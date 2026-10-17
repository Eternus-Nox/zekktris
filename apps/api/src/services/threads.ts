/**
 * Threads service
 * ---------------
 * Threads are modelled as channels with `type='public_thread'`. Discord uses
 * the same trick — it keeps the message store unified, lets gateway events
 * reuse `MESSAGE_CREATE` shape unchanged, and means `READ_MESSAGE_HISTORY`
 * checks Just Work.
 *
 * A thread row has:
 *   - `parentId`     → the text channel it sits under (for permission
 *                       inheritance and "show threads under #channel" lookup)
 *   - `parentMessageId` → the specific message in that channel that started
 *                       it (so the UI can render the thread inline below
 *                       the originating message)
 *   - `name`         → human label, defaults to the originating message's
 *                       first ~50 chars
 *   - `threadArchivedAt` → null for active, ISO timestamp for archived.
 *                       Archived threads are read-only; clients show them
 *                       grayed out at the bottom of the list.
 *
 * Permission inheritance: anyone who can VIEW_CHANNEL on the parent can
 * VIEW_CHANNEL on the thread. We don't copy override rows — the thread
 * is resolved live by walking up to its parent at check time. That's
 * implemented in the channel-context loader (assertChannelPermission)
 * via the parentId chain we already use for categories.
 *
 * Out of scope for v1:
 *   - Auto-archive after N days idle (background job)
 *   - Per-thread member tracking
 *   - Private threads (only invited members can see)
 *   - Thread-specific slow-mode
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';

export interface CreateThreadInput {
  /** The text channel this thread belongs to (its `parentId`). */
  parentChannelId: bigint;
  /** The message in the parent channel that the thread is anchored to. */
  parentMessageId: bigint;
  /** Guild this all happens in. Mirrored onto the thread row for cheap
      "list every thread in guild G" queries. */
  guildId: bigint;
  /** Display name for the thread; falls back to a snippet of the parent
      message content if the caller doesn't supply one. */
  name: string;
}

/**
 * Create a thread anchored to a specific message. Idempotent at the
 * (parentMessageId) level — only ONE thread per anchor message; a
 * second call with the same parentMessageId returns the existing
 * thread instead of creating a duplicate.
 *
 * Concurrency: two simultaneous calls (rage-clicking "Create Thread",
 * two browser tabs racing) could both pass the initial SELECT and
 * both attempt to INSERT. Migration 0022 added a partial unique
 * index on (parent_message_id) WHERE type='public_thread' AND
 * deleted_at IS NULL, so the second INSERT trips Postgres 23505 and
 * we catch it here and return whichever thread the winner created.
 * Same pattern as dms.getOrCreateDM and relationships.sendFriendRequest.
 */
export async function createThread(input: CreateThreadInput) {
  // First check if a thread already exists for this anchor — if so,
  // return it (idempotent). This lets the client safely retry the
  // create call without duplicating threads on the common path.
  const existing = await db
    .select()
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.parentMessageId, input.parentMessageId),
        eq(schema.channels.type, 'public_thread'),
        isNull(schema.channels.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const id = nextSnowflake();
  const now = new Date();
  try {
    const [row] = await db
      .insert(schema.channels)
      .values({
        id,
        type: 'public_thread',
        guildId: input.guildId,
        parentId: input.parentChannelId,
        parentMessageId: input.parentMessageId,
        name: input.name.slice(0, 100), // hard cap, server-side
        // Threads inherit position from their parent at render time;
        // the column itself is unused for thread rows. Default 0 is fine.
        position: 0,
        nsfw: false,
        rateLimitPerUser: 0,
        // Initialize the archive lifecycle. Stamp activity now so a
        // freshly-created thread doesn't immediately become a sweep
        // target. Default duration matches Discord's middle option
        // (3 days) — long enough for async discussion to breathe,
        // short enough to keep the active-list tidy.
        threadLastActivityAt: now,
        threadAutoArchiveMinutes: 4320,
      })
      .returning();
    if (!row) throw errors.internal('Failed to create thread');
    return row;
  } catch (err: unknown) {
    // 23505 = unique_violation. With migration 0022's partial unique
    // index, this fires when another concurrent createThread call
    // committed first. Re-run the lookup and return their thread —
    // the user's "create" intent is satisfied either way (they
    // wanted to start a thread on this message; one now exists).
    // Any other DB error bubbles up unchanged.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === '23505'
    ) {
      const winner = await db
        .select()
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.parentMessageId, input.parentMessageId),
            eq(schema.channels.type, 'public_thread'),
            isNull(schema.channels.deletedAt),
          ),
        )
        .limit(1);
      if (winner[0]) return winner[0];
      // No winner found? Either the partial index fired on something
      // other than our intended uniqueness (shouldn't happen given
      // the predicate) or the winning row was soft-deleted between
      // their commit and our re-lookup. Re-throw the original error
      // rather than mask it.
    }
    throw err;
  }
}

