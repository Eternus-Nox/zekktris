/**
 * Connection
 * ----------
 * Wraps one WebSocket plus the per-connection state needed to dispatch
 * events: who's authenticated as whom, what guilds/DM channels they can
 * hear from, the heartbeat clock, and a sequence counter for DISPATCH
 * frames.
 *
 * Lifecycle:
 *   1. ws.connect → server emits HELLO
 *   2. Identify timer starts; if IDENTIFY isn't received in IDENTIFY_TIMEOUT
 *      we close with SESSION_TIMEOUT.
 *   3. On valid IDENTIFY: load membership snapshot, send READY.
 *   4. Heartbeat: client must send HEARTBEAT op every interval. If we don't
 *      see one within INTERVAL + GRACE, drop the connection.
 *   5. On disconnect: registry removes us, event bus subscription cleared.
 *
 * Membership snapshots are loaded once at IDENTIFY time and updated
 * incrementally when the user joins/leaves a guild or opens a new DM.
 * We don't reload on every event — that would re-query the DB on every
 * keystroke from anyone in the guild.
 */

import { nanoid } from 'nanoid';
import type { WebSocket } from 'ws';
import type { GatewayFrame } from '@zekktris/shared/events';
import { GatewayOp } from '@zekktris/shared/events';
import {
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_GRACE_MS,
  IDENTIFY_TIMEOUT_MS,
  helloFrame,
  heartbeatAckFrame,
} from './types';

export class Connection {
  /** Stable id for this connection. Surfaced to the client as `session_id`. */
  readonly id: string = nanoid();

  /** Set after IDENTIFY succeeds. */
  userId: bigint | null = null;

  /** Snapshot of guild ids the user is a member of (post-IDENTIFY). */
  guildIds = new Set<bigint>();

  /** Snapshot of DM channel ids the user is a recipient of (post-IDENTIFY). */
  dmChannelIds = new Set<bigint>();

  /**
   * Snapshot of guild-channel ids the user has VIEW_CHANNEL on. Computed
   * at IDENTIFY by walking each guild's channels with the resolver. The
   * gateway's per-channel audience filter checks this set instead of just
   * "is the user in the guild" so events for a channel a member can't see
   * (because of a DENY override on @everyone or them specifically) don't
   * leak.
   *
   * Maintenance: addGuild() loads the new guild's viewable channels and
   * unions them in; removeGuild() drops every channel that belonged to
   * that guild (we cache the (channelId → guildId) reverse map so we don't
   * need a DB hit on disconnect).
   */
  viewableGuildChannelIds = new Set<bigint>();

  /**
   * Reverse map from a viewable channel back to its guild — only kept for
   * cleanup correctness when a user leaves a guild. Live updates on role
   * or override changes (which can flip channel visibility for an existing
   * member) aren't wired in v1; they're a v1.x maintenance hook.
   */
  channelToGuild = new Map<bigint, bigint>();

  /**
   * Last frame sequence number sent on this connection. Bumped on every
   * DISPATCH; included in the frame so the client can request RESUME later.
   */
  private seq = 0;

  /** Time of last seen HEARTBEAT op from the client. */
  private lastHeartbeatAt = Date.now();

  /** Set when this connection has successfully IDENTIFY'd. */
  private authenticated = false;

  /** When true, no further sends are attempted. Set by close()/disconnect. */
  private closed = false;

  /** Timers we own and must clear on disconnect. */
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private identifyTimer?: ReturnType<typeof setTimeout>;

  /** Optional cleanup hook the registry installs (unsubscribe from bus). */
  onCleanup: (() => void) | null = null;

