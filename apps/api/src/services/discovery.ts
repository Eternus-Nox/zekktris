/**
 * Server discovery service
 * ------------------------
 * Public directory of guilds that have opted into discovery. Three
 * primary operations:
 *
 *   - listDiscoverable: paginated search/browse, sorted by member
 *     count desc. Optional case-insensitive substring match on guild
 *     name + description.
 *   - setDiscoverable: owner / MANAGE_GUILD action. Toggles the flag
 *     and updates the discovery-specific description.
 *   - joinPublic: one-click join for any discoverable guild. No
 *     invite code, no approval flow — the guild has explicitly opted
 *     into letting anyone join.
 *
 * Member count for the listing is computed live with a COUNT(*) per
 * guild — fine while the catalogue is small. A future cache pass
 * would denormalize it onto `guilds` and bump it on member add/remove.
 */

import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors, AppError } from '../errors';
import { writeAudit } from './audit';
import { assertJoinAllowed } from './raidProtection';
import {
  Permissions,
  computeMemberGuildPermissions,
  hasPermission,
} from './permissions';

const PAGE_LIMIT = 24;
const MAX_DESCRIPTION_LEN = 500;

export interface DiscoverableGuildSummary {
  id: bigint;
  name: string;
  description: string | null;
  /** Long-form pitch shown on the directory. Falls back to the
      short `description` when null. */
  discoveryDescription: string | null;
  /** Category tag — one of DISCOVERY_CATEGORIES. */
  discoveryCategory: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  memberCount: number;
  vanityUrlCode: string | null;
}

/** Canonical category list. MUST match DISCOVERY_CATEGORIES in
    packages/client/src/types.ts. Duplicated here so the API package
    doesn't import from the client package (and to avoid a circular
    dependency through the workspace). Validated in setDiscoverable. */
export const DISCOVERY_CATEGORIES = [
  'Gaming',
  'Music',
  'Entertainment',
  'Education',
  'Science & Technology',
  'Content Creator',
  'Anime & Manga',
  'Movies & TV',
  'Other',
] as const;
export type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number];

// ── List / search ────────────────────────────────────────────────────────

/**
 * Browse discoverable guilds. `query` filters by case-insensitive
 * substring match on name or description; an empty query returns the
 * full directory. Sorted by member count desc so popular guilds
 * surface first.
 *
 * Pagination: cursor-based via `before` (a member-count-and-id
 * pair) would be ideal for a large dataset; for v1 we use simple
 * offset paging since guild counts are small.
 */
export async function listDiscoverable(args: {
  query?: string;
  category?: string;
  offset?: number;
}): Promise<{ guilds: DiscoverableGuildSummary[]; total: number }> {
  const offset = Math.max(0, args.offset ?? 0);
  const q = args.query?.trim() ?? '';
  const cat = args.category?.trim();

  // Build the base WHERE: discoverable=true AND not soft-deleted.
  // Layer in the optional category and text filters as additional
  // AND clauses. "Other" is a special case — it matches both
  // explicitly-tagged "Other" rows AND rows with NULL category, so
  // legacy guilds (created before this column existed) still surface
  // somewhere instead of vanishing from the directory.
  const conds = [
    eq(schema.guilds.discoverable, true),
    isNull(schema.guilds.deletedAt),
  ];
  if (cat) {
    if (cat === 'Other') {
      const otherClause = or(
        eq(schema.guilds.discoveryCategory, 'Other'),
        isNull(schema.guilds.discoveryCategory),
      );
      if (otherClause) conds.push(otherClause);
    } else if ((DISCOVERY_CATEGORIES as readonly string[]).includes(cat)) {
      conds.push(eq(schema.guilds.discoveryCategory, cat));
    }
    // Unknown category strings are silently ignored — treated as no filter.
  }
  if (q.length > 0) {
    const textClause = or(
      ilike(schema.guilds.name, `%${q}%`),
      ilike(schema.guilds.description, `%${q}%`),
      ilike(schema.guilds.discoveryDescription, `%${q}%`),
    );
    if (textClause) conds.push(textClause);
  }
  const where = and(...conds);

  // Member count is read from the denormalized `guilds.member_count` column
  // (maintained for discoverable guilds by refreshDiscoverableMemberCounts +
  // refreshGuildMemberCount). This replaces the old per-request LEFT JOIN +
  // COUNT(DISTINCT) + GROUP BY + aggregate ORDER BY over the whole
  // discoverable catalogue, which didn't scale as the directory grew. The
  // browse default sort (member_count DESC, id DESC) is served by the partial
  // guilds_discoverable_rank_idx. Count is eventually-consistent (fresh to
  // the sweep interval), which is fine for a directory.
  const rows = await db
    .select({
      id: schema.guilds.id,
      name: schema.guilds.name,
      description: schema.guilds.description,
      discoveryDescription: schema.guilds.discoveryDescription,
      discoveryCategory: schema.guilds.discoveryCategory,
      iconUrl: schema.guilds.iconUrl,
      bannerUrl: schema.guilds.bannerUrl,
      vanityUrlCode: schema.guilds.vanityUrlCode,
      memberCount: schema.guilds.memberCount,
    })
    .from(schema.guilds)
    .where(where)
    .orderBy(desc(schema.guilds.memberCount), desc(schema.guilds.id))
    .limit(PAGE_LIMIT)
    .offset(offset);

  // Total count (separate query — fine for v1 since the dataset is
  // small). Front-end uses this for the "X servers" header.
  const totalRows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(schema.guilds)
    .where(where);
  const total = totalRows[0]?.n ?? 0;

  return { guilds: rows, total };
}

