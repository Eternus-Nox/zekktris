/**
 * Relationships service
 * ---------------------
 * Friend requests, friendships, and blocks. Modelled as two-sided rows in
 * the `relationships` table:
 *
 *   - Friend request from A → B:
 *       (A, B, 'outgoing_request')
 *       (B, A, 'incoming_request')
 *   - On accept, both rows flip to 'friend'.
 *   - On reject/remove, both rows are deleted.
 *   - Block A → B:
 *       (A, B, 'blocked')
 *     plus we delete any inverse rows so a blocked user can't see prior
 *     friend status. The (B, A) row is NOT mirrored — only the blocker
 *     "remembers" the block in the row store. The blocked user just
 *     finds their actions silently failing.
 *
 * All write operations are transactional so partial states are
 * impossible — there's no point during a request/accept where one side
 * sees a stale relationship row.
 */

import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';

type RelType = 'outgoing_request' | 'incoming_request' | 'friend' | 'blocked';

/**
 * Look up a single relationship row by (user, target). Used as a
 * pre-check before mutations — most flows need to know whether a row
 * already exists with a specific type.
 */
async function getRow(userId: bigint, targetId: bigint) {
  const r = await db
    .select()
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.userId, userId),
        eq(schema.relationships.targetId, targetId),
      ),
    )
    .limit(1);
  return r[0] ?? null;
}

/**
 * Accepted-friend user ids for `userId`. The graph is symmetric (accept
 * flips BOTH rows to 'friend'), so the subject's own rows are sufficient.
 * Used by the gateway to fan a presence change out to friends who share no
 * guild and no DM channel — otherwise their status dot never updates live.
 * `type = 'friend'` inherently excludes blocked pairs (blockUser deletes the
 * friendship rows), so no blocked-pair leak.
 */
export async function listAcceptedFriendIds(userId: bigint): Promise<bigint[]> {
  const rows = await db
    .select({ targetId: schema.relationships.targetId })
    .from(schema.relationships)
    .where(and(eq(schema.relationships.userId, userId), eq(schema.relationships.type, 'friend')));
  return rows.map((r) => r.targetId);
}

/**
 * Send a friend request from `userId` to `targetId`. Idempotent — if
 * a row already exists, we resolve the conflict cleanly:
 *   - existing 'outgoing_request' → no-op (return existing)
 *   - existing 'incoming_request' → upgrade BOTH rows to 'friend' (the
 *     other side already requested us; this counts as accepting)
 *   - existing 'friend' → no-op
 *   - existing 'blocked' → reject (you can't friend someone you blocked)
 *   - inverse-side 'blocked' (target blocked you) → reject (you can't
 *     friend someone who blocked you)
 *
 * Cannot self-friend (returns BAD_REQUEST).
 */
