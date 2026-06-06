/**
 * Permissions service
 * -------------------
 * Source of truth for "can this member do X in this guild / channel?"
 *
 * The pure algorithm lives in @zekktris/shared/permissions so the web client
 * can mirror it for UI gating. This file is the *server* side: it fetches
 * the relevant rows (member, member's roles, @everyone role, channel
 * overrides) and feeds them into the algorithm.
 *
 * Convention: the @everyone role has id === guildId. Same trick Discord
 * uses — it gives O(1) lookup and avoids a separate flag.
 *
 * Two entry points exist for almost every action:
 *   - guild-scoped:   "does this member have MANAGE_GUILD?"
 *   - channel-scoped: "does this member have SEND_MESSAGES in #general?"
 *                     (folds in @everyone, role, and member overrides)
 *
 * Each has an `assert*` variant that throws MISSING_PERMISSIONS instead of
 * returning a bool.
 *
 * Role-hierarchy guards are separate (`assertCanManageRole`,
 * `assertCanManageMember`): MANAGE_ROLES and MANAGE_NICKNAMES alone aren't
 * enough — you also have to be *above* the target in the role hierarchy.
 */

import { and, eq, inArray, gte, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import {
  ALL_PERMISSIONS,
  Permissions,
  computeBasePermissions,
  computeChannelPermissions,
  hasPermission,
  permissionNames,
  type ResolvableOverride,
  type ResolvableRole,
} from '@zekktris/shared/permissions';

// ── Membership & role lookup ───────────────────────────────────────────────

interface ResolvedMember {
  guildId: bigint;
  userId: bigint;
  isOwner: boolean;
  /** Snowflake ids of the roles the member currently has (excluding @everyone). */
  roleIds: bigint[];
  everyoneRole: ResolvableRole;
  memberRoles: ResolvableRole[];
}

/**
 * Load the data needed for permission resolution. Returns null if the user
 * is not a member of the guild. The @everyone role lookup is a bigint
 * comparison against the guild id, which is cheap and unique per guild.
 */
async function loadMember(guildId: bigint, userId: bigint): Promise<ResolvedMember | null> {
  // The first three queries are mutually independent — guild row,
  // membership row, and the list of role-ids the member has are all
  // keyed on (guildId, userId) without needing each other. Previously
  // they ran sequentially, paying 3 round-trips on what fires on
  // every permission check, which fires on every message-route call.
  // Parallelize.
  const [guildRow, memberRow, memberRoleIds] = await Promise.all([
    db
      .select({ id: schema.guilds.id, ownerId: schema.guilds.ownerId })
      .from(schema.guilds)
      .where(eq(schema.guilds.id, guildId))
      .limit(1),
    db
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(
        and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, userId)),
      )
      .limit(1),
    db
      .select({ roleId: schema.memberRoles.roleId })
      .from(schema.memberRoles)
      .where(
        and(eq(schema.memberRoles.guildId, guildId), eq(schema.memberRoles.userId, userId)),
      ),
  ]);
  const guild = guildRow[0];
  if (!guild) return null;
  if (!memberRow[0]) return null;

  // Roles depend on memberRoleIds, so this stays sequential. Loads
  // member-assigned roles *and* the @everyone role in one query.
  const ids = [guildId, ...memberRoleIds.map((r) => r.roleId)];
  const roleRows = await db
    .select({
      id: schema.roles.id,
      position: schema.roles.position,
      permissions: schema.roles.permissions,
    })
    .from(schema.roles)
    .where(and(eq(schema.roles.guildId, guildId), inArray(schema.roles.id, ids)));

  // @everyone is the role with id === guildId. If somehow missing (corrupt
  // data — shouldn't happen, the create-guild transaction always inserts it)
  // fall back to a zero-permission stub so the request fails closed.
  const everyone = roleRows.find((r) => r.id === guildId) ?? { id: guildId, position: 0, permissions: 0n };
  const memberRoles = roleRows.filter((r) => r.id !== guildId);

  return {
    guildId,
    userId,
    isOwner: guild.ownerId === userId,
    roleIds: memberRoles.map((r) => r.id),
    everyoneRole: { position: everyone.position, permissions: everyone.permissions },
    memberRoles: memberRoles.map((r) => ({ position: r.position, permissions: r.permissions })),
  };
}

// ── Computation entry points ───────────────────────────────────────────────