/**
 * Recompute `member_count` for every discoverable, non-deleted guild from the
 * exact live count (excluding globally-banned + deleted users — the admin ban
 * path leaves guild_members rows intact for audit retention). One bulk
 * statement, only touching rows whose stored count actually changed.
 * Idempotent + multi-replica safe (concurrent runs converge on the same
 * values). This sweep is the SOURCE OF TRUTH for the directory's denormalized
 * count, so it self-heals any drift — there's no per-membership-mutation
 * counter to keep in sync. Returns the number of guilds updated.
 */
export async function refreshDiscoverableMemberCounts(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE "guilds" g
    SET "member_count" = COALESCE(c.cnt, 0)
    FROM "guilds" g2
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT u.id)::int AS cnt
      FROM "guild_members" gm
      JOIN "users" u ON u.id = gm.user_id
      WHERE gm.guild_id = g2.id
        AND u.banned_at IS NULL
        AND u.deleted_at IS NULL
    ) c ON true
    WHERE g.id = g2.id
      AND g2.discoverable
      AND g2.deleted_at IS NULL
      AND g.member_count IS DISTINCT FROM COALESCE(c.cnt, 0)
    RETURNING g.id
  `);
  return (res as unknown as { length?: number }).length ?? 0;
}

/**
 * Recompute one guild's `member_count` immediately — called when a guild opts
 * INTO discovery so its directory count/rank is correct from the first listing
 * rather than 0 until the next sweep.
 */
export async function refreshGuildMemberCount(guildId: bigint): Promise<void> {
  await db.execute(sql`
    UPDATE "guilds"
    SET "member_count" = COALESCE((
      SELECT COUNT(DISTINCT u.id)::int
      FROM "guild_members" gm
      JOIN "users" u ON u.id = gm.user_id
      WHERE gm.guild_id = ${guildId}
        AND u.banned_at IS NULL
        AND u.deleted_at IS NULL
    ), 0)
    WHERE "id" = ${guildId}
  `);
}

// ── Set discoverable (owner / MANAGE_GUILD) ─────────────────────────────

interface SetDiscoverableInput {
  guildId: bigint;
  actorId: bigint;
  discoverable: boolean;
  /** When discoverable=true, the long-form pitch shown on the directory.
      Optional — falls back to guild.description if null. Pass null to
      clear an existing description. */
  discoveryDescription?: string | null;
  /** Optional category tag — one of DISCOVERY_CATEGORIES. Pass null
      to clear, undefined to leave the existing value alone. Unknown
      strings are rejected as bad-request. */
  discoveryCategory?: string | null;
}

export async function setDiscoverable(
  input: SetDiscoverableInput,
): Promise<schema.Guild> {
  // Permission gate. Owner is implicit; non-owners need MANAGE_GUILD.
  const guild = await getGuildOrThrow(input.guildId);
  if (guild.ownerId !== input.actorId) {
    const perms = await computeMemberGuildPermissions(input.guildId, input.actorId);
    if (!hasPermission(perms, Permissions.MANAGE_GUILD)) {
      throw errors.missingPermissions(['MANAGE_GUILD']);
    }
  }

  let cleanedDesc: string | null | undefined = input.discoveryDescription;
  if (cleanedDesc !== undefined && cleanedDesc !== null) {
    cleanedDesc = cleanedDesc.trim();
    if (cleanedDesc.length === 0) cleanedDesc = null;
    else if (cleanedDesc.length > MAX_DESCRIPTION_LEN) {
      throw errors.badRequest(`Discovery description must be ${MAX_DESCRIPTION_LEN} chars or fewer`);
    }
  }

  let cleanedCat: string | null | undefined = input.discoveryCategory;
  if (cleanedCat !== undefined && cleanedCat !== null) {
    cleanedCat = cleanedCat.trim();
    if (cleanedCat.length === 0) cleanedCat = null;
    else if (!(DISCOVERY_CATEGORIES as readonly string[]).includes(cleanedCat)) {
      throw errors.badRequest(
        `Invalid discovery category. Allowed: ${DISCOVERY_CATEGORIES.join(', ')}`,
      );
    }
  }

  const updates: Partial<schema.NewGuild> = {
    discoverable: input.discoverable,
    updatedAt: new Date(),
  };
  if (cleanedDesc !== undefined) {
    updates.discoveryDescription = cleanedDesc;
  }
  if (cleanedCat !== undefined) {
    updates.discoveryCategory = cleanedCat;
  }

  const [row] = await db
    .update(schema.guilds)
    .set(updates)
    .where(eq(schema.guilds.id, input.guildId))
    .returning();
  if (!row) throw errors.internal('Guild update returned no row');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: input.discoverable ? 'discovery.enable' : 'discovery.disable',
    targetType: 'guild',
    targetId: input.guildId,
    changes: {
      discoverable: input.discoverable,
      ...(cleanedDesc !== undefined ? { discoveryDescription: cleanedDesc } : {}),
      ...(cleanedCat !== undefined ? { discoveryCategory: cleanedCat } : {}),
    },
  });

  // On opt-in, compute the count now so the guild ranks correctly on its first
  // listing instead of showing 0 until the next sweep. (On opt-out nothing
  // reads it, so no refresh needed.)
  if (input.discoverable) {
    await refreshGuildMemberCount(input.guildId).catch(() => undefined);
  }

  return row;
}

// ── Public join ──────────────────────────────────────────────────────────

/**
 * Join a discoverable guild without an invite code. The guild must be
 * marked discoverable; if not, this returns 404 (no leak about whether
 * the guild exists). Idempotent: already-members get a no-op.
 */
export async function joinPublic(args: {
  guildId: bigint;
  userId: bigint;
}): Promise<{ alreadyMember: boolean }> {
  return db.transaction(async (tx) => {
    // Verify the guild is discoverable + not deleted. Single SELECT.
    const rows = await tx
      .select()
      .from(schema.guilds)
      .where(
        and(
          eq(schema.guilds.id, args.guildId),
          eq(schema.guilds.discoverable, true),
          isNull(schema.guilds.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw errors.notFound('Guild');

    // Ban check.
    const banned = await tx
      .select({ userId: schema.bans.userId })
      .from(schema.bans)
      .where(
        and(
          eq(schema.bans.guildId, args.guildId),
          eq(schema.bans.userId, args.userId),
        ),
      )
      .limit(1);
    if (banned[0]) throw errors.forbidden('You are banned from this guild');

    // Supervision: an unlinked minor (or a guardian-restricted child) can't
    // join servers — same capability gate as invite-accept.
    const { getEffectiveRestrictions } = await import('./supervision');
    const restr = await getEffectiveRestrictions(args.userId);
    if (restr && !restr.allowJoinGuilds) {
      throw new AppError(
        'FORBIDDEN',
        'Joining servers is restricted — connect a guardian to continue',
        { supervisionRestricted: 'join_guild', guildId: args.guildId.toString() },
      );
    }

    // Raid protection — same gates as invite-accept.
    const [joiningUser] = await tx
      .select({
        createdAt: schema.users.createdAt,
        emailVerified: schema.users.emailVerified,
      })
      .from(schema.users)
      .where(eq(schema.users.id, args.userId))
      .limit(1);
    if (joiningUser) {
      await assertJoinAllowed(
        tx,
        {
          id: args.guildId,
          minAccountAgeMinutes: rows[0].minAccountAgeMinutes,
          requireVerifiedEmail: rows[0].requireVerifiedEmail,
          raidModeEnabled: rows[0].raidModeEnabled,
          joinRateLimitCount: rows[0].joinRateLimitCount,
          joinRateLimitSeconds: rows[0].joinRateLimitSeconds,
        },
        joiningUser,
      );
    }

    // Idempotency.
    const existing = await tx
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(
        and(
          eq(schema.guildMembers.guildId, args.guildId),
          eq(schema.guildMembers.userId, args.userId),
        ),
      )
      .limit(1);
    if (existing[0]) return { alreadyMember: true };

    await tx.insert(schema.guildMembers).values({
      guildId: args.guildId,
      userId: args.userId,
      // Same onboarding-gate logic as invite-accept: pending when
      // the guild has rules configured, else active.
      membershipState: rows[0].rulesContent ? 'pending' : 'active',
    });
    await writeAudit({
      tx,
      guildId: args.guildId,
      actorId: args.userId,
      action: 'member.join',
      targetType: 'member',
      targetId: args.userId,
      changes: { via: 'discovery' },
    });
    return { alreadyMember: false };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function getGuildOrThrow(guildId: bigint): Promise<schema.Guild> {
  const r = await db
    .select()
    .from(schema.guilds)
    .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
    .limit(1);
  if (!r[0]) throw errors.notFound('Guild');
  return r[0];
}