export async function sendFriendRequest(userId: bigint, targetId: bigint): Promise<RelType> {
  if (userId === targetId) {
    throw errors.badRequest('Cannot friend yourself');
  }

  // Verify target exists AND isn't banned/deleted. Without the
  // banned/deleted filters, a request would persist in the
  // relationships table targeting a user who can no longer accept
  // it — clutter that the sender's outgoing-requests list would
  // surface indefinitely. NOT_FOUND fails closed cleanly without
  // leaking whether the user was banned vs. simply nonexistent.
  const targetRow = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, targetId),
        isNull(schema.users.bannedAt),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(1);
  if (!targetRow[0]) throw errors.notFound('User');

  // Independent point reads on the same table — fetch both directions
  // concurrently instead of one round-trip after the other.
  const [existing, inverse] = await Promise.all([
    getRow(userId, targetId),
    getRow(targetId, userId),
  ]);

  if (existing?.type === 'blocked') {
    throw errors.forbidden('Unblock this user before sending a friend request');
  }
  if (inverse?.type === 'blocked') {
    // Don't leak the block to the requester — pretend the user just
    // doesn't accept requests right now.
    throw errors.forbidden('This user is not accepting friend requests');
  }
  if (existing?.type === 'friend') return 'friend';
  if (existing?.type === 'outgoing_request') return 'outgoing_request';

  // The "you have an incoming request, sending one back accepts it" path.
  if (existing?.type === 'incoming_request') {
    await db.transaction(async (tx) => {
      // Same race-defense as acceptFriendRequest: the `type`
      // predicate prevents a concurrent block (which inserts
      // (target, self, 'blocked') in the opposite direction)
      // from being silently rewritten to 'friend' by this
      // transaction's second UPDATE.
      const updatedA = await tx
        .update(schema.relationships)
        .set({ type: 'friend' })
        .where(
          and(
            eq(schema.relationships.userId, userId),
            eq(schema.relationships.targetId, targetId),
            eq(schema.relationships.type, 'incoming_request'),
          ),
        )
        .returning({ userId: schema.relationships.userId });
      const updatedB = await tx
        .update(schema.relationships)
        .set({ type: 'friend' })
        .where(
          and(
            eq(schema.relationships.userId, targetId),
            eq(schema.relationships.targetId, userId),
            eq(schema.relationships.type, 'outgoing_request'),
          ),
        )
        .returning({ userId: schema.relationships.userId });
      if (updatedA.length === 0 || updatedB.length === 0) {
        throw errors.notFound('Friend request');
      }
    });
    return 'friend';
  }

  // Fresh request — insert the two-sided row pair atomically.
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.relationships)
        .values({ userId, targetId, type: 'outgoing_request' });
      await tx
        .insert(schema.relationships)
        .values({ userId: targetId, targetId: userId, type: 'incoming_request' });
    });
  } catch (err: unknown) {
    // Concurrent path: target user also sent a friend request to us
    // between our two SELECTs and our two INSERTs. The first INSERT
    // collides with their existing (target, self) row (or vice versa),
    // Postgres raises 23505, and the transaction rolls back. Re-read
    // the relationship and resolve the same way we'd handle the
    // "incoming request already exists" branch above: flip both
    // rows to 'friend'. If anything else is going on (block, FK
    // violation), bubble the error.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === '23505'
    ) {
      const replay = await getRow(userId, targetId);
      if (replay?.type === 'incoming_request') {
        await db.transaction(async (tx) => {
          await tx
            .update(schema.relationships)
            .set({ type: 'friend' })
            .where(
              and(
                eq(schema.relationships.userId, userId),
                eq(schema.relationships.targetId, targetId),
              ),
            );
          await tx
            .update(schema.relationships)
            .set({ type: 'friend' })
            .where(
              and(
                eq(schema.relationships.userId, targetId),
                eq(schema.relationships.targetId, userId),
              ),
            );
        });
        return 'friend';
      }
      if (replay?.type === 'friend') return 'friend';
      if (replay?.type === 'outgoing_request') return 'outgoing_request';
    }
    throw err;
  }
  return 'outgoing_request';
}

/**
 * Accept an incoming friend request. The acting user must hold the
 * `incoming_request` row; flips both sides to 'friend'.
 */
export async function acceptFriendRequest(userId: bigint, targetId: bigint): Promise<void> {
  const existing = await getRow(userId, targetId);
  if (!existing || existing.type !== 'incoming_request') {
    throw errors.notFound('Friend request');
  }
  await db.transaction(async (tx) => {
    // CRITICAL: the UPDATEs include a `type` predicate so we don't
    // overwrite a 'blocked' row that landed between our initial
    // SELECT and the transaction starting. Trace of the race we
    // defend against:
    //
    //   1. user A reads (A, B, 'incoming_request') — OK to accept
    //   2. user B calls blockUser(B, A)
    //      - deletes (B, A) row (B's outgoing_request to A)
    //      - deletes (A, B) row (A's incoming_request) — per #76
    //        only non-blocked types in the reverse direction are
    //        cleared, but request types ARE non-blocked
    //      - inserts (B, A, 'blocked')
    //   3. user A's transaction UPDATEs:
    //      - (A, B) → 0 rows (already deleted)
    //      - (B, A) → without the type filter, would rewrite the
    //        freshly-inserted 'blocked' row to 'friend'. With the
    //        filter, 0 rows because type='blocked' != 'outgoing_request'.
    //
    // If both UPDATEs no-op, the request is effectively gone (either
    // a block landed OR the requester revoked) — surface notFound so
    // the caller sees a clean failure instead of "success" with no
    // friendship to show for it.
    const updatedA = await tx
      .update(schema.relationships)
      .set({ type: 'friend' })
      .where(
        and(
          eq(schema.relationships.userId, userId),
          eq(schema.relationships.targetId, targetId),
          eq(schema.relationships.type, 'incoming_request'),
        ),
      )
      .returning({ userId: schema.relationships.userId });
    const updatedB = await tx
      .update(schema.relationships)
      .set({ type: 'friend' })
      .where(
        and(
          eq(schema.relationships.userId, targetId),
          eq(schema.relationships.targetId, userId),
          eq(schema.relationships.type, 'outgoing_request'),
        ),
      )
      .returning({ userId: schema.relationships.userId });
    if (updatedA.length === 0 || updatedB.length === 0) {
      throw errors.notFound('Friend request');
    }
  });
  // Both sides are now 'friend' — either may cross a social_circle tier.
  // Throttled + best-effort, for both users.
  void import('./achievements')
    .then((m) => {
      m.syncAndNotifyAchievementsThrottled(userId);
      m.syncAndNotifyAchievementsThrottled(targetId);
    })
    .catch(() => {});
}

