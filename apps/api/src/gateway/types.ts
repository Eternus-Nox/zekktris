/**
 * Gateway internal types
 * ----------------------
 * Distinct from `@zekktris/shared/events`: that package holds the wire
 * protocol (op codes, event names, payload shapes the client also sees).
 * This file holds server-side constructs the client never sees:
 *   - Audience descriptors used to route events to the right connections
 *   - The internal ConnectionState shape
 *   - Helpers to build dispatch frames with sequence numbers
 */

import type { GatewayEventName, GatewayFrame } from '@zekktris/shared/events';
import { GatewayOp } from '@zekktris/shared/events';

// ── Audience ──────────────────────────────────────────────────────────────

/**
 * Describes who should receive an event. The dispatch layer attaches this
 * to every published event; the registry uses it to filter connections.
 *
 * Why not just compute "list of user IDs to notify" upfront? Because it
 * changes the cost model. With an Audience descriptor, dispatch is O(1) and
 * the filter cost is paid per active connection (sublinear on most events).
 * Computing the user list upfront would be O(M) per event where M is the
 * number of guild members, even if only a handful are connected.
 */
export type Audience =
  /** Specific user — both their connections (multi-device) get the event. */
  | { kind: 'user'; userId: bigint }
  /**
   * One DM recipient's connections that still hold the DM in their snapshot:
   * a viewer-relative DM event (CHANNEL_UPDATE carries that viewer's own DTO)
   * with the DM-channel audience's guarantee that a recipient who has closed
   * the DM doesn't get it back.
   */
  | { kind: 'dmRecipient'; userId: bigint; channelId: bigint }
  /** Every member of a guild (no per-channel filter). Used for guild-wide events. */
  | { kind: 'guild'; guildId: bigint }
  /**
   * Everyone with VIEW_CHANNEL on this channel. For DM channels, that's
   * the recipients; for guild channels, that's everyone with the bit set
   * in their effective channel permissions.
   */
  | { kind: 'channel'; channelId: bigint; guildId: bigint | null }
  /** Multiple specific users. Cheaper than emitting N user-audience events. */
  | { kind: 'users'; userIds: bigint[] }
  /**
   * A presence/status change for one user, destined for every guild they're
   * in PLUS their DM peers. Replaces what used to be N separate publishes
   * (one `guild` audience per guild + one `channel` audience per DM) with a
   * SINGLE bus publish — important under the Redis bus, where each publish is
   * a cross-replica round-trip. The registry expands this at delivery into
   * the exact same per-guild frames (each carrying its own `guild_id`, which
   * the web client uses to patch that guild's member list) plus one
   * `guild_id: null` frame for DM peers. No DB queries — the caller supplies
   * the membership lists. The payload `d` carries `{ user_id, status }`; the
   * per-frame `guild_id` is injected at delivery time.
   */
  | { kind: 'presence'; guildIds: bigint[]; dmChannelIds: bigint[]; userIds: bigint[] }
  /**
   * A profile change (USER_UPDATE) for one user, destined for every guild
   * they're in PLUS explicit extra recipients (their DM peers + themselves
   * for multi-tab sync). Like `presence`, this collapses what used to be N
   * separate publishes (one `guild` audience per guild + one `user` audience
   * for self + one per DM peer) into a SINGLE bus publish — one cross-replica
   * round-trip under the Redis bus instead of O(guilds).
   *
   * Unlike `presence`, the delivered frame is IDENTICAL for every recipient
   * (the USER_UPDATE wire carries no per-recipient `guild_id` — clients key
   * the upsert on `user.id` and patch every guild/DM that references it). So
   * this flows through the generic pre-serialize-once delivery path: the
   * registry only has to resolve the deduped union of (guild members ∪ listed
   * users) as the candidate set. A connection in several of the subject's
   * guilds — or in a guild AND the user list — receives exactly one frame.
   */
  | { kind: 'multiUser'; guildIds: bigint[]; userIds: bigint[] };

// ── Frame helpers ──────────────────────────────────────────────────────────

/**
 * Build a DISPATCH frame. Sequence number is filled in per-connection at send
 * time (different connections may be at different points in their stream
 * because of dropped frames or future RESUME catch-up).
 */
export function dispatchFrame<T>(t: GatewayEventName, d: T): GatewayFrame<T> {
  return { op: GatewayOp.DISPATCH, t, d };
}

export function helloFrame(heartbeatIntervalMs: number): GatewayFrame {
  return {
    op: GatewayOp.HELLO,
    d: { heartbeat_interval: heartbeatIntervalMs },
  };
}

export function heartbeatAckFrame(): GatewayFrame {
  return { op: GatewayOp.HEARTBEAT_ACK };
}

export function invalidSessionFrame(resumable: boolean): GatewayFrame {
  return { op: GatewayOp.INVALID_SESSION, d: { resumable } };
}

// ── Heartbeat constants ────────────────────────────────────────────────────

/** How often the client must send HEARTBEAT, baked into HELLO. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Grace period above the interval before we drop the connection. If the
 * client hasn't pinged in HEARTBEAT_INTERVAL + GRACE, they're gone.
 */
export const HEARTBEAT_GRACE_MS = 10_000;

/** Window for IDENTIFY after connect; close the socket if not received. */
export const IDENTIFY_TIMEOUT_MS = 15_000;

// ── Close codes ────────────────────────────────────────────────────────────
//
// Custom close codes in the 4000-4999 range. These mirror Discord's
// vocabulary so a client written against either can be ported.

export const CloseCode = {
  /** Normal closure (client/server initiated). */
  NORMAL: 1000,
  /** Generic protocol error (malformed frame, etc). */
  PROTOCOL_ERROR: 4000,
  AUTHENTICATION_FAILED: 4004,
  ALREADY_AUTHENTICATED: 4005,
  SESSION_TIMEOUT: 4009,
  RATE_LIMITED: 4008,
} as const;
