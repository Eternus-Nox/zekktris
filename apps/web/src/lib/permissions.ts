/**
 * Permission catalog
 * ------------------
 * Every permission bit (0..33) with display metadata: human label, group, a
 * one-line explanation, and whether the bit is meaningful as a per-
 * channel override.
 *
 * Bit numbers MUST stay in sync with packages/shared/src/permissions.ts.
 * We don't import that module here because:
 *   1. The shared module exports BigInt constants — too heavy for use
 *      in JSX checkbox arrays where we need plain numbers/strings.
 *   2. Display metadata (label, group, scope) is web-only concern; no
 *      reason to ship it to the api or the schema package.
 *
 * The `scope` field describes where each bit can apply:
 *   - 'guild' bits are only meaningful at the role/guild level
 *     (e.g. KICK_MEMBERS — there's no "can kick on this channel only"
 *     sense). They appear in the role editor but NOT in the per-
 *     channel override editor.
 *   - 'channel' bits CAN appear in per-channel overrides AND at the
 *     role level. Examples: SEND_MESSAGES, VIEW_CHANNEL.
 *   - 'voice' bits are voice-channel-scoped specifically.
 *
 * The override editor filters to scope === 'channel' | 'voice' and
 * further filters voice bits when the channel isn't a voice channel
 * (see channelOverridePermissions below).
 */

import { ApiError, type Channel } from '@zekktris/client';

export type PermissionScope = 'guild' | 'channel' | 'voice';

export interface PermissionDef {
  /** Bit position (0..33). The bitfield bit is `1n << BigInt(bit)`. */
  bit: number;
  /** Stable identifier used in code paths and logs. */
  key: string;
  /** Human-readable name for the UI. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** Section header in the editor. */
  group: 'general' | 'member' | 'text' | 'voice' | 'advanced';
  scope: PermissionScope;
}