/**
 * Remove a friendship, decline an incoming request, or cancel an
 * outgoing one. Single endpoint because the action from the user's POV
 * is identical: "I don't want this relationship". Both row sides are
 * deleted. No-op if no relationship exists.
 *
 * Does NOT touch 'blocked' rows — those are removed by `unblock`. This
 * separation prevents accidentally unblocking someone via the friend
 * UI.
 */
export async function removeFriendOrRequest(userId: bigint, targetId: bigint): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.relationships)
      .where(
        and(
          eq(schema.relationships.userId, userId),
          eq(schema.relationships.targetId, targetId),
          inArray(schema.relationships.type, [
            'outgoing_request',
            'incoming_request',
            'friend',
          ]),
        ),
      );
    await tx
      .delete(schema.relationships)
      .where(
        and(
          eq(schema.relationships.userId, targetId),
          eq(schema.relationships.targetId, userId),
          inArray(schema.relationships.type, [
            'outgoing_request',
            'incoming_request',
            'friend',
          ]),
        ),
      );
  });
}

/**
 * Block a user. Atomically:
 *   - Delete any existing relationship rows in either direction (friend,
 *     pending request — nothing should remain that grants the blocked
 *     user any social signal).
 *   - Insert (userId, targetId, 'blocked').
 *
 * Idempotent — already-blocked is a no-op.
 */
export async function blockUser(userId: bigint, targetId: bigint): Promise<void> {
  if (userId === targetId) {
    throw errors.badRequest('Cannot block yourself');
  }
  const targetRow = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, targetId))
    .limit(1);
  if (!targetRow[0]) throw errors.notFound('User');

  await db.transaction(async (tx) => {
    // Wipe our own prior state with this target — any type, since
    // we're about to insert a fresh 'blocked' row in the same slot.
    await tx
      .delete(schema.relationships)
      .where(
        and(
          eq(schema.relationships.userId, userId),
          eq(schema.relationships.targetId, targetId),
        ),
      );
    // Wipe the target's reverse-direction state — but ONLY for
    // non-blocked types (friendship halves, pending requests, etc).
    // We must NOT delete (targetId, userId, 'blocked') because that
    // row is the OTHER party's protective choice; us blocking them
    // doesn't invalidate their independent block of us. Wiping it
    // would silently strip their privacy decision (e.g. A blocked
    // B for harassment → B then blocks A → A's block disappears).
    await tx
      .delete(schema.relationships)
      .where(
        and(
          eq(schema.relationships.userId, targetId),
          eq(schema.relationships.targetId, userId),
          ne(schema.relationships.type, 'blocked'),
        ),
      );
    await tx
      .insert(schema.relationships)
      .values({ userId, targetId, type: 'blocked' });
  });
}

/**
 * Unblock a user. Removes only the (userId, targetId, 'blocked') row.
 * Does not auto-friend; the user has to send a fresh request if they
 * want to reconnect.
 */
export async function unblockUser(userId: bigint, targetId: bigint): Promise<void> {
  await db
    .delete(schema.relationships)
    .where(
      and(
        eq(schema.relationships.userId, userId),
        eq(schema.relationships.targetId, targetId),
        eq(schema.relationships.type, 'blocked'),
      ),
    );
}

/**
 * List every relationship the user has, with the joined target user
 * profile so the client can render names + avatars without a second
 * call. Returned shape distinguishes the four types so the UI can
 * group them ("Friends", "Pending", "Blocked").
 *
 * `'incoming_request'` rows surface separately from `'outgoing_request'`
 * because the actions available are different (accept/reject vs cancel).
 */
export async function listRelationships(userId: bigint) {
  const rows = await db
    .select({
      type: schema.relationships.type,
      createdAt: schema.relationships.createdAt,
      target: {
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        status: schema.users.status,
        customStatus: schema.users.customStatus,
      },
    })
    .from(schema.relationships)
    .innerJoin(schema.users, eq(schema.users.id, schema.relationships.targetId))
    .where(
      and(
        eq(schema.relationships.userId, userId),
        // Filter soft-deleted target users. Without this, a friend
        // who deletes their account stays in your friends list
        // with stale data and a dead-user click target. Banned
        // users are deliberately KEPT — they're still real users,
        // and a block against a banned account should keep
        // showing so the blocker has continuity if the ban is
        // lifted.
        isNull(schema.users.deletedAt),
      ),
    )
    .orderBy(sql`${schema.relationships.createdAt} desc`);
  return rows;
}

