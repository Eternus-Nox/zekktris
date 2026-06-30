/**
 * Invites service
 * ---------------
 * Invite codes are short, URL-safe, randomly generated. The `code` column is
 * the primary key, so collisions surface as 409 — we retry once on insert.
 *
 * Accepting an invite is a transaction:
 *   1. Atomically increment `uses` (only if uses < maxUses, not expired).
 *      Same race-free pattern as signup_codes.
 *   2. Verify the user isn't banned from the guild.
 *   3. Verify the user isn't already a member (idempotent: just return).
 *   4. Insert guildMembers row.
 *   5. Write audit log.
 */

import { customAlphabet } from 'nanoid';
import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema, isUniqueViolation } from '../db';
import { errors, AppError } from '../errors';
import { writeAudit } from './audit';
import { assertJoinAllowed } from './raidProtection';
import * as supervision from './supervision';
import { INVITE_CODE_LENGTH } from '@zekktris/shared/constants';

// Alphabet skips visually ambiguous chars (0/O, 1/l/I) to make codes readable.
const inviteAlphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generateCode = customAlphabet(inviteAlphabet, INVITE_CODE_LENGTH);

export interface CreateInviteInput {
  guildId: bigint;
  channelId: bigint;
  inviterId: bigint;
  /** null or omitted = unlimited uses. */
  maxUses?: number | null;
  /** Seconds. null/omitted = never expires. */
  ttlSeconds?: number | null;
}

export async function createInvite(input: CreateInviteInput) {
  // Verify the channel belongs to the guild AND is not soft-deleted.
  // Without the deletedAt filter we could mint invites pointing at
  // channels that no longer exist — the codes would resolve but
  // accepting the invite lands the user on a gone channel.
  const channel = await db
    .select({ id: schema.channels.id, guildId: schema.channels.guildId })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.id, input.channelId),
        isNull(schema.channels.deletedAt),
      ),
    )
    .limit(1);
  if (!channel[0] || channel[0].guildId !== input.guildId) {
    throw errors.notFound('Channel');
  }

  const expiresAt = input.ttlSeconds ? new Date(Date.now() + input.ttlSeconds * 1000) : null;

  // Retry once on collision (vanishingly unlikely with 8-char nanoid).
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generateCode();
    try {
      const [inv] = await db
        .insert(schema.invites)
        .values({
          code,
          guildId: input.guildId,
          channelId: input.channelId,
          inviterId: input.inviterId,
          maxUses: input.maxUses ?? null,
          expiresAt,
        })
        .returning();
      if (!inv) throw errors.internal('Invite insert returned no row');

      await writeAudit({
        guildId: input.guildId,
        actorId: input.inviterId,
        action: 'invite.create',
        targetType: 'invite',
        changes: { code, maxUses: input.maxUses ?? null },
      });
      return inv;
    } catch (err: unknown) {
      if (isUniqueViolation(err) && attempt === 0) continue;
      throw err;
    }
  }
  throw errors.internal('Could not generate a unique invite code');
}

export async function listGuildInvites(guildId: bigint) {
  return db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.guildId, guildId))
    .orderBy(asc(schema.invites.createdAt));
}

/**
 * Preview an invite without consuming it. Public — no auth required, since
 * a user has to be able to see "what is this thing I'm being invited to"
 * before deciding to accept.
 */
export async function previewInvite(code: string) {
  const row = await db
    .select({
      invite: schema.invites,
      guild: schema.guilds,
    })
    .from(schema.invites)
    .innerJoin(schema.guilds, eq(schema.guilds.id, schema.invites.guildId))
    .where(and(eq(schema.invites.code, code), isNull(schema.guilds.deletedAt)))
    .limit(1);
  if (!row[0]) throw errors.notFound('Invite');

  const inv = row[0].invite;
  // Check expiry & uses; expired/spent invites act like 404 to viewers.
  if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) {
    throw errors.notFound('Invite');
  }
  if (inv.maxUses != null && inv.uses >= inv.maxUses) {
    throw errors.notFound('Invite');
  }

  return { invite: inv, guild: row[0].guild };
}

export async function deleteInvite(code: string, actorId: bigint): Promise<void> {
  const result = await db
    .delete(schema.invites)
    .where(eq(schema.invites.code, code))
    .returning({ guildId: schema.invites.guildId });
  if (result.length === 0) throw errors.notFound('Invite');
  const guildId = result[0]!.guildId;

  await writeAudit({
    guildId,
    actorId,
    action: 'invite.delete',
    targetType: 'invite',
    changes: { code },
  });
}

