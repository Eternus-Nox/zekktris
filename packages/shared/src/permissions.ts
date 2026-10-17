/**
 * Permissions
 * -----------
 * Discord-style bitfield permission system, with one deliberate difference:
 * Discord copies ("syncs") a category's overrides onto its channels, while
 * here a channel inherits them at resolve time. computeChannelPermissions
 * applies steps 5-7 below for the parent CATEGORY, then again for the channel
 * itself, so ANY channel-level override beats ANY category-level one — a
 * channel @everyone allow re-opens a category member deny. (On Discord an
 * unsynced channel ignores the category entirely, so this exposes nothing
 * extra.)
 *
 * Stored as a 64-bit bigint. Each flag is a power of two. Permissions can be
 * OR'd together for "has any of", AND'd to test, and combined with the
 * channel-override allow/deny pair for per-channel resolution.
 *
 * The resolver (`computeBasePermissions()` + `computeChannelPermissions()`)
 * is the canonical authorization algorithm and follows Discord's order:
 *   1. Owner short-circuit
 *   2. @everyone role base
 *   3. OR in additional roles
 *   4. ADMINISTRATOR short-circuit
 *   5. @everyone channel override (deny then allow)
 *   6. Per-role channel overrides (folded together: deny then allow)
 *   7. Per-member channel override (deny then allow)
 *
 * The API (source of truth) uses this file. Never branch the algorithm. The
 * web client keeps its own display catalog of the same bits in
 * apps/web/src/lib/permissions.ts (apps/web/test/permissionsCatalog.test.ts
 * fails if the two drift), so add any new bit there too.
 */

export const Permissions = {
  // Core
  ADMINISTRATOR: 1n << 0n,
  VIEW_CHANNEL: 1n << 1n,
  READ_MESSAGE_HISTORY: 1n << 2n,

  // Messaging
  SEND_MESSAGES: 1n << 3n,
  MANAGE_MESSAGES: 1n << 4n,
  ATTACH_FILES: 1n << 5n,
  EMBED_LINKS: 1n << 6n,
  ADD_REACTIONS: 1n << 7n,
  USE_EXTERNAL_EMOJIS: 1n << 8n,
  MENTION_EVERYONE: 1n << 9n,

  // Channel management
  MANAGE_CHANNELS: 1n << 10n,
  CREATE_INVITE: 1n << 11n,

  // Role / member management
  MANAGE_ROLES: 1n << 12n,
  KICK_MEMBERS: 1n << 13n,
  BAN_MEMBERS: 1n << 14n,
  CHANGE_NICKNAME: 1n << 15n,
  MANAGE_NICKNAMES: 1n << 16n,
  MODERATE_MEMBERS: 1n << 17n, // timeouts

  // Server-wide
  MANAGE_GUILD: 1n << 18n,
  VIEW_AUDIT_LOG: 1n << 19n,
  MANAGE_WEBHOOKS: 1n << 20n, // reserved for v1.4
  MANAGE_EMOJIS: 1n << 21n, // reserved
  MANAGE_INVITES: 1n << 22n,

  // Voice (reserved for v1.1) — declared now so DB and overrides accept them
  CONNECT: 1n << 23n,
  SPEAK: 1n << 24n,
  MUTE_MEMBERS: 1n << 25n,
  DEAFEN_MEMBERS: 1n << 26n,
  MOVE_MEMBERS: 1n << 27n,
  USE_VAD: 1n << 28n, // voice-activity-detect
  PRIORITY_SPEAKER: 1n << 29n,

  // Video / streaming (reserved for v1.2)
  STREAM: 1n << 30n,
  USE_EMBEDDED_ACTIVITIES: 1n << 31n,

  // Scheduled events — gates create / update / delete / cancel on
  // scheduled_events. RSVP is open to all members regardless of
  // this permission. Bit 32.
  MANAGE_EVENTS: 1n << 32n,

  // Threads / forum posts — gates archiving and unarchiving any
  // thread (not just one's own), and deleting any post. Without
  // this bit, a user can still archive and delete their own posts
  // (creator privilege handled in the route layer). Bit 33.
  MANAGE_THREADS: 1n << 33n,
} as const;

export type PermissionName = keyof typeof Permissions;

/** All permissions OR'd together. ADMINISTRATOR effectively grants this. */
export const ALL_PERMISSIONS: bigint = Object.values(Permissions).reduce(
  (acc, bit) => acc | bit,
  0n,
);

/** Default permissions for the @everyone role on a fresh guild. */
export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
  Permissions.VIEW_CHANNEL |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.SEND_MESSAGES |
  Permissions.ATTACH_FILES |
  Permissions.EMBED_LINKS |
  Permissions.ADD_REACTIONS |
  Permissions.USE_EXTERNAL_EMOJIS |
  Permissions.CHANGE_NICKNAME |
  Permissions.CREATE_INVITE |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.USE_VAD |
  Permissions.STREAM;

