/**
 * Wire-format types
 * -----------------
 * These mirror the JSON shapes the server actually emits. Snowflake ids are
 * always decimal strings on the wire; the server's BigInt-to-string
 * conversion in lib/dto.ts is what produces them. We don't reify them back
 * into BigInt on the client because string equality is fine for keying React
 * lists and we never do arithmetic on them.
 *
 * Subset for v1 UI: only the fields the client actually reads. If a field
 * exists on the server but isn't here, the client just ignores it (extra
 * keys on JSON.parse are harmless). When new UI features need more fields,
 * add them here without coupling to the server's full DTO surface.
 */

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Cosmetic avatar decoration id (CSS ring/glow). Null = none. */
  avatarDecoration?: string | null;
  /** Whether the current viewer may DM / ring this user under the target's
      privacy policy (friend, or server-member opt-in + a shared guild). Only
      populated by the single-profile fetch (GET /users/:id); undefined on
      list-derived users. The profile card uses it to gate Message + Call. */
  canMessage?: boolean;
  /** Supporter tier title (Scout/Guardian/Legend). Only populated by the
      single-profile fetch; null when the user has no membership or opted out
      of showing it. */
  subscriptionTier?: 'scout' | 'guardian' | 'legend' | null;
  /** Optional on PublicUser because most surfaces (member lists,
      message authors) don't carry banners — they're fetched on
      demand when the profile card opens. SelfUser narrows this
      to a required nullable since /users/@me always returns it. */
  bannerUrl?: string | null;
  /** Free-form "about me" bio shown on the profile card. The server sends it
      in the public DTO; optional here because list-derived users omit it
      (fetched on demand when the profile card opens). */
  bio?: string | null;
  status: 'online' | 'idle' | 'dnd' | 'offline' | 'invisible';
  customStatus: string | null;
  /** Emoji alongside the custom status text. Independent — text-only,
      emoji-only, or both are all valid combinations. */
  customStatusEmoji?: string | null;
  /** Optional auto-clear time (ISO 8601). The client renders the
      status as cleared once this passes, even before the server
      updates the row. */
  customStatusExpiresAt?: string | null;
  /** E2EE identity public key (X25519, base64-encoded). Null when the
      user has not yet generated a keypair; senders fall back to
      plaintext for users with no key. Optional for back-compat with
      sessions issued before the column existed. */
  publicKey?: string | null;
  /** True for bot accounts. Drives the BOT badge. Optional for
      back-compat with payloads serialized before bots existed;
      treat missing as false. */
  isBot?: boolean;
  /** Custom name tag ("clan tag") rendered IN FRONT of the name —
      label-only (≤4 chars). Renders only when a label is set. tagColor is a
      #rrggbb hex (defaults to accent when null). */
  tagLabel?: string | null;
  tagColor?: string | null;
  /** Instance staff role. Present (and true) only for administrators /
      moderators — regular members omit both. Drives the subtle staff badge
      next to the name. Admin takes precedence when both are somehow set. */
  isAdmin?: boolean;
  isModerator?: boolean;
  /** Staff "shimmer" color (#rrggbb). Present only for instance staff who set
      one; makes the display name shimmer in this color, overriding role colors.
      On SelfUser it's always present (null = off) so the settings toggle
      pre-fills. */
  staffColor?: string | null;
  /** Optional soft glow layered on the staff shimmer. Present (with staffColor)
      only for staff; on SelfUser it's always present so the toggle pre-fills. */
  staffGlow?: boolean;
}

/** A single entry in a DM's poke history (newest-first, capped at 6),
    returned by GET /channels/:id/pokes. */
export interface PokeHistoryEntry {
  id: string;
  /** poke | heart | wave | like | fire. */
  pokeType: string;
  /** The poker's user id (stringified BigInt). */
  initiatorId: string;
  /** Who was poked (the current user, for received-poke history). */
  recipientId: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** The poker's display name (username fallback). */
  initiatorName: string;
}

/** A bot account owned by the current user. Like a PublicUser but with
    the owner id. Bots authenticate via a static token (returned only at
    create/regenerate, never on this DTO). */
export interface Bot extends PublicUser {
  botOwnerId: string | null;
  /** Configured event callback URL, or null if the bot has no event
      subscription. The signing secret is never included here. */
  botEventUrl?: string | null;
}

/** A slash-command registered on a bot (owner view). */
export interface BotCommand {
  id: string;
  botId: string;
  /** null = global; otherwise scoped to this guild. */
  guildId: string | null;
  name: string;
  description: string;
  createdAt: string;
}

/** A command available in a guild (composer slash-picker view). */
export interface GuildCommand {
  id: string;
  botId: string;
  botName: string;
  name: string;
  description: string;
}

