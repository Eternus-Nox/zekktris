/**
 * Reactions service
 * -----------------
 * Reactions table is keyed (messageId, userId, emoji). Adding a reaction is
 * an idempotent insert; removing it is a delete. Listing aggregates by
 * emoji.
 *
 * Emoji values for v1 are strings: either raw unicode codepoints (e.g. "❤️")
 * or unified shortcodes (e.g. ":heart:"). Custom guild emoji aren't part of
 * v1 — when they land in v1.x they'll add an emoji_id column.
 *
 * Authorization (the caller can react / clear) is the route layer's job.
 */

import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';

const EMOJI_MAX_BYTES = 64;

function validateEmoji(emoji: string): void {
  // Reject empty or oversized — emoji strings shouldn't exceed a few bytes,
  // but a unicode flag plus modifiers can hit ~16. Cap at 64 to leave room.
  const len = Buffer.byteLength(emoji, 'utf8');
  if (len === 0 || len > EMOJI_MAX_BYTES) {
    throw errors.badRequest(`emoji must be 1..${EMOJI_MAX_BYTES} bytes`);
  }
}

export async function addReaction(
  messageId: bigint,
  userId: bigint,
  emoji: string,
): Promise<boolean> {
  validateEmoji(emoji);
  // Verify the message still exists (and isn't deleted) — a soft-deleted
  // message shouldn't accumulate new reactions. The deletedAt filter
  // was missing from the WHERE until this round; the comment promised
  // it but the predicate didn't enforce it. Clients normally don't
  // surface react UI for deleted messages, but a cached client (or a
  // determined attacker with the message id) could still POST.
  const m = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.id, messageId), isNull(schema.messages.deletedAt)))
    .limit(1);
  if (!m[0]) throw errors.notFound('Message');

  // .returning() returns rows for actually-inserted rows; on conflict
  // (user already reacted with this emoji) it's empty. Caller uses this
  // to decide whether to broadcast a REACTION_ADD event — silent no-ops
  // on the client matter because reaction aggregates only carry count+
  // self-flag (no per-user list to dedupe against).
  const inserted = await db
    .insert(schema.reactions)
    .values({ messageId, userId, emoji })
    .onConflictDoNothing()
    .returning({ id: schema.reactions.messageId });
  return inserted.length > 0;
}

export async function removeOwnReaction(
  messageId: bigint,
  userId: bigint,
  emoji: string,
): Promise<boolean> {
  validateEmoji(emoji);
  const deleted = await db
    .delete(schema.reactions)
    .where(
      and(
        eq(schema.reactions.messageId, messageId),
        eq(schema.reactions.userId, userId),
        eq(schema.reactions.emoji, emoji),
      ),
    )
    .returning({ id: schema.reactions.messageId });
  return deleted.length > 0;
}

/** Mod action — wipe one user's reaction with a specific emoji from a message. */
export async function removeUserReaction(
  messageId: bigint,
  targetUserId: bigint,
  emoji: string,
): Promise<void> {
  validateEmoji(emoji);
  await db
    .delete(schema.reactions)
    .where(
      and(
        eq(schema.reactions.messageId, messageId),
        eq(schema.reactions.userId, targetUserId),
        eq(schema.reactions.emoji, emoji),
      ),
    );
}

/** Mod action — wipe every reaction with a specific emoji from a message. */
export async function clearEmoji(messageId: bigint, emoji: string): Promise<void> {
  validateEmoji(emoji);
  await db
    .delete(schema.reactions)
    .where(and(eq(schema.reactions.messageId, messageId), eq(schema.reactions.emoji, emoji)));
}

/** Mod action — wipe ALL reactions from a message. */
export async function clearAll(messageId: bigint): Promise<void> {
  await db.delete(schema.reactions).where(eq(schema.reactions.messageId, messageId));
}

/** Aggregated reaction list for one message: per-emoji count + which users reacted. */
export interface ReactionAggregate {
  emoji: string;
  count: number;
  userIds: bigint[];
}

export async function aggregateReactions(messageId: bigint): Promise<ReactionAggregate[]> {
  const rows = await db
    .select()
    .from(schema.reactions)
    .where(eq(schema.reactions.messageId, messageId))
    .orderBy(asc(schema.reactions.createdAt));

  const byEmoji = new Map<string, ReactionAggregate>();
  for (const r of rows) {
    const existing = byEmoji.get(r.emoji);
    if (existing) {
      existing.count++;
      existing.userIds.push(r.userId);
    } else {
      byEmoji.set(r.emoji, { emoji: r.emoji, count: 1, userIds: [r.userId] });
    }
  }
  return Array.from(byEmoji.values());
}

/** Users who reacted to a message with a specific emoji, paginated by user id. */
export async function listReactingUsers(
  messageId: bigint,
  emoji: string,
  opts: { limit: number; after?: bigint },
): Promise<bigint[]> {
  validateEmoji(emoji);
  // Build the WHERE inline so `after` is applied BEFORE the LIMIT.
  // The previous implementation took the LIMIT first and filtered in
  // JS afterwards — which breaks for any message with more reactions
  // than the page size: the second page would slice into a window
  // that contains zero rows past `after` and return empty even
  // though more matching reactions exist further along.
  const whereClause =
    opts.after !== undefined
      ? and(
          eq(schema.reactions.messageId, messageId),
          eq(schema.reactions.emoji, emoji),
          gt(schema.reactions.userId, opts.after),
        )
      : and(
          eq(schema.reactions.messageId, messageId),
          eq(schema.reactions.emoji, emoji),
        );
  const rows = await db
    .select({ userId: schema.reactions.userId })
    .from(schema.reactions)
    .where(whereClause)
    .orderBy(asc(schema.reactions.userId))
    .limit(opts.limit);
  return rows.map((r) => r.userId);
}