/**
 * Compute the guild-wide permission bitfield for a member. Returns 0 if the
 * user isn't a member of the guild — callers should typically pair this with
 * `ensureMember` to distinguish "not a member" from "has no perms".
 */
export async function computeMemberGuildPermissions(
  guildId: bigint,
  userId: bigint,
): Promise<bigint> {
  const m = await loadMember(guildId, userId);
  if (!m) return 0n;
  return computeBasePermissions({
    isOwner: m.isOwner,
    everyoneRole: m.everyoneRole,
    memberRoles: m.memberRoles,
  });
}

/**
 * Compute the effective permissions a member has in a specific channel.
 * Folds in the channel's @everyone, role, and member overrides per the
 * Discord algorithm.
 *
 * For DM/group-DM channels (no guildId), every recipient implicitly has full
 * permissions to participate. We still gate via dmRecipients membership in
 * the route layer.
 */
export async function computeMemberChannelPermissions(
  channelId: bigint,
  userId: bigint,
): Promise<bigint> {
  const channelRow = await db
    .select({
      id: schema.channels.id,
      guildId: schema.channels.guildId,
      type: schema.channels.type,
      parentId: schema.channels.parentId,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  const channel = channelRow[0];
  if (!channel) return 0n;

  // DMs: not part of the guild permission model. The caller must be a
  // recipient of the DM (membership recorded in dm_recipients).
  // Non-recipients get zero permissions — same fail-closed semantic
  // as guild non-members.
  //
  // We do the recipient check INSIDE this function (rather than
  // requiring every caller to gate ahead of us) because forgetting
  // the check is the kind of "permission resolver returns truthy
  // for users who shouldn't see the channel" bug that bypasses
  // every permission check downstream. Fail-closed at the source.
  if (!channel.guildId) {
    const isRecipient = await db
      .select({ userId: schema.dmRecipients.userId })
      .from(schema.dmRecipients)
      .where(
        and(
          eq(schema.dmRecipients.channelId, channelId),
          eq(schema.dmRecipients.userId, userId),
        ),
      )
      .limit(1);
    if (!isRecipient[0]) return 0n;
    return (
      Permissions.VIEW_CHANNEL |
      Permissions.READ_MESSAGE_HISTORY |
      Permissions.SEND_MESSAGES |
      Permissions.ATTACH_FILES |
      Permissions.EMBED_LINKS |
      Permissions.ADD_REACTIONS |
      Permissions.USE_EXTERNAL_EMOJIS |
      Permissions.MENTION_EVERYONE
    );
  }

  // Pull all overrides for this channel AND its parent category (if any)
  // in one query, then partition by source + target. The parent's
  // overrides apply first; the channel's own overrides win where they
  // overlap. This matches Discord's category-permission semantics.
  //
  // Parallel with the loadMember call below. They're mutually
  // independent — both only need the channel row's id/parentId which
  // is already in hand from the SELECT above. The previous sequential
  // implementation paid two round-trips on the hot path of every
  // permission check; the wasted-query cost when loadMember returns
  // null (user isn't a member) is negligible because the overrides
  // query is a small inArray on at most 2 channel ids.
  const channelIdsToQuery = channel.parentId
    ? [channelId, channel.parentId]
    : [channelId];
  const [m, overrideRows] = await Promise.all([
    loadMember(channel.guildId, userId),
    db
      .select()
      .from(schema.permissionOverrides)
      .where(inArray(schema.permissionOverrides.channelId, channelIdsToQuery)),
  ]);
  if (!m) return 0n;

  let everyoneOverride: ResolvableOverride | null = null;
  let memberOverride: ResolvableOverride | null = null;
  const roleOverrides: ResolvableOverride[] = [];
  let categoryEveryoneOverride: ResolvableOverride | null = null;
  let categoryMemberOverride: ResolvableOverride | null = null;
  const categoryRoleOverrides: ResolvableOverride[] = [];

  for (const ov of overrideRows) {
    const isCategory = channel.parentId !== null && ov.channelId === channel.parentId;
    if (ov.targetType === 'role') {
      // @everyone override has targetId === guildId (matches the role).
      if (ov.targetId === channel.guildId) {
        if (isCategory) categoryEveryoneOverride = { allow: ov.allow, deny: ov.deny };
        else everyoneOverride = { allow: ov.allow, deny: ov.deny };
      } else if (m.roleIds.includes(ov.targetId)) {
        if (isCategory) categoryRoleOverrides.push({ allow: ov.allow, deny: ov.deny });
        else roleOverrides.push({ allow: ov.allow, deny: ov.deny });
      }
    } else if (ov.targetType === 'member' && ov.targetId === userId) {
      if (isCategory) categoryMemberOverride = { allow: ov.allow, deny: ov.deny };
      else memberOverride = { allow: ov.allow, deny: ov.deny };
    }
  }

  return computeChannelPermissions({
    isOwner: m.isOwner,
    everyoneRole: m.everyoneRole,
    memberRoles: m.memberRoles,
    everyoneOverride,
    roleOverrides,
    memberOverride,
    categoryEveryoneOverride,
    categoryRoleOverrides,
    categoryMemberOverride,
  });
}

// ── Bulk channel-permission helpers ───────────────────────────────────────

/**
 * Return the channel IDs in `guildId` where `userId` has VIEW_CHANNEL set
 * after applying base + per-channel overrides. Used by the gateway at
 * IDENTIFY time to seed each connection's viewable-channel set, so per-
 * channel events can be filtered without a DB query at fanout.
 *
 * Cost: 2 queries (channels + overrides) per guild. Loaded once at IDENTIFY
 * and refreshed by the maintenance hooks below — never on the hot dispatch
 * path.
 */
export async function listViewableGuildChannelIds(
  guildId: bigint,
  userId: bigint,
): Promise<bigint[]> {
  const m = await loadMember(guildId, userId);
  if (!m) return [];

  // Owners and ADMINISTRATOR-bit holders see every channel by definition;
  // skip the override math entirely.
  const guildPerms = computeBasePermissions({
    isOwner: m.isOwner,
    everyoneRole: m.everyoneRole,
    memberRoles: m.memberRoles,
  });
  if (m.isOwner || hasPermission(guildPerms, Permissions.ADMINISTRATOR)) {
    const allChannels = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.guildId, guildId),
          // Soft-deleted channels are gone from the user's POV; including
          // them here would re-surface them in CHANNEL_CREATE diffs during
          // permission refresh and leak their existence in the visible
          // set the gateway broadcasts.
          isNull(schema.channels.deletedAt),
        ),
      );
    return allChannels.map((r) => r.id);
  }

  // Pull all channels in the guild, then all overrides for those channels
  // in one query each. We then partition overrides per-channel in memory
  // and run the existing computeChannelPermissions for each, keeping only
  // those where VIEW_CHANNEL ends up set.
  const channels = await db
    .select({
      id: schema.channels.id,
      parentId: schema.channels.parentId,
      type: schema.channels.type,
    })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.guildId, guildId),
        // Same filter as above — keep deleted channels out of the
        // viewable computation entirely.
        isNull(schema.channels.deletedAt),
      ),
    );
  if (channels.length === 0) return [];

  const overrides = await db
    .select()
    .from(schema.permissionOverrides)
    .where(
      inArray(
        schema.permissionOverrides.channelId,
        channels.map((c) => c.id),
      ),
    );

  // Group overrides by channelId so we can compute each channel's perms
  // independently. Keep the per-target separation the resolver expects.
  // Each bucket holds BOTH the channel's own overrides AND, when the
  // channel has a parentId, the parent category's overrides — so the
  // resolver can apply them in Discord's category-then-channel order.
  const byChannel = new Map<
    bigint,
    {
      everyoneOverride: ResolvableOverride | null;
      memberOverride: ResolvableOverride | null;
      roleOverrides: ResolvableOverride[];
    }
  >();
  for (const c of channels) {
    byChannel.set(c.id, { everyoneOverride: null, memberOverride: null, roleOverrides: [] });
  }
  for (const ov of overrides) {
    const bucket = byChannel.get(ov.channelId);
    if (!bucket) continue;
    if (ov.targetType === 'role') {
      if (ov.targetId === guildId) {
        bucket.everyoneOverride = { allow: ov.allow, deny: ov.deny };
      } else if (m.roleIds.includes(ov.targetId)) {
        bucket.roleOverrides.push({ allow: ov.allow, deny: ov.deny });
      }
    } else if (ov.targetType === 'member' && ov.targetId === userId) {
      bucket.memberOverride = { allow: ov.allow, deny: ov.deny };
    }
  }

  const out: bigint[] = [];
  for (const c of channels) {
    const own = byChannel.get(c.id)!;
    // If this channel has a parent category, look up the parent's
    // overrides bucket and pass them as the category-tier inputs.
    // Categories themselves have parentId = null and so contribute
    // no parent overrides on this pass.
    const parent = c.parentId ? byChannel.get(c.parentId) : undefined;
    const perms = computeChannelPermissions({
      isOwner: m.isOwner,
      everyoneRole: m.everyoneRole,
      memberRoles: m.memberRoles,
      everyoneOverride: own.everyoneOverride,
      roleOverrides: own.roleOverrides,
      memberOverride: own.memberOverride,
      categoryEveryoneOverride: parent?.everyoneOverride ?? null,
      categoryRoleOverrides: parent?.roleOverrides ?? [],
      categoryMemberOverride: parent?.memberOverride ?? null,
    });
    if (hasPermission(perms, Permissions.VIEW_CHANNEL)) out.push(c.id);
  }
  return reconcileCategoryVisibility(out, channels, {
    preserveEmptyCategories: hasPermission(guildPerms, Permissions.MANAGE_CHANNELS),
  });
}

