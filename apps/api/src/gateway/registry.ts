/**
 * Connection registry
 * -------------------
 * The single source of truth for "who's currently connected." Maintains
 * indexes for the lookups the gateway actually performs:
 *
 *   - byUserId(userId)        every connection a user has open (multi-device)
 *   - all()                   every authenticated connection (rare events)
 *
 * Also holds the subscription on the event bus. When a published event
 * arrives, the registry walks the appropriate candidate set (chosen by the
 * audience descriptor) and asks each connection to filter — a hit gets the
 * frame, a miss is skipped.
 *
 * For guild/channel audiences we use the connection's cached guild &
 * DM-channel sets (populated at IDENTIFY) — no DB query at fanout time.
 *
 * Per-channel permissions: each connection caches a viewableGuildChannelIds
 * set, computed at IDENTIFY by walking each guild's channels with the
 * permission resolver. The 'channel' audience filter checks that set so a
 * member with VIEW_CHANNEL revoked on a single channel doesn't receive its
 * events. Live re-evaluation when a role grants/revokes mid-session is a
 * v1.x maintenance hook; for now connections refresh on reconnect.
 */

import { jsonReplacer } from './connection';
import { GatewayOp } from '@zekktris/shared/events';
import type { Audience } from './types';
import { eventBus, type PublishedEvent } from './bus';
import type { Connection } from './connection';
import { RESUME_WINDOW_MS, RESUME_MAX_DETACHED_SESSIONS } from './resume';

class Registry {
  /** Authenticated only. Pre-IDENTIFY connections aren't here. */
  private byUser = new Map<bigint, Set<Connection>>();

  /** Every connection (authenticated or not), keyed by session id. */
  private bySession = new Map<string, Connection>();

  /**
   * Index from guildId → connections whose snapshot includes this guild.
   * Maintained alongside byUser whenever a connection authenticates,
   * disconnects, or has a guild added/removed via the dispatch helpers.
   *
   * Without this index, guild and channel audience fanout had to scan
   * every authenticated connection on the entire server to find which
   * ones cared about a given guild's event — O(total connections) per
   * chat message. On a server with 10k connected users (typical for
   * moderately-sized self-hosted), each message did 10k+ Set lookups
   * just to find the maybe-50 recipients. With this index, fanout is
   * O(audience size).
   *
   * Channel audience uses the same index plus a per-conn viewability
   * filter (members with DENY VIEW_CHANNEL on a sub-channel are
   * narrowed out by the connection's viewableGuildChannelIds set).
   */
  private byGuild = new Map<bigint, Set<Connection>>();

  /**
   * Same idea for DM channels — index from dmChannelId → connections
   * whose snapshot includes this DM. A DM has 2 recipients, so the
   * audience is tiny, but the previous full-scan was still wasteful
   * (10k connection check to find 2).
   */
  private byDMChannel = new Map<bigint, Set<Connection>>();

  /**
   * Sessions whose socket has dropped but which we're retaining for a
   * possible RESUME. The connection stays in byUser/byGuild/byDM so events
   * during the gap keep buffering into its resumeBuffer (with no live socket
   * write); a timer evicts it after RESUME_WINDOW_MS. Keyed by the logical
   * sessionId the client presents on RESUME.
   */
  private detachedSessions = new Map<
    string,
    { conn: Connection; timer: ReturnType<typeof setTimeout> }
  >();

  /** Whether the bus subscription is active. Set on first init(). */
  private busUnsubscribe: (() => void) | null = null;

  /**
   * Begin listening to the bus. Idempotent; safe to call multiple times.
   * The startup sequence calls this from index.ts.
   */
  init(): void {
    if (this.busUnsubscribe) return;
    this.busUnsubscribe = eventBus().subscribe((event) => this.onPublished(event));
  }

  /** For graceful shutdown / tests. */
  shutdown(): void {
    if (this.busUnsubscribe) {
      this.busUnsubscribe();
      this.busUnsubscribe = null;
    }
    for (const { timer } of this.detachedSessions.values()) clearTimeout(timer);
    this.detachedSessions.clear();
    for (const c of this.bySession.values()) {
      c.close(1001, 'server shutting down');
    }
    this.byUser.clear();
    this.bySession.clear();
    this.byGuild.clear();
    this.byDMChannel.clear();
  }

  // ── Connection registration ──────────────────────────────────────────────

