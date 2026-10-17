/**
 * Perk tiers — Scout / Guardian / Legend
 * --------------------------------------
 * The entitlement chokepoint for perk tiers. There are no payments: everyone
 * gets the whole app (cosmetics included), and a tier is a label an admin
 * hands out that unlocks extra perks — higher streaming quality and upload
 * caps, configured in services/monetization. A tier also shows its title on
 * the profile popup (unless the user opted out via
 * users.show_subscription_tier).
 *
 * Grant path: admin give (1/3/6 months or forever). The paid ('stripe') rows
 * left over from before payments were removed (2026-10-02) became forever
 * gifts in migration 0129; nothing writes that source any more.
 *
 * Family pass-down: a supervising parent's tier covers their supervised
 * children AT READ TIME (getEffectiveSubscription) — no child rows are
 * written, so the child's entitlement tracks link/tier changes live and
 * ends automatically when the link ends (18th birthday auto-release included).
 */

import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';

export type Tier = 'scout' | 'guardian' | 'legend';
export const TIERS: Tier[] = ['scout', 'guardian', 'legend'];
const TIER_RANK: Record<string, number> = { scout: 1, guardian: 2, legend: 3 };

/** Gift durations an admin can grant. 'forever' = expiresAt NULL. */
export type GiftDuration = '1m' | '3m' | '6m' | 'forever';
const DURATION_MONTHS: Record<Exclude<GiftDuration, 'forever'>, number> = {
  '1m': 1,
  '3m': 3,
  '6m': 6,
};

export interface EffectiveSubscription {
  tier: Tier;
  /** null = unlimited/forever. */
  expiresAt: Date | null;
  /** True when the membership is inherited from a supervising parent. */
  inherited: boolean;
  /** Whether the tier TITLE shows. Founder (grandfathered) memberships carry
      the perks but no title — titles are for supporters who chose a tier
      (paid or admin-gifted). */
  titled: boolean;
  /** Where the membership came from: 'gift' | 'founder'. */
  source: string;
}

/** WHERE clause for an active (unexpired) subscription row. */
function activeWhere() {
  return or(isNull(schema.subscriptions.expiresAt), gt(schema.subscriptions.expiresAt, new Date()));
}

/** The user's OWN active membership row, or null. */
export async function getOwnSubscription(userId: bigint) {
  const [row] = await db
    .select()
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.userId, userId), activeWhere()))
    .limit(1);
  return row ?? null;
}

/**
 * THE entitlement read: the user's own active membership, or the best one
 * inherited from a supervising parent (highest tier wins when multiple
 * guardians hold tiers). Null = no tier → base perks only.
 */
export async function getEffectiveSubscription(
  userId: bigint,
): Promise<EffectiveSubscription | null> {
  const own = await getOwnSubscription(userId);
  if (own) {
    return {
      tier: (own.tier as Tier) ?? 'scout',
      expiresAt: own.expiresAt,
      inherited: false,
      titled: own.source !== 'founder',
      source: own.source,
    };
  }

  // Parent pass-down. getActiveParentIds already excludes ended links and
  // bakes in the 18+ auto-release, so inheritance ends exactly when
  // supervision does.
  const supervision = await import('./supervision');
  const parents = await supervision.getActiveParentIds(userId);
  if (parents.length === 0) return null;

  let best: EffectiveSubscription | null = null;
  for (const pid of parents) {
    const sub = await getOwnSubscription(pid);
    if (!sub) continue;
    const tier = (sub.tier as Tier) ?? 'scout';
    if (!best || (TIER_RANK[tier] ?? 0) > (TIER_RANK[best.tier] ?? 0)) {
      best = {
        tier,
        expiresAt: sub.expiresAt,
        inherited: true,
        titled: sub.source !== 'founder',
        source: sub.source,
      };
    }
  }
  return best;
}

/** Whether the user holds any tier (own or inherited). */
export async function hasMembership(userId: bigint): Promise<boolean> {
  return (await getEffectiveSubscription(userId)) !== null;
}

/**
 * Admin grant: upsert the user's membership at `tier` for `duration`
 * (1m/3m/6m from NOW, or forever). Re-gifting overwrites the previous row —
 * an admin can extend, shorten, or retier with the same call.
 */
export async function giftSubscription(
  adminId: bigint,
  userId: bigint,
  tier: Tier,
  duration: GiftDuration,
) {
  const [target] = await db
    .select({ id: schema.users.id, isBot: schema.users.isBot })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .limit(1);
  if (!target) throw errors.notFound('User');
  if (target.isBot) throw errors.badRequest('Bots cannot hold memberships');

  const expiresAt =
    duration === 'forever'
      ? null
      : new Date(Date.now() + DURATION_MONTHS[duration] * 30 * 86_400_000);
  const [row] = await db
    .insert(schema.subscriptions)
    .values({
      userId,
      tier,
      source: 'gift',
      giftedBy: adminId,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: schema.subscriptions.userId,
      set: {
        tier,
        source: 'gift',
        giftedBy: adminId,
        expiresAt,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/**
 * Admin remove: drop the user's tier. Idempotent. Cosmetics are free, so the
 * user keeps their frame, tag and theme.
 */
export async function removeSubscription(userId: bigint): Promise<void> {
  await db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
}

/**
 * Daily hygiene sweep: timed tiers that lapsed get their rows deleted.
 * Cosmetics are free, so nothing else changes for the user. Users whose
 * entitlement is INHERITED are untouched here — inheritance is read-time.
 * Returns the number of tiers expired for logging.
 */
export async function sweepExpiredSubscriptions(): Promise<number> {
  // Atomic, self-guarding delete: the expiry predicate lives in the DELETE
  // itself, so a row re-gifted (expiresAt pushed out) in the gap between a
  // naive SELECT and DELETE no longer matches and is preserved.
  const now = new Date();
  const deleted = await db
    .delete(schema.subscriptions)
    .where(and(sql`${schema.subscriptions.expiresAt} IS NOT NULL`, lt(schema.subscriptions.expiresAt, now)))
    .returning({ userId: schema.subscriptions.userId });
  return deleted.length;
}