/**
 * Post-process a viewable channel set so categories and their children
 * stay aligned with the user's actual access.
 *
 * Two cleanups:
 *
 *   1. **Orphan-child rescue**: if a non-category channel is viewable
 *      but its parent category is NOT, add the category back. This
 *      happens when an admin grants explicit allow on a child but the
 *      user lacks VIEW_CHANNEL on the parent. Without this, the
 *      sidebar would render the child under no category header,
 *      which looks broken.
 *
 *   2. **Empty-category prune**: if a category IS viewable but has zero
 *      viewable non-category children, remove the category. This is
 *      the "you can see the door but nothing's behind it" case — the
 *      user has VIEW_CHANNEL on the category (so the resolver said
 *      yes) but every child is denied, leaving an empty header in
 *      the sidebar. Pruning gives a cleaner channel list and matches
 *      what users expect: if permissions hide everything inside a
 *      category, the category vanishes too.
 *
 * The owner / ADMINISTRATOR short-circuit branches return ALL channels
 * including categories before this function is called, so admins
 * still see empty categories in their sidebar (useful for newly-created
 * categories awaiting content, or for managing layout).
 */
function reconcileCategoryVisibility(
  viewableIds: bigint[],
  channels: Array<{ id: bigint; parentId: bigint | null; type: string }>,
  opts: { preserveEmptyCategories?: boolean } = {},
): bigint[] {
  const viewable = new Set(viewableIds);
  // Index categories so we can quickly check "is this id a category?".
  const categoryIds = new Set<bigint>();
  // Track which categories have at least one visible non-category child.
  const categoriesWithVisibleChild = new Set<bigint>();
  for (const c of channels) {
    if (c.type === 'guild_category') {
      categoryIds.add(c.id);
    } else if (c.parentId && viewable.has(c.id)) {
      categoriesWithVisibleChild.add(c.parentId);
    }
  }

  // (1) Orphan-child rescue: always applies. A child without its
  // header would just look broken regardless of admin status.
  for (const parentId of categoriesWithVisibleChild) {
    if (!viewable.has(parentId)) viewable.add(parentId);
  }

  // (2) Empty-category prune: skipped for MANAGE_CHANNELS holders so
  // admins keep the "add a channel here" UX on empty categories.
  if (!opts.preserveEmptyCategories) {
    for (const cid of viewableIds) {
      if (categoryIds.has(cid) && !categoriesWithVisibleChild.has(cid)) {
        viewable.delete(cid);
      }
    }
  }

  return Array.from(viewable);
}

