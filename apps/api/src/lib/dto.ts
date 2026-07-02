/**
 * DTOs (Data Transfer Objects)
 * ----------------------------
 * Convert raw DB rows into JSON-safe response shapes. This is the boundary
 * between the database and the wire — nothing else should serialize a User
 * row directly. Keeps `passwordHash`, `isAdmin` (sometimes), etc. from
 * leaking by accident.
 */

import type { User, Session, MessageMetadataJson } from '@zekktris/db';
import { bigintStr, isoDate } from './json';

// ───────────────────────────────────────────────────────────────────────────
// User DTOs
// ───────────────────────────────────────────────────────────────────────────

/** Self-view: the user looking at their own account. Includes private fields. */
export interface SelfUserDTO {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  /** Cosmetic avatar decoration id (CSS ring/glow). Null = none. */
  avatarDecoration: string | null;
  status: User['status'];
  customStatus: string | null;
  /** Emoji portion of the custom status. Independent of the text:
      either or both may be set. Null means no emoji. */
  customStatusEmoji: string | null;
  /** Optional auto-clear time for the custom status. ISO 8601.
      Client treats any past timestamp as "no status set" so we
      don't need a server cleanup job. */
  customStatusExpiresAt: string | null;
  isAdmin: boolean;
  locale: string;
  /** Per-user guild rail ordering. Null = no preference (client uses
      natural API order). Always reflects the latest server state;
      the client treats this as authoritative on login / refresh. */
  guildOrder: string[] | null;
  /** Per-user rail folders. Always present (empty array when the
      user has no folders configured). Same authoritative-server
      semantics as guildOrder. */
  guildFolders: Array<{
    id: string;
    name: string;
    color: string | null;
    guildIds: string[];
  }>;
  /** DM read-receipt opt-out. When false, this user's reads + the
      delivery of messages to them are NOT stamped, so senders see
      "Sent" forever on DMs to this user. Self-only state — the
      flag itself is private; others observe its effect via the
      absence of timestamps. */
  dmReadReceiptsEnabled: boolean;
  /** Achievements visibility. When true, others can view this user's
      achievements on their profile. Self-state carried on the user object
      so the client treats it as authoritative on login / refresh (the
      separate /achievements endpoint computes the shelf list). */
  achievementsPublic: boolean;
  /** Privacy: when true, anyone who shares a guild with this user can
      open a DM and ring them for a 1:1 call. When false (default),
      DMs/calls are friends-only. Blocks always override. Self-only
      field — the effect is observed by other users via the API
      refusing their DM/call attempt. */
  allowDmsFromServerMembers: boolean;
  /** E2EE identity public key, base64-encoded (X25519, 32 bytes →
      ~44 chars). Null until the user first generates a keypair (which
      happens lazily client-side on first DM send). The matching
      private key is stored only in the client's localStorage. */
  publicKey: string | null;
  /** Custom name tag ("clan tag") rendered in front of the name (label-only,
      ≤4 chars). Carried on the self DTO so the settings editor pre-fills. */
  tagLabel: string | null;
  tagColor: string | null;
  /** Whether the supporter tier title shows on the profile popup. */
  showSubscriptionTier: boolean;
  /** Effective supporter tier (own or inherited from a supervising parent);
      null/absent = no membership → Appearance perks locked. Populated only by
      routes that fetch it (GET/PATCH /@me) — optional so hot paths skip it. */
  subscriptionTier?: 'scout' | 'guardian' | 'legend' | null;
  /** Membership expiry (ISO), null = unlimited. Only set alongside tier. */
  subscriptionExpiresAt?: string | null;
  /** True when the membership is inherited from a supervising parent. */
  subscriptionInherited?: boolean;
  /** Whether the tier TITLE applies. False for founder (grandfathered)
      memberships — perks without a title until a tier is chosen. Drives the
      tier badge + the show-tier toggle in Settings. */
  subscriptionTitled?: boolean;
  /** 'gift' | 'founder' | 'stripe'. The web client shows "Manage
      subscription" (Stripe portal) only for own stripe memberships. */
  subscriptionSource?: string | null;
  /** The account's date of birth (YYYY-MM-DD), or null for a legacy account
      that never set one. Self-only (never on the public user DTO). */
  dateOfBirth: string | null;
  /** True when the user may still change their DOB themselves (unlocked). Once
      they set it, or for accounts locked at signup, this is false until an
      admin resets it. Drives the one-time "confirm your age" prompt. */
  canChangeDob: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Public view: what other users see. No email, no admin flag. */
export interface PublicUserDTO {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string | null;
  /** Cosmetic avatar decoration id (CSS ring/glow). Null = none. */
  avatarDecoration: string | null;
  status: User['status'];
  customStatus: string | null;
  /** Emoji portion of the custom status. Same semantics as
      SelfUserDTO — either or both of text/emoji can be set. */
  customStatusEmoji: string | null;
  /** Optional auto-clear time. Client treats past timestamps as
      "no status." */
  customStatusExpiresAt: string | null;
  /** E2EE identity public key, base64-encoded. Null if this user has
      never sent an E2EE message. Other clients fetch this to encrypt
      messages addressed to this user. Safe to expose publicly — only
      the matching private key needs to stay secret. */
  publicKey: string | null;
  createdAt: string;
  /** True for bot accounts. Drives the BOT badge in clients. */
  isBot: boolean;
  /** Custom name tag ("clan tag") rendered in front of the name (label-only,
      ≤4 chars). Renders only when a label is set. tagColor is a #rrggbb hex
      (clients default to the accent when null). */
  tagLabel: string | null;
  tagColor: string | null;
}

export function toSelfUser(
  user: User,
  /** Effective membership, when the route fetched it (GET/PATCH /@me). Pass
      null for "looked up, none" — undefined omits the fields entirely. */
  membership?: {
    tier: string;
    expiresAt: Date | null;
    inherited: boolean;
    titled: boolean;
    source: string;
  } | null,
): SelfUserDTO {
  const membershipFields =
    membership === undefined
      ? {}
      : membership === null
        ? {
            subscriptionTier: null,
            subscriptionExpiresAt: null,
            subscriptionInherited: false,
            subscriptionTitled: false,
            subscriptionSource: null,
          }
        : {
            subscriptionTier: membership.tier as 'scout' | 'guardian' | 'legend',
            subscriptionExpiresAt: isoDate(membership.expiresAt),
            subscriptionInherited: membership.inherited,
            subscriptionTitled: membership.titled,
            subscriptionSource: membership.source,
          };
  return {
    ...membershipFields,
    id: bigintStr(user.id),
    email: user.email,
    emailVerified: user.emailVerified,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    bio: user.bio,
    avatarDecoration: user.avatarDecoration ?? null,
    status: user.status,
    customStatus: user.customStatus,
    customStatusEmoji: user.customStatusEmoji ?? null,
    customStatusExpiresAt: isoDate(user.customStatusExpiresAt),
    isAdmin: user.isAdmin,
    locale: user.locale,
    guildOrder: user.guildOrder ?? null,
    guildFolders: user.guildFolders ?? [],
    dmReadReceiptsEnabled: user.dmReadReceiptsEnabled,
    achievementsPublic: user.achievementsPublic,
    allowDmsFromServerMembers: user.allowDmsFromServerMembers,
    publicKey: user.publicKey ?? null,
    tagLabel: user.tagLabel ?? null,
    tagColor: user.tagColor ?? null,
    showSubscriptionTier: user.showSubscriptionTier,
    dateOfBirth: user.dateOfBirth ?? null,
    canChangeDob: !user.dobLocked,
    createdAt: isoDate(user.createdAt),
    updatedAt: isoDate(user.updatedAt),
  };
}

export function toPublicUser(user: User): PublicUserDTO {
  const hideStatus = user.status === 'invisible';
  return {
    id: bigintStr(user.id),
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    bio: user.bio,
    avatarDecoration: user.avatarDecoration ?? null,
    // 'invisible' is shown as 'offline' to others.
    status: hideStatus ? 'offline' : user.status,
    customStatus: hideStatus ? null : user.customStatus,
    customStatusEmoji: hideStatus ? null : (user.customStatusEmoji ?? null),
    customStatusExpiresAt: hideStatus
      ? null
      : isoDate(user.customStatusExpiresAt),
    publicKey: user.publicKey ?? null,
    createdAt: isoDate(user.createdAt),
    isBot: user.isBot,
    tagLabel: user.tagLabel ?? null,
    tagColor: user.tagColor ?? null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Session DTO
// ───────────────────────────────────────────────────────────────────────────

export interface SessionDTO {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** True if this is the session making the current request. */
  current: boolean;
}

export function toSession(session: Session, currentSessionId: bigint): SessionDTO {
  return {
    id: bigintStr(session.id),
    userAgent: session.userAgent,
    ipAddress: session.ipAddress,
    createdAt: isoDate(session.createdAt),
    lastUsedAt: isoDate(session.lastUsedAt),
    expiresAt: isoDate(session.expiresAt),
    current: session.id === currentSessionId,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Guild DTOs
// ───────────────────────────────────────────────────────────────────────────

import type {
  Guild,
  Role,
  GuildMember,
  Channel,
  PermissionOverride,
  Invite,
  Ban,
  GuildEmoji,
} from '@zekktris/db';

export interface GuildDTO {
  id: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  ownerId: string;
  systemChannelId: string | null;
  vanityUrlCode: string | null;
  /** Opt-in to the public /discover directory. */
  discoverable: boolean;
  /** Long-form pitch shown next to the guild card on the directory.
      Falls back to `description` client-side when null. */
  discoveryDescription: string | null;
  /** Category tag for the discovery filter. */
  discoveryCategory: string | null;
  /** Voice channel users get parked in when idle. NULL = no AFK
      channel configured. Joining this channel auto-mutes at the
      LiveKit grant level. */
  afkChannelId: string | null;
  /** Idle threshold in seconds for the (v1.x) auto-move sweep. */
  afkTimeoutSeconds: number;
  /** Welcome-message configuration. welcomeChannelId falls back to
      systemChannelId server-side at post time; surfacing all three
      lets the settings UI show the resolution preview without a
      second roundtrip. */
  welcomeChannelId: string | null;
  welcomeMessageEnabled: boolean;
  welcomeMessageTemplate: string | null;
  /** Markdown rules shown during onboarding. Non-null gates new
   *  members behind a 'pending' state until they acknowledge. Null
   *  = no onboarding gate. */
  rulesContent: string | null;
  /** Timestamp of the last rules edit. Null when rulesContent is
   *  null. Future feature: optional re-prompt on substantive
   *  edits by comparing this against each member's acknowledgment. */
  rulesUpdatedAt: string | null;
  /** Raid protection — see schema. */
  minAccountAgeMinutes: number;
  requireVerifiedEmail: boolean;
  raidModeEnabled: boolean;
  joinRateLimitCount: number | null;
  joinRateLimitSeconds: number | null;
  createdAt: string;
  updatedAt: string;
}

export function toGuild(g: Guild): GuildDTO {
  return {
    id: bigintStr(g.id),
    name: g.name,
    description: g.description,
    iconUrl: g.iconUrl,
    bannerUrl: g.bannerUrl,
    ownerId: bigintStr(g.ownerId),
    systemChannelId: bigintStr(g.systemChannelId),
    vanityUrlCode: g.vanityUrlCode,
    discoverable: g.discoverable,
    discoveryDescription: g.discoveryDescription,
    discoveryCategory: g.discoveryCategory,
    afkChannelId: bigintStr(g.afkChannelId),
    afkTimeoutSeconds: g.afkTimeoutSeconds,
    welcomeChannelId: bigintStr(g.welcomeChannelId),
    welcomeMessageEnabled: g.welcomeMessageEnabled,
    welcomeMessageTemplate: g.welcomeMessageTemplate,
    rulesContent: g.rulesContent,
    rulesUpdatedAt: g.rulesUpdatedAt ? isoDate(g.rulesUpdatedAt) : null,
    minAccountAgeMinutes: g.minAccountAgeMinutes,
    requireVerifiedEmail: g.requireVerifiedEmail,
    raidModeEnabled: g.raidModeEnabled,
    joinRateLimitCount: g.joinRateLimitCount,
    joinRateLimitSeconds: g.joinRateLimitSeconds,
    createdAt: isoDate(g.createdAt),
    updatedAt: isoDate(g.updatedAt),
  };
}

// ── Role DTO ───────────────────────────────────────────────────────────────

export interface RoleDTO {
  id: string;
  guildId: string;
  name: string;
  color: number;
  position: number;
  /** Decimal-string bitfield. */
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  /** When true, members can grant/revoke this role for themselves
   *  via the self-assign endpoints. Default false. */
  selfAssignable: boolean;
  /** Admin-set blurb shown next to the role in the Browse Roles UI.
   *  Null when no description configured. */
  description: string | null;
}

export function toRole(r: Role): RoleDTO {
  return {
    id: bigintStr(r.id),
    guildId: bigintStr(r.guildId),
    name: r.name,
    color: r.color,
    position: r.position,
    permissions: r.permissions.toString(),
    hoist: r.hoist,
    mentionable: r.mentionable,
    managed: r.managed,
    selfAssignable: r.selfAssignable,
    description: r.description,
  };
}

// ── Member DTO ─────────────────────────────────────────────────────────────

export interface GuildMemberDTO {
  guildId: string;
  userId: string;
  /** Embedded user data — saves a round-trip per member listing. */
  user: PublicUserDTO;
  nickname: string | null;
  avatarUrl: string | null;
  joinedAt: string;
  /** Snowflake ids of the roles this member has, excluding @everyone. */
  roleIds: string[];
  communicationDisabledUntil: string | null;
  /** Onboarding state. 'pending' = hasn't acknowledged the guild's
   *  rules; can't send/react/join voice. 'active' = full member.
   *  Most members in most guilds are 'active'.
   *
   *  Note: the server's getMemberState gate also returns 'pending'
   *  if rulesAcknowledgedAt < guild.rulesUpdatedAt (stale ack after
   *  admin updated rules). The DTO carries the literal column value
   *  here; clients do their own staleness check via
   *  rulesAcknowledgedAt below. */
  membershipState: 'pending' | 'active';
  /** Timestamp of the member's most recent rules acknowledgment, or
   *  null if they've never acknowledged. Clients compare this
   *  against guild.rulesUpdatedAt to decide whether to render the
   *  OnboardingModal (re-prompt after admin updates rules). */
  rulesAcknowledgedAt: string | null;
}

export function toGuildMember(
  m: GuildMember,
  user: User,
  roleIds: bigint[],
): GuildMemberDTO {
  return {
    guildId: bigintStr(m.guildId),
    userId: bigintStr(m.userId),
    user: toPublicUser(user),
    nickname: m.nickname,
    avatarUrl: m.avatarUrl,
    joinedAt: isoDate(m.joinedAt),
    roleIds: roleIds.map((r) => r.toString()),
    communicationDisabledUntil: isoDate(m.communicationDisabledUntil),
    membershipState: m.membershipState,
    rulesAcknowledgedAt: isoDate(m.rulesAcknowledgedAt),
  };
}

// ── Channel DTO ────────────────────────────────────────────────────────────

export interface PermissionOverrideDTO {
  channelId: string;
  targetType: 'role' | 'member';
  targetId: string;
  /** Decimal-string bitfields. */
  allow: string;
  deny: string;
}

export function toPermissionOverride(o: PermissionOverride): PermissionOverrideDTO {
  return {
    channelId: bigintStr(o.channelId),
    targetType: o.targetType,
    targetId: bigintStr(o.targetId),
    allow: o.allow.toString(),
    deny: o.deny.toString(),
  };
}

export interface ChannelDTO {
  id: string;
  type: Channel['type'];
  guildId: string | null;
  parentId: string | null;
  name: string | null;
  topic: string | null;
  position: number;
  nsfw: boolean;
  rateLimitPerUser: number;
  /** Voice channels only: when true, voice is disabled (no one can talk;
      participants join muted at the SFU). False/irrelevant on other types. */
  voiceDisabled: boolean;
  lastMessageId: string | null;
  /** For threads: id of the parent-channel message that started this thread. */
  parentMessageId: string | null;
  /** ISO timestamp when this thread was archived; null for active or
      non-thread channels. */
  threadArchivedAt: string | null;
  /** For threads: ISO timestamp of the most recent message posted in
      this thread. Drives the auto-archive countdown — sweep flips
      archived_at when last_activity + auto_archive_minutes < now().
      Null for non-thread channels. */
  threadLastActivityAt: string | null;
  /** For threads: idle duration in minutes before auto-archive. One
      of 60 / 1440 / 4320 / 10080. Null for non-thread channels. */
  threadAutoArchiveMinutes: number | null;
  /** For threads: ISO timestamp when this thread was marked as
      resolved/complete. Null for unresolved threads and non-thread
      channels. Soft signal — the thread stays open. */
  threadResolvedAt: string | null;
  /** For guild_link channels: the external URL the bookmark points to.
      NULL on every other channel type. Clients use this in tandem
      with type='guild_link' to render the bookmark + confirm-leave
      flow when clicked. */
  linkUrl: string | null;
  createdAt: string;
  /** True when the channel has any permission overrides — a quick
      visibility indicator the client uses to render a lock glyph
      next to the channel name. The actual access check is still per
      member via computeMemberChannelPermissions; this flag exists
      purely for UI affordance, the same way Discord shows the
      lock icon next to private channels. */
  restricted?: boolean;
  /** Set when the caller has VIEW_AUDIT_LOG and asked for them. */
  permissionOverrides?: PermissionOverrideDTO[];
  /** Set on DM/group-DM channels only. The list of users on the
      OTHER side of the conversation (excludes the requesting user
      so the client can render the "this is a DM with X" header
      without needing a separate REST call). */
  recipients?: PublicUserDTO[];
  /**
   * Shared-key E2EE state for 1:1 DMs. Same value visible to both
   * recipients.
   *
   *   e2eeEnabled  — true iff E2EE is on for this DM.
   *   e2eeSalt     — 16-byte base64. PBKDF2 input alongside the
   *                  user-typed password. Public; required for both
   *                  participants to derive the same key.
   *   e2eeVerifier — base64 SHA-256 of the derived key. Lets the
   *                  second user verify they typed the right
   *                  password without exposing the password or key
   *                  to the server.
   *
   * When enabled is false, salt + verifier are null. When enabled
   * is true, both are non-null. Disabling triggers a server-side
   * purge of all zkE2EE/* messages in the conversation.
   */
  e2eeEnabled?: boolean;
  e2eeSalt?: string | null;
  e2eeVerifier?: string | null;
}

export function toChannel(
  c: Channel,
  overrides?: PermissionOverride[] | null,
  recipients?: User[],
  /** When true, report this DM as NOT end-to-end encrypted regardless of
      its stored flag. Used for supervised-child DMs so both clients send
      plaintext and the parent can review them. Parent↔child DMs are NOT
      suppressed (the caller decides). */
  e2eeSuppressed = false,
): ChannelDTO {
  return {
    id: bigintStr(c.id),
    type: c.type,
    guildId: bigintStr(c.guildId),
    parentId: bigintStr(c.parentId),
    name: c.name,
    topic: c.topic,
    position: c.position,
    nsfw: c.nsfw,
    rateLimitPerUser: c.rateLimitPerUser,
    voiceDisabled: c.voiceDisabled === true,
    lastMessageId: bigintStr(c.lastMessageId),
    parentMessageId: bigintStr(c.parentMessageId),
    threadArchivedAt: isoDate(c.threadArchivedAt),
    threadLastActivityAt: isoDate(c.threadLastActivityAt),
    threadAutoArchiveMinutes: c.threadAutoArchiveMinutes,
    threadResolvedAt: isoDate(c.threadResolvedAt),
    linkUrl: c.linkUrl,
    createdAt: isoDate(c.createdAt),
    ...(overrides && overrides.length > 0 ? { restricted: true } : {}),
    ...(overrides
      ? { permissionOverrides: overrides.map(toPermissionOverride) }
      : {}),
    ...(recipients ? { recipients: recipients.map(toPublicUser) } : {}),
    // E2EE only meaningful on DMs. We include the three fields
    // unconditionally on DM channels so the client can simply read
    // them; on non-DM channels we omit so we don't pollute every
    // guild channel with three null fields they'll never use.
    ...(c.type === 'dm' || c.type === 'group_dm'
      ? e2eeSuppressed
        ? { e2eeEnabled: false, e2eeSalt: null, e2eeVerifier: null }
        : {
            e2eeEnabled: c.e2eeEnabled === true,
            e2eeSalt: c.e2eeSalt ?? null,
            e2eeVerifier: c.e2eeVerifier ?? null,
          }
      : {}),
  };
}

// ── Invite DTO ─────────────────────────────────────────────────────────────

export interface InviteDTO {
  code: string;
  guildId: string;
  channelId: string;
  inviterId: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export function toInvite(i: Invite): InviteDTO {
  return {
    code: i.code,
    guildId: bigintStr(i.guildId),
    channelId: bigintStr(i.channelId),
    inviterId: bigintStr(i.inviterId),
    maxUses: i.maxUses,
    uses: i.uses,
    expiresAt: isoDate(i.expiresAt),
    createdAt: isoDate(i.createdAt),
  };
}

/** Public preview of an invite — what an unauthenticated viewer sees
    on the /invite/:code landing page. Includes a member count so the
    page can show "Join 1,234 members" the way Discord's invite page
    does. */
export interface InvitePreviewDTO {
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

export function toInvitePreview(
  i: Invite,
  g: Guild,
  memberCount: number,
): InvitePreviewDTO {
  return {
    code: i.code,
    guild: {
      id: bigintStr(g.id),
      name: g.name,
      iconUrl: g.iconUrl,
      bannerUrl: g.bannerUrl,
      description: g.description,
      memberCount,
    },
    channel: { id: bigintStr(i.channelId) },
    uses: i.uses,
    maxUses: i.maxUses,
    expiresAt: isoDate(i.expiresAt),
  };
}

// ── Ban DTO ────────────────────────────────────────────────────────────────

export interface BanDTO {
  guildId: string;
  user: PublicUserDTO;
  moderatorId: string | null;
  reason: string | null;
  createdAt: string;
}

export function toBan(b: Ban, user: User): BanDTO {
  return {
    guildId: bigintStr(b.guildId),
    user: toPublicUser(user),
    moderatorId: bigintStr(b.moderatorId),
    reason: b.reason,
    createdAt: isoDate(b.createdAt),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// GuildEmoji DTO
// ───────────────────────────────────────────────────────────────────────────
// Emojis are guild-scoped; the public payload mirrors the row 1:1 except
// that we coerce snowflakes to strings (JSON-safe) and drop the on-disk
// detail nothing client-side needs (which is currently nothing — `url`
// is the public path through the CDN handler, not the disk path).

export interface GuildEmojiDTO {
  id: string;
  guildId: string;
  name: string;
  url: string;
  animated: boolean;
  /** Uploader id; null only if the user got hard-deleted. */
  uploadedBy: string | null;
  createdAt: string;
}

export function toEmoji(e: GuildEmoji): GuildEmojiDTO {
  return {
    id: bigintStr(e.id),
    guildId: bigintStr(e.guildId),
    name: e.name,
    url: e.url,
    animated: e.animated,
    uploadedBy: bigintStr(e.uploadedBy),
    createdAt: isoDate(e.createdAt),
  };
}

// ── Stickers ─────────────────────────────────────────────────────────────

export interface StickerDTO {
  id: string;
  guildId: string;
  name: string;
  /** Optional description / alt-text. ≤100 chars. */
  description: string | null;
  url: string;
  animated: boolean;
  uploadedBy: string | null;
  createdAt: string;
}

export function toSticker(s: import('@zekktris/db/schema').Sticker): StickerDTO {
  return {
    id: bigintStr(s.id),
    guildId: bigintStr(s.guildId),
    name: s.name,
    description: s.description ?? null,
    url: s.url,
    animated: s.animated,
    uploadedBy: bigintStr(s.uploadedBy),
    createdAt: isoDate(s.createdAt),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Message / Attachment / Reaction DTOs
// ───────────────────────────────────────────────────────────────────────────

import type { Message, Attachment, Reaction, MessageEmbedJson } from '@zekktris/db';

export interface AttachmentDTO {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  width: number | null;
  height: number | null;
  /** True for voice messages — renderers should swap in the custom
      playback control instead of the generic file chip. */
  isVoiceMessage: boolean;
  /** Duration in seconds (integer). Only set for voice messages. */
  durationSeconds: number | null;
  /** Base64-encoded waveform bytes (typically 32-64 samples). Only
      set for voice messages. */
  waveform: string | null;
  /** Inline preview thumbnail URL, or null. Non-E2EE: a server-made ~480px
      webp; E2EE: the .zke URL of a client-made, channel-key-encrypted
      thumbnail. Null = load the full image (`url`) inline. */
  thumbnailUrl: string | null;
}

export function toAttachment(a: Attachment): AttachmentDTO {
  return {
    id: bigintStr(a.id),
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    url: a.url,
    width: a.width,
    height: a.height,
    isVoiceMessage: a.isVoiceMessage ?? false,
    durationSeconds: a.durationSeconds ?? null,
    waveform: a.waveform ?? null,
    thumbnailUrl: a.thumbnailUrl ?? null,
  };
}

export interface ReactionAggregateDTO {
  emoji: string;
  count: number;
  /** Whether the requesting user is among the reactors. */
  me: boolean;
}

export interface MessageDTO {
  id: string;
  channelId: string;
  authorId: string | null;
  /** Embedded author info — saves a per-message round-trip. Null for tombstoned authors. */
  author: PublicUserDTO | null;
  type: Message['type'];
  content: string;
  replyToId: string | null;
  pinned: boolean;
  editedAt: string | null;
  mentionsEveryone: boolean;
  /** Snowflake ids of mentioned users — clients can resolve via /users/:id. */
  mentionedUserIds: string[];
  /** Snowflake ids of mentioned roles. */
  mentionedRoleIds: string[];
  attachments: AttachmentDTO[];
  reactions: ReactionAggregateDTO[];
  /** Resolved link previews. Empty array when no URLs were detected
      OR all fetches failed; null when resolution hasn't run yet
      (rare; only seen during the few hundred ms between message
      create and the embed-resolver completing its background work). */
  embeds: MessageEmbedDTO[] | null;
  /** Set when this message has an attached poll. Null otherwise. */
  poll: PollDTO | null;
  /** Set when this message has an attached sticker. The id is the
      original sticker id; the resolved snapshot below carries the
      name/url/animated for rendering even after the sticker is
      deleted from the guild. */
  stickerId: string | null;
  sticker: StickerDTO | null;
  /** Set when this message is a forward of another message. The
      attached snapshot lets the renderer show the source content with
      attribution; the message can also have its own non-empty
      `content` (the forwarder's comment). */
  forwardedFromMessageId: string | null;
  forwardedFrom: ForwardSourceDTO | null;
  /** Set when this message was posted via a webhook. The id is the
      webhook's snowflake. Renderers use this as a signal to swap in
      the override fields below in place of the author's user record. */
  webhookId: string | null;
  /** Display name override for webhook-posted messages. The webhook's
      stored name is used by default; the per-execute body can override
      via `username`. Null for non-webhook messages. */
  authorOverrideName: string | null;
  /** Avatar URL override; same precedence rules as authorOverrideName. */
  authorOverrideAvatar: string | null;
  /**
   * DM read-receipt timestamps. Both fields are NULL on guild messages
   * (the receipt model is DM-only) and on DM messages where the
   * recipient has receipts disabled.
   *
   * `deliveredAt` is set when at least one of the recipient's gateway
   * connections receives the MESSAGE_CREATE — i.e. the message landed
   * on a recipient device. `viewedAt` is set when the recipient
   * actually opens the channel and lists this message (already wired
   * up server-side for the auto-delete feature; we now also surface
   * it for receipt rendering).
   *
   * Clients render Sent → Delivered → Read under the sender's last
   * own message in a 1:1 DM, mirroring iMessage / WhatsApp.
   */
  deliveredAt: string | null;
  viewedAt: string | null;
  /**
   * Structured metadata payload for special message types. NULL for
   * ordinary messages. Currently only `system_call` populates this,
   * with `{ kind: 'call', missed, durationMs, initiatorId }`.
   */
  metadata: MessageMetadataJson | null;
  createdAt: string;
}

export function toMessage(args: {
  message: Message;
  author: User | null;
  attachments?: Attachment[];
  reactions?: Array<{ emoji: string; count: number; userIds: bigint[] }>;
  mentionedUserIds?: bigint[];
  mentionedRoleIds?: bigint[];
  /** Pre-loaded poll for this message, if any. */
  poll?: PollDTO | null;
  /** Pre-loaded sticker snapshot, if any. The route layer fetches via
      a batched join in list-messages; passing null when stickerId is
      non-null results in a "[unavailable]" placeholder client-side. */
  sticker?: StickerDTO | null;
  /** Pre-loaded forward source for this message, if any. The route
      layer is responsible for fetching this when the forward field
      is set; passing null when forwardedFromMessageId is non-null
      results in a "[unavailable]" placeholder client-side. */
  forwardedFrom?: ForwardSourceDTO | null;
  /** Self-id; lets us flag which reactions the requester has applied. */
  selfId?: bigint;
}): MessageDTO {
  const { message: m, author, attachments = [], reactions = [], mentionedUserIds = [], mentionedRoleIds = [], poll = null, sticker = null, forwardedFrom = null, selfId } = args;
  return {
    id: bigintStr(m.id),
    channelId: bigintStr(m.channelId),
    authorId: bigintStr(m.authorId),
    author: author ? toPublicUser(author) : null,
    type: m.type,
    content: m.content,
    replyToId: bigintStr(m.replyToId),
    pinned: m.pinned,
    editedAt: isoDate(m.editedAt),
    mentionsEveryone: m.mentionsEveryone,
    mentionedUserIds: mentionedUserIds.map((id) => id.toString()),
    mentionedRoleIds: mentionedRoleIds.map((id) => id.toString()),
    attachments: attachments.map(toAttachment),
    reactions: reactions.map((r) => ({
      emoji: r.emoji,
      count: r.count,
      me: selfId !== undefined && r.userIds.some((u) => u === selfId),
    })),
    embeds: m.embeds === null
      ? null
      : (m.embeds as MessageEmbedJson[]).map(
          (e): MessageEmbedDTO => ({
            url: e.url,
            kind: e.kind,
            title: e.title ?? null,
            description: e.description ?? null,
            imageUrl: e.imageUrl ?? null,
            siteName: e.siteName ?? null,
            faviconUrl: e.faviconUrl ?? null,
            color: e.color ?? null,
            authorName: e.authorName ?? null,
            authorIconUrl: e.authorIconUrl ?? null,
            thumbnailUrl: e.thumbnailUrl ?? null,
            fields: e.fields
              ? e.fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline }))
              : null,
            footerText: e.footerText ?? null,
            footerIconUrl: e.footerIconUrl ?? null,
            timestamp: e.timestamp ?? null,
          }),
        ),
    poll,
    stickerId: bigintStr(m.stickerId ?? null),
    sticker,
    forwardedFromMessageId: bigintStr(m.forwardedFromMessageId ?? null),
    forwardedFrom,
    webhookId: bigintStr(m.webhookId ?? null),
    authorOverrideName: m.authorOverrideName ?? null,
    authorOverrideAvatar: m.authorOverrideAvatar ?? null,
    deliveredAt: isoDate(m.deliveredAt),
    viewedAt: isoDate(m.viewedAt),
    metadata: m.metadata ?? null,
    createdAt: isoDate(m.createdAt),
  };
}

// Suppress unused-import lint for the Reaction row type; consumers may use it.
void (null as Reaction | null);

// ───────────────────────────────────────────────────────────────────────────
// Read state
// ───────────────────────────────────────────────────────────────────────────

export interface ReadStateDTO {
  channelId: string;
  /** Most recently acked message in this channel; null = no acks yet. */
  lastMessageId: string | null;
  /** Direct mentions targeting the user since the last ack. */
  mentionCount: number;
}

/** Internal row shape from the readStates table. */
export interface ReadStateRow {
  channelId: bigint;
  lastMessageId: bigint | null;
  mentionCount: number;
}

export function toReadState(r: ReadStateRow): ReadStateDTO {
  return {
    channelId: r.channelId.toString(),
    lastMessageId: bigintStr(r.lastMessageId),
    mentionCount: r.mentionCount,
  };
}

// ── Voice states ───────────────────────────────────────────────────────────

interface VoiceStateRow {
  userId: bigint;
  channelId: bigint;
  /** Null for DM voice (1-on-1 calls); set for guild voice. */
  guildId: bigint | null;
  sessionId: string;
  selfMute: boolean;
  selfDeaf: boolean;
}

export interface VoiceStateDTO {
  userId: string;
  channelId: string | null; // null when the user just left voice
  /** Null for DM voice; string for guild voice. */
  guildId: string | null;
  sessionId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
}

export function toVoiceState(r: VoiceStateRow): VoiceStateDTO {
  return {
    userId: r.userId.toString(),
    channelId: r.channelId.toString(),
    guildId: r.guildId === null ? null : r.guildId.toString(),
    sessionId: r.sessionId,
    selfMute: r.selfMute,
    selfDeaf: r.selfDeaf,
  };
}

/**
 * Build a "user left voice" DTO. There's no row to read — we use the
 * outgoing context (captured pre-delete) to populate guildId. For DM
 * calls the captured guildId is null too, and clients use the
 * channelId to find which DM list entry to clear.
 */
export function leftVoiceStateDTO(args: { userId: bigint; guildId: bigint | null; channelId?: bigint | null }): VoiceStateDTO {
  // channelId is intentionally null in the wire payload. The web
  // reducer treats `channelId === null` as the "user left voice"
  // signal and removes them from voiceStatesByUser; if we sent the
  // prior channel id here instead, the reducer would upsert the
  // user back into voice with a null sessionId — i.e. leaving the
  // channel UI-wise would be a no-op. The dispatch routing (which
  // channel's audience receives this event) uses a separate
  // channelId parameter on voiceStateUpdate, so we don't lose
  // anything by zeroing the payload field.
  void args.channelId;
  return {
    userId: args.userId.toString(),
    channelId: null,
    guildId: args.guildId === null ? null : args.guildId.toString(),
    sessionId: null,
    selfMute: false,
    selfDeaf: false,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Webhooks
// ───────────────────────────────────────────────────────────────────────────

export interface WebhookDTO {
  id: string;
  channelId: string;
  guildId: string;
  name: string;
  avatarUrl: string | null;
  /**
   * The secret token. Currently returned to the creator AND to anyone
   * with MANAGE_WEBHOOKS who lists existing webhooks. The full URL
   * clients actually post to is built as
   * `${origin}/api/webhooks/${id}/${token}`.
   *
   * SECURITY: treat as bearer-grade secret. Anyone holding this token
   * can post messages as the webhook persona indefinitely — there's
   * no expiry or rotation. Because the listing endpoint returns this
   * field to every MANAGE_WEBHOOKS holder, the permission effectively
   * grants permanent impersonation of every webhook in scope, surviving
   * demotion or guild departure. Properly fixing requires a
   * regenerate-token endpoint + UI changes to show URL only once on
   * creation; tracked in the deferred list.
   */
  token: string;
  /** Whoever created the webhook. Null only if that user was hard-deleted. */
  createdBy: string | null;
  createdAt: string;
}

interface WebhookRow {
  id: bigint;
  channelId: bigint;
  guildId: bigint;
  name: string;
  avatarUrl: string | null;
  token: string;
  createdBy: bigint | null;
  createdAt: Date;
}

/**
 * Returns the webhook DTO including its token.
 *
 * SECURITY NOTE: the token is bearer-grade secret material — anyone
 * holding it can post messages as the webhook persona. This DTO is
 * currently returned by the create response AND by the list + patch
 * endpoints, which are gated by MANAGE_WEBHOOKS. That means any
 * MANAGE_WEBHOOKS holder can list every webhook in the channel and
 * collect every token; if they later lose the permission or leave
 * the guild, the tokens remain valid (no expiry, no rotation).
 *
 * Properly addressing this requires a regenerate-token endpoint plus
 * UI changes (show URL only once on creation, blank-out the token in
 * subsequent reads). Deferred until that feature work is scheduled —
 * see deferred list in AUDIT_NOTES.md. For now the comment documents
 * the risk for the operator's threat model: MANAGE_WEBHOOKS is
 * EFFECTIVELY a token-impersonation grant that survives demotion.
 */
export function toWebhook(w: WebhookRow): WebhookDTO {
  return {
    id: w.id.toString(),
    channelId: w.channelId.toString(),
    guildId: w.guildId.toString(),
    name: w.name,
    avatarUrl: w.avatarUrl,
    token: w.token,
    createdBy: bigintStr(w.createdBy),
    createdAt: isoDate(w.createdAt) ?? new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Polls
// ───────────────────────────────────────────────────────────────────────────

export interface PollOptionDTO {
  id: string;
  text: string;
  /** Display order. Stable, set at create time. */
  position: number;
  /** Live count. Updates via MESSAGE_UPDATE on every vote. */
  voteCount: number;
}

export interface PollDTO {
  id: string;
  question: string;
  multipleChoice: boolean;
  options: PollOptionDTO[];
  /** Sum of distinct voters across all options. Same as the sum of
      voteCount for single-choice polls; ≤ that sum for multi-choice. */
  totalVoters: number;
  /** Option ids the requesting user voted for. Empty list if not. */
  myVotes: string[];
  /** ISO-8601. Null = no end (admin-closed only). */
  expiresAt: string | null;
  /** Set when the poll has been closed (by expiry or admin action).
      Once non-null, votes are rejected and the UI shows final tallies. */
  closedAt: string | null;
}

interface PollWithCountsRow {
  poll: {
    id: bigint;
    question: string;
    multipleChoice: boolean;
    expiresAt: Date | null;
    closedAt: Date | null;
  };
  options: Array<{
    id: bigint;
    text: string;
    position: number;
    voteCount: number;
  }>;
  totalVoters: number;
  myVotes: bigint[];
}

export function toPoll(p: PollWithCountsRow): PollDTO {
  return {
    id: p.poll.id.toString(),
    question: p.poll.question,
    multipleChoice: p.poll.multipleChoice,
    options: p.options.map((o) => ({
      id: o.id.toString(),
      text: o.text,
      position: o.position,
      voteCount: o.voteCount,
    })),
    totalVoters: p.totalVoters,
    myVotes: p.myVotes.map((id) => id.toString()),
    expiresAt: isoDate(p.poll.expiresAt),
    closedAt: isoDate(p.poll.closedAt),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Forwarded message snapshot
// ───────────────────────────────────────────────────────────────────────────

export interface ForwardSourceDTO {
  /** The source message id. Stable across the forward's lifetime, even
      if the source is deleted. Clients use this as a navigation
      affordance ("Jump to original") when the source is still
      accessible. */
  messageId: string;
  /** The source channel — `id`, `name`, and `type` so the renderer can
      build a "#channel" attribution line. Null if the channel was
      deleted (rare; we soft-delete channels but don't yet purge their
      ids from message rows). */
  channel: { id: string; name: string | null; type: string } | null;
  /** Source author. Null if hard-deleted, OR if we couldn't read them
      (rare; users only get hard-deleted on account purge). */
  author: PublicUserDTO | null;
  /** Verbatim source content at fetch time. Edits to the source
      propagate to forwards (we don't snapshot at forward-time — the
      cost would be storage duplication for every share). */
  content: string;
  /** Source attachments. Forwarded so an image-only original still
      renders. URLs are the original CDN URLs — no copy-on-forward. */
  attachments: AttachmentDTO[];
  /** Original timestamp. Preserved so the forward chip can show
      "Forwarded from #x · 3 days ago" rather than the forwarder's now. */
  createdAt: string;
  /** True when the source message has been soft-deleted. The renderer
      should grey out the content (or show "[deleted]") rather than
      pretending it's live. */
  deleted: boolean;
}

/**
 * Build a ForwardSourceDTO from the source row + its dependencies.
 * Caller passes whatever it loaded via loadForwardSources(). When the
 * source row is missing (hard-deleted), pass `sourceMessage: null` and
 * the helper returns a tombstone DTO with empty content + deleted=true.
 */
export function toForwardSource(args: {
  /** The original source message id — preserved across deletion. */
  sourceMessageId: bigint;
  sourceMessage: Message | null;
  sourceAuthor: User | null;
  sourceChannel: Channel | null;
  sourceAttachments: Attachment[];
}): ForwardSourceDTO {
  const m = args.sourceMessage;
  if (!m) {
    return {
      messageId: args.sourceMessageId.toString(),
      channel: args.sourceChannel
        ? {
            id: args.sourceChannel.id.toString(),
            name: args.sourceChannel.name,
            type: args.sourceChannel.type,
          }
        : null,
      author: null,
      content: '',
      attachments: [],
      createdAt: new Date().toISOString(),
      deleted: true,
    };
  }
  return {
    messageId: m.id.toString(),
    channel: args.sourceChannel
      ? {
          id: args.sourceChannel.id.toString(),
          name: args.sourceChannel.name,
          type: args.sourceChannel.type,
        }
      : null,
    author: args.sourceAuthor ? toPublicUser(args.sourceAuthor) : null,
    // Redact a soft-deleted source: the `deleted` flag already tells the client
    // to render "[deleted]", but shipping the original content/attachments would
    // leak data the author deleted (a forward shouldn't be a backdoor past it).
    content: m.deletedAt ? '' : m.content,
    attachments: m.deletedAt ? [] : args.sourceAttachments.map(toAttachment),
    createdAt: isoDate(m.createdAt) ?? new Date().toISOString(),
    deleted: !!m.deletedAt,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Link preview embeds
// ───────────────────────────────────────────────────────────────────────────

export interface MessageEmbedFieldDTO {
  name: string;
  value: string;
  inline: boolean;
}

export interface MessageEmbedDTO {
  /** The originally-extracted URL the embed was generated from (empty for a
      rich webhook embed with no url). */
  url: string;
  /** Discriminator for the renderer. */
  kind: 'link' | 'image' | 'video' | 'rich';
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  // Rich (webhook) embed fields — null for auto-resolved previews.
  color: number | null;
  authorName: string | null;
  authorIconUrl: string | null;
  thumbnailUrl: string | null;
  fields: MessageEmbedFieldDTO[] | null;
  footerText: string | null;
  footerIconUrl: string | null;
  timestamp: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Stage participants
// ───────────────────────────────────────────────────────────────────────────

export interface StageParticipantDTO {
  channelId: string;
  userId: string;
  /** True = speaker (publish-allowed); false = audience (subscribe-only). */
  isSpeaker: boolean;
  /** Audience-only flag; speakers always show false here. */
  handRaised: boolean;
  joinedAt: string;
}

export function toStageParticipant(p: import('@zekktris/db/schema').StageParticipant): StageParticipantDTO {
  return {
    channelId: bigintStr(p.channelId)!,
    userId: bigintStr(p.userId)!,
    isSpeaker: p.isSpeaker,
    handRaised: p.handRaised,
    joinedAt: isoDate(p.joinedAt),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Automod rules
// ───────────────────────────────────────────────────────────────────────────

export interface AutomodRuleDTO {
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
   *  depends on ruleType:
   *   - word_blocklist: word-boundary, case-insensitive substring match
   *   - regex_pattern:  raw case-insensitive regex
   *   - link_filter:    domain blocklist + 'zk:invite' special token
   */
  patterns: string[];
  /** For repeat_message: how many identical sends within
   *  windowSeconds trigger the rule. For mention_spam: how many
   *  mentions in one message. Null when not relevant. */
  threshold: number | null;
  windowSeconds: number | null;
  action: 'block' | 'block_and_timeout' | 'log_only';
  /** Duration of the auto-issued timeout (when action is
   *  block_and_timeout). Null otherwise. Capped server-side at 28d. */
  timeoutSeconds: number | null;
  /** Role IDs whose holders bypass this rule. Any overlap with the
   *  member's role set is sufficient to bypass. */
  exemptRoleIds: string[];
  /** Channel IDs where this rule does NOT apply. Empty array means
   *  the rule applies in every channel. Use case: profanity allowed
   *  in #shitposting but blocked everywhere else. */
  exemptChannelIds: string[];
  createdAt: string;
  updatedAt: string;
}

export function toAutomodRule(r: import('@zekktris/db/schema').AutomodRule): AutomodRuleDTO {
  return {
    id: bigintStr(r.id)!,
    guildId: bigintStr(r.guildId)!,
    name: r.name,
    ruleType: r.ruleType,
    enabled: r.enabled,
    patterns: r.patterns,
    threshold: r.threshold,
    windowSeconds: r.windowSeconds,
    action: r.action,
    timeoutSeconds: r.timeoutSeconds,
    exemptRoleIds: r.exemptRoleIds,
    exemptChannelIds: r.exemptChannelIds,
    createdAt: isoDate(r.createdAt),
    updatedAt: isoDate(r.updatedAt),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Audit log entries
// ───────────────────────────────────────────────────────────────────────────

export interface AuditLogEntryDTO {
  id: string;
  guildId: string;
  /** Actor user, or null if the moderator was deleted. */
  actor: PublicUserDTO | null;
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
  /** Optional structured diff or context. JSON-serialized as-is. */
  changes: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}

export function toAuditLogEntry(
  entry: import('@zekktris/db/schema').AuditLogEntry,
  actor: import('@zekktris/db/schema').User | null,
): AuditLogEntryDTO {
  return {
    id: bigintStr(entry.id)!,
    guildId: bigintStr(entry.guildId)!,
    actor: actor ? toPublicUser(actor) : null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: bigintStr(entry.targetId),
    changes: (entry.changes ?? null) as Record<string, unknown> | null,
    reason: entry.reason,
    createdAt: isoDate(entry.createdAt),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Reports (moderation queue)
// ───────────────────────────────────────────────────────────────────────────

export interface ReportDTO {
  id: string;
  guildId: string;
  reporter: PublicUserDTO | null;
  targetType: 'message' | 'user';
  targetUser: PublicUserDTO | null;
  messageId: string | null;
  channelId: string | null;
  messageContent: string | null;
  reason: string;
  details: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  handledById: string | null;
  handledAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export function toReport(
  report: import('@zekktris/db/schema').Report,
  reporter: import('@zekktris/db/schema').User | null,
  target: import('@zekktris/db/schema').User | null,
): ReportDTO {
  return {
    id: bigintStr(report.id)!,
    guildId: bigintStr(report.guildId)!,
    reporter: reporter ? toPublicUser(reporter) : null,
    targetType: report.targetType,
    targetUser: target ? toPublicUser(target) : null,
    messageId: bigintStr(report.messageId),
    channelId: bigintStr(report.channelId),
    messageContent: report.messageContent,
    reason: report.reason,
    details: report.details,
    status: report.status,
    handledById: bigintStr(report.handledById),
    handledAt: isoDate(report.handledAt),
    resolutionNote: report.resolutionNote,
    createdAt: isoDate(report.createdAt),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Scheduled events
// ───────────────────────────────────────────────────────────────────────────

export interface ScheduledEventDTO {
  id: string;
  guildId: string;
  /** Creator user. Null when the creator was deleted (the event row
   *  survives via ON DELETE SET NULL on creator_id). */
  creator: PublicUserDTO | null;
  name: string;
  description: string | null;
  startAt: string;
  endAt: string | null;
  locationKind: 'voice_channel' | 'external';
  locationChannelId: string | null;
  locationText: string | null;
  status: 'scheduled' | 'active' | 'completed' | 'canceled';
  imageUrl: string | null;
  /** Optional aggregated RSVP counts. Present in list+detail
   *  responses, omitted in update-broadcast deltas where the
   *  client recomputes by fetching the event. */
  rsvpCounts?: { going: number; maybe: number; declined: number };
  /** The calling user's RSVP status for this event, or null if
   *  they haven't responded. Present only when the response is
   *  scoped to the caller (list / detail GET); omitted in broadcast
   *  deltas which are unaware of per-recipient context. */
  myRsvp?: 'going' | 'maybe' | 'declined' | null;
  createdAt: string;
  updatedAt: string;
}

export function toScheduledEvent(
  ev: import('@zekktris/db/schema').ScheduledEvent,
  creator: import('@zekktris/db/schema').User | null,
  extra?: {
    rsvpCounts?: { going: number; maybe: number; declined: number };
    myRsvp?: 'going' | 'maybe' | 'declined' | null;
  },
): ScheduledEventDTO {
  return {
    id: bigintStr(ev.id)!,
    guildId: bigintStr(ev.guildId)!,
    creator: creator ? toPublicUser(creator) : null,
    name: ev.name,
    description: ev.description,
    startAt: isoDate(ev.startAt),
    endAt: ev.endAt ? isoDate(ev.endAt) : null,
    locationKind: ev.locationKind,
    locationChannelId: bigintStr(ev.locationChannelId),
    locationText: ev.locationText,
    status: ev.status,
    imageUrl: ev.imageUrl,
    rsvpCounts: extra?.rsvpCounts,
    myRsvp: extra?.myRsvp,
    createdAt: isoDate(ev.createdAt),
    updatedAt: isoDate(ev.updatedAt),
  };
}

export interface EventRsvpDTO {
  eventId: string;
  user: PublicUserDTO;
  status: 'going' | 'maybe' | 'declined';
  createdAt: string;
  updatedAt: string;
}

export function toEventRsvp(
  rsvp: import('@zekktris/db/schema').EventRsvp,
  user: import('@zekktris/db/schema').User,
): EventRsvpDTO {
  return {
    eventId: bigintStr(rsvp.eventId)!,
    user: toPublicUser(user),
    status: rsvp.status,
    createdAt: isoDate(rsvp.createdAt),
    updatedAt: isoDate(rsvp.updatedAt),
  };
}
