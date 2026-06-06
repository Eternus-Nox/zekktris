/**
 * Account inactivity sweep
 * ------------------------
 * Background job that hard-deletes user accounts inactive for more
 * than INACTIVITY_TTL_DAYS days. "Active" is defined as the user
 * having any non-revoked session whose lastUsedAt is recent — that
 * timestamp is bumped by the refresh-token rotation, which fires
 * every time the user has the app open and an access token expires
 * (every ~15 minutes).
 *
 * Edge cases:
 *   - Users with no sessions at all (created account but never
 *     logged in): fall back to users.createdAt for the cutoff. A
 *     dormant signup never used is still expired after the same
 *     window — keeps stale registrations from accumulating.
 *   - Users currently in the middle of a session: their session row
 *     was bumped on the last refresh, so they're protected.
 *
 * Cascading effects (all already wired in the schema's FKs):
 *   - sessions, guildMembers, memberRoles, dmRecipients, channelOverrides,
 *     readStates, relationships, pushSubscriptions, signupCodes:
 *     ON DELETE CASCADE — cleaned up automatically
 *   - messages.authorId: ON DELETE SET NULL — message history preserved
 *     with a tombstoned author so channel scrollback doesn't gap
 *   - guilds.ownerId: ON DELETE SET NULL — orphaned guilds remain
 *     until a server admin/operator transfers or deletes them
 *
 * Operator override: setting INACTIVITY_TTL_DAYS=0 in env disables the
 * sweep entirely (no rows are touched). Setting a smaller value (e.g.
 * 30) speeds up the cycle for self-hosted instances with stricter
 * retention policies.
 *
 * The actual cron-like scheduling is in the API server's bootstrap;
 * this module exposes a single sweep() function that the scheduler
 * calls. We don't manage timers here.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { log } from '../log';

/** Result shape for telemetry / log lines. */
export interface SweepResult {
  /** Cutoff timestamp used for this sweep. Anything older is deleted. */
  cutoff: Date;
  /** Number of user rows hard-deleted by the sweep. */
  deleted: number;
  /** ms wall-clock duration of the sweep. */
  durationMs: number;
}

/**
 * Run a single inactivity sweep. Idempotent — running it twice in
 * quick succession will return zero on the second pass because the
 * eligible users from the first pass are gone. Safe to call from
 * any context (boot, on-demand admin endpoint, scheduled timer).
 */
export async function sweepInactiveAccounts(): Promise<SweepResult> {
  const start = Date.now();
  const ttlDays = env.INACTIVITY_TTL_DAYS;
  // Honored disable: zero or negative = sweep is off.
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    return { cutoff: new Date(0), deleted: 0, durationMs: Date.now() - start };
  }
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

  // We compute eligibility in a single query that covers two cases:
  //   (a) The user has at least one session row, and the most recent
  //       sessions.lastUsedAt is older than the cutoff (regardless of
  //       revoked state — a revoked session still represents past
  //       activity). Users with only revoked sessions whose last-used
  //       is recent stay protected; that's the conservative default.
  //   (b) The user has no session rows at all, and their users.createdAt
  //       is older than the cutoff.
  // The MAX over an outer-join handles (a) and (b) uniformly: missing
  // sessions yield NULL, and we COALESCE with createdAt so the cutoff
  // applies cleanly.
  //
  // We also exclude:
  //   - already soft-deleted users (deletedAt not null) — they're
  //     scheduled for hard-delete via a different path
  //   - instance admins (is_admin = true). Operators commonly
  //     maintain long-lived backup admin accounts for recovery; the
  //     default TTL of 365 days would silently destroy these. The
  //     check is belt-and-suspenders against operator misconfig.
  //   - guild owners (referenced by guilds.owner_id). The FK has
  //     ON DELETE RESTRICT, so attempting to delete an owner raises
  //     a constraint violation that rolls back the ENTIRE chunk
  //     (500 ids). One inactive owner shouldn't block 499 other
  //     eligible deletes. The FK remains the real protection; this
  //     filter just avoids the noisy batch failure.
  const candidates = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .leftJoin(schema.sessions, eq(schema.sessions.userId, schema.users.id))
    .where(
      and(
        isNull(schema.users.deletedAt),
        eq(schema.users.isAdmin, false),
        sql`${schema.users.id} NOT IN (SELECT ${schema.guilds.ownerId} FROM ${schema.guilds})`,
      ),
    )
    .groupBy(schema.users.id, schema.users.createdAt)
    .having(
      sql`COALESCE(MAX(${schema.sessions.lastUsedAt}), ${schema.users.createdAt}) < ${cutoff.toISOString()}`,
    );

  if (candidates.length === 0) {
    return { cutoff, deleted: 0, durationMs: Date.now() - start };
  }

  // Hard-delete in chunks. Single statement per chunk so the cascade
  // executes within one transaction; we don't need an explicit BEGIN
  // because each statement is already its own transaction.
  // Chunk size is conservative — 500 ids at a time keeps the IN list
  // manageable and avoids long-held locks on the users table.
  const ids = candidates.map((r) => r.id);
  let deleted = 0;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const r = await db
      .delete(schema.users)
      .where(sql`${schema.users.id} IN (${sql.join(chunk, sql`, `)})`)
      .returning({ id: schema.users.id });
    deleted += r.length;
  }

  const durationMs = Date.now() - start;
  log.info('inactivity sweep complete', {
    ttlDays,
    cutoff: cutoff.toISOString(),
    candidates: candidates.length,
    deleted,
    durationMs,
  });


  return { cutoff, deleted, durationMs };
}
