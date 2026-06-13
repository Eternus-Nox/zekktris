/**
 * Roles service
 * -------------
 * CRUD plus position reorder. The @everyone role (id === guildId) is a
 * special case:
 *   - cannot be deleted
 *   - cannot be renamed (its name is fixed)
 *   - cannot be moved off position 0
 *   - permissions ARE editable — that's how you set the default behavior
 *
 * Position is *not* unique; ties are broken by id at read time. Reordering
 * is therefore a simple "set this role to position N" call, not a full
 * permutation. The web client computes positions for batches.
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { writeAudit } from './audit';
import { Permissions } from '@zekktris/shared/permissions';

/**
 * Permission bits a self-assignable role MAY carry. selfAssignRole grants a
 * flagged role to any member with NO permission or hierarchy check, so this
 * is an ALLOWLIST of harmless participation-level bits (channel access,
 * messaging, voice participation) rather than a denylist of known-dangerous
 * ones — a denylist silently opens a hole every time a new permission bit is
 * added to the enum (which is exactly how MANAGE_THREADS, MOVE_MEMBERS,
 * MENTION_EVERYONE, VIEW_AUDIT_LOG et al. became self-grantable). Anything
 * not listed here — every MANAGE_*, kick/ban/timeout, mute/deafen/move,
 * audit-log access, @everyone mentions, priority speaker — is refused.
 */
const SELF_ASSIGNABLE_ALLOWED_PERMS =
  Permissions.VIEW_CHANNEL |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.SEND_MESSAGES |
  Permissions.ATTACH_FILES |
  Permissions.EMBED_LINKS |
  Permissions.ADD_REACTIONS |
  Permissions.USE_EXTERNAL_EMOJIS |
  Permissions.CREATE_INVITE |
  Permissions.CHANGE_NICKNAME |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.USE_VAD |
  Permissions.STREAM |
  Permissions.USE_EMBEDDED_ACTIVITIES;

/** True when `perms` carries any bit a self-assignable role must not have. */
function carriesPrivilegedBits(perms: bigint): boolean {
  return (perms & ~SELF_ASSIGNABLE_ALLOWED_PERMS) !== 0n;
}

export interface CreateRoleInput {
  guildId: bigint;
  actorId: bigint;
  name: string;
  /** Bitfield. Defaults to no permissions. */
  permissions?: bigint;
  /** RGB packed integer. 0 = no color. */
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
}

export async function createRole(input: CreateRoleInput) {
  // Place new roles just ABOVE @everyone (position 1), matching Discord.
  // The previous `max(position)+1` put new roles at the TOP of the
  // hierarchy — above owner/admin-designated roles, and out of the
  // creator's own manage reach (a role at or above your highest is
  // unmanageable), so a non-owner with MANAGE_ROLES couldn't edit the role
  // they'd just made. Positions are non-unique (ties broken by id), so
  // a fixed 1 needs no renumbering of existing roles.
  const nextPosition = 1;

  const id = nextSnowflake();
  const [role] = await db
    .insert(schema.roles)
    .values({
      id,
      guildId: input.guildId,
      name: input.name,
      permissions: input.permissions ?? 0n,
      color: input.color ?? 0,
      position: nextPosition,
      hoist: input.hoist ?? false,
      mentionable: input.mentionable ?? false,
    })
    .returning();
  if (!role) throw errors.internal('Role insert returned no row');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: 'role.create',
    targetType: 'role',
    targetId: id,
    changes: { name: input.name, permissions: input.permissions?.toString() ?? '0' },
  });

  return role;
}

export async function listRoles(guildId: bigint) {
  return db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.guildId, guildId))
    .orderBy(asc(schema.roles.position), asc(schema.roles.id));
}

export async function getRole(guildId: bigint, roleId: bigint) {
  const r = await db
    .select()
    .from(schema.roles)
    .where(and(eq(schema.roles.id, roleId), eq(schema.roles.guildId, guildId)))
    .limit(1);
  return r[0] ?? null;
}

export interface UpdateRoleInput {
  guildId: bigint;
  actorId: bigint;
  roleId: bigint;
  name?: string;
  permissions?: bigint;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  position?: number;
  /** When true, any guild member can grant/revoke this role for
   *  themselves via the self-assign endpoint. @everyone and
   *  managed roles can't be made self-assignable — those have
   *  system-defined membership semantics. */
  selfAssignable?: boolean;
  /** Admin-set blurb for the Browse Roles UI. Capped at 200 chars
   *  at the API layer. Pass null to clear. */
  description?: string | null;
}