  constructor(public readonly ws: WebSocket) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Server-side handshake: send HELLO, start identify timeout + heartbeat watch. */
  start(): void {
    this.send(helloFrame(HEARTBEAT_INTERVAL_MS));

    // If IDENTIFY doesn't arrive in time, kick. This shields us from bots
    // that open lots of connections to consume sockets without speaking.
    this.identifyTimer = setTimeout(() => {
      if (!this.authenticated) {
        this.close(CloseCode.SESSION_TIMEOUT, 'IDENTIFY not received in time');
      }
    }, IDENTIFY_TIMEOUT_MS);

    // Watchdog: if HEARTBEAT_INTERVAL + GRACE elapses without a heartbeat,
    // assume the client is gone (their TCP keepalive may not have fired
    // yet) and close the socket.
    this.heartbeatTimer = setInterval(() => {
      const since = Date.now() - this.lastHeartbeatAt;
      if (since > HEARTBEAT_INTERVAL_MS + HEARTBEAT_GRACE_MS) {
        this.close(CloseCode.SESSION_TIMEOUT, 'heartbeat lapsed');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  markAuthenticated(
    userId: bigint,
    guildIds: Iterable<bigint>,
    dmChannelIds: Iterable<bigint>,
    viewableChannels: Iterable<{ channelId: bigint; guildId: bigint }>,
  ): void {
    this.authenticated = true;
    this.userId = userId;
    this.guildIds = new Set(guildIds);
    this.dmChannelIds = new Set(dmChannelIds);
    this.viewableGuildChannelIds = new Set();
    this.channelToGuild = new Map();
    for (const v of viewableChannels) {
      this.viewableGuildChannelIds.add(v.channelId);
      this.channelToGuild.set(v.channelId, v.guildId);
    }
    if (this.identifyTimer) {
      clearTimeout(this.identifyTimer);
      this.identifyTimer = undefined;
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  noteHeartbeat(): void {
    this.lastHeartbeatAt = Date.now();
  }

  // ── Membership-snapshot mutators ─────────────────────────────────────────

  addGuild(guildId: bigint): void {
    this.guildIds.add(guildId);
  }

  /**
   * Add the channels the user can view in a newly-joined guild. The set of
   * viewable channels is computed by the caller (registry helper) so we
   * don't pull a DB dependency into Connection.
   */
  addViewableChannels(guildId: bigint, channelIds: Iterable<bigint>): void {
    for (const cid of channelIds) {
      this.viewableGuildChannelIds.add(cid);
      this.channelToGuild.set(cid, guildId);
    }
  }

  removeGuild(guildId: bigint): void {
    this.guildIds.delete(guildId);
    // Drop every channel that belonged to this guild from the viewable
    // snapshot. We use the reverse map populated at IDENTIFY/addViewable.
    for (const [cid, gid] of this.channelToGuild) {
      if (gid === guildId) {
        this.viewableGuildChannelIds.delete(cid);
        this.channelToGuild.delete(cid);
      }
    }
  }

  /**
   * Single-channel viewability change — used when a channel is created
   * inside a guild the user is already in (and they can see it) or when a
   * permission override flips visibility.
   */
  addViewableChannel(channelId: bigint, guildId: bigint): void {
    this.viewableGuildChannelIds.add(channelId);
    this.channelToGuild.set(channelId, guildId);
  }
  removeViewableChannel(channelId: bigint): void {
    this.viewableGuildChannelIds.delete(channelId);
    this.channelToGuild.delete(channelId);
  }

  addDMChannel(channelId: bigint): void {
    this.dmChannelIds.add(channelId);
  }
  removeDMChannel(channelId: bigint): void {
    this.dmChannelIds.delete(channelId);
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /** Send a frame. DISPATCH frames get the next sequence number. */
  send(frame: GatewayFrame): void {
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;

    let outgoing = frame;
    if (frame.op === GatewayOp.DISPATCH) {
      this.seq++;
      outgoing = { ...frame, s: this.seq };
    }

    try {
      this.ws.send(JSON.stringify(outgoing, jsonReplacer));
    } catch {
      // Send failures are unrecoverable for this connection; drop it.
      this.close(CloseCode.PROTOCOL_ERROR, 'send failed');
    }
  }

  /**
   * Fast-path for fanned-out DISPATCH frames: the registry pre-serializes
   * the body ONCE and passes a partial JSON string here, which we stamp
   * with this connection's next seq via a substring + concat. On a guild
   * with N connected members receiving the same MESSAGE_CREATE we go
   * from N JSON.stringify calls (one per recipient) to 1.
   *
   * `partialJson` is the full DISPATCH frame JSON minus the `s` field —
   * shape `{"op":0,"t":"MESSAGE_CREATE","d":{...}}`. We splice in
   * `,"s":N` immediately before the trailing `}` to produce the final
   * `{"op":0,"t":"MESSAGE_CREATE","d":{...},"s":N}` and ship it.
   *
   * Why string-splice rather than parse + restamp + stringify? Because
   * parsing would defeat the whole optimization — the win is exactly
   * that the body never gets re-walked per recipient.
   */
  sendPreparedDispatch(partialJson: string): void {
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.seq++;
    // partialJson is guaranteed to end with `}` (it's a JSON object).
    // Splice the seq just before the close brace.
    const final = partialJson.slice(0, -1) + ',"s":' + this.seq + '}';
    try {
      this.ws.send(final);
    } catch {
      this.close(CloseCode.PROTOCOL_ERROR, 'send failed');
    }
  }

  /** Convenience: build & send a HEARTBEAT_ACK in one call. */
  ackHeartbeat(): void {
    this.send(heartbeatAckFrame());
  }

  // ── Closing ──────────────────────────────────────────────────────────────

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.identifyTimer) clearTimeout(this.identifyTimer);
    try {
      this.ws.close(code, reason);
    } catch {
      // ws may be in CLOSING already; best-effort.
    }
    if (this.onCleanup) {
      this.onCleanup();
      this.onCleanup = null;
    }
  }

  /** Called from the WebSocket 'close' event — when the peer disconnects. */
  handlePeerClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.identifyTimer) clearTimeout(this.identifyTimer);
    if (this.onCleanup) {
      this.onCleanup();
      this.onCleanup = null;
    }
  }
}

// ── JSON helper ────────────────────────────────────────────────────────────

/**
 * BigInt → decimal string when serializing frames. Snowflake ids and
 * permission bitfields would otherwise throw "Do not know how to serialize
 * a BigInt". DTOs already convert most fields to strings, but defense in
 * depth here means we won't crash on a stray bigint.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
