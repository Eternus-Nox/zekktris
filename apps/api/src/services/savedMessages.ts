/**
 * Saved-messages service
 * ----------------------
 * CRUD for the per-user message bookmarks. Each row in
 * `saved_messages` represents one (user, message) save.
 *
 * Idempotency: the composite PK gives us "no duplicate saves" at
 * the storage layer. Trying to save the same message twice is
 * caught by an ON CONFLICT DO NOTHING and returns success without
 * inserting a duplicate row. This keeps the API contract simple —
 * the client can re-fire the save button safely (e.g. an optimistic
 * UI that bounces back) without worrying about 409 noise.
 */

import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db, schema } from '../db';

const PAGE_SIZE = 25;

export interface SavedListItem {
  message: typeof schema.messages.$inferSelect;
  savedAt: Date;
  channel: typeof schema.channels.$inferSelect | null;
}

export async function saveMessage(
  userId: bigint,
  messageId: bigint,
): Promise<{ created: boolean }> {
  const result = await db
    .insert(schema.savedMessages)
    .values({ userId, messageId })
    .onConflictDoNothing()
    .returning({ userId: schema.savedMessages.userId });
  return { created: result.length > 0 };
}

export async function unsaveMessage(
  userId: bigint,
  messageId: bigint,
): Promise<{ removed: boolean }> {
  const result = await db
    .delete(schema.savedMessages)
    .where(
      and(
        eq(schema.savedMessages.userId, userId),
        eq(schema.savedMessages.messageId, messageId),
      ),
    )
    .returning({ userId: schema.savedMessages.userId });
  return { removed: result.length > 0 };
}

/**
 * Is this specific message saved by this user? Cheap — single
 * indexed lookup on the (user_id, message_id) PK. Used by the
 * client to decide whether to render the bookmark icon as
 * filled or hollow on a per-message basis.
 */
export async function isSaved(
  userId: bigint,
  messageId: bigint,
): Promise<boolean> {
  const row = await db
    .select({ userId: schema.savedMessages.userId })
    .from(schema.savedMessages)
    .where(
      and(
        eq(schema.savedMessages.userId, userId),
        eq(schema.savedMessages.messageId, messageId),
      ),
    )
    .limit(1);
  return row.length > 0;
}

/**
 * Bulk membership check. Returns the subset of `messageIds` that
 * this user has saved. Used on initial channel load so we can
 * mark all currently-saved messages in one query rather than
 * N+1 isSaved calls.
 */
export async function listSavedAmong(
  userId: bigint,
  messageIds: bigint[],
): Promise<Set<bigint>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .select({ messageId: schema.savedMessages.messageId })
    .from(schema.savedMessages)
    .where(
      and(
        eq(schema.savedMessages.userId, userId),
        inArray(schema.savedMessages.messageId, messageIds),
      ),
    );
  return new Set(rows.map((r) => r.messageId));
}

/**
 * Paginated list of saved messages, newest save first. Keyset pagination
 * on the COMPOSITE (savedAt, messageId): savedAt alone isn't unique (a
 * bulk "save several" lands on identical timestamps), and a boundary
 * inside a same-timestamp cluster would silently drop every remaining
 * row at that timestamp. The cursor encodes both as
 * `<iso-savedAt>_<messageId>`; a bare ISO cursor (older clients /
 * in-flight pages) still parses and behaves like the old timestamp-only
 * boundary.
 */
export async function listSavedMessages(
  userId: bigint,
  opts?: { before?: { savedAt: Date; messageId: bigint }; limit?: number },
): Promise<{ items: SavedListItem[]; nextCursor: string | null }> {
  const limit = Math.min(opts?.limit ?? PAGE_SIZE, 100);

  const conditions = [
    eq(schema.savedMessages.userId, userId),
    // Saved-then-deleted messages must tombstone like every other read
    // path; without this the bookmark list kept serving full deleted
    // content.
    isNull(schema.messages.deletedAt),
  ];
  if (opts?.before) {
    conditions.push(
      or(
        lt(schema.savedMessages.savedAt, opts.before.savedAt),
        and(
          eq(schema.savedMessages.savedAt, opts.before.savedAt),
          lt(schema.savedMessages.messageId, opts.before.messageId),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      savedAt: schema.savedMessages.savedAt,
      message: schema.messages,
      channel: schema.channels,
    })
    .from(schema.savedMessages)
    .innerJoin(
      schema.messages,
      eq(schema.messages.id, schema.savedMessages.messageId),
    )
    .leftJoin(
      schema.channels,
      eq(schema.channels.id, schema.messages.channelId),
    )
    .where(and(...conditions))
    .orderBy(desc(schema.savedMessages.savedAt), desc(schema.savedMessages.messageId))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    savedAt: r.savedAt,
    message: r.message,
    channel: r.channel,
  }));
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? `${last.savedAt.toISOString()}_${last.message.id.toString()}` : null;

  return { items, nextCursor };
}
