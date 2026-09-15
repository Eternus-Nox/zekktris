/**
 * AppState
 * --------
 * Normalized client-side store for everything the user sees: guilds,
 * channels (per guild), messages (per channel). One reducer; the same
 * actions are dispatched by both REST callbacks and gateway event handlers.
 *
 * Shape choices:
 *   - guildsById, channelsByGuild, messagesByChannel are all maps so
 *     lookups are O(1) and inserts/patches don't require array scans
 *   - lists are kept as id arrays alongside the maps; the UI iterates the
 *     id list and reads the map. Keeps render-key stability easy.
 *
 * Action types are deliberately small and verb-named. The reducer is
 * pure; the side-effect-heavy code (calling REST, subscribing to gateway)
 * lives in the AppStateProvider's effects.
 *
 * If this grows past ~300 lines it's worth pulling out into a Zustand
 * store, but for the v1 surface a context+reducer is plenty and avoids
 * adding a dependency.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
// Use the selector-aware context from `use-context-selector` instead
// of React's built-in createContext/useContext. The created context's
// Provider has the same JSX shape as React's, but consumers can use
// useContextSelector(ctx, fn) to subscribe to only the slice their
// component actually reads — re-rendering only when that slice
// changes, not on every state mutation. The library falls back to
// useContext compatibility for code paths that don't migrate yet,
// so the existing useAppState() hook below keeps working as before
// while new call sites (MessageItem, MemberList rows) opt into the
// selector path via useAppStateSelector. The migration can proceed
// incrementally — there are 84 useAppState call sites across the
// web app and we don't need to refactor all of them at once.
import { createContext, useContext, useContextSelector } from 'use-context-selector';
import {
  GatewayEvent,
  ApiError,
  type Channel,
  type RestClient,
  type GatewayClient,
  type Guild,
  type GuildMember,
  type Message,
  type Poll,
  type PublicUser,
  type FamilySummary,
  type ReactionAggregate,
  type ReadState,
  type Role,
  type ScheduledEvent,
  type VoiceState,
  type GuildEmoji,
  type Sticker,
  type StageParticipant,
} from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from './Toasts';
import { hydrateVoicePrefs, setVoicePrefsSyncer, getVoicePrefs } from '../lib/voicePrefs';
import { playMessagePing } from '../lib/sounds';
import { showDesktopNotification } from '../lib/desktopNotify';
import { getNotifyPrefs } from '../lib/notifyPrefs';

// ── Shape ──────────────────────────────────────────────────────────────────

interface State {
  guildIds: string[];
  guildsById: Record<string, Guild>;
  /** channels per guild, ordered by category/position. Loaded lazily. */
  channelsByGuild: Record<string, Channel[]>;
  /** messages per channel, oldest→newest. Loaded lazily, capped at 200. */
  messagesByChannel: Record<string, Message[]>;
  /** Per-channel "we've fetched this at least once" flag. */
  loadedChannels: Set<string>;
  /**
   * Channels for which we've fetched older messages and got fewer
   * results than requested — the channel head has been reached, so
   * the Scroller stops trying to load more on scroll-up. Set semantics
   * because the value is just "yes/no per channel".
   */
  olderExhausted: Set<string>;
  /**
   * Channels currently fetching older messages. Used by the Scroller
   * to suppress re-entrancy (avoid firing two fetches at once when the
   * scrollTop sensor triggers twice in rapid succession).
   */
  loadingOlder: Set<string>;
  /**
   * Cache of users we've seen — populated incrementally from message authors
   * and from member-list loads. Used to resolve mention chips. When we don't
   * have a user we want to render, the renderer falls back to the raw id.
   */
  usersById: Record<string, PublicUser>;
  /**
   * Presence status keyed by user id, kept in a SEPARATE slice from
   * `usersById` on purpose. PRESENCE_PATCH fires on every online/idle/dnd
   * transition of any cached user; if it spread `usersById` (name/avatar/
   * tag) to write status, that reference flip would re-render every visible
   * MessageItem (which subscribes to the whole `usersById` map to resolve
   * mention names — MessageItem.tsx:111/298) even though it never renders a
   * status. Rendered status dots come from membersByGuild / dmChannels /
   * relationships, which PRESENCE_PATCH patches directly; this map holds the
   * status for any surface that wants to resolve a status by id without
   * disturbing the identity slice.
   */
  userStatusById: Record<string, PublicUser['status']>;
  /** Member list per guild, loaded lazily by the right column. */
  membersByGuild: Record<string, GuildMember[]>;
  /** Per-guild "members fetched at least once" flag. */
  loadedMembers: Set<string>;
  /**
   * Custom emoji per guild — keyed by guild id, value is the full
   * current list. The list is small (≤50 per guild by current cap)
   * and updates rarely; we replace the whole list on every gateway
   * GUILD_EMOJIS_UPDATE rather than diffing add/remove events.
   * Loaded lazily on first interaction with the guild (initial guild
   * fetch fills it). Empty array means "loaded, none configured";
   * absence means "not loaded yet".
   */
  emojisByGuild: Record<string, GuildEmoji[]>;
  /**
   * Custom stickers per guild — same lifecycle as emoji. Bulk-replace
   * on every GUILD_STICKERS_UPDATE; absence means "not loaded yet".
   * The picker reads this to populate its tab; the message renderer
   * doesn't need it because each message carries its own sticker
   * snapshot.
   */
  stickersByGuild: Record<string, Sticker[]>;
  /**
   * Stage participants per channel — keyed by channel id, value is the
   * full current participant list (speakers + audience). Bulk-replaced
   * on every STAGE_PARTICIPANTS_UPDATE; absence means "not loaded yet"
   * (the StageChannelView fetches on mount).
   */
  stageParticipantsByChannel: Record<string, StageParticipant[]>;
  /**
   * Roles per guild — loaded lazily on first member-list render or
   * when any view needs to resolve role data (member display color,
   * permission checks, role chips). The list is small (typically
   * ≤20 per guild) and changes rarely. Absence means "not loaded
   * yet"; empty array means "loaded, no roles besides @everyone".
   */
  rolesByGuild: Record<string, Role[]>;
  /**
   * Per-guild scheduled events (excluding canceled/completed unless
   * explicitly loaded with includeArchived=true). Loaded lazily when
   * the EventsModal mounts; broadcast deltas keep entries fresh while
   * any client view is observing.
   *
   * Per-recipient fields (rsvpCounts, myRsvp) come from the initial
   * fetch and survive broadcast deltas — broadcasts intentionally
   * omit those fields since they're recipient-specific. Status flips
   * from the sweep DO arrive via broadcast and are applied.
   */
  eventsByGuild: Record<string, ScheduledEvent[]>;
  /**
   * Monotonic counter that bumps on every SCHEDULED_EVENT_* gateway
   * broadcast (create, update, delete). Components that aggregate
   * events across guilds (the cross-guild MyEventsModal) observe
   * this counter to debounced-refetch their list whenever ANY event
   * changes in ANY guild the user is in.
   *
   * Cheaper and simpler than per-event diffing: the modal's data
   * shape (events + guildName/guildIconUrl per item) doesn't map
   * 1:1 with eventsByGuild, so reusing that as the trigger would
   * miss the guild-context resolution. A counter + refetch is the
   * straightforward approach.
   */
  eventChangeCounter: number;
  /**
   * DM channels the current user is in. Distinct from `channelsByGuild`
   * because DMs have no guild — they sort by recency at the top level
   * and live in their own column when the user is in DMs view.
   */
  dmChannels: Channel[];
  loadedDMs: boolean;
  /**
   * Per-channel read marker. Hydrated from REST on bootstrap and from the
   * gateway's READY frame; updated by `CHANNEL_ACK` events and local acks.
   * A channel with no entry here means "never acked" — every message in
   * that channel counts as unread.
   */
  readStateByChannel: Record<string, ReadState>;
  loadedReadStates: boolean;
  /**
   * Voice presence: which voice channel each user is currently in,
   * keyed by user id. Hydrated from READY (`voice_states`) and updated
   * by `VOICE_STATE_UPDATE` gateway events. Lookup-by-channel is done
   * via `voiceStatesForChannel(state, channelId)` selector below — we
   * don't denormalize because joins/leaves fan out through this single
   * map and a per-channel map would need two writes per event.
   */
  voiceStatesByUser: Record<string, VoiceState>;

  /**
   * Timestamp (ms) of the most recent CHANNEL_PINS_UPDATE event per
   * channel. PinPanel watches this as a useEffect dep so it re-fetches
   * the pin list immediately after a pin/unpin elsewhere. Stored as a
   * timestamp rather than a counter so the value is also useful for
   * "you have new pins" badging if we ever want it.
   */
  channelPinUpdateAt: Record<string, number>;

  /**
   * Per-target mute / level overrides keyed by `${type}:${id}` (e.g.
   * `guild:42` or `channel:1234`). Hydrated from REST on first need.
   * Resolution rule (channel-wins-over-guild-wins-over-default 'all')
   * lives in the `effectiveNotificationLevel` selector at the bottom
   * of this file. Callers should use the selector — the raw map is an
   * implementation detail.
   */
  notificationOverrides: Record<string, 'all' | 'mentions' | 'nothing'>;
  loadedNotificationOverrides: boolean;

  /**
   * The last poke received in each DM, as its emoji, waiting to be seen.
   *
   * A poke used to exist only as a toast, and a toast is gone in fifteen
   * seconds whether or not anyone was looking — so a poke sent while you were
   * away left no trace at all. This is the trace: the DM row shows the emoji
   * until you open that conversation.
   *
   * Deliberately not persisted. It is a nudge, not a ledger: surviving a reload
   * would make it a second unread system to clear.
   */
  pokePills: Record<string, string>;

  /**
   * Relationships (friends, requests, blocks). Hydrated on connect so
   * MessageItem / ProfileCard / etc can read state.relationships
   * synchronously instead of fetching per-render. ProfileCard still
   * does a bespoke fetch when opening (cheap; matches Discord's "fresh
   * mutual friends count" behaviour) — the AppState copy is the
   * authoritative source for derived UI like blocked-message hiding.
   */
  relationships: Array<{
    type: 'friend' | 'incoming_request' | 'outgoing_request' | 'blocked';
    createdAt: string;
    user: PublicUser;
  }>;
  loadedRelationships: boolean;
  /**
   * Personal DM nicknames: { targetUserId: nickname }. Viewer-private labels
   * shown in place of a user's name in direct messages only. Hydrated once at
   * login (like relationships) and applied wherever a DM peer renders.
   */
  dmNicknames: Record<string, string>;
  /**
   * Parental-controls summary for the current user (who they supervise,
   * who supervises them, pending requests). Null until loaded. Drives
   * the supervision banner and the DM E2EE policy for supervised users.
   */
  supervision: FamilySummary | null;
  /** Bumped whenever a live parental-controls event (new flag or
      approval request) arrives, so open Family views refetch. */
  familyNudge: number;
  /**
   * Set of message ids that the user has saved (bookmarked). Used
   * by MessageItem to render the bookmark icon as filled or
   * outlined. Hydrated on initial channel load via
   * GET /users/@me/saved/members?ids=... and updated optimistically
   * when the user toggles the bookmark.
   */
  savedMessageIds: Set<string>;
}

const initialState: State = {
  guildIds: [],
  guildsById: {},
  channelsByGuild: {},
  messagesByChannel: {},
  loadedChannels: new Set(),
  olderExhausted: new Set(),
  loadingOlder: new Set(),
  usersById: {},
  userStatusById: {},
  membersByGuild: {},
  loadedMembers: new Set(),
  emojisByGuild: {},
  stickersByGuild: {},
  stageParticipantsByChannel: {},
  rolesByGuild: {},
  eventsByGuild: {},
  eventChangeCounter: 0,
  dmChannels: [],
  loadedDMs: false,
  readStateByChannel: {},
  loadedReadStates: false,
  voiceStatesByUser: {},
  channelPinUpdateAt: {},
  notificationOverrides: {},
  loadedNotificationOverrides: false,
  pokePills: {},
  relationships: [],
  loadedRelationships: false,
  dmNicknames: {},
  supervision: null,
  familyNudge: 0,
  savedMessageIds: new Set(),
};

// ── Actions ────────────────────────────────────────────────────────────────

type Action =
  | { type: 'GUILDS_SET'; guilds: Guild[] }
  | { type: 'SUPERVISION_SET'; supervision: FamilySummary }
  | { type: 'FAMILY_NUDGE' }
  | { type: 'GUILD_UPSERT'; guild: Guild }
  | { type: 'GUILD_REMOVE'; guildId: string }
  | { type: 'CHANNELS_SET'; guildId: string; channels: Channel[] }
  | { type: 'CHANNEL_UPSERT'; channel: Channel }
  | {
      type: 'CHANNEL_REORDER';
      guildId: string;
      changes: Array<{ id: string; position: number; parentId?: string | null }>;
    }
  | { type: 'CHANNEL_REMOVE'; channelId: string; guildId: string | null }
  | {
      type: 'MESSAGES_SET';
      channelId: string;
      messages: Message[];
      // loadMessages (newest window) unions any newer optimistic/live row back
      // on so a mid-flight send isn't dropped. loadMessagesAround (a jump to an
      // arbitrary OLDER window) must NOT — unioning the newest tail onto a
      // middle window creates a disjoint list with a gap. Defaults true.
      preserveNewerSurvivors?: boolean;
    }
  | {
      type: 'MESSAGES_PREPEND';
      channelId: string;
      messages: Message[];
      /** True if the server returned fewer messages than the page size,
          meaning we've reached the head of the channel. Subsequent
          scroll-up fetches are short-circuited via olderExhausted. */
      reachedHead: boolean;
    }
  | { type: 'LOADING_OLDER_BEGIN'; channelId: string }
  | { type: 'LOADING_OLDER_END'; channelId: string }
  | { type: 'MESSAGE_APPEND'; channelId: string; message: Message }
  | { type: 'MESSAGE_PATCH'; channelId: string; message: Message }
  /** Focused poll-only delta — currently fired by the server's poll
   *  expiry sweep when closed_at flips. Reducer locates the
   *  matching message and patches the poll's closedAt without
   *  touching any other message state. */
  | {
      type: 'POLL_PATCH';
      channelId: string;
      messageId: string;
      pollId: string;
      closedAt: string;
    }
  /** Replace a message's poll with a locally-computed snapshot (the
   *  voter's optimistic tallies + their own myVotes). Gateway poll
   *  broadcasts carry no per-recipient vote state, so the user's own
   *  selection must be persisted here to survive MESSAGE_PATCH
   *  resyncs. */
  | { type: 'POLL_LOCAL_REPLACE'; channelId: string; messageId: string; poll: Poll }
  | { type: 'MESSAGE_REMOVE'; channelId: string; messageId: string }
  | { type: 'MESSAGES_REMOVE_BULK'; channelId: string; messageIds: string[] }
  /**
   * Apply a delivered_at or viewed_at stamp to a batch of messages.
   * Driven by the MESSAGE_DELIVERED / MESSAGE_VIEWED gateway events
   * (which only reach the message author). The reducer walks the
   * channel's message list once and patches each matched id;
   * unknown ids are silently ignored (the message may have scrolled
   * out of the cached window — when the user scrolls back it'll
   * be refetched with the stamps already populated).
   */
  | {
      type: 'MESSAGE_RECEIPT_STAMP';
      channelId: string;
      messageIds: string[];
      field: 'deliveredAt' | 'viewedAt';
      timestamp: string;
    }
  /**
   * Replace a locally-issued optimistic message (identified by its
   * temp `localId`) with the real server-returned message. If the
   * temp id isn't found we fall back to a plain append, which keeps
   * us from dropping messages on race conditions.
   */
  | { type: 'MESSAGE_REPLACE_LOCAL'; channelId: string; localId: string; message: Message }
  /**
   * Mark a locally-issued optimistic message as failed so the bubble
   * shows the retry affordance instead of remaining "pending forever".
   */
  | { type: 'MESSAGE_MARK_FAILED'; channelId: string; localId: string }
  | { type: 'USERS_UPSERT'; users: PublicUser[] }
  /** Replace a single user in the cache. Distinct from USERS_UPSERT
      because the latter skips already-known ids (the assumption being
      that mass user upserts come from message-author backfills, where
      the cache is more authoritative than the new copy). USER_REPLACE
      is for cases — like the USER_UPDATE gateway event — where the
      incoming row is the new truth. */
  | { type: 'USER_REPLACE'; user: PublicUser }
  | { type: 'MEMBERS_SET'; guildId: string; members: GuildMember[] }
  | { type: 'MEMBER_UPSERT'; guildId: string; member: GuildMember }
  | { type: 'MEMBER_REMOVE'; guildId: string; userId: string }
  | {
      type: 'PRESENCE_PATCH';
      guildId: string;
      userId: string;
      status: 'online' | 'idle' | 'dnd' | 'offline';
    }
  | { type: 'REACTION_ADD'; channelId: string; messageId: string; userId: string; emoji: string; selfId: string | null }
  | { type: 'REACTION_REMOVE'; channelId: string; messageId: string; userId: string; emoji: string; selfId: string | null }
  | { type: 'REACTION_REMOVE_ALL'; channelId: string; messageId: string; emoji?: string }
  | { type: 'DMS_SET'; channels: Channel[] }
  | { type: 'DM_UPSERT'; channel: Channel }
  | { type: 'DM_STREAK_SET'; channelId: string; streak: number }
  | { type: 'POKE_PILL_SET'; channelId: string; emoji: string }
  | { type: 'POKE_PILL_CLEAR'; channelId: string }
  | { type: 'READ_STATES_SET'; readStates: ReadState[] }
  | { type: 'READ_STATES_MERGE'; readStates: ReadState[] }
  | { type: 'READ_STATE_UPSERT'; readState: ReadState }
  | { type: 'MENTION_INCREMENT'; channelId: string }
  | { type: 'VOICE_STATES_SET'; voiceStates: VoiceState[] }
  | { type: 'VOICE_STATE_UPSERT'; voiceState: VoiceState }
  | {
      /** Merge an authoritative snapshot of a single channel's voice
          states into the map. Removes any current entries whose
          channelId equals the snapshot's channelId but whose userId
          isn't in the snapshot (they left and we missed the event),
          and upserts every entry in the snapshot. Other channels'
          entries are untouched. Used after rest.joinVoice returns
          to ensure the joiner's local map matches reality. */
      type: 'VOICE_STATES_MERGE_CHANNEL';
      channelId: string;
      voiceStates: VoiceState[];
    }
  | { type: 'CHANNEL_PINS_BUMP'; channelId: string }
  | {
      type: 'NOTIF_OVERRIDES_SET';
      overrides: Array<{
        targetType: 'guild' | 'channel';
        targetId: string;
        level: 'all' | 'mentions' | 'nothing';
      }>;
    }
  | {
      type: 'NOTIF_OVERRIDE_SET';
      targetType: 'guild' | 'channel';
      targetId: string;
      /** null clears the override (returns to default 'all'). */
      level: 'all' | 'mentions' | 'nothing' | null;
    }
  | {
      type: 'RELATIONSHIPS_SET';
      relationships: Array<{
        type: 'friend' | 'incoming_request' | 'outgoing_request' | 'blocked';
        createdAt: string;
        user: PublicUser;
      }>;
    }
  | { type: 'DM_NICKNAMES_SET'; nicknames: Record<string, string> }
  | { type: 'DM_NICKNAME_SET'; userId: string; nickname: string | null }
  | {
      type: 'RELATIONSHIP_UPSERT';
      relationship: {
        type: 'friend' | 'incoming_request' | 'outgoing_request' | 'blocked';
        createdAt: string;
        user: PublicUser;
      };
    }
  | { type: 'RELATIONSHIP_REMOVE'; userId: string }
  | { type: 'EMOJIS_SET'; guildId: string; emojis: GuildEmoji[] }
  | { type: 'STICKERS_SET'; guildId: string; stickers: Sticker[] }
  | { type: 'STAGE_PARTICIPANTS_SET'; channelId: string; participants: StageParticipant[] }
  | { type: 'ROLES_SET'; guildId: string; roles: Role[] }
  | { type: 'ROLE_UPSERT'; guildId: string; role: Role }
  // ── Scheduled events ──────────────────────────────────────────────────
  // Full replace from a list fetch. Caller-supplied DTOs include
  // rsvpCounts + myRsvp.
  | { type: 'EVENTS_SET'; guildId: string; events: ScheduledEvent[] }
  // Create-or-update single event. Used for both REST mutation
  // responses (DTO has rsvpCounts/myRsvp) and broadcast deltas
  // (DTO omits them). Reducer merges: when fields are absent in the
  // payload, preserve the prior values rather than overwrite with
  // undefined — this is the "broadcast preserves per-recipient
  // state" rule.
  | { type: 'EVENT_UPSERT'; guildId: string; event: ScheduledEvent }
  // Remove a single event (DELETE or broadcast).
  | { type: 'EVENT_REMOVE'; guildId: string; eventId: string }
  // Local-only optimistic patch of the caller's RSVP. The next REST
  // refresh is canonical; this is just for instant UI feedback.
  | {
      type: 'EVENT_RSVP_PATCH';
      guildId: string;
      eventId: string;
      myRsvp: 'going' | 'maybe' | 'declined' | null;
      rsvpCounts: { going: number; maybe: number; declined: number };
    }
  // Saved-messages (bookmarks) — local mirror of the (user, message)
  // saves table. Populated incrementally via the savedMembership REST
  // call when a channel loads, and toggled via the per-message
  // bookmark button.
  | { type: 'SAVED_HYDRATE'; messageIds: string[] }
  | { type: 'SAVED_TOGGLE'; messageId: string; saved: boolean }
  // Wipe everything back to initialState. Dispatched when the signed-in
  // identity changes (sign-out, or switching accounts). Without it this
  // provider stays mounted across a logout and the NEXT account inherits the
  // previous one's guilds, channels, messages, member lists and read states
  // until each is individually refetched — a cross-account data leak on any
  // shared machine, and visibly wrong in the seconds before hydration lands.
  | { type: 'RESET' };