export interface SelfUser extends PublicUser {
  email: string;
  /** Whether the account's email has been confirmed. Drives the
      verify-email gate when the deployment requires verification. */
  emailVerified: boolean;
  bio: string | null;
  bannerUrl: string | null;
  locale: string;
  /** Instance-level admin flag (server operator). When true the
      client surfaces the /admin route; when false /admin renders an
      "access denied" message because the API will reject the
      requests anyway. */
  isAdmin?: boolean;
  /** Instance moderator — restricted staff subset of the admin panel
      (security log, ban/unban, sign-out, capped gifting, DOB reset,
      server observe). */
  isModerator?: boolean;
  /** Whether the user's achievements shelf is visible to others. */
  achievementsPublic?: boolean;
  /** Account-level toggle for achievement-unlock notifications (push + in-app). */
  notifyAchievements?: boolean;
  /** Account-level toggle for reaction notifications (push when someone reacts
      to your message). */
  notifyReactions?: boolean;
  /** Per-user guild rail ordering. Null = no preference; client falls
      back to the natural order returned by `listGuilds`. Authoritative
      across devices — written by `setGuildOrder`. Optional in the
      type for back-compat with stored sessions from older builds. */
  guildOrder?: string[] | null;
  /** Per-user rail folders. Each folder is a named, optionally colored
      container that bundles some of the user's guilds. The folder's
      position in the rail is derived from its first contained guild's
      position. Optional in the type for back-compat with sessions
      issued before the column existed (server defaults to []). */
  guildFolders?: GuildFolder[];
  /** DM read-receipts opt-out. When false, the server suppresses
      delivered_at/viewed_at stamping for messages this user receives,
      and the sender's UI shows "Sent" forever on those DMs. Default
      true. Toggle via `updateMe({ dmReadReceiptsEnabled })`. Optional
      for back-compat with sessions issued before the column existed. */
  dmReadReceiptsEnabled?: boolean;
  /** Privacy: when true, anyone who shares a guild with this user can
      DM and 1:1 call this user. When false (default), only friends can.
      Toggle via `updateMe({ allowDmsFromServerMembers })`. Optional for
      back-compat with sessions from before the column existed. */
  allowDmsFromServerMembers?: boolean;
  /** The account's date of birth (YYYY-MM-DD), or null for a legacy account
      that never set one. Self-only. */
  dateOfBirth?: string | null;
  /** True while the user may still change their own DOB (unlocked). Drives the
      one-time "confirm your date of birth" prompt. Locked (false) at signup and
      after the one self-change; an admin can reopen it. */
  canChangeDob?: boolean;
  /** Whether the supporter tier title shows on the profile popup. */
  showSubscriptionTier?: boolean;
  /** Effective supporter membership (own or inherited from a supervising
      parent). Null/undefined = none → Appearance perks locked. */
  subscriptionTier?: 'scout' | 'guardian' | 'legend' | null;
  /** Membership expiry (ISO); null = unlimited/forever. */
  subscriptionExpiresAt?: string | null;
  /** True when the membership is inherited from a supervising parent. */
  subscriptionInherited?: boolean;
  /** Whether the tier TITLE applies. False for founder (grandfathered)
      memberships — perks without a title until a tier is chosen. */
  subscriptionTitled?: boolean;
  /** 'gift' | 'founder' | 'stripe'. "Manage subscription" (Stripe portal)
      shows only for own stripe memberships. */
  subscriptionSource?: string | null;
  /** Own stripe membership scheduled to end at subscriptionExpiresAt (the user
      cancelled). Settings shows "Cancels on <date> · Resume" when true. */
  subscriptionCancelAtPeriodEnd?: boolean;
  createdAt: string;
}

/** A single rail folder definition. Stored server-side as JSONB on
    the user record; written via `updateGuildFolders` (replaces the
    full list). Ids are client-generated with the `fldr_` prefix so
    the client can build the UI without a round-trip on creation. */
export interface GuildFolder {
  id: string;
  name: string;
  /** 6-digit hex with leading `#`, or null for the default tint. */
  color: string | null;
  /** Ordered list of guild ids contained in this folder. A guild can
      belong to at most one folder server-side (later writes win). */
  guildIds: string[];
}

