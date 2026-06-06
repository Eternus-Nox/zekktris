/**
 * Read-state service
 * ------------------
 * The (user, channel) → last_message_id + mention_count table backs the
 * unread-channel UX. Two operations matter for v1:
 *
 *   • ack(userId, channelId, messageId)
 *       Mark a message as the user's new high-water-mark in that channel.
 *       Refuses to move the marker BACKWARDS — if the user acks an older
 *       message than what's already recorded, we treat the call as a no-op
 *       rather than rolling back. This mirrors Discord's behavior and
 *       avoids weird "I scrolled up and now everything looks unread" UX.
 *       Resets mention_count to 0 on every ack — even when the marker
 *       didn't move, an ack is the user explicitly saying "I've read this."
 *
 *   • listMy(userId)
 *       Return all read-state rows for a user. Used by the gateway during
 *       READY hydration so clients have the full picture from frame 1.
 *
 * Mention-count *increments* (when a new message mentions the user) are
 * NOT in this service yet — that's a follow-up that hooks into the
 * messages.create flow. The schema column is in place; ack still resets it,
 * so the storage path is end-to-end ready for the increment to land later.
 */

import { and, eq, gt, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';

export interface ReadStateRow {
  channelId: bigint;
  lastMessageId: bigint | null;
  mentionCount: number;
}

/**
 * Upsert the user's read marker for a channel. The new marker is only
 * persisted if it's >= the previous one; older acks are silently no-ops
 * (we still reset mention_count, since "I clicked into this channel" is
 * a clear-mentions intent).
 *
 * Verifies the message exists and belongs to the channel before persisting,
 * to prevent forging a marker that points at an unrelated message.
 */
export async function ack(
  userId: bigint,
  channelId: bigint,
  messageId: bigint,
): Promise<{ lastMessageId: bigint; mentionCount: number }> {
  // Sanity: message must exist and be in this channel.
  const m = await db
    .select({ id: schema.messages.id, channelId: schema.messages.channelId })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  const row = m[0];
  if (!row) throw errors.notFound('Message');
  if (row.channelId !== channelId) {
    throw errors.badRequest('Message does not belong to this channel');
  }

  // Upsert. The conflict target is the (userId, channelId) PK. The DO UPDATE
  // clause uses GREATEST() so an ack of an older message doesn't roll back
  // the marker. mention_count resets only when the marker actually
  // advances — an ack for an OLDER message would otherwise wipe the
  // user's mention count for newer-still-unread mentions even though
  // the marker stayed put, leaving them with no UI signal that
  // mentions are pending.
  //
  // Use .returning() to read the committed lastMessageId in the same
  // round-trip — the previous implementation issued a second SELECT
  // for the same row. Every channel-open paid both queries serially.
  const upserted = await db
    .insert(schema.readStates)
    .values({
      userId,
      channelId,
      lastMessageId: messageId,
      mentionCount: 0,
    })
    .onConflictDoUpdate({
      target: [schema.readStates.userId, schema.readStates.channelId],
      set: {
        // Snowflake IDs are monotonic, so a numeric GREATEST is correct.
        // EXCLUDED is the proposed row in PG's ON CONFLICT semantics.
        lastMessageId: sql`GREATEST(${schema.readStates.lastMessageId}, EXCLUDED.last_message_id)`,
        // Only reset the count when the marker actually moves
        // forward. An older ack keeps the count intact because the
        // mentions it would clear are still genuinely unread.
        mentionCount: sql`CASE WHEN EXCLUDED.last_message_id > ${schema.readStates.lastMessageId} THEN 0 ELSE ${schema.readStates.mentionCount} END`,
        updatedAt: new Date(),
      },
    })
    .returning({
      lastMessageId: schema.readStates.lastMessageId,
      mentionCount: schema.readStates.mentionCount,
    });

  const finalLast = upserted[0]?.lastMessageId ?? messageId;
  const finalMentions = upserted[0]?.mentionCount ?? 0;
  return { lastMessageId: finalLast, mentionCount: finalMentions };
}

/** All read states for a user. Used by READY hydration. */
export async function listMy(userId: bigint): Promise<ReadStateRow[]> {
  const rows = await db
    .select({
      channelId: schema.readStates.channelId,
      lastMessageId: schema.readStates.lastMessageId,
      mentionCount: schema.readStates.mentionCount,
    })
    .from(schema.readStates)
    .where(eq(schema.readStates.userId, userId));
  return rows;
}

/**
 * Zero out mention_count for every channel this user has a row in.
 * Used by the "Clear all mentions" affordance in the Mentions inbox.
 * Returns the rows that were actually touched (mention_count > 0
 * before the update) so the caller can dispatch per-channel
 * CHANNEL_ACK events and the client updates badges in one reducer
 * step rather than waiting for each channel's next visit.
 *
 * `lastMessageId` is preserved — the user's "where I left off"
 * marker is independent of the mention chip and the user might
 * still want unread-but-not-mentioned indicators for those channels.
 */
export async function clearAllMentions(
  userId: bigint,
): Promise<
  Array<{ channelId: bigint; lastMessageId: bigint | null; mentionCount: number }>
> {
  // Two operations run in parallel:
  //
  //   1. Zero the per-channel mention_count rows so the sidebar
  //      pill-badges go away. Returns the touched rows so the
  //      caller can dispatch per-channel CHANNEL_ACK events and
  //      the client updates badges in one reducer step rather
  //      than waiting for each channel's next visit.
  //
  //   2. **Hard-delete** every message_user_mentions row pointing
  //      at this user. This is the bit that actually makes Clear
  //      all stick across reloads — listUserMentions joins on
  //      this table to find mentions, so removing the rows makes
  //      them invisible to the inbox forever. Previously we relied
  //      on a `mentions_cleared_message_id` watermark column with
  //      a gt() filter; that was fragile in two ways:
  //
  //        (a) Postgres MAX() of a BIGINT column comes back as a
  //            string in node-postgres, and drizzle's type
  //            annotation doesn't trigger a runtime cast — so the
  //            watermark could end up stored as a string, making
  //            gt() do lexicographic comparison instead of
  //            numeric, which silently mis-filters.
  //
  //        (b) Any code path that read users.mentions_cleared_-
  //            message_id getting a null back (column missing on
  //            an unmigrated instance, transient connection issue,
  //            anything) would skip the filter entirely and the
  //            "cleared" mentions would reappear on the next
  //            fetch.
  //
  //      DELETE has neither failure mode. The rows are gone; the
  //      next listUserMentions query naturally returns nothing
  //      for the cleared messages because the inner join has no
  //      partner. The watermark column is now unused — left in
  //      place to avoid an extra migration churn but no longer
  //      written or read by anything in this code path.
  //
  // `lastMessageId` is preserved on the read_states rows — that's
  // the "where I left off reading" marker, independent of the
  // mention chip. Channels with new non-mention messages still
  // show the general unread indicator after this.
  const [updated] = await Promise.all([
    db
      .update(schema.readStates)
      .set({ mentionCount: 0, updatedAt: new Date() })
      .where(
        and(
          eq(schema.readStates.userId, userId),
          sql`${schema.readStates.mentionCount} > 0`,
        ),
      )
      .returning({
        channelId: schema.readStates.channelId,
        lastMessageId: schema.readStates.lastMessageId,
        mentionCount: schema.readStates.mentionCount,
      }),
    db
      .delete(schema.messageUserMentions)
      .where(eq(schema.messageUserMentions.userId, userId)),
  ]);

  return updated;
}

/**
 * Convenience: is `messageId` strictly newer than the user's marker for the
 * channel? Used by tests; the actual unread computation in the client is
 * channel.lastMessageId > readState.lastMessageId.
 */
export async function isUnread(
  userId: bigint,
  channelId: bigint,
  messageId: bigint,
): Promise<boolean> {
  const r = await db
    .select({ lastMessageId: schema.readStates.lastMessageId })
    .from(schema.readStates)
    .where(
      and(
        eq(schema.readStates.userId, userId),
        eq(schema.readStates.channelId, channelId),
        gt(schema.readStates.lastMessageId, messageId),
      ),
    )
    .limit(1);
  return r.length === 0;
}
