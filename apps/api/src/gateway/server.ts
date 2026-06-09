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
 *   - RESUME: rejected for v1 (always responds INVALID_SESSION resumable=false)
 *   - PRESENCE_UPDATE: updates the user's online status (deferred — minimal v1)
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { GatewayOp } from '@zekktris/shared/events';
import type {
  GatewayFrame,
  IdentifyPayload,
  HeartbeatPayload,
  ResumePayload,
} from '@zekktris/shared/events';
import { verifyAccessToken } from '../auth/tokens';
import { db, schema } from '../db';
import { and, eq, ne } from 'drizzle-orm';
import { log } from '../log';
import { Connection } from './connection';
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

const GATEWAY_PATH = '/gateway';

let wss: WebSocketServer | null = null;

/** Attach the gateway to a running http.Server. Idempotent. */
export function attachGateway(httpServer: HttpServer): void {
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

  // ── Boot-time presence reset ───────────────────────────────────────
  // Presence (online/idle/dnd) is persisted on users.status and only
  // transitioned back to 'offline' when a connection closes gracefully.
  // A process restart or crash never runs those per-connection close
  // hooks, so the column is left asserting that everyone who was
  // connected at shutdown is still online — they then show as online to
  // everyone else forever, despite holding no live connection. At boot
  // there are zero connections by definition, so any non-offline,
  // non-invisible status is stale. Reset them. 'invisible' is preserved
  // (it's a privacy preference that already reads as offline to others
  // and must survive across reconnects); this mirrors exactly how the
  // graceful-disconnect handler treats each status.
  void (async () => {
    try {
      const reset = await db
        .update(schema.users)
        .set({ status: 'offline' })
        .where(
          and(
            ne(schema.users.status, 'offline'),
            ne(schema.users.status, 'invisible'),
          ),
        )
        .returning({ id: schema.users.id });
      if (reset.length > 0) {
        log.info('gateway: reset stale presence on boot', { count: reset.length });
      }
    } catch (err) {
      log.warn('gateway: boot presence reset failed', { err: (err as Error).message });
    }
  })();
  // Pending voice-eviction timers keyed by userId (see grace period in
  // onUserFullyDisconnected below).
  const VOICE_EVICT_GRACE_MS = 45_000;
  const pendingVoiceEvictions = new Map<string, ReturnType<typeof setTimeout>>();

  // When a user's final gateway connection drops we have two pieces of
  // stale state to clean up:
  //   1. Voice: any joined room becomes ghost-attendee; clear it and
  //      broadcast a leave so the channel's voice list updates.
  //   2. Presence: their `users.status` row stays at whatever it was
  //      (online/idle/dnd) until they explicitly change it, so other
  //      users would forever see them as online. Mark them offline
  //      and broadcast PRESENCE_UPDATE to every shared guild.
  // Fire-and-forget — the hook signature is sync to keep registry.ts
  // free of async machinery.
  registry.onUserFullyDisconnected = (userId: bigint) => {
    // GRACE PERIOD before evicting from voice. A gateway WebSocket blip
    // (WiFi->LTE handoff, brief network loss — likelier under the load
    // of video/screen share) is NOT the same as leaving the call: the
    // LiveKit media connection usually survives or reconnects on its
    // own. Evicting instantly told the peer "they left", which made the
    // 1:1 auto-hangup kill perfectly good calls. We wait, and cancel if
    // the user re-identifies in time. Presence offline-flip waits with
    // it (harmless either way).
    const pending = setTimeout(() => {
      pendingVoiceEvictions.delete(userId.toString());
      runDisconnectCleanup(userId);
    }, VOICE_EVICT_GRACE_MS);
    pendingVoiceEvictions.set(userId.toString(), pending);
  };
  registry.onUserConnected = (userId: bigint) => {
    const key = userId.toString();
    const pending = pendingVoiceEvictions.get(key);
    if (pending) {
      clearTimeout(pending);
      pendingVoiceEvictions.delete(key);
    }
  };

  function runDisconnectCleanup(userId: bigint): void {
    void (async () => {
      try {
        const result = await voice.leaveVoice(userId);
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
        // Read the user's current status. If they're 'invisible' we
        // leave it alone — their wire-presence is already 'offline' to
        // others, and bumping the column would lose their privacy
        // setting on next connect. For online/idle/dnd, transition
        // to 'offline' so the row reflects reality.
        const [u] = await db
          .select({ status: schema.users.status })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        if (!u || u.status === 'invisible' || u.status === 'offline') return;

        await db
          .update(schema.users)
          .set({ status: 'offline' })
          .where(eq(schema.users.id, userId));

        // Broadcast to every guild this user is in so co-members'
        // member-list dot recolors live. Also fan out to the user's
        // DM channels so DM partners see the dot change too — without
        // this, two users who only ever DM each other never see each
        // other's presence transitions. We DON'T worry about race
        // with a fresh reconnect — if the user reconnects before this
        // finishes, the IDENTIFY handler will flip them back online
        // and dispatch the appropriate transition.
        const memberRows = await db
          .select({ guildId: schema.guildMembers.guildId })
          .from(schema.guildMembers)
          .where(eq(schema.guildMembers.userId, userId));
        const dmRows = await db
          .select({ channelId: schema.dmRecipients.channelId })
          .from(schema.dmRecipients)
          .where(eq(schema.dmRecipients.userId, userId));
        if (memberRows.length > 0 || dmRows.length > 0) {
          dispatch.presenceUpdate({
            userId,
            status: 'offline',
            guildIds: memberRows.map((r) => r.guildId),
            dmChannelIds: dmRows.map((r) => r.channelId),
          });
        }
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
    wss!.handleUpgrade(req, socket as Socket, head, (ws) => {
      wss!.emit('connection', ws, req);
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
      // Honor as a no-op for now. Online presence is set on IDENTIFY and
      // reset on disconnect; explicit status changes ride on the REST
      // PATCH /users/@me endpoint.
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
  const [user, guildIdRows, dmChannelIdRows] = await Promise.all([
    db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1),
    db
      .select({ guildId: schema.guildMembers.guildId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, userId)),
    db
      .select({ channelId: schema.dmRecipients.channelId })
      .from(schema.dmRecipients)
      .where(eq(schema.dmRecipients.userId, userId)),
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
  // specific moderation state.
  if (user[0].bannedAt || user[0].deletedAt) {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'account unavailable');
    return;
  }

  // Compute the user's viewable channels per guild. Each call is ~2 DB
  // round trips and they parallelize cleanly. This is paid ONCE per
  // connection, never on the hot dispatch path.
  const guildIds = guildIdRows.map((r) => r.guildId);
  const viewableByGuild = await Promise.all(
    guildIds.map(async (gid) => ({
      guildId: gid,
      channelIds: await permissions.listViewableGuildChannelIds(gid, userId),
    })),
  );
  const viewableChannels = viewableByGuild.flatMap(({ guildId, channelIds }) =>
    channelIds.map((channelId) => ({ channelId, guildId })),
  );

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
  registry.index(conn);

  // Read states for the user — small enough to ship in READY (one row per
  // channel they've ever opened). Saves the client a round-trip and means
  // unread badges can render before the first frame paint.
  const readStateRows = await readStates.listMy(userId);

  // Voice states relevant to the user — both guild voice (members in
  // any of the user's guilds' voice channels) AND DM voice (1-on-1 /
  // group calls in any of the user's DM channels). Combined into a
  // single call so reconnect rebuilds the full presence map in one
  // round-trip. DMs need the channelId-scoped leg because DM voice
  // rows have guildId=null and so are invisible to the guild leg.
  const dmChannelIds = dmChannelIdRows.map((r) => r.channelId);
  const voiceStateRows = await voice.listVoiceStatesForReady({
    guildIds,
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
    }),
  );

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

  // Mark user online if they were offline. Critically, we DON'T blow
  // away an explicit status pick (idle / dnd / invisible) — that's
  // bug parity with Discord, where reconnecting doesn't yank you back
  // to "Online" if you'd set "Do Not Disturb" before the disconnect.
  // Only the offline → online transition resets to 'online'; any other
  // current status is preserved verbatim.
  await db
    .update(schema.users)
    .set({ status: 'online' })
    .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'offline')));

  // Derive the post-update status WITHOUT re-querying. The conditional
  // UPDATE above only changes the row when status was 'offline' — for
  // every other prior value the row is unchanged. So:
  //   prior 'offline' → broadcast 'online' (we just bumped it)
  //   prior anything-else → broadcast that anything-else verbatim
  // Map invisible → offline for over-the-wire (others see invisible
  // as offline; this matches what listMembers serves through the
  // toPublicUser DTO). Online/idle/dnd pass through.
  //
  // CRITICAL: we broadcast on EVERY successful IDENTIFY, not just on
  // transitions. Reason — when a user reconnects (flaky mobile, app
  // foregrounded after background WS suspension, etc.), other clients
  // might have stale member-list data showing them offline.
  // Re-broadcasting the current truth on every connect heals that
  // drift cheaply, with one event per guild + DM. Without this, two
  // users who silently had their WSes recycled by iOS suspension
  // would each appear offline to the other forever despite both
  // being "online".
  //
  // Also re-uses guildIds and dmChannelIdRows we already loaded above
  // for the snapshot — the previous implementation issued two more
  // round-trips for the same data on every IDENTIFY.
  const priorStatus = user[0].status;
  const postUpdateStatus = priorStatus === 'offline' ? 'online' : priorStatus;
  const broadcastStatus = postUpdateStatus === 'invisible' ? 'offline' : postUpdateStatus;
  if (guildIds.length > 0 || dmChannelIdRows.length > 0) {
    dispatch.presenceUpdate({
      userId,
      status: broadcastStatus,
      guildIds,
      dmChannelIds: dmChannelIdRows.map((r) => r.channelId),
    });
  }

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
      status: schema.users.status,
      bannedAt: schema.users.bannedAt,
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
  if (userRow.bannedAt || userRow.deletedAt) {
    conn.send(invalidSessionFrame(false));
    conn.close(CloseCode.AUTHENTICATION_FAILED, 'account unavailable');
    return;
  }

  // The new socket may have dropped while we were awaiting the DB.
  if (conn.isClosed()) return;

  // 2. Locate the retained session AFTER the await, so anything that landed
  //    in the gap (and during this await) is already buffered. Unknown /
  //    expired / different-node / not-ours / gap-too-large → IDENTIFY.
  const prev = registry.findResumable(payload.session_id);
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
  for (const json of missed) conn.sendRaw(json);
  conn.send(dispatchFrame('RESUMED', { session_id: conn.sessionId }));

  // 4. Go live: index the fresh connection, drop the prior detached one.
  //    (index → onUserConnected cancels any pending voice eviction.)
  registry.completeResume(prev, conn);

  // 5. Presence: heal back to online + re-broadcast, mirroring IDENTIFY's
  //    every-connect re-broadcast so a >grace-period gap (where presence had
  //    already flipped offline) recovers, and shorter gaps just heal drift.
  await db
    .update(schema.users)
    .set({ status: 'online' })
    .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'offline')));
  const broadcastStatus =
    userRow.status === 'offline'
      ? 'online'
      : userRow.status === 'invisible'
        ? 'offline'
        : userRow.status;
  const guildIds = Array.from(conn.guildIds);
  const dmChannelIds = Array.from(conn.dmChannelIds);
  if (guildIds.length > 0 || dmChannelIds.length > 0) {
    dispatch.presenceUpdate({ userId, status: broadcastStatus, guildIds, dmChannelIds });
  }

  log.info('gateway: resumed', {
    sessionId: conn.sessionId,
    userId: userId.toString(),
    replayed: missed.length,
  });
}

// ── HEARTBEAT ──────────────────────────────────────────────────────────────

function handleHeartbeat(conn: Connection, _payload: HeartbeatPayload | undefined): void {
  conn.noteHeartbeat();
  conn.ackHeartbeat();
}