export interface Guild {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  ownerId: string;
  systemChannelId: string | null;
  /** Opt-in to the public /discover directory. */
  discoverable?: boolean;
  /** Long-form pitch shown on the directory. Falls back to
      `description` when null. Optional because older API responses
      may not include the field; the discovery view treats undefined
      and null identically. */
  discoveryDescription?: string | null;
  /** Category tag shown on the discovery card and used by the
      left-rail filter. One of `DISCOVERY_CATEGORIES`. */
  discoveryCategory?: DiscoveryCategory | null;
  /** AFK voice channel — users joining this channel are auto-muted
      at the SFU level (canPublish=false on the LiveKit grant). Null
      means no AFK channel is configured. Optional for back-compat. */
  afkChannelId?: string | null;
  /** Idle threshold in seconds before the (v1.x) auto-move sweep
      relocates a user to the AFK channel. Bounded 60–3600 server-side. */
  afkTimeoutSeconds?: number;
  /** Welcome message: channel + enabled toggle + template. Empty
      template renders the default "Welcome to the server, {user}!"
      greeting on the server side. {user} substitutes to a mention
      of the joining member. */
  welcomeChannelId?: string | null;
  welcomeMessageEnabled?: boolean;
  welcomeMessageTemplate?: string | null;
  /** Markdown rules shown during onboarding. Non-null gates new
   *  members behind a 'pending' membershipState until they
   *  acknowledge. Null = no onboarding gate. */
  rulesContent?: string | null;
  /** ISO timestamp of the last rules edit. Null when rulesContent
   *  is null. */
  rulesUpdatedAt?: string | null;
}

/** Canonical category list. Stored as text in the database, validated
    against this exact array in the patchGuild route, and rendered in
    the discovery left-rail in this order. Adding a new category
    requires NO migration — just append to this array.

    "Other" is the fallback bucket for any guild whose category is
    null or unrecognized; we render it explicitly in the rail so
    those guilds remain discoverable even if their category was set
    by a previous deploy with a now-removed tag. */
export const DISCOVERY_CATEGORIES = [
  'Gaming',
  'Music',
  'Entertainment',
  'Education',
  'Science & Technology',
  'Content Creator',
  'Anime & Manga',
  'Movies & TV',
  'Other',
] as const;

export type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number];

export interface DiscoverableGuild {
  id: string;
  name: string;
  description: string | null;
  discoveryDescription: string | null;
  discoveryCategory: DiscoveryCategory | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
  vanityUrlCode: string | null;
}

export interface Channel {
  id: string;
  type:
    | 'guild_text'
    | 'guild_category'
    | 'guild_voice'
    | 'guild_stage'
    | 'guild_forum'
    | 'guild_link'
    | 'dm'
    | 'group_dm'
    | 'public_thread';
  guildId: string | null;
  parentId: string | null;
  name: string | null;
  topic: string | null;
  position: number;
  nsfw: boolean;
  rateLimitPerUser: number;
  /** Voice channels only: when true, voice is disabled in the channel — no
      one can talk (participants join muted at the SFU). Optional for
      back-compat with older API responses; treat undefined as false. */
  voiceDisabled?: boolean;
  /** 1:1 DMs only: current messaging-streak day count (both parties
      messaged on consecutive UTC days). Present only when > 0. */
  streak?: number;
  lastMessageId: string | null;
  /** For threads: id of the parent-channel message that started this thread. */
  parentMessageId?: string | null;
  /** ISO timestamp when this thread was archived; null for active threads
      and non-thread channels. */
  threadArchivedAt?: string | null;
  threadResolvedAt?: string | null;
  /** For threads: ISO timestamp of the most recent message posted in
      this thread. Drives the auto-archive countdown. Null for non-thread
      channels. */
  threadLastActivityAt?: string | null;
  /** For threads: idle duration in minutes before auto-archive. One of
      60 / 1440 / 4320 / 10080. Null for non-thread channels. */
  threadAutoArchiveMinutes?: number | null;
  /** For guild_link channels: the bookmark target URL. NULL for every
      other channel type. The sidebar's LinkChannelRow uses this both
      for the confirm-leave dialog (showing the destination host) and
      for the actual window.open call on confirm. Optional in the
      type for back-compat with older API responses. */
  linkUrl?: string | null;
  createdAt?: string;
  /** True if this channel has any permission overrides. Drives the
      lock glyph next to restricted channels in the rail. Optional
      since older API responses may not include the field. */
  restricted?: boolean;
  /** DM/group-DM channels only. The OTHER recipients (excludes the
      requesting user). Used to render "DM with X" headers without a
      separate user-fetch round-trip. */
  recipients?: PublicUser[];
  /**
   * Shared-key E2EE state for 1:1 DMs. Same value seen by both
   * recipients (vs the previous per-user keys map).
   *
   *   e2eeEnabled  — true iff E2EE is on for this DM.
   *   e2eeSalt     — 16-byte base64 PBKDF2 salt. Public; used by
   *                  both participants to rederive the same key
   *                  from their shared password.
   *   e2eeVerifier — base64 SHA-256 of the derived key. Lets the
   *                  client confirm the user typed the right
   *                  password without exposing the key.
   *
   * When enabled is false, salt + verifier are null. Disabling
   * purges all encrypted messages in the conversation.
   */
  e2eeEnabled?: boolean;
  e2eeSalt?: string | null;
  e2eeVerifier?: string | null;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  width: number | null;
  height: number | null;
  /** True for voice messages — replace the generic file chip with a
      custom playback control. */
  isVoiceMessage: boolean;
  /** Duration in seconds. Only set for voice messages. */
  durationSeconds: number | null;
  /** Base64-encoded waveform bytes (typically 32-64 samples). Only
      set for voice messages. */
  waveform: string | null;
  /** Inline preview thumbnail URL, or null. Non-E2EE: a server-made ~480px
      webp; E2EE: the .zke URL of a client-made, channel-key-encrypted
      thumbnail. Null = load the full image (`url`) inline. */
  thumbnailUrl: string | null;
}