// Cap messages-per-channel to keep memory bounded. For v1 we don't have
// virtualized scrolling, so 200 is plenty for the visible buffer; older
// messages can be re-fetched via REST on scroll-up (deferred).
const MESSAGES_CAP = 200;

/**
 * Pull user objects out of an iterable of messages and insert them into
 * usersById. The same author is referenced from many messages — Object
 * spread short-circuits when nothing changes, but we explicitly check for
 * absence to avoid creating new state objects on no-op upserts.
 */
function upsertUsersFromMessages(state: State, messages: Iterable<Message>): State {
  let usersById: Record<string, PublicUser> | null = null;
  for (const m of messages) {
    if (!m.author) continue;
    if (state.usersById[m.author.id]) continue;
    if (!usersById) usersById = { ...state.usersById };
    usersById[m.author.id] = m.author;
  }
  return usersById ? { ...state, usersById } : state;
}

/**
 * Keep a DM channel's `lastMessageId` current when a message lands. The
 * server-loaded value is a point-in-time snapshot and was never bumped
 * on subsequent messages, so the DM list couldn't sort by recency and
 * unread could miss post-load messages. We only touch DM channels (guild
 * channels manage their own order), skip non-numeric ids (optimistic
 * `local-…` placeholders), and only ever move the id FORWARD. Returns
 * the same array reference when nothing changes so React bails cheaply.
 */
function bumpDmRecency(
  channels: Channel[],
  channelId: string,
  messageId: string,
): Channel[] {
  if (!/^\d+$/.test(messageId)) return channels;
  const idx = channels.findIndex((c) => c.id === channelId);
  if (idx === -1) return channels;
  const ch = channels[idx]!;
  if (
    ch.lastMessageId &&
    /^\d+$/.test(ch.lastMessageId) &&
    BigInt(ch.lastMessageId) >= BigInt(messageId)
  ) {
    return channels;
  }
  const next = channels.slice();
  next[idx] = { ...ch, lastMessageId: messageId };
  return next;
}

/**
 * Same forward-only lastMessageId bump for GUILD channels. Without this, a
 * guild channel's lastMessageId was a point-in-time snapshot from the last
 * channels fetch: the unread dot neither appeared live when a message arrived
 * in a background channel, nor reliably cleared after reading (the auto-ack
 * acks the newest LOADED id; a stale-but-higher snapshot elsewhere could
 * out-compare it). Returns the same map reference when nothing changes.
 */
function bumpGuildRecency(
  channelsByGuild: Record<string, Channel[]>,
  channelId: string,
  messageId: string,
): Record<string, Channel[]> {
  if (!/^\d+$/.test(messageId)) return channelsByGuild;
  for (const [gid, list] of Object.entries(channelsByGuild)) {
    const idx = list.findIndex((c) => c.id === channelId);
    if (idx === -1) continue;
    const ch = list[idx]!;
    if (
      ch.lastMessageId &&
      /^\d+$/.test(ch.lastMessageId) &&
      BigInt(ch.lastMessageId) >= BigInt(messageId)
    ) {
      return channelsByGuild;
    }
    const nextList = list.slice();
    nextList[idx] = { ...ch, lastMessageId: messageId };
    return { ...channelsByGuild, [gid]: nextList };
  }
  return channelsByGuild;
}