// Order matters — this is the order the editor renders. Within each
// group, ordering is roughly "most-used first."
export const PERMISSIONS: PermissionDef[] = [
  // ── General ──────────────────────────────────────────────────────────────
  {
    bit: 0,
    key: 'ADMINISTRATOR',
    label: 'Administrator',
    description: 'Bypass every permission check on this server. Grant carefully.',
    group: 'general',
    scope: 'guild',
  },
  {
    bit: 18,
    key: 'MANAGE_GUILD',
    label: 'Manage Server',
    description: 'Edit server name, icon, and other settings.',
    group: 'general',
    scope: 'guild',
  },
  {
    bit: 12,
    key: 'MANAGE_ROLES',
    label: 'Manage Roles',
    description: 'Create, edit, and delete roles and permission overrides.',
    group: 'general',
    scope: 'guild',
  },
  {
    bit: 10,
    key: 'MANAGE_CHANNELS',
    label: 'Manage Channels',
    description: 'Create, edit, and delete channels.',
    group: 'general',
    scope: 'channel',
  },
  {
    bit: 1,
    key: 'VIEW_CHANNEL',
    label: 'View Channel',
    description: 'See this channel and its messages.',
    group: 'general',
    scope: 'channel',
  },
  {
    bit: 19,
    key: 'VIEW_AUDIT_LOG',
    label: 'View Audit Log',
    description: 'Read the audit log of admin actions.',
    group: 'general',
    scope: 'guild',
  },
  {
    bit: 32,
    key: 'MANAGE_EVENTS',
    label: 'Manage Events',
    description: 'Create, edit, cancel, and delete scheduled events.',
    group: 'general',
    scope: 'guild',
  },

  // ── Membership ───────────────────────────────────────────────────────────
  {
    bit: 11,
    key: 'CREATE_INVITE',
    label: 'Create Invite',
    description: 'Generate invite links other people can use to join.',
    group: 'member',
    scope: 'channel',
  },
  {
    bit: 22,
    key: 'MANAGE_INVITES',
    label: 'Manage Invites',
    description: 'View and revoke any invite, not just your own.',
    group: 'member',
    scope: 'guild',
  },
  {
    bit: 13,
    key: 'KICK_MEMBERS',
    label: 'Kick Members',
    description: 'Remove members from the server (they can rejoin via invite).',
    group: 'member',
    scope: 'guild',
  },
  {
    bit: 14,
    key: 'BAN_MEMBERS',
    label: 'Ban Members',
    description: 'Permanently remove members and prevent re-joining.',
    group: 'member',
    scope: 'guild',
  },
  {
    bit: 17,
    key: 'MODERATE_MEMBERS',
    label: 'Time Out Members',
    description: 'Temporarily prevent members from sending messages or joining voice.',
    group: 'member',
    scope: 'guild',
  },
  {
    bit: 15,
    key: 'CHANGE_NICKNAME',
    label: 'Change Own Nickname',
    description: 'Edit your own nickname on this server.',
    group: 'member',
    scope: 'guild',
  },
  {
    bit: 16,
    key: 'MANAGE_NICKNAMES',
    label: 'Manage Nicknames',
    description: 'Change other members’ nicknames.',
    group: 'member',
    scope: 'guild',
  },

  // ── Text channels ────────────────────────────────────────────────────────
  {
    bit: 3,
    key: 'SEND_MESSAGES',
    label: 'Send Messages',
    description: 'Post messages in this channel.',
    group: 'text',
    scope: 'channel',
  },
  {
    bit: 2,
    key: 'READ_MESSAGE_HISTORY',
    label: 'Read Message History',
    description: 'See messages posted before you joined or before now.',
    group: 'text',
    scope: 'channel',
  },
  {
    bit: 5,
    key: 'ATTACH_FILES',
    label: 'Attach Files',
    description: 'Upload files in messages.',
    group: 'text',
    scope: 'channel',
  },
  {
    bit: 6,
    key: 'EMBED_LINKS',
    label: 'Embed Links',
    description: 'Show link previews when posting URLs.',
    group: 'text',
    scope: 'channel',
  },
  {
    bit: 7,
    key: 'ADD_REACTIONS',
    label: 'Add Reactions',
    description: 'React to messages with emoji.',
    group: 'text',
    scope: 'channel',
  },
  {
    bit: 4,
    key: 'MANAGE_MESSAGES',
    label: 'Manage Messages',
    description: 'Delete or edit messages from any user; pin messages.',
    group: 'text',
    scope: 'channel',
  },
  {
    // Checked per channel by the thread archive/resolve routes: a thread
    // inherits its parent channel's overrides (and that channel's
    // category's), as in Discord. Deleting a thread needs MANAGE_CHANNELS.
    bit: 33,
    key: 'MANAGE_THREADS',
    label: 'Manage Threads',
    description: 'Archive and resolve any thread or forum post, not just your own.',
    group: 'text',
    scope: 'channel',
  },
  {
    bit: 9,
    key: 'MENTION_EVERYONE',
    label: 'Mention @everyone, @here, all roles',
    description: 'Trigger notifications for everyone or large groups.',
    group: 'text',
    scope: 'channel',
  },
  {
    bit: 8,
    key: 'USE_EXTERNAL_EMOJIS',
    label: 'Use External Emoji',
    description: 'Use emoji from other servers in messages and reactions.',
    group: 'text',
    scope: 'channel',
  },

  // ── Voice channels ───────────────────────────────────────────────────────
  {
    bit: 23,
    key: 'CONNECT',
    label: 'Connect',
    description: 'Join this voice channel.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 24,
    key: 'SPEAK',
    label: 'Speak',
    description: 'Transmit audio in voice channels.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 30,
    key: 'STREAM',
    label: 'Video / Screen Share',
    description: 'Publish a camera or screen-share track.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 28,
    key: 'USE_VAD',
    label: 'Use Voice Activity Detection',
    description: 'Without this, the user must hold push-to-talk to speak.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 25,
    key: 'MUTE_MEMBERS',
    label: 'Mute Members',
    description: 'Server-mute any member in any voice channel.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 26,
    key: 'DEAFEN_MEMBERS',
    label: 'Deafen Members',
    description: 'Server-deafen any member in any voice channel.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 27,
    key: 'MOVE_MEMBERS',
    label: 'Move Members',
    description: 'Move members between voice channels they have access to.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 29,
    key: 'PRIORITY_SPEAKER',
    label: 'Priority Speaker',
    description: 'When you speak, others get attenuated.',
    group: 'voice',
    scope: 'voice',
  },
  {
    bit: 31,
    key: 'USE_EMBEDDED_ACTIVITIES',
    label: 'Use Activities',
    description: 'Start shared activities in voice channels. (Reserved.)',
    group: 'voice',
    scope: 'voice',
  },

  // ── Advanced / reserved ──────────────────────────────────────────────────
  {
    bit: 20,
    key: 'MANAGE_WEBHOOKS',
    label: 'Manage Webhooks',
    description: 'Create and edit incoming webhook integrations. (Reserved.)',
    group: 'advanced',
    scope: 'guild',
  },
  {
    bit: 21,
    key: 'MANAGE_EMOJIS',
    label: 'Manage Emoji',
    description: 'Upload, rename, and remove custom server emoji.',
    group: 'advanced',
    scope: 'guild',
  },
];