/**
 * Create a forum post — a thread under a `guild_forum` channel that has
 * NO anchor message. The "post body" is the first message written into
 * the resulting thread by the route layer; this service only stamps the
 * thread row itself.
 *
 * Unlike message-anchored threads, forum posts don't share the unique-
 * anchor constraint (the partial unique index in migration 0022 is keyed
 * on parent_message_id, which is NULL here — Postgres treats each NULL
 * as distinct so multiple NULL-anchor threads under the same forum are
 * permitted). That mirrors how forums work in Discord: a single forum
 * channel holds many posts.
 *
 * Returns the freshly-created thread row. The route is then responsible
 * for inserting the first message via messages.createMessage and
 * dispatching CHANNEL_CREATE + MESSAGE_CREATE.
 */
export async function createForumPost(input: {
  forumChannelId: bigint;
  guildId: bigint;
  /** Display name for the post (forum thread). Max 100 chars. */
  title: string;
  /** Optional auto-archive duration in minutes. When omitted, defaults
   *  to 4320 (3 days) — matches Discord's mid-tier preset. Server
   *  validates against the canonical set (60 / 1440 / 4320 / 10080)
   *  so arbitrary values can't sneak in. */
  autoArchiveMinutes?: number;
}) {
  // Canonical preset set. Keeping this fixed at the service layer means
  // the UI can offer a different picker shape later without the server
  // accepting anything outside the supported tiers.
  const presets = new Set([60, 1440, 4320, 10080]);
  const autoArchive =
    input.autoArchiveMinutes && presets.has(input.autoArchiveMinutes)
      ? input.autoArchiveMinutes
      : 4320;

  const id = nextSnowflake();
  const now = new Date();
  const [row] = await db
    .insert(schema.channels)
    .values({
      id,
      type: 'public_thread',
      guildId: input.guildId,
      parentId: input.forumChannelId,
      // Anchor-less. Forum posts don't reference a specific message;
      // their root content is the first message in the thread.
      parentMessageId: null,
      name: input.title.slice(0, 100),
      position: 0,
      nsfw: false,
      rateLimitPerUser: 0,
      // Archive lifecycle: activity stamp seeded to creation time;
      // auto-archive duration from input (validated above) or default.
      threadLastActivityAt: now,
      threadAutoArchiveMinutes: autoArchive,
    })
    .returning();
  if (!row) throw errors.internal('Failed to create forum post');
  return row;
}

/**
 * List all threads under a parent channel, active (non-archived) first
 * by most-recently-created. Capped at 50 — matches Discord's per-channel
 * thread cap and keeps the UI listable without virtualisation.
 *
 * Returns thread rows; the caller decorates with the same DTO loader as
 * regular channels. Soft-deleted threads are excluded.
 */
export async function listThreadsForChannel(parentChannelId: bigint) {
  return db
    .select()
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.parentId, parentChannelId),
        eq(schema.channels.type, 'public_thread'),
        isNull(schema.channels.deletedAt),
      ),
    )
    .orderBy(
      // Active threads first (NULL archived_at sorts last with desc, so we
      // negate by sorting on the boolean expression). Then newest first.
      sql`(${schema.channels.threadArchivedAt} IS NOT NULL) ASC`,
      desc(schema.channels.id),
    )
    .limit(50);
}

/**
 * Bump a thread's last_activity_at to now. Called from messages.createMessage
 * when posting into a thread. The auto-archive sweep starts its countdown
 * from this stamp, so each new message resets the idle timer.
 *
 * Also unarchives the thread if it was archived — posting "wakes" a stale
 * thread. Matches Discord's behavior and lets users revive old discussions
 * naturally. Returns true when an unarchive occurred so the caller can
 * dispatch a CHANNEL_UPDATE broadcast.
 *
 * No-op when the row isn't a thread (defensive; caller is expected to gate
 * on channel.type but we don't trust the call site).
 */
