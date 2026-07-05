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
  /** Whether the tier TITLE shows. Founder (grandfathered) memberships carry
      the perks but no title — titles are for supporters who chose a tier
      (paid or admin-gifted). */
  titled: boolean;
  /** Where the membership came from: 'gift' | 'founder' | 'stripe'. The web
      client shows "Manage subscription" only for own stripe rows. */
  source: string;
  /** OWN stripe rows only: scheduled to end at expiresAt (user cancelled).
      Drives the Settings "Cancels on <date> · Resume" vs "Cancel" state. */
  cancelAtPeriodEnd: boolean;
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
    return {
      tier: (own.tier as Tier) ?? 'scout',
      expiresAt: own.expiresAt,
      inherited: false,
      titled: own.source !== 'founder',
      source: own.source,
      cancelAtPeriodEnd: own.cancelAtPeriodEnd,
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
        // Inherited memberships aren't the child's to cancel.
        cancelAtPeriodEnd: false,
      };
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

  // Never silently clobber an active PAID subscription — the user would keep
  // getting charged while their row says 'gift'. Reset it first (which also
  // cancels it at Stripe), then gift.
  const existing = await getOwnSubscription(userId);
  if (existing?.source === 'stripe') {
    throw errors.badRequest(
      'This user has an active paid subscription. Reset their membership first (that cancels the Stripe subscription), then gift.',
    );
  }

  // A stripe row can be present but INACTIVE here (expiresAt lapsed, hourly
  // sweep not yet run). getOwnSubscription's active-only filter hides it, so
  // re-read unfiltered and cancel any lingering live Stripe sub before we
  // overwrite the row as a gift — otherwise it keeps billing as an orphan
  // that removeSubscription can never cancel (source would read 'gift').
  const [physical] = await db
    .select({ source: schema.subscriptions.source, stripeSubscriptionId: schema.subscriptions.stripeSubscriptionId })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .limit(1);
  if (physical?.source === 'stripe' && physical.stripeSubscriptionId) {
    const billing = await import('./billing');
    await billing.cancelStripeSubscription(physical.stripeSubscriptionId).catch(() => undefined);
  }

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
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
    })
    .onConflictDoUpdate({
      target: schema.subscriptions.userId,
      set: {
        tier,
        source: 'gift',
        giftedBy: adminId,
        expiresAt,
        // Clear any stale Stripe pointer so a re-gift can't leave a live
        // subscriptionId on a source='gift' row (which removeSubscription and
        // a late subscription.deleted webhook would both mishandle).
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/**
 * Admin reset: remove the user's membership AND hard-lock their paid
 * cosmetics (avatar frame + clan tag cleared; the client falls back to the
 * default theme when the entitlement is gone). Idempotent. A paid (Stripe)
 * membership is also canceled remotely — best-effort — so the user doesn't
 * keep getting charged for an entitlement we just removed.
 */
export async function removeSubscription(userId: bigint): Promise<void> {
  const [row] = await db
    .delete(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, userId))
    .returning();
  if (row?.source === 'stripe' && row.stripeSubscriptionId) {
    const billing = await import('./billing');
    await billing.cancelStripeSubscription(row.stripeSubscriptionId).catch(() => undefined);
  }
  await clearPaidCosmetics(userId);
}

// ── Stripe row lifecycle (called by the billing webhook) ───────────────────
// Pure DB mutations, kept here so they're testable without a Stripe client.
// expiresAt = current period end + 24h grace: renewals (invoice.paid) push it
// forward; if payments stop or a webhook is missed, the hourly expiry sweep
// hard-locks automatically. Fail-safe by construction.

const STRIPE_GRACE_MS = 24 * 60 * 60 * 1000;

export async function activateStripeSubscription(input: {
  userId: bigint;
  tier: Tier;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  currentPeriodEnd: Date;
}): Promise<{
  row: typeof schema.subscriptions.$inferSelect;
  /** A DIFFERENT stripe subscription this activation replaces — the caller
   *  must cancel it at Stripe or it keeps billing as an orphan. */
  supersededSubscriptionId: string | null;
}> {
  // If the user already has a stripe row for a DIFFERENT subscription (two
  // Checkout sessions completed before the first webhook landed), overwriting
  // it here would orphan the old one — it keeps generating monthly charges
  // with no local record. Report it so the caller cancels it at Stripe.
  const [prior] = await db
    .select({ stripeSubscriptionId: schema.subscriptions.stripeSubscriptionId })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.userId, input.userId))
    .limit(1);
  const supersededSubscriptionId =
    prior?.stripeSubscriptionId && prior.stripeSubscriptionId !== input.stripeSubscriptionId
      ? prior.stripeSubscriptionId
      : null;

  const [row] = await db
    .insert(schema.subscriptions)
    .values({
      userId: input.userId,
      tier: input.tier,
      source: 'stripe',
      giftedBy: null,
      expiresAt: new Date(input.currentPeriodEnd.getTime() + STRIPE_GRACE_MS),
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      cancelAtPeriodEnd: false,
    })
    .onConflictDoUpdate({
      target: schema.subscriptions.userId,
      set: {
        tier: input.tier,
        source: 'stripe',
        giftedBy: null,
        expiresAt: new Date(input.currentPeriodEnd.getTime() + STRIPE_GRACE_MS),
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        // Fresh activation always starts auto-renewing.
        cancelAtPeriodEnd: false,
        updatedAt: new Date(),
      },
    })
    .returning();
  return { row: row!, supersededSubscriptionId };
}

/** Renewal / plan change: push expiry forward (and retier if changed). */
export async function renewStripeSubscription(
  stripeSubscriptionId: string,
  currentPeriodEnd: Date,
  tier?: Tier,
  cancelAtPeriodEnd?: boolean,
): Promise<boolean> {
  const updated = await db
    .update(schema.subscriptions)
    .set({
      expiresAt: new Date(currentPeriodEnd.getTime() + STRIPE_GRACE_MS),
      ...(tier ? { tier } : {}),
      ...(cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd } : {}),
      updatedAt: new Date(),
    })
    // Scope to Stripe-sourced rows so a stale id can't re-tier/re-extend a
    // gift or founder row that happens to carry an old stripeSubscriptionId.
    .where(and(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
      eq(schema.subscriptions.source, 'stripe'),
    ))
    .returning({ userId: schema.subscriptions.userId });
  return updated.length > 0;
}

/** Stripe-side cancellation/deletion → hard-lock now (row + cosmetics). */
export async function endStripeSubscription(stripeSubscriptionId: string): Promise<boolean> {
  const [row] = await db
    .delete(schema.subscriptions)
    // Scope to Stripe-sourced rows: a late/stale subscription.deleted for a
    // superseded id must never clobber an admin gift or founder grant (which
    // could carry a stale stripeSubscriptionId) and wipe the user's cosmetics.
    .where(and(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
      eq(schema.subscriptions.source, 'stripe'),
    ))
    .returning({ userId: schema.subscriptions.userId });
  if (!row) return false;
  await clearPaidCosmetics(row.userId);
  return true;
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
