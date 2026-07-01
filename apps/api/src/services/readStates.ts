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

import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '@zekktris/db';
import { db, schema } from '../db';
import { errors } from '../errors';

/** Accepts either the pooled db or a transaction handle. */
type DbHandle = Omit<Database, '$client'>;

export interface ReadStateRow {
  channelId: bigint;
  lastMessageId: bigint | null;
  mentionCount: number;
}

/**
 * Seed read-states for a user who just joined a guild: mark every channel that
 * already has messages as read up to its current latest. A new member thus
 * joins with a CLEAN slate — no wall of unread badges for history that predates
 * them — while still being able to scroll up to the full history (the message
 * list is no longer join-floor clamped). Runs inside the join transaction so
 * it commits atomically with the membership row. Idempotent: a re-join keeps
 * any existing marker (ON CONFLICT DO NOTHING), so unread accrued before a
 * previous leave isn't wiped.
 */
export async function seedGuildReadOnJoin(
  exec: DbHandle,
  guildId: bigint,
  userId: bigint,
): Promise<void> {
  await exec.execute(sql`
    INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count, updated_at)
    SELECT ${userId}, c.id, c.last_message_id, 0, now()
    FROM channels c
    WHERE c.guild_id = ${guildId} AND c.last_message_id IS NOT NULL
    ON CONFLICT (user_id, channel_id) DO NOTHING
  `);
}

/**
 * Increment the mention badge for a set of users in a channel — used for
 * @everyone fan-out (direct @user mentions are bumped inline in
 * messages.createMessage). Upsert because a recipient may have no read_state
 * row yet (INSERT with mentionCount=1 + NULL marker = "all unread"). The caller
 * is responsible for excluding the author and scoping to the channel audience.
 */
export async function bumpMentions(channelId: bigint, userIds: bigint[]): Promise<void> {
  if (userIds.length === 0) return;
  await db
    .insert(schema.readStates)
    .values(
      userIds.map((userId) => ({
        userId,
        channelId,
        lastMessageId: null,
        mentionCount: 1,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.readStates.userId, schema.readStates.channelId],
      set: {
        mentionCount: sql`${schema.readStates.mentionCount} + 1`,
        updatedAt: new Date(),
      },
    });
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
  // Sanity: message must exist and be in this channel. deletedAt is
  // deliberately NOT filtered here: clients ack the newest message as it
  // arrives, so "ack a message that was just deleted" is a routine race —
  // rejecting it would 404 a legitimate read. A tombstone id is a perfectly
  // good watermark (unread math only compares snowflake ordering), and the
  // channel-membership check below still blocks forged cross-channel markers.
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
        // NULL guard: rows created by the mention-increment path
        // (createMessage) start with last_message_id = NULL, and
        // `EXCLUDED.last_message_id > NULL` is NULL — without the
        // IS NULL arm the first ack would advance the marker but
        // leave the stale mention badge stuck forever.
        mentionCount: sql`CASE WHEN ${schema.readStates.lastMessageId} IS NULL OR EXCLUDED.last_message_id > ${schema.readStates.lastMessageId} THEN 0 ELSE ${schema.readStates.mentionCount} END`,
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

/**
 * Mark an entire guild read: advance the user's read marker to each
 * channel's current latest message and zero its mention count. The caller
 * passes the channel ids the user may VIEW (so we never seed a read row for a
 * hidden channel), and we only touch channels that actually have messages
 * (last_message_id IS NOT NULL). GREATEST-guarded like ack() so a marker is
 * never rolled backward. Returns the touched rows so the route can dispatch a
 * CHANNEL_ACK per channel (multi-device badge reconcile) and the caller can
 * update local state without a refetch.
 */
export async function markGuildRead(
  userId: bigint,
  viewableChannelIds: bigint[],
): Promise<Array<{ channelId: bigint; lastMessageId: bigint | null; mentionCount: number }>> {
  if (viewableChannelIds.length === 0) return [];
  const channels = await db
    .select({ id: schema.channels.id, lastMessageId: schema.channels.lastMessageId })
    .from(schema.channels)
    .where(
      and(
        inArray(schema.channels.id, viewableChannelIds),
        isNotNull(schema.channels.lastMessageId),
      ),
    );
  if (channels.length === 0) return [];
  const updated = await db
    .insert(schema.readStates)
    .values(
      channels.map((ch) => ({
        userId,
        channelId: ch.id,
        lastMessageId: ch.lastMessageId,
        mentionCount: 0,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.readStates.userId, schema.readStates.channelId],
      set: {
        // Never roll a marker backward (a channel whose row is already at or
        // past its current latest stays put); always clear the mention badge.
        lastMessageId: sql`GREATEST(${schema.readStates.lastMessageId}, EXCLUDED.last_message_id)`,
        mentionCount: 0,
        updatedAt: new Date(),
      },
    })
    .returning({
      channelId: schema.readStates.channelId,
      lastMessageId: schema.readStates.lastMessageId,
      mentionCount: schema.readStates.mentionCount,
    });
  return updated;
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
 * Total "unread" counts for the given users' iOS app-icon badges: per user,
 * unread DM conversations + total pending mention count. A DM is unread when
 * the channel's latest message is newer than the user's read marker (the same
 * rule the clients use for the unread dot — DMs don't bump mention_count);
 * guild pings accumulate in read_states.mention_count. Used to set APNs
 * `aps.badge` on message pushes so the home-screen icon reflects unread while
 * the app is closed.
 *
 * BULK by user id — the push fan-out resolves many recipients at once, so this
 * mirrors the other per-recipient lookups there (resolveLevelsBulk,
 * getDmNotificationPrefsForChannel): two grouped aggregates total, not two per
 * recipient. A DM that's both unread AND carries an explicit @mention is
 * counted in both (negligible; the client recomputes the exact number on next
 * foreground). Users with no unread are simply absent from the map (caller
 * defaults to 0).
 */
export async function unreadBadgeCounts(userIds: bigint[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;

  const dmUnread = db
    .select({ userId: schema.dmRecipients.userId, n: sql<number>`count(*)::int` })
    .from(schema.dmRecipients)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.dmRecipients.channelId))
    .leftJoin(
      schema.readStates,
      and(
        eq(schema.readStates.channelId, schema.channels.id),
        eq(schema.readStates.userId, schema.dmRecipients.userId),
      ),
    )
    .where(
      and(
        inArray(schema.dmRecipients.userId, userIds),
        isNotNull(schema.channels.lastMessageId),
        isNull(schema.channels.deletedAt),
        sql`(${schema.readStates.lastMessageId} IS NULL OR ${schema.channels.lastMessageId} > ${schema.readStates.lastMessageId})`,
      ),
    )
    .groupBy(schema.dmRecipients.userId);

  const mentionSum = db
    .select({
      userId: schema.readStates.userId,
      n: sql<number>`coalesce(sum(${schema.readStates.mentionCount}), 0)::int`,
    })
    .from(schema.readStates)
    .where(inArray(schema.readStates.userId, userIds))
    .groupBy(schema.readStates.userId);

  const [dmRows, mentionRows] = await Promise.all([dmUnread, mentionSum]);
  for (const r of dmRows) out.set(r.userId.toString(), (out.get(r.userId.toString()) ?? 0) + (r.n ?? 0));
  for (const r of mentionRows) {
    out.set(r.userId.toString(), (out.get(r.userId.toString()) ?? 0) + (r.n ?? 0));
  }
  return out;
}