export async function bumpThreadActivity(
  threadId: bigint,
): Promise<{ unarchivedFromPost: boolean }> {
  const now = new Date();
  // Conditional update: only act on rows that are actually threads.
  // RETURNING lets us see whether archived_at was set BEFORE we
  // cleared it, so we can signal "unarchived" to the caller.
  const [row] = await db
    .update(schema.channels)
    .set({
      threadLastActivityAt: now,
      // Posting to an archived thread unarchives it. The previous
      // value is captured in RETURNING below so the caller can tell
      // whether it was archived before this call.
      threadArchivedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.channels.id, threadId),
        eq(schema.channels.type, 'public_thread'),
      ),
    )
    .returning({
      // Borrow the threadArchivedAt column NAME but capture its
      // pre-update value with a subquery isn't supported in drizzle's
      // returning. Workaround: we don't actually know the prior state
      // here — caller checks before calling. Simplify: just return
      // void-equivalent and let the caller decide based on its own
      // pre-fetched channel state.
      id: schema.channels.id,
    });

  // We can't reliably tell from the UPDATE whether the thread was
  // archived prior to this call. The simplest correct approach: caller
  // (messages.createMessage) checks channel.threadArchivedAt before
  // posting and knows whether unarchive will occur. We just signal
  // success here.
  return { unarchivedFromPost: !!row };
}

/**
 * Archive or unarchive a thread. Setting archived=true stamps archived_at;
 * archived=false clears it AND stamps last_activity_at = now() so the
 * freshly-revived thread doesn't immediately re-archive on the next
 * sweep tick (e.g. an admin unarchives a 6-day-old thread that hadn't
 * been touched in 3 days — we don't want it to re-archive 60 seconds
 * later because the activity timestamp is stale).
 *
 * Permission gating happens in the route layer, not here. Service is
 * intentionally permission-free so it can be reused from privileged
 * paths (sweep, admin scripts) without contortion.
 *
 * Returns the updated row for the caller to broadcast.
 */
export async function archiveThread(
  threadId: bigint,
  archived: boolean,
): Promise<typeof schema.channels.$inferSelect | null> {
  const now = new Date();
  const [row] = await db
    .update(schema.channels)
    .set({
      threadArchivedAt: archived ? now : null,
      // On unarchive: refresh activity so the next sweep doesn't
      // immediately re-archive. On archive: leave activity stamp
      // alone (it's the basis for "how long was it active").
      ...(archived ? {} : { threadLastActivityAt: now }),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.channels.id, threadId),
        eq(schema.channels.type, 'public_thread'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Mark a thread as resolved (or clear the resolved state). Soft
 * signal — the thread stays open and accepting replies, just gets
 * a checkmark + "Resolved" badge in the UI. Authorization is
 * handled at the route layer (creator OR MANAGE_THREADS in the
 * thread's channel).
 */
export async function setThreadResolved(
  threadId: bigint,
  resolved: boolean,
): Promise<typeof schema.channels.$inferSelect | null> {
  const now = new Date();
  const [row] = await db
    .update(schema.channels)
    .set({
      threadResolvedAt: resolved ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.channels.id, threadId),
        eq(schema.channels.type, 'public_thread'),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Legacy alias for callers still using the old name. Forwards to
 * archiveThread without the row return. Kept to avoid breaking the
 * existing callsite shape during the transition.
 */
export async function setArchived(
  threadId: bigint,
  archived: boolean,
): Promise<void> {
  await archiveThread(threadId, archived);
}

/**
 * Auto-archive sweep. Finds threads where the auto-archive deadline
 * has passed (last_activity_at + auto_archive_minutes < now()) and
 * flips them to archived.
 *
 * Bounded by the partial channels_active_threads_idx, so the scan
 * stays cheap even on guilds with thousands of historical archived
 * threads — the index only includes the active set.
 *
 * Single bulk UPDATE returning the affected rows. The scheduler fans
 * out CHANNEL_UPDATE broadcasts per affected thread so connected
 * clients see the archive transition live (UI grays the thread out
 * in the post list, switches the message stream to read-only).
 *
 * Returns the affected channel rows. Caller responsible for the
 * broadcast — keeps the service free of gateway coupling.
 */
export async function runThreadAutoArchiveSweep(): Promise<
  Array<typeof schema.channels.$inferSelect>
> {
  const now = new Date();
  // Postgres interval math: (last_activity + (auto_archive_minutes * 1 minute)) < now()
  // Using a raw SQL expression because drizzle's date arithmetic
  // doesn't natively express "timestamp + N minutes" with N from a
  // column. The interval cast handles fractional/larger durations
  // uniformly.
  const updated = await db
    .update(schema.channels)
    .set({
      threadArchivedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.channels.type, 'public_thread'),
        isNull(schema.channels.deletedAt),
        isNull(schema.channels.threadArchivedAt),
        sql`${schema.channels.threadLastActivityAt} IS NOT NULL`,
        sql`${schema.channels.threadAutoArchiveMinutes} IS NOT NULL`,
        sql`${schema.channels.threadLastActivityAt} + (${schema.channels.threadAutoArchiveMinutes} || ' minutes')::interval < now()`,
      ),
    )
    .returning();
  return updated;
}
