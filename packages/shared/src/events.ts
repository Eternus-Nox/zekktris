/**
 * Gateway protocol — WebSocket events and opcodes
 * -------------------------------------------------
 * Frame shape: { op, t?, d, s? }
 *   op : opcode (see GatewayOp)
 *   t  : event type (only for op=DISPATCH)
 *   d  : payload data
 *   s  : sequence number (server→client DISPATCH only; used for RESUME)
 *
 * Heartbeat: every interval ms (sent in HELLO), the client must send
 * { op: HEARTBEAT, d: <last seq> }. Server replies HEARTBEAT_ACK.
 *
 * The handshake is:
 *   server → HELLO
 *   client → IDENTIFY (with access token)
 *   server → DISPATCH READY (or fresh READY → INVALID_SESSION)
 *
 * If a client disconnects, on reconnect they may send RESUME with their
 * session_id and last seq number. If the server still has the buffer, it
 * replays missed events. Otherwise it sends INVALID_SESSION and the client
 * must IDENTIFY again.
 */

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RESUME: 4,
  RECONNECT: 5,
  INVALID_SESSION: 6,
  HELLO: 7,
  HEARTBEAT_ACK: 8,
} as const;

export type GatewayOpCode = (typeof GatewayOp)[keyof typeof GatewayOp];