export interface ReactionAggregate {
  emoji: string;
  count: number;
  me: boolean;
}

/**
 * Structured payload attached to special message types. Discriminated
 * on `kind`. Currently:
 *
 *   - 'call': for `type === 'system_call'`. Carries enough info to
 *     render "Call ended · 5m 23s" (when missed=false) or "Missed call
 *     from <user>" (when missed=true).
 *
 * Future system message types should add a new union variant here
 * rather than introducing a new typed field on Message.
 */
export type MessageMetadata =
  | {
      kind: 'call';
      /** True when the caller hung up before the callee answered. The
       *  message renders as a missed call in that case. */
      missed: boolean;
      /** Answered-to-ended span in milliseconds. 0 when missed=true. */
      durationMs: number;
      /** Caller's user id (stringified BigInt). */
      initiatorId: string;
    }
  | {
      /** A "your DM streak expires soon" warning. The row is type 'default'
       *  but renders as a quiet notice (not a bubble) when this is present. */
      kind: 'streak_warning';
      /** Streak day count at warning time. */
      streak: number;
    }
  | {
      /** A poke / nudge. Row is type 'default'; rendered as a centered notice
       *  ("👉 poked you") + a buzz on the recipient. */
      kind: 'poke';
      /** Variant — drives the emoji + verb shown:
       *  poke | heart | wave | like | fire. */
      pokeType: string;
      /** The poker's user id (stringified BigInt). */
      initiatorId: string;
    };

export interface Message {
  id: string;
  channelId: string;
  authorId: string | null;
  author: PublicUser | null;
  type: string;
  content: string;
  replyToId: string | null;
  pinned: boolean;
  editedAt: string | null;
  mentionsEveryone: boolean;
  mentionedUserIds: string[];
  mentionedRoleIds: string[];
  attachments: Attachment[];
  reactions: ReactionAggregate[];
  /** Resolved link previews. Empty array means "scanned, nothing
      previewable"; null means "not resolved yet" (transient state
      during the ~1s between send and background fetch completing). */
  embeds: MessageEmbed[] | null;
  /** Set when this message has an attached poll. Null otherwise. */
  poll: Poll | null;
  /** Set when this message has an attached sticker. The id stays
      constant even if the sticker is later deleted; `sticker` carries
      the rendering snapshot (null if the sticker is gone). */
  stickerId: string | null;
  sticker: Sticker | null;
  /** Set when this message is a forward. The id of the SOURCE message
      (preserved across deletion of the source row). Null for non-
      forwarded messages. */
  forwardedFromMessageId: string | null;
  /** Source content snapshot — present whenever forwardedFromMessageId
      is set. Renderers show this in a quoted block under any
      forwarder-supplied content. */
  forwardedFrom: ForwardSource | null;
  /** When set, this message was posted by a webhook. Renderers use this
      as a signal to swap in `authorOverrideName` / `authorOverrideAvatar`
      in place of the embedded author's user record. */
  webhookId: string | null;
  authorOverrideName: string | null;
  authorOverrideAvatar: string | null;
  /** DM read-receipt timestamps. Both NULL on guild messages and on
      DM messages where the recipient has receipts off. Drive the
      Sent / Delivered / Read indicator under the sender's last own
      message in a 1:1 DM. Optional for back-compat with older
      server builds that don't ship the columns. */
  deliveredAt?: string | null;
  viewedAt?: string | null;
  /**
   * Structured metadata for special message types. NULL for ordinary
   * messages. Currently populated for `type === 'system_call'` with
   * `{ kind: 'call', missed, durationMs, initiatorId }` — clients
   * use this to render "Call ended · 5m 23s" vs "Missed call from X".
   */
  metadata?: MessageMetadata | null;
  createdAt: string;
  /**
   * Client-only flag set on optimistic placeholder messages — the bubble
   * is rendered at half opacity until the server response arrives and
   * the placeholder is replaced with the real row. The server never
   * sets this field.
   */
  pending?: boolean;
  /**
   * Client-only flag set when the optimistic send failed (network down,
   * 4xx, etc). The bubble shows a retry affordance instead of fading
   * silently. The server never sets this field.
   */
  failed?: boolean;
  /**
   * Echo token. Present ONLY on the MESSAGE_CREATE gateway event sent
   * back to the message's author (the server doesn't persist it). The
   * client matches it against the optimistic placeholder's local id to
   * replace the placeholder in place — preventing the duplicate "ghost"
   * bubble when the gateway echo beats the REST response.
   */
  nonce?: string | null;
}