/**
 * The all-guilds version: returns every viewable channel id across all the
 * user's guilds, flattened. Called once at IDENTIFY by the gateway.
 *
 * We parallelize the per-guild calls — each is independent, and IDENTIFY
 * is a one-shot at connection time. Not in the hot path.
 */
export async function listAllViewableGuildChannelIds(
  guildIds: Iterable<bigint>,
  userId: bigint,
): Promise<bigint[]> {
  const ids = Array.from(guildIds);
  if (ids.length === 0) return [];
  const lists = await Promise.all(
    ids.map((gid) => listViewableGuildChannelIds(gid, userId)),
  );
  return lists.flat();
}

/**
 * BATCHED version of listViewableGuildChannelIds — computes the
 * viewable-channel set for MANY users in one round of queries.
 *
 * Why this exists: when a role permission changes,
 * applyGuildPermissionChange fans out a permission recompute to every
 * currently-connected member of the guild. The naive implementation
 * (Promise.all over per-user listViewableGuildChannelIds) costs
 * 3 queries per user — loadMember (guild + member-roles + role-rows),
 * the channels query, and the overrides query. On a 200-member guild
 * with most members connected, that's ~600 round-trips for a single
 * role edit.
 *
 * This helper restructures the load:
 *   1. ONE query: guild row + everyone-role (covers isOwner check + the
 *      @everyone permissions/position).
 *   2. ONE query: ALL channels in the guild (shared across users).
 *   3. ONE query: ALL overrides for those channels (shared).
 *   4. ONE query: ALL roles in the guild keyed by id (shared).
 *   5. ONE query: member-role assignments for the listed users only.
 *
 * Then the per-user permission math runs in memory. Constant DB cost
 * regardless of how many users we're computing for. Returns a Map
 * keyed by userId; users with no membership row simply get an empty
 * set (matches listViewableGuildChannelIds returning []).
 */
