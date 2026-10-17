/**
 * Dispatch API
 * ------------
 * Service-facing entrypoint for emitting gateway events. Each function:
 *   - takes the domain object (a message, a member, etc.)
 *   - resolves the right Audience descriptor
 *   - publishes via the event bus
 *
 * Services depend on this module — not on the connection registry, the
 * event bus, or `ws` directly. That keeps the dependency graph clean
 * (services depend on dispatch; gateway depends on services nothing) and
 * makes the dispatch surface easy to swap or stub for tests.
 *
 * Adding a new event:
 *   1. Make sure the event name exists in @zekktris/shared/events.GatewayEvent
 *   2. Add a typed function here
 *   3. Call it from the relevant service after the DB write commits
 */

import { GatewayEvent } from '@zekktris/shared/events';
import { eventBus } from './bus';
import { registry } from './registry';
import type { Audience } from './types';
import { dispatchFrame } from './types';
import * as permissions from '../services/permissions';
import * as channelsSvc from '../services/channels';
import * as voice from '../services/voice';
import { db, schema } from '../db';
import { and, eq } from 'drizzle-orm';
import { toChannel, leftVoiceStateDTO } from '../lib/dto';

/** Shared empty set for "no viewable channels in this guild" lookups. */
const EMPTY_CHANNEL_SET: ReadonlySet<bigint> = new Set();

function publish(t: typeof GatewayEvent[keyof typeof GatewayEvent], d: unknown, audience: Audience): void {
  eventBus().publish({ t, d, audience });
}

// ── Message events ─────────────────────────────────────────────────────────

export function messageCreate(payload: { messageDTO: unknown; channelId: bigint; guildId: bigint | null }): void {
  publish(GatewayEvent.MESSAGE_CREATE, payload.messageDTO, {
    kind: 'channel',
    channelId: payload.channelId,
    guildId: payload.guildId,
  });
}

export function messageUpdate(payload: { messageDTO: unknown; channelId: bigint; guildId: bigint | null }): void {
  publish(GatewayEvent.MESSAGE_UPDATE, payload.messageDTO, {
    kind: 'channel',
    channelId: payload.channelId,
    guildId: payload.guildId,
  });
}