export interface GuildMember {
  guildId: string;
  userId: string;
  user: PublicUser;
  roleIds: string[];
  joinedAt: string;
  /**
   * ISO-8601 timestamp of when the member's timeout ends, or null
   * if they're not timed out. Compare to now() before showing UI
   * indicators — past values mean the timeout expired but the row
   * column hasn't been cleared yet (the message-send route already
   * does the comparison correctly).
   */
  communicationDisabledUntil: string | null;
  /** Onboarding state. 'pending' = the member needs to acknowledge
   *  the guild's rules before they can send / react / join voice.
   *  'active' = full member. Optional for back-compat with older
   *  API responses — undefined is treated as 'active'. */
  membershipState?: 'pending' | 'active';
  /** Timestamp of the member's most recent rules acknowledgment, or
   *  null if they've never acknowledged. The client compares this
   *  against `guild.rulesUpdatedAt` to re-show the OnboardingModal
   *  after an admin updates the rules (re-prompt flow). Optional
   *  for back-compat. */
  rulesAcknowledgedAt?: string | null;
}

/**
 * A persistent invite link to a guild. The `code` is the public token used
 * in `/invite/:code` URLs. Invites optionally have an expiry and a use
 * cap; both null means "permanent, unlimited."
 */
export interface Invite {
  code: string;
  channelId: string;
  guildId: string;
  inviterId: string;
  uses: number;
  maxUses: number | null;
  expiresAt: string | null;
  createdAt: string;
}

/** Public preview shape returned by GET /invites/:code. Surfaces just
    enough information for the /invite/:code landing page to render
    a "join this server" call to action — no auth required to fetch.
    Distinct from `Invite` (which is the owner-side view with usage
    metrics and the inviter id). */
export interface InvitePreview {
  code: string;
  guild: {
    id: string;
    name: string;
    iconUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
    memberCount: number;
  };
  channel: { id: string };
  uses: number;
  maxUses: number | null;
  expiresAt: string | null;
}

/**
 * A guild role. Permissions are an opaque decimal-string bitfield over
 * the 30 known permission bits defined in @zekktris/shared/permissions.
 * Role positions establish the role hierarchy — higher position outranks
 * lower. The `@everyone` role is special: its `id === guildId` and its
 * `position === 0`. It cannot be deleted, and `managed` for it is true.
 */
export interface Role {
  id: string;
  guildId: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  /** When true, any guild member can grant/revoke this role for
   *  themselves via the self-assign endpoints. Default false. */
  selfAssignable?: boolean;
  /** Admin-set blurb shown beside the role in the Browse Roles UI. */
  description?: string | null;
}

/**
 * A per-channel permission override targeting either a role or an
 * individual member. `allow` and `deny` are decimal-string bitfields;
 * the resolver applies @everyone first, then role overrides in
 * ascending position order, then any matching member override.
 */
export interface PermissionOverride {
  channelId: string;
  targetType: 'role' | 'member';
  targetId: string;
  allow: string;
  deny: string;
}

/**
 * One row per user currently in a voice channel. The gateway emits
 * VOICE_STATE_UPDATE on join/leave/mute changes; channelId is null on the
 * "this user just left voice" variant so clients can drop the entry from
 * their presence map.
 */
export interface VoiceState {
  userId: string;
  channelId: string | null;
  /** Null for DM voice (1-on-1 calls); string for guild voice. */
  guildId: string | null;
  sessionId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
}

export interface ReadState {
  channelId: string;
  /** Most recently acked message in this channel; null = no acks yet. */
  lastMessageId: string | null;
  /** Direct mentions targeting the user since the last ack. */
  mentionCount: number;
}

export interface AuthSession {
  user: SelfUser;
  accessToken: string;
}

