/**
 * Stripe billing — LEGACY, wind-down only
 * ---------------------------------------
 * Payments were removed on 2026-10-02: every account gets the whole app, and
 * perk tiers are given out by admins. Nobody can start a new subscription
 * (there is no checkout any more). What remains keeps the subscriptions
 * bought before then honest until an admin retires them
 * (subscriptions.retirePaidSubscriptions):
 *   - the webhook keeps renewals / cancellations in sync with the rows,
 *   - a subscriber can still cancel or open the Stripe portal,
 *   - admin give/remove and the expiry sweep cancel at Stripe so nobody is
 *     charged for a tier that's gone.
 * Feature-flagged on STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET; a server
 * without them (every self-hosted install) never touches Stripe.
 */

import Stripe from 'stripe';
import { env } from '../env';
import { errors } from '../errors';
import { log } from '../log';
import * as subscriptions from './subscriptions';
import type { Tier } from './subscriptions';

export function billingEnabled(): boolean {
  return !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET;
}

let _stripe: Stripe | null = null;
function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw errors.internal('Stripe is not configured');
  _stripe ??= new Stripe(env.STRIPE_SECRET_KEY);
  return _stripe;
}

/** lookup_key ↔ tier, for renewals of subscriptions bought before payments
 *  were removed. */
const TIER_LOOKUP_KEYS: Record<Tier, string> = {
  scout: 'zekktris_scout',
  guardian: 'zekktris_guardian',
  legend: 'zekktris_legend',
};

export function tierForLookupKey(lookupKey: string | null | undefined): Tier | null {
  for (const [tier, key] of Object.entries(TIER_LOOKUP_KEYS)) {
    if (key === lookupKey) return tier as Tier;
  }
  return null;
}

/** Billing-portal session (manage/cancel). Requires a paid membership. */
export async function createPortalSession(userId: bigint): Promise<string> {
  const own = await subscriptions.getOwnSubscription(userId);
  if (!own?.stripeCustomerId) {
    throw errors.badRequest('No paid subscription to manage');
  }
  const session = await stripe().billingPortal.sessions.create({
    customer: own.stripeCustomerId,
    return_url: `${env.PUBLIC_URL}/settings`,
  });
  return session.url;
}

/** Whether this server can cancel anything at Stripe. */
export function canCancelAtStripe(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}

/** Remote cancel (admin reset path). Immediate, best-effort at the caller. */
export async function cancelStripeSubscription(stripeSubscriptionId: string): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return; // nothing to cancel against
  await stripe().subscriptions.cancel(stripeSubscriptionId);
}

/**
 * User-initiated in-app cancel: schedule the subscription to end at the current
 * period's end (they keep the tier until then). Returns the effective end
 * (period end + grace) for a "your tier runs until <date>" message.
 */
export async function cancelOwnSubscriptionAtPeriodEnd(
  userId: bigint,
): Promise<{ endsAt: Date | null }> {
  const own = await subscriptions.getOwnSubscription(userId);
  if (own?.source !== 'stripe' || !own.stripeSubscriptionId) {
    throw errors.badRequest('You have no paid subscription to cancel.');
  }
  const sub = await stripe().subscriptions.update(own.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
  // customer.subscription.updated fires and keeps the row's expiry current; the
  // actual hard-lock happens on subscription.deleted at period end.
  return { endsAt: periodEndOf(sub) };
}

/** Period end resolution across API versions (item-level fallback). */
function periodEndOf(sub: Stripe.Subscription): Date {
  const raw =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    sub.items?.data?.[0]?.current_period_end;
  // Missing period info shouldn't grant infinite access — fall back to ~35
  // days out (a monthly cycle + margin); the next invoice.paid corrects it.
  return raw ? new Date(raw * 1000) : new Date(Date.now() + 35 * 86_400_000);
}

/**
 * Webhook dispatcher. The route verified the signature already; this applies
 * the event to the entitlement rows. Unknown events are ignored.
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription' || !session.subscription) return;
      const userIdStr = session.metadata?.userId ?? session.client_reference_id;
      const tier = (session.metadata?.tier ?? null) as Tier | null;
      if (!userIdStr || !tier || !subscriptions.TIERS.includes(tier)) {
        log.error('stripe checkout completed without usable metadata', {
          sessionId: session.id,
        });
        return;
      }
      const subId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
      const sub = await stripe().subscriptions.retrieve(subId);
      const { supersededSubscriptionId } = await subscriptions.activateStripeSubscription({
        userId: BigInt(userIdStr),
        tier,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? ''),
        stripeSubscriptionId: subId,
        currentPeriodEnd: periodEndOf(sub),
      });
      // If this checkout replaced a DIFFERENT live stripe subscription (a
      // double-checkout race), cancel the old one at Stripe so it doesn't keep
      // billing as an orphan with no local record. Best-effort — a failure
      // here must not fail the webhook (Stripe would retry the whole event).
      if (supersededSubscriptionId) {
        try {
          await stripe().subscriptions.cancel(supersededSubscriptionId);
          log.warn('stripe: cancelled superseded duplicate subscription', {
            userId: userIdStr,
            supersededSubscriptionId,
            keptSubscriptionId: subId,
          });
        } catch (err) {
          log.error('stripe: failed to cancel superseded duplicate subscription', {
            userId: userIdStr,
            supersededSubscriptionId,
            err: (err as Error).message,
          });
        }
      }
      log.info('stripe membership activated', { userId: userIdStr, tier });
      return;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      const subRef = (invoice as unknown as { subscription?: string | { id: string } | null })
        .subscription;
      const subId = typeof subRef === 'string' ? subRef : subRef?.id;
      if (!subId) return;
      const sub = await stripe().subscriptions.retrieve(subId);
      const tier = tierForLookupKey(sub.items?.data?.[0]?.price?.lookup_key) ?? undefined;
      await subscriptions.renewStripeSubscription(subId, periodEndOf(sub), tier);
      return;
    }
    case 'customer.subscription.updated': {
      // Plan changes + renewals both land here; keep tier + expiry current.
      // cancel_at_period_end needs no action — the row simply expires.
      const sub = event.data.object;
      const tier = tierForLookupKey(sub.items?.data?.[0]?.price?.lookup_key) ?? undefined;
      // ONLY extend entitlement for a paying status. On a failed renewal Stripe
      // fires this with status='past_due'/'unpaid' (often advancing the period
      // for dunning) before it eventually deletes the sub — extending here
      // would keep a non-paying user's cosmetics/title alive. For those states
      // we leave expiresAt as-is so the existing grace lapses and the hourly
      // sweep hard-locks; if payment recovers, invoice.paid re-extends.
      const PAID_STATUSES = new Set(['active', 'trialing']);
      if (PAID_STATUSES.has(sub.status)) {
        await subscriptions.renewStripeSubscription(
          sub.id,
          periodEndOf(sub),
          tier,
          sub.cancel_at_period_end === true,
        );
      }
      return;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const ended = await subscriptions.endStripeSubscription(sub.id);
      if (ended) log.info('stripe membership ended', { stripeSubscriptionId: sub.id });
      return;
    }
    default:
      return; // unhandled event types are fine — we only subscribed to a few
  }
}

/** Verify + parse a webhook payload. Throws on bad signatures. */
export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) throw errors.internal('Stripe webhook secret not configured');
  return stripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}
