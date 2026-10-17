/**
 * Gateway WebSocket server
 * ------------------------
 * Mounts on the existing Hono HTTP server (not Hono itself — `ws`'s upgrade
 * handler runs at the http.Server level, before Hono sees the request).
 *
 * The path is `/gateway`. Anything else gets the socket destroyed without
 * an HTTP response — this is the standard ws pattern for path filtering
 * outside the HTTP routing layer.
 *
 * Frame model (see @zekktris/shared/events):
 *   { op, d, t?, s? }
 *
 * Server frames sent here:
 *   - HELLO (immediately after connect)
 *   - DISPATCH (on bus events)
 *   - HEARTBEAT_ACK (in response to client HEARTBEAT)
 *   - INVALID_SESSION (on bad IDENTIFY/RESUME)
 *
 * Client frames handled here:
 *   - IDENTIFY: validates token, loads membership snapshot, sends READY
 *   - HEARTBEAT: bumps the watchdog, replies HEARTBEAT_ACK
 *   - RESUME: replays a retained session's missed events (see handleResume)
 *   - PRESENCE_UPDATE: this device's activity {active} — feeds the user's
 *     effective presence (gateway/presence.ts)
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { GatewayOp } from '@zekktris/shared/events';
import type {
  GatewayFrame,
  IdentifyPayload,
  HeartbeatPayload,
  PresenceActivity,
  PresenceUpdatePayload,
  ResumePayload,
} from '@zekktris/shared/events';
import { verifyAccessToken } from '../auth/tokens';
import { db, schema } from '../db';
import { eq, inArray } from 'drizzle-orm';
import { log } from '../log';
import { Connection } from './connection';
import { initInternalDispatchBus } from './dispatch';
import { registry } from './registry';
import {
  CloseCode,
  dispatchFrame,
  invalidSessionFrame,
} from './types';
import { toSelfUser, toReadState, toVoiceState, leftVoiceStateDTO, toMessage } from '../lib/dto';
import * as readStates from '../services/readStates';
import * as permissions from '../services/permissions';
import * as voice from '../services/voice';
import * as dispatch from './dispatch';
import * as dms from '../services/dms';
import * as relationships from '../services/relationships';
import { touchLastSeen } from '../services/presence';
import { isCurrentlyBanned } from '../services/instanceBans';
import { getIncomingClientIp } from '../lib/request';
import { leaderInterval } from '../lib/leaderTimers';
import { consumeGatewayConnect, consumeGatewayIdentify } from './limits';
import {
  presence,
  resetPresenceOnBoot,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_SWEEP_MS,
} from './presence';

const GATEWAY_PATH = '/gateway';

/** Grace after one of several live connections closes before the user's
 *  presence is recomputed, so a reconnect blip (tab reload, network handoff)
 *  doesn't flap their dot. The LAST connection closing waits for the longer
 *  voice-eviction grace instead (VOICE_EVICT_GRACE_MS). */
export const PRESENCE_CLOSE_GRACE_MS = 5_000;

/** Test seams; production passes none and gets the defaults. */
export interface GatewayOptions {
  /** Default PRESENCE_CLOSE_GRACE_MS. */
  presenceCloseGraceMs?: number;
  /** Default 45 s — see VOICE_EVICT_GRACE_MS in attachGateway. */
  voiceEvictGraceMs?: number;
  /** Default true. Tests sharing a database with other test files turn the
   *  boot reset off — it would offline those files' users mid-test. */
  resetPresenceOnBoot?: boolean;
}

let wss: WebSocketServer | null = null;
/** Timers owned by the attached gateway, cleared by detachGateway. */
let gatewayTimers: Array<ReturnType<typeof setInterval>> = [];
let pendingPresenceRecomputes = new Map<bigint, ReturnType<typeof setTimeout>>();

/** A valid `presence` from IDENTIFY/RESUME, or null if absent/malformed. */
function presenceActivity(p: PresenceActivity | undefined): boolean | null {
  return p && typeof p === 'object' && typeof p.active === 'boolean' ? p.active : null;
}