/** A short-lived, single-use quick-login code for logging in on another
    device (shown as digits + encoded in a QR). `expiresIn` is seconds. */
export interface QuickLoginCode {
  code: string;
  expiresIn: number;
}

/**
 * A guild ban — server-side this is a row in the `bans` table; the
 * matching guildMember row was deleted as part of the ban transaction.
 * Re-bans on top of an existing ban refresh the moderator/reason.
 */
export interface GuildBan {
  guildId: string;
  user: PublicUser;
  /** User id of the moderator who issued the ban. Null only for legacy
      rows from before audit attribution; new bans always carry this. */
  moderatorId: string | null;
  /** Optional human-readable reason. UI surfaces it in the bans list. */
  reason: string | null;
  /** ISO timestamp the ban was created. Re-banning resets this. */
  createdAt: string;
}

/**
 * Per-guild automoderation rule. Configured by admins (MANAGE_GUILD)
 * via the guild settings UI; the message-send path checks each
 * enabled rule against incoming content and either blocks the
 * message or block-and-timeouts the sender.
 *
 * Three rule types are reserved by the schema, but only the first is
 * enforced in v1:
 *   - word_blocklist: reject messages containing any listed phrase
 *     (case-insensitive, word-boundary matched).
 *   - repeat_message: reject when a user sends N identical messages
 *     within windowSeconds. Reserved; not enforced yet.
 *   - mention_spam: reject when a single message contains too many
 *     user/role mentions. Reserved; not enforced yet.
 */
