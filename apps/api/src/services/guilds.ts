/**
 * Guilds service
 * --------------
 * Operations on the `guilds` table plus the bootstrap rows that go with it.
 *
 * Creating a guild is a 5-step transaction:
 *   1. insert guilds row
 *   2. insert @everyone role (id === guild.id)
 *   3. insert guildMembers row for the owner
 *   4. insert a default category and a default text channel
 *   5. insert audit log entry
 *
 * If any step fails the whole thing rolls back — leaving an orphaned guild
 * with no @everyone role would be unrecoverable for the resolver.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { errors } from '../errors';
import { writeAudit } from './audit';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@zekktris/shared/permissions';
import { EVERYONE_ROLE_NAME } from '@zekktris/shared/constants';

export interface CreateGuildInput {
  ownerId: bigint;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  /**
   * Federation: use a pre-assigned id instead of generating one. A guild node
   * passes the backbone-assigned id here so the node's copy and the backbone
   * directory entry share the same id. Omit on the backbone/standalone.
   */
  id?: bigint;
}

export interface CreateGuildResult {
  guildId: bigint;
  everyoneRoleId: bigint;
  defaultChannelId: bigint;
}

export async function createGuild(input: CreateGuildInput): Promise<CreateGuildResult> {
  const guildId = input.id ?? nextSnowflake();
  // @everyone role's id intentionally equals the guild id.
  const everyoneRoleId = guildId;
  const categoryId = nextSnowflake();
  const defaultChannelId = nextSnowflake();

  await db.transaction(async (tx) => {
    await tx.insert(schema.guilds).values({
      id: guildId,
      name: input.name,
      description: input.description ?? null,
      iconUrl: input.iconUrl ?? null,
      ownerId: input.ownerId,
      systemChannelId: defaultChannelId,
    });

    await tx.insert(schema.roles).values({
      id: everyoneRoleId,
      guildId,
      name: EVERYONE_ROLE_NAME,
      permissions: DEFAULT_EVERYONE_PERMISSIONS,
      position: 0,
      managed: true,
    });

    await tx.insert(schema.guildMembers).values({
      guildId,
      userId: input.ownerId,
    });

    await tx.insert(schema.channels).values([
      {
        id: categoryId,
        guildId,
        type: 'guild_category',
        name: 'general',
        position: 0,
      },
      {
        id: defaultChannelId,
        guildId,
        type: 'guild_text',
        name: 'general',
        parentId: categoryId,
        position: 0,
      },
    ]);

    await writeAudit({
      tx,
      guildId,
      actorId: input.ownerId,
      action: 'guild.create',
      targetType: 'guild',
      targetId: guildId,
    });
  });

  return { guildId, everyoneRoleId, defaultChannelId };
}