export async function listViewableGuildChannelIdsForUsers(
  guildId: bigint,
  userIds: bigint[],
): Promise<Map<bigint, Set<bigint>>> {
  const result = new Map<bigint, Set<bigint>>();
  if (userIds.length === 0) return result;

  // Phase 1: load everything that doesn't depend on the channels list.
  // We need the channel ids before we can scope the overrides query,
  // so overrides is fetched in phase 2.
  const [guildRow, channels, allRoles, memberRolesRows, memberRows] =
    await Promise.all([
      db
        .select({ ownerId: schema.guilds.ownerId })
        .from(schema.guilds)
        .where(eq(schema.guilds.id, guildId))
        .limit(1),
      db
        .select({
          id: schema.channels.id,
          parentId: schema.channels.parentId,
          type: schema.channels.type,
        })
        .from(schema.channels)
        .where(and(eq(schema.channels.guildId, guildId), isNull(schema.channels.deletedAt))),
      db
        .select({
          id: schema.roles.id,
          position: schema.roles.position,
          permissions: schema.roles.permissions,
        })
        .from(schema.roles)
        .where(eq(schema.roles.guildId, guildId)),
      db
        .select({
          userId: schema.memberRoles.userId,
          roleId: schema.memberRoles.roleId,
        })
        .from(schema.memberRoles)
        .where(
          and(
            eq(schema.memberRoles.guildId, guildId),
            inArray(schema.memberRoles.userId, userIds),
          ),
        ),
      db
        .select({ userId: schema.guildMembers.userId })
        .from(schema.guildMembers)
        .where(
          and(
            eq(schema.guildMembers.guildId, guildId),
            inArray(schema.guildMembers.userId, userIds),
          ),
        ),
    ]);

  // Phase 2: overrides scoped to the actual channel ids we just loaded.
  const channelIds = channels.map((c) => c.id);
  const realOverrides =
    channelIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.permissionOverrides)
          .where(inArray(schema.permissionOverrides.channelId, channelIds));

  const guild = guildRow[0];
  if (!guild) return result; // No guild → no one sees anything.

  const everyoneRoleRow = allRoles.find((r) => r.id === guildId) ?? {
    id: guildId,
    position: 0,
    permissions: 0n,
  };
  const everyoneRole = {
    position: everyoneRoleRow.position,
    permissions: everyoneRoleRow.permissions,
  };
  const rolesById = new Map(allRoles.map((r) => [r.id, r]));
  const validMembers = new Set(memberRows.map((m) => m.userId));

  // Pre-group member-roles by userId so the inner loop doesn't filter.
  const rolesByUser = new Map<bigint, bigint[]>();
  for (const mr of memberRolesRows) {
    const list = rolesByUser.get(mr.userId);
    if (list) list.push(mr.roleId);
    else rolesByUser.set(mr.userId, [mr.roleId]);
  }

  // Pre-group overrides by channelId so we don't re-scan the override
  // array for each (user, channel) pair. Each bucket holds the @everyone
  // row (target_id === guildId), all role rows, and all member rows;
  // the per-user loop picks the rows whose targetId matches a role the
  // user has or the user themself.
  type OverrideRow = (typeof realOverrides)[number];
  const ovByChannel = new Map<bigint, OverrideRow[]>();
  for (const ov of realOverrides) {
    const list = ovByChannel.get(ov.channelId);
    if (list) list.push(ov);
    else ovByChannel.set(ov.channelId, [ov]);
  }

  // Compute per user.
  for (const userId of userIds) {
    if (!validMembers.has(userId)) {
      result.set(userId, new Set());
      continue;
    }
    const memberRoleIds = rolesByUser.get(userId) ?? [];
    const memberRoles = memberRoleIds
      .map((rid) => rolesById.get(rid))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({ position: r.position, permissions: r.permissions }));

    // Owner / administrator short-circuit — sees everything in the guild.
    const guildPerms = computeBasePermissions({
      isOwner: guild.ownerId === userId,
      everyoneRole,
      memberRoles,
    });
    if (guild.ownerId === userId || hasPermission(guildPerms, Permissions.ADMINISTRATOR)) {
      result.set(userId, new Set(channelIds));
      continue;
    }

    // Channel-by-channel evaluation. Same algorithm as the single-user
    // listViewableGuildChannelIds, just driven from the in-memory
    // overrides table.
    const viewable = new Set<bigint>();
    const memberRoleIdSet = new Set(memberRoleIds);

    // Per-channel: partition overrides into the resolver's buckets.
    // For category cascade, look up the parent's bucket too.
    function buildBuckets(channelId: bigint) {
      let everyoneOverride: ResolvableOverride | null = null;
      let memberOverride: ResolvableOverride | null = null;
      const roleOverrides: ResolvableOverride[] = [];
      const ovs = ovByChannel.get(channelId);
      if (ovs) {
        for (const ov of ovs) {
          if (ov.targetType === 'role') {
            if (ov.targetId === guildId) {
              everyoneOverride = { allow: ov.allow, deny: ov.deny };
            } else if (memberRoleIdSet.has(ov.targetId)) {
              roleOverrides.push({ allow: ov.allow, deny: ov.deny });
            }
          } else if (ov.targetType === 'member' && ov.targetId === userId) {
            memberOverride = { allow: ov.allow, deny: ov.deny };
          }
        }
      }
      return { everyoneOverride, memberOverride, roleOverrides };
    }

    for (const c of channels) {
      const own = buildBuckets(c.id);
      const parent = c.parentId ? buildBuckets(c.parentId) : null;
      const perms = computeChannelPermissions({
        isOwner: false,
        everyoneRole,
        memberRoles,
        everyoneOverride: own.everyoneOverride,
        roleOverrides: own.roleOverrides,
        memberOverride: own.memberOverride,
        categoryEveryoneOverride: parent?.everyoneOverride ?? null,
        categoryRoleOverrides: parent?.roleOverrides ?? [],
        categoryMemberOverride: parent?.memberOverride ?? null,
      });
      if (hasPermission(perms, Permissions.VIEW_CHANNEL)) viewable.add(c.id);
    }
    // MANAGE_CHANNELS holders keep empty categories visible so they
    // can place new channels into them from the sidebar; everyone
    // else gets the prune (an empty category looks broken otherwise).
    // The guildPerms bitfield computed above for the admin short-
    // circuit is reused — no extra cost.
    const reconciled = reconcileCategoryVisibility(Array.from(viewable), channels, {
      preserveEmptyCategories: hasPermission(guildPerms, Permissions.MANAGE_CHANNELS),
    });
    result.set(userId, new Set(reconciled));
  }

  return result;
}

