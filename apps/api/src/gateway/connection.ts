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
  PRESENCE_UPDATE_MIN_INTERVAL_MS,
  helloFrame,
  heartbeatAckFrame,
} from './types';
import { ResumeBuffer } from './resume';

export class Connection {
  /** Stable id for this connection. Surfaced to the client as `session_id`. */
  readonly id: string = nanoid();

  /**
   * Logical session id — what the client stores and presents on RESUME.
   * Defaults to this socket's `id`, but a RESUMEd connection adopts the
   * PRIOR session's id so the resumable identity survives the new socket.
   */
  sessionId: string = this.id;

  /**
   * True once the socket has dropped but we're retaining this connection in
   * the registry's fan-out indexes for the resume window — so events during
   * the gap keep landing in `resumeBuffer` for replay. No live socket; sends
   * buffer only. Set by the registry; cleared by adopting a fresh socket on
   * RESUME.
   */
  detached = false;

  /**
   * Replay buffer of recent DISPATCH frames sent on this session. Created at
   * IDENTIFY; carried across a RESUME. Null for unauthenticated connections
   * (nothing to resume). See gateway/resume.ts.
   */
  resumeBuffer: ResumeBuffer | null = null;

  /** Set after IDENTIFY succeeds. */
  userId: bigint | null = null;

  /** The sign-in session (sessions.id) whose access token authenticated this
   *  socket — lets the page-hide beacon close only the closing browser's
   *  sockets, not the user's other devices. Set by IDENTIFY / RESUME. */
  authSessionId: bigint | null = null;

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
   * Forward index: guild → the viewable channel ids in it. Kept in lockstep
   * with channelToGuild so the per-guild permission-refresh helpers (which
   * run for EVERY connection in a guild on any override/role change) read
   * one map entry instead of scanning the user's entire channelToGuild.
   */
  guildToChannels = new Map<bigint, Set<bigint>>();

  /**
   * This device's activity as its client reports it (IDENTIFY/RESUME
   * `presence`, op 3 PRESENCE_UPDATE): true while the person is using the
   * device. A client that never reports stays true — a legacy connection
   * counts as active, exactly the old "connected = online". Read by the
   * presence recompute (gateway/presence.ts) through the registry.
   */
  presenceActive = true;
  /** This client reports its device's activity (presence in IDENTIFY/RESUME
   *  or an op 3) — an updated client. Legacy clients never do; they count as
   *  active, except that a pre-update client's automatic away marks the
   *  devices of those that could have set it as idle (presence.ts). */
  reportsActivity = false;
  /** For a legacy client: whether it is one that set Away by itself (old
   *  iOS, the old desktop app), from its User-Agent at connect — see
   *  lib/legacyClients.ts. */
  legacyAutoAway = true;
  /** A RESUME was attempted on this socket. An IDENTIFY after it (the
   *  RESUME refused — another replica, a restarted server) comes from the
   *  same running app, not a new session. */
  resumeAttempted = false;