export async function updateRole(input: UpdateRoleInput) {
  const role = await getRole(input.guildId, input.roleId);
  if (!role) throw errors.notFound('Role');

  const isEveryone = role.id === input.guildId;

  // @everyone is name-locked and position-locked. Permissions are still editable.
  if (isEveryone) {
    if (input.name !== undefined) {
      throw errors.badRequest('Cannot rename the @everyone role');
    }
    if (input.position !== undefined) {
      throw errors.badRequest('Cannot move the @everyone role');
    }
    if (input.hoist || input.mentionable) {
      // These have no meaning for @everyone (it implicitly contains everyone).
      throw errors.badRequest('Cannot set hoist or mentionable on @everyone');
    }
    if (input.selfAssignable === true) {
      // Already auto-granted to everyone — toggle would be nonsensical.
      throw errors.badRequest('Cannot make @everyone self-assignable');
    }
  }
  // Managed roles have system-defined membership rules; let the
  // system manage their members rather than mixing manual member-
  // grant with system behavior.
  if (role.managed && input.selfAssignable !== undefined) {
    throw errors.badRequest('Cannot toggle self-assignable on a managed role');
  }
  // A self-assignable role can be self-granted by any member with no
  // permission/hierarchy check, so it must not carry privileged bits.
  // Check the EFFECTIVE flag and EFFECTIVE permissions (the new values if
  // this call sets them, else the current ones) so you can't flip
  // selfAssignable and raise permissions in one request — and equally
  // can't raise permissions on a role that is ALREADY self-assignable.
  const willBeSelfAssignable = input.selfAssignable ?? role.selfAssignable;
  if (willBeSelfAssignable) {
    const effectivePerms = input.permissions ?? role.permissions;
    if (carriesPrivilegedBits(effectivePerms)) {
      throw errors.badRequest(
        'Self-assignable roles may only carry participation permissions (no management or moderation powers)',
      );
    }
  }

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.permissions !== undefined) update.permissions = input.permissions;
  if (input.color !== undefined) update.color = input.color;
  if (input.hoist !== undefined) update.hoist = input.hoist;
  if (input.mentionable !== undefined) update.mentionable = input.mentionable;
  if (input.position !== undefined) update.position = input.position;
  if (input.selfAssignable !== undefined) update.selfAssignable = input.selfAssignable;
  if (input.description !== undefined) {
    // Normalize empty/whitespace to null so the column doesn't
    // accumulate "" rows that render as ugly empty hint text.
    const trimmed = input.description?.trim();
    update.description = trimmed && trimmed.length > 0 ? trimmed : null;
  }

  if (Object.keys(update).length === 0) return role;

  const [updated] = await db
    .update(schema.roles)
    .set(update)
    .where(eq(schema.roles.id, input.roleId))
    .returning();
  if (!updated) throw errors.notFound('Role');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: 'role.update',
    targetType: 'role',
    targetId: input.roleId,
    changes: Object.fromEntries(
      Object.entries(update).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
    ),
  });

  return updated;
}

export async function deleteRole(guildId: bigint, roleId: bigint, actorId: bigint): Promise<void> {
  if (roleId === guildId) {
    throw errors.badRequest('Cannot delete the @everyone role');
  }

  await db.transaction(async (tx) => {
    const role = await tx
      .select()
      .from(schema.roles)
      .where(and(eq(schema.roles.id, roleId), eq(schema.roles.guildId, guildId)))
      .limit(1);
    if (!role[0]) throw errors.notFound('Role');
    if (role[0].managed) {
      throw errors.badRequest('Managed roles cannot be deleted');
    }

    // Permission overrides for this role need explicit cleanup — targetId is
    // polymorphic in the schema and isn't covered by an FK.
    await tx
      .delete(schema.permissionOverrides)
      .where(
        and(
          eq(schema.permissionOverrides.targetType, 'role'),
          eq(schema.permissionOverrides.targetId, roleId),
        ),
      );

    // Reaction-role mappings pointing at this role have no FK back
    // to roles.id (added in v1.x — for now the column is bare
    // bigint), so the role-delete cascade doesn't catch them.
    // Without explicit cleanup, the mappings persist as orphans:
    // the reaction-add hook tries `addMemberRole` with the stale
    // role-id, addMemberRole throws "Role not found," the hook's
    // try/catch swallows it, and the reaction succeeds as a silent
    // no-op for the user. Not broken, but stale state that
    // surfaces in the "manage reaction-roles" admin UI as dead
    // mappings. Same pattern as the override cleanup above.
    await tx
      .delete(schema.reactionRoles)
      .where(eq(schema.reactionRoles.roleId, roleId));

    await tx.delete(schema.roles).where(eq(schema.roles.id, roleId));

    await writeAudit({
      tx,
      guildId,
      actorId,
      action: 'role.delete',
      targetType: 'role',
      targetId: roleId,
    });
  });
}

/**
 * Bulk reorder. The client sends a list of {id, position} pairs; we apply
 * them in one transaction. @everyone is silently filtered out — clients can
 * include it without breaking anything.
 */
