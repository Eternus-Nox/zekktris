/**
 * Supervision (parental controls) service
 * ---------------------------------------
 * The relationship lifecycle and the queries that other parts of the
 * system use to answer "is this user supervised?", "who is their
 * parent?", and "should this DM be end-to-end encrypted?".
 *
 * Consent gate: a link is created `pending` by the parent and only
 * becomes `active` when the CHILD accepts. Nothing about supervision
 * takes effect until then — this is what stops the feature being used to
 * monitor a non-consenting party.
 *
 * Later phases layer monitoring, watch-word flagging, and restriction
 * enforcement on top of these primitives; this module is the foundation.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { errors } from '../errors';
import * as dispatch from '../gateway/dispatch';

/**
 * Supervision caps. "Up to two people can supervise an account, and a
 * guardian can supervise up to six accounts." Enforced on ACTIVE links
 * (pending requests don't count — they aren't control yet) at both
 * request and accept time.
 */
export const MAX_PARENTS_PER_CHILD = 2;
export const MAX_CHILDREN_PER_PARENT = 6;


/** Best-effort display name for a user id (for notification labels). */
async function displayNameFor(userId: bigint): Promise<string> {
  const [u] = await db
    .select({ username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u?.displayName || u?.username || 'Account';
}

const userSummary = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  avatarUrl: schema.users.avatarUrl,
  status: schema.users.status,
  customStatus: schema.users.customStatus,
};

/** Parent sends a supervision request to a child account (by username). */
export async function requestLink(parentId: bigint, childUsername: string) {
  const handle = childUsername.trim();
  const child = await db.query.users.findFirst({
    where: and(
      sql`lower(${schema.users.username}) = lower(${handle})`,
      eq(schema.users.isBot, false),
    ),
    columns: { id: true, username: true, displayName: true, avatarUrl: true },
  });
  if (!child) throw errors.badRequest('No account with that username');
  if (child.id === parentId) throw errors.badRequest("You can't supervise your own account");

  // Reject a duplicate (pending or active) in either direction so we
  // can't create a supervision cycle or a redundant request.
  const existing = await db
    .select({ status: schema.parentChildLinks.status })
    .from(schema.parentChildLinks)
    .where(
      or(
        and(
          eq(schema.parentChildLinks.parentId, parentId),
          eq(schema.parentChildLinks.childId, child.id),
        ),
        and(
          eq(schema.parentChildLinks.parentId, child.id),
          eq(schema.parentChildLinks.childId, parentId),
        ),
      ),
    );
  if (existing.some((r) => r.status !== 'revoked')) {
    throw errors.conflict('A supervision link with this account already exists');
  }

  // Capacity caps (active links only — a pending request isn't control).
  if ((await getActiveChildIds(parentId)).length >= MAX_CHILDREN_PER_PARENT) {
    throw errors.badRequest(`You can supervise up to ${MAX_CHILDREN_PER_PARENT} accounts`);
  }
  if ((await getActiveParentIds(child.id)).length >= MAX_PARENTS_PER_CHILD) {
    throw errors.badRequest(
      `That account already has the maximum of ${MAX_PARENTS_PER_CHILD} guardians`,
    );
  }

  await db
    .insert(schema.parentChildLinks)
    .values({ parentId, childId: child.id, status: 'pending' })
    .onConflictDoUpdate({
      target: [schema.parentChildLinks.parentId, schema.parentChildLinks.childId],
      set: { status: 'pending', createdAt: new Date(), acceptedAt: null, revokedAt: null },
    });

  return child;
}

/** Child accepts a pending request, activating supervision. */
export async function acceptLink(childId: bigint, parentId: bigint) {
  // Re-check caps at accept time — counts can change between request and
  // acceptance (two pending requests could otherwise both activate).
  if ((await getActiveParentIds(childId)).length >= MAX_PARENTS_PER_CHILD) {
    throw errors.badRequest(
      `You already have the maximum of ${MAX_PARENTS_PER_CHILD} guardians`,
    );
  }
  if ((await getActiveChildIds(parentId)).length >= MAX_CHILDREN_PER_PARENT) {
    throw errors.badRequest(
      `That guardian is already supervising the maximum of ${MAX_CHILDREN_PER_PARENT} accounts`,
    );
  }
  const updated = await db
    .update(schema.parentChildLinks)
    .set({ status: 'active', acceptedAt: new Date() })
    .where(
      and(
        eq(schema.parentChildLinks.parentId, parentId),
        eq(schema.parentChildLinks.childId, childId),
        eq(schema.parentChildLinks.status, 'pending'),
      ),
    )
    .returning({ childId: schema.parentChildLinks.childId });
  if (updated.length === 0) throw errors.badRequest('No pending request from that account');
  // Make sure a restrictions row exists with defaults.
  await ensureRestrictions(childId);
}

/**
 * End a link. The PARENT may always remove it (cancel a pending request
 * or unlink an active child). The CHILD may only decline/cancel a request
 * that is still PENDING — once they've accepted supervision they cannot
 * unilaterally remove a guardian. This is core to parental controls: a
 * kid shouldn't be able to switch off oversight on their own.
 *
 * Per-child restrictions/watch-words remain keyed to the child and go
 * dormant if no active link remains (re-linking reuses them).
 */
export async function removeLinkBetween(actorId: bigint, otherId: bigint) {
  const [link] = await db
    .select({
      parentId: schema.parentChildLinks.parentId,
      childId: schema.parentChildLinks.childId,
      status: schema.parentChildLinks.status,
    })
    .from(schema.parentChildLinks)
    .where(
      or(
        and(
          eq(schema.parentChildLinks.parentId, actorId),
          eq(schema.parentChildLinks.childId, otherId),
        ),
        and(
          eq(schema.parentChildLinks.parentId, otherId),
          eq(schema.parentChildLinks.childId, actorId),
        ),
      ),
    )
    .limit(1);
  if (!link) return; // nothing to remove (idempotent)

  const actorIsChild = link.childId === actorId;
  if (actorIsChild && link.status === 'active') {
    throw errors.forbidden('Only a guardian can remove parental supervision');
  }

  await db
    .delete(schema.parentChildLinks)
    .where(
      and(
        eq(schema.parentChildLinks.parentId, link.parentId),
        eq(schema.parentChildLinks.childId, link.childId),
      ),
    );
}

export async function ensureRestrictions(childId: bigint) {
  await db
    .insert(schema.childRestrictions)
    .values({ childId })
    .onConflictDoNothing({ target: schema.childRestrictions.childId });
}

/** Active parent ids for a child (usually 0 or 1, up to 2 guardians). */
export async function getActiveParentIds(childId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ parentId: schema.parentChildLinks.parentId })
    .from(schema.parentChildLinks)
    .where(
      and(
        eq(schema.parentChildLinks.childId, childId),
        eq(schema.parentChildLinks.status, 'active'),
      ),
    );
  return rows.map((r) => r.parentId);
}