  add(conn: Connection): void {
    this.bySession.set(conn.id, conn);
    // Install cleanup so when the conn's socket closes we either retain it
    // for a possible RESUME (authenticated) or drop it (unauthenticated).
    conn.onCleanup = () => this.handleClose(conn);
  }

  /**
   * Socket-closed handler. An AUTHENTICATED connection is DETACHED — kept in
   * the fan-out indexes (so gap events keep buffering) and retained for the
   * resume window. An unauthenticated connection (never IDENTIFY'd) has
   * nothing to resume, so it's removed immediately as before.
   */
  private handleClose(conn: Connection): void {
    if (conn.isAuthenticated() && conn.userId !== null && !conn.detached) {
      this.detach(conn);
    } else {
      this.remove(conn);
    }
  }

  /**
   * Count of a user's connections that still have a live socket (not
   * detached). Drives the "user fully disconnected" hook so presence/voice
   * cleanup fires at exactly the same moment as before: when the user's last
   * LIVE socket goes away.
   */
  private userLiveCount(userId: bigint): number {
    const set = this.byUser.get(userId);
    if (!set) return 0;
    let n = 0;
    for (const c of set) if (!c.detached) n++;
    return n;
  }

  /**
   * Mark a connection detached: keep it in every index (so events during the
   * gap keep buffering into resumeBuffer with no socket write), retain it for
   * RESUME, and — if it was the user's last live socket — fire the
   * full-disconnect hook now (same timing as a plain disconnect today).
   */
  private detach(conn: Connection): void {
    if (conn.detached || conn.userId === null) {
      this.remove(conn);
      return;
    }
    conn.detached = true;
    const timer = setTimeout(() => this.evictDetached(conn), RESUME_WINDOW_MS);
    // Don't keep the event loop alive just to expire a buffer.
    (timer as { unref?: () => void }).unref?.();
    this.detachedSessions.set(conn.sessionId, { conn, timer });

    // Global memory backstop: if too many sessions are retained (mass
    // disconnect), evict the oldest (Map preserves insertion order).
    if (this.detachedSessions.size > RESUME_MAX_DETACHED_SESSIONS) {
      const oldest = this.detachedSessions.values().next().value;
      if (oldest && oldest.conn !== conn) this.evictDetached(oldest.conn);
    }

    // The full-disconnect hook fires on the live-count 1→0 transition — i.e.
    // when this detach removed the user's last live socket.
    if (this.userLiveCount(conn.userId) === 0 && this.onUserFullyDisconnected) {
      try {
        this.onUserFullyDisconnected(conn.userId);
      } catch {
        // Hook errors mustn't break the lifecycle.
      }
    }
  }

  /** Resume-window expiry: fully remove a detached session. */
  private evictDetached(conn: Connection): void {
    const entry = this.detachedSessions.get(conn.sessionId);
    if (!entry || entry.conn !== conn) return;
    this.remove(conn);
  }

  /** Look up a retained session for RESUME. Null if unknown/expired. */
  findResumable(sessionId: string): Connection | null {
    return this.detachedSessions.get(sessionId)?.conn ?? null;
  }

  /**
   * Complete a RESUME: index the fresh (live) connection and drop the prior
   * detached one. The prior conn is detached, so its removal fires no
   * full-disconnect hook; indexing the new one fires onUserConnected (which
   * cancels any pending voice eviction), so the user is continuously present.
   */
  completeResume(prev: Connection, next: Connection): void {
    this.index(next);
    this.remove(prev);
  }

  /** Called once a connection becomes authenticated. */
  index(conn: Connection): void {
    if (conn.userId !== null && this.onUserConnected) {
      try {
        this.onUserConnected(conn.userId);
      } catch {
        // Hook errors mustn't break indexing.
      }
    }
    if (!conn.userId) return;
    let set = this.byUser.get(conn.userId);
    if (!set) {
      set = new Set();
      this.byUser.set(conn.userId, set);
    }
    set.add(conn);
    // Also seed the per-guild and per-DM indexes from the conn's
    // initial snapshot (populated by the server's IDENTIFY handler
    // before this call). Future incremental mutations go through
    // addGuildToUser / addDMToUser, which keep both indexes in sync.
    for (const gid of conn.guildIds) this.indexAddGuild(conn, gid);
    for (const cid of conn.dmChannelIds) this.indexAddDM(conn, cid);
  }