/**
 * Hard-delete invites that are permanently DEAD — expired, or spent their max
 * uses — AND have been dead longer than `graceMs`. Nearly every invite carries
 * a TTL (24h default), so without this the table grows without bound. The grace
 * window keeps recently-dead codes visible in the invite manager (which lists
 * expired/spent invites so admins can see what lapsed) before they're swept.
 *
 * Idempotent + multi-replica safe: a single bulk DELETE on a fixed predicate,
 * so concurrent runs just delete the same rows once (the second deletes none).
 * Death timestamp: `expiresAt` for expired codes; `createdAt` as the age proxy
 * for spent ones (the schema has no spent-at column). Returns rows removed.
 */
export async function pruneDeadInvites(graceMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const deleted = await db
    .delete(schema.invites)
    .where(
      or(
        // Expired more than `graceMs` ago.
        and(
          isNotNull(schema.invites.expiresAt),
          lt(schema.invites.expiresAt, cutoff),
        ),
        // Spent (hit max uses) and created more than `graceMs` ago.
        and(
          isNotNull(schema.invites.maxUses),
          sql`${schema.invites.uses} >= ${schema.invites.maxUses}`,
          lt(schema.invites.createdAt, cutoff),
        ),
      ),
    )
    .returning({ code: schema.invites.code });
  return deleted.length;
}

/**
 * Redeem an invite to join the guild. Idempotent: if the user is already a
 * member of the target guild, this returns success without consuming a use.
 */