/**
 * The bits the per-channel override editor offers for a channel of the
 * given type: every 'channel'-scoped bit, plus the 'voice'-scoped bits
 * on voice channels. 'guild'-scoped bits are role-level only.
 */
export function channelOverridePermissions(channelType: Channel['type']): PermissionDef[] {
  return PERMISSIONS.filter(
    (p) => p.scope === 'channel' || (p.scope === 'voice' && channelType === 'guild_voice'),
  );
}

export const PERMISSION_GROUPS: Array<{ id: PermissionDef['group']; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'member', label: 'Membership' },
  { id: 'text', label: 'Text' },
  { id: 'voice', label: 'Voice' },
  { id: 'advanced', label: 'Advanced' },
];

// ── BigInt helpers ──────────────────────────────────────────────────────────
//
// Permission values are decimal strings on the wire. The browser supports
// BigInt natively, so we parse for bit-test and serialize for transmit.

/** Parse a decimal-string bitfield into a BigInt. Empty/null = 0. */
export function parsePerms(s: string | null | undefined): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Test whether a bit is set in the bitfield. */
export function hasBit(perms: bigint, bit: number): boolean {
  return (perms & (1n << BigInt(bit))) !== 0n;
}

/** Return a new bitfield with the given bit set or cleared. */
export function withBit(perms: bigint, bit: number, on: boolean): bigint {
  const mask = 1n << BigInt(bit);
  return on ? perms | mask : perms & ~mask;
}

/** Stringify for the wire format. */
export function permsToString(perms: bigint): string {
  return perms.toString();
}

// ── Member permission compute ───────────────────────────────────────────────
//
// Mirrors the server's `computeBasePermissions` from @zekktris/shared but
// in client-friendly types: a `Role[]` list (any subset is fine, must
// include @everyone if perm compute should be accurate) and a
// `roleIds: string[]` for the member's assigned roles. We keep this
// duplicated rather than importing from shared because the server
// stores `permissions` as a decimal string and the bigint conversion
// happens in lib/permissions's `parsePerms` already — pulling in the
// shared module would create a transitive dependency on the schema
// types we don't need.

import type { Role } from '@zekktris/client';

/**
 * Compute the effective guild-wide permission bitfield for a member,
 * given the guild's roles list (including @everyone) and the member's
 * assigned role ids. Owner short-circuits to all-bits; ADMINISTRATOR
 * also short-circuits to all-bits; otherwise OR the everyone role
 * bits with each assigned role's bits.
 *
 * @param roles full roles list for the guild (everyone identified by
 *              `id === guildId`); ordering doesn't matter
 * @param guildId the guild id, used to find @everyone
 * @param memberRoleIds the role ids assigned to the member
 * @param isOwner true if the member is the guild owner
 */