  remove(conn: Connection): void {
    this.bySession.delete(conn.id);
    // If this connection was being retained for RESUME, drop that retention.
    const retained = this.detachedSessions.get(conn.sessionId);
    if (retained && retained.conn === conn) {
      clearTimeout(retained.timer);
      this.detachedSessions.delete(conn.sessionId);
    }
    if (conn.userId) {
      // Whether removing this connection ends a LIVE socket. A detached conn
      // already stopped counting as live at detach time (when the
      // full-disconnect hook fired), so removing it must NOT fire again.
      const wasLive = !conn.detached;
      const set = this.byUser.get(conn.userId);
      if (set) {
        set.delete(conn);
        if (set.size === 0) this.byUser.delete(conn.userId);
        // Fire the "user fully disconnected" hook only on the live-count
        // 1→0 transition caused by removing a LIVE connection — same moment
        // as before. Cleanup logic lives in the gateway server (keeps the
        // registry free of service-layer imports).
        if (wasLive && this.userLiveCount(conn.userId) === 0 && this.onUserFullyDisconnected) {
          try {
            this.onUserFullyDisconnected(conn.userId);
          } catch {
            // Hook errors mustn't take down the connection lifecycle.
            // The hook itself is responsible for logging.
          }
        }
      }
      // Tear down the per-guild and per-DM index entries we seeded in
      // index(). Done over the conn's current snapshot — incremental
      // mutations have kept those sets aligned with the indexes.
      for (const gid of conn.guildIds) this.indexRemoveGuild(conn, gid);
      for (const cid of conn.dmChannelIds) this.indexRemoveDM(conn, cid);
    }
  }

  // ── Index helpers (internal) ─────────────────────────────────────────────

  private indexAddGuild(conn: Connection, guildId: bigint): void {
    let set = this.byGuild.get(guildId);
    if (!set) {
      set = new Set();
      this.byGuild.set(guildId, set);
    }
    set.add(conn);
  }
  private indexRemoveGuild(conn: Connection, guildId: bigint): void {
    const set = this.byGuild.get(guildId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byGuild.delete(guildId);
  }
  private indexAddDM(conn: Connection, channelId: bigint): void {
    let set = this.byDMChannel.get(channelId);
    if (!set) {
      set = new Set();
      this.byDMChannel.set(channelId, set);
    }
    set.add(conn);
  }
  private indexRemoveDM(conn: Connection, channelId: bigint): void {
    const set = this.byDMChannel.get(channelId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byDMChannel.delete(channelId);
  }

  /**
   * Optional hook fired when a user's LAST connection closes. The hook
   * receives the userId and is intentionally fire-and-forget — return
   * value (or thrown error) is ignored. Install once at startup.
   */
  onUserFullyDisconnected: ((userId: bigint) => void) | null = null;
  /** Fired when a user gains a connection — cancels pending grace-period
      voice evictions scheduled by onUserFullyDisconnected. */
  onUserConnected: ((userId: bigint) => void) | null = null;

  // ── Membership snapshot mutations ────────────────────────────────────────
  //
  // When the user joins/leaves a guild or opens/closes a DM, we need to
  // update every connection they have open so subsequent events route
  // correctly. These mutators are the only API by which an external caller
  // (the dispatch layer) can keep snapshots in sync.

  /**
   * Apply a guild-join to all of the user's open connections. Also seeds
   * each connection's viewable-channel set for the new guild — the caller
   * provides the precomputed channel ids so we don't pull a DB import
   * into this file (and so the lifecycle helper in dispatch.ts can compute
   * once and reuse across N connections of the same user).
   */
  addGuildToUser(userId: bigint, guildId: bigint, viewableChannelIds?: Iterable<bigint>): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const c of set) {
      c.addGuild(guildId);
      if (viewableChannelIds) c.addViewableChannels(guildId, viewableChannelIds);
      // Keep the per-guild index in lockstep with conn.guildIds.
      this.indexAddGuild(c, guildId);
    }
  }