/** Active child ids supervised by a parent. */
export async function getActiveChildIds(parentId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ childId: schema.parentChildLinks.childId })
    .from(schema.parentChildLinks)
    .where(
      and(
        eq(schema.parentChildLinks.parentId, parentId),
        eq(schema.parentChildLinks.status, 'active'),
      ),
    );
  return rows.map((r) => r.childId);
}

export async function isSupervised(childId: bigint): Promise<boolean> {
  return (await getActiveParentIds(childId)).length > 0;
}

/** Throw unless the caller actively supervises the given child. */
export async function assertParentOf(parentId: bigint, childId: bigint): Promise<void> {
  const parents = await getActiveParentIds(childId);
  if (!parents.includes(parentId)) {
    throw errors.forbidden('You do not supervise this account');
  }
}

/**
 * E2EE policy for a 1:1 DM between two users. A supervised child's DMs
 * are NOT end-to-end encrypted so the parent can review them — EXCEPT a
 * DM between the child and one of their own active parents, which stays
 * encrypted and private. Returns true when E2EE is permitted.
 */
export async function isE2eeAllowedBetween(a: bigint, b: bigint): Promise<boolean> {
  const [aParents, bParents] = await Promise.all([
    getActiveParentIds(a),
    getActiveParentIds(b),
  ]);
  // If A is a supervised child, E2EE only allowed when B is A's parent.
  if (aParents.length > 0 && !aParents.includes(b)) return false;
  // Symmetric for B.
  if (bParents.length > 0 && !bParents.includes(a)) return false;
  return true;
}

