/**
 * Constants
 * ---------
 * Hard limits and well-known values used across client and server. These are
 * the non-configurable bounds (input lengths, channel name shapes, etc.).
 * Runtime-configurable knobs (upload size cap, registration mode) live in
 * the API's env config, not here.
 */

// ── Identity ─────────────────────────────────────────────────────────────
export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 32;
export const DISPLAY_NAME_MAX_LENGTH = 32;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200; // bcrypt 72-byte limit handled separately
export const BIO_MAX_LENGTH = 200;
export const CUSTOM_STATUS_MAX_LENGTH = 128;

/** Lowercased, alphanumerics + underscore + period; no consecutive periods. */
export const USERNAME_REGEX = /^(?!.*\.\.)[a-z0-9_.]+$/;

// ── Guilds ───────────────────────────────────────────────────────────────
export const GUILD_NAME_MIN_LENGTH = 2;
export const GUILD_NAME_MAX_LENGTH = 100;
export const GUILD_DESCRIPTION_MAX_LENGTH = 1024;
export const MAX_ROLES_PER_GUILD = 250;
export const MAX_CHANNELS_PER_GUILD = 500;
export const MAX_MEMBERS_PER_GUILD_DEFAULT = 250_000;

// ── Channels ─────────────────────────────────────────────────────────────
export const CHANNEL_NAME_MIN_LENGTH = 1;
export const CHANNEL_NAME_MAX_LENGTH = 100;
export const CHANNEL_TOPIC_MAX_LENGTH = 1024;
export const SLOWMODE_MAX_SECONDS = 21_600; // 6 hours

// ── Messages ─────────────────────────────────────────────────────────────
export const MESSAGE_CONTENT_MAX_LENGTH = 4000;
export const MESSAGES_PAGE_DEFAULT = 50;
export const MESSAGES_PAGE_MAX = 100;

// ── Roles ────────────────────────────────────────────────────────────────
export const ROLE_NAME_MIN_LENGTH = 1;
export const ROLE_NAME_MAX_LENGTH = 100;
export const EVERYONE_ROLE_NAME = '@everyone';

// ── DMs / Group DMs ──────────────────────────────────────────────────────
export const GROUP_DM_NAME_MAX_LENGTH = 100;

// ── Invites ──────────────────────────────────────────────────────────────
export const INVITE_CODE_LENGTH = 8;
export const INVITE_DEFAULT_TTL_SECONDS = 86_400; // 24h
export const INVITE_MAX_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ── Defaults ─────────────────────────────────────────────────────────────
export const DEFAULT_AVATAR_COLORS = [
  0x5865f2, 0xed4245, 0xfee75c, 0x57f287, 0xeb459e, 0xf26522, 0x9b59b6,
] as const;

// ── User status (mirrors the DB enum) ────────────────────────────────────
export const UserStatus = {
  ONLINE: 'online',
  IDLE: 'idle',
  DND: 'dnd',
  OFFLINE: 'offline',
  INVISIBLE: 'invisible',
} as const;

// ── Relationship types (mirrors the DB enum) ─────────────────────────────
export const RelationshipType = {
  OUTGOING_REQUEST: 'outgoing_request',
  INCOMING_REQUEST: 'incoming_request',
  FRIEND: 'friend',
  BLOCKED: 'blocked',
} as const;