/** Attach the gateway to a running http.Server. Idempotent. */
export function attachGateway(httpServer: HttpServer, opts: GatewayOptions = {}): void {
  if (wss) return;

  wss = new WebSocketServer({
    noServer: true,
    // Cap frame size at 64KB. Real gateway frames are kilobytes at
    // most (IDENTIFY with a JWT, small DISPATCH structures); the
    // ws library's 100MB default is a DoS vector — an attacker
    // sending oversized frames over N concurrent connections would
    // exhaust memory before our parser had a chance to reject. 64KB
    // is comfortable headroom for legitimate use.
    maxPayload: 64 * 1024,
  });
  registry.init();
  // Consume internal cross-node viewability-invalidation signals so a
  // permission/role change on one replica invalidates the cache on all of them.
  initInternalDispatchBus();

  // ── Boot-time presence reset ───────────────────────────────────────
  // Presence (online/idle/dnd) is persisted on users.status and only
  // transitioned back to 'offline' when a connection closes gracefully.
  // A process restart or crash never runs those per-connection close
  // hooks, so the column is left asserting that everyone who was
  // connected at shutdown is still online — they then show as online to
  // everyone else forever, despite holding no live connection. On a single
  // replica every such row is stale at boot; in a cluster only those with no
  // live connection on another replica are (resetPresenceOnBoot).
  // 'invisible' is preserved (it's a privacy preference that already reads
  // as offline to others and must survive across reconnects).
  const presenceEngine = presence();
  if (opts.resetPresenceOnBoot !== false) {
    void resetPresenceOnBoot(presenceEngine).catch((err: unknown) => {
      log.warn('gateway: boot presence reset failed', { err: (err as Error).message });
    });
  }
  if (presenceEngine.clustered) {
    // Keep this replica's per-user entries fresh (every replica), and let the
    // leader recompute users stranded by a replica that died.
    const beat = setInterval(() => void presenceEngine.heartbeat(), PRESENCE_HEARTBEAT_MS);
    const sweep = leaderInterval(() => {
      void presenceEngine.sweep().catch((err: unknown) => {
        log.warn('gateway: presence sweep failed', { err: (err as Error).message });
      });
    }, PRESENCE_SWEEP_MS);
    for (const t of [beat, sweep]) (t as { unref?: () => void }).unref?.();
    gatewayTimers.push(beat, sweep);
  }

  // A live connection closed: recompute after a short grace (the device that
  // left may have been the one in use). Debounced per user. For the user's
  // last socket on this replica the device is held through the voice grace
  // (below); the close grace then only SETTLES the hold — it keeps them from
  // reading offline but no longer counts as in use while another device,
  // e.g. on another replica, is connected (gateway/presence.ts).
  const presenceCloseGraceMs = opts.presenceCloseGraceMs ?? PRESENCE_CLOSE_GRACE_MS;
  function scheduleCloseGraceRecompute(userId: bigint): void {
    const prior = pendingPresenceRecomputes.get(userId);
    if (prior) clearTimeout(prior);
    const t = setTimeout(() => {
      pendingPresenceRecomputes.delete(userId);
      presenceEngine.settleHold(userId);
      void presenceEngine.recompute(userId);
    }, presenceCloseGraceMs);
    (t as { unref?: () => void }).unref?.();
    pendingPresenceRecomputes.set(userId, t);
  }
  registry.onUserConnectionClosed = (userId: bigint) => {
    scheduleCloseGraceRecompute(userId);
  };

  // Pending voice-eviction timers keyed by userId (see grace period in
  // onUserFullyDisconnected below).
  const VOICE_EVICT_GRACE_MS = opts.voiceEvictGraceMs ?? 45_000;
  /** How many more grace windows to wait while LiveKit still reports the user
   *  in their room. 40 x 45s = 30 minutes: long enough to ride out any real
   *  signalling outage, bounded so a client whose gateway is permanently dead
   *  but whose media lingers is eventually cleaned up. */
  const VOICE_EVICT_MAX_RECHECKS = 40;
  const pendingVoiceEvictions = new Map<string, ReturnType<typeof setTimeout>>();

  // When a user's final gateway connection drops we have two pieces of
  // stale state to clean up:
  //   1. Voice: any joined room becomes ghost-attendee; clear it and
  //      broadcast a leave so the channel's voice list updates.
  //   2. Presence: their `users.status` row stays at whatever it was
  //      (online/idle/dnd), so other users would forever see them as
  //      online. Recompute it (→ 'offline' unless they're connected to
  //      another replica) and broadcast PRESENCE_UPDATE.
  // Fire-and-forget — the hook signature is sync to keep registry.ts
  // free of async machinery.
  registry.onUserFullyDisconnected = (userId: bigint, conn: Connection) => {
    // Until the grace below ends the user still counts as connected (with
    // the last device's activity until the close grace settles it), so no
    // other recompute flips them offline early — the offline flip keeps the
    // voice grace's timing.
    presenceEngine.hold(userId, conn.presenceActive);
    scheduleCloseGraceRecompute(userId);
    // GRACE PERIOD before evicting from voice. A gateway WebSocket blip
    // (WiFi->LTE handoff, brief network loss — likelier under the load
    // of video/screen share) is NOT the same as leaving the call: the
    // LiveKit media connection usually survives or reconnects on its
    // own. Evicting instantly told the peer "they left", which made the
    // 1:1 auto-hangup kill perfectly good calls. We wait, and cancel if
    // the user re-identifies in time. Presence offline-flip waits with
    // it (harmless either way).
    armVoiceEviction(userId, 0);
  };
  registry.onUserConnected = (userId: bigint) => {
    presenceEngine.release(userId);
    const key = userId.toString();
    const pending = pendingVoiceEvictions.get(key);
    if (pending) {
      clearTimeout(pending);
      pendingVoiceEvictions.delete(key);
    }
  };

  /**
   * Arm (or re-arm) the grace timer that evicts a fully-disconnected user
   * from voice.
   *
   * The socket going away is a SIGNALLING outage; it is not the user leaving
   * the call. LiveKit media is a separate connection and routinely survives
   * it, so before evicting we ask LiveKit whether they are still in the room.
   * Evicting on the socket alone deleted the voice row while leaving the
   * participant connected — audio kept working and every mute, deafen and
   * leave from that client then 409'd "not in voice".
   *
   * The entry stays in pendingVoiceEvictions for the whole async check, so a
   * reconnect during it (onUserConnected clears the entry) still cancels. The
   * live-count test after the await is the ground truth for the same thing.
   */
  function armVoiceEviction(userId: bigint, rechecks: number): void {
    const key = userId.toString();
    const pending = setTimeout(() => {
      void (async () => {
        if (pendingVoiceEvictions.get(key) !== pending) return;
        const onSfu = await voice.isStillOnSfu(userId).catch(() => null);
        // The await can span a reconnect. Either signal means they're back.
        if (pendingVoiceEvictions.get(key) !== pending || registry.isUserLive(userId)) return;
        if (onSfu === true && rechecks < VOICE_EVICT_MAX_RECHECKS) {
          // Still in the room: the call is alive. Wait another window.
          armVoiceEviction(userId, rechecks + 1);
          return;
        }
        pendingVoiceEvictions.delete(key);
        // Evicting someone LiveKit still reports present (the recheck cap)
        // must remove them from the room too, or this recreates the very
        // orphan the recheck exists to prevent. Absent or unknown: the row
        // alone, as before.
        runDisconnectCleanup(userId, { evictFromSfu: onSfu === true });
      })();
    }, VOICE_EVICT_GRACE_MS);
    pendingVoiceEvictions.set(key, pending);
  }

  function runDisconnectCleanup(userId: bigint, opts?: { evictFromSfu?: boolean }): void {
    void (async () => {
      try {
        const result = await voice.leaveVoice(userId, opts);
        if (result.priorState) {
          dispatch.voiceStateUpdate({
            guildId: result.priorState.guildId,
            channelId: result.priorState.channelId,
            voiceState: leftVoiceStateDTO({
              userId,
              guildId: result.priorState.guildId,
              channelId: result.priorState.channelId,
            }),
          });
        }
        // If leaving voice ended a 1:1 DM call, dispatch the
        // system_call message so the partner's transcript shows
        // the disconnect-as-hangup.
        if (result.systemCallMessage && result.systemCallChannelId !== null) {
          const m = result.systemCallMessage;
          const author = m.authorId
            ? (await db
                .select()
                .from(schema.users)
                .where(eq(schema.users.id, m.authorId))
                .limit(1))[0] ?? null
            : null;
          dispatch.messageCreate({
            messageDTO: toMessage({ message: m, author }),
            channelId: result.systemCallChannelId,
            guildId: null,
          });
        }
      } catch (err) {
        log.warn('gateway: voice cleanup on disconnect failed', {
          userId: userId.toString(),
          err: (err as Error).message,
        });
      }

      try {
        // Stage roster cleanup. Stage joins create stage_participants
        // rows WITHOUT a voice_states row, so the leaveVoice above never
        // touches them — without this, a closed tab / dead connection
        // leaves a ghost participant (or ghost SPEAKER) on the roster
        // forever, and their own re-join short-circuits on the stale row.
        // Runs after the same 45s grace as voice eviction.
        const removedStage = await db
          .delete(schema.stageParticipants)
          .where(eq(schema.stageParticipants.userId, userId))
          .returning({ channelId: schema.stageParticipants.channelId });
        if (removedStage.length > 0) {
          // Batch the channel→guild lookups (was one query per removed row) and
          // hoist the dynamic imports out of the loop.
          const stageChannels = await db
            .select({ id: schema.channels.id, guildId: schema.channels.guildId })
            .from(schema.channels)
            .where(inArray(schema.channels.id, removedStage.map((r) => r.channelId)));
          const guildByChannel = new Map(stageChannels.map((c) => [c.id, c.guildId]));
          const stageSvc = await import('../services/stage');
          const { toStageParticipant } = await import('../lib/dto');
          for (const r of removedStage) {
            const guildId = guildByChannel.get(r.channelId);
            if (!guildId) continue;
            const remaining = await stageSvc.listParticipants(r.channelId);
            dispatch.stageParticipantsUpdate({
              guildId,
              channelId: r.channelId,
              participants: remaining.map(toStageParticipant),
            });
          }
        }
      } catch (err) {
        log.warn('gateway: stage cleanup on disconnect failed', {
          userId: userId.toString(),
          err: (err as Error).message,
        });
      }

      try {
        // The grace is over: drop the hold and recompute. With no live
        // connection anywhere this writes 'offline' (an 'invisible' user stays
        // 'invisible' — it already reads as offline to others and is their
        // choice), stamps "last online" and broadcasts to every guild, DM
        // peer and friend. If they reconnected — here or on another replica —
        // the recompute simply reflects that.
        presenceEngine.release(userId);
        await presenceEngine.recompute(userId);
      } catch (err) {
        log.warn('gateway: presence offline on disconnect failed', {
          userId: userId.toString(),
          err: (err as Error).message,
        });
      }
    })();
  };

  // ── HTTP-level upgrade routing ─────────────────────────────────────────
  // We intercept upgrades for /gateway and let Hono's HTTP handler ignore
  // them. Anything else gets the socket destroyed cleanly so we don't leak
  // half-upgraded connections.
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    // Strip query string for path comparison.
    const path = url.split('?')[0];
    if (path !== GATEWAY_PATH) {
      // Not for us — let other listeners handle it, or destroy if none do.
      // Other listeners are likely Hono's, but Hono v4 + node-server doesn't
      // claim upgrade events, so destroying here is the right default.
      socket.destroy();
      return;
    }
    // Per-IP upgrade limit (gateway/limits.ts), checked BEFORE the handshake
    // so a flood costs us neither a WebSocket nor an IDENTIFY timer. The
    // limiter may await Redis; until ws takes the socket over, a client reset
    // must not surface as an unhandled 'error' event, so guard it meanwhile.
    const onEarlyError = () => socket.destroy();
    socket.on('error', onEarlyError);
    void consumeGatewayConnect(getIncomingClientIp(req))
      .then((retryAfterMs) => {
        if (socket.destroyed) return;
        if (!wss) {
          socket.destroy(); // gateway detached while we waited
          return;
        }
        if (retryAfterMs !== null) {
          // A plain HTTP 429 instead of an upgrade: clients see a failed
          // connect and retry through their normal reconnect backoff.
          socket.end(
            'HTTP/1.1 429 Too Many Requests\r\n' +
              `Retry-After: ${Math.max(1, Math.ceil(retryAfterMs / 1000))}\r\n` +
              'Connection: close\r\nContent-Length: 0\r\n\r\n',
          );
          return;
        }
        // ws installs its own error handling from here on.
        socket.removeListener('error', onEarlyError);
        wss.handleUpgrade(req, socket as Socket, head, (ws) => {
          wss!.emit('connection', ws, req);
        });
      })
      .catch((err) => {
        log.warn('gateway: upgrade failed', { err: (err as Error).message });
        socket.destroy();
      });
  });

  // ── New connection ─────────────────────────────────────────────────────
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const conn = new Connection(ws);
    registry.add(conn);

    log.debug('gateway: new connection', { sessionId: conn.id, ip: req.socket.remoteAddress });

    ws.on('message', (raw) => {
      // A rejection here (e.g. a transient DB error inside the IDENTIFY
      // handler's queries) would otherwise surface as an unhandled
      // rejection, which the process-level handler in index.ts treats
      // as fatal (process.exit). One bad frame must never take down
      // the whole server — log, close this connection, move on.
      void handleClientFrame(conn, raw.toString()).catch((err) => {
        log.warn('gateway: client frame handling failed', {
          sessionId: conn.id,
          err: (err as Error).message,
        });
        conn.close(CloseCode.PROTOCOL_ERROR, 'internal error');
      });
    });

    ws.on('close', () => {
      conn.handlePeerClosed();
      log.debug('gateway: connection closed', { sessionId: conn.id, userId: conn.userId?.toString() });
    });

    ws.on('error', (err) => {
      log.warn('gateway: ws error', { sessionId: conn.id, err: (err as Error).message });
    });

    conn.start();
  });
}

