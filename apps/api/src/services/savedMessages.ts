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

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { hasPermission, Permissions } from '@zekktris/shared/permissions';
import * as channels from './channels';
import { notExpired } from './messages';
import { computeMemberChannelPermissions } from './permissions';

const PAGE_SIZE = 25;

/**
 * Can `userId` actually see the channel a message lives in? Mirrors the
 * message-route viewability gate (loadChannelContext): a GUILD channel
 * requires VIEW_CHANNEL; a DM/group-DM requires recipient membership.
 * Anything else (deleted/unknown channel type) is not viewable.
 *
 * Used both to gate saving (you may only bookmark a message you can read)
 * and to filter the saved list (access can be revoked AFTER a save — kicked
 * from the guild, channel made private, removed from a group DM — and a
 * bookmark must never become a back door to content you've lost access to).
 */
async function canViewChannelRow(
  userId: bigint,
  channel: typeof schema.channels.$inferSelect,
): Promise<boolean> {
  if (channel.guildId) {
    const perms = await computeMemberChannelPermissions(channel.id, userId, channel);
    return hasPermission(perms, Permissions.VIEW_CHANNEL);
  }
  if (channel.type === 'dm' || channel.type === 'group_dm') {
    const r = await db
      .select({ userId: schema.dmRecipients.userId })
      .from(schema.dmRecipients)
      .where(
        and(
          eq(schema.dmRecipients.channelId, channel.id),
          eq(schema.dmRecipients.userId, userId),
        ),
      )
      .limit(1);
    return r.length > 0;
  }
  return false;
}

export interface SavedListItem {
  message: typeof schema.messages.$inferSelect;
  savedAt: Date;
  channel: typeof schema.channels.$inferSelect | null;
}

export async function saveMessage(
  userId: bigint,
  messageId: bigint,
): Promise<{ created: boolean }> {
  // Viewability gate (IDOR fix). Without this, any authenticated user could
  // bookmark an arbitrary message by snowflake and then read its full content
  // back through GET /@me/saved — the save was a bare INSERT with no check
  // that the caller can see the target. Resolve the message → channel and
  // enforce the same visibility as the message routes before inserting.
  const msgRow = (
    await db
      .select({
        channelId: schema.messages.channelId,
        deletedAt: schema.messages.deletedAt,
        // A disappeared message (deadline passed, sweep not run yet) is gone.
        expired: sql<boolean>`NOT ${notExpired()}`,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1)
  )[0];
  if (!msgRow || msgRow.deletedAt || msgRow.expired) throw errors.notFound('Message');
  const channel = await channels.getChannel(msgRow.channelId);
  if (!channel || !(await canViewChannelRow(userId, channel))) {
    throw errors.notFound('Message');
  }

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
    // content. Same for a disappeared message whose sweep hasn't run yet.
    isNull(schema.messages.deletedAt),
    notExpired(),
  ];
  if (opts?.before) {
    // saved_at is a NOW()-stamped microsecond timestamptz, but the cursor came
    // back through a JS Date (millisecond precision), so a bare eq() on the
    // full-precision column would never match the truncated cursor and drop
    // same-millisecond saves at the page boundary. Truncate BOTH comparison
    // arms to ms so they align (same fix class as the DM call-record columns).
    conditions.push(
      or(
        sql`date_trunc('milliseconds', ${schema.savedMessages.savedAt}) < date_trunc('milliseconds', ${opts.before.savedAt.toISOString()}::timestamptz)`,
        and(
          sql`date_trunc('milliseconds', ${schema.savedMessages.savedAt}) = date_trunc('milliseconds', ${opts.before.savedAt.toISOString()}::timestamptz)`,
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
  const windowRows = hasMore ? rows.slice(0, limit) : rows;

  // Compute the keyset boundary from the last RAW row in the window, BEFORE
  // the viewability filter below. If a whole page filters out, pagination
  // must still advance past it — deriving the cursor from the filtered set
  // could go null on an all-hidden page and strand viewable rows beyond it.
  const boundary = windowRows[windowRows.length - 1];
  const nextCursor =
    hasMore && boundary
      ? `${boundary.savedAt.toISOString()}_${boundary.message.id.toString()}`
      : null;

  // Defense-in-depth: even a legitimately-saved message must be re-checked
  // for current viewability, because access can be revoked after the save
  // (kicked from the guild, channel turned private, removed from a group DM).
  // Drop any row the caller can no longer see.
  // Independent per-row permission checks — run them concurrently rather than
  // one sequential round-trip at a time. Index-mapped Promise.all + filter/map
  // preserves the exact rows, order, and DTO shape.
  const oks = await Promise.all(
    windowRows.map((r) =>
      r.channel ? canViewChannelRow(userId, r.channel) : Promise.resolve(false),
    ),
  );
  const items: SavedListItem[] = windowRows
    .filter((_, i) => oks[i])
    .map((r) => ({ savedAt: r.savedAt, message: r.message, channel: r.channel! }));

  return { items, nextCursor };
}