export interface AutomodRule {
  id: string;
  guildId: string;
  name: string;
  ruleType:
    | 'word_blocklist'
    | 'regex_pattern'
    | 'link_filter'
    | 'repeat_message'
    | 'mention_spam';
  enabled: boolean;
  /** Strings to match against message content. Interpretation
      depends on ruleType:
       - word_blocklist: word-boundary, case-insensitive substring
       - regex_pattern:  raw case-insensitive regex
       - link_filter:    domain blocklist; the special token
                         'zk:invite' blocks Zekktris invite links
      Cap of 100 patterns per rule, 200 chars per pattern. */
  patterns: string[];
  /** repeat_message: identical-send count threshold.
      mention_spam: mentions-per-message threshold. Null otherwise. */
  threshold: number | null;
  /** repeat_message: rolling window in seconds. Null for other rule
      types. */
  windowSeconds: number | null;
  /** What happens when the rule fires.
       - block:             reject the message
       - block_and_timeout: reject + apply a timeout
       - log_only:          write audit entry but let the message
                            through (observation mode) */
  action: 'block' | 'block_and_timeout' | 'log_only';
  /** Duration of the auto-applied timeout. Null when action is
      plain `block` or `log_only`. Server caps at 28 days to match
      manual moderator-issued timeouts. */
  timeoutSeconds: number | null;
  /** Role IDs whose holders bypass this rule entirely. Any overlap
      with the sender's role set is sufficient. */
  exemptRoleIds: string[];
  /** Channel IDs where this rule does NOT apply. Empty array means
      it applies in every channel. */
  exemptChannelIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A custom guild emoji — uploaded as a PNG/GIF/WebP file, referenced
 * from messages and reactions as `:name:` tokens. Visibility scoped
 * to members of the owning guild; non-members never see them.
 */
export interface GuildEmoji {
  id: string;
  guildId: string;
  /** :name: token. Lowercase letters, digits, underscores; 2–32 chars. */
  name: string;
  /** Public CDN path. Members of the guild can fetch via this URL. */
  url: string;
  /** True for animated GIFs. UI may opt to pause them based on user prefs. */
  animated: boolean;
  /** Uploader id. Null only if that user got hard-deleted. */
  uploadedBy: string | null;
  /** ISO timestamp the emoji was uploaded. */
  createdAt: string;
}

// ── Gateway frame types (shared with server via @zekktris/shared) ───────────
//
// Re-exported for the client's convenience so consumers don't need to know
// about @zekktris/shared.
export type { GatewayFrame, GatewayEventName } from '@zekktris/shared/events';
export { GatewayOp, GatewayEvent } from '@zekktris/shared/events';

// ── Webhooks ─────────────────────────────────────────────────────────────

export interface Webhook {
  id: string;
  channelId: string;
  guildId: string;
  name: string;
  avatarUrl: string | null;
  /**
   * The secret token. The full URL is `${origin}/api/webhooks/${id}/${token}`.
   * Treat as a secret — anyone with the URL can post messages to the
   * channel as this webhook.
   */
  token: string;
  createdBy: string | null;
  createdAt: string;
}

// ── Polls ────────────────────────────────────────────────────────────────

export interface PollOption {
  id: string;
  text: string;
  position: number;
  /** Live vote count. Refreshed on every MESSAGE_UPDATE. */
  voteCount: number;
}

export interface Poll {
  id: string;
  question: string;
  multipleChoice: boolean;
  options: PollOption[];
  /** Distinct voters across all options. */
  totalVoters: number;
  /** Option ids the requesting user voted for. */
  myVotes: string[];
  /** Hard end timestamp. Null = no end (admin closes manually). */
  expiresAt: string | null;
  /** Set when the poll has been closed. Final results after this. */
  closedAt: string | null;
}

// ── Forward source snapshot ──────────────────────────────────────────────

export interface ForwardSource {
  /** The source message id. Stable across the forward's lifetime, even
      if the source is deleted. Used as a "Jump to original" affordance
      when the source is still accessible. */
  messageId: string;
  /** Source channel — null only if the channel was deleted. */
  channel: { id: string; name: string | null; type: string } | null;
  /** Source author — null if hard-deleted. */
  author: PublicUser | null;
  /** Verbatim source content. */
  content: string;
  attachments: Attachment[];
  createdAt: string;
  /** True when the source has been soft-deleted; renderer should grey
      the content out / show "[deleted]". */
  deleted: boolean;
}

// ── Link preview embeds ──────────────────────────────────────────────────

export interface MessageEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface MessageEmbed {
  /** Originally-extracted URL (empty for a rich webhook embed with no url). */
  url: string;
  kind: 'link' | 'image' | 'video' | 'rich';
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  // Rich (webhook) embed fields — null for auto-resolved link/image previews.
  color: number | null;
  authorName: string | null;
  authorIconUrl: string | null;
  thumbnailUrl: string | null;
  fields: MessageEmbedField[] | null;
  footerText: string | null;
  footerIconUrl: string | null;
  timestamp: string | null;
}

// ── Stickers ─────────────────────────────────────────────────────────────

export interface Sticker {
  id: string;
  guildId: string;
  name: string;
  /** Optional description / alt-text. ≤100 chars. */
  description: string | null;
  url: string;
  animated: boolean;
  /** Uploader id; null if hard-deleted. */
  uploadedBy: string | null;
  createdAt: string;
}

// ── Scheduled events ──────────────────────────────────────────────────────

/**
 * Scheduled event. Time-bounded happenings members RSVP to.
 *
 * Status lifecycle (driven by the server's sweep + admin manual):
 *   scheduled → active    : at start_at
 *   active    → completed : at end_at (open-ended events never auto-complete)
 *   any       → canceled  : admin manual; terminal
 */
export interface ScheduledEvent {
  id: string;
  guildId: string;
  /** Creator user. Null when the creator was deleted. */
  creator: PublicUser | null;
  name: string;
  description: string | null;
  startAt: string;
  endAt: string | null;
  locationKind: 'voice_channel' | 'external';
  locationChannelId: string | null;
  locationText: string | null;
  status: 'scheduled' | 'active' | 'completed' | 'canceled';
  imageUrl: string | null;
  /** Optional. Server includes on list/detail GETs; omits on
   *  realtime broadcast deltas. */
  rsvpCounts?: { going: number; maybe: number; declined: number };
  /** Optional. Caller's own RSVP, null if they haven't responded.
   *  Server-resolved server-side so the client doesn't need a
   *  separate roundtrip to highlight the active button. */
  myRsvp?: 'going' | 'maybe' | 'declined' | null;
  createdAt: string;
  updatedAt: string;
}

/** One member's RSVP to an event. */
export interface EventRsvp {
  eventId: string;
  user: PublicUser;
  status: 'going' | 'maybe' | 'declined';
  createdAt: string;
  updatedAt: string;
}

// ── Stage participants ───────────────────────────────────────────────────

export interface StageParticipant {
  channelId: string;
  userId: string;
  /** True = speaker (publish-allowed); false = audience (subscribe-only). */
  isSpeaker: boolean;
  /** Audience-only "request to speak" flag. */
  handRaised: boolean;
  joinedAt: string;
}

/** Reaction-role mapping. One per (messageId, emoji); reacting
    with the emoji on the message auto-grants the role. */
export interface ReactionRoleMapping {
  messageId: string;
  emoji: string;
  channelId: string;
  roleId: string;
}

// ── Audit log ─────────────────────────────────────────────────────────────

/**
 * One audit-log entry. Written by the server on every moderator-
 * relevant action (kicks, bans, role changes, timeouts, rule
 * triggers, etc.). Admins with VIEW_AUDIT_LOG can list these via
 * `GET /guilds/:id/audit-log`.
 */
export interface AuditLogEntry {
  id: string;
  guildId: string;
  /** The user who performed the action, or null when the moderator
   *  was deleted (the row survives via ON DELETE SET NULL). */
  actor: PublicUser | null;
  /** Dot.case action name. Stable strings — clients can switch on
   *  these to render specific entry templates. */
  action: string;
  targetType:
    | 'guild'
    | 'channel'
    | 'role'
    | 'member'
    | 'message'
    | 'invite'
    | 'webhook'
    | 'emoji'
    | 'sticker'
    | 'automod_rule'
    | 'scheduled_event';
  targetId: string | null;
  /** Optional structured before/after diff or context. Shape varies
   *  by action — the client switches on `action` to interpret. */
  changes: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}

// ── Automod ───────────────────────────────────────────────────────────────

/**
 * Per-guild moderation rule. Configured by admins (MANAGE_GUILD) and
 * enforced server-side on every message send in the guild. Three
 * rule kinds reserved by the schema:
 *   - word_blocklist : reject if message contains any listed phrase
 *   - repeat_message : reserved — N identical sends in window_seconds
 *   - mention_spam   : reserved — too many mentions in one message
 *
 * v1 enforces word_blocklist. The others store fine but the server
 * treats them as no-ops at check time; future ships will wire the
 * matching algorithms.
 */


// ── Achievements ─────────────────────────────────────────────────────────────

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Marker shown in the badge (year number, tier threshold…). */
  marker: string;
  /** Current raw progress value behind the badge. */
  value: number;
  /** Whether the user has unlocked it. Locked entries carry progress
      (own shelf only — other users' shelves are earned-only). */
  earned?: boolean;
  /** Threshold to unlock, when the badge has a fixed goal. */
  goal?: number;
}