export async function getGuild(guildId: bigint) {
  const rows = await db
    .select()
    .from(schema.guilds)
    .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listGuildsForUser(userId: bigint) {
  // INNER JOIN guilds <- guild_members on userId. Drizzle's relational query
  // builder works here too, but the explicit join makes the order-by clearer.
  const rows = await db
    .select({
      guild: schema.guilds,
    })
    .from(schema.guildMembers)
    .innerJoin(schema.guilds, eq(schema.guilds.id, schema.guildMembers.guildId))
    .where(
      and(eq(schema.guildMembers.userId, userId), isNull(schema.guilds.deletedAt)),
    )
    .orderBy(asc(schema.guildMembers.joinedAt));

  return rows.map((r) => r.guild);
}

export interface UpdateGuildInput {
  name?: string;
  description?: string | null;
  iconUrl?: string | null;
  bannerUrl?: string | null;
  systemChannelId?: bigint | null;
  /** AFK voice channel id. The route layer validates that the id
      references a real, non-deleted voice channel in this guild
      before passing it through. Null clears the config. */
  afkChannelId?: bigint | null;
  /** Idle threshold in seconds before the (v1.x) auto-move sweep
      relocates a user to the AFK channel. Stored but not yet
      enforced. */
  afkTimeoutSeconds?: number;
  /** Welcome message config. welcomeChannelId/text/template are
      independent — each can be patched without touching the others. */
  welcomeChannelId?: bigint | null;
  welcomeMessageEnabled?: boolean;
  welcomeMessageTemplate?: string | null;
  /** Onboarding rules markdown. Empty/whitespace-only string clears
   *  (stored as NULL). Setting this stamps rulesUpdatedAt to now,
   *  which the future re-prompt feature can compare against each
   *  member's acknowledgment timestamp. */
  rulesContent?: string | null;
  /** Raid protection — see schema. The generic patch loop persists these
   *  directly (column names match); the route validates ranges. */
  minAccountAgeMinutes?: number;
  requireVerifiedEmail?: boolean;
  raidModeEnabled?: boolean;
  joinRateLimitCount?: number | null;
  joinRateLimitSeconds?: number | null;
}

export async function updateGuild(
  guildId: bigint,
  patch: UpdateGuildInput,
  actorId: bigint,
): Promise<typeof schema.guilds.$inferSelect> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) update[k] = v;
  }
  // Normalize rules: empty/whitespace stored as NULL (removes the
  // onboarding gate). Setting it also stamps rulesUpdatedAt.
  // Track whether this patch is CLEARING rules (transitioning from
  // a non-null value to null) — used below to auto-activate any
  // pending members in the same transaction.
  let clearingRules = false;
  if (patch.rulesContent !== undefined) {
    const trimmed = patch.rulesContent?.trim();
    const newValue = trimmed && trimmed.length > 0 ? patch.rulesContent : null;
    update.rulesContent = newValue;
    update.rulesUpdatedAt = new Date();
    clearingRules = newValue === null;
  }

  // Whether THIS patch touches the icon/banner columns — used to gate
  // the prior-URL capture so patches that only touch name/description
  // don't pay for an extra SELECT FOR UPDATE round.
  const touchingIcon = patch.iconUrl !== undefined;
  const touchingBanner = patch.bannerUrl !== undefined;

  // Capture prior icon/banner ids inside a transaction so two concurrent
  // patches that both rotate the icon can't both miss the cleanup.
  // Mirrors the pattern in POST /:guildId/icon. The cleanup fires
  // AFTER commit, best-effort.
  const { deleteAttachmentFile, parseCdnAttachmentId } = await import(
    './uploads'
  );
  let priorIconId: bigint | null = null;
  let priorBannerId: bigint | null = null;
  // Members auto-activated as a side effect of clearing rules.
  // Captured in the transaction so we can include the count in the
  // audit entry and surface it to the caller for a toast.
  let autoActivatedCount = 0;
  // User ids of the auto-activated members. Used to fan out
  // guildMemberUpdate broadcasts after the transaction commits so
  // their connected clients see the membership-state flip live
  // without needing to reconnect. Captured here (outer scope)
  // because the dispatch must happen post-commit; doing it inside
  // the tx would let observers see "active" state before the row
  // is durable, racing the broadcast against a rollback.
  let autoActivatedUserIds: bigint[] = [];

  const updated = await db.transaction(async (tx) => {
    if (touchingIcon || touchingBanner) {
      const [prior] = await tx
        .select({
          iconUrl: schema.guilds.iconUrl,
          bannerUrl: schema.guilds.bannerUrl,
        })
        .from(schema.guilds)
        .where(eq(schema.guilds.id, guildId))
        .for('update')
        .limit(1);
      if (!prior) throw errors.notFound('Guild');
      if (touchingIcon) priorIconId = parseCdnAttachmentId(prior.iconUrl);
      if (touchingBanner) priorBannerId = parseCdnAttachmentId(prior.bannerUrl);
    }
    const [u] = await tx
      .update(schema.guilds)
      .set(update)
      .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
      .returning();
    if (!u) throw errors.notFound('Guild');

    // Auto-activate pending members when rules are cleared. Without
    // this, members who joined while rules were configured stay
    // stuck in 'pending' forever — there's nothing for them to
    // acknowledge, and the onboarding modal won't render (the
    // render guard requires both pending state AND non-empty
    // rulesContent, so the user just can't participate at all).
    // Single bulk UPDATE rather than per-member work; uses the
    // partial pending-state index for the WHERE clause.
    if (clearingRules) {
      const flipped = await tx
        .update(schema.guildMembers)
        .set({ membershipState: 'active' })
        .where(
          and(
            eq(schema.guildMembers.guildId, guildId),
            eq(schema.guildMembers.membershipState, 'pending'),
          ),
        )
        .returning({ userId: schema.guildMembers.userId });
      autoActivatedCount = flipped.length;
      autoActivatedUserIds = flipped.map((r) => r.userId);
      // Broadcast dispatch is intentionally deferred to AFTER tx
      // commit (see autoActivatedUserIds declaration above).
    }
    return u;
  });

  await writeAudit({
    guildId,
    actorId,
    action: 'guild.update',
    targetType: 'guild',
    targetId: guildId,
    changes: patch as Record<string, unknown>,
  });

  // Separate audit entry for the bulk auto-activation when rules
  // were cleared. Single entry with count (rather than per-member
  // rows) keeps the log readable on guilds with many pending
  // members.
  if (autoActivatedCount > 0) {
    await writeAudit({
      guildId,
      actorId,
      action: 'guild.rules_cleared_auto_activated',
      targetType: 'guild',
      targetId: guildId,
      changes: { count: autoActivatedCount },
    });
  }

  // Best-effort cleanup of orphaned files. Skip when the new URL parses
  // to the same id as prior (unchanged patch on that field) or when
  // prior was external.
  if (touchingIcon && priorIconId !== null) {
    const newIconId = parseCdnAttachmentId(updated.iconUrl);
    if (newIconId !== priorIconId) {
      void deleteAttachmentFile(priorIconId);
    }
  }
  if (touchingBanner && priorBannerId !== null) {
    const newBannerId = parseCdnAttachmentId(updated.bannerUrl);
    if (newBannerId !== priorBannerId) {
      void deleteAttachmentFile(priorBannerId);
    }
  }

  // Post-commit broadcast fan-out for auto-activated members. Each
  // affected member's connected clients receive a guildMemberUpdate
  // with their new membership state — they see the OnboardingModal
  // disappear and the send-message gate lift in real time without
  // reconnecting.
  //
  // Per-user dispatch rather than bulk: the existing
  // GUILD_MEMBER_UPDATE event shape is per-member; introducing a
  // bulk variant just for this rare edge case would add protocol
  // surface for negligible payoff. The auto-activated set is
  // typically 0-2 members (folks who joined before rules were set).
  //
  // Errors per-user are logged but don't propagate — one bad row
  // shouldn't poison the others or block the request response.
  if (autoActivatedUserIds.length > 0) {
    void (async () => {
      const { getMemberDetailed } = await import('./members');
      const { toGuildMember } = await import('../lib/dto');
      const dispatch = await import('../gateway/dispatch');
      for (const userId of autoActivatedUserIds) {
        try {
          const m = await getMemberDetailed(guildId, userId);
          if (!m) continue; // member row vanished between tx + dispatch
          dispatch.guildMemberUpdate(
            toGuildMember(m.member, m.user, m.roleIds),
            guildId,
          );
        } catch (err) {
          // Best-effort. Members will pick up state on reconnect.
          console.warn(
            `auto-activate broadcast failed for user ${userId}`,
            err,
          );
        }
      }
    })();
  }

  return updated;
}