/** All event types that the server may DISPATCH. */
export const GatewayEvent = {
  READY: 'READY',
  RESUMED: 'RESUMED',

  // Messages
  MESSAGE_CREATE: 'MESSAGE_CREATE',
  MESSAGE_UPDATE: 'MESSAGE_UPDATE',
  MESSAGE_DELETE: 'MESSAGE_DELETE',
  MESSAGE_DELETE_BULK: 'MESSAGE_DELETE_BULK',
  MESSAGE_REACTION_ADD: 'MESSAGE_REACTION_ADD',
  MESSAGE_REACTION_REMOVE: 'MESSAGE_REACTION_REMOVE',
  MESSAGE_REACTION_REMOVE_ALL: 'MESSAGE_REACTION_REMOVE_ALL',

  // Channels
  CHANNEL_CREATE: 'CHANNEL_CREATE',
  CHANNEL_UPDATE: 'CHANNEL_UPDATE',
  CHANNEL_DELETE: 'CHANNEL_DELETE',
  CHANNEL_PINS_UPDATE: 'CHANNEL_PINS_UPDATE',

  // Guilds
  GUILD_CREATE: 'GUILD_CREATE',
  GUILD_UPDATE: 'GUILD_UPDATE',
  GUILD_DELETE: 'GUILD_DELETE',

  // Members
  GUILD_MEMBER_ADD: 'GUILD_MEMBER_ADD',
  GUILD_MEMBER_UPDATE: 'GUILD_MEMBER_UPDATE',
  GUILD_MEMBER_REMOVE: 'GUILD_MEMBER_REMOVE',
  GUILD_MEMBERS_CHUNK: 'GUILD_MEMBERS_CHUNK',

  // Bans
  GUILD_BAN_ADD: 'GUILD_BAN_ADD',
  GUILD_BAN_REMOVE: 'GUILD_BAN_REMOVE',

  // Roles
  GUILD_ROLE_CREATE: 'GUILD_ROLE_CREATE',
  GUILD_ROLE_UPDATE: 'GUILD_ROLE_UPDATE',
  GUILD_ROLE_DELETE: 'GUILD_ROLE_DELETE',

  // Custom emoji — single bulk-update event covers create/rename/delete
  // because the client always re-keys its emoji index off the freshly-
  // delivered list. Keeping it as one event keeps the dispatcher thin
  // and avoids a 3:1 multiplier on a low-frequency change type.
  GUILD_EMOJIS_UPDATE: 'GUILD_EMOJIS_UPDATE',
  /** Same shape as GUILD_EMOJIS_UPDATE — one bulk-replace event per
      guild whenever a sticker is created, renamed, re-described, or
      deleted. Clients re-key their sticker index off the delivered
      list. */
  GUILD_STICKERS_UPDATE: 'GUILD_STICKERS_UPDATE',

  // Stage channels — bulk replace of the participant list whenever
  // anyone joins, leaves, raises a hand, or the moderator promotes /
  // demotes someone. Same lifecycle as GUILD_EMOJIS_UPDATE: clients
  // re-key their per-channel state from the delivered list.
  STAGE_PARTICIPANTS_UPDATE: 'STAGE_PARTICIPANTS_UPDATE',

  // Presence / typing
  TYPING_START: 'TYPING_START',
  // Payload: { user_id, status, guild_id } — `status` is the EFFECTIVE
  // presence, 'invisible' masked as 'offline'. One frame per shared guild
  // (guild_id set) plus one guild_id=null frame for DM peers, friends and,
  // on a server with features.presence_activity, the user's OWN connections
  // (so each of their devices shows their current effective dot). That
  // frame to the user's own connections (guild_id=null) also carries
  // `chosen_status` — what they picked, unmasked — so a pick made on one
  // device reaches the status pickers of the others. No one else ever gets
  // `chosen_status`.
  PRESENCE_UPDATE: 'PRESENCE_UPDATE',

  // Poke / nudge — an EPHEMERAL notification (no stored message, no history).
  // Payload: { channel_id, poke_type, emoji, initiator_id, initiator_name }.
  // Sent to the DM channel audience; the recipient's clients surface it
  // transiently (a toast on phone/web, a big-emoji flash + haptic on the
  // watch). The sender is skipped client-side via initiator_id. A backgrounded
  // recipient gets the big-emoji push instead.
  POKE: 'POKE',

  // User
  USER_UPDATE: 'USER_UPDATE',

  // Relationships (friends / blocks)
  RELATIONSHIP_ADD: 'RELATIONSHIP_ADD',
  RELATIONSHIP_UPDATE: 'RELATIONSHIP_UPDATE',
  RELATIONSHIP_REMOVE: 'RELATIONSHIP_REMOVE',

  // Read state
  CHANNEL_ACK: 'CHANNEL_ACK',

  // Voice. A single combined event covers join (state appears with
  // channelId), update (mute/deafen flags change), and leave (state's
  // channelId is null). The client mirrors that into its presence map.
  VOICE_STATE_UPDATE: 'VOICE_STATE_UPDATE',

  // DM auto-delete TTL changed. Payload: { channelId, ttlSecondsAfterRead }.
  // Sent to both recipients of the DM so each side's settings UI
  // reflects the change in real time across all connected tabs.
  DM_SETTINGS_UPDATE: 'DM_SETTINGS_UPDATE',

  // 1:1 DM messaging streak changed. Payload: { channel_id, streak }. Sent to
  // both recipients when the credited streak value moves (at most once per
  // day per channel) so the streak chip updates live instead of only after
  // the next DM-list fetch / app relaunch.
  DM_STREAK_UPDATE: 'DM_STREAK_UPDATE',

  // A new achievement was just unlocked by the current user. Sent ONLY to that
  // user's own connections (user audience) so the app can pop a celebratory
  // in-app toast/banner in real time. Payload: { id, name, description, marker }.
  ACHIEVEMENT_UNLOCK: 'ACHIEVEMENT_UNLOCK',

  // DM read-receipt events. Both fire only on 1:1 DMs where the
  // recipient has dmReadReceiptsEnabled=true; suppressed otherwise.
  //
  // MESSAGE_DELIVERED fires when the recipient's first gateway
  // connection receives the original MESSAGE_CREATE — i.e. the
  // message physically landed on a recipient device. Audience: the
  // message author only. Payload: { channelId, messageIds[], deliveredAt }.
  //
  // MESSAGE_VIEWED fires when the recipient opens the channel and
  // lists the messages (the listMessages route stamps viewed_at).
  // Audience: the message author only. Payload: { channelId,
  // messageIds[], viewedAt }.
  //
  // Both are batched by (channelId, author) so a list page that
  // reads 30 unread messages produces ONE event with 30 ids rather
  // than 30 separate events.
  MESSAGE_DELIVERED: 'MESSAGE_DELIVERED',
  MESSAGE_VIEWED: 'MESSAGE_VIEWED',

  // MESSAGE_POLL_UPDATE — focused delta for a poll's state changing
  // without re-broadcasting the whole message. Currently fired by
  // the poll expiry sweep when a poll's closed_at flips, but the
  // shape (pollId + closedAt + channel/message refs) generalizes
  // to any sub-message poll-only update.
  //
  // Audience: channel viewers. Payload:
  //   { channelId, messageId, pollId, closedAt }
  // Client reducer locates the message and patches the poll's
  // closedAt; no other fields touched.
  //
  // Used instead of MESSAGE_UPDATE for poll-only deltas because
  // building the full message DTO (author + reactions + mentions
  // + poll-with-options-and-counts) per closure is wasteful when
  // only one field actually changed.
  MESSAGE_POLL_UPDATE: 'MESSAGE_POLL_UPDATE',

  // Scheduled events. Three discrete events rather than a single
  // bulk update — events change one at a time (admins create one,
  // sweep transitions a few per tick), so per-event delta payloads
  // keep the wire traffic small without complicating the dispatcher.
  // Audience: all members of the event's guild.
  //
  // SCHEDULED_EVENT_CREATE — admin POSTed a new event. Payload:
  // the ScheduledEventDTO. Clients prepend or sort-merge into their
  // local cache.
  //
  // SCHEDULED_EVENT_UPDATE — admin PATCHed an event, OR the server's
  // status sweep flipped scheduled→active or active→completed.
  // Payload: the (updated) ScheduledEventDTO. Note: rsvpCounts/
  // myRsvp are omitted from this delivery — the broadcast goes to
  // every guild member, and myRsvp is per-recipient. Clients
  // preserve their existing local rsvpCounts/myRsvp on apply.
  //
  // SCHEDULED_EVENT_DELETE — admin hard-deleted (or cascade from
  // guild delete). Payload: { eventId, guildId }. Clients remove
  // from local cache.
  SCHEDULED_EVENT_CREATE: 'SCHEDULED_EVENT_CREATE',
  SCHEDULED_EVENT_UPDATE: 'SCHEDULED_EVENT_UPDATE',
  SCHEDULED_EVENT_DELETE: 'SCHEDULED_EVENT_DELETE',

  // Parental controls. The first two are scoped to a single parent
  // (kind:'user') so live updates reach the supervising account without
  // polling.
  //
  // FAMILY_REQUEST_CREATE — a supervised child asked the parent to
  // approve adding a friend or joining a server. Payload:
  //   { childId, childName, kind: 'friend' | 'guild', label }
  // FAMILY_FLAG_CREATE — a watch word matched in a message the child
  // sent or received. Payload:
  //   { childId, childName, matchedWord, direction }
  // Clients show a notification and refresh the relevant Family view.
  FAMILY_REQUEST_CREATE: 'FAMILY_REQUEST_CREATE',
  FAMILY_FLAG_CREATE: 'FAMILY_FLAG_CREATE',

  // FAMILY_SUPERVISION_UPDATE — the SUBJECT's own supervision state
  // changed: a guardian edited their restrictions, a link was accepted
  // or ended, a server was blocked/unblocked for them, or the age sweep
  // released them at 18. Audience is the subject alone (kind:'user') —
  // it carries no guardian identity and is never sent to the parent.
  //
  // Payload (see FamilySupervisionUpdate in @zekktris/client):
  //   { restrictions, supervised, isMinor, restrictedHeavily, blockedGuildIds }
  // `restrictions` is the same effective-restrictions object GET
  // /family/me returns (null = unrestricted), so a client can re-apply
  // every local supervision gate from the frame alone. Clients that also
  // render the guardian list should refetch /family/me on receipt —
  // guardians are deliberately absent from this payload.
  //
  // Latency matters here: without it a revoked restriction only took
  // effect on the child's device after a cold start.
  FAMILY_SUPERVISION_UPDATE: 'FAMILY_SUPERVISION_UPDATE',
} as const;

