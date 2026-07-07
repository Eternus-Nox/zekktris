/**
 * Members service
 * ---------------
 * Operations on guild membership rows. Role hierarchy and permission
 * checks live in services/permissions.ts; this file is purely DB ops.
 *
 * Listing pagination uses an `after` cursor on userId (snowflake monotonic
 * by creation time, but we order by joinedAt; ties broken by userId).
 */

import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { writeAudit } from './audit';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Purge a departing member's guild-scoped access grants in one transaction:
 * their role assignments AND their member-target channel permission overrides.
 * Neither table FK-cascades off guild_members, so without this a user who
 * rejoins silently regains their old roles AND any explicit channel overrides
 * (e.g. an allow=VIEW_CHANNEL on a private channel) — a privilege-restoration
 * bug. Shared by kick / leave / ban so the three paths can't drift.
 */
export async function purgeMemberGuildState(
  tx: Tx,
  guildId: bigint,
  userId: bigint,
): Promise<void> {
  await tx
    .delete(schema.memberRoles)
    .where(
      and(eq(schema.memberRoles.guildId, guildId), eq(schema.memberRoles.userId, userId)),
    );
  // permission_overrides has no guild_id column and no FK to guild_members;
  // scope the member-target deletes to this guild's channels via a subquery.
  await tx
    .delete(schema.permissionOverrides)
    .where(
      and(
        eq(schema.permissionOverrides.targetType, 'member'),
        eq(schema.permissionOverrides.targetId, userId),
        inArray(
          schema.permissionOverrides.channelId,
          tx
            .select({ id: schema.channels.id })
            .from(schema.channels)
            .where(eq(schema.channels.guildId, guildId)),
        ),
      ),
    );
}

export async function getMember(guildId: bigint, userId: bigint) {
  const row = await db
    .select()
    .from(schema.guildMembers)
    .where(and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, userId)))
    .limit(1);
  return row[0] ?? null;
}

/**
 * Page through members of a guild. Returns the member, the user (joined),
 * and the role IDs each one has.
 */
export async function listMembers(
  guildId: bigint,
  opts: { limit?: number; after?: bigint } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);

  const baseWhere = opts.after
    ? and(
        eq(schema.guildMembers.guildId, guildId),
        gt(schema.guildMembers.userId, opts.after),
        // Hide instance-banned users from the visible roster. The
        // admin ban path leaves guild_members rows in place (for
        // audit retention) but the banned user shouldn't appear in
        // every guild's sidebar with their pre-ban state. Same
        // rationale as the discovery member-count filter — match
        // those semantics here.
        isNull(schema.users.bannedAt),
        isNull(schema.users.deletedAt),
      )
    : and(
        eq(schema.guildMembers.guildId, guildId),
        isNull(schema.users.bannedAt),
        isNull(schema.users.deletedAt),
      );

  const rows = await db
    .select({
      member: schema.guildMembers,
      // Project only the columns toPublicUser reads — the full users row carries
      // ~20 unused wide/jsonb/secret columns (voicePrefs, guildFolders,
      // guildOrder, passwordHash, totpSecret, email, ...) fetched and discarded
      // ×up-to-1000 members per page.
      user: {
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        bannerUrl: schema.users.bannerUrl,
        bio: schema.users.bio,
        avatarDecoration: schema.users.avatarDecoration,
        status: schema.users.status,
        customStatus: schema.users.customStatus,
        customStatusEmoji: schema.users.customStatusEmoji,
        customStatusExpiresAt: schema.users.customStatusExpiresAt,
        publicKey: schema.users.publicKey,
        createdAt: schema.users.createdAt,
        isBot: schema.users.isBot,
        tagLabel: schema.users.tagLabel,
        tagColor: schema.users.tagColor,
        isAdmin: schema.users.isAdmin,
        isModerator: schema.users.isModerator,
        staffColor: schema.users.staffColor,
        staffGlow: schema.users.staffGlow,
      },
    })
    .from(schema.guildMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.guildMembers.userId))
    .where(baseWhere)
    .orderBy(asc(schema.guildMembers.userId))
    .limit(limit);

  if (rows.length === 0) return [];

  // Bulk-load role assignments for all returned members in one query, then
  // group in JS. inArray() handles bigint arrays correctly; raw sql template
  // ANY(...) doesn't auto-cast JS arrays to Postgres arrays.
  const userIds = rows.map((r) => r.member.userId);
  const memberRoleRows = await db
    .select()
    .from(schema.memberRoles)
    .where(
      and(
        eq(schema.memberRoles.guildId, guildId),
        inArray(schema.memberRoles.userId, userIds),
      ),
    );

  const rolesByUser = new Map<bigint, bigint[]>();
  for (const mr of memberRoleRows) {
    const list = rolesByUser.get(mr.userId);
    if (list) list.push(mr.roleId);
    else rolesByUser.set(mr.userId, [mr.roleId]);
  }

  return rows.map((r) => ({
    member: r.member,
    // The narrowed projection carries exactly the columns toGuildMember →
    // toPublicUser reads; cast back to the full row type the DTO mapper expects.
    user: r.user as typeof schema.users.$inferSelect,
    roleIds: rolesByUser.get(r.member.userId) ?? [],
  }));
}