  /** When an op-3 change was last applied (rate limit), and the latest value
   *  that arrived too soon, applied when the window reopens. */
  private presenceAppliedAt = 0;
  private presencePending: boolean | null = null;
  private presenceTimer?: ReturnType<typeof setTimeout>;

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
    //
    // Polled every GRACE, not every INTERVAL. The threshold is unchanged, but
    // a check that only ran every INTERVAL could overshoot it by nearly a full
    // interval: a client dying just after a heartbeat was detected at up to
    // 2*INTERVAL + GRACE (~70 s), not the ~40 s the constants read as. Ticking
    // on the smaller of the two bounds the overshoot to GRACE. No extra
    // traffic — this timer only compares a timestamp.
    this.heartbeatTimer = setInterval(() => {
      const since = Date.now() - this.lastHeartbeatAt;
      if (since > HEARTBEAT_INTERVAL_MS + HEARTBEAT_GRACE_MS) {
        this.close(CloseCode.SESSION_TIMEOUT, 'heartbeat lapsed');
      }
    }, HEARTBEAT_GRACE_MS);
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
    this.guildToChannels = new Map();
    for (const v of viewableChannels) {
      this.addViewableChannel(v.channelId, v.guildId);
    }
    // Fresh session → fresh replay buffer (RESUME adopts the prior one
    // instead, via adoptResumedSession).
    if (!this.resumeBuffer) this.resumeBuffer = new ResumeBuffer();
    if (this.identifyTimer) {
      clearTimeout(this.identifyTimer);
      this.identifyTimer = undefined;
    }
    // Catch-all for achievement unlocks: on every fresh identify (app open /
    // new session) reconcile the user's earned ledger and notify any newly-
    // unlocked ones. Throttled + fire-and-forget so it never blocks the
    // handshake; guarantees an unlock is announced by next connect even if no
    // hotter hook fired for it.
    void import('../services/achievements')
      .then((m) => m.syncAndNotifyAchievementsThrottled(userId))
      .catch(() => {});
  }

  /** Current outbound sequence number (last seq sent). */
  get currentSeq(): number {
    return this.seq;
  }

  /**
   * Take over a RESUMEd session: adopt the prior connection's identity,
   * routing snapshot, sequence counter and replay buffer onto this fresh
   * socket, so the stream continues seamlessly. The caller (RESUME handler)
   * then replays the buffered suffix and re-indexes this connection live.
   */
  adoptResumedSession(prev: Connection): void {
    this.authenticated = true;
    this.userId = prev.userId;
    this.sessionId = prev.sessionId;
    this.guildIds = prev.guildIds;
    this.dmChannelIds = prev.dmChannelIds;
    this.viewableGuildChannelIds = prev.viewableGuildChannelIds;
    this.channelToGuild = prev.channelToGuild;
    this.guildToChannels = prev.guildToChannels;
    this.seq = prev.currentSeq;
    this.resumeBuffer = prev.resumeBuffer;
    // The device is the same one; the RESUME handler overrides this when the
    // client sent its current activity.
    this.presenceActive = prev.presenceActive;
    this.reportsActivity = prev.reportsActivity;
    if (this.identifyTimer) {
      clearTimeout(this.identifyTimer);
      this.identifyTimer = undefined;
    }
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /**
   * True once this connection is closing/closed (either side initiated).
   * The IDENTIFY handler checks this after its async snapshot loads —
   * registering a connection whose close hook already ran would leak it
   * into the registry indexes with no cleanup path.
   */
  isClosed(): boolean {
    return this.closed;
  }

  noteHeartbeat(): void {
    this.lastHeartbeatAt = Date.now();
  }

  /**
   * Apply an op-3 activity report. A value equal to the current one is
   * ignored. Changes are applied at most once per
   * PRESENCE_UPDATE_MIN_INTERVAL_MS: one arriving sooner is held and applied
   * when the window reopens, and further ones in the meantime just replace it
   * (latest wins) — a flapping client costs one recompute per window and its
   * final state is never lost. Never closes the socket. `onChange` runs after
   * each applied change (the caller recomputes the user's presence).
   */
  reportPresenceActivity(active: boolean, onChange: () => void): void {
    if (this.closed) return;
    if (this.presenceTimer) {
      this.presencePending = active;
      return;
    }
    if (active === this.presenceActive) return;
    const wait = this.presenceAppliedAt + PRESENCE_UPDATE_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.applyPresenceActivity(active, onChange);
      return;
    }
    this.presencePending = active;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      const next = this.presencePending;
      this.presencePending = null;
      if (next === null || this.closed || next === this.presenceActive) return;
      this.applyPresenceActivity(next, onChange);
    }, wait);
    (this.presenceTimer as { unref?: () => void }).unref?.();
  }

  private applyPresenceActivity(active: boolean, onChange: () => void): void {
    this.presenceActive = active;
    this.presenceAppliedAt = Date.now();
    onChange();
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
      this.addViewableChannel(cid, guildId);
    }
  }

  removeGuild(guildId: bigint): void {
    this.guildIds.delete(guildId);
    // Drop every channel that belonged to this guild from the viewable
    // snapshot — one forward-index lookup instead of scanning the whole
    // channelToGuild map.
    const channels = this.guildToChannels.get(guildId);
    if (channels) {
      for (const cid of channels) {
        this.viewableGuildChannelIds.delete(cid);
        this.channelToGuild.delete(cid);
      }
      this.guildToChannels.delete(guildId);
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
    let set = this.guildToChannels.get(guildId);
    if (!set) {
      set = new Set();
      this.guildToChannels.set(guildId, set);
    }
    set.add(channelId);
  }
  removeViewableChannel(channelId: bigint): void {
    this.viewableGuildChannelIds.delete(channelId);
    const guildId = this.channelToGuild.get(channelId);
    this.channelToGuild.delete(channelId);
    if (guildId !== undefined) {
      const set = this.guildToChannels.get(guildId);
      if (set) {
        set.delete(channelId);
        if (set.size === 0) this.guildToChannels.delete(guildId);
      }
    }
  }

  addDMChannel(channelId: bigint): void {
    this.dmChannelIds.add(channelId);
  }
  removeDMChannel(channelId: bigint): void {
    this.dmChannelIds.delete(channelId);
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /** Send a frame. DISPATCH frames get the next sequence number and are
   *  recorded in the replay buffer (so they can be replayed on RESUME),
   *  including while detached (no live socket — buffer only). */
  send(frame: GatewayFrame): void {
    if (frame.op === GatewayOp.DISPATCH) {
      this.seq++;
      const outgoing = { ...frame, s: this.seq };
      const json = JSON.stringify(outgoing, jsonReplacer);
      this.resumeBuffer?.append(this.seq, json, Date.now());
      if (this.detached) return; // no live socket; buffered for replay only
      if (this.closed) return;
      if (this.ws.readyState !== this.ws.OPEN) return;
      try {
        this.ws.send(json);
      } catch {
        this.close(CloseCode.PROTOCOL_ERROR, 'send failed');
      }
      return;
    }
    // Non-DISPATCH control frame: no seq, not buffered, never to a dead socket.
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame, jsonReplacer));
    } catch {
      // Send failures are unrecoverable for this connection; drop it.
      this.close(CloseCode.PROTOCOL_ERROR, 'send failed');
    }
  }

  /**
   * Replay a previously-buffered frame VERBATIM — no seq bump, no re-buffer.
   * Used by the RESUME handler to re-send the suffix the client missed,
   * preserving the original sequence numbers and permission-filtered bytes.
   */
  sendRaw(json: string): void {
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(json);
    } catch {
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
    // Always advance the seq + record in the replay buffer, even while
    // detached — that's exactly how events occurring DURING a disconnect gap
    // get captured for replay on RESUME.
    this.seq++;
    // partialJson is guaranteed to end with `}` (it's a JSON object).
    // Splice the seq just before the close brace.
    const final = partialJson.slice(0, -1) + ',"s":' + this.seq + '}';
    this.resumeBuffer?.append(this.seq, final, Date.now());
    if (this.detached) return; // no live socket; buffered for replay only
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return;
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
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
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
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
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