/**
 * Soft-delete a guild and revoke all member rows. We don't DELETE the guild
 * row immediately — keeping it around with deletedAt set means audit log
 * entries (which FK to guildId) stay intact for forensic purposes.
 *
 * Channels, messages, roles, etc. cascade-delete via their FKs once the
 * guild row is hard-deleted by the periodic purge (deferred to v1.x).
 */
export async function deleteGuild(guildId: bigint, actorId: bigint): Promise<void> {
  const [updated] = await db
    .update(schema.guilds)
    .set({ deletedAt: new Date() })
    .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
    .returning({ id: schema.guilds.id });

  if (!updated) throw errors.notFound('Guild');

  // Soft-delete the guild's channels too. The attachment GC keys "in use" on
  // channels.deletedAt (not guilds.deletedAt) — so without this, a deleted
  // guild's channels stay deletedAt=null and the GC treats all their media as
  // referenced forever, never reclaiming it. (There is no guild-restore path;
  // a deleted guild is gone, so marking its channels deleted is correct.)
  await db
    .update(schema.channels)
    .set({ deletedAt: new Date() })
    .where(and(eq(schema.channels.guildId, guildId), isNull(schema.channels.deletedAt)));

  // Note: we deliberately keep the guild_members rows so audit log queries
  // that join through them still work. For this scope the guild is "gone"
  // because every list/lookup honors deletedAt.
  await writeAudit({
    guildId,
    actorId,
    action: 'guild.delete',
    targetType: 'guild',
    targetId: guildId,
  });
}

