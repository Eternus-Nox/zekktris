/**
 * Instance-wide MUTE (Admin → Account Info). Same shape as the instance ban
 * (services/instanceBans.ts), but milder: a muted account can still sign in and
 * read everything — it just can't post or talk.
 *
 *   muted_at set, muted_until NULL      → permanent mute
 *   muted_at set, muted_until > now     → timed mute (lapses on its own)
 *   muted_at set, muted_until <= now    → expired (treated as not-muted)
 *
 * No sweeper: a mute is only ever consulted at a write, and `isCurrentlyMuted`
 * treats an expired one as lifted, so stale columns are harmless. Unmute (or a
 * fresh mute) overwrites them.
 *
 * WHERE IT IS ENFORCED — `assertNotInstanceMuted` is called on every path that
 * lets an account say something: message send / edit, threads, forum posts,
 * scheduled messages, poll votes, reactions, pokes. Voice is covered at the
 * token: a muted account gets a non-publishing LiveKit grant (services/voice,
 * services/stage), and muting evicts it from any call it is already in.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';

export type MuteDuration = '1h' | '1d' | '1w' | 'perm';

const HOUR_MS = 60 * 60 * 1000;

/** Resolve a mute duration to its `muted_until` value (null = permanent). */
export function muteExpiryFor(duration: MuteDuration, from = new Date()): Date | null {
  switch (duration) {
    case 'perm':
      return null;
    case '1h':
      return new Date(from.getTime() + HOUR_MS);
    case '1d':
      return new Date(from.getTime() + 24 * HOUR_MS);
    case '1w':
      return new Date(from.getTime() + 7 * 24 * HOUR_MS);
  }
}

/** Whether a mute row is CURRENTLY in force (an expired timed mute is not). */
export function isCurrentlyMuted(
  row: { mutedAt: Date | null; mutedUntil: Date | null },
  now = new Date(),
): boolean {
  if (row.mutedAt === null) return false;
  return row.mutedUntil === null || row.mutedUntil > now;
}

/**
 * The account's current mute, or null. One primary-key read — the same order
 * of cost as the supervision check every send already pays. Deliberately not
 * cached: an unmute must take effect on the very next message, and a cache
 * would need invalidating across API processes to guarantee that.
 */
export async function getInstanceMute(userId: bigint): Promise<{ until: Date | null } | null> {
  const [row] = await db
    .select({ mutedAt: schema.users.mutedAt, mutedUntil: schema.users.mutedUntil })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row || !isCurrentlyMuted(row)) return null;
  return { until: row.mutedUntil };
}

/** Throw INSTANCE_MUTED if the account is muted. Call on every "say something" path. */
export async function assertNotInstanceMuted(userId: bigint): Promise<void> {
  const mute = await getInstanceMute(userId);
  if (mute) throw errors.instanceMuted(mute.until);
}