// ── Assertion helpers (throw on failure) ───────────────────────────────────

/** Throw NOT_FOUND if not a member of the guild. Returns the member-load on success. */
export async function ensureMember(guildId: bigint, userId: bigint): Promise<void> {
  const r = await db
    .select({ userId: schema.guildMembers.userId })
    .from(schema.guildMembers)
    .where(
      and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, userId)),
    )
    .limit(1);
  if (!r[0]) throw errors.notFound('Guild');
}

export async function assertGuildPermission(
  guildId: bigint,
  userId: bigint,
  ...required: bigint[]
): Promise<void> {
  const perms = await computeMemberGuildPermissions(guildId, userId);
  for (const p of required) {
    if (!hasPermission(perms, p)) {
      throw errors.missingPermissions(permissionNames(required.reduce((a, b) => a | b, 0n)));
    }
  }
}

/** Pass if the member has ANY of the listed guild permissions (vs.
 *  assertGuildPermission which requires ALL). Used for "is a moderator"
 *  gates where several permissions each qualify. */
export async function assertAnyGuildPermission(
  guildId: bigint,
  userId: bigint,
  ...anyOf: bigint[]
): Promise<void> {
  const perms = await computeMemberGuildPermissions(guildId, userId);
  if (anyOf.some((p) => hasPermission(perms, p))) return;
  throw errors.missingPermissions(permissionNames(anyOf.reduce((a, b) => a | b, 0n)));
}