/** Get one member with their full user row and role IDs. */
export async function getMemberDetailed(guildId: bigint, userId: bigint) {
  const row = await db
    .select({
      member: schema.guildMembers,
      user: schema.users,
    })
    .from(schema.guildMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.guildMembers.userId))
    .where(and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, userId)))
    .limit(1);
  if (!row[0]) return null;

  const roleRows = await db
    .select({ roleId: schema.memberRoles.roleId })
    .from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.guildId, guildId), eq(schema.memberRoles.userId, userId)));

  return {
    member: row[0].member,
    user: row[0].user,
    roleIds: roleRows.map((r) => r.roleId),
  };
}

/**
 * Just the role IDs for a member — cheaper than getMemberDetailed
 * when the caller only needs the role list (e.g. automod's
 * exempt-role check). One indexed query on (guildId, userId).
 */
export async function getMemberRoleIds(guildId: bigint, userId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ roleId: schema.memberRoles.roleId })
    .from(schema.memberRoles)
    .where(and(eq(schema.memberRoles.guildId, guildId), eq(schema.memberRoles.userId, userId)));
  return rows.map((r) => r.roleId);
}

/**
 * Set or clear a member's timeout. While `communicationDisabledUntil`
 * is set to a future timestamp, the message-send + reaction + voice-
 * connect routes reject the user with a TIMED_OUT error and tell the
 * client when they'll be free again — Discord's "timeout" semantics.
 *
 * `until: null` clears the timeout immediately. A past timestamp is
 * accepted (it ends up cleared by the enforcement comparison) but the
 * route layer normalizes to null for clarity in the audit log.
 *
 * Permission + hierarchy checks live in the route layer (caller needs
 * MODERATE_MEMBERS, and must outrank the target). This service trusts
 * those have already passed and just performs the write.
 */
export interface SetMemberTimeoutInput {
  guildId: bigint;
  userId: bigint;
  actorId: bigint;
  until: Date | null;
}

