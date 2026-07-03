/**
 * Bans service
 * ------------
 * A ban is a row in `bans` plus the absence of a `guild_members` row. The
 * banned user can no longer be a member; future joins (via invite) are
 * blocked at the join step.
 *
 * Banning is a transaction:
 *   1. delete guild_members + member_roles (no FK cascade exists between them)
 *   2. insert bans row (with a unique-violation guard)
 *   3. write audit log
 */

import { and, asc, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { writeAudit } from './audit';

export async function listBans(
  guildId: bigint,
  opts: { limit?: number; after?: bigint } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const baseWhere = opts.after
    ? and(eq(schema.bans.guildId, guildId), gt(schema.bans.userId, opts.after))
    : eq(schema.bans.guildId, guildId);

  // We only return the banned user's profile inline. The moderator id is on
  // the ban row; clients can resolve them via /users/:id if they need
  // display info. Doing the moderator self-join here would require aliasing
  // the users table, which adds complexity for no current consumer.
  return db
    .select({ ban: schema.bans, user: schema.users })
    .from(schema.bans)
    .innerJoin(schema.users, eq(schema.users.id, schema.bans.userId))
    .where(baseWhere)
    .orderBy(asc(schema.bans.userId))
    .limit(limit);
}

export async function getBan(guildId: bigint, userId: bigint) {
  const r = await db
    .select()
    .from(schema.bans)
    .where(and(eq(schema.bans.guildId, guildId), eq(schema.bans.userId, userId)))
    .limit(1);
  return r[0] ?? null;
}

export interface BanInput {
  guildId: bigint;
  userId: bigint;
  actorId: bigint;
  reason?: string | null;
}

export async function banMember(input: BanInput): Promise<void> {
  // The role-hierarchy and "actor isn't banning the owner" checks live in
  // services/permissions.ts (assertCanManageMember), called by the route.
  await db.transaction(async (tx) => {
    // Drop the membership row. Tolerate "no row" — that just means the
    // user wasn't currently a member.
    await tx
      .delete(schema.guildMembers)
      .where(
        and(
          eq(schema.guildMembers.guildId, input.guildId),
          eq(schema.guildMembers.userId, input.userId),
        ),
      );

    // Neither member_roles nor member-target permission_overrides cascade off
    // guild_members, so the delete above leaves them behind — after an unban +
    // rejoin the user would silently regain their old roles (incl.
    // moderator/admin) AND any explicit channel overrides. Purge both here.
    const { purgeMemberGuildState } = await import('./members');
    await purgeMemberGuildState(tx, input.guildId, input.userId);

    // Insert the ban. ON CONFLICT DO UPDATE so re-banning refreshes the
    // moderator/reason rather than 409'ing.
    await tx
      .insert(schema.bans)
      .values({
        guildId: input.guildId,
        userId: input.userId,
        moderatorId: input.actorId,
        reason: input.reason ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.bans.guildId, schema.bans.userId],
        set: { moderatorId: input.actorId, reason: input.reason ?? null, createdAt: new Date() },
      });

    await writeAudit({
      tx,
      guildId: input.guildId,
      actorId: input.actorId,
      action: 'ban.add',
      targetType: 'member',
      targetId: input.userId,
      reason: input.reason ?? null,
    });
  });
}

export async function unbanMember(input: {
  guildId: bigint;
  userId: bigint;
  actorId: bigint;
}): Promise<void> {
  const result = await db
    .delete(schema.bans)
    .where(and(eq(schema.bans.guildId, input.guildId), eq(schema.bans.userId, input.userId)))
    .returning({ userId: schema.bans.userId });

  if (result.length === 0) throw errors.notFound('Ban');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: 'ban.remove',
    targetType: 'member',
    targetId: input.userId,
  });
}

/** Helper for the join-via-invite flow: refuse to admit a banned user. */
export async function isBanned(guildId: bigint, userId: bigint): Promise<boolean> {
  const r = await db
    .select({ userId: schema.bans.userId })
    .from(schema.bans)
    .where(and(eq(schema.bans.guildId, guildId), eq(schema.bans.userId, userId)))
    .limit(1);
  return r.length > 0;
}