export interface AchievementsResponse {
  achievements: Achievement[];
  /** Present on the @me variant: current visibility toggle. */
  public?: boolean;
}

// ── Instance security (Admin → Security) ────────────────────────────────────

export interface SecurityConfig {
  spamEnabled: boolean;
  spamMaxMessages: number;
  spamWindowSeconds: number;
  spamCooldownSeconds: number;
  wordFilterEnabled: boolean;
}

/** A banned/watched word in the instance moderation lists. 'blocked' hard-
    blocks messages + identity fields; 'watch' logs usage without blocking. */
export interface SecurityWord {
  word: string;
  severity: 'blocked' | 'watch';
}

export interface SecurityEvent {
  id: string;
  /** Automated detections ('spam_limited' | 'banned_word') plus staff-action
      audit kinds ('staff_ban', 'staff_gift', …). */
  kind: string;
  /** The TARGET of the event (message author / actioned user). */
  userId: string | null;
  username: string | null;
  displayName: string | null;
  /** WHO performed a staff action (null for automated detections). */
  actorId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  guildId: string | null;
  channelId: string | null;
  detail: string;
  contentSnapshot: string | null;
  createdAt: string;
}

// ── Instance monetization (Admin → Monetization) ────────────────────────────

/** MINIMUM membership tier a gated feature requires; 'none' = free. */
export type MonetizationTier = 'none' | 'scout' | 'guardian' | 'legend';

/** Per-resolution tier requirements for one video surface (screen share or
    webcam). 720p is always free and therefore not part of the matrix. */
export interface MonetizationMatrix {
  p1080: MonetizationTier;
  k2: MonetizationTier;
  k4: MonetizationTier;
}

/** Admin-configurable feature gating. Fetched by every client at login
    (GET /instance/monetization); written by admins (PUT /admin/monetization). */
export interface MonetizationConfig {
  /** Screen-share resolution gates. Defaults: p1080 free, 2K Guardian, 4K Legend. */
  stream: MonetizationMatrix;
  /** Webcam resolution gates. Same defaults as `stream`. */
  camera: MonetizationMatrix;
  /** Tier required for Appearance cosmetics (themes/frames/tags).
      Default 'scout' = any membership (founder grants are 'scout'). */
  appearance: MonetizationTier;
  /** Per-tier upload caps in MB; null = the server's env default
      (MAX_UPLOAD_SIZE_MB). The env cap stays the hard ceiling either way. */
  uploadCapsMb: {
    free: number | null;
    scout: number | null;
    guardian: number | null;
    legend: number | null;
  };
}

/** PUT /admin/monetization accepts a full config or any subset of it. */
export interface MonetizationConfigPatch {
  stream?: Partial<MonetizationMatrix>;
  camera?: Partial<MonetizationMatrix>;
  appearance?: MonetizationTier;
  uploadCapsMb?: Partial<MonetizationConfig['uploadCapsMb']>;
}