/**
 * Batched version for serializing many DMs at once. Loads every active
 * parent link for the given user ids in ONE query and returns a synchronous
 * predicate `allowed(a, b)` — true when E2EE is permitted for that pair.
 * `suppressed = !allowed(a, b)`.
 */
export async function buildE2eePolicy(
  userIds: Iterable<bigint>,
): Promise<(a: bigint, b: bigint) => boolean> {
  const ids = [...new Set([...userIds].map((u) => u.toString()))].map((s) => BigInt(s));
  const parentsByChild = new Map<string, Set<string>>();
  if (ids.length > 0) {
    const rows = await db
      .select({
        parentId: schema.parentChildLinks.parentId,
        childId: schema.parentChildLinks.childId,
      })
      .from(schema.parentChildLinks)
      .where(
        and(
          eq(schema.parentChildLinks.status, 'active'),
          inArray(schema.parentChildLinks.childId, ids),
        ),
      );
    for (const r of rows) {
      const key = r.childId.toString();
      let set = parentsByChild.get(key);
      if (!set) parentsByChild.set(key, (set = new Set()));
      set.add(r.parentId.toString());
    }
  }
  return (a: bigint, b: bigint) => {
    const aParents = parentsByChild.get(a.toString());
    const bParents = parentsByChild.get(b.toString());
    if (aParents && aParents.size > 0 && !aParents.has(b.toString())) return false;
    if (bParents && bParents.size > 0 && !bParents.has(a.toString())) return false;
    return true;
  };
}

/** Everything the /family/me endpoint needs for the current user. */
export async function supervisionSummary(userId: bigint) {
  const myRestrictions = await getEnforcedRestrictions(userId);
  const asParent = await db
    .select({
      status: schema.parentChildLinks.status,
      createdAt: schema.parentChildLinks.createdAt,
      child: userSummary,
    })
    .from(schema.parentChildLinks)
    .innerJoin(schema.users, eq(schema.users.id, schema.parentChildLinks.childId))
    .where(
      and(
        eq(schema.parentChildLinks.parentId, userId),
        inArray(schema.parentChildLinks.status, ['pending', 'active']),
      ),
    );

  const asChild = await db
    .select({
      status: schema.parentChildLinks.status,
      createdAt: schema.parentChildLinks.createdAt,
      parent: userSummary,
    })
    .from(schema.parentChildLinks)
    .innerJoin(schema.users, eq(schema.users.id, schema.parentChildLinks.parentId))
    .where(
      and(
        eq(schema.parentChildLinks.childId, userId),
        inArray(schema.parentChildLinks.status, ['pending', 'active']),
      ),
    );

  return {
    // The current user's own restrictions, if they're a supervised
    // child (null otherwise). Lets the client disable restricted
    // actions and offer the "ask your parent" path proactively.
    restrictions: myRestrictions
      ? {
          canAddFriends: myRestrictions.canAddFriends,
          canRemoveFriends: myRestrictions.canRemoveFriends,
          allowVoice: myRestrictions.allowVoice,
          allowVideo: myRestrictions.allowVideo,
          allowStream: myRestrictions.allowStream,
          allowCreateGuild: myRestrictions.allowCreateGuild,
        }
      : null,
    // Children I supervise (active) + requests I've sent (pending).
    children: asParent
      .filter((r) => r.status === 'active')
      .map((r) => ({ ...r.child, id: String(r.child.id), since: r.createdAt })),
    outgoingRequests: asParent
      .filter((r) => r.status === 'pending')
      .map((r) => ({ ...r.child, id: String(r.child.id) })),
    // Parents supervising me (active) + requests awaiting my acceptance.
    supervisedBy: asChild
      .filter((r) => r.status === 'active')
      .map((r) => ({ ...r.parent, id: String(r.parent.id), since: r.createdAt })),
    incomingRequests: asChild
      .filter((r) => r.status === 'pending')
      .map((r) => ({ ...r.parent, id: String(r.parent.id) })),
  };
}