/** Graceful shutdown — close all sockets and stop accepting upgrades. */
export function detachGateway(): void {
  if (!wss) return;
  for (const t of gatewayTimers) clearInterval(t);
  gatewayTimers = [];
  for (const t of pendingPresenceRecomputes.values()) clearTimeout(t);
  pendingPresenceRecomputes = new Map();
  registry.onUserConnectionClosed = null;
  registry.shutdown();
  wss.close();
  wss = null;
}

// ── Frame dispatch ─────────────────────────────────────────────────────────

async function handleClientFrame(conn: Connection, raw: string): Promise<void> {
  let frame: GatewayFrame;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { op: unknown }).op !== 'number') {
      throw new Error('bad frame');
    }
    frame = parsed as GatewayFrame;
  } catch {
    conn.close(CloseCode.PROTOCOL_ERROR, 'malformed frame');
    return;
  }

  switch (frame.op) {
    case GatewayOp.IDENTIFY:
      await handleIdentify(conn, frame.d as IdentifyPayload | undefined);
      return;
    case GatewayOp.HEARTBEAT:
      handleHeartbeat(conn, frame.d as HeartbeatPayload | undefined);
      return;
    case GatewayOp.RESUME:
      await handleResume(conn, frame.d as ResumePayload | undefined);
      return;
    case GatewayOp.PRESENCE_UPDATE:
      handlePresenceUpdate(conn, frame.d as PresenceUpdatePayload | undefined);
      return;
    default:
      conn.close(CloseCode.PROTOCOL_ERROR, `unsupported op ${frame.op}`);
      return;
  }
}

