/**
 * Instance ban helpers (Admin → Users). An instance ban sets users.banned_at
 * and — for a TIMED ban — users.banned_until. Both text and voice are covered:
 * the ban handler revokes sessions, evicts from all voice, drops push subs, and
 * closes gateway sockets.
 *
 *   banned_at set, banned_until NULL      → permanent ban
 *   banned_at set, banned_until > now     → timed ban (auto-lifts)
 *   banned_at set, banned_until <= now    → expired (treated as not-banned;
 *                                           cleared by the sweep)
 */

import { and, isNotNull, lte } from 'drizzle-orm';
import { db, schema } from '../db';

/** How long each ban duration lasts, in whole months. 'perm' → no expiry. */
export type BanDuration = '1m' | '3m' | '6m' | 'perm';

/** Resolve a ban duration to its `banned_until` value (null = permanent). */
export function banExpiryFor(duration: BanDuration, from = new Date()): Date | null {
  if (duration === 'perm') return null;
  const months = duration === '1m' ? 1 : duration === '3m' ? 3 : 6;
  // UTC month arithmetic so the expiry is deterministic regardless of the
  // server's local timezone / DST (setMonth would shift the hour across a DST
  // boundary).
  const until = new Date(from);
  until.setUTCMonth(until.getUTCMonth() + months);
  return until;
}

/**
 * Whether an account is CURRENTLY banned. A timed ban whose banned_until has
 * passed is NOT banned even before the sweep clears the columns — so an expired
 * ban never blocks login for up to an hour waiting on the sweep.
 */
export function isCurrentlyBanned(
  row: { bannedAt: Date | null; bannedUntil: Date | null },
  now = new Date(),
): boolean {
  if (row.bannedAt === null) return false;
  return row.bannedUntil === null || row.bannedUntil > now;
}

/**
 * Auto-unban sweep: clear expired timed bans (banned_until <= now). Hourly,
 * error-isolated like the other maintenance sweeps. Returns the count lifted.
 */
export async function sweepExpiredInstanceBans(): Promise<number> {
  const lifted = await db
    .update(schema.users)
    .set({ bannedAt: null, bannedUntil: null, updatedAt: new Date() })
    .where(and(isNotNull(schema.users.bannedUntil), lte(schema.users.bannedUntil, new Date())))
    .returning({ id: schema.users.id });
  return lifted.length;
}