// ── Restrictions ─────────────────────────────────────────────────────────

const DEFAULT_RESTRICTIONS = {
  canAddFriends: true,
  canRemoveFriends: true,
  allowVoice: true,
  allowVideo: true,
  allowStream: true,
  allowCreateGuild: true,
};

/** Restrictions in effect for a user, or null if they aren't supervised. */
export async function getEnforcedRestrictions(
  userId: bigint,
): Promise<typeof schema.childRestrictions.$inferSelect | null> {
  const parents = await getActiveParentIds(userId);
  if (parents.length === 0) return null;
  const [row] = await db
    .select()
    .from(schema.childRestrictions)
    .where(eq(schema.childRestrictions.childId, userId))
    .limit(1);
  return row ?? { childId: userId, ...DEFAULT_RESTRICTIONS, updatedAt: new Date() };
}

/** Parent-facing read of a child's restrictions (defaults if no row yet). */
export async function getRestrictions(childId: bigint) {
  const [row] = await db
    .select()
    .from(schema.childRestrictions)
    .where(eq(schema.childRestrictions.childId, childId))
    .limit(1);
  const r = row ?? { childId, ...DEFAULT_RESTRICTIONS, updatedAt: new Date() };
  return {
    canAddFriends: r.canAddFriends,
    canRemoveFriends: r.canRemoveFriends,
    allowVoice: r.allowVoice,
    allowVideo: r.allowVideo,
    allowStream: r.allowStream,
    allowCreateGuild: r.allowCreateGuild,
  };
}

export type RestrictionPatch = Partial<{
  canAddFriends: boolean;
  canRemoveFriends: boolean;
  allowVoice: boolean;
  allowVideo: boolean;
  allowStream: boolean;
  allowCreateGuild: boolean;
}>;

export async function setRestrictions(parentId: bigint, childId: bigint, patch: RestrictionPatch) {
  await assertParentOf(parentId, childId);
  await db
    .insert(schema.childRestrictions)
    .values({ childId, ...patch })
    .onConflictDoUpdate({
      target: schema.childRestrictions.childId,
      set: { ...patch, updatedAt: new Date() },
    });
  return getRestrictions(childId);
}

// ── Blocked guilds ───────────────────────────────────────────────────────

export async function listBlockedGuildIds(childId: bigint): Promise<string[]> {
  const rows = await db
    .select({ guildId: schema.childBlockedGuilds.guildId })
    .from(schema.childBlockedGuilds)
    .where(eq(schema.childBlockedGuilds.childId, childId));
  return rows.map((r) => r.guildId.toString());
}