// ── IDENTIFY ───────────────────────────────────────────────────────────────

async function handleIdentify(conn: Connection, payload: IdentifyPayload | undefined): Promise<void> {
  if (conn.isAuthenticated()) {
    conn.close(CloseCode.ALREADY_AUTHENTICATED, 'already authenticated');
    return;
  }
  if (!payload?.token || typeof payload.token !== 'string') {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'missing token');
    return;
  }

  let userId: bigint;
  let sessionId: bigint;
  {
    try {
      const claims = await verifyAccessToken(payload.token);
      userId = claims.userId;
      sessionId = claims.sessionId;
    } catch {
      conn.send(invalidSessionFrame(false));
      conn.close(CloseCode.AUTHENTICATION_FAILED, 'invalid token');
      return;
    }

    // Per-user IDENTIFY/RESUME limit, before any DB work. Close WITHOUT an
    // INVALID_SESSION frame: clients treat that as fatal, whereas a plain
    // close sends them through their reconnect backoff.
    if (!(await consumeGatewayIdentify(userId))) {
      conn.close(CloseCode.RATE_LIMITED, 'rate limited');
      return;
    }

    // Check that the underlying session hasn't been revoked. A valid
    // access token alone isn't enough — JWTs survive session
    // revocation up to their TTL (~15 min). After a password reset
    // or admin force-signout, the sessions row is marked revoked but
    // the client (and any attacker holding the same token) auto-
    // reconnects the WebSocket on close. Without this check, that
    // reconnect succeeds and the user-facing "log out everywhere"
    // operation is silently undone for the remaining TTL.
    //
    // One extra DB read per IDENTIFY. IDENTIFY is rare (once per
    // socket-open, not per frame), so the cost is acceptable in
    // exchange for tightening session revocation from
    // eventually-consistent to "next gateway interaction at latest".
    const sessionRows = await db
      .select({ revokedAt: schema.sessions.revokedAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    if (!sessionRows[0] || sessionRows[0].revokedAt !== null) {
      conn.send(invalidSessionFrame(false));
      conn.close(CloseCode.AUTHENTICATION_FAILED, 'session revoked');
      return;
    }
  }

  // Load the user's membership snapshot. We materialize sets that the
  // registry filter consults at fanout time — no DB queries on the hot
  // path.
  const [user, guildIdRows, dmChannelIdRows, readStateRows, friendIds] = await Promise.all([
    db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1),
    db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId)),
    db
      .select({ channelId: schema.dmRecipients.channelId })
      .from(schema.dmRecipients)
      .where(eq(schema.dmRecipients.userId, userId)),
    // Read states — userId-only read with no dependency on the guild/channel
    // resolution below, so batch it here instead of a separate serial
    // round-trip after the viewable-channel resolver (saves one RTT on every
    // connect/reconnect, which iOS does on every background/foreground).
    readStates.listMy(userId),
    // Accepted friends — so a friend who shares NO guild and NO DM channel
    // still sees this user flip online on IDENTIFY. Batched here (one indexed
    // read) rather than a serial round-trip before the presence broadcast.
    relationships.listAcceptedFriendIds(userId),
  ]);
  if (!user[0]) {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'user not found');
    return;
  }
  // Reject banned or soft-deleted users at the gateway too. The REST
  // login already blocks these, but a user holding a still-valid
  // access token (issued BEFORE the ban / account deletion) could
  // otherwise re-authenticate the gateway on a fresh connection up
  // to the access-token TTL (~15min). The admin force-signout path
  // closes EXISTING connections; this check prevents NEW ones from
  // being established. Generic close code to avoid leaking the
  // specific moderation state. isCurrentlyBanned, like REST login: an
  // EXPIRED timed ban is not a ban, even before the sweep clears it.
  if (isCurrentlyBanned(user[0]) || user[0].deletedAt) {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'account unavailable');
    return;
  }

  // Compute the user's viewable channels across ALL their guilds in a
  // CONSTANT number of queries (six set-based reads), regardless of how
  // many guilds they're in. Previously this ran one resolver call per
  // guild (~3 round-trips each), so a 50-guild user paid ~150 round-trips
  // on every reconnect — and iOS reconnects often (WS suspension on
  // backgrounding). The batched resolver returns the identical viewable
  // set; only the query shape changed. Paid ONCE per connection, never on
  // the hot dispatch path.
  const guildIds = guildIdRows.map((r) => r.guildId);
  const viewableByGuild = await permissions.listViewableGuildChannelIdsByGuild(
    guildIds,
    userId,
  );
  const viewableChannels: Array<{ channelId: bigint; guildId: bigint }> = [];
  for (const [guildId, channelIds] of viewableByGuild) {
    for (const channelId of channelIds) viewableChannels.push({ channelId, guildId });
  }

  // The peer may have disconnected while the snapshot queries above were
  // in flight. Its close hook (registry.remove) has already run, so
  // indexing it now would leak the connection into byUser/byGuild/byDM
  // forever — keeping the user permanently "connected" (their presence
  // never flips offline because the byUser set never empties again).
  if (conn.isClosed()) return;

  conn.markAuthenticated(
    userId,
    guildIds,
    dmChannelIdRows.map((r) => r.channelId),
    viewableChannels,
  );
  conn.authSessionId = sessionId;
  // This device's activity at connect. Absent (legacy client) = active.
  conn.presenceActive = presenceActivity(payload.presence) ?? true;
  // NOTE: indexing for live fan-out is deferred until AFTER the READY frame is
  // sent (below) — see the comment there. Indexing here would let an event
  // fanned out during the awaited voice-states read reach this socket with a
  // seq LOWER than READY, violating the handshake.

  // (readStateRows was hoisted into the top Promise.all batch above — it's a
  // userId-only read that need not wait on the channel-viewability resolver.)

  // Voice states relevant to the user — both guild voice (members in
  // any of the user's guilds' voice channels) AND DM voice (1-on-1 /
  // group calls in any of the user's DM channels). Combined into a
  // single call so reconnect rebuilds the full presence map in one
  // round-trip. DMs need the channelId-scoped leg because DM voice
  // rows have guildId=null and so are invisible to the guild leg.
  const dmChannelIds = dmChannelIdRows.map((r) => r.channelId);
  const voiceStateRows = await voice.listVoiceStatesForReady({
    // Only channels the user can VIEW_CHANNEL — so the snapshot doesn't leak
    // voice presence in private channels (mirrors the live fan-out filter).
    viewableChannelIds: viewableChannels.map((v) => v.channelId),
    dmChannelIds,
  });

  // ── READY payload ────────────────────────────────────────────────────
  // Identity + light snapshots. Full guild/channel/member trees still come
  // from REST — enriching READY further is a v1.x perf optimization.
  conn.send(
    dispatchFrame('READY', {
      session_id: conn.sessionId,
      user: toSelfUser(user[0]),
      guilds: guildIdRows.map((r) => ({ id: r.guildId.toString() })),
      private_channels: dmChannelIdRows.map((r) => ({ id: r.channelId.toString() })),
      read_state: readStateRows.map(toReadState),
      voice_states: voiceStateRows.map(toVoiceState),
      // Clients switch to activity reporting (and stop PATCHing status
      // automatically) only when they see this.
      features: { presence_activity: true },
    }),
  );

  // Index for live fan-out only NOW that READY is on the wire (mirrors the
  // RESUME path, which indexes via completeResume after RESUMED). An event
  // arriving in the tiny pre-index window is simply not delivered live — the
  // client reconciles channel contents via REST on open — which is strictly
  // better than delivering a DISPATCH before READY.
  if (conn.isClosed()) return;
  registry.index(conn);

  // ── DM read-receipt: delivery backfill ──────────────────────────────────
  // For every 1:1 DM that landed while this user was offline, stamp
  // delivered_at and fan MESSAGE_DELIVERED out to the original
  // senders. Fire-and-forget so the rest of the IDENTIFY path isn't
  // gated on the UPDATE — the events are independent of READY and
  // can arrive a few ms after.
  //
  // Honors the user's dmReadReceiptsEnabled toggle (gated inside the
  // service). Capped at 500 rows per backfill so a user reconnecting
  // after weeks offline pays a bounded cost.
  void (async () => {
    try {
      const { stamped, userReceiptsEnabled } =
        await dms.backfillPendingDeliveries(userId);
      if (stamped.length === 0) return;
      // Stamps land regardless (sweep correctness); dispatch is
      // gated on receipts being enabled for this user.
      if (!userReceiptsEnabled) return;
      // Group by (authorId, channelId) — one event per author per
      // channel rather than one per message — so the sender's UI
      // applies the bulk Sent → Delivered transition in a single
      // reducer step. Map key uses string concat for bigint
      // comparability.
      const grouped = new Map<
        string,
        { authorId: bigint; channelId: bigint; messageIds: bigint[] }
      >();
      for (const s of stamped) {
        const key = `${s.authorId.toString()}|${s.channelId.toString()}`;
        const bucket = grouped.get(key);
        if (bucket) {
          bucket.messageIds.push(s.messageId);
        } else {
          grouped.set(key, {
            authorId: s.authorId,
            channelId: s.channelId,
            messageIds: [s.messageId],
          });
        }
      }
      const now = new Date();
      for (const g of grouped.values()) {
        dispatch.messageDelivered({
          authorId: g.authorId,
          channelId: g.channelId,
          messageIds: g.messageIds,
          deliveredAt: now,
        });
      }
    } catch {
      // Best-effort. The next listMessages call from the recipient
      // will catch any pending row that didn't make it through.
    }
  })();

  // If the peer dropped between READY and here, skip the online flip —
  // the disconnect hook owns presence cleanup at this point, and writing
  // 'online' for a connection that's already gone would leave the user
  // stuck appearing online with zero live connections.
  if (conn.isClosed()) return;

  // Recompute the user's effective presence now that this device counts:
  // offline → online (or idle, if this device connected idle and no other is
  // in use). The chosen status is never touched, so a Do Not Disturb or
  // Invisible picked before a disconnect is still in force — Discord parity.
  //
  // CRITICAL: we broadcast on EVERY successful IDENTIFY, not just on
  // transitions ('always'). Reason — when a user reconnects (flaky mobile,
  // app foregrounded after background WS suspension, etc.), other clients
  // might have stale member-list data showing them offline. Re-broadcasting
  // the current truth on every connect heals that drift cheaply, with one
  // event per guild + DM. Without this, two users who silently had their
  // WSes recycled by iOS suspension would each appear offline to the other
  // forever despite both being "online". Re-uses the guild / DM / friend
  // lists loaded for the snapshot above instead of querying them again.
  await presence().recompute(userId, {
    broadcast: 'always',
    audience: {
      guildIds,
      dmChannelIds: dmChannelIdRows.map((r) => r.channelId),
      friendIds,
    },
  });

  // "Last online": bound the stamp at the START of the session too, not just
  // at disconnect. The disconnect hook is what normally writes it, but it
  // never runs if the process dies — without this, a user who'd been
  // connected for three days would read as "last seen 3 days ago" the
  // instant the server crashed. No-ops (in SQL) while they're invisible.
  // Runs after READY is already on the wire, so it adds no login latency.
  await touchLastSeen(userId);

  log.info('gateway: identified', { sessionId: conn.id, userId: userId.toString() });
}

