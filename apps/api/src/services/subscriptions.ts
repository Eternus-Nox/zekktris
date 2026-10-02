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
 * Grant path: admin give (1/3/6 months or forever). Rows with source 'stripe'
 * are subscriptions bought before payments were removed (2026-10-02); the
 * webhook still keeps them in sync until an admin retires them
 * (retirePaidSubscriptions), which turns each into a forever tier and stops
 * the billing.
 *
 * Family pass-down: a supervising parent's tier covers their supervised
 * children AT READ TIME (getEffectiveSubscription) — no child rows are
 * written, so the child's entitlement tracks link/tier changes live and
 * ends automatically when the link ends (18th birthday auto-release included).
 */

import { and, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
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

  // A row left over from paid billing may still be live at Stripe. Cancel it
  // before overwriting the row as a gift, or it keeps charging as an orphan
  // that nothing local points at any more. Best-effort: the gift still lands.
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
 * Admin remove: drop the user's tier. Idempotent. Cosmetics are free, so the
 * user keeps their frame, tag and theme. A leftover paid (Stripe) row is also
 * canceled remotely — best-effort — so nobody is charged for a tier we just
 * removed.
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
}

/** How many leftover paid (Stripe) tiers are still live. */
export async function countPaidSubscriptions(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.source, 'stripe'), activeWhere()));
  return row?.n ?? 0;
}

/**
 * End paid billing for good: every live Stripe row becomes a forever tier at
 * the same level (source 'gift', given by `adminId`), then its Stripe
 * subscription is canceled so it never charges again. The row is converted
 * FIRST — a late subscription.deleted webhook is scoped to source 'stripe',
 * so it can no longer touch the row. Cancel failures are counted, not thrown:
 * the admin is told to finish those in the Stripe dashboard.
 */
export async function retirePaidSubscriptions(
  adminId: bigint,
): Promise<{ converted: number; cancelFailures: number }> {
  const live = await db
    .select({
      userId: schema.subscriptions.userId,
      stripeSubscriptionId: schema.subscriptions.stripeSubscriptionId,
    })
    .from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.source, 'stripe'), activeWhere()));
  if (live.length === 0) return { converted: 0, cancelFailures: 0 };

  const converted = await db
    .update(schema.subscriptions)
    .set({
      source: 'gift',
      giftedBy: adminId,
      expiresAt: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(schema.subscriptions.userId, live.map((r) => r.userId)),
      eq(schema.subscriptions.source, 'stripe'),
    ))
    .returning({ userId: schema.subscriptions.userId });

  const billing = await import('./billing');
  let cancelFailures = 0;
  for (const row of live) {
    if (!row.stripeSubscriptionId) continue;
    // Without a Stripe key nothing can be canceled from here.
    if (!billing.canCancelAtStripe()) {
      cancelFailures++;
      continue;
    }
    try {
      await billing.cancelStripeSubscription(row.stripeSubscriptionId);
    } catch {
      cancelFailures++;
    }
  }
  return { converted: converted.length, cancelFailures };
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

/** Stripe-side cancellation/deletion → the tier ends now. */
export async function endStripeSubscription(stripeSubscriptionId: string): Promise<boolean> {
  const [row] = await db
    .delete(schema.subscriptions)
    // Scope to Stripe-sourced rows: a late/stale subscription.deleted for a
    // superseded id must never clobber an admin gift or founder grant (which
    // could carry a stale stripeSubscriptionId).
    .where(and(
      eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId),
      eq(schema.subscriptions.source, 'stripe'),
    ))
    .returning({ userId: schema.subscriptions.userId });
  return !!row;
}

/**
 * Daily hygiene sweep: timed tiers that lapsed get their rows deleted.
 * Cosmetics are free, so nothing else changes for the user. Users whose
 * entitlement is INHERITED are untouched here — inheritance is read-time.
 * Returns the number of tiers expired for logging.
 */
export async function sweepExpiredSubscriptions(): Promise<number> {
  // Atomic, self-guarding delete: re-check the expiry predicate in the DELETE
  // itself so a row renewed in the gap between a naive SELECT and DELETE (its
  // expiresAt pushed into the future by a concurrent renewal webhook) no longer
  // matches the WHERE and is preserved — the row-level lock serializes the
  // renewal UPDATE and this DELETE. Legitimately-expired stripe rows are still
  // canceled at Stripe (never keep billing someone whose tier ended).
  const now = new Date();
  const deleted = await db
    .delete(schema.subscriptions)
    .where(and(sql`${schema.subscriptions.expiresAt} IS NOT NULL`, lt(schema.subscriptions.expiresAt, now)))
    .returning({
      userId: schema.subscriptions.userId,
      source: schema.subscriptions.source,
      stripeSubscriptionId: schema.subscriptions.stripeSubscriptionId,
    });
  for (const row of deleted) {
    if (row.source === 'stripe' && row.stripeSubscriptionId) {
      const billing = await import('./billing');
      await billing.cancelStripeSubscription(row.stripeSubscriptionId).catch(() => undefined);
    }
  }
  return deleted.length;
}