export async function setMemberTimeout(input: SetMemberTimeoutInput) {
  // Capture prior so the audit entry can show the actual delta — useful
  // when an admin shortens / extends an existing timeout vs sets one
  // from scratch.
  const [prior] = await db
    .select({ communicationDisabledUntil: schema.guildMembers.communicationDisabledUntil })
    .from(schema.guildMembers)
    .where(
      and(
        eq(schema.guildMembers.guildId, input.guildId),
        eq(schema.guildMembers.userId, input.userId),
      ),
    )
    .limit(1);
  if (!prior) throw errors.notFound('Member');

  const [updated] = await db
    .update(schema.guildMembers)
    .set({ communicationDisabledUntil: input.until })
    .where(
      and(
        eq(schema.guildMembers.guildId, input.guildId),
        eq(schema.guildMembers.userId, input.userId),
      ),
    )
    .returning();
  if (!updated) throw errors.notFound('Member');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: input.until === null ? 'member.timeout_clear' : 'member.timeout_set',
    targetType: 'member',
    targetId: input.userId,
    changes: {
      from: prior.communicationDisabledUntil
        ? prior.communicationDisabledUntil.toISOString()
        : null,
      to: input.until ? input.until.toISOString() : null,
    },
  });

  return updated;
}

/**
 * Returns the active timeout end-timestamp for a member, or null if
 * they're not currently timed out (column null, or set to a past
 * date). Centralizes the "is the timeout still active right now"
 * comparison so the message-send / reaction / voice-join enforcement
 * sites don't each implement the same check.
 *
 * Cheap PK lookup — guild_members has a composite PK on (guildId,
 * userId) so this is a single index probe.
 */
export async function getActiveTimeout(
  guildId: bigint,
  userId: bigint,
): Promise<Date | null> {
  const [row] = await db
    .select({ communicationDisabledUntil: schema.guildMembers.communicationDisabledUntil })
    .from(schema.guildMembers)
    .where(
      and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!row?.communicationDisabledUntil) return null;
  return row.communicationDisabledUntil.getTime() > Date.now()
    ? row.communicationDisabledUntil
    : null;
}

/**
 * Add a role to a member. Idempotent: granting an already-granted role is a
 * no-op (the row is just left alone). The role-hierarchy guard runs in the
 * route layer before this is called.
 */
export async function addMemberRole(input: {
  guildId: bigint;
  userId: bigint;
  roleId: bigint;
  actorId: bigint;
  /** When true, the audit action is recorded as `member.role_add_self`
   *  so log reviewers can distinguish self-grants from moderator
   *  grants without inferring it from actor==target. */
  selfAssign?: boolean;
}): Promise<void> {
  if (input.roleId === input.guildId) {
    // @everyone is implicit. Pretend success rather than 400, since clients
    // that always include all role IDs in a "set" call shouldn't break here.
    return;
  }

  await db.transaction(async (tx) => {
    // Validate target role belongs to this guild.
    const role = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.id, input.roleId), eq(schema.roles.guildId, input.guildId)))
      .limit(1);
    if (!role[0]) throw errors.notFound('Role');

    // Validate member exists — with a ROW LOCK so this serializes against a
    // concurrent kick/leave/ban DELETE on the same guild_members row. Without
    // FOR UPDATE, a kick committing between this check and the insert leaves an
    // orphaned member_roles row that silently restores the role on rejoin. With
    // it: if the kick commits first, this locked read returns no row → notFound
    // (no orphan); if we lock first, the kick's DELETE waits, then its
    // member_roles cleanup removes the row we just inserted.
    const m = await tx
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(
        and(
          eq(schema.guildMembers.guildId, input.guildId),
          eq(schema.guildMembers.userId, input.userId),
        ),
      )
      .limit(1)
      .for('update');
    if (!m[0]) throw errors.notFound('Member');

    // Insert with ON CONFLICT DO NOTHING so re-grants are no-ops.
    await tx
      .insert(schema.memberRoles)
      .values({ guildId: input.guildId, userId: input.userId, roleId: input.roleId })
      .onConflictDoNothing();

    await writeAudit({
      tx,
      guildId: input.guildId,
      actorId: input.actorId,
      action: input.selfAssign ? 'member.role_add_self' : 'member.role_add',
      targetType: 'member',
      targetId: input.userId,
      changes: { roleId: input.roleId.toString() },
    });
  });
}