export async function assertChannelPermission(
  channelId: bigint,
  userId: bigint,
  ...required: bigint[]
): Promise<void> {
  const perms = await computeMemberChannelPermissions(channelId, userId);
  for (const p of required) {
    if (!hasPermission(perms, p)) {
      throw errors.missingPermissions(permissionNames(required.reduce((a, b) => a | b, 0n)));
    }
  }
}

// ── Hierarchy guards ───────────────────────────────────────────────────────

/**
 * Assert the actor can manage a role: they need MANAGE_ROLES *and* a role
 * positioned strictly above the target. Owners bypass.
 *
 * The "manage" verb covers: edit the target role, delete it, or move it.
 */
export async function assertCanManageRole(
  guildId: bigint,
  actorId: bigint,
  targetRoleId: bigint,
): Promise<void> {
  const m = await loadMember(guildId, actorId);
  if (!m) throw errors.notFound('Guild');
  if (m.isOwner) return;

  const perms = computeBasePermissions({
    isOwner: m.isOwner,
    everyoneRole: m.everyoneRole,
    memberRoles: m.memberRoles,
  });
  if (perms === ALL_PERMISSIONS) return;
  if (!hasPermission(perms, Permissions.MANAGE_ROLES)) {
    throw errors.missingPermissions(['MANAGE_ROLES']);
  }

  // The actor's "highest" role determines the hierarchy ceiling.
  const actorTop = m.memberRoles.reduce((max, r) => (r.position > max ? r.position : max), 0);

  const targetRow = await db
    .select({ position: schema.roles.position, guildId: schema.roles.guildId })
    .from(schema.roles)
    .where(eq(schema.roles.id, targetRoleId))
    .limit(1);
  const target = targetRow[0];
  if (!target || target.guildId !== guildId) throw errors.notFound('Role');
  if (target.position >= actorTop) {
    throw errors.forbidden('You cannot manage a role at or above your highest role');
  }
}

/**
 * Assert the actor can act on another member (kick/ban/role-assign):
 * needs the relevant permission AND a higher-positioned highest-role than
 * the target. Owner bypasses; cannot act on owner.
 */
export async function assertCanManageMember(
  guildId: bigint,
  actorId: bigint,
  targetId: bigint,
): Promise<void> {
  if (actorId === targetId) return; // self-actions are allowed (e.g. leave)

  const guildRow = await db
    .select({ ownerId: schema.guilds.ownerId })
    .from(schema.guilds)
    .where(eq(schema.guilds.id, guildId))
    .limit(1);
  const guild = guildRow[0];
  if (!guild) throw errors.notFound('Guild');
  if (guild.ownerId === targetId) {
    throw errors.forbidden('Cannot act on the guild owner');
  }
  if (guild.ownerId === actorId) return; // owner can do anything below

  const actor = await loadMember(guildId, actorId);
  const target = await loadMember(guildId, targetId);
  if (!actor) throw errors.notFound('Guild');
  if (!target) throw errors.notFound('Member');

  const actorTop = actor.memberRoles.reduce((m, r) => (r.position > m ? r.position : m), 0);
  const targetTop = target.memberRoles.reduce((m, r) => (r.position > m ? r.position : m), 0);
  if (targetTop >= actorTop) {
    throw errors.forbidden('Target has an equal or higher role than you');
  }
}

// ── Re-exports for convenience ─────────────────────────────────────────────

export {
  Permissions,
  hasPermission,
  permissionNames,
  ALL_PERMISSIONS,
} from '@zekktris/shared/permissions';

// Silence unused-import warning when consumers only use re-exports above.
void gte;