/**
 * Check whether the actor has blocked the target, OR vice versa. Both
 * directions matter for visibility — if either side blocks, neither
 * sees the other's actions. Returns the FIRST blocked row found
 * (caller usually only needs the boolean).
 */
export async function isBlockedEitherWay(
  actorId: bigint,
  otherId: bigint,
): Promise<boolean> {
  const r = await db
    .select({ userId: schema.relationships.userId })
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.type, 'blocked'),
        or(
          and(
            eq(schema.relationships.userId, actorId),
            eq(schema.relationships.targetId, otherId),
          ),
          and(
            eq(schema.relationships.userId, otherId),
            eq(schema.relationships.targetId, actorId),
          ),
        ),
      ),
    )
    .limit(1);
  return r.length > 0;
}

/**
 * Are `a` and `b` mutual friends? Both sides keep a 'friend' row in sync
 * (accept/decline updates both), so reading one side is authoritative.
 * Used by the supervision DM-policy gate (friends-only minors).
 */
export async function areFriends(a: bigint, b: bigint): Promise<boolean> {
  if (a === b) return false;
  const row = await db
    .select({ type: schema.relationships.type })
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.userId, a),
        eq(schema.relationships.targetId, b),
        eq(schema.relationships.type, 'friend'),
      ),
    )
    .limit(1);
  return row.length > 0;
}

/**
 * Privacy policy check for DM creation + 1:1 voice ringing.
 *
 * Returns true iff `senderId` is allowed to initiate a DM with or ring
 * `recipientId` under the recipient's current privacy settings.
 *
 * Policy:
 *   1. Blocks (either direction) always deny.
 *   2. Mutual friend (both rows = 'friend') always allows.
 *   3. If recipient has `allowDmsFromServerMembers = true`, sharing
 *      at least one guild with the sender allows.
 *   4. Otherwise deny.
 *
 * The recipient's existing DM history is NOT a license — the policy
 * gates new outbound contact, but a DM that's already open continues
 * to function (the channel row is shared and the policy doesn't get
 * re-evaluated on each message). Flipping the toggle to friends-only
 * locks down NEW conversations without retroactively breaking ongoing
 * ones.
 *
 * Self-to-self always returns true so the existing self-DM check in
 * getOrCreateDM (which rejects with a clearer error) is unchanged.
 */
export async function canReachByDmOrCall(
  senderId: bigint,
  recipientId: bigint,
): Promise<boolean> {
  if (senderId === recipientId) return true;

  if (await isBlockedEitherWay(senderId, recipientId)) return false;

  // Mutual friend? Both rows must be of type 'friend' (so one-sided
  // outgoing_request doesn't count). Reading the row from the
  // sender's side is enough — accept/decline keeps both rows in sync.
  const friendRow = await db
    .select({ type: schema.relationships.type })
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.userId, senderId),
        eq(schema.relationships.targetId, recipientId),
        eq(schema.relationships.type, 'friend'),
      ),
    )
    .limit(1);
  if (friendRow.length > 0) return true;

  // Recipient's privacy toggle. If they've opened up to server
  // members, check whether sender + recipient share at least one
  // guild via guild_members.
  const recipient = await db
    .select({
      allowDmsFromServerMembers: schema.users.allowDmsFromServerMembers,
    })
    .from(schema.users)
    .where(eq(schema.users.id, recipientId))
    .limit(1);
  const recipientRow = recipient[0];
  if (!recipientRow || !recipientRow.allowDmsFromServerMembers) {
    return false;
  }

  // Find a guild that both users are members of. We only need to know
  // whether such a guild exists — limit 1 + projection on guildId.
  const shared = await db
    .select({ guildId: schema.guildMembers.guildId })
    .from(schema.guildMembers)
    .where(
      and(
        eq(schema.guildMembers.userId, senderId),
        inArray(
          schema.guildMembers.guildId,
          db
            .select({ guildId: schema.guildMembers.guildId })
            .from(schema.guildMembers)
            .where(eq(schema.guildMembers.userId, recipientId)),
        ),
      ),
    )
    .limit(1);

  return shared.length > 0;
}

