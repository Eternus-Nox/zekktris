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
    // Install cleanup so when the conn closes, we drop it from indexes.
    conn.onCleanup = () => this.remove(conn);
  }

  /** Called once a connection becomes authenticated. */
  index(conn: Connection): void {
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
    if (conn.userId) {
      const set = this.byUser.get(conn.userId);
      if (set) {
        set.delete(conn);
        if (set.size === 0) {
          this.byUser.delete(conn.userId);
          // Fire the "last connection closed" hook, if installed. Used
          // by the gateway server to clean up voice presence — keeping
          // the actual cleanup logic out of this file so the registry
          // stays free of service-layer imports.
          if (this.onUserFullyDisconnected) {
            try {
              this.onUserFullyDisconnected(conn.userId);
            } catch {
              // Hook errors mustn't take down the connection lifecycle.
              // The hook itself is responsible for logging.
            }
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
    }
  }
}

/** Singleton — initialized once at boot from index.ts. */
export const registry = new Registry();
