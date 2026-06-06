/**
 * DM messaging streaks
 * --------------------
 * A streak day is credited when BOTH participants of a 1:1 DM message
 * within the same UTC calendar day; consecutive credited days build the
 * streak (display-capped at 10,000). Only timestamps are used — content is
 * never read, so E2EE conversations participate fully.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db';

const CAP = 10_000;

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function prevUtcDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDay(d);
}

/** Record a message from `authorId` in a 1:1 DM and update the streak. */
export async function recordDmMessage(args: {
  channelId: bigint;
  authorId: bigint;
  recipientId: bigint;
}): Promise<void> {
  const today = utcDay();
  const [a, b] = args.authorId < args.recipientId
    ? [args.authorId, args.recipientId]
    : [args.recipientId, args.authorId];
  const authorIsA = args.authorId === a;

  const [row] = await db
    .select()
    .from(schema.dmStreaks)
    .where(eq(schema.dmStreaks.channelId, args.channelId))
    .limit(1);

  let lastDayA = row?.lastDayA ?? null;
  let lastDayB = row?.lastDayB ?? null;
  let lastCountedDay = row?.lastCountedDay ?? null;
  let streak = row?.streak ?? 0;
  let bestStreak = row?.bestStreak ?? 0;

  if (authorIsA) lastDayA = today;
  else lastDayB = today;

  // Credit today once both sides have messaged today.
  if (lastDayA === today && lastDayB === today && lastCountedDay !== today) {
    if (lastCountedDay === prevUtcDay(today)) {
      streak = Math.min(streak + 1, CAP);
    } else {
      streak = 1; // chain broken (or first ever day) — restart
    }
    lastCountedDay = today;
    bestStreak = Math.max(bestStreak, streak);
  }

  await db
    .insert(schema.dmStreaks)
    .values({
      channelId: args.channelId,
      userAId: a,
      userBId: b,
      lastDayA,
      lastDayB,
      lastCountedDay,
      streak,
      bestStreak,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.dmStreaks.channelId,
      set: { lastDayA, lastDayB, lastCountedDay, streak, bestStreak, updatedAt: new Date() },
    });
}

/**
 * Display streak for a set of DM channels: the stored value while the
 * chain is alive (credited today or yesterday), else 0.
 */
export async function streaksForChannels(channelIds: bigint[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (channelIds.length === 0) return out;
  const { inArray } = await import('drizzle-orm');
  const rows = await db
    .select()
    .from(schema.dmStreaks)
    .where(inArray(schema.dmStreaks.channelId, channelIds));
  const today = utcDay();
  const yesterday = prevUtcDay(today);
  for (const r of rows) {
    const alive = r.lastCountedDay === today || r.lastCountedDay === yesterday;
    out.set(r.channelId.toString(), alive ? Math.min(r.streak, CAP) : 0);
  }
  return out;
}

/** Longest live-or-historical streak the user has ever held (achievements). */
export async function bestStreakForUser(userId: bigint): Promise<number> {
  const { or, eq: eqOp } = await import('drizzle-orm');
  const rows = await db
    .select({ best: schema.dmStreaks.bestStreak })
    .from(schema.dmStreaks)
    .where(or(eqOp(schema.dmStreaks.userAId, userId), eqOp(schema.dmStreaks.userBId, userId)));
  return rows.reduce((m, r) => Math.max(m, r.best), 0);
}