export function computeMemberGuildPerms(
  roles: Role[],
  guildId: string,
  memberRoleIds: string[],
  isOwner: boolean,
): bigint {
  if (isOwner) {
    // Same as ALL_PERMISSIONS server-side: every defined bit set.
    return PERMISSIONS.reduce((acc, p) => acc | (1n << BigInt(p.bit)), 0n);
  }
  const everyone = roles.find((r) => r.id === guildId);
  let perms = parsePerms(everyone?.permissions);
  const assigned = new Set(memberRoleIds);
  for (const r of roles) {
    if (r.id === guildId) continue; // @everyone already folded in
    if (!assigned.has(r.id)) continue;
    perms |= parsePerms(r.permissions);
  }
  // ADMINISTRATOR short-circuit — server applies the same shortcut.
  const ADMIN = 1n << 0n;
  if ((perms & ADMIN) === ADMIN) {
    return PERMISSIONS.reduce((acc, p) => acc | (1n << BigInt(p.bit)), 0n);
  }
  return perms;
}

/**
 * Highest position among the roles this member has assigned. Used for
 * role-hierarchy checks (you must outrank a role / a member to manage
 * them). @everyone's position is conventionally 0; non-everyone roles
 * have positive positions. A member with no roles besides @everyone
 * returns 0.
 */
export function memberHighestRolePosition(
  roles: Role[],
  guildId: string,
  memberRoleIds: string[],
): number {
  let max = 0;
  const assigned = new Set(memberRoleIds);
  for (const r of roles) {
    if (r.id === guildId) continue;
    if (!assigned.has(r.id)) continue;
    if (r.position > max) max = r.position;
  }
  return max;
}

/**
 * Tiny convenience over the bitwise check. Useful in places where
 * we have a single `bit` literal in scope (e.g. a tab definition's
 * required-permission gate) and want to keep the call site readable.
 *
 *   const canBan = hasPermissionBit(perms, 14);   // BAN_MEMBERS
 */
export function hasPermissionBit(perms: bigint, bit: number): boolean {
  const mask = 1n << BigInt(bit);
  return (perms & mask) === mask;
}

/**
 * Compute the display color for a member based on their roles. Returns
 * the color of the highest-position role with a non-zero color, as a
 * hex string `#rrggbb`. Returns `null` if no role provides a color —
 * the caller should fall back to the default text color in that case.
 *
 * Discord's exact rule: roles paint the member's name in the color of
 * the highest-positioned role that has BOTH a non-zero color AND an
 * explicit color (not the default 0x000000 placeholder). Position
 * ties don't realistically happen because of the unique-position
 * constraint, but if they did, we'd fall back to insertion order.
 */
export function memberDisplayColor(
  roles: Role[],
  guildId: string,
  memberRoleIds: string[],
): string | null {
  const assigned = new Set(memberRoleIds);
  let best: Role | null = null;
  for (const r of roles) {
    if (r.id === guildId) continue; // @everyone never paints
    if (!assigned.has(r.id)) continue;
    if (!r.color || r.color === 0) continue;
    if (!best || r.position > best.position) best = r;
  }
  if (!best) return null;
  return '#' + best.color.toString(16).padStart(6, '0');
}

/**
 * Convenience: does this member effectively have ADMINISTRATOR (either
 * by being the guild owner OR by having the bit set via a role)? Used
 * to gate UI affordances that should be available to admins regardless
 * of the specific permission bit they'd otherwise need (e.g. opening
 * any tab in the server-settings modal).
 *
 * Returns false safely when role data isn't loaded yet, which means
 * gated UI stays hidden until the permission picture is fully known.
 */
export function memberIsAdmin(
  roles: Role[] | null | undefined,
  guildId: string,
  memberRoleIds: string[] | null | undefined,
  isOwner: boolean,
): boolean {
  if (isOwner) return true;
  if (!roles || !memberRoleIds) return false;
  const perms = computeMemberGuildPerms(roles, guildId, memberRoleIds, false);
  // ADMINISTRATOR is bit 0; computeMemberGuildPerms expands to
  // ALL_PERMISSIONS when set, so checking any specific bit also
  // works — but the bit-0 check is the canonical predicate.
  return hasPermissionBit(perms, 0);
}

/**
 * Toast text for a failed thread archive/resolve. The web client can't
 * resolve per-channel overrides, so it may show those buttons to someone a
 * channel override denies MANAGE_THREADS; the server's 403 then gets a
 * message that says what's missing instead of a generic one.
 */
export function threadToggleErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code === 'MISSING_PERMISSIONS') {
    return 'You need Manage Threads in this channel to change a thread you didn’t start.';
  }
  return e.message;
}