function applyReactionDelta(
  reactions: ReactionAggregate[],
  emoji: string,
  delta: 1 | -1,
  meChange: boolean | null,
): ReactionAggregate[] {
  const idx = reactions.findIndex((r) => r.emoji === emoji);
  if (idx === -1) {
    if (delta < 0) return reactions; // removing nothing — ignore
    return [...reactions, { emoji, count: 1, me: meChange === true }];
  }
  const existing = reactions[idx]!;
  // Idempotency guard for self-reactions:
  //   ADD with meChange=true and existing.me already true → no-op
  //   REMOVE with meChange=false and existing.me already false → no-op
  // Without this, the optimistic update from clicking a reaction +
  // the matching gateway MESSAGE_REACTION_ADD event both fired
  // their own +1, briefly rendering as TWO of the same emoji
  // before a reconciliation corrected it. Same idea for the
  // remove path.
  if (delta === 1 && meChange === true && existing.me) {
    return reactions;
  }
  if (delta === -1 && meChange === false && !existing.me) {
    return reactions;
  }
  const nextCount = existing.count + delta;
  if (nextCount <= 0) {
    return reactions.filter((_, i) => i !== idx);
  }
  const next: ReactionAggregate = {
    emoji,
    count: nextCount,
    me: meChange === null ? existing.me : meChange,
  };
  return reactions.map((r, i) => (i === idx ? next : r));
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'RESET':
      return initialState;
    case 'GUILDS_SET': {
      const guildsById: Record<string, Guild> = {};
      for (const g of action.guilds) guildsById[g.id] = g;
      return { ...state, guildIds: action.guilds.map((g) => g.id), guildsById };
    }
    case 'GUILD_UPSERT': {
      const isNew = !state.guildsById[action.guild.id];
      return {
        ...state,
        guildIds: isNew ? [...state.guildIds, action.guild.id] : state.guildIds,
        guildsById: { ...state.guildsById, [action.guild.id]: action.guild },
      };
    }
    case 'GUILD_REMOVE': {
      if (!state.guildsById[action.guildId]) return state;
      const { [action.guildId]: _drop, ...remaining } = state.guildsById;
      void _drop;

      // Capture the channel ids that belonged to the removed guild
      // BEFORE deleting the channelsByGuild entry — we need them to
      // scrub every channel-keyed slice of state (messages, read
      // state, paginator flags).
      const removedChannels = state.channelsByGuild[action.guildId] ?? [];
      const removedChannelIds = new Set(removedChannels.map((c) => c.id));

      const channelsByGuild = { ...state.channelsByGuild };
      delete channelsByGuild[action.guildId];
      const membersByGuild = { ...state.membersByGuild };
      delete membersByGuild[action.guildId];
      const emojisByGuild = { ...state.emojisByGuild };
      delete emojisByGuild[action.guildId];

      // Drop the guild's role list. Roles are guild-scoped, so when
      // the user loses access to the guild the roles are useless.
      let rolesByGuild = state.rolesByGuild;
      if (rolesByGuild[action.guildId]) {
        const { [action.guildId]: _r, ...rest } = rolesByGuild;
        void _r;
        rolesByGuild = rest;
      }

      // Sticker + scheduled-event lists and the member-loaded flag are
      // guild-scoped too — drop them so they don't leak after the guild goes.
      let stickersByGuild = state.stickersByGuild;
      if (stickersByGuild[action.guildId]) {
        const { [action.guildId]: _s, ...rest } = stickersByGuild;
        void _s;
        stickersByGuild = rest;
      }
      let eventsByGuild = state.eventsByGuild;
      if (eventsByGuild[action.guildId]) {
        const { [action.guildId]: _e, ...rest } = eventsByGuild;
        void _e;
        eventsByGuild = rest;
      }
      let loadedMembers = state.loadedMembers;
      if (loadedMembers.has(action.guildId)) {
        const next = new Set(loadedMembers);
        next.delete(action.guildId);
        loadedMembers = next;
      }

      // Scrub channel-keyed slices. Only allocate new refs when there's
      // something to drop — most channel-keyed entries belong to other
      // guilds or DMs and shouldn't be touched.
      let messagesByChannel = state.messagesByChannel;
      let readStateByChannel = state.readStateByChannel;
      let loadingOlder = state.loadingOlder;
      let olderExhausted = state.olderExhausted;
      let loadedChannels = state.loadedChannels;
      let stageParticipantsByChannel = state.stageParticipantsByChannel;
      let channelPinUpdateAt = state.channelPinUpdateAt;
      if (removedChannelIds.size > 0) {
        // messagesByChannel + readStateByChannel: filter out removed
        // channels from the dict.
        let msgChanged = false;
        const nextMsg: Record<string, typeof messagesByChannel[string]> = {};
        for (const [cid, msgs] of Object.entries(messagesByChannel)) {
          if (removedChannelIds.has(cid)) {
            msgChanged = true;
          } else {
            nextMsg[cid] = msgs;
          }
        }
        if (msgChanged) messagesByChannel = nextMsg;

        let readChanged = false;
        const nextRead: Record<string, typeof readStateByChannel[string]> = {};
        for (const [cid, rs] of Object.entries(readStateByChannel)) {
          if (removedChannelIds.has(cid)) {
            readChanged = true;
          } else {
            nextRead[cid] = rs;
          }
        }
        if (readChanged) readStateByChannel = nextRead;

        // loadingOlder + olderExhausted are Sets. Only rebuild when at
        // least one removed channel is present (avoids spurious Set
        // identity changes that would invalidate downstream memoization).
        let loadingChanged = false;
        for (const cid of removedChannelIds) {
          if (loadingOlder.has(cid)) {
            loadingChanged = true;
            break;
          }
        }
        if (loadingChanged) {
          const next = new Set(loadingOlder);
          for (const cid of removedChannelIds) next.delete(cid);
          loadingOlder = next;
        }

        let exhaustedChanged = false;
        for (const cid of removedChannelIds) {
          if (olderExhausted.has(cid)) {
            exhaustedChanged = true;
            break;
          }
        }
        if (exhaustedChanged) {
          const next = new Set(olderExhausted);
          for (const cid of removedChannelIds) next.delete(cid);
          olderExhausted = next;
        }

        // loadedChannels (Set of channel ids).
        let loadedChChanged = false;
        for (const cid of removedChannelIds) {
          if (loadedChannels.has(cid)) {
            loadedChChanged = true;
            break;
          }
        }
        if (loadedChChanged) {
          const next = new Set(loadedChannels);
          for (const cid of removedChannelIds) next.delete(cid);
          loadedChannels = next;
        }

        // stageParticipantsByChannel + channelPinUpdateAt (channel-keyed dicts).
        let stageChanged = false;
        const nextStage: Record<string, (typeof stageParticipantsByChannel)[string]> = {};
        for (const [cid, v] of Object.entries(stageParticipantsByChannel)) {
          if (removedChannelIds.has(cid)) stageChanged = true;
          else nextStage[cid] = v;
        }
        if (stageChanged) stageParticipantsByChannel = nextStage;

        let pinChanged = false;
        const nextPin: Record<string, number> = {};
        for (const [cid, v] of Object.entries(channelPinUpdateAt)) {
          if (removedChannelIds.has(cid)) pinChanged = true;
          else nextPin[cid] = v;
        }
        if (pinChanged) channelPinUpdateAt = nextPin;
      }

      return {
        ...state,
        guildIds: state.guildIds.filter((id) => id !== action.guildId),
        guildsById: remaining,
        channelsByGuild,
        membersByGuild,
        emojisByGuild,
        rolesByGuild,
        stickersByGuild,
        eventsByGuild,
        loadedMembers,
        messagesByChannel,
        readStateByChannel,
        loadingOlder,
        olderExhausted,
        loadedChannels,
        stageParticipantsByChannel,
        channelPinUpdateAt,
      };
    }

    case 'CHANNELS_SET':
      return {
        ...state,
        channelsByGuild: { ...state.channelsByGuild, [action.guildId]: action.channels },
      };
    case 'CHANNEL_UPSERT': {
      const guildId = action.channel.guildId;
      if (!guildId) return state; // DM channels handled separately later
      const existing = state.channelsByGuild[guildId] ?? [];
      const idx = existing.findIndex((c) => c.id === action.channel.id);
      const next = idx === -1 ? [...existing, action.channel] : existing.map((c) => (c.id === action.channel.id ? action.channel : c));
      return {
        ...state,
        channelsByGuild: { ...state.channelsByGuild, [guildId]: next },
      };
    }
    case 'CHANNEL_REORDER': {
      // Optimistic patch from a drag-and-drop. Each change adjusts
      // a single channel's position (and optionally parentId); we
      // merge in place. Render layer sorts by position so the rail
      // re-orders on the next render. Channels not mentioned in
      // changes stay untouched. The matching gateway CHANNEL_UPDATE
      // events that arrive moments later are idempotent — they
      // overwrite each row with the same values, no flicker.
      const existing = state.channelsByGuild[action.guildId];
      if (!existing) return state;
      const changeMap = new Map(action.changes.map((c) => [c.id, c]));
      const next = existing.map((ch) => {
        const change = changeMap.get(ch.id);
        if (!change) return ch;
        return {
          ...ch,
          position: change.position,
          parentId: change.parentId === undefined ? ch.parentId : change.parentId,
        };
      });
      return {
        ...state,
        channelsByGuild: { ...state.channelsByGuild, [action.guildId]: next },
      };
    }
    case 'CHANNEL_REMOVE': {
      // Guild channels live in channelsByGuild; DMs live in dmChannels.
      // Decide which list to filter based on which one currently has
      // the channel — falling back on the explicit guildId if present.
      // We also drop any local read-state for the removed channel so
      // the unread cache doesn't grow indefinitely as channels come
      // and go.
      if (action.guildId) {
        const existing = state.channelsByGuild[action.guildId];
        if (!existing) return state;
        // Scrub every per-channel cache for the removed channel — the guild
        // path previously only updated channelsByGuild and leaked the rest
        // (messages, read state, paginator flags, stage participants, pin
        // timestamps, loaded flag), same as the DM path below already does.
        const cid = action.channelId;
        const nextMessages = { ...state.messagesByChannel };
        delete nextMessages[cid];
        const nextRead = { ...state.readStateByChannel };
        delete nextRead[cid];
        const nextStage = { ...state.stageParticipantsByChannel };
        delete nextStage[cid];
        const nextPin = { ...state.channelPinUpdateAt };
        delete nextPin[cid];
        const loadedChannels = new Set(state.loadedChannels);
        loadedChannels.delete(cid);
        const loadingOlder = new Set(state.loadingOlder);
        loadingOlder.delete(cid);
        const olderExhausted = new Set(state.olderExhausted);
        olderExhausted.delete(cid);
        return {
          ...state,
          channelsByGuild: {
            ...state.channelsByGuild,
            [action.guildId]: existing.filter((c) => c.id !== cid),
          },
          messagesByChannel: nextMessages,
          readStateByChannel: nextRead,
          stageParticipantsByChannel: nextStage,
          channelPinUpdateAt: nextPin,
          loadedChannels,
          loadingOlder,
          olderExhausted,
        };
      }
      // DM channel — purge from dmChannels and from any per-channel
      // caches so navigating away leaves no dangling state behind.
      const nextDm = state.dmChannels.filter((c) => c.id !== action.channelId);
      if (nextDm.length === state.dmChannels.length) return state;
      const nextMessages = { ...state.messagesByChannel };
      delete nextMessages[action.channelId];
      const nextRead = { ...state.readStateByChannel };
      delete nextRead[action.channelId];
      const loadedChannels = new Set(state.loadedChannels);
      loadedChannels.delete(action.channelId);
      return {
        ...state,
        dmChannels: nextDm,
        messagesByChannel: nextMessages,
        readStateByChannel: nextRead,
        loadedChannels,
      };
    }

    case 'MESSAGES_SET': {
      const loaded = new Set(state.loadedChannels);
      loaded.add(action.channelId);
      // Reset older-exhausted on full re-fetch — if the user re-enters
      // a channel, the head may have moved (this is rare but cheap).
      const exhausted = new Set(state.olderExhausted);
      exhausted.delete(action.channelId);
      // Preserve live rows that arrived via MESSAGE_APPEND while this REST
      // fetch was in flight: a message posted AFTER the fetch's snapshot but
      // BEFORE its response lands isn't in `action.messages`, and a blind
      // replace would drop it (invisible until the next reconcile poll). Union
      // any existing row STRICTLY NEWER than the newest fetched row (by numeric
      // snowflake, deduped) back onto the tail. Optimistic `local-` ids are
      // ignored — they reconcile via their own nonce path.
      const fetched = action.messages;
      let maxFetched = 0n;
      for (const m of fetched) {
        if (/^\d+$/.test(m.id)) {
          const n = BigInt(m.id);
          if (n > maxFetched) maxFetched = n;
        }
      }
      const fetchedIds = new Set(fetched.map((m) => m.id));
      const prior = state.messagesByChannel[action.channelId] ?? [];
      const keepSurvivors = action.preserveNewerSurvivors ?? true;
      const survivors = keepSurvivors
        ? prior.filter(
            (m) => /^\d+$/.test(m.id) && !fetchedIds.has(m.id) && BigInt(m.id) > maxFetched,
          )
        : [];
      const merged = survivors.length > 0 ? [...fetched, ...survivors] : fetched;
      const next: State = {
        ...state,
        messagesByChannel: { ...state.messagesByChannel, [action.channelId]: merged },
        loadedChannels: loaded,
        olderExhausted: exhausted,
      };
      return upsertUsersFromMessages(next, merged);
    }
    case 'MESSAGES_PREPEND': {
      const existing = state.messagesByChannel[action.channelId] ?? [];
      // Drop ids that are already present — re-entry races + WebSocket
      // races could make the same id show up twice. The Set keeps the
      // dedupe at O(1) per check.
      const seen = new Set(existing.map((m) => m.id));
      const fresh = action.messages.filter((m) => !seen.has(m.id));
      // Prepend in the order we got them (already chronological by the
      // time the loader hands them off).
      const merged = [...fresh, ...existing];
      const exhausted = new Set(state.olderExhausted);
      if (action.reachedHead) exhausted.add(action.channelId);
      const next: State = {
        ...state,
        messagesByChannel: { ...state.messagesByChannel, [action.channelId]: merged },
        olderExhausted: exhausted,
      };
      return upsertUsersFromMessages(next, fresh);
    }
    case 'LOADING_OLDER_BEGIN': {
      if (state.loadingOlder.has(action.channelId)) return state;
      const s = new Set(state.loadingOlder);
      s.add(action.channelId);
      return { ...state, loadingOlder: s };
    }
    case 'LOADING_OLDER_END': {
      if (!state.loadingOlder.has(action.channelId)) return state;
      const s = new Set(state.loadingOlder);
      s.delete(action.channelId);
      return { ...state, loadingOlder: s };
    }
    case 'MESSAGE_APPEND': {
      const existing = state.messagesByChannel[action.channelId] ?? [];
      // Reconcile a gateway echo with our own optimistic placeholder.
      // The sender's MESSAGE_CREATE carries the `nonce` we sent (the
      // placeholder's local id). If it matches a placeholder we have,
      // replace IN PLACE — otherwise the echo (real id) and the
      // placeholder (local id) would both render until the REST 201
      // lands, which is the brief duplicate "ghost" the user sees.
      const nonce = action.message.nonce;
      if (nonce) {
        const phIdx = existing.findIndex((m) => m.id === nonce);
        if (phIdx !== -1) {
          // Guard against the real id also being present already.
          const dupIdx = existing.findIndex((m) => m.id === action.message.id);
          const replaced = existing.slice();
          replaced[phIdx] = action.message;
          const cleaned =
            dupIdx !== -1 && dupIdx !== phIdx
              ? replaced.filter((_, i) => i !== dupIdx)
              : replaced;
          const next: State = {
            ...state,
            messagesByChannel: {
              ...state.messagesByChannel,
              [action.channelId]: cleaned,
            },
            dmChannels: bumpDmRecency(state.dmChannels, action.channelId, action.message.id),
            channelsByGuild: bumpGuildRecency(state.channelsByGuild, action.channelId, action.message.id),
          };
          return upsertUsersFromMessages(next, [action.message]);
        }
      }
      // Drop dupes — REST optimism + gateway echo can both feed the same id.
      if (existing.some((m) => m.id === action.message.id)) return state;
      const nextList = [...existing, action.message];
      // Cap from the front so we keep the newest tail.
      const capped = nextList.length > MESSAGES_CAP ? nextList.slice(nextList.length - MESSAGES_CAP) : nextList;
      const next: State = {
        ...state,
        messagesByChannel: { ...state.messagesByChannel, [action.channelId]: capped },
        dmChannels: bumpDmRecency(state.dmChannels, action.channelId, action.message.id),
        channelsByGuild: bumpGuildRecency(state.channelsByGuild, action.channelId, action.message.id),
      };
      return upsertUsersFromMessages(next, [action.message]);
    }
    case 'MESSAGE_PATCH': {
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      const idx = existing.findIndex((m) => m.id === action.message.id);
      if (idx === -1) return state;
      // Gateway MESSAGE_UPDATE fans ONE DTO to every channel member, so it
      // cannot carry per-recipient state: poll.myVotes arrives empty and
      // reactions[].me arrives false for everyone. Preserve what this
      // client already knows about the current user (REST hydration,
      // reaction events, and POLL_LOCAL_REPLACE are the per-self truth).
      const prev = existing[idx];
      let merged = action.message;
      if (merged.poll && prev.poll && merged.poll.id === prev.poll.id && prev.poll.myVotes.length > 0) {
        merged = { ...merged, poll: { ...merged.poll, myVotes: prev.poll.myVotes } };
      }
      if (merged.reactions?.length && prev.reactions?.length) {
        const mine = new Set(prev.reactions.filter((r) => r.me).map((r) => r.emoji));
        if (mine.size > 0) {
          merged = {
            ...merged,
            reactions: merged.reactions.map((r) => (mine.has(r.emoji) && !r.me ? { ...r, me: true } : r)),
          };
        }
      }
      const nextList = existing.slice();
      nextList[idx] = merged;
      const next: State = {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: nextList,
        },
      };
      return upsertUsersFromMessages(next, [merged]);
    }
    case 'POLL_LOCAL_REPLACE': {
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      const idx = existing.findIndex((m) => m.id === action.messageId);
      if (idx === -1) return state;
      const msg = existing[idx];
      if (!msg.poll || msg.poll.id !== action.poll.id) return state;
      const nextList = existing.slice();
      nextList[idx] = { ...msg, poll: action.poll };
      return {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: nextList,
        },
      };
    }
    case 'POLL_PATCH': {
      // Focused poll-only patch — locate the message and patch the
      // poll subtree's closedAt without touching anything else.
      // If the channel/message/poll isn't in our local cache (user
      // hasn't scrolled here, or the message was pruned by the
      // ring buffer), the action is a no-op — the next message
      // load will pick up the canonical state.
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      const idx = existing.findIndex((m) => m.id === action.messageId);
      if (idx === -1) return state;
      const msg = existing[idx];
      if (!msg.poll || msg.poll.id !== action.pollId) return state;
      const patched: Message = {
        ...msg,
        poll: {
          ...msg.poll,
          closedAt: action.closedAt,
        },
      };
      const nextList = existing.slice();
      nextList[idx] = patched;
      return {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: nextList,
        },
      };
    }
    case 'MESSAGE_REMOVE': {
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      return {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: existing.filter((m) => m.id !== action.messageId),
        },
      };
    }
    case 'MESSAGES_REMOVE_BULK': {
      // Channel purge / bulk-mod-delete from the gateway. Strip the
      // listed ids from the channel's message list in one pass.
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      const drop = new Set(action.messageIds);
      const next = existing.filter((m) => !drop.has(m.id));
      if (next.length === existing.length) return state;
      return {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: next,
        },
      };
    }
    case 'MESSAGE_RECEIPT_STAMP': {
      // Apply Sent → Delivered / Read stamps from the gateway. We
      // walk the channel's message list once and patch each matched
      // id; ids we don't know about (scrolled out of the window)
      // are silently skipped. The field+timestamp pair lets us reuse
      // this reducer for both event types.
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      const ids = new Set(action.messageIds);
      let changed = false;
      const updated = existing.map((m) => {
        if (!ids.has(m.id)) return m;
        // Monotonic: never overwrite a populated stamp with the same
        // event firing twice. The server's UPDATE has the same
        // monotonic guard but the client's local-optimistic state
        // could already carry a stamp from a prior reducer tick.
        const current = m[action.field];
        if (current) return m;
        changed = true;
        return { ...m, [action.field]: action.timestamp };
      });
      if (!changed) return state;
      return {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: updated,
        },
      };
    }
    case 'MESSAGE_REPLACE_LOCAL': {
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) {
        // No list for this channel — fall back to append.
        return {
          ...state,
          messagesByChannel: { ...state.messagesByChannel, [action.channelId]: [action.message] },
        };
      }
      // If the gateway echo already arrived first (server's MESSAGE_CREATE
      // beat our REST 201 response), the real message is already in the
      // list at its correct position. Just remove the temp placeholder —
      // the dedup-by-id logic in MESSAGE_APPEND has already handled the
      // real one (placing it in the correct slot relative to any other
      // messages that arrived around the same time).
      const localIdx = existing.findIndex((m) => m.id === action.localId);
      const realAlreadyPresent = existing.some((m) => m.id === action.message.id);
      let next: Message[];
      if (localIdx === -1) {
        // Placeholder not found (already removed by something else, or
        // the channel state was reset mid-send). Append the real
        // message at the tail unless it's already in.
        next = realAlreadyPresent ? existing : [...existing, action.message];
      } else if (realAlreadyPresent) {
        // Real one already landed via gateway echo — drop the
        // placeholder and let the real one stay wherever the APPEND
        // path put it.
        next = existing.filter((m) => m.id !== action.localId);
      } else {
        // Replace IN PLACE at the placeholder's index. The previous
        // implementation did filter + concat-to-end, which placed the
        // real message AFTER any other messages that had arrived
        // between the optimistic-insert and the REST response. That
        // contradicted snowflake-id ordering: the user's own message
        // would appear after messages created later than it on the
        // server, and a refetch would reshuffle. In-place replacement
        // keeps the user's message visually anchored where they
        // pressed send, and the rest of the array (later arrivals
        // already appended after the placeholder) stays in the
        // correct relative order.
        next = existing.slice();
        next[localIdx] = action.message;
      }
      const nextState: State = {
        ...state,
        messagesByChannel: { ...state.messagesByChannel, [action.channelId]: next },
        dmChannels: bumpDmRecency(state.dmChannels, action.channelId, action.message.id),
      };
      return upsertUsersFromMessages(nextState, [action.message]);
    }
    case 'MESSAGE_MARK_FAILED': {
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      const next = existing.map((m) =>
        m.id === action.localId ? { ...m, pending: false, failed: true } : m,
      );
      return {
        ...state,
        messagesByChannel: { ...state.messagesByChannel, [action.channelId]: next },
      };
    }

    case 'USERS_UPSERT': {
      let usersById: Record<string, PublicUser> | null = null;
      for (const u of action.users) {
        if (state.usersById[u.id]) continue;
        if (!usersById) usersById = { ...state.usersById };
        usersById[u.id] = u;
      }
      return usersById ? { ...state, usersById } : state;
    }

    case 'USER_REPLACE': {
      // Replace semantics: overwrite when the incoming row genuinely
      // differs. We also propagate the new avatar/displayName into any
      // cached GuildMember rows that reference this user. Members carry
      // a `user: PublicUser` snapshot per role-rendering needs; without
      // this update the MemberList would still show the old avatar
      // until the next loadMembers().
      //
      // Early bail when the payload doesn't change anything we hold.
      // USER_UPDATE fans out per-guild on the gateway, so for a user
      // shared across N guilds we receive the same payload N times in
      // quick succession. Without this check each delivery re-allocates
      // a new top-level state and triggers every consumer of
      // useAppState to re-render — for a payload-identical event.
      const prev = state.usersById[action.user.id];
      const userUnchanged =
        prev !== undefined &&
        prev.username === action.user.username &&
        prev.displayName === action.user.displayName &&
        prev.avatarUrl === action.user.avatarUrl &&
        prev.customStatus === action.user.customStatus &&
        prev.status === action.user.status;
      if (userUnchanged) {
        // Even if the user row didn't change, a guild-member's
        // *embedded* user snapshot might be stale (e.g. we loaded
        // members earlier than the user came into the cache). Walk
        // membersByGuild only when that's actually possible — when
        // prev is undefined we know we just inserted the user, so
        // walking is necessary. When prev matches the incoming payload
        // and the member-list snapshots are guaranteed to track
        // usersById (they do — every MEMBER_UPSERT keeps them aligned
        // and MEMBERS_SET seeds usersById from member rows), no
        // further work is needed.
        return state;
      }
      const next = { ...state.usersById, [action.user.id]: action.user };
      let membersByGuild: Record<string, GuildMember[]> | null = null;
      for (const [gid, members] of Object.entries(state.membersByGuild)) {
        let dirty = false;
        const updated = members.map((m) => {
          if (m.userId !== action.user.id) return m;
          dirty = true;
          return { ...m, user: action.user };
        });
        if (dirty) {
          if (!membersByGuild) membersByGuild = { ...state.membersByGuild };
          membersByGuild[gid] = updated;
        }
      }
      return {
        ...state,
        usersById: next,
        membersByGuild: membersByGuild ?? state.membersByGuild,
      };
    }

    case 'MEMBERS_SET': {
      const loaded = new Set(state.loadedMembers);
      loaded.add(action.guildId);
      // Pull users out into the cache while we're at it.
      let usersById: Record<string, PublicUser> | null = null;
      for (const m of action.members) {
        if (state.usersById[m.user.id]) continue;
        if (!usersById) usersById = { ...state.usersById };
        usersById[m.user.id] = m.user;
      }
      return {
        ...state,
        membersByGuild: { ...state.membersByGuild, [action.guildId]: action.members },
        loadedMembers: loaded,
        usersById: usersById ?? state.usersById,
      };
    }
    case 'MEMBER_UPSERT': {
      const list = state.membersByGuild[action.guildId];
      if (!list) return state; // member list not loaded — gateway events have nowhere to land yet
      const idx = list.findIndex((m) => m.userId === action.member.userId);
      const nextList = idx === -1 ? [...list, action.member] : list.map((m, i) => (i === idx ? action.member : m));
      const usersById = state.usersById[action.member.user.id]
        ? state.usersById
        : { ...state.usersById, [action.member.user.id]: action.member.user };
      return {
        ...state,
        membersByGuild: { ...state.membersByGuild, [action.guildId]: nextList },
        usersById,
      };
    }
    case 'MEMBER_REMOVE': {
      const list = state.membersByGuild[action.guildId];
      if (!list) return state;
      // Short-circuit when the user isn't in our cached list. Without
      // this, .filter() returns an identical-content but fresh-identity
      // array that invalidates every consumer of membersByGuild — for
      // no actual change. Common on remove events for users we hadn't
      // loaded yet (guild member panel never opened).
      if (!list.some((m) => m.userId === action.userId)) return state;
      return {
        ...state,
        membersByGuild: {
          ...state.membersByGuild,
          [action.guildId]: list.filter((m) => m.userId !== action.userId),
        },
      };
    }
    case 'PRESENCE_PATCH': {
      // Patch a single member's status without touching anything else
      // about the row. We also update the parallel `usersById` map so any
      // other render path that resolves users from there sees the new
      // status. If the target isn't a member (transient race), no-op.
      //
      // Early bail when the patch has nothing to land on: presence
      // events fan out per-guild and we receive them for any guild we
      // belong to, but we only hold cached data for guilds the user
      // has actually opened. For guilds we haven't loaded members for
      // AND a user we don't already have in usersById, the work below
      // would allocate two fresh top-level objects and trigger every
      // useAppState consumer to re-render — for a state mutation that
      // wouldn't be visible anywhere. Returning state preserves the
      // reference and React skips the re-render entirely.
      const list = state.membersByGuild[action.guildId];
      const cachedUser = state.usersById[action.userId];

      // The Friends tab renders its status dots from
      // relationships[].user.status — a copy that, despite the doc comment
      // on userStatusById claiming this reducer patches it, was in fact only
      // ever written by a full listRelationships() refetch. Patch it here too
      // so a live presence event moves the Friends-tab dot in lock-step with
      // the member-list and DM dots (it previously froze at the last list
      // fetch until a reconnect — a cross-surface presence split-brain).
      // Computed up front so it still lands when the member/usersById
      // fast-paths below bail out: a friend may be in no loaded guild and not
      // in usersById, yet still visible in the Friends tab. Resolves to the
      // same array reference when nothing matches, so unrelated presence
      // events don't re-render Friends consumers.
      const relIdx = state.relationships.findIndex((r) => r.user.id === action.userId);
      const relPrev = relIdx !== -1 ? state.relationships[relIdx]! : null;
      // DELIBERATELY NOT stamping lastSeenAt locally when a friend flips to
      // offline. An earlier version did, reasoning that a one-shot stamp "can't
      // be used to infer that an invisible user is still connected". That
      // reasoning is wrong, and the bug it hides is subtle:
      //
      // Going Invisible is broadcast as `offline`, identical on the wire to a
      // real disconnect. But the SERVER only advances last_seen_at on a genuine
      // disconnect — never for someone going invisible (that guard is the whole
      // point). So the local stamp makes the two cases diverge on the next
      // fetch:
      //
      //   real disconnect → "just now",  refetch → still "just now"
      //   went Invisible  → "just now",  refetch → snaps back to "5h ago"
      //
      // A last-seen time that jumps BACKWARDS is a reliable tell for "they went
      // invisible and are online right now" — exactly what Invisible hides.
      // Rendering a slightly stale value until the next listRelationships() is
      // the correct trade. Android reached the same conclusion independently.
      const relationships =
        relPrev !== null && relPrev.user.status !== action.status
          ? state.relationships.map((r, i) =>
              i === relIdx
                ? {
                    ...r,
                    user: {
                      ...r.user,
                      status: action.status,
                    },
                  }
                : r,
            )
          : state.relationships;

      if (!list && !cachedUser) {
        // Neither a loaded member list nor a cached identity — but a DM partner
        // you share this guild with (whose member list you never opened and
        // whose messages you never loaded) is in NEITHER map, yet the DM-list
        // dot still needs updating. Same for a friend in no loaded guild. Try
        // both patches; each returns the SAME ref when nothing matched, so we
        // keep the cheap reference-preserving bail for the common case.
        const dmChannels = patchDmRecipientStatus(state.dmChannels, action.userId, action.status);
        if (dmChannels === state.dmChannels && relationships === state.relationships) return state;
        return { ...state, dmChannels, relationships };
      }

      // Single findIndex serves both the early-bail check AND the
      // splice below — the previous code walked the list twice (once
      // in find, once in map) for the common path.
      const memberIdx = list
        ? list.findIndex((m) => m.userId === action.userId)
        : -1;

      // Also bail when the status is already what the patch says. The
      // server re-broadcasts presence on every IDENTIFY (to heal stale
      // member-list state across reconnects), so we get a flood of
      // redundant "user X is still online" updates that previously
      // re-allocated state for no reason. The cached-status check reads
      // the parallel userStatusById slice (below) rather than
      // usersById[x].status — presence no longer writes into usersById,
      // so its embedded status is not a reliable "current" value.
      const statusMatches =
        cachedUser === undefined || state.userStatusById[action.userId] === action.status;
      const memberStatusMatches =
        memberIdx === -1 || list![memberIdx]!.user.status === action.status;
      if (statusMatches && memberStatusMatches) {
        // The member row + status slice are already current, but the
        // relationships / DM-recipient copies might not be — don't drop those
        // patches just because the member-list view is up to date.
        const dmChannels = patchDmRecipientStatus(state.dmChannels, action.userId, action.status);
        if (dmChannels === state.dmChannels && relationships === state.relationships) return state;
        return { ...state, dmChannels, relationships };
      }

      // Write presence into a SEPARATE slice, never into usersById.
      // usersById holds identity (name/avatar/tag) and is subscribed to
      // wholesale by every visible MessageItem to resolve mention names
      // (MessageItem.tsx:111, fed into its renderCtx useMemo dep at
      // MessageItem.tsx:298). Spreading it on a status-only change would
      // flip that map's reference and re-render every message row in the
      // open channel on ANY cached user's online/idle/dnd transition —
      // work that changes nothing MessageItem renders. Rendered status
      // dots come from membersByGuild / dmChannels / relationships, which
      // this reducer patches directly (below), so identity stays stable.
      const userStatusById =
        cachedUser && state.userStatusById[action.userId] !== action.status
          ? { ...state.userStatusById, [action.userId]: action.status }
          : state.userStatusById;

      // No member entry to patch — just write back the status slice (or
      // skip it if it didn't change either). Previously this branch
      // fell through and allocated a fresh-but-identical member list,
      // spuriously invalidating every consumer of membersByGuild.
      if (memberIdx === -1) {
        // Still patch DM recipients — the DM list's status dots read
        // channel.recipients[*].status, which nothing else updates.
        // Without this, a DM partner's dot froze at whatever the list
        // fetch returned (the web-side twin of the iOS stale-pin bug).
        const dmChannels = patchDmRecipientStatus(state.dmChannels, action.userId, action.status);
        if (
          userStatusById === state.userStatusById &&
          dmChannels === state.dmChannels &&
          relationships === state.relationships
        )
          return state;
        return { ...state, userStatusById, dmChannels, relationships };
      }

      // Splice in place — O(1) work instead of .map's O(n) callback
      // invocation across the whole member list. For a 1000-member
      // guild that's the difference between iterating 1000 rows on
      // every presence change vs touching just the one that changed.
      const nextList = list!.slice();
      const m = nextList[memberIdx]!;
      nextList[memberIdx] = { ...m, user: { ...m.user, status: action.status } };
      return {
        ...state,
        membersByGuild: { ...state.membersByGuild, [action.guildId]: nextList },
        userStatusById,
        dmChannels: patchDmRecipientStatus(state.dmChannels, action.userId, action.status),
        relationships,
      };
    }

    case 'REACTION_ADD':
    case 'REACTION_REMOVE': {
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      // findIndex + slice update beats .map() on the hot path. For a
      // 200-message scrollback, .map() runs 200 comparison callbacks
      // and rebuilds the array from scratch on every reaction. With
      // findIndex we touch each ref once at slice time (pointer copy)
      // and do exactly one object replacement. Same React semantics
      // (new array identity), much less wasted work.
      const idx = existing.findIndex((m) => m.id === action.messageId);
      if (idx === -1) return state;
      const isSelf = action.selfId !== null && action.userId === action.selfId;
      const meChange = isSelf ? action.type === 'REACTION_ADD' : null;
      const delta = action.type === 'REACTION_ADD' ? 1 : -1;
      const target = existing[idx]!;
      const nextList = existing.slice();
      nextList[idx] = {
        ...target,
        reactions: applyReactionDelta(target.reactions, action.emoji, delta, meChange),
      };
      return {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: nextList,
        },
      };
    }
    case 'REACTION_REMOVE_ALL': {
      const existing = state.messagesByChannel[action.channelId];
      if (!existing) return state;
      const idx = existing.findIndex((m) => m.id === action.messageId);
      if (idx === -1) return state;
      const target = existing[idx]!;
      const nextList = existing.slice();
      nextList[idx] = {
        ...target,
        reactions:
          action.emoji === undefined
            ? []
            : target.reactions.filter((r) => r.emoji !== action.emoji),
      };
      return {
        ...state,
        messagesByChannel: {
          ...state.messagesByChannel,
          [action.channelId]: nextList,
        },
      };
    }

    case 'DMS_SET':
      return { ...state, dmChannels: action.channels, loadedDMs: true };
    case 'DM_UPSERT': {
      const idx = state.dmChannels.findIndex((c) => c.id === action.channel.id);
      // The gateway Channel DTO never carries `streak` (REST-only), so a
      // wholesale replace would wipe a loaded streak on any unrelated
      // CHANNEL_UPDATE (e.g. E2EE toggle). Preserve the existing value.
      const merged =
        idx === -1
          ? action.channel
          : { ...action.channel, streak: action.channel.streak ?? state.dmChannels[idx].streak };
      const next =
        idx === -1
          ? // New DM goes to the top — most-recent-first ordering
            [merged, ...state.dmChannels]
          : state.dmChannels.map((c) => (c.id === action.channel.id ? merged : c));
      return { ...state, dmChannels: next };
    }
    case 'DM_STREAK_SET': {
      const idx = state.dmChannels.findIndex((c) => c.id === action.channelId);
      if (idx === -1) return state;
      const next = state.dmChannels.slice();
      next[idx] = { ...next[idx], streak: action.streak };
      return { ...state, dmChannels: next };
    }

    case 'POKE_PILL_SET':
      return {
        ...state,
        pokePills: { ...state.pokePills, [action.channelId]: action.emoji },
      };

    case 'POKE_PILL_CLEAR': {
      if (!state.pokePills[action.channelId]) return state;   // no churn
      const next = { ...state.pokePills };
      delete next[action.channelId];
      return { ...state, pokePills: next };
    }

    case 'READ_STATES_SET': {
      const map: Record<string, ReadState> = {};
      for (const rs of action.readStates) map[rs.channelId] = rs;
      return { ...state, readStateByChannel: map, loadedReadStates: true };
    }

    case 'READ_STATES_MERGE': {
      // Merge a batch (e.g. a node's read-states for remote guilds) into the
      // existing map without clobbering backbone entries. Used so remote
      // guilds contribute to per-channel unread + the total mention count.
      if (action.readStates.length === 0) return state;
      const map = { ...state.readStateByChannel };
      for (const rs of action.readStates) map[rs.channelId] = rs;
      return { ...state, readStateByChannel: map };
    }
    case 'READ_STATE_UPSERT': {
      const existing = state.readStateByChannel[action.readState.channelId];
      // Same monotonicity guard as the server: refuse backwards moves on
      // lastMessageId. Compare numerically (snowflakes are monotonic but
      // they're strings on the wire — bigint comparison is the safe path).
      // Guard with a digit-only check first: optimistic placeholder ids
      // (`local-...`) would crash BigInt() with InvalidBigIntSyntax. They
      // shouldn't reach here because callers filter, but a runtime safety
      // net is cheap and surface-area-bounded — silently drop the update
      // rather than crash the dispatch chain.
      const looksNumeric = (s: string | null | undefined): s is string =>
        typeof s === 'string' && /^\d+$/.test(s);
      if (!looksNumeric(action.readState.lastMessageId)) return state;
      if (existing && existing.lastMessageId && looksNumeric(existing.lastMessageId)) {
        if (BigInt(action.readState.lastMessageId) < BigInt(existing.lastMessageId)) {
          // Backwards — keep existing marker AND existing count.
          // The server (see services/readStates.ts) preserves
          // mention_count when the marker doesn't advance, so an
          // incoming value in this branch is either an optimistic
          // 0 (client guessed before the server response landed)
          // or a stale echo from a different device. Either way
          // it's not authoritative; the genuine count is what we
          // already have. The previous behavior of accepting the
          // incoming count caused a 5 → 0 → 5 flicker when the
          // user clicked "jump to message" on an older message
          // and the optimistic ack temporarily zeroed mentions.
          return state;
        }
      }
      return {
        ...state,
        readStateByChannel: {
          ...state.readStateByChannel,
          [action.readState.channelId]: action.readState,
        },
      };
    }
    case 'MENTION_INCREMENT': {
      // Bump mention_count for a channel; preserves lastMessageId. If no
      // row exists yet, create one with lastMessageId=null and count=1
      // (matches the server's INSERT path in services/messages.ts).
      const existing = state.readStateByChannel[action.channelId];
      const next: ReadState = existing
        ? { ...existing, mentionCount: existing.mentionCount + 1 }
        : { channelId: action.channelId, lastMessageId: null, mentionCount: 1 };
      return {
        ...state,
        readStateByChannel: {
          ...state.readStateByChannel,
          [action.channelId]: next,
        },
      };
    }
    case 'VOICE_STATES_SET': {
      // READY-frame hydration: replace the entire map. Each row's userId
      // is the key — one voice state per user.
      const map: Record<string, VoiceState> = {};
      for (const v of action.voiceStates) {
        if (v.channelId !== null) map[v.userId] = v;
      }
      return { ...state, voiceStatesByUser: map };
    }
    case 'VOICE_STATE_UPSERT': {
      // VOICE_STATE_UPDATE — channelId=null means the user left voice
      // entirely; remove them from the map. Otherwise upsert.
      const next = { ...state.voiceStatesByUser };
      if (action.voiceState.channelId === null) {
        delete next[action.voiceState.userId];
      } else {
        next[action.voiceState.userId] = action.voiceState;
      }
      return { ...state, voiceStatesByUser: next };
    }
    case 'VOICE_STATES_MERGE_CHANNEL': {
      // Authoritative snapshot for one channel — used after the
      // joiner's REST joinVoice returns to ensure their local map
      // matches reality for that channel. We do NOT touch entries
      // for OTHER channels (other DMs, other guild voice rooms);
      // only the named channel is rebuilt from the snapshot.
      const next = { ...state.voiceStatesByUser };
      // Remove existing entries that were in this channel but aren't
      // in the snapshot — they left while we weren't paying attention.
      const snapshotUserIds = new Set<string>();
      for (const v of action.voiceStates) snapshotUserIds.add(v.userId);
      for (const [userId, v] of Object.entries(next)) {
        if (v.channelId === action.channelId && !snapshotUserIds.has(userId)) {
          delete next[userId];
        }
      }
      // Upsert every entry from the snapshot.
      for (const v of action.voiceStates) {
        next[v.userId] = v;
      }
      return { ...state, voiceStatesByUser: next };
    }
    case 'CHANNEL_PINS_BUMP': {
      // CHANNEL_PINS_UPDATE — bump the timestamp so panels watching
      // this channel re-fetch the pin list. We don't store pinned
      // messages in app state; the panel owns its own list and re-runs
      // listPinnedMessages on every bump.
      return {
        ...state,
        channelPinUpdateAt: {
          ...state.channelPinUpdateAt,
          [action.channelId]: Date.now(),
        },
      };
    }
    case 'NOTIF_OVERRIDES_SET': {
      const map: Record<string, 'all' | 'mentions' | 'nothing'> = {};
      for (const o of action.overrides) {
        map[`${o.targetType}:${o.targetId}`] = o.level;
      }
      return { ...state, notificationOverrides: map, loadedNotificationOverrides: true };
    }
    case 'NOTIF_OVERRIDE_SET': {
      const key = `${action.targetType}:${action.targetId}`;
      const next = { ...state.notificationOverrides };
      if (action.level === null) delete next[key];
      else next[key] = action.level;
      return { ...state, notificationOverrides: next };
    }
    case 'DM_NICKNAMES_SET': {
      return { ...state, dmNicknames: action.nicknames };
    }
    case 'DM_NICKNAME_SET': {
      const next = { ...state.dmNicknames };
      if (action.nickname) next[action.userId] = action.nickname;
      else delete next[action.userId];
      return { ...state, dmNicknames: next };
    }
    case 'RELATIONSHIPS_SET': {
      return { ...state, relationships: action.relationships, loadedRelationships: true };
    }
    case 'SUPERVISION_SET': {
      return { ...state, supervision: action.supervision };
    }
    case 'FAMILY_NUDGE': {
      return { ...state, familyNudge: state.familyNudge + 1 };
    }
    case 'RELATIONSHIP_UPSERT': {
      // Replace any existing row for the same target user, otherwise
      // append. We dedupe by user id since a relationship is uniquely
      // identified by the (self, target) pair.
      const id = action.relationship.user.id;
      const next = state.relationships.filter((r) => r.user.id !== id);
      next.unshift(action.relationship);
      return { ...state, relationships: next };
    }
    case 'RELATIONSHIP_REMOVE': {
      return {
        ...state,
        relationships: state.relationships.filter((r) => r.user.id !== action.userId),
      };
    }
    case 'EMOJIS_SET': {
      // Replace the whole list for this guild — the gateway broadcasts
      // the post-mutation truth, and the initial-load path also delivers
      // the full list, so there's never a need to merge/diff here.
      return {
        ...state,
        emojisByGuild: { ...state.emojisByGuild, [action.guildId]: action.emojis },
      };
    }
    case 'STICKERS_SET': {
      // Same lifecycle as EMOJIS_SET — bulk replace, no merging.
      return {
        ...state,
        stickersByGuild: { ...state.stickersByGuild, [action.guildId]: action.stickers },
      };
    }
    case 'STAGE_PARTICIPANTS_SET': {
      // Bulk-replace per channel. Stage joins/leaves/promotions all
      // come through this reducer; the gateway broadcasts the full
      // post-mutation list so we don't merge.
      return {
        ...state,
        stageParticipantsByChannel: {
          ...state.stageParticipantsByChannel,
          [action.channelId]: action.participants,
        },
      };
    }
    case 'ROLES_SET': {
      // Replace the whole list — same pattern as EMOJIS_SET. Roles
      // change rarely; the role-edit UI dispatches this after each
      // save, and any initial-load path delivers the full list.
      return {
        ...state,
        rolesByGuild: { ...state.rolesByGuild, [action.guildId]: action.roles },
      };
    }
    case 'ROLE_UPSERT': {
      // Live patch of a single role (color/name/permission edit) from
      // GUILD_ROLE_UPDATE. Member name colors + role pills read
      // state.rolesByGuild, which was otherwise only ever written by a full
      // REST loadRoles — so a role recolor stayed stale until a guild-settings
      // open or a reload (reconnect didn't even heal it).
      const existing = state.rolesByGuild[action.guildId];
      // Do NOT create a fresh guild entry from a single-role event: a
      // 1-element list would satisfy the mount-time `if (guildRoles) return`
      // load guard and suppress the full fetch, leaving every OTHER role's
      // color unknown. Only patch a guild whose role list is already loaded.
      if (!existing) return state;
      const idx = existing.findIndex((r) => r.id === action.role.id);
      const next =
        idx >= 0
          ? existing.map((r) => (r.id === action.role.id ? action.role : r))
          : [...existing, action.role];
      return {
        ...state,
        rolesByGuild: { ...state.rolesByGuild, [action.guildId]: next },
      };
    }
    case 'EVENTS_SET': {
      // Full replace after a list fetch. Same shape as ROLES_SET.
      return {
        ...state,
        eventsByGuild: { ...state.eventsByGuild, [action.guildId]: action.events },
        eventChangeCounter: state.eventChangeCounter + 1,
      };
    }
    case 'EVENT_UPSERT': {
      // Insert-or-merge. When the guild's entry doesn't exist yet
      // we don't pre-populate from a broadcast — the user hasn't
      // opened the events surface, so caching here would just hold
      // memory for views nobody is observing. The next EventsModal
      // mount will load the full list.
      //
      // BUT: we still bump eventChangeCounter even in the
      // no-entry-yet path so cross-guild observers (MyEventsModal)
      // pick up the signal. They don't depend on eventsByGuild;
      // they care that *some* event somewhere changed.
      const existing = state.eventsByGuild[action.guildId];
      if (!existing) {
        return { ...state, eventChangeCounter: state.eventChangeCounter + 1 };
      }
      const idx = existing.findIndex((e) => e.id === action.event.id);
      const incoming = action.event;
      // Preserve per-recipient fields when the payload omits them
      // (broadcast deltas do). REST mutation responses include
      // them and overwrite as expected.
      const merged: ScheduledEvent =
        idx >= 0
          ? {
              ...existing[idx],
              ...incoming,
              rsvpCounts: incoming.rsvpCounts ?? existing[idx].rsvpCounts,
              myRsvp: incoming.myRsvp !== undefined ? incoming.myRsvp : existing[idx].myRsvp,
            }
          : incoming;
      const next =
        idx >= 0
          ? [...existing.slice(0, idx), merged, ...existing.slice(idx + 1)]
          : [...existing, merged].sort((a, b) => a.startAt.localeCompare(b.startAt));
      return {
        ...state,
        eventsByGuild: { ...state.eventsByGuild, [action.guildId]: next },
        eventChangeCounter: state.eventChangeCounter + 1,
      };
    }
    case 'EVENT_REMOVE': {
      const existing = state.eventsByGuild[action.guildId];
      // Even when we have no local entry, bump the counter — cross-
      // guild observers (MyEventsModal) need the signal regardless
      // of whether THIS reducer's eventsByGuild slot changed.
      if (!existing) {
        return { ...state, eventChangeCounter: state.eventChangeCounter + 1 };
      }
      const filtered = existing.filter((e) => e.id !== action.eventId);
      // Avoid pointless object churn if nothing matched. But still
      // bump the counter — broadcast received means cross-guild
      // observers should refetch.
      if (filtered.length === existing.length) {
        return { ...state, eventChangeCounter: state.eventChangeCounter + 1 };
      }
      return {
        ...state,
        eventsByGuild: { ...state.eventsByGuild, [action.guildId]: filtered },
        eventChangeCounter: state.eventChangeCounter + 1,
      };
    }
    case 'EVENT_RSVP_PATCH': {
      const existing = state.eventsByGuild[action.guildId];
      if (!existing) return state;
      const idx = existing.findIndex((e) => e.id === action.eventId);
      if (idx < 0) return state;
      const updated: ScheduledEvent = {
        ...existing[idx],
        myRsvp: action.myRsvp,
        rsvpCounts: action.rsvpCounts,
      };
      return {
        ...state,
        eventsByGuild: {
          ...state.eventsByGuild,
          [action.guildId]: [
            ...existing.slice(0, idx),
            updated,
            ...existing.slice(idx + 1),
          ],
        },
      };
    }
    case 'SAVED_HYDRATE': {
      // Add ALL ids in the action to the set (i.e. these ids are
      // confirmed saved). Doesn't remove anything — a non-empty set
      // before this action implies some optimistic state from
      // toggle, and the hydrate is intersecting with server truth
      // for the queried subset only.
      if (action.messageIds.length === 0) return state;
      const next = new Set(state.savedMessageIds);
      for (const id of action.messageIds) next.add(id);
      return { ...state, savedMessageIds: next };
    }
    case 'SAVED_TOGGLE': {
      const cur = state.savedMessageIds;
      // Bail when no-op — keeps reducer dispatch cheap and avoids
      // re-rendering subscribed components for nothing.
      const has = cur.has(action.messageId);
      if (action.saved && has) return state;
      if (!action.saved && !has) return state;
      const next = new Set(cur);
      if (action.saved) next.add(action.messageId);
      else next.delete(action.messageId);
      return { ...state, savedMessageIds: next };
    }
  }
}