// ── RESUME ───────────────────────────────────────────────────────────────────

/**
 * RESUME {token, session_id, seq}: replay the events a reconnecting client
 * missed instead of forcing a full re-IDENTIFY.
 *
 * Strictly additive + safe: any condition we can't satisfy (unknown/expired
 * session, gap too large, a different node, an owner mismatch) is answered
 * with INVALID_SESSION{resumable:false} on the SAME open socket, and the
 * client falls back to IDENTIFY exactly as it does today. Only a bad/revoked
 * token is fatal (mirrors IDENTIFY — closes the socket).
 *
 * Correctness:
 *   - Ordering: replayed frames carry their ORIGINAL seqs, in order, and the
 *     adopted connection continues the same seq counter, so the stream is
 *     contiguous across the reconnect.
 *   - Permission filtering: the buffer holds frames that were already
 *     permission-filtered for this exact session at fan-out time, so replay
 *     is visibility-correct by construction — we never re-filter, we re-send.
 *   - Multi-node: buffers are per-node/in-memory, so a reconnect that lands
 *     on a different node finds no session and falls back to IDENTIFY.
 */
async function handleResume(conn: Connection, payload: ResumePayload | undefined): Promise<void> {
  if (conn.isAuthenticated()) {
    conn.close(CloseCode.ALREADY_AUTHENTICATED, 'already authenticated');
    return;
  }
  if (
    !payload?.token ||
    typeof payload.token !== 'string' ||
    typeof payload.session_id !== 'string' ||
    typeof payload.seq !== 'number'
  ) {
    // Malformed RESUME → IDENTIFY fresh (non-fatal; keep the socket open).
    conn.send(invalidSessionFrame(false));
    return;
  }

  // 1. Authenticate exactly like IDENTIFY (valid token + session not revoked
  //    + user not banned/deleted). A bad token is fatal; closing matches
  //    IDENTIFY so a holder of a revoked token can't resume past revocation.
  let userId: bigint;
  let sessionId: bigint;
  try {
    const claims = await verifyAccessToken(payload.token);
    userId = claims.userId;
    sessionId = claims.sessionId;
  } catch {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'invalid token');
    return;
  }
  // Same per-user limit as IDENTIFY (one shared budget for both).
  if (!(await consumeGatewayIdentify(userId))) {
    conn.close(CloseCode.RATE_LIMITED, 'rate limited');
    return;
  }
  const sessionRows = await db
    .select({ revokedAt: schema.sessions.revokedAt })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  if (!sessionRows[0] || sessionRows[0].revokedAt !== null) {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'session revoked');
    return;
  }
  const [userRow] = await db
    .select({
      bannedAt: schema.users.bannedAt,
      bannedUntil: schema.users.bannedUntil,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!userRow) {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'user not found');
    return;
  }
  if (isCurrentlyBanned(userRow) || userRow.deletedAt) {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'account unavailable');
    return;
  }

  // The new socket may have dropped while we were awaiting the DB.
  if (conn.isClosed()) return;

  // 2. Locate the retained session AFTER the await, so anything that landed
  //    in the gap (and during this await) is already buffered. Unknown /
  //    expired / different-node / not-ours / gap-too-large → IDENTIFY.
  let prev = registry.findResumable(payload.session_id);
  if (!prev) {
    // Not detached — but it may still be indexed as LIVE: in the silent-
    // death case (WiFi→LTE, iOS suspension — the exact scenario RESUME was
    // built for) the client's ~10s ack watchdog notices the zombie long
    // before our 40s server watchdog, so its RESUME beats our detach. Take
    // over the live session, Discord-style: the resume displaces the old
    // socket. The gap check runs BEFORE the takeover so a too-large gap
    // leaves the zombie to expire through its normal watchdog path.
    const live = registry.findLiveSession(payload.session_id, userId);
    if (
      live &&
      live !== conn &&
      live.resumeBuffer &&
      live.resumeBuffer.canResume(payload.seq, live.currentSeq)
    ) {
      registry.takeoverLiveSession(live);
      prev = live;
    }
  }
  if (
    !prev ||
    prev.userId !== userId ||
    !prev.resumeBuffer ||
    !prev.resumeBuffer.canResume(payload.seq, prev.currentSeq)
  ) {
    conn.send(invalidSessionFrame(false));
    return;
  }

  // 3. Adopt the prior session onto this socket, replay the missed suffix
  //    verbatim (original seqs, already-filtered bytes), then RESUMED.
  const missed = prev.resumeBuffer.framesAfter(payload.seq);
  conn.adoptResumedSession(prev);
  conn.authSessionId = sessionId;
  // The client's current activity, if it sent one (else the session's).
  const resumedActivity = presenceActivity(payload.presence);
  if (resumedActivity !== null) conn.presenceActive = resumedActivity;
  for (const json of missed) conn.sendRaw(json);
  conn.send(dispatchFrame('RESUMED', { session_id: conn.sessionId }));

  // 4. Go live: index the fresh connection, drop the prior detached one.
  //    (index → onUserConnected cancels any pending voice eviction.)
  registry.completeResume(prev, conn);

  // 5. Presence: recompute + re-broadcast, mirroring IDENTIFY's every-connect
  //    re-broadcast so a >grace-period gap (where presence had already
  //    flipped offline) recovers, and shorter gaps just heal drift.
  //    The connection snapshot carries guilds + DM channels but not the
  //    friend list, so load accepted friends fresh here — this heals presence
  //    for a friend who shares no guild/DM after a >grace-period gap.
  const friendIds = await relationships.listAcceptedFriendIds(userId);
  await presence().recompute(userId, {
    broadcast: 'always',
    audience: {
      guildIds: Array.from(conn.guildIds),
      dmChannelIds: Array.from(conn.dmChannelIds),
      friendIds,
    },
  });
  // Same session-start bound as IDENTIFY — a RESUME is a connect too.
  await touchLastSeen(userId);

  log.info('gateway: resumed', {
    sessionId: conn.sessionId,
    userId: userId.toString(),
    replayed: missed.length,
  });
}

// ── PRESENCE_UPDATE ────────────────────────────────────────────────────────

/**
 * Op 3 `{ active }`: this device's activity changed. Ignored before IDENTIFY
 * and when malformed; a repeat of the current value is ignored and changes
 * are rate-limited per connection (Connection.reportPresenceActivity) — never
 * a reason to close the socket. Each applied change recomputes the user's
 * effective presence.
 */
function handlePresenceUpdate(conn: Connection, payload: PresenceUpdatePayload | undefined): void {
  if (!conn.isAuthenticated() || conn.userId === null || conn.detached) return;
  const active = presenceActivity(payload);
  if (active === null) return;
  const userId = conn.userId;
  conn.reportPresenceActivity(active, () => {
    void presence().recompute(userId);
  });
}

// ── HEARTBEAT ──────────────────────────────────────────────────────────────

function handleHeartbeat(conn: Connection, _payload: HeartbeatPayload | undefined): void {
  conn.noteHeartbeat();
  conn.ackHeartbeat();
}