export async function setGuildBlocked(
  parentId: bigint,
  childId: bigint,
  guildId: bigint,
  blocked: boolean,
) {
  await assertParentOf(parentId, childId);
  if (blocked) {
    await db
      .insert(schema.childBlockedGuilds)
      .values({ childId, guildId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.childBlockedGuilds)
      .where(
        and(
          eq(schema.childBlockedGuilds.childId, childId),
          eq(schema.childBlockedGuilds.guildId, guildId),
        ),
      );
  }
}

/** Enforcement: is this guild off-limits for this (supervised) user? */
export async function isGuildBlockedForChild(childId: bigint, guildId: bigint): Promise<boolean> {
  const parents = await getActiveParentIds(childId);
  if (parents.length === 0) return false;
  const [row] = await db
    .select({ g: schema.childBlockedGuilds.guildId })
    .from(schema.childBlockedGuilds)
    .where(
      and(
        eq(schema.childBlockedGuilds.childId, childId),
        eq(schema.childBlockedGuilds.guildId, guildId),
      ),
    )
    .limit(1);
  return !!row;
}

// ── Approval requests ────────────────────────────────────────────────────

export async function createFriendApproval(childId: bigint, targetUserId: bigint, note?: string) {
  // Must actually be supervised + restricted, else there's nothing to approve.
  const restr = await getEnforcedRestrictions(childId);
  if (!restr || restr.canAddFriends) {
    throw errors.badRequest('You can add this friend yourself');
  }
  const id = nextSnowflake();
  await db.insert(schema.childRequests).values({
    id,
    childId,
    type: 'friend',
    targetUserId,
    note: note ?? null,
  });
  try {
    const [childName, targetName] = await Promise.all([
      displayNameFor(childId),
      displayNameFor(targetUserId),
    ]);
    dispatch.familyRequestCreate({
      parentIds: await getActiveParentIds(childId),
      childId,
      childName,
      kind: 'friend',
      label: `add ${targetName}`,
    });
  } catch {
    /* best-effort */
  }
  return id.toString();
}

export async function createGuildApproval(
  childId: bigint,
  inviteCode: string,
  guildId: bigint | null,
  note?: string,
) {
  const id = nextSnowflake();
  await db.insert(schema.childRequests).values({
    id,
    childId,
    type: 'guild',
    inviteCode,
    guildId,
    note: note ?? null,
  });
  try {
    const childName = await displayNameFor(childId);
    let guildName = 'a server';
    if (guildId) {
      const [g] = await db
        .select({ name: schema.guilds.name })
        .from(schema.guilds)
        .where(eq(schema.guilds.id, guildId))
        .limit(1);
      if (g?.name) guildName = `“${g.name}”`;
    }
    dispatch.familyRequestCreate({
      parentIds: await getActiveParentIds(childId),
      childId,
      childName,
      kind: 'guild',
      label: `join ${guildName}`,
    });
  } catch {
    /* best-effort */
  }
  return id.toString();
}

const reqUser = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  avatarUrl: schema.users.avatarUrl,
};

/** Pending approval requests across all of a parent's supervised children. */
export async function listParentRequests(parentId: bigint) {
  const childIds = await getActiveChildIds(parentId);
  if (childIds.length === 0) return [];
  const rows = await db
    .select({
      id: schema.childRequests.id,
      type: schema.childRequests.type,
      note: schema.childRequests.note,
      createdAt: schema.childRequests.createdAt,
      inviteCode: schema.childRequests.inviteCode,
      guildId: schema.childRequests.guildId,
      childId: schema.childRequests.childId,
      childUsername: schema.users.username,
      childDisplayName: schema.users.displayName,
    })
    .from(schema.childRequests)
    .innerJoin(schema.users, eq(schema.users.id, schema.childRequests.childId))
    .where(
      and(
        inArray(schema.childRequests.childId, childIds),
        eq(schema.childRequests.status, 'pending'),
      ),
    )
    .orderBy(sql`${schema.childRequests.createdAt} desc`);

  // Hydrate friend targets + guild names in small follow-up queries.
  const targetIds = await db
    .select({ id: schema.childRequests.id, targetUserId: schema.childRequests.targetUserId })
    .from(schema.childRequests)
    .where(inArray(schema.childRequests.id, rows.map((r) => r.id)));
  const targetByReq = new Map(targetIds.map((t) => [t.id.toString(), t.targetUserId]));
  const distinctTargets = [...new Set(targetIds.map((t) => t.targetUserId).filter((x): x is bigint => x !== null))];
  const targetUsers = distinctTargets.length
    ? await db.select(reqUser).from(schema.users).where(inArray(schema.users.id, distinctTargets))
    : [];
  const targetUserById = new Map(targetUsers.map((u) => [u.id.toString(), u]));

  const guildIds = [...new Set(rows.map((r) => r.guildId).filter((x): x is bigint => x !== null))];
  const guildRows = guildIds.length
    ? await db
        .select({ id: schema.guilds.id, name: schema.guilds.name })
        .from(schema.guilds)
        .where(inArray(schema.guilds.id, guildIds))
    : [];
  const guildById = new Map(guildRows.map((g) => [g.id.toString(), g.name]));

  return rows.map((r) => {
    const tid = targetByReq.get(r.id.toString());
    const tu = tid ? targetUserById.get(tid.toString()) : null;
    return {
      id: r.id.toString(),
      type: r.type,
      note: r.note,
      createdAt: r.createdAt,
      child: {
        id: r.childId.toString(),
        username: r.childUsername,
        displayName: r.childDisplayName,
      },
      target: tu ? { id: tu.id.toString(), username: tu.username, displayName: tu.displayName } : null,
      guild: r.guildId ? { id: r.guildId.toString(), name: guildById.get(r.guildId.toString()) ?? null } : null,
      inviteCode: r.inviteCode,
    };
  });
}