// ───────────────────────────────────────────────────────────────────────────
// Bitfield helpers
// ───────────────────────────────────────────────────────────────────────────

export function hasPermission(bitfield: bigint, perm: bigint): boolean {
  // ADMINISTRATOR grants everything.
  if ((bitfield & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) return true;
  return (bitfield & perm) === perm;
}

export function hasAnyPermission(bitfield: bigint, perms: readonly bigint[]): boolean {
  if ((bitfield & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) return true;
  return perms.some((p) => (bitfield & p) === p);
}

export function permissionNames(bitfield: bigint): PermissionName[] {
  const out: PermissionName[] = [];
  for (const [name, bit] of Object.entries(Permissions) as [PermissionName, bigint][]) {
    if ((bitfield & bit) === bit) out.push(name);
  }
  return out;
}

export function bitfieldFromNames(names: readonly PermissionName[]): bigint {
  return names.reduce((acc, n) => acc | Permissions[n], 0n);
}

// ───────────────────────────────────────────────────────────────────────────
// Permission resolver — the canonical algorithm
// ───────────────────────────────────────────────────────────────────────────

export interface ResolvableRole {
  /** Higher position == higher in hierarchy. @everyone is always 0. */
  position: number;
  permissions: bigint;
}

export interface ResolvableOverride {
  allow: bigint;
  deny: bigint;
}

export interface ResolveBaseInput {
  /** True if the member is the guild owner — short-circuits to ALL. */
  isOwner: boolean;
  /** The @everyone role for this guild. */
  everyoneRole: ResolvableRole;
  /** All other roles the member has. */
  memberRoles: readonly ResolvableRole[];
}

export interface ResolveChannelInput extends ResolveBaseInput {
  /** Override applied to @everyone in this channel, if any. */
  everyoneOverride?: ResolvableOverride | null;
  /**
   * Overrides applied to each role the member has, in any order.
   * The resolver folds them together (all denies, then all allows).
   */
  roleOverrides?: readonly ResolvableOverride[];
  /** Override applied directly to this member, if any. */
  memberOverride?: ResolvableOverride | null;
  // ── Parent category overrides ─────────────────────────────────────────
  // When a channel is inside a category (channel.parentId set), the
  // category's permission overrides apply FIRST, then the channel's
  // overrides apply on top. This is the Discord model: setting
  // "members can't speak in #general" via the channel beats setting
  // "everyone can speak in [Voice category]" at the parent level.
  // Each of these is the matching override on the PARENT category, if
  // any. Pass null/empty when the channel has no parent.
  categoryEveryoneOverride?: ResolvableOverride | null;
  categoryRoleOverrides?: readonly ResolvableOverride[];
  categoryMemberOverride?: ResolvableOverride | null;
}

/**
 * Compute the base (server-wide) permissions a member has. This is the value
 * used when there is no specific channel context — for actions like creating
 * a channel, kicking a user, etc.
 */
export function computeBasePermissions(input: ResolveBaseInput): bigint {
  if (input.isOwner) return ALL_PERMISSIONS;

  let perms = input.everyoneRole.permissions;
  for (const role of input.memberRoles) {
    perms |= role.permissions;
  }

  if ((perms & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  return perms;
}

/**
 * Compute the effective permissions a member has *in a specific channel*,
 * applying the role-and-override resolution algorithm exactly as Discord does.
 */
export function computeChannelPermissions(input: ResolveChannelInput): bigint {
  if (input.isOwner) return ALL_PERMISSIONS;

  let perms = computeBasePermissions(input);

  // ADMINISTRATOR bypasses overrides entirely.
  if ((perms & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  // Helper: fold a (everyone, roles[], member) trio of overrides onto the
  // running bitfield in Discord's exact order (everyone → roles → member).
  // We run this twice: first with the parent CATEGORY's overrides, then
  // with the CHANNEL's own overrides, so child overrides win where they
  // disagree with the parent.
  const applyTier = (
    everyone: ResolvableOverride | null | undefined,
    roles: readonly ResolvableOverride[] | undefined,
    member: ResolvableOverride | null | undefined,
  ): void => {
    if (everyone) {
      perms &= ~everyone.deny;
      perms |= everyone.allow;
    }
    if (roles && roles.length > 0) {
      let allow = 0n;
      let deny = 0n;
      for (const ov of roles) {
        allow |= ov.allow;
        deny |= ov.deny;
      }
      perms &= ~deny;
      perms |= allow;
    }
    if (member) {
      perms &= ~member.deny;
      perms |= member.allow;
    }
  };

  // 1. Parent category tier — only present if the channel has a parent.
  applyTier(
    input.categoryEveryoneOverride ?? null,
    input.categoryRoleOverrides,
    input.categoryMemberOverride ?? null,
  );

  // 2. Channel's own tier — wins over the category where they overlap.
  applyTier(
    input.everyoneOverride ?? null,
    input.roleOverrides,
    input.memberOverride ?? null,
  );

  return perms;
}