// ── Context ────────────────────────────────────────────────────────────────

interface AppStateValue {
  state: State;
  /** Load the user's guild list from REST. Idempotent. */
  refreshGuilds: () => Promise<void>;
  /** Load a guild's channels into state. Idempotent. */
  loadChannels: (guildId: string) => Promise<void>;
  /**
   * Resolve the REST client for a guild or channel. There's a single backbone
   * client, so these return it directly; kept as async accessors so call sites
   * that `await restForGuild(id)` stay unchanged.
   */
  restForGuild: (guildId: string) => Promise<RestClient>;
  restForChannel: (channelId: string) => Promise<RestClient>;
  /**
   * Apply a drag-reorder result locally. Caller should fire AFTER
   * the REST request to PATCH /guilds/:id/channels/positions has
   * succeeded — at that point the server has accepted the diff and
   * will emit gateway CHANNEL_UPDATE events for each row, but those
   * events take a few hundred ms to arrive in practice and the
   * user expects the rail to snap immediately on drop.
   */
  applyChannelReorder: (
    guildId: string,
    changes: Array<{ id: string; position: number; parentId?: string | null }>,
  ) => void;
  /** Load (or reload) the recent messages of a channel. */
  loadMessages: (channelId: string) => Promise<void>;
  /**
   * Load a window of messages centered on a specific message id. Used
   * by message-link jumping — a click on a `/channels/G/C/M` link
   * needs context loaded around M before scroll-to-message can find
   * it in the DOM. Replaces the channel's current message list with
   * the fetched window (≈ 50 messages straddling M).
   *
   * Idempotent on the same id: if the window we'd fetch contains the
   * id we're already displaying, this becomes a no-op. Returns
   * whether the message was found in the loaded window.
   */
  loadMessagesAround: (channelId: string, messageId: string) => Promise<{ found: boolean }>;
  /** Append any messages newer than what we hold for an already-loaded
      channel (web analog of the native open-channel self-heal). */
  reconcileChannel: (channelId: string) => Promise<void>;
  /** Bulletproof latest-window catch-up for the open channel (merges, never
      resets scroll) — the return-from-background floor the after-cursor
      reconcile can miss. */
  refreshChannelLatest: (channelId: string) => Promise<void>;
  /**
   * Load the page of messages immediately older than what's currently
   * in state. Returns the number of messages added (0 = no new
   * results, exhausted). Idempotent if a load is already in flight.
   */
  loadOlderMessages: (channelId: string) => Promise<{ added: number }>;
  /** Load a guild's member list. Idempotent. */
  loadMembers: (guildId: string) => Promise<void>;
  /**
   * Load a guild's roles list. Idempotent — safe to call repeatedly;
   * the latest payload replaces the cached list. Used by member-list
   * + message rendering to compute display colors, and by permission
   * checks that need full role data.
   */
  loadRoles: (guildId: string) => Promise<Role[]>;
  /**
   * Load a guild's scheduled events (excluding completed/canceled
   * by default). Used by the EventsModal mount. Idempotent — the
   * REST roundtrip is cheap relative to the modal-open latency.
   * Returns the events array as a convenience so the caller can
   * avoid a re-read of state for the initial render.
   */
  loadGuildEvents: (guildId: string) => Promise<ScheduledEvent[]>;
  /** Load the user's DM channel list. Idempotent. */
  loadDMs: () => Promise<void>;
  /** Load the user's read-state set from REST. */
  loadReadStates: () => Promise<void>;
  /** Acknowledge a message — fires REST and updates state optimistically. */
  ackChannel: (channelId: string, messageId: string) => Promise<void>;
  /**
   * Drop the poke pill on a DM row. Called when the conversation is opened,
   * which `ackChannel` cannot cover: a poke creates no message, so a DM with
   * nothing unread is never acked and the pill would sit there for good.
   */
  clearPokePill: (channelId: string) => void;
  /**
   * Send a message with optimistic insertion. The bubble appears
   * immediately as a `pending` placeholder; on REST success it's
   * replaced by the real server-issued row. On failure it's marked
   * `failed` for the retry affordance to pick up. Returns a Promise
   * that resolves to the placeholder's local id (useful for UIs that
   * want to track in-flight sends across re-renders).
   */
  sendMessageOptimistic: (
    channelId: string,
    input: {
      content: string;
      replyToId?: string | null;
      files?: File[];
      poll?: {
        question: string;
        options: string[];
        multipleChoice?: boolean;
        durationHours: number;
      };
      /** When set, this message is a forward of the source. */
      forwardFromMessageId?: string;
      /** When set, this message attaches the referenced sticker. */
      stickerId?: string;
      /** When set, the FIRST file is treated as a voice message. */
      voiceMessage?: { durationSeconds: number; waveform: string };
      /** When set, attachments are encrypted with this DM's shared key
          before upload (the optimistic preview still uses the plaintext
          originals). The caller must have already confirmed the local key
          exists. */
      encryptAttachmentsForDm?: string;
    },
  ) => Promise<string>;
  /** Retry a previously-failed optimistic send. */
  retrySendMessage: (channelId: string, localId: string) => Promise<void>;
  /** Discard a failed optimistic placeholder without retrying. */
  discardFailedMessage: (channelId: string, localId: string) => void;
  /** Load all notification overrides for the current user. */
  loadNotificationOverrides: () => Promise<void>;
  /**
   * Set or clear an override. Pass `null` to clear (return to default).
   * Optimistically updates local state, then fires REST. On failure the
   * UI surfaces a toast; the optimistic mutation stays put because
   * fixing it would require remembering the previous value across the
   * async call — the user can just toggle again.
   */
  setNotificationOverride: (
    targetType: 'guild' | 'channel',
    targetId: string,
    level: 'all' | 'mentions' | 'nothing' | null,
  ) => Promise<void>;
  /** Hydrate the relationships list from REST. Idempotent. */
  loadRelationships: () => Promise<void>;
  /** Re-fetch the current user's personal DM-nickname map. */
  loadDmNicknames: () => Promise<void>;
  /** Set (non-empty) or clear (null) the personal DM nickname for a user.
      Optimistic + fires the REST mutation; reverts on failure. */
  setDmNickname: (userId: string, nickname: string | null) => Promise<void>;
  /** Re-fetch the current user's parental-controls summary. Call after
      a linking mutation so the banner / Family settings reflect it. */
  reloadSupervision: () => Promise<void>;
  /**
   * Apply a relationship change locally (optimistic). Pass `null` to
   * remove. Doesn't fire REST — caller wires the REST call separately
   * because the action varies (sendFriendRequest vs accept vs block).
   */
  applyRelationship: (
    user: PublicUser,
    type: 'friend' | 'incoming_request' | 'outgoing_request' | 'blocked' | null,
  ) => void;
  /**
   * Replace a single user in the cache (state.usersById + propagation
   * into membersByGuild). Use after a self-mutation (avatar upload,
   * profile edit) so caches stay in sync without waiting for the
   * gateway USER_UPDATE round-trip.
   */
  replaceUser: (user: PublicUser) => void;
  /**
   * Merge an authoritative snapshot of one channel's voice states
   * into local state. Used after rest.joinVoice returns to make
   * sure the joining client has the complete current participant
   * list for that channel, defending against missed earlier
   * gateway events.
   */
  mergeChannelVoiceStates: (channelId: string, voiceStates: VoiceState[]) => void;
  /**
   * Toggle the saved state of a message. Optimistic — flips the
   * local set immediately, then fires REST. On REST failure, the
   * UI toasts and the optimistic flip is reverted by re-calling
   * toggleSavedMessage with the previous value.
   */
  toggleSavedMessage: (messageId: string) => Promise<void>;
  /**
   * Bulk-check which of the given message ids the caller has saved
   * and merge them into state.savedMessageIds. Called once per
   * channel load so the bookmark icon renders correctly for
   * already-saved messages.
   */
  hydrateSavedMembership: (messageIds: string[]) => Promise<void>;
  /** Persist the voter's optimistic poll snapshot (tallies + own myVotes)
   *  into the canonical message — gateway poll broadcasts carry no
   *  per-recipient vote state. */
  setPollLocal: (channelId: string, messageId: string, poll: Poll) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

// Family notifications (flags, approval requests) are dispatched per-user
// and fan out to EVERY active connection for that account — multiple tabs
// or devices, plus any momentary reconnect overlap. Message events are
// deduped by id in the reducer, but one-shot toasts/notifications have no
// such guard, so the same alert could surface several times. This keeps a
// short content-keyed memory so a repeated alert within the window shows
// exactly once.
const recentFamilyNotifs = new Map<string, number>();
function familyNotifyOnce(key: string, windowMs = 6000): boolean {
  const now = Date.now();
  for (const [k, exp] of recentFamilyNotifs) {
    if (exp < now) recentFamilyNotifs.delete(k);
  }
  if (recentFamilyNotifs.has(key)) return false;
  recentFamilyNotifs.set(key, now + windowMs);
  return true;
}

/**
 * Close any delivered OS notifications for a channel when the user reads it,
 * so Notification Center / the lock screen don't keep showing banners for a
 * conversation that's already open. Mirrors the iOS clearDeliveredNotifications
 * path. Message pushes tag their notification with the channelId AND carry
 * channelId in `data` (see public/sw.js), so we match on either — the `data`
 * match also catches pokes, whose tag is `poke-<channelId>`. Best-effort:
 * silently no-ops where the service worker or getNotifications() is
 * unavailable.
 */
function clearChannelNotifications(channelId: string): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.getNotifications())
    .then((notes) => {
      for (const n of notes) {
        const dataChannel =
          n.data && typeof n.data === 'object'
            ? (n.data as { channelId?: string }).channelId
            : undefined;
        if (n.tag === channelId || dataChannel === channelId) n.close();
      }
    })
    .catch(() => {
      /* getNotifications unsupported or SW not ready — ignore */
    });
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { rest, gateway, token, user } = useAuth();
  const toasts = useToasts();
  const [state, dispatch] = useReducer(reducer, initialState);

  // Wipe all cached state when the signed-in identity changes.
  //
  // This provider stays MOUNTED across sign-out (only the routed children swap),
  // so without this the reducer kept the previous account's guilds, channels,
  // messages, member lists and read states. Sign out, sign in as someone else,
  // and you were looking at the last user's data until each slice happened to be
  // refetched — a cross-account leak on any shared machine.
  //
  // Keyed on user id, not on a logout callback, so it also covers the
  // switch-account path (A -> B with no intervening null) and a token swap.
  // The ref keeps the very first identity from firing a pointless reset.
  const lastIdentityRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const identity = user?.id ?? null;
    if (lastIdentityRef.current === undefined) {
      lastIdentityRef.current = identity;
      return;
    }
    if (lastIdentityRef.current === identity) return;
    lastIdentityRef.current = identity;
    dispatch({ type: 'RESET' });
  }, [user?.id]);
  // Mirror state into a ref so async callbacks can guard against re-
  // entrancy without the closure pinning a stale value. React doesn't
  // expose a "read latest state" primitive synchronously inside a
  // useCallback that doesn't depend on state; this ref is the
  // canonical workaround.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Tracks whether the gateway has delivered its first READY for the
  // current auth session. Used by the READY handler below to distinguish
  // "initial connect (bootstrap effect already running)" from "reconnect
  // (need to refetch state we may have missed events for)". Reset to false
  // only on a genuine login → logout identity flip (a dedicated effect keyed
  // on user?.id), NOT on token refresh or self-user churn, so a logout → login
  // cycle gets a fresh first-READY semantic while a mid-session token rotation
  // keeps the reconnect-resync behavior.
  const readyOnceRef = useRef(false);

  // ── REST loaders ──────────────────────────────────────────────────────

  const refreshGuilds = useCallback(async () => {
    const r = await rest.listGuilds();
    dispatch({ type: 'GUILDS_SET', guilds: r.guilds });
  }, [rest]);

  // All guilds are local; these resolve to the one backbone REST client.
  // Kept as async (guildId) shims so existing call sites stay unchanged.
  const restForGuild = useCallback(
    async (_guildId: string): Promise<RestClient> => rest,
    [rest],
  );

  const restForChannel = useCallback(
    async (_channelId: string): Promise<RestClient> => rest,
    [rest],
  );

  const loadChannels = useCallback(
    async (guildId: string) => {
      const api = await restForGuild(guildId);
      const r = await api.listGuildChannels(guildId);
      dispatch({ type: 'CHANNELS_SET', guildId, channels: r.channels });
      // Hydrate emoji index for this guild on first channel-load. Soft
      // failure: a 403 here means the user isn't actually a member
      // (race during permission revocation), and rendering :name:
      // tokens as plain text is a graceful degradation. Other
      // failures we just swallow — no user-facing toast since the
      // emoji feature is supplementary, not critical-path.
      void api
        .listGuildEmojis(guildId)
        .then((er) => {
          dispatch({ type: 'EMOJIS_SET', guildId, emojis: er.emojis });
        })
        .catch(() => undefined);
      // Same lifecycle for stickers — hydrate on first channel-load
      // for the guild, soft-failure on permission errors.
      void api
        .listGuildStickers(guildId)
        .then((sr) => {
          dispatch({ type: 'STICKERS_SET', guildId, stickers: sr.stickers });
        })
        .catch(() => undefined);
    },
    [restForGuild],
  );

  /**
   * Apply a drag-reorder result locally without waiting for the
   * gateway round-trip. Called from ChannelList's onReorder handler
   * AFTER the REST request succeeds, so we know the server accepted
   * the changes. Each change patches an existing channel's position
   * (and optionally parentId) in place; the render layer sorts by
   * position so the rail re-orders on the next render.
   *
   * Why optimistic-after-REST instead of optimistic-before:
   *   - Before: we'd need to roll back if the server rejected the
   *     diff (e.g. permission revoked mid-drag); roll-back paths
   *     compound state-management complexity for an edge case.
   *   - After: we already know the server accepted; we just want to
   *     skip the wait for CHANNEL_UPDATE events to reach the gateway
   *     and reducer. The UI snaps immediately to the new order.
   *
   * The eventual CHANNEL_UPDATE events are still received and re-
   * apply the same data — idempotent, no flicker because the
   * positions already match.
   */
  const applyChannelReorder = useCallback(
    (guildId: string, changes: Array<{ id: string; position: number; parentId?: string | null }>) => {
      // Pull the current list, patch each changed entry, re-dispatch.
      // We can't dispatch one CHANNEL_UPSERT per change because the
      // reducer keys on the channel object itself — we need each
      // patched object to be a Channel with full fields. Simpler to
      // iterate and merge.
      dispatch({ type: 'CHANNEL_REORDER', guildId, changes });
    },
    [],
  );

  // Persist a locally-computed poll snapshot (the voter's optimistic
  // tallies + their own myVotes) into the canonical message. Gateway
  // poll broadcasts carry no per-recipient vote state, so without this
  // the next MESSAGE_UPDATE resync would wipe the user's selection.
  const setPollLocal = useCallback((channelId: string, messageId: string, poll: Poll) => {
    dispatch({ type: 'POLL_LOCAL_REPLACE', channelId, messageId, poll });
  }, []);

  const loadMessages = useCallback(
    async (channelId: string) => {
      const api = await restForChannel(channelId);
      const r = await api.listMessages(channelId, { limit: 50 });
      // REST returns newest-first; reverse for chronological render.
      const ordered = [...r.messages].reverse();
      dispatch({ type: 'MESSAGES_SET', channelId, messages: ordered });
      // Hydrate the saved-message set for these ids so the bookmark
      // icon renders correctly. Fire-and-forget — purely decorative
      // and fine to land a beat after the message bodies. Saved messages
      // are a backbone concept, so this stays on the backbone `rest`
      // (node message ids simply won't match — harmless).
      const ids = ordered.map((m) => m.id).filter((id) => !id.startsWith('local-'));
      if (ids.length > 0) {
        void rest
          .savedMembership(ids)
          .then((sr) => {
            if (sr.savedIds.length > 0) {
              dispatch({ type: 'SAVED_HYDRATE', messageIds: sr.savedIds });
            }
          })
          .catch(() => undefined);
      }
    },
    [rest, restForChannel],
  );

  const loadMessagesAround = useCallback(
    async (channelId: string, messageId: string): Promise<{ found: boolean }> => {
      // Cheap reuse: if the message is already in the current list,
      // skip the round trip. The scroll-to handler picks it up from
      // the existing DOM.
      const existing = stateRef.current.messagesByChannel[channelId];
      if (existing?.some((m) => m.id === messageId)) {
        return { found: true };
      }
      const r = await (await restForChannel(channelId)).listMessages(channelId, {
        around: messageId,
        limit: 50,
      });
      // `around` returns chronological order from the server (oldest
      // first) — no reverse needed. We REPLACE the current window
      // because mixing two disjoint windows would create gaps that
      // the scroll-up paginator can't bridge.
      // A jump lands on an arbitrary older window — replace, don't union the
      // newest tail on (that would leave a gap between the two windows).
      dispatch({
        type: 'MESSAGES_SET',
        channelId,
        messages: r.messages,
        preserveNewerSurvivors: false,
      });
      const found = r.messages.some((m) => m.id === messageId);
      return { found };
    },
    [rest, restForChannel],
  );

  /**
   * Reconcile an ALREADY-loaded channel against the server: fetch anything
   * newer than the newest message we hold and append it. This is the web
   * analog of the native openChannel self-heal — the open effect only calls
   * loadMessages when a channel is first opened (loadedChannels guard), so a
   * DM the user opened earlier in the session can go stale if a live
   * MESSAGE_CREATE was ever missed (tab/laptop asleep, a silent socket drop, a
   * resume-buffer gap). Without this, re-opening that DM shows the old list
   * until a full page refresh — exactly the reported bug.
   *
   * Append-only via the `after` cursor: never replaces the array, so loaded
   * older history and scroll position survive. MESSAGE_APPEND dedups by id, so
   * a no-gap channel is a cheap no-op fetch. The GET also stamps viewed_at +
   * fires MESSAGE_VIEWED server-side, so opening a DM marks it read promptly.
   */
  const reconcileChannel = useCallback(
    async (channelId: string) => {
      const existing = stateRef.current.messagesByChannel[channelId];
      if (!existing || existing.length === 0) {
        // Nothing loaded yet → a normal first load is correct.
        await loadMessages(channelId);
        return;
      }
      // Newest message with a real (server snowflake) id — skip optimistic
      // `local-` placeholders, which the server cursor wouldn't understand.
      let after: string | undefined;
      for (let i = existing.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(existing[i]!.id)) {
          after = existing[i]!.id;
          break;
        }
      }
      if (!after) {
        await loadMessages(channelId);
        return;
      }
      const r = await (await restForChannel(channelId)).listMessages(channelId, {
        after,
        limit: 50,
      });
      // REST returns newest-first; append oldest-first so order is preserved.
      for (const m of [...r.messages].reverse()) {
        dispatch({ type: 'MESSAGE_APPEND', channelId, message: m });
      }
    },
    [loadMessages, restForChannel],
  );

  /**
   * BULLETPROOF catch-up for the OPEN conversation. Fetches the LATEST window
   * (no `after` cursor — exactly what re-opening the channel does, the one
   * recovery that always works) and MERGES it via MESSAGE_APPEND, which dedups
   * by id, so it never clobbers loaded history or resets scroll. The after-
   * cursor `reconcileChannel` above can still miss on a return-from-background
   * (a stale/failed cursor fetch, a fetch racing the socket coming back); the
   * plain latest fetch shares none of those failure modes, so a message that
   * slipped through every live path appears the instant the tab regains focus
   * or visibility — no page reload needed.
   */
  const refreshChannelLatest = useCallback(
    async (channelId: string) => {
      const existing = stateRef.current.messagesByChannel[channelId];
      if (!existing || existing.length === 0) {
        await loadMessages(channelId);
        return;
      }
      const r = await (await restForChannel(channelId)).listMessages(channelId, { limit: 50 });
      for (const m of [...r.messages].reverse()) {
        dispatch({ type: 'MESSAGE_APPEND', channelId, message: m });
      }
    },
    [loadMessages, restForChannel],
  );

  /**
   * Full open-window RESYNC for an already-loaded channel. This is the
   * MUTATION twin of refreshChannelLatest above, not a replacement for it:
   * both fetch the tail, but refreshChannelLatest merges via MESSAGE_APPEND
   * (dedups by id, so it can only ADD messages it doesn't have) while this
   * REPLACES the loaded window, healing mutations that landed on rows the
   * client ALREADY holds — edits, deletes, reactions, and read-receipts.
   *
   * That's precisely what the reconnect resync needs and what neither
   * refreshChannelLatest nor the append-only reconcileChannel can do: a fresh
   * IDENTIFY (RESUME failed) replays no MESSAGE_UPDATE / MESSAGE_DELETE /
   * REACTION / *_VIEWED for the outage, so an append-merge returning zero new
   * messages still leaves the open DM showing stale text / stuck 'Delivered' /
   * wrong reaction counts / the ghost of a deleted message until a hard
   * refresh. The two compose safely if both run (a reconnect that coincides
   * with the tab regaining visibility): whichever lands last converges on the
   * same server tail, since APPEND dedups and REPLACE takes server truth.
   *
   * Anchors the `around=<id>` window on the newest real (server snowflake) id
   * so the refetched window is the same tail the user is viewing — which also
   * means MESSAGES_SET's default `preserveNewerSurvivors` is the behavior we
   * want here (unlike loadMessagesAround's jump to an older window, which
   * opts out): any REAL row newer than the fetched tail that landed during the
   * round trip is unioned back by the reducer, so we don't re-implement that.
   * What the reducer deliberately does NOT keep is optimistic `local-`
   * placeholders, so we carry those forward explicitly: a send whose REST 201
   * hasn't landed would otherwise vanish from the list mid-flight (and lose the
   * nonce row its echo reconciles against). Re-reads the live list after the
   * await so a placeholder created during the round trip is included. No-op
   * when nothing is loaded (a normal first open handles that) or only
   * optimistic rows exist.
   */
  const resyncChannelWindow = useCallback(
    async (channelId: string) => {
      const existing = stateRef.current.messagesByChannel[channelId];
      if (!existing || existing.length === 0) return;
      // Newest real id anchors the window; skip optimistic `local-` rows the
      // server cursor wouldn't understand.
      let anchor: string | undefined;
      for (let i = existing.length - 1; i >= 0; i--) {
        if (/^\d+$/.test(existing[i]!.id)) {
          anchor = existing[i]!.id;
          break;
        }
      }
      if (!anchor) return; // only optimistic rows — nothing server-side to heal
      const r = await (await restForChannel(channelId)).listMessages(channelId, {
        around: anchor,
        limit: 50,
      });
      // `around` returns chronological order (oldest-first) — no reverse.
      // Re-read the LIVE list (a send/echo may have landed during the await)
      // and carry forward any optimistic placeholders the server window can't
      // contain, appended after the tail so chronological order holds.
      const live = stateRef.current.messagesByChannel[channelId] ?? existing;
      const serverIds = new Set(r.messages.map((m) => m.id));
      const pending = live.filter((m) => m.id.startsWith('local-') && !serverIds.has(m.id));
      const merged = pending.length > 0 ? [...r.messages, ...pending] : r.messages;
      dispatch({ type: 'MESSAGES_SET', channelId, messages: merged });
    },
    [restForChannel],
  );

  /**
   * Load older messages for the given channel — called from the
   * Scroller when the user scrolls near the top. We use the oldest
   * locally-known message id as the `before` cursor. The server
   * returns up to `limit` messages older than that id. If fewer than
   * the page size came back, the channel head has been reached and
   * we mark the channel olderExhausted so future scroll-ups short-
   * circuit.
   *
   * Re-entrancy: we ignore calls for a channel that's already loading
   * older messages (loadingOlder set membership). This prevents a
   * scroll handler that fires multiple times in quick succession from
   * racing two requests.
   */
  const loadOlderMessages = useCallback(
    async (channelId: string): Promise<{ added: number }> => {
      // Guard against re-entry. Reading the latest state via a closure
      // is safe here because dispatch + state updates are synchronous
      // within React's batching window.
      if (stateRef.current.loadingOlder.has(channelId)) return { added: 0 };
      if (stateRef.current.olderExhausted.has(channelId)) return { added: 0 };
      const existing = stateRef.current.messagesByChannel[channelId];
      if (!existing || existing.length === 0) return { added: 0 };
      const oldestId = existing[0]!.id;

      dispatch({ type: 'LOADING_OLDER_BEGIN', channelId });
      try {
        const PAGE = 50;
        const r = await (await restForChannel(channelId)).listMessages(channelId, {
          before: oldestId,
          limit: PAGE,
        });
        // REST returns newest-first relative to the page; reverse so
        // the oldest of the returned set comes first when prepended.
        const ordered = [...r.messages].reverse();
        dispatch({
          type: 'MESSAGES_PREPEND',
          channelId,
          messages: ordered,
          reachedHead: r.messages.length < PAGE,
        });
        return { added: ordered.length };
      } finally {
        dispatch({ type: 'LOADING_OLDER_END', channelId });
      }
    },
    [restForChannel],
  );

  const loadMembers = useCallback(
    async (guildId: string) => {
      const r = await (await restForGuild(guildId)).listMembers(guildId, { limit: 200 });
      dispatch({ type: 'MEMBERS_SET', guildId, members: r.members });
    },
    [restForGuild],
  );

  const loadRoles = useCallback(
    async (guildId: string): Promise<Role[]> => {
      const r = await (await restForGuild(guildId)).listRoles(guildId);
      dispatch({ type: 'ROLES_SET', guildId, roles: r.roles });
      return r.roles;
    },
    [restForGuild],
  );

  const loadGuildEvents = useCallback(
    async (guildId: string): Promise<ScheduledEvent[]> => {
      // Default to upcoming + active only; admin UI can request the
      // full set including completed via its own call site if needed.
      const r = await rest.listGuildEvents(guildId, { includeArchived: false });
      dispatch({ type: 'EVENTS_SET', guildId, events: r.events });
      return r.events;
    },
    [rest],
  );

  const loadDMs = useCallback(async () => {
    const r = await rest.listDMs();
    dispatch({ type: 'DMS_SET', channels: r.channels });
  }, [rest]);

  const loadReadStates = useCallback(async () => {
    const r = await rest.listReadStates();
    dispatch({ type: 'READ_STATES_SET', readStates: r.readStates });
  }, [rest]);

  const loadNotificationOverrides = useCallback(async () => {
    const r = await rest.listNotificationOverrides();
    dispatch({ type: 'NOTIF_OVERRIDES_SET', overrides: r.overrides });
  }, [rest]);

  const loadRelationships = useCallback(async () => {
    const r = await rest.listRelationships();
    dispatch({ type: 'RELATIONSHIPS_SET', relationships: r.relationships });
  }, [rest]);

  const loadDmNicknames = useCallback(async () => {
    const r = await rest.getDmNicknames();
    dispatch({ type: 'DM_NICKNAMES_SET', nicknames: r.nicknames });
  }, [rest]);

  /**
   * Set (non-empty) or clear (null) a personal DM nickname for a user. Updates
   * local state optimistically then fires the REST mutation; reverts on failure.
   */
  const setDmNickname = useCallback(
    async (userId: string, nickname: string | null) => {
      const prev = stateRef.current.dmNicknames[userId] ?? null;
      dispatch({ type: 'DM_NICKNAME_SET', userId, nickname });
      try {
        if (nickname && nickname.trim()) await rest.setDmNickname(userId, nickname.trim());
        else await rest.clearDmNickname(userId);
      } catch (e) {
        dispatch({ type: 'DM_NICKNAME_SET', userId, nickname: prev });
        throw e;
      }
    },
    [rest],
  );

  const loadSupervision = useCallback(async () => {
    const r = await rest.familyMe();
    dispatch({ type: 'SUPERVISION_SET', supervision: r });
  }, [rest]);

  /**
   * Optimistically apply a relationship change to local state. Caller
   * is responsible for firing the REST mutation; we expose this so
   * UIs (ProfileCard, friend list) can update the global view as
   * they act, instead of waiting for the next loadRelationships()
   * round-trip. Pass `null` to remove a relationship row entirely.
   */
  const applyRelationship = useCallback(
    (
      user: PublicUser,
      type: 'friend' | 'incoming_request' | 'outgoing_request' | 'blocked' | null,
    ) => {
      if (type === null) {
        dispatch({ type: 'RELATIONSHIP_REMOVE', userId: user.id });
      } else {
        dispatch({
          type: 'RELATIONSHIP_UPSERT',
          relationship: { type, createdAt: new Date().toISOString(), user },
        });
      }
    },
    [],
  );

  const replaceUser = useCallback((u: PublicUser) => {
    dispatch({ type: 'USER_REPLACE', user: u });
  }, []);

  const mergeChannelVoiceStates = useCallback(
    (channelId: string, voiceStates: VoiceState[]) => {
      dispatch({ type: 'VOICE_STATES_MERGE_CHANNEL', channelId, voiceStates });
    },
    [],
  );

  /**
   * IN-CALL ROSTER RECONCILE — the missing safety net.
   *
   * The voice roster was EVENT-ONLY: built from VOICE_STATE_UPDATE frames plus
   * the snapshot in your own join response. Messages have three layers of
   * catch-up (3s poll, focus refetch, resume reconcile); voice states had ZERO.
   * So a single dropped frame left a participant permanently invisible while
   * their audio played — LiveKit is a separate transport with its own
   * reconnect, which is exactly why you can hear someone you cannot see.
   *
   * While connected to a voice channel this re-reads the authoritative roster
   * every 10s, and immediately on window focus and on regaining network. The
   * GET is side-effect free and the merge is idempotent, so a redundant call
   * costs one small query and changes nothing.
   *
   * 10s, not 3s: unlike messages (where staleness is read as "my message never
   * sent"), a roster row is low-stakes and this runs for the whole call.
   * Focus/online cover the case that actually bites — a desktop window that sat
   * unfocused while the gateway went quiet.
   */
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const reconcile = async (): Promise<void> => {
      try {
        // Dynamic import, matching the other voice touchpoints in this file —
        // a static one would create an AppState <-> voice cycle.
        const voiceMod = await import('../lib/voice');
        const channelId = voiceMod.getConnectedChannelId();
        if (!channelId || cancelled) return;
        const { voiceStates } = await rest.listVoiceStates(channelId);
        if (cancelled) return;
        // Re-check the channel: a leave/switch can land mid-flight, and
        // applying a stale channel's roster would resurrect ghosts.
        if (voiceMod.getConnectedChannelId() !== channelId) return;
        dispatch({ type: 'VOICE_STATES_MERGE_CHANNEL', channelId, voiceStates });
      } catch {
        // Best-effort: a failed reconcile leaves the event-driven state as-is.
      }
    };

    const id = window.setInterval(() => void reconcile(), 10_000);
    const onFocus = (): void => void reconcile();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
    };
  }, [token, rest]);

  /**
   * Toggle the saved state of a message. Optimistic dispatch first
   * (the bookmark icon flips immediately), then REST. On failure,
   * roll back the dispatch and toast.
   */
  const toggleSavedMessage = useCallback(
    async (messageId: string) => {
      const wasSaved = stateRef.current.savedMessageIds.has(messageId);
      const nextSaved = !wasSaved;
      dispatch({ type: 'SAVED_TOGGLE', messageId, saved: nextSaved });
      try {
        if (nextSaved) await rest.saveMessage(messageId);
        else await rest.unsaveMessage(messageId);
      } catch (e) {
        // Revert and surface the error. Idempotent so a retry from
        // the user works; we don't auto-retry to avoid spamming the
        // server on a flaky network.
        dispatch({ type: 'SAVED_TOGGLE', messageId, saved: wasSaved });
        toasts.push(
          e instanceof ApiError
            ? e.message
            : nextSaved
              ? 'Could not save message'
              : 'Could not remove bookmark',
          'error',
        );
      }
    },
    [rest, toasts],
  );

  /**
   * Bulk-fetch membership for a list of message ids and merge the
   * results into the saved set. Called on initial channel load so
   * the bookmark icon renders correctly for already-saved messages.
   * Silently degrades on error (saved icons just stay outlined
   * until the user re-renders); not worth toasting.
   */
  const hydrateSavedMembership = useCallback(
    async (messageIds: string[]) => {
      if (messageIds.length === 0) return;
      try {
        const r = await rest.savedMembership(messageIds);
        if (r.savedIds.length > 0) {
          dispatch({ type: 'SAVED_HYDRATE', messageIds: r.savedIds });
        }
      } catch {
        // best-effort; not worth surfacing
      }
    },
    [rest],
  );

  const setNotificationOverride = useCallback(
    async (
      targetType: 'guild' | 'channel',
      targetId: string,
      level: 'all' | 'mentions' | 'nothing' | null,
    ) => {
      // Optimistic local mutation so the toggle UI flips instantly.
      dispatch({ type: 'NOTIF_OVERRIDE_SET', targetType, targetId, level });
      await rest.setNotificationOverride(targetType, targetId, level);
    },
    [rest],
  );

  /**
   * Optimistically advance the local marker to messageId, then send the ack
   * to the server. The reducer's monotonic guard means an in-flight server
   * response that lands after a newer optimistic update won't roll us back.
   * On REST failure we DON'T revert — the next CHANNEL_ACK from the server
   * will reconcile if the marker actually didn't move, and surfacing a
   * "your read marker rolled back" toast would be more confusing than
   * useful.
   */
  const ackChannel = useCallback(
    async (channelId: string, messageId: string) => {
      // Reading a channel clears its delivered OS notifications from
      // Notification Center / the lock screen. Done before the snowflake
      // guard so it fires on every read, even if the marker id is somehow
      // an optimistic placeholder.
      clearChannelNotifications(channelId);
      // A poke is answered by looking at the conversation, same as a
      // notification.
      dispatch({ type: 'POKE_PILL_CLEAR', channelId });
      // Defensive: reject any non-snowflake id outright. Optimistic
      // local-prefixed ids would crash the bigint comparison in the
      // READ_STATE_UPSERT reducer, AND would 400 on the server's ack
      // route which validates as snowflake. The MessageView call site
      // also filters these out, but a second safety net here means
      // any future caller can't accidentally trigger the same bug.
      if (!/^\d+$/.test(messageId)) return;
      dispatch({
        type: 'READ_STATE_UPSERT',
        readState: { channelId, lastMessageId: messageId, mentionCount: 0 },
      });
      try {
        await (await restForChannel(channelId)).ack(channelId, messageId);
      } catch {
        // Silent — the gateway is the source of truth for read-state
        // reconciliation. Logging to console for the operator's benefit.
        // (No toast — acks happen frequently and silently in the
        // background; surfacing failures would be noisy.)
        // eslint-disable-next-line no-console
        console.warn('[ack] failed for channel', channelId);
      }
    },
    [restForChannel],
  );

  // ── Optimistic message sending ────────────────────────────────────────
  //
  // The user shouldn't wait 200ms for the server before seeing their own
  // message in the stream. We insert a placeholder bubble immediately
  // with a temp id, then either replace it with the server-issued row
  // on success or mark it failed on error. Files are kept on a parallel
  // map keyed by localId so retries don't need to re-prompt the user
  // for the same upload.

  const pendingFilesRef = useRef<Map<string, File[]>>(new Map());
  const pendingInputsRef = useRef<
    Map<string, { content: string; replyToId: string | null; channelId: string }>
  >(new Map());

  const sendMessageOptimistic = useCallback(
    async (
      channelId: string,
      input: {
        content: string;
        replyToId?: string | null;
        files?: File[];
        /** Optional poll to attach. Polls aren't optimistically rendered;
            the bubble shows just the (possibly empty) text content
            until the server response arrives with the real poll DTO. */
        poll?: {
          question: string;
          options: string[];
          multipleChoice?: boolean;
          durationHours: number;
        };
        /** When set, the message is a forward of the source. The
            optimistic placeholder doesn't render the source snapshot
            — it shows up when the real DTO replaces the placeholder. */
        forwardFromMessageId?: string;
        /** When set, this message attaches the referenced sticker. */
        stickerId?: string;
        /** When set, the FIRST file is treated as a voice message. */
        voiceMessage?: { durationSeconds: number; waveform: string };
        /** When set, attachments are encrypted with this DM's shared key
            before upload (the optimistic preview still uses the plaintext
            originals). The caller must have already confirmed the local
            key exists. */
        encryptAttachmentsForDm?: string;
      },
    ): Promise<string> => {
      // Build a temp id distinct from any server-issued snowflake (those
      // are pure digits). The `local-` prefix collides with nothing and
      // is unsigned-int-incompatible so it never accidentally matches.
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const files = input.files ?? [];
      pendingInputsRef.current.set(localId, {
        content: input.content,
        replyToId: input.replyToId ?? null,
        channelId,
      });

      // Insert placeholder. We synthesize an Attachment[] with object-URL
      // previews so images render before the real upload completes.
      const placeholderAttachments = files.map((f, i) => ({
        id: `${localId}-att-${i}`,
        filename: f.name,
        contentType: f.type || 'application/octet-stream',
        size: f.size,
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : '#',
        width: null,
        height: null,
        // Voice metadata: optimistic placeholder doesn't render the
        // custom player (the real DTO arrives within ~1s with the
        // proper waveform + duration). We carry the flag so the
        // bubble's render logic can route correctly even before the
        // server replaces the row.
        isVoiceMessage: !!input.voiceMessage && i === 0,
        durationSeconds: input.voiceMessage && i === 0 ? input.voiceMessage.durationSeconds : null,
        waveform: input.voiceMessage && i === 0 ? input.voiceMessage.waveform : null,
        // Optimistic row renders the local full image inline; no thumb needed.
        thumbnailUrl: null,
      }));

      const placeholder: Message = {
        id: localId,
        channelId,
        authorId: user?.id ?? null,
        author: user
          ? {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              avatarUrl: user.avatarUrl ?? null,
              status: user.status,
              customStatus: user.customStatus ?? null,
            }
          : null,
        type: 'default',
        content: input.content,
        replyToId: input.replyToId ?? null,
        pinned: false,
        editedAt: null,
        mentionsEveryone: false,
        mentionedUserIds: [],
        mentionedRoleIds: [],
        attachments: placeholderAttachments,
        reactions: [],
        // Embeds: optimistic placeholder uses null = "still loading"
        // so the renderer doesn't show an empty terminal state. The
        // server's MESSAGE_UPDATE will arrive with the real list once
        // the background OG fetcher resolves.
        embeds: null,
        // Polls aren't optimistically rendered — the placeholder shows
        // the user's text content (or empty) and the poll bubble appears
        // when the server response replaces the local row.
        poll: null,
        // Forwards: the snapshot lands when the real DTO arrives. The
        // optimistic placeholder just shows the forwarder's comment
        // (their `content`) without the source quote — close enough
        // visually and avoids fetching the source twice.
        forwardedFromMessageId: input.forwardFromMessageId ?? null,
        forwardedFrom: null,
        // Stickers: the placeholder carries the id but no snapshot;
        // the real DTO arrives within a few hundred ms and the
        // sticker image renders then. We could optimistically render
        // by looking up state.stickersByGuild, but the wait is short
        // enough that a brief blank slot is acceptable and saves us
        // the matching code.
        stickerId: input.stickerId ?? null,
        sticker: null,
        // Webhook fields — null on user-authored optimistic placeholders.
        // The renderer treats null as "not a webhook message" and falls
        // back to the user identity from `author`.
        webhookId: null,
        authorOverrideName: null,
        authorOverrideAvatar: null,
        createdAt: new Date().toISOString(),
        pending: true,
      };
      dispatch({ type: 'MESSAGE_APPEND', channelId, message: placeholder });

      // E2EE: encrypt attachments before they leave the device. The
      // optimistic placeholder above already used the plaintext originals
      // for an instant local preview; only the uploaded bytes are
      // encrypted. We store the ciphertext files in pendingFilesRef so a
      // Retry re-uploads ciphertext too — never plaintext. Each encrypted
      // file gets the `.zke` suffix the renderer/gallery use to detect it.
      let uploadFiles = files;
      let attachmentsMeta:
        | ({ width?: number; height?: number; hasThumbnail?: boolean } | null)[]
        | undefined;
      let thumbFiles: (File | null)[] | undefined;
      if (input.encryptAttachmentsForDm && files.length > 0) {
        try {
          const { encryptBytesForDm, imageBitmapDims, makeEncryptedThumbnail } = await import(
            '../lib/e2ee'
          );
          const cid = input.encryptAttachmentsForDm;
          const out: File[] = [];
          const meta: ({ width?: number; height?: number; hasThumbnail?: boolean } | null)[] = [];
          const thumbs: (File | null)[] = [];
          for (const f of files) {
            const bytes = new Uint8Array(await f.arrayBuffer());
            const enc = await encryptBytesForDm(bytes, cid);
            if (!enc) throw new Error('attachment-encryption-failed');
            out.push(
              new File([enc as BlobPart], `${f.name}.zke`, {
                type: 'application/octet-stream',
              }),
            );
            // For images: make a small ENCRYPTED thumbnail (loaded inline) and
            // send the original's dims (slot reservation). The dims/thumb come
            // from the plaintext original, never the ciphertext. If thumbnailing
            // fails, still send dims so the slot is reserved.
            if (f.type.startsWith('image/')) {
              const r = await makeEncryptedThumbnail(f, cid);
              if (r) {
                meta.push({ width: r.width, height: r.height, hasThumbnail: true });
                thumbs.push(r.thumb);
              } else {
                const d = await imageBitmapDims(f);
                meta.push(d ? { width: d.width, height: d.height } : null);
                thumbs.push(null);
              }
            } else {
              meta.push(null);
              thumbs.push(null);
            }
          }
          uploadFiles = out;
          attachmentsMeta = meta;
          thumbFiles = thumbs;
        } catch {
          // Never fall back to plaintext under E2EE — fail the bubble.
          dispatch({ type: 'MESSAGE_MARK_FAILED', channelId, localId });
          toasts.push('Could not encrypt attachment — message not sent.', 'error');
          return localId;
        }
      } else if (files.length > 0) {
        // Non-E2EE: read pixel dims from the plaintext bitmap and send them so
        // the server persists width/height and every client reserves the image
        // box up front — no reflow-on-load that makes the virtualized list jump
        // while scrolling. Best-effort; unreserved is the pre-existing behavior.
        try {
          const meta: ({ width?: number; height?: number } | null)[] = await Promise.all(
            files.map(async (f) => {
              if (!f.type.startsWith('image/') || typeof createImageBitmap !== 'function') {
                return null;
              }
              try {
                const bmp = await createImageBitmap(f);
                const d = bmp.width && bmp.height ? { width: bmp.width, height: bmp.height } : null;
                bmp.close();
                return d;
              } catch {
                return null;
              }
            }),
          );
          if (meta.some((m) => m)) attachmentsMeta = meta;
        } catch {
          // best-effort — an unreserved box is the pre-existing behavior
        }
      }
      pendingFilesRef.current.set(localId, uploadFiles);

      // Fire the actual REST call in the background.
      try {
        const r = await (await restForChannel(channelId)).sendMessage(channelId, {
          content: input.content,
          replyToId: input.replyToId,
          files: uploadFiles,
          nonce: localId,
          ...(input.poll ? { poll: input.poll } : {}),
          ...(input.forwardFromMessageId ? { forwardFromMessageId: input.forwardFromMessageId } : {}),
          ...(input.stickerId ? { stickerId: input.stickerId } : {}),
          ...(input.voiceMessage ? { voiceMessage: input.voiceMessage } : {}),
          ...(attachmentsMeta ? { attachmentsMeta } : {}),
          ...(thumbFiles ? { thumbs: thumbFiles } : {}),
        });
        dispatch({
          type: 'MESSAGE_REPLACE_LOCAL',
          channelId,
          localId,
          message: r.message,
        });
        // Free object URLs once the real DTO has the real CDN URLs.
        for (const att of placeholderAttachments) {
          if (att.url.startsWith('blob:')) URL.revokeObjectURL(att.url);
        }
        pendingFilesRef.current.delete(localId);
        pendingInputsRef.current.delete(localId);
      } catch (err) {
        dispatch({ type: 'MESSAGE_MARK_FAILED', channelId, localId });
        // Timeout is the most user-confusing error path here: the
        // bubble flips to failed and the user has no idea why. Surface
        // the until-timestamp so they understand they're temporarily
        // muted, not that their network is broken. Other errors keep
        // the silent fail (in-stream Retry affordance handles them).
        if (err instanceof ApiError && err.code === 'TIMED_OUT') {
          const until = (err.details as { until?: string } | undefined)?.until;
          const friendlyUntil = until
            ? new Date(until).toLocaleString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
                month: 'short',
                day: 'numeric',
              })
            : null;
          toasts.push(
            friendlyUntil
              ? `You're timed out until ${friendlyUntil}`
              : "You're timed out in this server",
            'error',
          );
        } else if (err instanceof ApiError && err.code === 'AUTOMOD_BLOCKED') {
          // Surface the rule name so the sender knows what tripped
          // rather than guessing what to rephrase. If the rule also
          // applied a timeout, mention that — the gateway member-
          // update broadcast will populate the timeout state in the
          // composer banner shortly after, but the toast is the
          // immediate signal.
          const details = err.details as
            | { ruleName?: string; timeoutApplied?: boolean }
            | undefined;
          const rule = details?.ruleName ?? 'server rule';
          const msg = details?.timeoutApplied
            ? `Blocked by "${rule}" — you've been timed out`
            : `Blocked by "${rule}"`;
          toasts.push(msg, 'error');
        } else if (err instanceof ApiError && err.code === 'PENDING_ACKNOWLEDGMENT') {
          // The onboarding modal should already be rendered (same
          // condition fires it). The toast is the in-context signal
          // for users who somehow got around to trying to send (e.g.
          // they had the composer focused before the modal mounted,
          // or the member state took a beat to propagate).
          toasts.push('Read and accept the server rules to participate', 'info');
        }
      }
      return localId;
    },
    [rest, user, toasts],
  );

  const retrySendMessage = useCallback(
    async (channelId: string, localId: string) => {
      const input = pendingInputsRef.current.get(localId);
      if (!input || input.channelId !== channelId) return;
      const files = pendingFilesRef.current.get(localId) ?? [];

      // Flip back to pending state visually. Read via stateRef (not the closure)
      // so a stale callback instance can't miss the message in an old snapshot.
      const existing = stateRef.current.messagesByChannel[channelId];
      if (existing) {
        const target = existing.find((m) => m.id === localId);
        if (target) {
          dispatch({
            type: 'MESSAGE_PATCH',
            channelId,
            message: { ...target, pending: true, failed: false },
          });
        }
      }

      try {
        const r = await (await restForChannel(channelId)).sendMessage(channelId, {
          content: input.content,
          replyToId: input.replyToId,
          files,
          // Dedupe against a first attempt that actually landed server-side but
          // whose response was lost (marked failed) — avoids a double-send.
          nonce: localId,
        });
        // Revoke the placeholder's blob: previews before we replace it, or they
        // leak (mirrors the first-send success path + discardFailedMessage).
        stateRef.current.messagesByChannel[channelId]
          ?.find((m) => m.id === localId)
          ?.attachments?.forEach((a) => {
            if (a.url?.startsWith('blob:')) URL.revokeObjectURL(a.url);
          });
        dispatch({
          type: 'MESSAGE_REPLACE_LOCAL',
          channelId,
          localId,
          message: r.message,
        });
        pendingFilesRef.current.delete(localId);
        pendingInputsRef.current.delete(localId);
      } catch (err) {
        dispatch({ type: 'MESSAGE_MARK_FAILED', channelId, localId });
        if (err instanceof ApiError && err.code === 'TIMED_OUT') {
          const until = (err.details as { until?: string } | undefined)?.until;
          const friendlyUntil = until
            ? new Date(until).toLocaleString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
                month: 'short',
                day: 'numeric',
              })
            : null;
          toasts.push(
            friendlyUntil
              ? `You're timed out until ${friendlyUntil}`
              : "You're timed out in this server",
            'error',
          );
        } else if (err instanceof ApiError && err.code === 'AUTOMOD_BLOCKED') {
          const details = err.details as
            | { ruleName?: string; timeoutApplied?: boolean }
            | undefined;
          const rule = details?.ruleName ?? 'server rule';
          const msg = details?.timeoutApplied
            ? `Blocked by "${rule}" — you've been timed out`
            : `Blocked by "${rule}"`;
          toasts.push(msg, 'error');
        } else if (err instanceof ApiError && err.code === 'PENDING_ACKNOWLEDGMENT') {
          toasts.push('Read and accept the server rules to participate', 'info');
        }
      }
    },
    [rest, toasts],
  );

  const discardFailedMessage = useCallback(
    (channelId: string, localId: string) => {
      dispatch({ type: 'MESSAGE_REMOVE', channelId, messageId: localId });
      // Free any pending object URLs. Read via stateRef (not the closure) so a
      // stale callback instance can't miss the message in an old snapshot, and
      // so this callback's identity never flips on message events (which would
      // re-render every mounted MessageItem — see MessageItem.tsx:94-97).
      const existing = stateRef.current.messagesByChannel[channelId];
      const m = existing?.find((m) => m.id === localId);
      if (m) {
        for (const att of m.attachments) {
          if (att.url.startsWith('blob:')) URL.revokeObjectURL(att.url);
        }
      }
      pendingFilesRef.current.delete(localId);
      pendingInputsRef.current.delete(localId);
    },
    [],
  );

  // ── Initial bootstrap on auth ────────────────────────────────────────

  useEffect(() => {
    if (!token || !user) return;
    void refreshGuilds().catch(() => {
      // If listing guilds fails, leave state empty; the UI surfaces the
      // empty state. A retry button is a polish-pass concern.
    });
    // Load DMs and read-states alongside guilds — they share the bootstrap
    // moment. Read-states arrive in the gateway's READY frame too, but
    // hitting REST in parallel makes the unread badges paint sooner if the
    // WS handshake is slow.
    void loadDMs().catch(() => undefined);
    void loadReadStates().catch(() => undefined);
    void loadNotificationOverrides().catch(() => undefined);
    void loadRelationships().catch(() => undefined);
    void loadDmNicknames().catch(() => undefined);
    void loadSupervision().catch(() => undefined);
  }, [token, user, refreshGuilds, loadDMs, loadReadStates, loadNotificationOverrides, loadRelationships, loadDmNicknames, loadSupervision]);

  // ── Voice-prefs sync ─────────────────────────────────────────────────
  //
  // Pull the user's persisted voice prefs from the server and merge
  // into the local store on auth. Wire the syncer so future local
  // changes write back. Logout detaches the syncer so a re-login as
  // a different user doesn't briefly fire PATCHes attributed to the
  // wrong account.
  useEffect(() => {
    if (!token || !user) return;
    let cancelled = false;
    setVoicePrefsSyncer((nextState) =>
      rest.updateVoicePrefs(nextState as unknown as Record<string, unknown>),
    );
    void rest
      .getVoicePrefs()
      .then((r) => {
        // Bail if the auth session changed mid-fetch (logout, or
        // re-login as a different user). Otherwise we'd apply the
        // previous user's prefs to the new user's local store, or
        // PATCH attributed to whichever user the syncer is now
        // bound to.
        if (cancelled) return;
        // Only hydrate if the server actually has something — first-
        // time users have an empty {} blob and we don't want to clear
        // their local prefs by overwriting with empty.
        if (r.voicePrefs && Object.keys(r.voicePrefs).length > 0) {
          hydrateVoicePrefs(r.voicePrefs);
        } else {
          // Brand-new user → push the current local state up so the
          // server starts holding it. Using the syncer triggers the
          // 500ms debounce; a single extra setTimeout below ensures
          // the upload actually fires (the debounce is only armed by
          // persist() calls). We do this once explicitly.
          void rest.updateVoicePrefs(
            getVoicePrefs() as unknown as Record<string, unknown>,
          ).catch(() => undefined);
        }
      })
      .catch(() => {
        // Network failure on boot → keep using local prefs. Future
        // edits will retry when they fire the syncer.
      });
    return () => {
      cancelled = true;
      setVoicePrefsSyncer(null);
    };
  }, [token, user, rest]);

  // On logout, drop any pending optimistic-send state. The provider stays
  // mounted across auth changes, so without this the refs hold the previous
  // session's File objects + input metadata indefinitely (cross-session leak).
  useEffect(() => {
    if (!token) {
      pendingFilesRef.current.clear();
      pendingInputsRef.current.clear();
    }
  }, [token]);

  // ── Gateway → state ──────────────────────────────────────────────────
  // Subscriptions are scoped to the lifetime of the auth session.

  // Register all gateway→state handlers on a given gateway client and return
  // the unsubscribe list. Used for BOTH the backbone gateway and per-node
  // gateways (remote guilds). The parameter is named `gateway` so the handler
  // bodies below — which all reference `gateway.on(...)` — bind to whichever
  // client is passed, with zero changes. `isNode` skips the session-level
  // READY bootstrap (guild/DM/relationship refetch + bulk voice replace),
  // which is a backbone concern and must not re-run for a node connection.
  const subscribeGateway = useCallback(
    (gateway: GatewayClient, isNode = false) => {
      const selfId = user?.id ?? '';
      const unsubs: Array<() => void> = [];

    unsubs.push(
      gateway.on<Message>(GatewayEvent.MESSAGE_CREATE, (m) => {
        dispatch({ type: 'MESSAGE_APPEND', channelId: m.channelId, message: m });

        // ── Notification surfacing rules ────────────────────────────
        // Three signals can fire here:
        //   1. mention badge increment (existing)
        //   2. mention ping (sound)
        //   3. DM ping (sound, softer)
        //
        // Mute resolution: read state.notificationOverrides via the
        // synchronous ref. A muted channel/guild suppresses BOTH the
        // mention badge (handled in DMList/ChannelList render via
        // isChannelMuted) and the audio ping. We honor the same rule
        // server-side in the push fan-out — push is filtered by the
        // resolveLevelsBulk helper — so mute is consistent across
        // every notification surface.

        if (!selfId || m.authorId === selfId) {
          // Our OWN message must not light an unread dot for us. Unread is a
          // bare lastMessageId comparison with no authorship concept, so a
          // message we sent (from this or another tab/device) would show a
          // dot in DMList/ChannelList until the channel is opened. Advance
          // our read marker locally; the READ_STATE_UPSERT reducer's
          // monotonic + numeric-id guards make this safe (optimistic
          // `local-` ids are dropped). The server also advances it on create.
          if (m.authorId === selfId && /^\d+$/.test(m.id)) {
            dispatch({
              type: 'READ_STATE_UPSERT',
              readState: { channelId: m.channelId, lastMessageId: m.id, mentionCount: 0 },
            });
          }
          return;
        }

        const fresh = stateRef.current;
        // @everyone/@here counts as a mention too (own messages already
        // returned above, so this can't self-badge). mentionsEveryone is only
        // ever true on guild messages the recipient can see.
        const isMention = m.mentionedUserIds.includes(selfId) || m.mentionsEveryone;

        // Look up the channel to decide if this is a DM. We check the
        // dmChannels list first (fast O(n) over <50 channels in
        // practice) then fall back to assuming it's a guild channel.
        const isDM = fresh.dmChannels.some((c) => c.id === m.channelId);

        // Mention badge. Mirrors the server's read_states.mention_count
        // increment so the UI badge updates without waiting for a page
        // reload to re-fetch read-states. The reducer's monotonic
        // guard prevents double-counting; we rely on at-most-once
        // delivery of MESSAGE_CREATE per channel-recipient.
        if (isMention) {
          dispatch({ type: 'MENTION_INCREMENT', channelId: m.channelId });
        }

        // Find the channel's guild id for mute resolution. DMs have
        // null guildId; guild channels carry it on the Channel row.
        const guildIdForChannel: string | null = (() => {
          if (isDM) return null;
          for (const [gid, channels] of Object.entries(fresh.channelsByGuild)) {
            if (channels.some((c) => c.id === m.channelId)) return gid;
          }
          return null;
        })();
        const muted = isChannelMuted(
          fresh.notificationOverrides,
          m.channelId,
          guildIdForChannel,
        );

        // Ping rules:
        //   - @-mention OR DM → audible ping (unless muted)
        //   - Plain guild message (no mention) → no ping (would be a
        //     fire-hose in any active server)
        // Additional suppression: if the user is already actively
        // looking at this channel (window focused AND URL path
        // includes the channel id), skip the ping — they don't need
        // an audible cue for a message that's already on-screen.
        const looking =
          typeof document !== 'undefined' &&
          document.hasFocus() &&
          typeof window !== 'undefined' &&
          window.location.pathname.includes(`/${m.channelId}`);
        // "Get notifications from servers too": also ping for a plain guild
        // message when the user EXPLICITLY chose All for this channel (or its
        // guild). Must be explicit — the resolver defaults to 'all', so a bare
        // resolve would fire-hose every guild message. Mirrors the server push.
        const chOverride = fresh.notificationOverrides[`channel:${m.channelId}`];
        let explicitAll = chOverride === 'all';
        // Reuse guildIdForChannel (already resolved above) instead of a second
        // full channelsByGuild scan. The null-guard preserves the old loop's
        // behavior: a channel not found in channelsByGuild never matched, so
        // explicitAll stayed false.
        if (!chOverride && !isDM && guildIdForChannel) {
          explicitAll = fresh.notificationOverrides[`guild:${guildIdForChannel}`] === 'all';
        }
        // Device-local "Messages & mentions" toggle (Settings) gates BOTH
        // the audible ping and the desktop notification, mirroring the
        // native app's notifyMessages switch.
        if (
          getNotifyPrefs().notifyMessages &&
          !muted &&
          !looking &&
          (isMention || isDM || explicitAll)
        ) {
          playMentionPing();

          // Native desktop notification (Electron app only — browsers
          // use service-worker push). Build a concise title/body.
          const author = m.authorId ? fresh.usersById[m.authorId] : undefined;
          const authorName =
            author?.displayName ?? author?.username ?? 'New message';
          // Resolve a channel label for guild messages. Key directly off the
          // guild id resolved above rather than scanning every guild's channels.
          let channelName: string | null = null;
          if (!isDM && guildIdForChannel) {
            channelName =
              fresh.channelsByGuild[guildIdForChannel]?.find((c) => c.id === m.channelId)
                ?.name ?? null;
          }
          // DMs are end-to-end encrypted; m.content here may be
          // ciphertext, so we don't surface DM bodies. Guild messages
          // are plaintext and safe to preview.
          const body = isDM
            ? 'Sent you a message'
            : typeof m.content === 'string' && m.content.trim().length > 0
              ? m.content.slice(0, 140)
              : 'New message';
          showDesktopNotification({
            title: isDM
              ? authorName
              : channelName
                ? `${authorName} · #${channelName}`
                : authorName,
            body,
            tag: m.channelId,
            onClick: () => {
              try {
                const path = isDM
                  ? `/channels/@me/${m.channelId}`
                  : guildIdForChannel
                    ? `/channels/${guildIdForChannel}/${m.channelId}`
                    : null;
                // Soft navigation — same pattern as the service-worker
                // NAVIGATE handler in main.tsx. location.assign() here
                // was a full bundle reload: in-memory AppState and the
                // gateway connection were torn down and re-bootstrapped
                // just to switch channels.
                if (path) {
                  window.history.pushState({}, '', path);
                  window.dispatchEvent(new PopStateEvent('popstate'));
                }
              } catch {
                // ignore — focusing the window already happened
              }
            },
          });
        }
      }),
      gateway.on<Message>(GatewayEvent.MESSAGE_UPDATE, (m) => {
        dispatch({ type: 'MESSAGE_PATCH', channelId: m.channelId, message: m });
      }),

      // MESSAGE_POLL_UPDATE — focused poll-only delta. Currently
      // fires from the server's poll expiry sweep when closed_at
      // flips. Reducer patches the poll subtree in place rather
      // than replacing the whole message DTO.
      gateway.on<{
        poll_id: string;
        message_id: string;
        channel_id: string;
        guild_id: string | null;
        closed_at: string;
      }>(GatewayEvent.MESSAGE_POLL_UPDATE, (d) => {
        dispatch({
          type: 'POLL_PATCH',
          channelId: d.channel_id,
          messageId: d.message_id,
          pollId: d.poll_id,
          closedAt: d.closed_at,
        });
      }),
      gateway.on<{ id: string; channel_id: string }>(GatewayEvent.MESSAGE_DELETE, (d) => {
        dispatch({ type: 'MESSAGE_REMOVE', channelId: d.channel_id, messageId: d.id });
      }),
      gateway.on<{ ids: string[]; channel_id: string }>(GatewayEvent.MESSAGE_DELETE_BULK, (d) => {
        dispatch({
          type: 'MESSAGES_REMOVE_BULK',
          channelId: d.channel_id,
          messageIds: d.ids,
        });
      }),

      // DM read-receipt events. Both fire only to the sender's own
      // connections (server scopes the audience to { kind: 'user',
      // userId: authorId }), and only on 1:1 DMs where the recipient
      // has receipts enabled. The reducer is shared — both fire
      // MESSAGE_RECEIPT_STAMP with a field name + timestamp so the
      // same code path handles "Delivered" and "Read".
      gateway.on<{
        channel_id: string;
        message_ids: string[];
        delivered_at: string;
      }>(GatewayEvent.MESSAGE_DELIVERED, (d) => {
        dispatch({
          type: 'MESSAGE_RECEIPT_STAMP',
          channelId: d.channel_id,
          messageIds: d.message_ids,
          field: 'deliveredAt',
          timestamp: d.delivered_at,
        });
      }),
      gateway.on<{
        channel_id: string;
        message_ids: string[];
        viewed_at: string;
      }>(GatewayEvent.MESSAGE_VIEWED, (d) => {
        dispatch({
          type: 'MESSAGE_RECEIPT_STAMP',
          channelId: d.channel_id,
          messageIds: d.message_ids,
          field: 'viewedAt',
          timestamp: d.viewed_at,
        });
      }),

      // CHANNEL_PINS_UPDATE — fired alongside MESSAGE_UPDATE on pin/unpin.
      // We bump a per-channel timestamp; PinPanel watches it and re-runs
      // its listPinnedMessages call when the timestamp changes.
      gateway.on<{ channel_id: string; last_pin_timestamp: string }>(
        GatewayEvent.CHANNEL_PINS_UPDATE,
        (d) => {
          dispatch({ type: 'CHANNEL_PINS_BUMP', channelId: d.channel_id });
        },
      ),

      gateway.on<{ message_id: string; channel_id: string; user_id: string; emoji: string }>(
        GatewayEvent.MESSAGE_REACTION_ADD,
        (d) => {
          dispatch({
            type: 'REACTION_ADD',
            channelId: d.channel_id,
            messageId: d.message_id,
            userId: d.user_id,
            emoji: d.emoji,
            selfId,
          });
        },
      ),
      gateway.on<{ message_id: string; channel_id: string; user_id: string; emoji: string }>(
        GatewayEvent.MESSAGE_REACTION_REMOVE,
        (d) => {
          dispatch({
            type: 'REACTION_REMOVE',
            channelId: d.channel_id,
            messageId: d.message_id,
            userId: d.user_id,
            emoji: d.emoji,
            selfId,
          });
        },
      ),
      gateway.on<{ message_id: string; channel_id: string; emoji?: string }>(
        GatewayEvent.MESSAGE_REACTION_REMOVE_ALL,
        (d) => {
          dispatch({
            type: 'REACTION_REMOVE_ALL',
            channelId: d.channel_id,
            messageId: d.message_id,
            emoji: d.emoji,
          });
        },
      ),

      gateway.on<Channel>(GatewayEvent.CHANNEL_CREATE, (ch) => {
        // Route DMs to their own slice; guild channels go to the per-guild map.
        if (ch.guildId) dispatch({ type: 'CHANNEL_UPSERT', channel: ch });
        else dispatch({ type: 'DM_UPSERT', channel: ch });
      }),
      gateway.on<Channel>(GatewayEvent.CHANNEL_UPDATE, (ch) => {
        if (ch.guildId) dispatch({ type: 'CHANNEL_UPSERT', channel: ch });
        else dispatch({ type: 'DM_UPSERT', channel: ch });
      }),
      gateway.on<{ channel_id: string; streak: number }>(GatewayEvent.DM_STREAK_UPDATE, (d) => {
        dispatch({ type: 'DM_STREAK_SET', channelId: d.channel_id, streak: d.streak });
      }),
      // Poke / nudge — an ephemeral notification (no message, no history). Show
      // a transient toast (emoji + who) AND, in the desktop app, an OS banner;
      // skip our own pokes echoed to the DM channel audience. A closed app is
      // reached by the big-emoji push.
      gateway.on<{
        channel_id: string;
        poke_type: string;
        emoji: string;
        initiator_id: string;
        initiator_name: string;
      }>(GatewayEvent.POKE, (d) => {
        if (!selfId || d.initiator_id === selfId) return;
        // Mute resolution, mirroring MESSAGE_CREATE above and the server's own
        // poke fan-out (which skips any recipient whose level for this DM
        // resolves to 'nothing'). A poke is a nudge, not an exemption — it
        // must not be the one alert that punches through a DM the user muted.
        // Pokes only ever land on 1:1 DMs, so there is no guild level to
        // inherit from.
        const muted = isChannelMuted(
          stateRef.current.notificationOverrides,
          d.channel_id,
          null,
        );
        // Already looking at this DM in a focused window → the toast is the
        // whole story and an OS banner on top is noise. Same suppression the
        // service worker applies to the push copy of a poke.
        const looking =
          typeof document !== 'undefined' &&
          document.hasFocus() &&
          typeof window !== 'undefined' &&
          window.location.pathname.includes(`/${d.channel_id}`);
        // Device-local "Messages & mentions" toggle gates this the same way it
        // gates message banners: a device the user silenced stays silent.
        if (getNotifyPrefs().notifyMessages && !muted && !looking) {
          // Electron only (browsers receive the service-worker push instead,
          // see lib/desktopNotify). Without this a BACKGROUNDED desktop app
          // showed nothing at all for a poke: the toast renders behind
          // whatever window has focus and is gone before the user looks.
          // Title / body / tag deliberately match the server's push copy
          // (routes/messages.ts poke) so both surfaces read identically —
          // sender's name, the emoji as the body, one banner per DM.
          showDesktopNotification({
            title: d.initiator_name,
            body: d.emoji,
            tag: `poke-${d.channel_id}`,
            onClick: () => {
              window.history.pushState({}, '', `/channels/@me/${d.channel_id}`);
              window.dispatchEvent(new PopStateEvent('popstate'));
            },
          });
        }
        // Leave a mark on the DM row. The toast below is for someone looking
        // at the screen right now; this is what the poke leaves behind for
        // someone who wasn't, and it clears when they open the conversation.
        dispatch({ type: 'POKE_PILL_SET', channelId: d.channel_id, emoji: d.emoji });
        // 15s, not the 4s default: a poke is a deliberate nudge from another
        // person and its toast carries the poke-back button, so it has to
        // survive a glance away from the screen. 4s was short enough that the
        // recipient routinely never saw it.
        toasts.push(`${d.emoji}  ${d.initiator_name}`, 'info', 15_000, {
          // Tap the toast → open the DM with the sender (the poke arrived on
          // their DM channel). Soft-nav (no full reload — keeps the gateway up).
          onClick: () => {
            window.history.pushState({}, '', `/channels/@me/${d.channel_id}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
          // Tap the emoji → poke them back with the SAME variant.
          action: {
            label: d.emoji,
            onClick: () => {
              void (async () => {
                try {
                  await (await restForChannel(d.channel_id)).poke(d.channel_id, d.poke_type);
                } catch {
                  /* best-effort poke-back */
                }
              })();
            },
          },
        });
      }),
      // A new achievement just unlocked (sent only to this user's own
      // connections) → celebratory toast. The server already gates this on the
      // per-account notify_achievements preference, so if it arrives, show it.
      gateway.on<{ id: string; name: string; description: string; marker: string }>(
        GatewayEvent.ACHIEVEMENT_UNLOCK,
        (a) => {
          toasts.push(`🏆  Achievement unlocked — ${a.name}`, 'success', 6000);
        },
      ),
      gateway.on<Channel>(GatewayEvent.CHANNEL_DELETE, (ch) => {
        dispatch({ type: 'CHANNEL_REMOVE', channelId: ch.id, guildId: ch.guildId });
      }),
      gateway.on<Guild>(GatewayEvent.GUILD_CREATE, (g) => {
        dispatch({ type: 'GUILD_UPSERT', guild: g });
        // Eagerly load channels so the user can navigate to it immediately.
        void loadChannels(g.id).catch(() => undefined);
      }),
      gateway.on<{ id: string }>(GatewayEvent.GUILD_DELETE, (g) => {
        dispatch({ type: 'GUILD_REMOVE', guildId: g.id });
      }),

      gateway.on<GuildMember>(GatewayEvent.GUILD_MEMBER_ADD, (m) => {
        dispatch({ type: 'MEMBER_UPSERT', guildId: m.guildId, member: m });
      }),
      // GUILD_MEMBER_UPDATE — role assignment/removal, hoist, and timeout
      // (communicationDisabledUntil) changes. The wire DTO is produced by the
      // same toGuildMember() serializer as GUILD_MEMBER_ADD (camelCase
      // guildId/userId/roleIds), so the ADD handler body works verbatim.
      // Without this the member row (role color, hoisted grouping, timeout
      // state) stayed stale until a guild switch or reconnect. MEMBER_UPSERT
      // is idempotent, so replaying for an existing member just refreshes it.
      gateway.on<GuildMember>(GatewayEvent.GUILD_MEMBER_UPDATE, (m) => {
        dispatch({ type: 'MEMBER_UPSERT', guildId: m.guildId, member: m });
      }),
      gateway.on<{ guild_id: string; user_id: string }>(GatewayEvent.GUILD_MEMBER_REMOVE, (d) => {
        dispatch({ type: 'MEMBER_REMOVE', guildId: d.guild_id, userId: d.user_id });
      }),

      // GUILD_ROLE_UPDATE — role rename / recolor / permission edit. The
      // toRole() DTO carries a camelCase guildId. Member name colors and role
      // pills read state.rolesByGuild; without this handler the frame is
      // dropped and the stale color persists (not even healed on reconnect —
      // see the loadRoles refetch in the READY resync below).
      gateway.on<Role>(GatewayEvent.GUILD_ROLE_UPDATE, (role) => {
        dispatch({ type: 'ROLE_UPSERT', guildId: role.guildId, role });
      }),

      // GUILD_EMOJIS_UPDATE — bulk replace of a guild's emoji list.
      // Fires on create/rename/delete. Payload carries the full
      // post-mutation list, so we just splice it in without diffing.
      gateway.on<{ guild_id: string; emojis: GuildEmoji[] }>(
        GatewayEvent.GUILD_EMOJIS_UPDATE,
        (d) => {
          dispatch({ type: 'EMOJIS_SET', guildId: d.guild_id, emojis: d.emojis });
        },
      ),

      // GUILD_STICKERS_UPDATE — same pattern as emojis. Fires on
      // create/patch/delete; payload is the full current list.
      gateway.on<{ guild_id: string; stickers: Sticker[] }>(
        GatewayEvent.GUILD_STICKERS_UPDATE,
        (d) => {
          dispatch({ type: 'STICKERS_SET', guildId: d.guild_id, stickers: d.stickers });
        },
      ),

      // STAGE_PARTICIPANTS_UPDATE — bulk-replace of a stage channel's
      // speaker/audience list. Fires on join/leave/promote/demote/
      // hand-raise. We mirror the convention used for emoji + stickers.
      gateway.on<{ guild_id: string; channel_id: string; participants: StageParticipant[] }>(
        GatewayEvent.STAGE_PARTICIPANTS_UPDATE,
        (d) => {
          dispatch({
            type: 'STAGE_PARTICIPANTS_SET',
            channelId: d.channel_id,
            participants: d.participants,
          });
        },
      ),

      // SCHEDULED_EVENT_* — three discrete events for scheduled-event
      // CRUD. Reducer handles the "no entry yet" case (won't
      // pre-populate from broadcasts for guilds whose EventsModal
      // hasn't been opened; next open does a fresh REST load).
      gateway.on<ScheduledEvent>(GatewayEvent.SCHEDULED_EVENT_CREATE, (d) => {
        dispatch({ type: 'EVENT_UPSERT', guildId: d.guildId, event: d });
      }),
      gateway.on<ScheduledEvent>(GatewayEvent.SCHEDULED_EVENT_UPDATE, (d) => {
        dispatch({ type: 'EVENT_UPSERT', guildId: d.guildId, event: d });
      }),
      gateway.on<{ event_id: string; guild_id: string }>(
        GatewayEvent.SCHEDULED_EVENT_DELETE,
        (d) => {
          dispatch({ type: 'EVENT_REMOVE', guildId: d.guild_id, eventId: d.event_id });
        },
      ),

      // PRESENCE_UPDATE — fired when any user changes their status. We
      // patch the matching member row in the affected guild so the dot
      // color updates live without re-fetching the member list. Servers
      // dispatch one event per guild the user is in, so we just trust
      // the guild_id that came in.
      gateway.on<{
        guild_id: string;
        user_id: string;
        status: 'online' | 'idle' | 'dnd' | 'offline';
      }>(GatewayEvent.PRESENCE_UPDATE, (d) => {
        dispatch({
          type: 'PRESENCE_PATCH',
          guildId: d.guild_id,
          userId: d.user_id,
          status: d.status,
        });
      }),

      // USER_UPDATE — fired when a user's profile (display name, avatar,
      // bio, custom status) changes. Server fans out to every guild the
      // user is in plus their own connection. We replace the cached
      // PublicUser; the reducer also propagates into cached
      // GuildMember.user references so MemberList rows update without
      // a re-fetch. Self-tab gets this too — useful for multi-tab
      // sync (avatar uploaded on tab A → tab B's profile menu refreshes).
      gateway.on<{
        user: {
          id: string;
          username: string;
          display_name: string;
          avatar_url: string | null;
          bio: string | null;
          custom_status: string | null;
          status: 'online' | 'idle' | 'dnd' | 'offline';
        };
      }>(GatewayEvent.USER_UPDATE, (d) => {
        // Map snake_case wire format to the PublicUser camelCase shape
        // the rest of the app uses. Bio is server-emitted but not
        // part of PublicUser (it's SelfUser-only); we discard it
        // here. Guarded against missing payload — the gateway
        // shouldn't deliver an empty event but a stray bug elsewhere
        // shouldn't crash this handler.
        if (!d?.user) return;
        const u = d.user;
        dispatch({
          type: 'USER_REPLACE',
          user: {
            id: u.id,
            username: u.username,
            displayName: u.display_name,
            avatarUrl: u.avatar_url,
            customStatus: u.custom_status,
            status: u.status,
          },
        });
      }),

      // CHANNEL_ACK keeps cross-tab read state in sync. The server publishes
      // to the user's audience after every ack; both this tab and any other
      // open client of the same user converge on the same marker.
      gateway.on<ReadState>(GatewayEvent.CHANNEL_ACK, (rs) => {
        dispatch({ type: 'READ_STATE_UPSERT', readState: rs });
      }),
      gateway.on<{ childName: string; kind: 'friend' | 'guild'; label: string }>(
        GatewayEvent.FAMILY_REQUEST_CREATE,
        (p) => {
          if (!familyNotifyOnce(`req:${p.childName}:${p.kind}:${p.label}`)) return;
          dispatch({ type: 'FAMILY_NUDGE' });
          const msg = `${p.childName} wants to ${p.label}`;
          // One alert, not two: prefer the OS notification (desktop app);
          // fall back to an in-app toast when it isn't available (web, or
          // notifications not granted). showDesktopNotification returns
          // null in those cases.
          const notified = showDesktopNotification({
            title: 'Approval request',
            body: msg,
            tag: 'family-request',
          });
          if (!notified) toasts.push(msg, 'info');
        },
      ),
      gateway.on<{ childName: string; matchedWord: string; direction: 'sent' | 'received' }>(
        GatewayEvent.FAMILY_FLAG_CREATE,
        (p) => {
          if (!familyNotifyOnce(`flag:${p.childName}:${p.matchedWord}:${p.direction}`)) return;
          dispatch({ type: 'FAMILY_NUDGE' });
          const msg = `Flagged for ${p.childName}: “${p.matchedWord}” (${p.direction})`;
          const notified = showDesktopNotification({
            title: 'Watch word flagged',
            body: msg,
            tag: 'family-flag',
          });
          if (!notified) toasts.push(msg, 'info');
        },
      ),
      // The SUBJECT's own supervision changed — a guardian edited their
      // restrictions, a link was accepted or ended, a server was
      // blocked/unblocked, or the 18+ sweep released them. Audience is this
      // user alone, so receiving it means OUR gates are stale.
      //
      // The frame carries the effective restrictions, but state.supervision is
      // a FamilySummary (it also lists guardians and the grace-window fields,
      // which this payload deliberately omits), so we re-read /family/me rather
      // than splice a partial shape in. That single refetch re-gates every
      // consumer at once — DM policy + E2EE, messaging, friend adds, guild
      // create/join, voice/video/stream, the profanity mask, the supervision
      // banner — instead of waiting for the next page load.
      //
      // No payload is read, hence `unknown`. A failed refetch keeps the last
      // good snapshot (loadSupervision only dispatches on success), same as
      // every other supervision refresh path.
      gateway.on<unknown>(GatewayEvent.FAMILY_SUPERVISION_UPDATE, () => {
        void loadSupervision().catch(() => undefined);
      }),
      gateway.on<VoiceState>(GatewayEvent.VOICE_STATE_UPDATE, (v) => {
        // ── Ambient join/leave blips ──────────────────────────────────────
        // A quiet blip when somebody ELSE arrives in or departs from the
        // voice channel we're currently sitting in.
        //
        // Read the previous channel BEFORE the dispatch below overwrites it.
        // VOICE_STATE_UPDATE also fires for mute / deafen / video toggles, so
        // only an actual channel *transition* counts as an arrival or a
        // departure — otherwise every mute click in the room would blip.
        const prevChannelId = stateRef.current.voiceStatesByUser[v.userId]?.channelId ?? null;
        const nextChannelId = v.channelId ?? null;
        if (selfId && v.userId !== selfId && prevChannelId !== nextChannelId) {
          void (async () => {
            // Dynamic import for the same reason as the self-move detector
            // below: a static one would make AppState ↔ voice circular.
            const voiceMod = await import('../lib/voice');
            // The channel we hold live media in. Null when we're not in voice
            // at all, which silences other channels' churn for free — and
            // deafened means no audio, chrome included.
            const myChannelId = voiceMod.getConnectedChannelId();
            if (!myChannelId || voiceMod.isDeafened()) return;
            const { playVoiceJoin, playVoiceLeave } = await import('../lib/sounds');
            if (nextChannelId === myChannelId) playVoiceJoin();
            else if (prevChannelId === myChannelId) playVoiceLeave();
          })();
        }
        dispatch({ type: 'VOICE_STATE_UPSERT', voiceState: v });
        // Self-move detection. If the gateway just told us OUR voice
        // state moved to a channel this device neither holds nor is
        // trying to reach, a moderator dragged us. We need to disconnect
        // from the old LiveKit room and join the new one — the server's
        // already updated the DB and evicted us from the old SFU room.
        // Voice mod is imported dynamically to avoid circular reference
        // between AppState and the voice module.
        //
        // getConnectedChannelId() reports INTENT, not just settled state:
        // every join site stakes a claim on its target before calling
        // rest.joinVoice, because the server fans this very event out over
        // the gateway BEFORE it writes the join response. Without the
        // claim our own join's echo arrives while we're still connected to
        // nothing (or to the room we're leaving), reads as a drag, and
        // races a duplicate join against the one in flight. A REAL drag
        // has no local claim, so `connected` is the old room and the
        // mismatch below still fires.
        if (selfId && v.userId === selfId && v.channelId) {
          const newChannelId = v.channelId;
          void (async () => {
            const voiceMod = await import('../lib/voice');
            const connected = voiceMod.getConnectedChannelId();
            // Not in voice at all: nothing to move.
            if (!connected) return;
            // Our own doing — either we're already there, or we claimed it
            // before the REST join. Matching against OUTSTANDING CLAIMS as
            // well as the settled channel is what makes two overlapping
            // joins safe: with a single "current channel" the first join's
            // echo read as a drag to the second join's channel, and the
            // detector ping-ponged between them.
            if (voiceMod.isSelfVoiceTarget(newChannelId)) return;
            try {
              // silent: a moderator dragging us between channels is a move,
              // not a hangup. The connect chime from the rejoin below marks
              // the transition on its own.
              await voiceMod.disconnectVoice({ silent: true });
              // Claim the destination after the teardown (a disconnect-time
              // clear would otherwise wipe it) and before the REST call, so
              // the server's echo of THIS join isn't read as a second drag.
              voiceMod.claimVoiceChannel(newChannelId);
              const r = await (await restForChannel(newChannelId)).joinVoice(newChannelId);
              if (r?.token && r.wsUrl) {
                await voiceMod.connectToVoice({
                  token: r.token,
                  wsUrl: r.wsUrl,
                  sessionId: r.voiceState.sessionId,
                  channelId: newChannelId,
                });
              }
            } catch {
              // Toasts surfaced by inner calls.
            } finally {
              // connectToVoice releases the claim when it settles; the
              // REST-failed / no-token paths never reach it.
              voiceMod.releaseVoiceChannel(newChannelId);
            }
          })();
        }
      }),
      // READY hydrates voice presence in one shot. Listed under a
      // narrowed shape — the server sends `voice_states` snake_case.
      //
      // We ALSO use this hook to detect reconnects and trigger a full
      // state resync. Background: a zombie WebSocket (mobile suspend,
      // network blip, kernel-buffered writes after a silent TCP drop)
      // can swallow events for up to ~40s before the heartbeat-ack
      // watchdog catches it and force-reconnects. Every event in that
      // window is lost — GUILD_MEMBER_ADD, VOICE_STATE_UPDATE,
      // PRESENCE_UPDATE — and the server's READY frame only ships
      // ids for guilds + DMs + voice states. Without an explicit
      // refetch, the client carries its pre-zombie snapshot forward:
      // members invisible, presence stuck, voice rosters wrong, all
      // until a manual restart. The fix is to treat every READY after
      // the first as "I missed events while I was gone; reload from
      // the source of truth."
      //
      // First READY in a session: the initial-load useEffect above
      // is already running the bootstrap in parallel; doing it twice
      // would just thrash. We skip with the readyOnceRef flag.
      gateway.on<{ voice_states?: VoiceState[] }>('READY', (payload) => {
        // A node gateway's READY is just connection establishment — the
        // session bootstrap (guilds/DMs/relationships) and the bulk voice
        // replace are backbone concerns. The node's live per-event handlers
        // still flow.
        if (isNode) return;
        if (payload?.voice_states) {
          dispatch({ type: 'VOICE_STATES_SET', voiceStates: payload.voice_states });
        }
        if (!readyOnceRef.current) {
          readyOnceRef.current = true;
          return;
        }
        // Reconnect — re-bootstrap. Each call below is idempotent
        // (REPLACE semantics on the reducer side) so refetching is
        // safe even if state hasn't drifted. We fan out in parallel
        // and swallow individual failures so one slow endpoint
        // can't block the others.
        void refreshGuilds().catch(() => undefined);
        void loadDMs().catch(() => undefined);
        void loadReadStates().catch(() => undefined);
        void loadNotificationOverrides().catch(() => undefined);
        void loadRelationships().catch(() => undefined);
        void loadDmNicknames().catch(() => undefined);
        void loadSupervision().catch(() => undefined);
        // For guilds the user has already opened (their channel list
        // or member list has been loaded), refresh both. This is what
        // makes the cousin-joined-but-invisible symptom go away: the
        // GUILD_MEMBER_ADD we missed is recovered by re-pulling the
        // full member list. Channel-list refresh covers permission
        // changes that fired CHANNEL_CREATE / CHANNEL_DELETE during
        // the gap. The keys-iteration uses stateRef (not state) so
        // we read the live value at call time, not the stale closure
        // value from when this handler was registered.
        const loaded = stateRef.current;
        const channelGuildIds = Object.keys(loaded.channelsByGuild);
        for (const gid of channelGuildIds) {
          void loadChannels(gid).catch(() => undefined);
        }
        const memberGuildIds = Object.keys(loaded.membersByGuild);
        for (const gid of memberGuildIds) {
          void loadMembers(gid).catch(() => undefined);
        }
        // Roles have no reconnect heal of their own — GUILD_ROLE_UPDATE is
        // handled live above, but a role edit missed during the drop would
        // otherwise stay stale forever (mount-time loadRoles is guarded on
        // absence). Refetch only guilds whose role list was actually loaded.
        const roleGuildIds = Object.keys(loaded.rolesByGuild);
        for (const gid of roleGuildIds) {
          void loadRoles(gid).catch(() => undefined);
        }
        // Heal the OPEN conversation's message window. Everything above
        // refetches DMs/guilds/read-states/members/roles but NOT the open
        // channel's messages — so any edit / delete / reaction / read-receipt
        // that landed on an ALREADY-LOADED row during the drop stays stale
        // until a page reload. A fresh IDENTIFY replays none of those events,
        // and neither MessageView's refreshChannelLatest (append-merge, dedups
        // by id) nor the after-cursor reconcileChannel can fix a row they
        // already hold — only the around-window REPLACE can. Note this is
        // complementary to, not a duplicate of, the tab-focus/visibility
        // catch-up in MessageView: that path recovers MISSED MESSAGES on
        // focus, this one heals MUTATED ROWS on reconnect, and the two
        // converge on the same server tail if they overlap.
        //
        // AppState doesn't track the active channel, so derive it from the
        // route (the router encodes it as the last segment of
        // /channels/<...>/<channelId>). Guard on the channel actually being
        // loaded so this only ever REPLACES a window the user is looking at.
        const openChannelId =
          typeof window !== 'undefined'
            ? window.location.pathname.match(/\/channels\/[^/]+\/([^/?#]+)/)?.[1] ?? null
            : null;
        if (openChannelId && loaded.messagesByChannel[openChannelId]?.length) {
          void resyncChannelWindow(openChannelId).catch(() => undefined);
        }
      }),
    );

      return unsubs;
    },
    [
      user,
      token,
      loadChannels,
      loadMembers,
      loadRoles,
      refreshGuilds,
      loadDMs,
      loadReadStates,
      loadNotificationOverrides,
      loadRelationships,
      loadDmNicknames,
      loadSupervision,
      toasts.push,
      restForChannel,
      resyncChannelWindow,
    ],
  );

  // Backbone gateway: subscribe for the auth session (unchanged behavior).
  //
  // NOTE: we deliberately do NOT reset readyOnceRef here. This effect re-runs
  // on every `token` refresh (~15 min) and on every self-user object churn
  // (status / custom-status / settings changes replace the `user` object),
  // neither of which is a new session. Resetting the flag here made the NEXT
  // fresh-IDENTIFY READY skip the full resync (it saw readyOnceRef===false,
  // marked it true, and returned early), so any events missed during the drop
  // — member adds, presence, channel create/delete, unread — were never
  // reconciled. React runs cleanup + re-subscribe synchronously in the same
  // commit (no gap that drops WS frames) and gateway.on replays no cached
  // READY, so leaving the flag true across a re-subscribe is correct. The flag
  // is reset only on a genuine login/logout identity flip by the effect below.
  useEffect(() => {
    if (!token || !user) return;
    const unsubs = subscribeGateway(gateway);
    return () => {
      for (const u of unsubs) u();
    };
  }, [gateway, token, user, subscribeGateway]);

  // Reset the first-READY flag ONLY on a genuine login/logout (the stable user
  // id flips), never on token rotation or self-user-object patches. A fresh
  // session must run the full bootstrap on its first READY; a mere reconnect
  // within a session must run the reconnect resync.
  useEffect(() => {
    return () => {
      readyOnceRef.current = false;
    };
  }, [user?.id]);

  const clearPokePill = useCallback((channelId: string) => {
    dispatch({ type: 'POKE_PILL_CLEAR', channelId });
  }, []);

  const value = useMemo<AppStateValue>(
    () => ({
      state,
      clearPokePill,
      refreshGuilds,
      loadChannels,
      restForGuild,
      restForChannel,
      applyChannelReorder,
      loadMessages,
      loadMessagesAround,
      reconcileChannel,
      refreshChannelLatest,
      loadOlderMessages,
      loadMembers,
      loadRoles,
      loadGuildEvents,
      loadDMs,
      loadReadStates,
      ackChannel,
      sendMessageOptimistic,
      retrySendMessage,
      discardFailedMessage,
      loadNotificationOverrides,
      setNotificationOverride,
      loadRelationships,
      loadDmNicknames,
      setDmNickname,
      reloadSupervision: loadSupervision,
      applyRelationship,
      replaceUser,
      mergeChannelVoiceStates,
      toggleSavedMessage,
      hydrateSavedMembership,
      setPollLocal,
    }),
    [
      state,
      refreshGuilds,
      loadChannels,
      restForGuild,
      restForChannel,
      applyChannelReorder,
      loadMessages,
      loadMessagesAround,
      reconcileChannel,
      refreshChannelLatest,
      loadOlderMessages,
      loadMembers,
      loadRoles,
      loadGuildEvents,
      loadDMs,
      loadReadStates,
      ackChannel,
      clearPokePill,
      sendMessageOptimistic,
      retrySendMessage,
      discardFailedMessage,
      loadNotificationOverrides,
      setNotificationOverride,
      loadRelationships,
      loadDmNicknames,
      setDmNickname,
      applyRelationship,
      replaceUser,
      mergeChannelVoiceStates,
      toggleSavedMessage,
      hydrateSavedMembership,
      setPollLocal,
      loadSupervision,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState() must be used inside <AppStateProvider>');
  return ctx;
}

/**
 * Selector-aware companion to useAppState. The selector function runs
 * against the full AppStateValue (which includes `state` and every
 * loader/mutator callback) and the consuming component only re-renders
 * when the selector's returned value changes by reference equality.
 *
 * Why this exists: useAppState() re-renders every consumer on every
 * dispatch — the context value is memoized only on `state`, so any
 * reducer action fans a new value to every component subscribing
 * through useAppState. The default React context behavior is "any
 * change to the context value re-renders every consumer," and there's
 * no way around that without a selector library. For most components
 * this is fine, but for high-volume row components (MessageItem
 * rendered once per visible message; member rows in MemberList) it
 * causes app-wide re-render storms on every typing indicator,
 * presence event, or any other minor state mutation.
 *
 * Selector design notes:
 *  - The selector receives the WHOLE AppStateValue, not just `state`.
 *    Loaders and mutators are also on the value, so consumers can
 *    select { send: v.sendMessageOptimistic, msgs: v.state.messagesByChannel[id] }
 *    in one call if needed.
 *  - Reference equality is the default comparison. If your selector
 *    returns a fresh object each time (e.g. {a: state.x, b: state.y})
 *    the component will still re-render on every state change, which
 *    defeats the optimization. Prefer multiple separate
 *    useAppStateSelector calls — each one tracks its own slice
 *    independently — over one selector that builds a composite.
 *  - The reducer must do immutable updates (it does, mostly) so that
 *    unchanged slices keep the same reference. The PRESENCE_PATCH
 *    and USER_REPLACE bail-early fixes (#11a, #11b) are what make
 *    selector subscriptions actually skip re-renders on no-op events.
 */
export function useAppStateSelector<T>(selector: (v: AppStateValue) => T): T {
  // The selector receives AppStateValue (not the AppStateValue | null
  // declared on the context) because every render path that mounts a
  // component using this hook is gated by AuthContext on the provider
  // being present. We narrow at the call boundary with a single
  // non-null assertion. Passing a wrapper that does the null check
  // confuses TypeScript's inference of T through the nested function,
  // which is why we don't do that — the slot-type assertion keeps
  // the selector's return type flowing through cleanly.
  return useContextSelector(AppStateContext, (v) => selector(v as AppStateValue));
}

/**
 * The viewer's personal DM nickname for a user, or undefined. Apply ONLY in
 * DM contexts — the caller decides it's a DM before substituting the name.
 */
export function useDmNickname(userId: string | null | undefined): string | undefined {
  return useAppStateSelector((v) => (userId ? v.state.dmNicknames[userId] : undefined));
}

/** The full personal DM-nickname map (for sites resolving several ids at once). */
export function useDmNicknames(): Record<string, string> {
  return useAppStateSelector((v) => v.state.dmNicknames);
}

/**
 * True if the given channel has new messages the user hasn't acked yet.
 *
 * Definition: channel.lastMessageId > readState.lastMessageId. A channel
 * with no readState row at all (user has never opened it) is considered
 * unread iff it has any messages — i.e. lastMessageId !== null.
 *
 * Snowflakes are monotonic time-ordered IDs, so a numeric comparison
 * (BigInt) is sufficient — no clock skew or per-host ordering issues.
 */
/**
 * Whether a 1:1 DM's E2EE must be suppressed because the current user is
 * a supervised child and the peer is NOT one of their parents. A
 * supervised child's DMs are plaintext so the parent can review them;
 * DMs with the parent themselves stay encrypted and private. Returns
 * false for everyone who isn't a supervised child.
 */
export function dmE2eeSuppressed(
  supervision: FamilySummary | null,
  channel: Channel,
): boolean {
  if (!supervision || supervision.supervisedBy.length === 0) return false;
  const peerId =
    channel.recipients && channel.recipients[0] ? channel.recipients[0].id : null;
  // Unknown peer → suppress (safer: keeps it monitorable rather than
  // silently encrypting around supervision).
  if (!peerId) return true;
  const parentIds = new Set(supervision.supervisedBy.map((p) => p.id));
  return !parentIds.has(peerId);
}

export function isChannelUnread(
  channel: Channel,
  readStates: Record<string, ReadState>,
): boolean {
  if (!channel.lastMessageId) return false;
  const rs = readStates[channel.id];
  if (!rs || !rs.lastMessageId) return true;
  // Both should be snowflakes (pure digit strings) but guard anyway —
  // a stale optimistic placeholder leaking into either side would
  // crash BigInt(). Treat invalid ids as "not unread" so we don't
  // surface a phantom unread badge on a misbehaving row.
  if (!/^\d+$/.test(channel.lastMessageId) || !/^\d+$/.test(rs.lastMessageId)) {
    return false;
  }
  return BigInt(channel.lastMessageId) > BigInt(rs.lastMessageId);
}

/** Mention count for a channel (0 if no read state row). */
export function channelMentionCount(
  channelId: string,
  readStates: Record<string, ReadState>,
): number {
  return readStates[channelId]?.mentionCount ?? 0;
}

/** Every voice state currently in the given channel. Takes the
 *  `voiceStatesByUser` map directly (not the whole `State`) so callers on
 *  the selector hook can pass just that slice without subscribing to all
 *  of state. */
export function voiceStatesForChannel(
  voiceStatesByUser: Record<string, VoiceState>,
  channelId: string,
): VoiceState[] {
  const out: VoiceState[] = [];
  for (const v of Object.values(voiceStatesByUser)) {
    if (v.channelId === channelId) out.push(v);
  }
  return out;
}

/** This user's current voice state, if any. Takes the `voiceStatesByUser`
 *  map directly (see voiceStatesForChannel). */
export function selfVoiceState(
  voiceStatesByUser: Record<string, VoiceState>,
  selfUserId: string | undefined,
): VoiceState | null {
  if (!selfUserId) return null;
  return voiceStatesByUser[selfUserId] ?? null;
}

// ── Notification ping ──────────────────────────────────────────────────────
//
// We use the Web Audio API to synthesize a short two-note chime instead of
// shipping an audio asset. Browsers gate AudioContext creation behind a
// user gesture — first call in a fresh tab may silently fail before the
// user has interacted with the page. That's fine: the mention badge in
// the rail is the authoritative signal; the ping is a redundancy.
//
// We rate-limit to one ping per second so a burst of mentions doesn't
// produce a chord.

let audioCtx: AudioContext | null = null;
let lastPingAt = 0;

function playMentionPing(): void {
  // Delegate to the shared sound library so message + call sounds share
  // one AudioContext and one implementation. Kept as a thin wrapper so
  // the existing call sites don't change.
  void audioCtx;
  void lastPingAt;
  playMessagePing();
}

// ── Aggregate selectors ────────────────────────────────────────────────────

/**
 * Sum of mention counts across every channel the user has access to.
 * Used to drive the document title prefix `(N) Zekktris` so the user
 * sees mention counts in the browser tab even when Zekktris isn't
 * focused. Excludes the currently-active channel since the user is
 * presumably reading it (and the gateway will ack-clear the count
 * imminently anyway).
 */
export function totalMentionCount(
  readStates: Record<string, ReadState>,
  exceptChannelId?: string,
): number {
  let total = 0;
  for (const [channelId, rs] of Object.entries(readStates)) {
    if (channelId === exceptChannelId) continue;
    total += rs.mentionCount;
  }
  return total;
}

// ── Notification override resolution ────────────────────────────────────────

export type NotificationLevel = 'all' | 'mentions' | 'nothing';

/**
 * Resolve the effective notification level for a channel using the
 * client's cached overrides. Mirrors the server-side resolution rule
 * (channel > guild > default 'all'). Used by:
 *   - DMList / ChannelList: skip unread badge increments for muted
 *     channels (level === 'nothing')
 *   - totalMentionCount: optionally skip muted channels
 *   - GuildInfoCard / ChannelEditModal: render the current toggle state
 *
 * The override map is keyed `${type}:${id}` and lives on State; this
 * selector takes the map directly so it's cheap to call from selectors
 * that already have the map in scope.
 */
export function effectiveNotificationLevel(
  overrides: Record<string, NotificationLevel>,
  channelId: string,
  guildId: string | null,
): NotificationLevel {
  const channel = overrides[`channel:${channelId}`];
  if (channel) return channel;
  if (guildId) {
    const guild = overrides[`guild:${guildId}`];
    if (guild) return guild;
  }
  return 'all';
}

/**
 * Convenience predicate — is the channel muted? Equivalent to
 * `effectiveNotificationLevel(...) === 'nothing'` but reads cleaner at
 * call sites that just want a boolean.
 */
export function isChannelMuted(
  overrides: Record<string, NotificationLevel>,
  channelId: string,
  guildId: string | null,
): boolean {
  return effectiveNotificationLevel(overrides, channelId, guildId) === 'nothing';
}

/**
 * Is the given user blocked by the current user? Looked up from the
 * cached relationships list, so this is O(n) but n is tiny in practice
 * (relationships scale with the user's social graph). Used by
 * MessageItem to collapse messages from blocked authors.
 */
export function isUserBlocked(
  relationships: State['relationships'],
  userId: string,
): boolean {
  return relationships.some((r) => r.type === 'blocked' && r.user.id === userId);
}


/**
 * Return dmChannels with `userId`'s recipient status updated, or the SAME
 * array reference when nothing changed (so memoized consumers skip work).
 * Presence events are the hottest gateway traffic; the identity-preserving
 * fast path matters.
 */
function patchDmRecipientStatus(
  dmChannels: Channel[],
  userId: string,
  status: PublicUser['status'],
): Channel[] {
  let next: Channel[] | null = null;
  for (let i = 0; i < dmChannels.length; i++) {
    const c = dmChannels[i]!;
    const rIdx = c.recipients ? c.recipients.findIndex((r) => r.id === userId) : -1;
    if (rIdx === -1 || c.recipients![rIdx]!.status === status) continue;
    const recipients = c.recipients!.slice();
    recipients[rIdx] = { ...recipients[rIdx]!, status };
    if (!next) next = dmChannels.slice();
    next[i] = { ...c, recipients };
  }
  return next ?? dmChannels;
}