/**
 * Transfer ownership to another existing member of the guild. The new owner
 * must already be a member; this prevents a typo from handing your guild to
 * a stranger.
 */
export async function transferGuildOwnership(
  guildId: bigint,
  currentOwnerId: bigint,
  newOwnerId: bigint,
): Promise<void> {
  if (currentOwnerId === newOwnerId) {
    throw errors.badRequest('You already own this guild');
  }
  await db.transaction(async (tx) => {
    const guildRow = await tx
      .select({ ownerId: schema.guilds.ownerId })
      .from(schema.guilds)
      .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
      .limit(1);
    if (!guildRow[0]) throw errors.notFound('Guild');
    if (guildRow[0].ownerId !== currentOwnerId) {
      throw errors.forbidden('Only the current owner can transfer the guild');
    }

    const newMember = await tx
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(
        and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, newOwnerId)),
      )
      .limit(1);
    if (!newMember[0]) {
      throw errors.badRequest('New owner must already be a member of the guild');
    }

    await tx
      .update(schema.guilds)
      .set({ ownerId: newOwnerId, updatedAt: new Date() })
      .where(eq(schema.guilds.id, guildId));

    await writeAudit({
      tx,
      guildId,
      actorId: currentOwnerId,
      action: 'guild.transfer',
      targetType: 'member',
      targetId: newOwnerId,
    });
  });
}

/** Remove yourself from a guild. Owners can't leave — they have to delete or transfer first. */
export async function leaveGuild(guildId: bigint, userId: bigint): Promise<void> {
  const guildRow = await db
    .select({ ownerId: schema.guilds.ownerId })
    .from(schema.guilds)
    .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
    .limit(1);
  const guild = guildRow[0];
  if (!guild) throw errors.notFound('Guild');
  if (guild.ownerId === userId) {
    throw errors.badRequest('Owners cannot leave; transfer ownership or delete the guild first');
  }

  await db.transaction(async (tx) => {
    const result = await tx
      .delete(schema.guildMembers)
      .where(and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, userId)))
      .returning({ userId: schema.guildMembers.userId });

    if (result.length === 0) throw errors.notFound('Membership');

    // member_roles has no FK to guild_members; clear the leaver's role rows
    // explicitly so a later rejoin doesn't silently restore their old roles.
    await tx
      .delete(schema.memberRoles)
      .where(and(eq(schema.memberRoles.guildId, guildId), eq(schema.memberRoles.userId, userId)));

    await writeAudit({
      tx,
      guildId,
      actorId: userId,
      action: 'member.leave',
      targetType: 'member',
      targetId: userId,
    });
  });
}