export function messageDelete(payload: { messageId: bigint; channelId: bigint; guildId: bigint | null }): void {
  publish(
    GatewayEvent.MESSAGE_DELETE,
    {
      id: payload.messageId.toString(),
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

/**
 * Focused poll-only delta. Currently fired by the expiry sweep when
 * closed_at flips. Payload carries enough for the client reducer to
 * locate the message and patch the poll subtree in place — much
 * cheaper than rebuilding + broadcasting the full message DTO when
 * only one field changed.
 */
export function messagePollUpdate(payload: {
  pollId: bigint;
  messageId: bigint;
  channelId: bigint;
  guildId: bigint | null;
  closedAt: Date;
}): void {
  publish(
    GatewayEvent.MESSAGE_POLL_UPDATE,
    {
      poll_id: payload.pollId.toString(),
      message_id: payload.messageId.toString(),
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
      closed_at: payload.closedAt.toISOString(),
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

/**
 * Notify a channel that a batch of messages got soft-deleted in a
 * single operation (channel purge, future "select N messages and
 * delete" mod tool, etc). Mirrors Discord's MESSAGE_DELETE_BULK so
 * clients can wipe multiple ids from local state in one reducer
 * run instead of N MESSAGE_DELETE events. Same channel-scoped
 * audience as MESSAGE_DELETE.
 */
export function messageDeleteBulk(payload: {
  messageIds: bigint[];
  channelId: bigint;
  guildId: bigint | null;
}): void {
  publish(
    GatewayEvent.MESSAGE_DELETE_BULK,
    {
      ids: payload.messageIds.map((id) => id.toString()),
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

/**
 * Notify the channel that the pinned-message set changed. Discord ships
 * this as a separate event from MESSAGE_UPDATE so clients can refresh
 * the pinned-list panel without re-rendering the whole message stream.
 * We mirror that contract.
 */
export function channelPinsUpdate(payload: {
  channelId: bigint;
  guildId: bigint | null;
  /** ISO 8601 timestamp of the most recent pin/unpin in this channel.
      Clients use it to detect "you have new pins to look at" badging. */
  lastPinTimestamp: string;
}): void {
  publish(
    GatewayEvent.CHANNEL_PINS_UPDATE,
    {
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
      last_pin_timestamp: payload.lastPinTimestamp,
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

// ── Reaction events ────────────────────────────────────────────────────────

export function reactionAdd(payload: {
  messageId: bigint;
  channelId: bigint;
  guildId: bigint | null;
  userId: bigint;
  emoji: string;
}): void {
  publish(
    GatewayEvent.MESSAGE_REACTION_ADD,
    {
      message_id: payload.messageId.toString(),
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
      user_id: payload.userId.toString(),
      emoji: payload.emoji,
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

export function reactionRemove(payload: {
  messageId: bigint;
  channelId: bigint;
  guildId: bigint | null;
  userId: bigint;
  emoji: string;
}): void {
  publish(
    GatewayEvent.MESSAGE_REACTION_REMOVE,
    {
      message_id: payload.messageId.toString(),
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
      user_id: payload.userId.toString(),
      emoji: payload.emoji,
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

export function reactionRemoveAll(payload: {
  messageId: bigint;
  channelId: bigint;
  guildId: bigint | null;
  /**
   * If set, only this emoji's reactions were cleared. If omitted, ALL
   * reactions on the message were cleared. The same event covers both
   * cases — the client switches on presence of `emoji` in the payload.
   */
  emoji?: string;
}): void {
  publish(
    GatewayEvent.MESSAGE_REACTION_REMOVE_ALL,
    {
      message_id: payload.messageId.toString(),
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
      ...(payload.emoji !== undefined ? { emoji: payload.emoji } : {}),
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

// ── Channel events ─────────────────────────────────────────────────────────

/**
 * Publish CHANNEL_UPDATE to viewers only. The previous `kind: 'guild'`
 * audience leaked rename/topic-change information about private channels
 * to members who couldn't see them; `kind: 'channel'` filters on the
 * per-connection viewable set, so only members with VIEW_CHANNEL receive
 * the update.
 */
export function channelUpdate(args: { channelDTO: unknown; channelId: bigint; guildId: bigint }): void {
  publish(GatewayEvent.CHANNEL_UPDATE, args.channelDTO, {
    kind: 'channel',
    channelId: args.channelId,
    guildId: args.guildId,
  });
}

/**
 * Publish CHANNEL_DELETE to viewers only. By the time this fires the
 * channel is already gone in DB, so further events will never reference
 * it again — the stale entries in connection caches are harmless. We
 * rely on next-IDENTIFY to fully clean those out; live cleanup is a
 * v1.x.5 housekeeping concern.
 */
export function channelDelete(args: { channelDTO: unknown; channelId: bigint; guildId: bigint }): void {
  publish(GatewayEvent.CHANNEL_DELETE, args.channelDTO, {
    kind: 'channel',
    channelId: args.channelId,
    guildId: args.guildId,
  });
}

// channelCreate is intentionally NOT exported as a one-shot publish anymore.
// Channel creation goes through `applyGuildPermissionChange(guildId)` in the
// route handler — that helper sends a per-user CHANNEL_CREATE only to
// connected members who actually gained visibility, so it covers the
// "channel born with default perms, everyone sees it" case AND the future
// "channel born with overrides" case (not currently exposed by the API but
// the dispatch path already supports it). The previous guild-broadcast
// duplicated those events and could leak channels to members who couldn't
// see them, both of which the visibility-transition path avoids.

// ── Guild events ───────────────────────────────────────────────────────────

export function guildUpdate(guildDTO: unknown, guildId: bigint): void {
  publish(GatewayEvent.GUILD_UPDATE, guildDTO, { kind: 'guild', guildId });
}

// ── Member events ──────────────────────────────────────────────────────────

export function guildMemberUpdate(memberDTO: unknown, guildId: bigint): void {
  publish(GatewayEvent.GUILD_MEMBER_UPDATE, memberDTO, { kind: 'guild', guildId });
}

// ── Role events ────────────────────────────────────────────────────────────

export function guildRoleCreate(roleDTO: unknown, guildId: bigint): void {
  publish(GatewayEvent.GUILD_ROLE_CREATE, roleDTO, { kind: 'guild', guildId });
}

export function guildRoleUpdate(roleDTO: unknown, guildId: bigint): void {
  publish(GatewayEvent.GUILD_ROLE_UPDATE, roleDTO, { kind: 'guild', guildId });
}

export function guildRoleDelete(payload: { guildId: bigint; roleId: bigint }): void {
  publish(
    GatewayEvent.GUILD_ROLE_DELETE,
    {
      guild_id: payload.guildId.toString(),
      role_id: payload.roleId.toString(),
    },
    { kind: 'guild', guildId: payload.guildId },
  );
}

/**
 * Custom emoji updated — broadcast the full current list of emojis for
 * this guild so the client can replace its local index in one assign.
 * We use a bulk payload (rather than separate add/remove/rename events)
 * because emoji edits are infrequent and the list is small (≤50 per
 * guild by current limit), so the wire-cost difference is negligible
 * but the client code is simpler.
 */
export function guildEmojisUpdate(payload: { guildId: bigint; emojis: unknown[] }): void {
  publish(
    GatewayEvent.GUILD_EMOJIS_UPDATE,
    {
      guild_id: payload.guildId.toString(),
      emojis: payload.emojis,
    },
    { kind: 'guild', guildId: payload.guildId },
  );
}

export function guildStickersUpdate(payload: { guildId: bigint; stickers: unknown[] }): void {
  publish(
    GatewayEvent.GUILD_STICKERS_UPDATE,
    {
      guild_id: payload.guildId.toString(),
      stickers: payload.stickers,
    },
    { kind: 'guild', guildId: payload.guildId },
  );
}

/**
 * Stage participants — fan out the post-mutation list to every member
 * of the owning guild. Audience members receive this so they can see
 * speaker promotions / hand-raise activity; mods see it for the queue
 * UI. Bulk replace mirrors the emoji/sticker convention.
 */
export function stageParticipantsUpdate(payload: {
  guildId: bigint;
  channelId: bigint;
  participants: unknown[];
}): void {
  publish(
    GatewayEvent.STAGE_PARTICIPANTS_UPDATE,
    {
      guild_id: payload.guildId.toString(),
      channel_id: payload.channelId.toString(),
      participants: payload.participants,
    },
    // Channel audience, matching voiceStateUpdate. This was a 'guild'
    // audience, which fanned every stage roster to EVERY member of the
    // guild — leaking both the existence of a private stage channel and
    // who is on it to members without VIEW_CHANNEL. The 'channel' branch
    // of shouldReceive filters against conn.viewableGuildChannelIds, so
    // non-viewers are excluded with no other change needed.
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

// ── Scheduled events ───────────────────────────────────────────────────────
//
// Each broadcast goes to every member of the owning guild. The
// payload for create/update is the ScheduledEventDTO; delete is the
// minimal { eventId, guildId } pair. Per-recipient fields
// (rsvpCounts, myRsvp) are NOT included in broadcasts — the
// broadcast crosses recipient boundaries so per-recipient data
// would be wrong for every receiver. Clients preserve their own
// rsvpCounts/myRsvp on apply.

export function scheduledEventCreate(eventDTO: unknown, guildId: bigint): void {
  publish(GatewayEvent.SCHEDULED_EVENT_CREATE, eventDTO, { kind: 'guild', guildId });
}

export function scheduledEventUpdate(eventDTO: unknown, guildId: bigint): void {
  publish(GatewayEvent.SCHEDULED_EVENT_UPDATE, eventDTO, { kind: 'guild', guildId });
}

export function scheduledEventDelete(payload: { eventId: bigint; guildId: bigint }): void {
  publish(
    GatewayEvent.SCHEDULED_EVENT_DELETE,
    {
      event_id: payload.eventId.toString(),
      guild_id: payload.guildId.toString(),
    },
    { kind: 'guild', guildId: payload.guildId },
  );
}

// ── Typing / presence ──────────────────────────────────────────────────────

export function typingStart(payload: {
  channelId: bigint;
  guildId: bigint | null;
  userId: bigint;
}): void {
  publish(
    GatewayEvent.TYPING_START,
    {
      channel_id: payload.channelId.toString(),
      guild_id: payload.guildId?.toString() ?? null,
      user_id: payload.userId.toString(),
      timestamp: Math.floor(Date.now() / 1000),
    },
    { kind: 'channel', channelId: payload.channelId, guildId: payload.guildId },
  );
}

/**
 * A poke / nudge. Ephemeral — creates NO message and no history; it's purely a
 * notification. Goes to the DM channel audience; recipients surface it
 * transiently and skip it if they're the initiator. (A closed app is reached by
 * the push the route sends alongside this.)
 */
export function poke(payload: {
  channelId: bigint;
  pokeType: string;
  emoji: string;
  initiatorId: bigint;
  initiatorName: string;
}): void {
  publish(
    GatewayEvent.POKE,
    {
      channel_id: payload.channelId.toString(),
      poke_type: payload.pokeType,
      emoji: payload.emoji,
      initiator_id: payload.initiatorId.toString(),
      initiator_name: payload.initiatorName,
    },
    { kind: 'channel', channelId: payload.channelId, guildId: null },
  );
}

export function presenceUpdate(payload: {
  userId: bigint;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  guildIds: bigint[];
  /**
   * DM channel ids the user is part of. Without this, two users who
   * only know each other via DM never see each other's presence
   * change — the guild fan-out below would skip them entirely. The
   * caller (gateway server's onUserFullyDisconnected hook + IDENTIFY
   * online-flip) loads these alongside guildIds.
   */
  dmChannelIds?: bigint[];
  /**
   * Accepted-friend user ids. Delivered a single guild_id=null frame each so
   * a friend who shares NO guild and NO DM channel still sees the subject's
   * status change live (the null frame drives usersById + the Friends dot).
   * The caller loads these via relationships.listAcceptedFriendIds.
   */
  userIds?: bigint[];
}): void {
  // ONE bus publish carrying the user's full membership footprint. The
  // registry expands it at delivery into the exact frames the previous
  // implementation sent: one PRESENCE_UPDATE per guild the recipient
  // shares with the user (each stamped with that guild_id — the web client
  // uses it to patch that guild's member list), plus a single guild_id=null
  // frame for DM peers (the client's reducer treats null guild_id as a
  // no-op for the member-list patch but still updates usersById, which
  // drives the DM list's status dot). Collapsing the previous per-guild +
  // per-DM publishes into one matters most under the Redis bus, where each
  // publish was a cross-replica round-trip × O(guilds) per status flip.
  //
  // The top-level `d` carries only the guild-invariant fields; guild_id is
  // injected per-frame by the registry so each guild still gets its own.
  const guildIds = payload.guildIds;
  const dmChannelIds = payload.dmChannelIds ?? [];
  const userIds = payload.userIds ?? [];
  if (guildIds.length === 0 && dmChannelIds.length === 0 && userIds.length === 0) return;
  publish(
    GatewayEvent.PRESENCE_UPDATE,
    {
      user_id: payload.userId.toString(),
      status: payload.status,
    },
    { kind: 'presence', guildIds, dmChannelIds, userIds },
  );
}

/**
 * The user's profile changed (display name, bio, custom status, avatar).
 * Fired to every guild they belong to so co-members see the update
 * without waiting for the next message-they-send to refresh their
 * cached author payload. Self also receives it (to keep multi-tab
 * sessions in sync).
 *
 * Payload uses snake_case to match the rest of the gateway wire
 * format. We send the *full* updated PublicUser shape so clients
 * can do a single replace into state.usersById without merging.
 */
export function userUpdate(payload: {
  userId: bigint;
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    bio: string | null;
    customStatus: string | null;
    status: 'online' | 'idle' | 'dnd' | 'offline';
  };
  guildIds: bigint[];
  /** User ids to ALSO receive this update directly — typically DM
      peers of the user, since they wouldn't otherwise get the event
      via guild fan-out (a DM-only friend shares no guild with the
      updating user). Optional; omit when the caller only cares
      about guild members seeing the change. */
  userIds?: bigint[];
}): void {
  // Wire payload mirrors the type the client expects from REST; we
  // emit `user` directly so the gateway handler can just dispatch
  // USER_UPSERT into the cache.
  const wire = {
    user: {
      id: payload.user.id,
      username: payload.user.username,
      display_name: payload.user.displayName,
      avatar_url: payload.user.avatarUrl,
      bio: payload.user.bio,
      custom_status: payload.user.customStatus,
      status: payload.user.status,
    },
  };
  // Recipients: the subject's guild co-members + the subject themselves (so a
  // guild-less user still syncs across their own tabs) + any explicit user
  // targets (typically DM peers, who share no guild). Assemble the explicit
  // user list as self + deduped extras; the `multiUser` audience expands at
  // delivery into the deduped union of (guild members ∪ these users).
  const userIds: bigint[] = [payload.userId];
  if (payload.userIds) {
    for (const otherId of payload.userIds) {
      // Skip self (already present) and any caller-supplied duplicates.
      if (otherId !== payload.userId && !userIds.includes(otherId)) {
        userIds.push(otherId);
      }
    }
  }
  // ONE bus publish (was O(guilds) + 1 for self + 1 per DM peer) — a single
  // cross-replica round-trip under the Redis bus. The frame is identical for
  // every recipient (USER_UPDATE carries no per-recipient guild_id), so this
  // rides the generic pre-serialize-once delivery path and each connection
  // gets exactly one frame even when it sits in several of these guilds.
  publish(GatewayEvent.USER_UPDATE, wire, {
    kind: 'multiUser',
    guildIds: payload.guildIds,
    userIds,
  });
}

// ── Lifecycle helpers ──────────────────────────────────────────────────────
//
// These bundle the multi-event flows that happen when a user crosses a
// membership boundary. Calling sites (routes/services) shouldn't have to
// remember to fire two events plus update the registry — the helper does it.

/**
 * The user just joined `guildId`. Two things happen:
 *   1. Update the user's connection snapshot so subsequent guild-scoped
 *      events route to them.
 *   2. Fire GUILD_CREATE to the joining user (so their UI can render the
 *      new guild) and GUILD_MEMBER_ADD to the rest of the guild.
 *
 * Order: snapshot update FIRST, then events. Otherwise the GUILD_MEMBER_ADD
 * we fire wouldn't actually reach the joining user (filter would say "not
 * in this guild yet").
 */
export function userJoinedGuild(args: {
  userId: bigint;
  guildId: bigint;
  guildDTO: unknown;
  memberDTO: unknown;
  /**
   * Channel ids the joining user can VIEW_CHANNEL on in the new guild.
   * The route layer computes this (it already has a member context handy
   * after persisting the join) and passes it in so the registry can update
   * each connection's viewable-channel cache without a DB hit. If absent
   * we fall back to "guild membership only" — the per-channel filter still
   * works correctly because it's a Set lookup, just on an empty set, which
   * means the user gets no per-channel events until reconnect rebuilds
   * the cache. Documented; callers should pass the list when available.
   */
  viewableChannelIds?: bigint[];
}): void {
  registry.addGuildToUser(args.userId, args.guildId, args.viewableChannelIds);
  // The user may be connected to another replica — update its snapshot too.
  // Signalled BEFORE the events below; the bus preserves publish order, so the
  // peer applies the join before GUILD_MEMBER_ADD reaches its filter.
  publishMembershipRemote(
    {
      op: 'guild_add',
      userId: args.userId.toString(),
      guildId: args.guildId.toString(),
      viewableChannelIds: args.viewableChannelIds?.map((id) => id.toString()),
    },
    { kind: 'user', userId: args.userId },
  );
  publish(GatewayEvent.GUILD_CREATE, args.guildDTO, { kind: 'user', userId: args.userId });
  publish(GatewayEvent.GUILD_MEMBER_ADD, args.memberDTO, { kind: 'guild', guildId: args.guildId });
}

/**
 * The user is no longer a member of `guildId` (left, kicked, banned, or
 * the guild was deleted). We notify the rest of the guild they're gone,
 * then notify the user themselves, then strip the membership from their
 * connection so future guild events don't reach them.
 *
 * Order matters here — see comments inline.
 */
export function userLeftGuild(args: { userId: bigint; guildId: bigint }): void {
  // 1. Tell the remaining members. While the snapshot still includes the
  //    user, they receive this too. That's intentional — it acts as the
  //    "you have been removed" signal alongside step 2.
  publish(
    GatewayEvent.GUILD_MEMBER_REMOVE,
    { guild_id: args.guildId.toString(), user_id: args.userId.toString() },
    { kind: 'guild', guildId: args.guildId },
  );

  // 2. Tell the user explicitly with GUILD_DELETE so their client can
  //    clear local state for that guild even if step 1 was missed.
  publish(
    GatewayEvent.GUILD_DELETE,
    { id: args.guildId.toString() },
    { kind: 'user', userId: args.userId },
  );

  // 3. Snapshot update last. Any further events emitted in this same tick
  //    that target this guild will not reach the user, which is correct.
  //    Fanned to the other replicas too, which may hold the user's sockets.
  registry.removeGuildFromUser(args.userId, args.guildId);
  publishMembershipRemote(
    { op: 'guild_remove', userId: args.userId.toString(), guildId: args.guildId.toString() },
    { kind: 'user', userId: args.userId },
  );
}

/**
 * A DM channel DTO built for ONE recipient. A DM DTO is viewer-relative —
 * its `recipients` are the viewer's peers (never the viewer) — so a DM event
 * can't send one shared frame to the whole channel audience: the peer would
 * receive the actor's DTO, whose `recipients` is the peer themself, and every
 * client swaps it in wholesale (the DM then reads as a chat with yourself).
 */
export type DMChannelDTOForRecipient = { userId: bigint; channelDTO: unknown };

/** Send each DM recipient its own DTO (the bus carries it to whichever
 *  replica holds that user's sockets). CHANNEL_CREATE goes to every socket
 *  of the user — it is what puts the DM in front of them; anything later goes
 *  only to sockets that still hold the DM, so a recipient who closed it
 *  meanwhile doesn't get it back (what the channel audience guaranteed). */
function publishDMChannelPerRecipient(
  t: typeof GatewayEvent[keyof typeof GatewayEvent],
  channelId: bigint,
  dtos: DMChannelDTOForRecipient[],
): void {
  for (const { userId, channelDTO } of dtos) {
    publish(
      t,
      channelDTO,
      t === GatewayEvent.CHANNEL_CREATE
        ? { kind: 'user', userId }
        : { kind: 'dmRecipient', userId, channelId },
    );
  }
}

/**
 * A 1:1 DM channel was just opened (or re-opened) between two users. Each
 * recipient gets CHANNEL_CREATE with its own DTO to bootstrap UI, and we
 * attach the channel to each of their connection snapshots so future
 * messages route there.
 *
 * Idempotent at the snapshot level — adding a channel that's already in
 * the set is a no-op.
 */
export function dmChannelCreated(args: {
  channelId: bigint;
  dtos: DMChannelDTOForRecipient[];
}): void {
  dmSubscribeRecipients({
    channelId: args.channelId,
    recipientIds: args.dtos.map((d) => d.userId),
  });
  publishDMChannelPerRecipient(GatewayEvent.CHANNEL_CREATE, args.channelId, args.dtos);
}

/**
 * Attach a DM channel to every recipient's connection snapshot, on this
 * replica and all others, so the channel's events route to them. Idempotent
 * (adding a channel that's already in the set is a no-op). Used when a DM is
 * opened and before each DM message fan-out (see routes/messages.ts).
 */
export function dmSubscribeRecipients(args: { channelId: bigint; recipientIds: bigint[] }): void {
  for (const userId of args.recipientIds) {
    registry.addDMToUser(userId, args.channelId);
  }
  publishMembershipRemote(
    {
      op: 'dm_add',
      userIds: args.recipientIds.map((id) => id.toString()),
      channelId: args.channelId.toString(),
    },
    { kind: 'users', userIds: args.recipientIds },
  );
}

/** A 1:1 DM's messaging streak changed — push the new value to both
 *  recipients so the streak chip updates without a DM-list refetch. */
export function dmStreakUpdate(args: {
  channelId: bigint;
  recipientIds: bigint[];
  streak: number;
}): void {
  const payload = { channel_id: args.channelId.toString(), streak: args.streak };
  // Identical frame for both recipients → one 'users' publish (serialized once,
  // one bus round-trip) instead of one per recipient.
  publish(GatewayEvent.DM_STREAK_UPDATE, payload, {
    kind: 'users',
    userIds: args.recipientIds,
  });
}

/** A user just unlocked a new achievement — push it to their own connections
 *  (multi-device) so the app can pop a celebratory in-app toast/banner live. */
export function achievementUnlock(args: {
  userId: bigint;
  id: string;
  name: string;
  description: string;
  marker: string;
}): void {
  publish(
    GatewayEvent.ACHIEVEMENT_UNLOCK,
    { id: args.id, name: args.name, description: args.description, marker: args.marker },
    { kind: 'user', userId: args.userId },
  );
}

/**
 * The current user has closed a DM. We strip the channel from their
 * connections' subscription set (so further events for the channel
 * are not delivered to them) and emit CHANNEL_DELETE on each of their
 * connections so the SPA can splice the channel out of the DM list
 * immediately. The OTHER recipient is unaffected — their dm_recipients
 * row remains and they keep seeing the channel.
 *
 * The channel itself is not deleted from the database; the other party
 * may still want to send messages or simply have the conversation in
 * their list. This is "close" semantics, not "destroy".
 */
export function dmChannelClosedForUser(args: {
  channelDTO: unknown;
  channelId: bigint;
  userId: bigint;
}): void {
  registry.removeDMFromUser(args.userId, args.channelId);
  publishMembershipRemote(
    { op: 'dm_remove', userId: args.userId.toString(), channelId: args.channelId.toString() },
    { kind: 'user', userId: args.userId },
  );
  publish(GatewayEvent.CHANNEL_DELETE, args.channelDTO, { kind: 'user', userId: args.userId });
}

/**
 * A DM's auto-delete TTL was changed. Notifies the channel audience —
 * which for a DM means every connected client of every recipient — so
 * each side's settings UI updates without a refetch. Payload carries
 * the channel id + the new TTL (or null when turned off).
 *
 * The audience is { kind: 'channel', channelId } and registry walks
 * the dm_recipients membership to fan to the right user sockets. We
 * don't have to enumerate recipients manually here.
 */
export function dmSettingsUpdated(args: {
  channelId: bigint;
  ttlSecondsAfterRead: number | null;
}): void {
  publish(
    GatewayEvent.DM_SETTINGS_UPDATE,
    {
      channelId: args.channelId.toString(),
      ttlSecondsAfterRead: args.ttlSecondsAfterRead,
    },
    { kind: 'channel', channelId: args.channelId, guildId: null },
  );
}

/**
 * A DM channel's properties changed (currently the per-DM E2EE enable,
 * purge-proof registration and disable). Fires CHANNEL_UPDATE with the full
 * re-fetched channel DTO so the receiving client can replace its cached
 * channel record. Each recipient gets its OWN DTO (see
 * DMChannelDTOForRecipient) — never one channel-audience frame.
 */
export function dmChannelUpdated(args: { channelId: bigint; dtos: DMChannelDTOForRecipient[] }): void {
  publishDMChannelPerRecipient(GatewayEvent.CHANNEL_UPDATE, args.channelId, args.dtos);
}

/**
 * A guild was deleted (owner-driven, not member-driven). Every member's
 * client should clear local state for that guild. We send GUILD_DELETE to
 * the guild audience while the snapshot is still intact, then strip the
 * membership from every connection of every member.
 */
export function guildDeletedBroadcast(args: { guildId: bigint; memberIds: bigint[] }): void {
  publish(
    GatewayEvent.GUILD_DELETE,
    { id: args.guildId.toString() },
    { kind: 'guild', guildId: args.guildId },
  );
  for (const userId of args.memberIds) {
    registry.removeGuildFromUser(userId, args.guildId);
  }
  // Other replicas drop the guild from every connection they hold in it — no
  // member list on the wire, their per-guild index already knows who that is.
  publishMembershipRemote(
    { op: 'guild_drop', guildId: args.guildId.toString() },
    { kind: 'guild', guildId: args.guildId },
  );
}

/**
 * The user acked a channel — their read marker advanced. We fan to the
 * user's audience so other connections (other browser tabs, the desktop
 * app, mobile) see the same read state without polling.
 *
 * Single-user, single-event — this is the simplest possible dispatch in
 * the file. We accept a fully-formed DTO from the route so the dispatch
 * doesn't need to import the dto module.
 */
export function channelAck(args: { userId: bigint; readState: unknown }): void {
  publish(GatewayEvent.CHANNEL_ACK, args.readState, {
    kind: 'user',
    userId: args.userId,
  });
}

/**
 * Parental controls — push to each supervising parent so their Family
 * view updates live (and they get a notification) instead of polling.
 */
export function familyRequestCreate(args: {
  parentIds: bigint[];
  childId: bigint;
  childName: string;
  kind: 'friend' | 'guild';
  label: string;
}): void {
  const payload = {
    childId: args.childId.toString(),
    childName: args.childName,
    kind: args.kind,
    label: args.label,
  };
  if (args.parentIds.length === 0) return;
  // Identical frame per parent → one 'users' publish. Guard preserves the
  // loop's zero-publish behavior on an empty parent set.
  publish(GatewayEvent.FAMILY_REQUEST_CREATE, payload, {
    kind: 'users',
    userIds: args.parentIds,
  });
}

export function familyFlagCreate(args: {
  parentIds: bigint[];
  childId: bigint;
  childName: string;
  matchedWord: string;
  direction: 'sent' | 'received';
}): void {
  const payload = {
    childId: args.childId.toString(),
    childName: args.childName,
    matchedWord: args.matchedWord,
    direction: args.direction,
  };
  if (args.parentIds.length === 0) return;
  publish(GatewayEvent.FAMILY_FLAG_CREATE, payload, {
    kind: 'users',
    userIds: args.parentIds,
  });
}

/**
 * Parental controls — the SUBJECT's own supervision state changed
 * (restrictions edited, link accepted/ended, a server blocked, the 18+
 * sweep releasing them). Audience is that one user, so every device they
 * have connected re-applies its supervision gates immediately instead of
 * carrying stale permissions until the next cold start.
 *
 * The caller builds the state DTO (supervision.supervisionStateFor) so
 * dispatch stays free of domain imports — same contract as channelAck.
 * That DTO is the subject's OWN state only: it must never carry guardian
 * identity or any other parent-side data.
 */
export function familySupervisionUpdate(args: { childId: bigint; state: unknown }): void {
  publish(GatewayEvent.FAMILY_SUPERVISION_UPDATE, args.state, {
    kind: 'user',
    userId: args.childId,
  });
}

/**
 * DM read-receipt events. Both fire only when the recipient has
 * receipts enabled (the markMessage* services in dms.ts gate that;
 * if they return no stamps, the route skips calling these). Both
 * are scoped to a single user — the message author whose UI should
 * flip "Sent" → "Delivered" / "Read" under their own message.
 *
 * Payload shape on the wire mirrors what the client needs to splice
 * into local message state: a list of ids + the timestamp that was
 * stamped, scoped to one channel.
 */
export function messageDelivered(args: {
  authorId: bigint;
  channelId: bigint;
  messageIds: bigint[];
  deliveredAt: Date;
}): void {
  if (args.messageIds.length === 0) return;
  publish(
    GatewayEvent.MESSAGE_DELIVERED,
    {
      channel_id: args.channelId.toString(),
      message_ids: args.messageIds.map((m) => m.toString()),
      delivered_at: args.deliveredAt.toISOString(),
    },
    { kind: 'user', userId: args.authorId },
  );
}

export function messageViewed(args: {
  authorId: bigint;
  channelId: bigint;
  messageIds: bigint[];
  viewedAt: Date;
}): void {
  if (args.messageIds.length === 0) return;
  publish(
    GatewayEvent.MESSAGE_VIEWED,
    {
      channel_id: args.channelId.toString(),
      message_ids: args.messageIds.map((m) => m.toString()),
      viewed_at: args.viewedAt.toISOString(),
    },
    { kind: 'user', userId: args.authorId },
  );
}

/**
 * Voice presence change. Audience is the whole guild — every member can
 * see the voice room headcount on every voice channel they have
 * VIEW_CHANNEL on, so they all need the event. (We could narrow to
 * "members with VIEW_CHANNEL on the affected voice channel" by reusing
 * the per-channel filter, but voice presence is low-volume — a typical
 * guild sees a handful of join/leave events per hour, not per second —
 * so the broader audience is fine for v1.)
 *
 * Caller passes a fully-formed DTO so this module stays free of dto
 * imports.
 */
export function voiceStateUpdate(args: {
  /** Null for DM voice (1-on-1 calls). */
  guildId: bigint | null;
  /** Channel the voice state belongs to. Always provide it: it scopes the
      fan-out to connections that can VIEW_CHANNEL it (the 'channel' audience
      filters on each connection's viewable set), so voice presence in a
      private channel doesn't leak to guild members who can't see it. */
  channelId: bigint | null;
  voiceState: unknown;
}): void {
  if (args.channelId !== null) {
    // Channel audience for BOTH guild voice and DM voice. For guild voice
    // this restricts to VIEW_CHANNEL holders (was the 'guild' audience,
    // which fanned to EVERY member and leaked who's in a private voice
    // channel); for a public channel the audience is identical, so no
    // functional change there.
    publish(GatewayEvent.VOICE_STATE_UPDATE, args.voiceState, {
      kind: 'channel',
      channelId: args.channelId,
      guildId: args.guildId,
    });
  } else if (args.guildId !== null) {
    // Defensive fallback — a guild voice event with no channelId (shouldn't
    // happen; all callers pass it). Fan to the guild rather than drop it.
    publish(GatewayEvent.VOICE_STATE_UPDATE, args.voiceState, {
      kind: 'guild',
      guildId: args.guildId,
    });
  }
}

/**
 * Deliver a voice-state update straight to a specific user's
 * connections. Used for 1:1 DM call ring/teardown: the channel-audience
 * fan-out depends on the recipient's connection being correctly indexed
 * under that DM channel, and any gap there means the callee never sees
 * the incoming-call modal unless they happen to have the DM open (which
 * fetches voice states over REST). Targeting the user directly via the
 * byUser index is the reliable path — it's how every other personal
 * notification reaches them — so we send the ring this way too. The
 * client upserts by user id, so receiving it via both the channel and
 * user audiences is harmless (idempotent).
 */
export function voiceStateUpdateToUser(userId: bigint, voiceState: unknown): void {
  publish(GatewayEvent.VOICE_STATE_UPDATE, voiceState, { kind: 'user', userId });
}

/**
 * Apply a member's role-set change to their gateway connections.
 *
 * Changing what roles a member has can flip VIEW_CHANNEL on per-channel
 * overrides up or down (e.g. role X grants visibility on #mod-chat via an
 * override). At IDENTIFY we computed and cached the viewable set per
 * connection; without this helper that cache would be stale until reconnect.
 *
 * What we do:
 *   1. Recompute the viewable channel id list for (guild, user) via the
 *      bulk permissions resolver (2 DB queries per call).
 *   2. For each open connection of the user:
 *      a. Compute diff against the slice of its cache for THIS guild
 *         (using the channelToGuild reverse map to filter).
 *      b. Atomically apply the diff to the cache.
 *      c. Dispatch CHANNEL_CREATE for newly-visible channels (with full
 *         DTOs so the client can render immediately) and CHANNEL_DELETE
 *         for newly-hidden ones (id-only).
 *
 * If the user has no open connections we still want the cache to be
 * accurate on next IDENTIFY — but IDENTIFY recomputes from the database,
 * so there's nothing to do. Safe early-return.
 *
 * Cost: 2 DB queries (channels + overrides via the permission resolver),
 * plus one channel-list query when the diff is non-empty (DTOs for the
 * newly-visible channels). Paid only on role grant/revoke, never in the
 * hot path.
 */
/**
 * Apply a per-channel-visibility refresh for a single user in one guild.
 * Computes the new authoritative viewable-channel set, diffs it against
 * each of the user's connection caches, then sends `CHANNEL_CREATE` for
 * newly-visible channels (with full DTOs so the client can render
 * immediately) and `CHANNEL_DELETE` for newly-hidden channels.
 *
 * This is the engine that closes the "permission overrides aren't honored
 * mid-session" gap. The cost is a 2-query bulk resolver call plus an
 * optional channel-list query (only when at least one connection has
 * newly-visible channels). Paid only on permission-change paths, never in
 * the hot dispatch loop.
 *
 * Idempotent: when the diff is empty for a connection, we skip cleanly
 * with no events sent and no cache mutations. Calling this from a route
 * handler that didn't actually change anything is harmless.
 */
async function refreshUserViewableChannels(args: {
  userId: bigint;
  guildId: bigint;
  /**
   * Optional pre-loaded DTO map for this guild's channels. The bulk path
   * (applyGuildPermissionChange) supplies one to amortize a single query
   * across all affected users. The single-user path leaves it null and
   * lazy-loads inside the function.
   */
  dtoMap?: Map<bigint, ReturnType<typeof toChannel>>;
  /**
   * Pre-computed viewable channel set for this user in this guild.
   * Supplied by the bulk path (applyGuildPermissionChange), which
   * batches the resolver across every connected user. When provided,
   * we skip the per-user permission query entirely — the most
   * expensive part of a fanned-out role change. Undefined → fall
   * back to listViewableGuildChannelIds for single-user callers.
   */
  precomputedViewable?: Set<bigint>;
  /**
   * Pre-loaded map of userId → in-voice channelId for this guild, supplied by
   * the bulk path (applyGuildPermissionChange) so the eviction check is an
   * in-memory lookup instead of a per-user voice_states query — removing the
   * last per-member DB hit on a bulk flip. Undefined → single-user callers do
   * the one-row lookup themselves (identical result, since voice_states is
   * keyed by userId).
   */
  voiceByUser?: Map<bigint, bigint>;
}): Promise<void> {
  const conns = registry.byUserId(args.userId);
  if (conns.length === 0) return;

  // The new authoritative set of channels visible to this user in this guild.
  const newSet =
    args.precomputedViewable ??
    new Set(await permissions.listViewableGuildChannelIds(args.guildId, args.userId));

  // Lazy DTO lookup — only loaded if at least one connection has a
  // non-empty `added` set. Avoids a guildwide channel list query for the
  // common "no visibility delta" case.
  let dtoMap = args.dtoMap ?? null;
  async function loadDtoMap(): Promise<Map<bigint, ReturnType<typeof toChannel>>> {
    if (dtoMap) return dtoMap;
    const rows = await channelsSvc.listGuildChannels(args.guildId);
    const m = new Map<bigint, ReturnType<typeof toChannel>>();
    for (const ch of rows) m.set(ch.id, toChannel(ch));
    dtoMap = m;
    return m;
  }

  for (const conn of conns) {
    // The connection's cache slice for THIS guild, straight from the
    // forward index (this helper runs for every connection in the guild on
    // any override/role change — the old per-conn scan of the entire
    // channelToGuild map was O(all the user's channels) each time). Read
    // only: the diff below is fully computed before the mutators run.
    const currentForGuild: ReadonlySet<bigint> =
      conn.guildToChannels.get(args.guildId) ?? EMPTY_CHANNEL_SET;

    const added: bigint[] = [];
    const removed: bigint[] = [];
    for (const cid of newSet) if (!currentForGuild.has(cid)) added.push(cid);
    for (const cid of currentForGuild) if (!newSet.has(cid)) removed.push(cid);
    if (added.length === 0 && removed.length === 0) continue;

    // Apply the diff to the cache BEFORE sending events, so any subsequent
    // events delivered to this connection use the new visibility set.
    for (const cid of removed) conn.removeViewableChannel(cid);
    for (const cid of added) conn.addViewableChannel(cid, args.guildId);

    // Voice / stage eviction. If any newly-removed channel is one the
    // user is currently connected to via voice, they need to be kicked
    // out of the SFU and the voice_states row deleted. Without this,
    // a user who loses VIEW_CHANNEL on a voice channel they're in keeps
    // their LiveKit token (valid up to ~1 hour) and continues to talk
    // and listen in a channel they can no longer see in their UI —
    // effectively kicked from the sidebar but still in the audio room.
    //
    // Cost: in the bulk path the in-voice channel comes from the pre-loaded
    // voiceByUser map (one voice_states read for the whole guild); the
    // single-user path does the one-row lookup itself. If the user isn't in
    // voice in this guild we do no further work. If they are AND the
    // channel they're in just got removed, run the full eviction:
    // voice_states delete + LiveKit removeParticipant + (for stage)
    // stage_participants cleanup + VOICE_STATE_UPDATE broadcast so
    // remaining guild members see the disconnect.
    if (removed.length > 0) {
      const vsChannelId = args.voiceByUser
        ? args.voiceByUser.get(args.userId)
        : ((await voice.voiceChannelInGuild(args.userId, args.guildId)) ?? undefined);
      if (vsChannelId !== undefined && removed.includes(vsChannelId)) {
        // Drop the SFU + DB rows in voice_states. The evict helper also
        // returns the row so we can fan out the leave broadcast.
        const evicted = await voice.evictFromVoiceInGuild(args.userId, args.guildId);
        if (evicted) {
          // For stage channels we also clean up the roster row. The
          // SFU presence is gone via the voice eviction above; the
          // stage_participants row would otherwise show the user as
          // "still on stage" forever, including blocking their own
          // re-join attempts which short-circuit on existing.
          // Cheap (channel-id + user-id is a PK on stage_participants).
          // Run unconditionally — if the channel isn't a stage the
          // delete affects zero rows and returns harmlessly. The
          // returned rows tell us whether this WAS a stage roster
          // member (only stage channels have rows), which gates the
          // STAGE_PARTICIPANTS_UPDATE fan-out below.
          const removedStage = await db
            .delete(schema.stageParticipants)
            .where(
              and(
                eq(schema.stageParticipants.channelId, evicted.channelId),
                eq(schema.stageParticipants.userId, args.userId),
              ),
            )
            .returning({ id: schema.stageParticipants.userId });
          publish(
            GatewayEvent.VOICE_STATE_UPDATE,
            leftVoiceStateDTO({ userId: args.userId, guildId: args.guildId }),
            { kind: 'guild', guildId: args.guildId },
          );
          // If the user was on the stage roster, the VOICE_STATE_UPDATE
          // above isn't enough — other clients render the stage roster
          // from STAGE_PARTICIPANTS_UPDATE, so without this they'd keep
          // showing the evicted user on stage. Re-list and fan out the
          // post-eviction roster, mirroring broadcastParticipants in
          // routes/stage.ts. Gated on removedStage so non-stage voice
          // channels (the common case) emit no spurious stage event.
          if (removedStage.length > 0) {
            const stageSvc = await import('../services/stage');
            const { toStageParticipant } = await import('../lib/dto');
            const remaining = await stageSvc.listParticipants(evicted.channelId);
            stageParticipantsUpdate({
              guildId: args.guildId,
              channelId: evicted.channelId,
              participants: remaining.map(toStageParticipant),
            });
          }
        }
      }
    }

    // Hidden channels: id-only DELETE is enough — the client knows which
    // channel and which guild.
    for (const cid of removed) {
      conn.send(
        dispatchFrame(GatewayEvent.CHANNEL_DELETE, {
          id: cid.toString(),
          guildId: args.guildId.toString(),
        }),
      );
    }

    // Newly-visible channels: ship full DTOs so the client doesn't need a
    // round-trip to render them.
    if (added.length > 0) {
      const map = await loadDtoMap();
      for (const cid of added) {
        const dto = map.get(cid);
        if (!dto) continue; // channel deleted between resolve + dispatch
        conn.send(dispatchFrame(GatewayEvent.CHANNEL_CREATE, dto));
      }
    }
  }
}

/**
 * Public helper: a single user's role set changed in this guild. Called
 * from the member-PATCH route after add/remove role.
 */
/**
 * Internal (non-client) bus event: a viewability change happened and every
 * replica must recompute the per-connection channel cache for ITS OWN
 * connections. The per-connection snapshot is deliberately node-local (see
 * SHARDING.md), but the RECOMPUTE TRIGGER must fan out — otherwise a role/
 * permission change handled on node A never invalidates the victim's cache on
 * node B, and node B keeps delivering messages for a channel the user can no
 * longer see (a private-channel leak until they reconnect). Distinguished by
 * the `_zk.internal.` prefix; registry.onPublished ignores it (no client
 * frame), and the subscriber below is the only consumer.
 */
const INTERNAL_VIEWABILITY_INVALIDATE = '_zk.internal.viewability_invalidate';

/**
 * Cross-node force-disconnect signal. A ban/session-revocation handled on node
 * A must close the target's gateway sockets on EVERY node, not just the local
 * one — the gateway only re-checks ban state at IDENTIFY/RESUME, so a socket
 * held by another replica keeps receiving live dispatches until it drops. Mirrors
 * the viewability-invalidate plumbing above: `_zk.internal.` prefix so
 * registry.onPublished never forwards it to clients; the subscriber below is the
 * only consumer.
 */
const INTERNAL_FORCE_DISCONNECT = '_zk.internal.force_disconnect';

/** Close every LOCAL gateway connection for this user. Shared by the direct
 *  (local) path and the cross-node subscriber. */
function forceDisconnectUserLocal(userId: bigint): void {
  for (const conn of registry.byUserId(userId)) {
    try {
      // CloseCode 4004 = AUTHENTICATION_FAILED; generic "you've been signed
      // out" without leaking the moderation context.
      conn.close(4004, 'account disabled');
    } catch {
      // Already closed mid-iteration; cleanup will still fire.
    }
  }
}

/**
 * Public helper: force-close a user's gateway sockets across the whole cluster.
 * Closes this node's connections immediately, then signals other replicas to do
 * the same. Used by the ban/disable path so a banned user can't keep reading on
 * a still-open WebSocket held by any node.
 */
export function forceDisconnectUser(userId: bigint): void {
  forceDisconnectUserLocal(userId);
  eventBus().publishRemote({
    t: INTERNAL_FORCE_DISCONNECT as never,
    d: { userId: userId.toString() },
    audience: { kind: 'user', userId },
  });
}

/**
 * Cross-node membership-snapshot signal. Guild join/leave/kick/ban, guild
 * delete and DM open/close change WHICH guilds and DMs a connection's snapshot
 * routes, and the user's sockets may be held by any replica — not just the one
 * that handled the request. Without this, a member kicked on node A keeps
 * receiving the guild's events on node B (and a member who joined on A
 * receives nothing on B) until they reconnect. The origin applies the change
 * locally, then publishes this remote-only (no echo); every other replica
 * applies it to its own connections. Same `_zk.internal.` plumbing as the
 * signals above.
 */
const INTERNAL_MEMBERSHIP = '_zk.internal.membership';

type MembershipSignal =
  | { op: 'guild_add'; userId: string; guildId: string; viewableChannelIds?: string[] }
  | { op: 'guild_remove'; userId: string; guildId: string }
  | { op: 'guild_drop'; guildId: string }
  | { op: 'dm_add'; userIds: string[]; channelId: string }
  | { op: 'dm_remove'; userId: string; channelId: string };

function publishMembershipRemote(d: MembershipSignal, audience: Audience): void {
  eventBus().publishRemote({ t: INTERNAL_MEMBERSHIP as never, d, audience });
}

/** Apply a membership signal from another replica to THIS replica's
 *  connections. Users with no local connection no-op inside the registry. */
function applyMembershipSignalLocal(d: MembershipSignal): void {
  switch (d.op) {
    case 'guild_add':
      registry.addGuildToUser(
        BigInt(d.userId),
        BigInt(d.guildId),
        d.viewableChannelIds?.map((id) => BigInt(id)),
      );
      return;
    case 'guild_remove':
      registry.removeGuildFromUser(BigInt(d.userId), BigInt(d.guildId));
      return;
    case 'guild_drop': {
      const guildId = BigInt(d.guildId);
      for (const userId of registry.connectedUsersInGuild(guildId)) {
        registry.removeGuildFromUser(userId, guildId);
      }
      return;
    }
    case 'dm_add': {
      const channelId = BigInt(d.channelId);
      for (const userId of d.userIds) registry.addDMToUser(BigInt(userId), channelId);
      return;
    }
    case 'dm_remove':
      registry.removeDMFromUser(BigInt(d.userId), BigInt(d.channelId));
      return;
  }
}

let internalBusUnsub: (() => void) | null = null;

/** Subscribe (once) to internal cross-node signals (force disconnect,
 *  membership snapshots, viewability invalidations). Called from the gateway
 *  startup path alongside registry.init(). Idempotent. */
export function initInternalDispatchBus(): void {
  if (internalBusUnsub) return;
  internalBusUnsub = eventBus().subscribe((event) => {
    if (event.t === (INTERNAL_MEMBERSHIP as never)) {
      applyMembershipSignalLocal(event.d as MembershipSignal);
      return;
    }
    if (event.t === (INTERNAL_FORCE_DISCONNECT as never)) {
      const d = event.d as { userId: string };
      forceDisconnectUserLocal(BigInt(d.userId));
      return;
    }
    if (event.t !== (INTERNAL_VIEWABILITY_INVALIDATE as never)) return;
    const d = event.d as { scope: 'guild' | 'user'; guildId: string; userId?: string };
    // Run the recompute against THIS node's local connections. Nodes that
    // don't hold the affected user/members no-op cheaply inside the helpers.
    if (d.scope === 'guild') {
      void applyGuildPermissionChangeLocal({ guildId: BigInt(d.guildId) });
    } else if (d.scope === 'user' && d.userId) {
      void refreshUserViewableChannels({ userId: BigInt(d.userId), guildId: BigInt(d.guildId) });
    }
  });
}

export function shutdownInternalDispatchBus(): void {
  if (internalBusUnsub) {
    internalBusUnsub();
    internalBusUnsub = null;
  }
}

export async function applyMemberRoleChange(args: {
  userId: bigint;
  guildId: bigint;
}): Promise<void> {
  // Recompute for THIS node's connections (synchronous for callers/tests)…
  await refreshUserViewableChannels(args);
  // …then signal OTHER replicas to recompute their own copies of this user.
  eventBus().publishRemote({
    t: INTERNAL_VIEWABILITY_INVALIDATE as never,
    d: { scope: 'user', guildId: args.guildId.toString(), userId: args.userId.toString() },
    audience: { kind: 'guild', guildId: args.guildId },
  });
}

/**
 * Public helper: a guild-wide permission change happened — a permission
 * override was upserted/deleted, a role's bits changed, or a new channel
 * was added. Recomputes per-channel visibility for every CONNECTED user
 * with this guild in their snapshot.
 *
 * Offline users are intentionally NOT touched — their next IDENTIFY
 * recomputes from the database, which is the source of truth. The cache
 * we maintain here is purely for live connections.
 *
 * The guild's channel DTO map is loaded once and shared across the per-
 * user calls so we don't issue N identical queries when many connected
 * users are in the same guild.
 */
export async function applyGuildPermissionChange(args: {
  guildId: bigint;
}): Promise<void> {
  // Recompute for THIS node's connections (synchronous for callers/tests)…
  await applyGuildPermissionChangeLocal(args);
  // …then signal OTHER replicas to recompute their own connections. Without
  // this, a permission/role/channel change handled here never invalidates the
  // cache on a node holding an affected user, leaking a now-hidden channel's
  // messages to them until they reconnect.
  eventBus().publishRemote({
    t: INTERNAL_VIEWABILITY_INVALIDATE as never,
    d: { scope: 'guild', guildId: args.guildId.toString() },
    audience: { kind: 'guild', guildId: args.guildId },
  });
}

/** Node-local recompute worker — see applyGuildPermissionChange. Runs against
 *  this replica's registry only; the cross-node trigger is the caller's job. */
async function applyGuildPermissionChangeLocal(args: {
  guildId: bigint;
}): Promise<void> {
  const userIds = registry.connectedUsersInGuild(args.guildId);
  if (userIds.length === 0) return;

  // Load the guild's channels + DTOs once. Used both for the "did the
  // user gain visibility" diff in refreshUserViewableChannels and for
  // building CHANNEL_CREATE frames when they do.
  const rows = await channelsSvc.listGuildChannels(args.guildId);
  const dtoMap = new Map<bigint, ReturnType<typeof toChannel>>();
  for (const ch of rows) dtoMap.set(ch.id, toChannel(ch));

  // Batched permission compute: one round of queries computes the
  // viewable-channel set for EVERY connected user in this guild,
  // rather than one round per user. On a 200-member guild with most
  // members connected this drops from ~600 round-trips to ~6
  // (loadMember + channels + overrides + roles + memberRoles + members,
  // all run in parallel). The per-user math runs in memory from the
  // shared query results.
  const viewableByUser = await permissions.listViewableGuildChannelIdsForUsers(
    args.guildId,
    userIds,
  );

  // One voice_states read for the whole guild (userId → in-voice channelId),
  // shared across the per-user refreshes. This removes the last per-member DB
  // query: previously every connected user who lost a channel ran its own
  // voice_states lookup, so a bulk flip fired ~N of them even though almost
  // nobody is in voice. Now it's a single query + in-memory map lookups.
  const voiceByUser = await voice.listGuildVoiceChannels(args.guildId);

  // Per-user refresh now consults the pre-computed sets rather than
  // re-running the permission resolver or re-querying voice_states. Kept in
  // parallel because the remaining per-user work (gateway sends, the rare
  // actual voice eviction) touches disjoint Connection objects.
  await Promise.all(
    userIds.map((userId) =>
      refreshUserViewableChannels({
        userId,
        guildId: args.guildId,
        dtoMap,
        precomputedViewable: viewableByUser.get(userId) ?? new Set(),
        voiceByUser,
      }),
    ),
  );
}