  removeGuildFromUser(userId: bigint, guildId: bigint): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const c of set) {
      c.removeGuild(guildId);
      this.indexRemoveGuild(c, guildId);
    }
  }

  addDMToUser(userId: bigint, channelId: bigint): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const c of set) {
      c.addDMChannel(channelId);
      this.indexAddDM(c, channelId);
    }
  }

  /**
   * Remove a DM channel from every connection a user has open. Called
   * when the user closes a DM — their connections shouldn't receive
   * further events for that channel even though it may still exist
   * in the database (the other party may not have closed their side).
   */
  removeDMFromUser(userId: bigint, channelId: bigint): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    for (const c of set) {
      c.removeDMChannel(channelId);
      this.indexRemoveDM(c, channelId);
    }
  }

  // ── Lookups ──────────────────────────────────────────────────────────────

  byUserId(userId: bigint): Connection[] {
    const set = this.byUser.get(userId);
    return set ? Array.from(set) : [];
  }

  /** Diagnostic: total open connections (incl. unauthenticated). */
  get connectionCount(): number {
    return this.bySession.size;
  }

  /** Diagnostic: count of distinct authenticated users currently connected. */
  get userCount(): number {
    return this.byUser.size;
  }

  /**
   * Enumerate the user IDs of every authenticated user with at least one
   * connection whose snapshot includes `guildId`. Used by the live
   * permission-change helpers in dispatch.ts to find affected users
   * without scanning every connection in the registry.
   *
   * Cost: O(connections-in-this-guild). Was O(total-connections) before
   * the byGuild index landed.
   */
  connectedUsersInGuild(guildId: bigint): bigint[] {
    const set = this.byGuild.get(guildId);
    if (!set) return [];
    const seen = new Set<bigint>();
    const out: bigint[] = [];
    for (const c of set) {
      if (c.userId !== null && !seen.has(c.userId)) {
        seen.add(c.userId);
        out.push(c.userId);
      }
    }
    return out;
  }

  // ── Bus delivery ─────────────────────────────────────────────────────────

  private onPublished(event: PublishedEvent): void {
    // Presence is delivered through a dedicated path: a single published
    // event expands into one frame per shared guild (each carrying its own
    // guild_id) plus a guild_id=null frame for DM peers. The generic
    // pre-serialize-once path below can't express the per-guild guild_id, so
    // it's handled separately.
    if (event.audience.kind === 'presence') {
      this.deliverPresence(event, event.audience);
      return;
    }

    const candidates = this.candidateConnections(event.audience);
    if (candidates.length === 0) return;

    // Pre-serialize the DISPATCH body ONCE. On a guild with N connected
    // members receiving the same MESSAGE_CREATE we previously paid N
    // full JSON.stringify calls of the identical payload — same DTO,
    // same bigint walk, same UTF-8 encoding, just with a different
    // `s` (seq) field per recipient. The seq is now spliced in
    // per-recipient by sendPreparedDispatch via a substring concat,
    // so we walk the payload exactly once regardless of audience
    // size. Heartbeat acks, READY, and other single-recipient frames
    // still go through the plain send() path which keeps its own
    // per-call stringify (no win there — single recipient already).
    const partialJson = JSON.stringify(
      { op: GatewayOp.DISPATCH, t: event.t, d: event.d },
      jsonReplacer,
    );
    for (const conn of candidates) {
      if (this.shouldReceive(conn, event.audience)) {
        conn.sendPreparedDispatch(partialJson);
      }
    }
  }

  /**
   * Deliver a presence/status change. Replaces the previous N publishes
   * (one per guild + one per DM channel) with a single published event
   * expanded here, so under the Redis bus a status flip is ONE cross-replica
   * round-trip instead of O(guilds).
   *
   * The delivered frames are byte-identical to the old path:
   *   - one PRESENCE_UPDATE per guild the recipient shares with the subject,
   *     each stamped with that guild's guild_id (the web reducer keys the
   *     per-guild member-list patch on it; native ignores guild_id entirely);
   *   - a single guild_id=null frame for DM peers. The old path emitted one
   *     null frame per shared DM channel, but the client's null-guild handler
   *     is idempotent (it patches usersById + ALL DM recipients globally), so
   *     collapsing to one frame leaves identical resulting state.
   *
   * Frames are memoized per guild_id within the call, so recipients sharing a
   * guild reuse the same serialized string — same serialization cost as the
   * old per-guild publish, minus the per-guild bus round-trips.
   */
  private deliverPresence(
    event: PublishedEvent,
    audience: Extract<Audience, { kind: 'presence' }>,
  ): void {
    // Deduped union of connections in any shared guild or DM channel. A
    // connection in multiple shared guilds appears once here and receives
    // one frame per shared guild in the loop below.
    const candidates = new Set<Connection>();
    for (const guildId of audience.guildIds) {
      const set = this.byGuild.get(guildId);
      if (set) for (const c of set) candidates.add(c);
    }
    for (const channelId of audience.dmChannelIds) {
      const set = this.byDMChannel.get(channelId);
      if (set) for (const c of set) candidates.add(c);
    }
    if (candidates.size === 0) return;

    const base = event.d as Record<string, unknown>;
    const guildFrameCache = new Map<bigint, string>();
    let nullFrame: string | null = null;

    for (const conn of candidates) {
      if (!conn.isAuthenticated() || conn.userId === null) continue;
      // One frame per guild this connection shares with the subject. The
      // .has guard mirrors the old shouldReceive('guild') check.
      for (const guildId of audience.guildIds) {
        if (!conn.guildIds.has(guildId)) continue;
        let frame = guildFrameCache.get(guildId);
        if (frame === undefined) {
          frame = JSON.stringify(
            { op: GatewayOp.DISPATCH, t: event.t, d: { ...base, guild_id: guildId.toString() } },
            jsonReplacer,
          );
          guildFrameCache.set(guildId, frame);
        }
        conn.sendPreparedDispatch(frame);
      }
      // One null-guild frame if this connection is a recipient of any of the
      // subject's DM channels (mirrors the old shouldReceive('channel', null)
      // check). Idempotent, so a single frame covers all shared DMs.
      let isDmPeer = false;
      for (const channelId of audience.dmChannelIds) {
        if (conn.dmChannelIds.has(channelId)) {
          isDmPeer = true;
          break;
        }
      }
      if (isDmPeer) {
        if (nullFrame === null) {
          nullFrame = JSON.stringify(
            { op: GatewayOp.DISPATCH, t: event.t, d: { ...base, guild_id: null } },
            jsonReplacer,
          );
        }
        conn.sendPreparedDispatch(nullFrame);
      }
    }
  }

  /**
   * Fast-path narrowing of who *might* receive an event. For user-scoped
   * audiences this is O(1); for guild/channel audiences we now use the
   * per-guild and per-DM-channel indexes so we no longer scan every
   * authenticated connection — only ones whose snapshot already
   * includes the relevant guild or DM.
   */
  private candidateConnections(audience: Audience): Connection[] {
    switch (audience.kind) {
      case 'user':
        return this.byUserId(audience.userId);
      case 'users': {
        const out: Connection[] = [];
        for (const uid of audience.userIds) {
          const conns = this.byUser.get(uid);
          if (conns) for (const c of conns) out.push(c);
        }
        return out;
      }
      case 'guild': {
        // O(connections-in-this-guild) — was O(total-connections).
        const set = this.byGuild.get(audience.guildId);
        return set ? Array.from(set) : [];
      }
      case 'channel': {
        if (audience.guildId === null) {
          // DM channel — use the DM index. Audience is at most the
          // two recipients × their open tabs.
          const set = this.byDMChannel.get(audience.channelId);
          return set ? Array.from(set) : [];
        }
        // Guild channel — narrow to connections in this guild. The
        // shouldReceive filter then checks the per-conn viewability
        // set (members with VIEW_CHANNEL denied on this specific
        // channel get filtered out there). Same end result as the
        // old full-scan, much smaller candidate set.
        const set = this.byGuild.get(audience.guildId);
        return set ? Array.from(set) : [];
      }
      case 'presence':
        // Handled by deliverPresence before this is reached. Listed for
        // switch exhaustiveness only.
        return [];
    }
  }

  private shouldReceive(conn: Connection, audience: Audience): boolean {
    if (!conn.isAuthenticated() || conn.userId === null) return false;
    switch (audience.kind) {
      case 'user':
        return conn.userId === audience.userId;
      case 'users':
        return audience.userIds.includes(conn.userId);
      case 'guild':
        return conn.guildIds.has(audience.guildId);
      case 'channel':
        if (audience.guildId === null) {
          // DM channel — must be a recipient.
          return conn.dmChannelIds.has(audience.channelId);
        }
        // Guild channel — must have VIEW_CHANNEL on this specific channel.
        // The connection caches the set at IDENTIFY (and on guild join);
        // a member with VIEW_CHANNEL revoked on a single channel won't be
        // in the set and is correctly filtered out.
        return conn.viewableGuildChannelIds.has(audience.channelId);
      case 'presence':
        // Presence never flows through the generic path (see onPublished →
        // deliverPresence). Listed for switch exhaustiveness only.
        return false;
    }
  }
}

/** Singleton — initialized once at boot from index.ts. */
export const registry = new Registry();
