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
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { errors } from '../errors';
import { ageOnDate, adultCutoffDob, isMinorDob, ADULT_AGE, MINOR_GRACE_DAYS } from '../lib/age';
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
/** True if this user is a supervised-age minor (13–17) — a minor can only be
 *  supervised, never act as a guardian. */
async function isMinorUser(userId: bigint): Promise<boolean> {
  const [u] = await db
    .select({ dateOfBirth: schema.users.dateOfBirth })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return isMinorDob(u?.dateOfBirth ?? null, new Date());
}

export async function requestLink(parentId: bigint, childUsername: string) {
  // A minor can't supervise anyone — they can only be supervised.
  if (await isMinorUser(parentId)) {
    throw errors.forbidden('Minors cannot supervise other accounts');
  }
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
  // Independent lookups; run them together.
  const [activeChildren, activeParents] = await Promise.all([
    getActiveChildIds(parentId),
    getActiveParentIds(child.id),
  ]);
  if (activeChildren.length >= MAX_CHILDREN_PER_PARENT) {
    throw errors.badRequest(`You can supervise up to ${MAX_CHILDREN_PER_PARENT} accounts`);
  }
  if (activeParents.length >= MAX_PARENTS_PER_CHILD) {
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
  await db.transaction(async (tx) => {
    // Serialize concurrent accepts touching this child / this parent so the
    // cap re-check and the activation UPDATE are effectively atomic. Without
    // it, two simultaneous accepts each read the stale pre-accept count, both
    // pass the cap gate, and both flip their own distinct pending row →
    // guardian/child cap exceeded by one. Lock child THEN parent (distinct
    // key namespaces ⇒ deadlock-free) — the loser blocks until the winner
    // commits, then re-reads the now-current count and is correctly rejected.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`supchild:${childId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`supparent:${parentId}`}))`);

    // Committed reads — the advisory locks guarantee no competing accept sits
    // between this count and our commit, so a plain db read is accurate here.
    const [activeParents, activeChildren] = await Promise.all([
      getActiveParentIds(childId),
      getActiveChildIds(parentId),
    ]);
    if (activeParents.length >= MAX_PARENTS_PER_CHILD) {
      throw errors.badRequest(
        `You already have the maximum of ${MAX_PARENTS_PER_CHILD} guardians`,
      );
    }
    if (activeChildren.length >= MAX_CHILDREN_PER_PARENT) {
      throw errors.badRequest(
        `That guardian is already supervising the maximum of ${MAX_CHILDREN_PER_PARENT} accounts`,
      );
    }
    const updated = await tx
      .update(schema.parentChildLinks)
      .set({ status: 'active', acceptedAt: new Date() })
      .where(
        and(
          eq(schema.parentChildLinks.parentId, parentId),
          eq(schema.parentChildLinks.childId, childId),
          eq(schema.parentChildLinks.status, 'pending'),
          // Only the CHILD accepts a PARENT-initiated request. A child-initiated
          // request (initiated_by='child') is accepted by the parent via
          // acceptChildInitiatedLink — guarding here stops a child "accepting"
          // their own invite.
          eq(schema.parentChildLinks.initiatedBy, 'parent'),
        ),
      )
      .returning({ childId: schema.parentChildLinks.childId });
    if (updated.length === 0) throw errors.badRequest('No pending request from that account');
  });
  // Make sure a restrictions row exists with defaults.
  await ensureRestrictions(childId);
  // Activation changes the child's effective restrictions (an unlinked minor
  // goes from STRICT lockdown to the guardian's row); push it now.
  await notifySupervisionChanged(childId);
}

/**
 * Child invites a parent to supervise them, BY EMAIL (the reverse of
 * requestLink). If the email already has an account, create a pending
 * child-initiated link the PARENT must accept; otherwise email an invite to
 * sign up. We never create a dangling link row for a non-existent account.
 */
export async function requestParentByEmail(
  childId: bigint,
  rawEmail: string,
): Promise<{ status: 'pending' | 'awaiting_signup' }> {
  const email = rawEmail.trim().toLowerCase(); // emails are stored lowercased
  const parent = await db.query.users.findFirst({
    where: and(eq(schema.users.email, email), eq(schema.users.isBot, false)),
    columns: { id: true },
  });

  if (parent) {
    if (parent.id === childId) throw errors.badRequest("You can't supervise your own account");
    // Reject a duplicate (pending or active) link in either direction.
    const existing = await db
      .select({ status: schema.parentChildLinks.status })
      .from(schema.parentChildLinks)
      .where(
        or(
          and(
            eq(schema.parentChildLinks.parentId, parent.id),
            eq(schema.parentChildLinks.childId, childId),
          ),
          and(
            eq(schema.parentChildLinks.parentId, childId),
            eq(schema.parentChildLinks.childId, parent.id),
          ),
        ),
      );
    if (existing.some((r) => r.status !== 'revoked')) {
      throw errors.conflict('A supervision link with this account already exists');
    }
    const [activeParents, activeChildren] = await Promise.all([
      getActiveParentIds(childId),
      getActiveChildIds(parent.id),
    ]);
    if (activeParents.length >= MAX_PARENTS_PER_CHILD) {
      throw errors.badRequest(`You already have the maximum of ${MAX_PARENTS_PER_CHILD} guardians`);
    }
    if (activeChildren.length >= MAX_CHILDREN_PER_PARENT) {
      throw errors.badRequest(
        `That guardian is already supervising the maximum of ${MAX_CHILDREN_PER_PARENT} accounts`,
      );
    }
    await db
      .insert(schema.parentChildLinks)
      .values({ parentId: parent.id, childId, status: 'pending', initiatedBy: 'child' })
      .onConflictDoUpdate({
        target: [schema.parentChildLinks.parentId, schema.parentChildLinks.childId],
        set: {
          status: 'pending',
          initiatedBy: 'child',
          createdAt: new Date(),
          acceptedAt: null,
          revokedAt: null,
        },
      });
    return { status: 'pending' };
  }

  // No account with that email → invite them to sign up (needs email config).
  const { isEmailConfigured, sendParentLinkInvitationEmail } = await import('./email');
  if (!isEmailConfigured()) {
    throw errors.badRequest(
      "This server hasn't set up email, so a guardian who doesn't already have an account can't be invited by email. Ask them to create an account first.",
    );
  }
  const childName = await displayNameFor(childId);
  await sendParentLinkInvitationEmail({ to: email, childName }).catch(() => {
    // Never leak SMTP details; the child still sees a generic "sent" state.
  });
  return { status: 'awaiting_signup' };
}

/** Parent accepts a CHILD-initiated supervision request, activating it. */
export async function acceptChildInitiatedLink(parentId: bigint, childId: bigint) {
  // A minor can't accept a guardian role over another account.
  if (await isMinorUser(parentId)) {
    throw errors.forbidden('Minors cannot supervise other accounts');
  }
  await db.transaction(async (tx) => {
    // Serialize concurrent accepts (same rationale + deadlock-free lock order
    // as acceptLink) so the cap re-check and activation UPDATE are atomic.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`supchild:${childId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`supparent:${parentId}`}))`);

    const [activeParents, activeChildren] = await Promise.all([
      getActiveParentIds(childId),
      getActiveChildIds(parentId),
    ]);
    if (activeParents.length >= MAX_PARENTS_PER_CHILD) {
      throw errors.badRequest(
        `That account already has the maximum of ${MAX_PARENTS_PER_CHILD} guardians`,
      );
    }
    if (activeChildren.length >= MAX_CHILDREN_PER_PARENT) {
      throw errors.badRequest(`You can supervise up to ${MAX_CHILDREN_PER_PARENT} accounts`);
    }
    const updated = await tx
      .update(schema.parentChildLinks)
      .set({ status: 'active', acceptedAt: new Date() })
      .where(
        and(
          eq(schema.parentChildLinks.parentId, parentId),
          eq(schema.parentChildLinks.childId, childId),
          eq(schema.parentChildLinks.status, 'pending'),
          eq(schema.parentChildLinks.initiatedBy, 'child'),
        ),
      )
      .returning({ childId: schema.parentChildLinks.childId });
    if (updated.length === 0) throw errors.badRequest('No pending request from that account');
  });
  await ensureRestrictions(childId);
  // Same activation transition as acceptLink, parent-accepted direction.
  await notifySupervisionChanged(childId);
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

  // Ending a link flips the child's effective restrictions the other way — an
  // adult child is released outright, a 13–17 child drops to the unlinked
  // STRICT profile. Either way their device must stop using the old set now.
  // Audience is the child even when the PARENT removed the link (they're the
  // subject of the state that changed); the removing parent already has the
  // result in their own response.
  await notifySupervisionChanged(link.childId);
}

export async function ensureRestrictions(childId: bigint) {
  await db
    .insert(schema.childRestrictions)
    .values({ childId })
    .onConflictDoNothing({ target: schema.childRestrictions.childId });
}

/** Active parent ids for a child (usually 0 or 1, up to 2 guardians).
 *
 * 18+ release is computed HERE, on the fly: a link is ignored once the child
 * turns 18 (DOB <= today-18y), so every consumer of "who supervises this
 * child" — restrictions, E2EE, the parent's review access — sees the release
 * immediately, independent of the periodic sweep. A null DOB is treated as
 * still-supervised (we don't know the age, and the link was set up
 * deliberately). */
export async function getActiveParentIds(childId: bigint): Promise<bigint[]> {
  const cutoff = adultCutoffDob();
  const rows = await db
    .select({ parentId: schema.parentChildLinks.parentId })
    .from(schema.parentChildLinks)
    .innerJoin(schema.users, eq(schema.users.id, schema.parentChildLinks.childId))
    .where(
      and(
        eq(schema.parentChildLinks.childId, childId),
        eq(schema.parentChildLinks.status, 'active'),
        or(isNull(schema.users.dateOfBirth), gt(schema.users.dateOfBirth, cutoff)),
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
    const cutoff = adultCutoffDob();
    const rows = await db
      .select({
        parentId: schema.parentChildLinks.parentId,
        childId: schema.parentChildLinks.childId,
      })
      .from(schema.parentChildLinks)
      .innerJoin(schema.users, eq(schema.users.id, schema.parentChildLinks.childId))
      .where(
        and(
          eq(schema.parentChildLinks.status, 'active'),
          inArray(schema.parentChildLinks.childId, ids),
          // 18+ release on the fly (mirror getActiveParentIds) so a just-adult
          // user's DMs aren't kept plaintext by a stale link.
          or(isNull(schema.users.dateOfBirth), gt(schema.users.dateOfBirth, cutoff)),
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
  const myRestrictions = await getEffectiveRestrictions(userId);
  const [me] = await db
    .select({ dateOfBirth: schema.users.dateOfBirth, createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const asParent = await db
    .select({
      status: schema.parentChildLinks.status,
      initiatedBy: schema.parentChildLinks.initiatedBy,
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
      initiatedBy: schema.parentChildLinks.initiatedBy,
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

  // Age-driven minor state (server-computed so the client does no clock math).
  const now = new Date();
  const dob = me?.dateOfBirth ?? null;
  const minor = isMinorDob(dob, now);
  const hasActiveParent = asChild.some((r) => r.status === 'active');
  const createdMs = me ? now.getTime() - new Date(me.createdAt).getTime() : 0;
  const graceMs = MINOR_GRACE_DAYS * 86_400_000;
  const unlinkedMinor = minor && !hasActiveParent;
  // An unlinked minor is restricted immediately now (no grace enforcement).
  // graceDaysRemaining is kept purely informational — a soft "you have N days
  // before this is permanent"-style countdown the client may show — but it no
  // longer gates anything. graceActive stays false so clients don't render the
  // old "you're fine for now" state.
  const graceActive = false;
  const restrictedHeavily = unlinkedMinor;
  const graceDaysRemaining = unlinkedMinor
    ? Math.max(0, Math.ceil((graceMs - createdMs) / 86_400_000))
    : null;

  return {
    // The current user's own restrictions, if they're a supervised
    // child (null otherwise). Lets the client disable restricted
    // actions and offer the "ask your parent" path proactively.
    restrictions: myRestrictions ? toRestrictionsDTO(myRestrictions) : null,
    // Age-driven supervision state for the current user.
    isMinor: minor,
    graceActive,
    graceDaysRemaining,
    restrictedHeavily,
    // Children I supervise (active) + requests I sent that await the child.
    children: asParent
      .filter((r) => r.status === 'active')
      .map((r) => ({ ...r.child, id: String(r.child.id), since: r.createdAt })),
    outgoingRequests: asParent
      .filter((r) => r.status === 'pending' && r.initiatedBy === 'parent')
      .map((r) => ({ ...r.child, id: String(r.child.id) })),
    // Child-initiated requests awaiting MY (the parent's) acceptance.
    incomingChildRequests: asParent
      .filter((r) => r.status === 'pending' && r.initiatedBy === 'child')
      .map((r) => ({ ...r.child, id: String(r.child.id) })),
    // Parents supervising me (active) + parent-initiated requests awaiting me.
    supervisedBy: asChild
      .filter((r) => r.status === 'active')
      .map((r) => ({ ...r.parent, id: String(r.parent.id), since: r.createdAt })),
    incomingRequests: asChild
      .filter((r) => r.status === 'pending' && r.initiatedBy === 'parent')
      .map((r) => ({ ...r.parent, id: String(r.parent.id) })),
    // Parent invites I (the child) sent that await the parent's acceptance.
    outgoingParentRequests: asChild
      .filter((r) => r.status === 'pending' && r.initiatedBy === 'child')
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
  allowJoinGuilds: true,
  allowMessaging: true,
  // Friends-only by default for a supervised child; the parent can widen to
  // 'all' or tighten to 'none'.
  dmPolicy: 'friends' as string,
  // Mask swear words in the child's message views by default (parent can lift).
  filterProfanity: true,
};

/** The "restrict heavily" profile for a 13–17 account with NO guardian link.
    Everything off, no DMs — the only thing an unlinked minor can do is invite
    a guardian. Applied immediately on account creation (no grace window). */
const STRICT_RESTRICTIONS = {
  canAddFriends: false,
  canRemoveFriends: false,
  allowVoice: false,
  allowVideo: false,
  allowStream: false,
  allowCreateGuild: false,
  allowJoinGuilds: false,
  allowMessaging: false,
  dmPolicy: 'none' as string,
  // A locked-down unlinked minor also gets profanity masked.
  filterProfanity: true,
};

/**
 * THE restriction chokepoint. Every restriction gate (create-guild, add/remove
 * friend, voice/video/stream) calls this and only acts when it returns a row
 * with the relevant field false; `null` means "no restrictions". The age-driven
 * minor lifecycle is folded in here so all gates honor it with zero per-gate
 * logic:
 *
 *   - 18+ (DOB present, age >= 18)            → null   (fully released)
 *   - has an active parent link               → the parent's configured row
 *                                                (DEFAULTS until they set any)
 *   - no DOB (legacy account), unlinked       → null   (treated as adult)
 *   - 13–17, unlinked                         → STRICT (restrict heavily NOW)
 *
 * Unlinked minors are restricted IMMEDIATELY on account creation — no grace
 * window. The only thing they can do is invite a guardian (the supervision
 * routes aren't gated by this). The 30-day counter is now purely informational
 * (surfaced via the summary) — it no longer relaxes enforcement.
 */
export async function getEffectiveRestrictions(
  userId: bigint,
): Promise<typeof schema.childRestrictions.$inferSelect | null> {
  const [u] = await db
    .select({ dateOfBirth: schema.users.dateOfBirth, createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const now = new Date();
  const dob = u?.dateOfBirth ?? null;
  const age = dob ? ageOnDate(dob, now) : null;

  // 18+ → fully released regardless of any stale link/restriction row.
  if (age !== null && age >= ADULT_AGE) return null;

  // Linked → the parent's configured restrictions (defaults until they edit).
  const parents = await getActiveParentIds(userId);
  if (parents.length > 0) {
    const [row] = await db
      .select()
      .from(schema.childRestrictions)
      .where(eq(schema.childRestrictions.childId, userId))
      .limit(1);
    return row ?? { childId: userId, ...DEFAULT_RESTRICTIONS, updatedAt: new Date() };
  }

  // Unlinked from here.
  if (age === null) return null; // legacy account, no DOB → treat as adult
  // 13–17, unlinked → strict lockdown immediately (connect a guardian to lift).
  return { childId: userId, ...STRICT_RESTRICTIONS, updatedAt: new Date() };
}

/**
 * DM-policy gate for supervised minors — symmetric, so it protects the minor
 * whether they initiate the DM or receive it. Returns true if a DM between
 * `a` and `b` is BLOCKED by either side's supervision:
 *   - dmPolicy 'all'     → that side imposes no extra constraint
 *   - dmPolicy 'friends' → the two must be mutual friends
 *   - dmPolicy 'none'    → no DMs at all
 * The stricter of the two policies wins. Adults / unsupervised users get a null
 * restriction row and impose no constraint.
 */
export async function dmBlockedBySupervision(a: bigint, b: bigint): Promise<boolean> {
  if (a === b) return false;
  const [ra, rb] = await Promise.all([
    getEffectiveRestrictions(a),
    getEffectiveRestrictions(b),
  ]);
  const policies: string[] = [];
  if (ra) policies.push(ra.dmPolicy);
  if (rb) policies.push(rb.dmPolicy);
  if (policies.length === 0) return false;
  if (policies.includes('none')) return true;
  if (policies.includes('friends')) {
    const { areFriends } = await import('./relationships');
    if (!(await areFriends(a, b))) return true;
  }
  return false;
}

/**
 * Explicit field pick for the wire — NOT a spread of the row. Every reader
 * (parent GET, the child's own summary, and the FAMILY_SUPERVISION_UPDATE
 * frame) goes through here so a column added to child_restrictions can't
 * silently reach one surface and not the others, and so the three shapes
 * can't drift apart.
 */
type RestrictionRowLike = Omit<typeof schema.childRestrictions.$inferSelect, 'childId' | 'updatedAt'>;

function toRestrictionsDTO(r: RestrictionRowLike) {
  return {
    canAddFriends: r.canAddFriends,
    canRemoveFriends: r.canRemoveFriends,
    allowVoice: r.allowVoice,
    allowVideo: r.allowVideo,
    allowStream: r.allowStream,
    allowCreateGuild: r.allowCreateGuild,
    allowJoinGuilds: r.allowJoinGuilds,
    allowMessaging: r.allowMessaging,
    dmPolicy: r.dmPolicy,
    filterProfanity: r.filterProfanity,
  };
}

/** Parent-facing read of a child's restrictions (defaults if no row yet). */
export async function getRestrictions(childId: bigint) {
  const [row] = await db
    .select()
    .from(schema.childRestrictions)
    .where(eq(schema.childRestrictions.childId, childId))
    .limit(1);
  return toRestrictionsDTO(row ?? { childId, ...DEFAULT_RESTRICTIONS, updatedAt: new Date() });
}

/**
 * The subject's OWN supervision snapshot: the effective restrictions plus
 * the age/link state their client gates on. Everything here is already
 * visible to that user via GET /family/me, and NOTHING here identifies a
 * guardian — this DTO is what we push to the child, so it must never carry
 * parent-side data.
 */
export async function supervisionStateFor(userId: bigint) {
  const [effective, parents, blockedGuildIds, minor] = await Promise.all([
    getEffectiveRestrictions(userId),
    getActiveParentIds(userId),
    listBlockedGuildIds(userId),
    isMinorUser(userId),
  ]);
  return {
    restrictions: effective ? toRestrictionsDTO(effective) : null,
    supervised: parents.length > 0,
    isMinor: minor,
    // Mirrors supervisionSummary: an unlinked 13–17 account is locked down.
    restrictedHeavily: minor && parents.length === 0,
    blockedGuildIds,
  };
}

/**
 * Push the subject's supervision state to their own connections.
 *
 * Call this after ANY write that changes what that user may do: a guardian
 * editing restrictions, a link activating or ending, a server being
 * blocked/unblocked, the 18+ auto-release. Without it a connected device
 * keeps enforcing the restrictions it loaded at startup — a parent lifting
 * a DM/messaging restriction did nothing until the child cold-started the
 * app, which is the wrong latency for a parental control.
 *
 * Audience is the subject alone, so the guardian's own Family view is not
 * touched (and the child learns nothing new about the guardian).
 *
 * Best-effort: the write has already committed, so a bus/serialization
 * failure must not turn a successful mutation into an error response.
 */
export async function notifySupervisionChanged(userId: bigint): Promise<void> {
  try {
    dispatch.familySupervisionUpdate({
      childId: userId,
      state: await supervisionStateFor(userId),
    });
  } catch {
    /* best-effort */
  }
}

export type RestrictionPatch = Partial<{
  canAddFriends: boolean;
  canRemoveFriends: boolean;
  allowVoice: boolean;
  allowVideo: boolean;
  allowStream: boolean;
  allowCreateGuild: boolean;
  allowJoinGuilds: boolean;
  allowMessaging: boolean;
  dmPolicy: 'none' | 'friends' | 'all';
  filterProfanity: boolean;
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
  // Live-apply on the child's devices instead of at their next cold start.
  await notifySupervisionChanged(childId);
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
  // blockedGuildIds rides the same snapshot, so a block/unblock reaches the
  // child's UI as fast as a restriction change does.
  await notifySupervisionChanged(childId);
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
  const restr = await getEffectiveRestrictions(childId);
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
// Process-level cache of the ids of children under ACTIVE supervision. The
// per-message flag scan runs (fire-and-forget) on EVERY message send, so
// without this an instance with NO parental controls still paid 1 query per
// guild message and 2-3 per DM. The fast path below short-circuits when this
// set is empty (the common case) or doesn't contain the candidate. 15s TTL —
// a newly supervised child starts being scanned within that window.
let supervisedChildIdsCache: Set<bigint> | null = null;
let supervisedChildIdsCacheAt = 0;
const SUPERVISED_CACHE_MS = 15_000;

async function getSupervisedChildIds(): Promise<Set<bigint>> {
  if (supervisedChildIdsCache && Date.now() - supervisedChildIdsCacheAt < SUPERVISED_CACHE_MS) {
    return supervisedChildIdsCache;
  }
  let ids: Set<bigint>;
  try {
    const rows = await db
      .selectDistinct({ childId: schema.parentChildLinks.childId })
      .from(schema.parentChildLinks)
      .where(eq(schema.parentChildLinks.status, 'active'));
    ids = new Set(rows.map((r) => r.childId));
  } catch {
    // Table missing (migration not applied) → treat as no supervision active.
    ids = new Set();
  }
  supervisedChildIdsCache = ids;
  supervisedChildIdsCacheAt = Date.now();
  return ids;
}

export async function scanMessageForFlags(input: {
  messageId: bigint;
  channelId: bigint;
  channelType: string;
  authorId: bigint | null;
  content: string;
}): Promise<void> {
  const content = (input.content || '').toLowerCase();
  if (!content.trim() || !input.authorId) return;

  // Fast path: no children under active supervision → nothing to scan, zero
  // queries. (This is the steady state for most self-hosted instances.)
  const supervised = await getSupervisedChildIds();
  if (supervised.size === 0) return;

  const candidates: Array<{ childId: bigint; direction: 'sent' | 'received' }> = [
    { childId: input.authorId, direction: 'sent' },
  ];
  if (input.channelType === 'dm') {
    const { getOtherRecipient } = await import('./dms');
    const peer = await getOtherRecipient(input.channelId, input.authorId);
    if (peer) candidates.push({ childId: peer, direction: 'received' });
  }

  for (const cand of candidates) {
    if (!supervised.has(cand.childId)) continue; // not a supervised child
    const words = await watchWordsFor(cand.childId);
    if (words.length === 0) continue;
    const parents = await getActiveParentIds(cand.childId);
    if (parents.length === 0) continue; // not supervised (cache raced a revoke)
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