export async function approveRequest(parentId: bigint, requestId: bigint) {
  const [req] = await db
    .select()
    .from(schema.childRequests)
    .where(eq(schema.childRequests.id, requestId))
    .limit(1);
  if (!req || req.status !== 'pending') throw errors.badRequest('Request not found');
  await assertParentOf(parentId, req.childId);

  if (req.type === 'friend' && req.targetUserId) {
    const { sendFriendRequest } = await import('./relationships');
    await sendFriendRequest(req.childId, req.targetUserId);
  } else if (req.type === 'guild') {
    // Key the join on the STABLE guild id (resolved + stored when the child
    // made the request), NOT the mutable invite code — which may have been
    // revoked / expired / regenerated since, breaking or mis-associating an
    // otherwise-valid approval. Fall back to the invite code only for legacy
    // rows that never resolved a guild id at request time.
    const { joinGuildByApproval, acceptInvite } = await import('./invites');
    if (req.guildId) {
      await joinGuildByApproval(req.guildId, req.childId);
    } else if (req.inviteCode) {
      await acceptInvite(req.inviteCode, req.childId, { skipSupervisionCheck: true });
    }
  }

  await db
    .update(schema.childRequests)
    .set({ status: 'approved', resolvedAt: new Date() })
    .where(eq(schema.childRequests.id, requestId));
}

export async function denyRequest(parentId: bigint, requestId: bigint) {
  const [req] = await db
    .select({ childId: schema.childRequests.childId, status: schema.childRequests.status })
    .from(schema.childRequests)
    .where(eq(schema.childRequests.id, requestId))
    .limit(1);
  if (!req || req.status !== 'pending') throw errors.badRequest('Request not found');
  await assertParentOf(parentId, req.childId);
  await db
    .update(schema.childRequests)
    .set({ status: 'denied', resolvedAt: new Date() })
    .where(eq(schema.childRequests.id, requestId));
}

// ── Watch words + flagging ───────────────────────────────────────────────

export async function listWatchWords(parentId: bigint, childId: bigint): Promise<string[]> {
  await assertParentOf(parentId, childId);
  const rows = await db
    .select({ word: schema.childWatchWords.word })
    .from(schema.childWatchWords)
    .where(eq(schema.childWatchWords.childId, childId))
    .orderBy(schema.childWatchWords.word);
  return rows.map((r) => r.word);
}

export async function addWatchWord(parentId: bigint, childId: bigint, input: string) {
  await assertParentOf(parentId, childId);
  // Accept a single word or a comma-separated list. Normalize each:
  // trim, lowercase, drop empties, cap length, dedupe.
  const words = [
    ...new Set(
      input
        .split(',')
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 0 && w.length <= 64),
    ),
  ];
  if (words.length === 0) throw errors.badRequest('Enter at least one word');
  await db
    .insert(schema.childWatchWords)
    .values(words.map((word) => ({ childId, word })))
    .onConflictDoNothing();
  return listWatchWords(parentId, childId);
}

export async function removeWatchWord(parentId: bigint, childId: bigint, word: string) {
  await assertParentOf(parentId, childId);
  await db
    .delete(schema.childWatchWords)
    .where(
      and(
        eq(schema.childWatchWords.childId, childId),
        eq(schema.childWatchWords.word, word.trim().toLowerCase()),
      ),
    );
  return listWatchWords(parentId, childId);
}

async function watchWordsFor(childId: bigint): Promise<string[]> {
  const rows = await db
    .select({ word: schema.childWatchWords.word })
    .from(schema.childWatchWords)
    .where(eq(schema.childWatchWords.childId, childId));
  return rows.map((r) => r.word);
}

