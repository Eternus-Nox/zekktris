/**
 * Supporter memberships — Scout ($2) / Guardian ($5) / Legend ($10)
 * -----------------------------------------------------------------
 * The entitlement chokepoint for the membership system. An ACTIVE membership
 * (row with expiresAt NULL = forever, or in the future) unlocks the
 * Appearance perks (themes, avatar frames, clan tags) and shows the tier
 * title on the profile popup (unless the user opted out via
 * users.show_subscription_tier).
 *
 * Grant paths: admin gift (1/3/6 months or forever) — the only path until a
 * card-payment rail is wired ('stripe' source reserved). Memberships are
 * NON-REFUNDABLE by policy; the purchase/pitch copy states it.
 *
 * Family pass-down: a supervising parent's membership covers their supervised
 * children AT READ TIME (getEffectiveSubscription) — no child rows are
 * written, so the child's entitlement tracks link/membership changes live and
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
 * guardians are subscribed). Null = no membership → Appearance hard-locked.
 */
export async function getEffectiveSubscription(
  userId: bigint,
): Promise<EffectiveSubscription | null> {
  const own = await getOwnSubscription(userId);
  if (own) {
    return { tier: (own.tier as Tier) ?? 'scout', expiresAt: own.expiresAt, inherited: false };
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
      best = { tier, expiresAt: sub.expiresAt, inherited: true };
    }
  }
  return best;
}

/** Entitlement gate used by the Appearance write paths. */
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
    .values({ userId, tier, source: 'gift', giftedBy: adminId, expiresAt })
    .onConflictDoUpdate({
      target: schema.subscriptions.userId,
      set: { tier, source: 'gift', giftedBy: adminId, expiresAt, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

/**
 * Admin reset: remove the user's membership AND hard-lock their paid
 * cosmetics (avatar frame + clan tag cleared; the client falls back to the
 * default theme when the entitlement is gone). Idempotent.
 */
export async function removeSubscription(userId: bigint): Promise<void> {
  await db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
  await clearPaidCosmetics(userId);
}

/** Strip the Appearance cosmetics a membership was paying for. */
async function clearPaidCosmetics(userId: bigint): Promise<void> {
  await db
    .update(schema.users)
    .set({ avatarDecoration: null, tagLabel: null, tagColor: null, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
}

/**
 * Daily hygiene sweep: timed gifts that lapsed get their rows deleted and
 * their cosmetics cleared (same hard lock as an admin reset). Users whose
 * entitlement is INHERITED are untouched here — inheritance is read-time.
 * Returns the number of memberships expired for logging.
 */
export async function sweepExpiredSubscriptions(): Promise<number> {
  const expired = await db
    .select({ userId: schema.subscriptions.userId })
    .from(schema.subscriptions)
    .where(and(sql`${schema.subscriptions.expiresAt} IS NOT NULL`, lt(schema.subscriptions.expiresAt, new Date())));
  for (const row of expired) {
    await removeSubscription(row.userId);
  }
  return expired.length;
}