export async function reorderRoles(
  guildId: bigint,
  actorId: bigint,
  positions: Array<{ id: bigint; position: number }>,
): Promise<void> {
  // Strip out @everyone (locked at position 0) up front so we don't
  // build a CASE branch we'll never apply.
  const effective = positions.filter((p) => p.id !== guildId);
  if (effective.length === 0) {
    // Only-@everyone reorder is a no-op; still write the audit row so
    // the trail records the attempt.
    await writeAudit({
      guildId,
      actorId,
      action: 'role.reorder',
      targetType: 'role',
      changes: { count: 0 },
    });
    return;
  }

  await db.transaction(async (tx) => {
    // Single UPDATE with a CASE expression batches all position
    // changes into one round-trip. Previous implementation issued
    // one UPDATE per moved role serially within the transaction — a
    // 20-role drag paid 20 sequential round-trips on the same
    // connection. The ne(@everyone) guard in the previous WHERE is
    // redundant once we filter `positions` above, but we keep the
    // guildId filter here so a stale client with a wrong role id
    // can't accidentally update a role from another guild.
    const ids = effective.map((p) => p.id);
    const cases = effective
      .map((p) => sql`WHEN ${schema.roles.id} = ${p.id} THEN ${p.position}`)
      .reduce(
        (acc, cur, i) => (i === 0 ? cur : sql`${acc} ${cur}`),
        sql.empty(),
      );
    await tx
      .update(schema.roles)
      .set({
        position: sql`CASE ${cases} ELSE ${schema.roles.position} END`,
      })
      .where(
        and(
          eq(schema.roles.guildId, guildId),
          inArray(schema.roles.id, ids),
        ),
      );

    await writeAudit({
      tx,
      guildId,
      actorId,
      action: 'role.reorder',
      targetType: 'role',
      changes: { count: effective.length },
    });
  });
}

// ── Self-assignable roles ─────────────────────────────────────────────────

/**
 * List the roles in a guild that members can grant/revoke for
 * themselves. Backs the Browse Roles UI. Ordered by position
 * descending — same order as the regular role list so display
 * stays consistent.
 *
 * Uses the partial `WHERE self_assignable = true` index for an
 * index-only scan path that doesn't touch the bulk of the roles
 * table (most roles are admin-controlled).
 */
export async function listSelfAssignableRoles(guildId: bigint) {
  return db
    .select()
    .from(schema.roles)
    .where(
      and(
        eq(schema.roles.guildId, guildId),
        eq(schema.roles.selfAssignable, true),
      ),
    )
    .orderBy(desc(schema.roles.position));
}

/**
 * Member grants themselves a self-assignable role. We re-check the
 * self_assignable flag at write time — an admin un-toggling
 * mid-flight is the race we want to lose-closed (don't let stale
 * client state grant a role that's been admin-locked since the
 * page was opened).
 *
 * Idempotent: granting an already-held role is a no-op success.
 * The underlying addMemberRole handles the INSERT-IF-NOT-EXISTS
 * + audit write + gateway broadcast.
 */
export async function selfAssignRole(args: {
  guildId: bigint;
  userId: bigint;
  roleId: bigint;
}): Promise<void> {
  const role = await getRole(args.guildId, args.roleId);
  if (!role) throw errors.notFound('Role');
  if (!role.selfAssignable) {
    throw errors.forbidden('This role is not self-assignable');
  }
  // Defense in depth: refuse to self-grant a role that carries privileged
  // bits even if it was somehow flagged self-assignable (e.g. permissions
  // raised after the flag, or a row from before the updateRole guard).
  if (carriesPrivilegedBits(role.permissions)) {
    throw errors.forbidden('This role can no longer be self-assigned');
  }
  const { addMemberRole } = await import('./members');
  await addMemberRole({
    guildId: args.guildId,
    userId: args.userId,
    roleId: args.roleId,
    // Actor is the member themselves — the audit row reads as
    // "user X added role Y to themselves," disambiguated from
    // moderator-assigned roles by the actor === target match plus
    // the action code.
    actorId: args.userId,
    selfAssign: true,
  });
}

/**
 * Member revokes a self-assignable role from themselves. Restricted
 * to roles that ARE currently self-assignable; we deliberately don't
 * let members revoke arbitrary roles from themselves, since a
 * punishment role applied by a moderator shouldn't be self-removable.
 *
 * Idempotent: revoking a role the member doesn't have is a no-op.
 */
export async function selfRevokeRole(args: {
  guildId: bigint;
  userId: bigint;
  roleId: bigint;
}): Promise<void> {
  const role = await getRole(args.guildId, args.roleId);
  if (!role) throw errors.notFound('Role');
  if (!role.selfAssignable) {
    throw errors.forbidden('This role is not self-assignable');
  }
  const { removeMemberRole } = await import('./members');
  await removeMemberRole({
    guildId: args.guildId,
    userId: args.userId,
    roleId: args.roleId,
    actorId: args.userId,
    selfAssign: true,
  });
}