/**
 * Scan a newly-created message against the watch words of any supervised
 * child it touches, and record flags. Best-effort + fire-and-forget from
 * the caller — must never block or fail a send.
 *
 *   • SENT: the author is a supervised child → check the author's words.
 *   • RECEIVED: a 1:1 DM where the OTHER party is a supervised child →
 *     check that child's words. (Supervised DMs are plaintext, so the
 *     content is readable here.)
 *
 * Guild "received" is intentionally out of scope — it would mean scanning
 * every channel member per message, which is both expensive and noisy.
 */
export async function scanMessageForFlags(input: {
  messageId: bigint;
  channelId: bigint;
  channelType: string;
  authorId: bigint | null;
  content: string;
}): Promise<void> {
  const content = (input.content || '').toLowerCase();
  if (!content.trim() || !input.authorId) return;

  const candidates: Array<{ childId: bigint; direction: 'sent' | 'received' }> = [
    { childId: input.authorId, direction: 'sent' },
  ];
  if (input.channelType === 'dm') {
    const { getOtherRecipient } = await import('./dms');
    const peer = await getOtherRecipient(input.channelId, input.authorId);
    if (peer) candidates.push({ childId: peer, direction: 'received' });
  }

  for (const cand of candidates) {
    const words = await watchWordsFor(cand.childId);
    if (words.length === 0) continue;
    const parents = await getActiveParentIds(cand.childId);
    if (parents.length === 0) continue; // not supervised
    const matched = [...new Set(words.filter((w) => content.includes(w)))];
    if (matched.length === 0) continue;
    const matchedWord = matched.join(', ').slice(0, 200);
    await db.insert(schema.flaggedMessages).values({
      id: nextSnowflake(),
      childId: cand.childId,
      messageId: input.messageId,
      channelId: input.channelId,
      matchedWord,
      direction: cand.direction,
    });
    // Push to the supervising parent(s) so the flag surfaces live.
    try {
      const childName = await displayNameFor(cand.childId);
      dispatch.familyFlagCreate({
        parentIds: parents,
        childId: cand.childId,
        childName,
        matchedWord,
        direction: cand.direction,
      });
    } catch {
      /* notification is best-effort */
    }
  }
}

export async function listFlags(parentId: bigint, childId: bigint, limit = 100) {
  await assertParentOf(parentId, childId);
  const rows = await db
    .select({
      id: schema.flaggedMessages.id,
      messageId: schema.flaggedMessages.messageId,
      channelId: schema.flaggedMessages.channelId,
      matchedWord: schema.flaggedMessages.matchedWord,
      direction: schema.flaggedMessages.direction,
      createdAt: schema.flaggedMessages.createdAt,
      reviewedAt: schema.flaggedMessages.reviewedAt,
      content: schema.messages.content,
      authorId: schema.messages.authorId,
    })
    .from(schema.flaggedMessages)
    .leftJoin(schema.messages, eq(schema.messages.id, schema.flaggedMessages.messageId))
    .where(
      and(
        eq(schema.flaggedMessages.childId, childId),
        // Reviewed flags drop off the alert list — once the parent has
        // seen one it's cleared and won't resurface on refresh.
        isNull(schema.flaggedMessages.reviewedAt),
      ),
    )
    .orderBy(sql`${schema.flaggedMessages.createdAt} desc`)
    .limit(limit);
  return rows.map((r) => ({
    id: r.id.toString(),
    messageId: r.messageId.toString(),
    channelId: r.channelId.toString(),
    matchedWord: r.matchedWord,
    direction: r.direction,
    createdAt: r.createdAt,
    reviewed: r.reviewedAt !== null,
    byChild: r.authorId !== null && r.authorId === childId,
    snippet: r.content ? r.content.slice(0, 280) : null,
  }));
}

export async function markFlagReviewed(parentId: bigint, flagId: bigint) {
  const [f] = await db
    .select({ childId: schema.flaggedMessages.childId })
    .from(schema.flaggedMessages)
    .where(eq(schema.flaggedMessages.id, flagId))
    .limit(1);
  if (!f) throw errors.badRequest('Flag not found');
  await assertParentOf(parentId, f.childId);
  await db
    .update(schema.flaggedMessages)
    .set({ reviewedAt: new Date() })
    .where(eq(schema.flaggedMessages.id, flagId));
}