export async function removeMemberRole(input: {
  guildId: bigint;
  userId: bigint;
  roleId: bigint;
  actorId: bigint;
  /** Mirror of addMemberRole. Records `member.role_remove_self`. */
  selfAssign?: boolean;
}): Promise<void> {
  if (input.roleId === input.guildId) {
    // Can't remove @everyone — every member implicitly has it.
    throw errors.badRequest('Cannot remove the @everyone role');
  }

  const result = await db
    .delete(schema.memberRoles)
    .where(
      and(
        eq(schema.memberRoles.guildId, input.guildId),
        eq(schema.memberRoles.userId, input.userId),
        eq(schema.memberRoles.roleId, input.roleId),
      ),
    )
    .returning({ roleId: schema.memberRoles.roleId });

  // Idempotent: removing a role they don't have is fine, but only emit an
  // audit entry if we actually removed something.
  if (result.length > 0) {
    await writeAudit({
      guildId: input.guildId,
      actorId: input.actorId,
      action: input.selfAssign ? 'member.role_remove_self' : 'member.role_remove',
      targetType: 'member',
      targetId: input.userId,
      changes: { roleId: input.roleId.toString() },
    });
  }
}

/** Remove a member from the guild, clearing their role assignments. */
export async function kickMember(input: {
  guildId: bigint;
  userId: bigint;
  actorId: bigint;
  reason?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const result = await tx
      .delete(schema.guildMembers)
      .where(
        and(
          eq(schema.guildMembers.guildId, input.guildId),
          eq(schema.guildMembers.userId, input.userId),
        ),
      )
      .returning({ userId: schema.guildMembers.userId });

    if (result.length === 0) throw errors.notFound('Member');

    // Clear role assignments AND member-target channel overrides in the same
    // transaction — neither cascades off guild_members, so without this a
    // rejoining user regains their old roles and explicit channel access.
    await purgeMemberGuildState(tx, input.guildId, input.userId);

    await writeAudit({
      tx,
      guildId: input.guildId,
      actorId: input.actorId,
      action: 'member.kick',
      targetType: 'member',
      targetId: input.userId,
      reason: input.reason ?? null,
    });
  });
}

// ── Onboarding ──────────────────────────────────────────────────────────────

/**
 * Mark a member as having acknowledged the guild's rules, flipping
 * them from 'pending' to 'active'. Idempotent: already-active members
 * are a no-op (returns false). Only the 'pending' → 'active'
 * transition writes an audit entry; re-acks don't spam the log.
 *
 * Two paths:
 *   1. First-time ack: member is 'pending', flip to 'active', stamp
 *      rules_acknowledged_at, write audit.
 *   2. Re-ack (admin updated rules): member is already 'active' but
 *      their previous ack went stale. Just stamp the new timestamp;
 *      no audit (re-acks aren't moderation-relevant).
 *
 * Returns true if we changed any state; false if there was nothing
 * to ack (e.g. member already current, or member not in the guild).
 */
export async function acknowledgeRules(
  guildId: bigint,
  userId: bigint,
): Promise<boolean> {
  const now = new Date();
  // Path 1: pending → active + stamp. Conditional on the literal
  // pending state so we only fire the audit + state transition for
  // first-time acks.
  const flippedToActive = await db
    .update(schema.guildMembers)
    .set({ membershipState: 'active', rulesAcknowledgedAt: now })
    .where(
      and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, userId),
        eq(schema.guildMembers.membershipState, 'pending'),
      ),
    )
    .returning({ userId: schema.guildMembers.userId });
  if (flippedToActive.length > 0) {
    await writeAudit({
      guildId,
      actorId: userId,
      action: 'member.onboarding_acknowledged',
      targetType: 'member',
      targetId: userId,
    });
    return true;
  }
  // Path 2: already active, but possibly stale. Stamp the timestamp
  // unconditionally — if they weren't stale this is a harmless
  // no-op (same value); if they were stale this clears the
  // re-prompt. We don't audit re-acks; the audit log shouldn't be
  // noisy with self-acknowledgments.
  const restamp = await db
    .update(schema.guildMembers)
    .set({ rulesAcknowledgedAt: now })
    .where(
      and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, userId),
        eq(schema.guildMembers.membershipState, 'active'),
      ),
    )
    .returning({ userId: schema.guildMembers.userId });
  return restamp.length > 0;
}

