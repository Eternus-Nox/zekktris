/**
 * Scheduled messages service
 * --------------------------
 * Two surfaces:
 *
 *   1. User-facing CRUD: schedule a future send, list my pending,
 *      cancel one.
 *
 *   2. Worker interface: fetch-due, complete-on-success, fail-on-error.
 *      These run from `apps/api/src/workers/scheduledMessages.ts`
 *      every minute and reify scheduled rows as real messages.
 *
 * Permission model: we check "can the user post to this channel?"
 * AT SCHEDULE TIME. Permission can change in the gap between
 * scheduling and sending — if the user loses access (kicked from
 * guild, channel deleted, blocked by recipient), the worker fails
 * gracefully and bumps the attempt counter. After 3 failures the
 * row freezes and shows up in the user's list with an error tag,
 * letting them investigate.
 */

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { errors } from '../errors';

// Max retries before the worker stops trying a row. Matches the
// partial index predicate (attempts < 3) in migration 0046.
const MAX_ATTEMPTS = 3;
// How many due rows the worker processes per poll. Big enough to
// catch up after a brief outage, small enough that one poll can't
// monopolize the DB on a long backlog.
const POLL_BATCH = 50;
// Earliest scheduling delta. Anything sooner than this gets
// rejected at create time — "schedule for 1 minute from now" is
// pointless and creates a race with the poll cycle (the worker
// might fire before the row is fully committed). 60s gives the
// poll predictable behavior.
const MIN_DELAY_SECONDS = 60;
// Latest scheduling delta. One year out is more than any sensible
// user case; rejects accidental year-typos that would otherwise
// queue messages forever.
const MAX_DELAY_SECONDS = 365 * 24 * 60 * 60;

export interface CreateScheduledInput {
  authorId: bigint;
  channelId: bigint;
  content: string;
  attachments?: unknown[];
  replyToMessageId?: bigint | null;
  scheduledFor: Date;
}

export async function createScheduled(
  input: CreateScheduledInput,
): Promise<schema.ScheduledMessage> {
  const now = Date.now();
  const target = input.scheduledFor.getTime();
  if (!Number.isFinite(target)) {
    throw errors.badRequest('Invalid scheduledFor');
  }
  const delta = (target - now) / 1000;
  if (delta < MIN_DELAY_SECONDS) {
    throw errors.badRequest(
      `Scheduled time must be at least ${MIN_DELAY_SECONDS} seconds in the future`,
    );
  }
  if (delta > MAX_DELAY_SECONDS) {
    throw errors.badRequest(
      'Scheduled time must be within one year',
    );
  }
  const id = nextSnowflake();
  const [row] = await db
    .insert(schema.scheduledMessages)
    .values({
      id,
      authorId: input.authorId,
      channelId: input.channelId,
      content: input.content,
      attachmentsJson: input.attachments ?? [],
      replyToMessageId: input.replyToMessageId ?? null,
      scheduledFor: input.scheduledFor,
    })
    .returning();
  if (!row) throw errors.internal('Failed to schedule message');
  return row;
}

/**
 * List the caller's pending scheduled messages, soonest-first.
 * Includes failed-but-not-deleted rows so the user can see and
 * either retry (by deleting + rescheduling) or just delete them.
 */
export async function listForUser(
  authorId: bigint,
  opts?: { limit?: number },
): Promise<schema.ScheduledMessage[]> {
  const limit = Math.min(opts?.limit ?? 50, 200);
  return db
    .select()
    .from(schema.scheduledMessages)
    .where(eq(schema.scheduledMessages.authorId, authorId))
    .orderBy(asc(schema.scheduledMessages.scheduledFor))
    .limit(limit);
}

/**
 * Cancel a scheduled message. Idempotent — cancelling a row that's
 * already gone (worker beat us to it, or another tab cancelled
 * first) returns false without erroring.
 */
export async function cancelScheduled(
  scheduledId: bigint,
  authorId: bigint,
): Promise<boolean> {
  const result = await db
    .delete(schema.scheduledMessages)
    .where(
      and(
        eq(schema.scheduledMessages.id, scheduledId),
        eq(schema.scheduledMessages.authorId, authorId),
      ),
    )
    .returning({ id: schema.scheduledMessages.id });
  return result.length > 0;
}

// ── Worker interface ────────────────────────────────────────────────────

// A claim older than this is treated as abandoned (the worker that took it
// died mid-send) and may be reclaimed. Comfortably longer than a normal send.
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Atomically CLAIM up to POLL_BATCH due rows for sending and return them.
 *
 * Exactly-once under concurrency: the candidate ids are locked with
 * `FOR UPDATE SKIP LOCKED` (so two concurrent ticks / replicas never grab the
 * same row), and each claimed row is stamped with `claimed_at` — so a
 * *subsequent* tick skips it too (the row isn't deleted until the send
 * succeeds, which can be after the next poll). A claim older than
 * STALE_CLAIM_MS is reclaimable, so a worker that crashed mid-send doesn't
 * strand the row. The caller must finish each returned row with
 * completeScheduled (success → delete) or failScheduled (error → bump +
 * release the claim).
 */
export async function claimDue(): Promise<schema.ScheduledMessage[]> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const candidates = db
    .select({ id: schema.scheduledMessages.id })
    .from(schema.scheduledMessages)
    .where(
      and(
        lte(schema.scheduledMessages.scheduledFor, now),
        lt(schema.scheduledMessages.attempts, MAX_ATTEMPTS),
        or(
          isNull(schema.scheduledMessages.claimedAt),
          lt(schema.scheduledMessages.claimedAt, staleCutoff),
        ),
      ),
    )
    .orderBy(asc(schema.scheduledMessages.scheduledFor))
    .limit(POLL_BATCH)
    .for('update', { skipLocked: true });

  return db
    .update(schema.scheduledMessages)
    .set({ claimedAt: now })
    .where(inArray(schema.scheduledMessages.id, candidates))
    .returning();
}

/**
 * Worker calls this when a row was successfully turned into a
 * real message. Deletes the schedule entry.
 */
export async function completeScheduled(scheduledId: bigint): Promise<void> {
  await db
    .delete(schema.scheduledMessages)
    .where(eq(schema.scheduledMessages.id, scheduledId));
}

/**
 * Worker calls this when a send attempt failed. Bumps the attempts counter,
 * records the error, and RELEASES the claim (claimed_at → null) so the next
 * poll can retry — until attempts reaches MAX_ATTEMPTS, after which claimDue's
 * `attempts < MAX_ATTEMPTS` predicate excludes the row from future polls.
 */
export async function failScheduled(
  scheduledId: bigint,
  error: string,
): Promise<void> {
  await db
    .update(schema.scheduledMessages)
    .set({
      attempts: sql`${schema.scheduledMessages.attempts} + 1`,
      lastError: error.slice(0, 500),
      claimedAt: null,
    })
    .where(eq(schema.scheduledMessages.id, scheduledId));
}
