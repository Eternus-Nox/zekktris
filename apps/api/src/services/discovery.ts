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
import { errors } from '../errors';
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

  // Compute member counts via a LEFT JOIN + GROUP BY. Previously this
  // was a correlated subquery in the SELECT clause; that pattern
  // returned 0 for guilds that actually had members — drizzle's
  // sql-template builder didn't emit the outer-scope guild reference
  // in a form Postgres correlated reliably, and the count came back
  // as zero regardless of guild_members content. LEFT JOIN +
  // GROUP BY is the textbook fix: explicit join with filters in the
  // ON clause, then COUNT(DISTINCT) on the joined user id so guilds
  // with no surviving members still appear (counted as 0) rather
  // than dropping out of the result set entirely.
  //
  // Filters out banned + soft-deleted users in the ON clause for the
  // same reason as before: the admin ban path leaves guild_members
  // rows intact (audit retention), so an unfiltered COUNT would
  // inflate the directory number with banned ghosts.
  const memberCountSql = sql<number>`COUNT(DISTINCT ${schema.users.id})::int`;

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
      memberCount: memberCountSql,
    })
    .from(schema.guilds)
    // LEFT JOIN through guild_members → users so banned/deleted users
    // are filtered from the count in the ON clause. LEFT preserves
    // guild rows even when they have zero qualifying members, so a
    // newly-created guild (1 owner, no one else) still renders.
    .leftJoin(
      schema.guildMembers,
      eq(schema.guildMembers.guildId, schema.guilds.id),
    )
    .leftJoin(
      schema.users,
      and(
        eq(schema.users.id, schema.guildMembers.userId),
        isNull(schema.users.bannedAt),
        isNull(schema.users.deletedAt),
      ),
    )
    .where(where)
    .groupBy(
      schema.guilds.id,
      schema.guilds.name,
      schema.guilds.description,
      schema.guilds.discoveryDescription,
      schema.guilds.discoveryCategory,
      schema.guilds.iconUrl,
      schema.guilds.bannerUrl,
      schema.guilds.vanityUrlCode,
    )
    .orderBy(desc(memberCountSql), desc(schema.guilds.id))
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