/**
 * Effective onboarding state for the gate checks. Returns the literal
 * state UNLESS the member's previous acknowledgment is stale relative
 * to the guild's current rulesUpdatedAt — in which case 'pending' is
 * returned even though the column says 'active'.
 *
 * Staleness logic:
 *   - If guild has no rules configured (rules_content is NULL or ''),
 *     never stale.
 *   - If member's rules_acknowledged_at IS NULL or
 *     < guild.rules_updated_at, stale → 'pending'.
 *   - Otherwise 'active'.
 *
 * Single JOIN keeps the lookup cheap — both rows are on indexed PKs.
 */
export async function getMemberState(
  guildId: bigint,
  userId: bigint,
): Promise<'pending' | 'active' | null> {
  const [row] = await db
    .select({
      membershipState: schema.guildMembers.membershipState,
      rulesAcknowledgedAt: schema.guildMembers.rulesAcknowledgedAt,
      rulesContent: schema.guilds.rulesContent,
      rulesUpdatedAt: schema.guilds.rulesUpdatedAt,
    })
    .from(schema.guildMembers)
    .innerJoin(schema.guilds, eq(schema.guilds.id, schema.guildMembers.guildId))
    .where(
      and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.membershipState === 'pending') return 'pending';
  // Derived stale-ack check: only applies when the guild actually has
  // rules. Without rules, "stale ack" is meaningless.
  const hasRules = row.rulesContent && row.rulesContent.trim().length > 0;
  if (!hasRules) return 'active';
  // The guild always has a rulesUpdatedAt when rulesContent is set
  // (updateGuild stamps both together), but be defensive.
  if (!row.rulesUpdatedAt) return 'active';
  const ack = row.rulesAcknowledgedAt;
  if (!ack || ack.getTime() < row.rulesUpdatedAt.getTime()) return 'pending';
  return 'active';
}

/**
 * One guild_members row read (+ guilds join) that resolves BOTH the
 * onboarding/pending gate AND the active-timeout gate — so the hot message-send
 * path pays a single round-trip instead of two point reads of the same row
 * (getMemberState + getActiveTimeout). Logic mirrors both exactly.
 */
export async function getParticipationRow(
  guildId: bigint,
  userId: bigint,
): Promise<{ state: 'pending' | 'active' | null; timeoutUntil: Date | null }> {
  const [row] = await db
    .select({
      membershipState: schema.guildMembers.membershipState,
      rulesAcknowledgedAt: schema.guildMembers.rulesAcknowledgedAt,
      communicationDisabledUntil: schema.guildMembers.communicationDisabledUntil,
      rulesContent: schema.guilds.rulesContent,
      rulesUpdatedAt: schema.guilds.rulesUpdatedAt,
    })
    .from(schema.guildMembers)
    .innerJoin(schema.guilds, eq(schema.guilds.id, schema.guildMembers.guildId))
    .where(
      and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return { state: null, timeoutUntil: null };
  // state — identical derivation to getMemberState.
  let state: 'pending' | 'active' = 'active';
  if (row.membershipState === 'pending') {
    state = 'pending';
  } else {
    const hasRules = row.rulesContent && row.rulesContent.trim().length > 0;
    if (hasRules && row.rulesUpdatedAt) {
      const ack = row.rulesAcknowledgedAt;
      if (!ack || ack.getTime() < row.rulesUpdatedAt.getTime()) state = 'pending';
    }
  }
  // timeout — identical derivation to getActiveTimeout.
  const until = row.communicationDisabledUntil;
  const timeoutUntil = until && until.getTime() > Date.now() ? until : null;
  return { state, timeoutUntil };
}