export type GatewayEventName = (typeof GatewayEvent)[keyof typeof GatewayEvent];

/** Generic frame envelope. */
export interface GatewayFrame<T = unknown> {
  op: GatewayOpCode;
  d?: T;
  t?: GatewayEventName;
  s?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Specific frame payload shapes (client → server)
// ───────────────────────────────────────────────────────────────────────────

/**
 * A device's activity, as its client reports it: `active` while the person is
 * using this device (input within the client's idle threshold, app/tab in the
 * foreground, or the desktop shell's system-wide signal), false once they
 * stop. The server derives the user's effective presence from every live
 * connection's activity: chosen 'online' reads 'online' if ANY device is
 * active, else 'idle'. A connection that never reports counts as active.
 */
export interface PresenceActivity {
  active: boolean;
}

export interface IdentifyPayload {
  token: string;
  /** Optional: client info, used for session display. */
  properties?: {
    os?: string;
    browser?: string;
    device?: string;
  };
  /** This device's activity at connect time. Omitted = active (legacy). */
  presence?: PresenceActivity;
}

export interface ResumePayload {
  token: string;
  session_id: string;
  seq: number;
  /** This device's activity now. Omitted = keep the resumed session's value. */
  presence?: PresenceActivity;
}

export interface HeartbeatPayload {
  /** Last sequence number the client received. */
  seq: number | null;
}

/**
 * Client → server PRESENCE_UPDATE (op 3): `d: { active }`. Send it on each
 * local active↔idle transition and never otherwise — the server ignores a
 * repeat of the connection's current value and applies at most one change per
 * connection every 2 s (a faster flip is coalesced, latest value wins). Only
 * send it to a server whose READY carried `features.presence_activity`.
 * The user's CHOSEN status is not set here; that is PATCH /users/@me {status}.
 */
export type PresenceUpdatePayload = PresenceActivity;

// ───────────────────────────────────────────────────────────────────────────
// Specific frame payload shapes (server → client)
// ───────────────────────────────────────────────────────────────────────────

export interface HelloPayload {
  /** How often the client must heartbeat, in milliseconds. */
  heartbeat_interval: number;
}

export interface InvalidSessionPayload {
  /** If true, the client may RESUME. If false, must re-IDENTIFY from scratch. */
  resumable: boolean;
}

export interface TypingStartPayload {
  channel_id: string;
  user_id: string;
  guild_id?: string;
  timestamp: number;
}

/**
 * The full READY payload — what the client receives right after IDENTIFY.
 * Concrete typed in the API package once the entity DTOs are finalized; here
 * we use the loose shape so this file has zero dependencies.
 */
export interface ReadyPayload {
  session_id: string;
  user: unknown; // UserSelfDTO
  guilds: unknown[]; // GuildDTO[]
  private_channels: unknown[]; // DM/GroupDM DTOs
  relationships: unknown[]; // RelationshipDTO[]
  read_state: unknown[]; // ReadStateDTO[]
  /** Server capabilities. Absent on servers older than the flag itself, so a
   *  client must treat a missing object / key as "not supported". */
  features?: ReadyFeatures;
}

export interface ReadyFeatures {
  /** The server derives presence from per-device activity: clients report it
   *  (IDENTIFY/RESUME `presence`, op 3 PRESENCE_UPDATE) and must NOT PATCH
   *  /users/@me {status} automatically; a status the user picks is PATCHed
   *  with `statusSource: 'manual'` (an unmarked 'idle' is treated as a
   *  pre-update client's automatic away and ends when an updated device reports
   *  itself in use, or when the user's last device disconnects). The self user carries `chosenStatus` (the pick; `status`
   *  is the same value, for older clients) and `effectiveStatus` (what others
   *  see, until the first self PRESENCE_UPDATE frame). */
  presence_activity?: true;
}