export async function acceptInvite(
  code: string,
  userId: bigint,
  opts?: { skipSupervisionCheck?: boolean },
) {
  return db.transaction(async (tx) => {
    // Step 0: read the invite (without consuming) to know the guild it
    // points at. We need this before checking membership. Join on
    // guilds so we can verify the target hasn't been soft-deleted —
    // previewInvite does the same; without this check a user could
    // redeem an invite to a dead guild and end up with a stranded
    // guild_members row pointing at a row that's marked deleted.
    // Same generic notFound surface as a missing invite to avoid
    // leaking the deletion state of admin-force-deleted guilds.
    const inviteRow = await tx
      .select({
        invite: schema.invites,
        // Read rules_content alongside so we can decide whether this
        // new member starts 'pending' or 'active' without a second
        // round-trip.
        rulesContent: schema.guilds.rulesContent,
        // Raid-protection columns — gates enforced below.
        minAccountAgeMinutes: schema.guilds.minAccountAgeMinutes,
        requireVerifiedEmail: schema.guilds.requireVerifiedEmail,
        raidModeEnabled: schema.guilds.raidModeEnabled,
        joinRateLimitCount: schema.guilds.joinRateLimitCount,
        joinRateLimitSeconds: schema.guilds.joinRateLimitSeconds,
      })
      .from(schema.invites)
      .innerJoin(schema.guilds, eq(schema.guilds.id, schema.invites.guildId))
      .where(and(eq(schema.invites.code, code), isNull(schema.guilds.deletedAt)))
      .limit(1);
    if (!inviteRow[0]) throw errors.notFound('Invite');
    const invite = inviteRow[0].invite;
    const guildRulesContent = inviteRow[0].rulesContent;

    // Parental controls: a supervised child may be barred from this
    // server. Skipped when the parent is approving an earlier request.
    if (!opts?.skipSupervisionCheck) {
      const blocked = await supervision.isGuildBlockedForChild(userId, invite.guildId);
      if (blocked) {
        throw new AppError('FORBIDDEN', 'This server is restricted by your parent', {
          supervisionRestricted: 'guild',
          guildId: invite.guildId.toString(),
          inviteCode: code,
        });
      }
    }

    // Step 1: idempotency BEFORE we touch the counter. If the user is
    // already a member we return success without consuming a use. Doing
    // this in the opposite order (consume-then-check) would let a user
    // who already joined burn the invite's remaining uses just by
    // clicking the link a second time — and on a maxUses=1 invite that
    // locks out the actual second invitee.
    const existing = await tx
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(
        and(
          eq(schema.guildMembers.guildId, invite.guildId),
          eq(schema.guildMembers.userId, userId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { guildId: invite.guildId, channelId: invite.channelId, alreadyMember: true };
    }

    // Step 2: ban check. We do this before consuming, too, so a banned
    // user clicking the link doesn't burn a slot.
    const banned = await tx
      .select({ userId: schema.bans.userId })
      .from(schema.bans)
      .where(
        and(eq(schema.bans.guildId, invite.guildId), eq(schema.bans.userId, userId)),
      )
      .limit(1);
    if (banned[0]) throw errors.forbidden('You are banned from this guild');

    // Raid protection: account-age / verified-email gates + raid-mode
    // lockdown + join-rate auto-trigger. Done before consuming a use so a
    // blocked join doesn't burn an invite slot. Skipped on the parent-
    // approval path (that join was already vetted by a parent).
    if (!opts?.skipSupervisionCheck) {
      const [joiningUser] = await tx
        .select({
          createdAt: schema.users.createdAt,
          emailVerified: schema.users.emailVerified,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (joiningUser) {
        await assertJoinAllowed(
          tx,
          {
            id: invite.guildId,
            minAccountAgeMinutes: inviteRow[0].minAccountAgeMinutes,
            requireVerifiedEmail: inviteRow[0].requireVerifiedEmail,
            raidModeEnabled: inviteRow[0].raidModeEnabled,
            joinRateLimitCount: inviteRow[0].joinRateLimitCount,
            joinRateLimitSeconds: inviteRow[0].joinRateLimitSeconds,
          },
          joiningUser,
        );
      }
    }

    // Step 3: atomic redemption. The WHERE clause prevents two concurrent
    // accepts from both succeeding past max_uses, and it re-checks the
    // expiry — we read above without locking, so the row could have lapsed
    // between the SELECT and now.
    const now = new Date();
    const consumed = await tx
      .update(schema.invites)
      .set({ uses: sql`${schema.invites.uses} + 1` })
      .where(
        and(
          eq(schema.invites.code, code),
          or(
            isNull(schema.invites.maxUses),
            sql`${schema.invites.uses} < ${schema.invites.maxUses}`,
          ),
          or(isNull(schema.invites.expiresAt), gt(schema.invites.expiresAt, now)),
        ),
      )
      .returning();
    if (consumed.length === 0) throw errors.notFound('Invite');

    // Re-check the ban immediately before insert: a ban can land between the
    // step-2 check and now (neither the consume above nor the member PK guards
    // against a concurrent ban). Under READ COMMITTED a committed ban is visible
    // here, and throwing rolls back the whole tx (including the consumed use) —
    // closing the join-while-being-banned window.
    const bannedNow = await tx
      .select({ userId: schema.bans.userId })
      .from(schema.bans)
      .where(and(eq(schema.bans.guildId, invite.guildId), eq(schema.bans.userId, userId)))
      .limit(1);
    if (bannedNow[0]) throw errors.forbidden('You are banned from this guild');

    // Step 4: insert member + audit.
    await tx.insert(schema.guildMembers).values({
      guildId: invite.guildId,
      userId,
      // If the guild has rules configured, the new member starts in
      // 'pending' state and can't send/react/join voice until they
      // POST onboarding/acknowledge. Otherwise they're immediately
      // 'active' (the default).
      membershipState: guildRulesContent ? 'pending' : 'active',
    });
    await writeAudit({
      tx,
      guildId: invite.guildId,
      actorId: userId,
      action: 'member.join',
      targetType: 'member',
      targetId: userId,
      changes: { via: 'invite', code },
    });

    return { guildId: invite.guildId, channelId: invite.channelId, alreadyMember: false };
  });
}

/**
 * Join a guild as the result of a parent APPROVING a child's earlier
 * guild-join request.
 *
 * Keyed on the STABLE guild id (resolved + stored on the child_requests row
 * at request time), NOT the invite code. The invite code is mutable — it can
 * be revoked, expire, or be regenerated between the child's request and the
 * parent's approval — so re-redeeming it at approval time would make a
 * perfectly valid approval fail (invite gone) or land via the wrong invite.
 * The parent's approval is itself the authorization, so we add the membership
 * directly and don't consume an invite use. Raid-protection / supervision
 * gates are skipped for the same reason acceptInvite skips them on the
 * approval path: this join was already vetted by a parent.
 *
 * Idempotent (already-member → no-op). Mirrors acceptInvite's member insert:
 * deleted-guild guard, ban check, rules→membershipState, member.join audit.
 */
export async function joinGuildByApproval(
  guildId: bigint,
  userId: bigint,
): Promise<{ guildId: bigint; alreadyMember: boolean }> {
  return db.transaction(async (tx) => {
    const [guild] = await tx
      .select({ rulesContent: schema.guilds.rulesContent })
      .from(schema.guilds)
      .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
      .limit(1);
    if (!guild) throw errors.notFound('Guild');

    const existing = await tx
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(
        and(
          eq(schema.guildMembers.guildId, guildId),
          eq(schema.guildMembers.userId, userId),
        ),
      )
      .limit(1);
    if (existing[0]) return { guildId, alreadyMember: true };

    const banned = await tx
      .select({ userId: schema.bans.userId })
      .from(schema.bans)
      .where(and(eq(schema.bans.guildId, guildId), eq(schema.bans.userId, userId)))
      .limit(1);
    if (banned[0]) throw errors.forbidden('You are banned from this guild');

    await tx.insert(schema.guildMembers).values({
      guildId,
      userId,
      // Same onboarding gate as invite-accept: pending when the guild has
      // rules configured, else active.
      membershipState: guild.rulesContent ? 'pending' : 'active',
    });
    await writeAudit({
      tx,
      guildId,
      actorId: userId,
      action: 'member.join',
      targetType: 'member',
      targetId: userId,
      changes: { via: 'parent_approval' },
    });
    return { guildId, alreadyMember: false };
  });
}
