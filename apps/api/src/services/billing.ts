/**
 * Stripe billing for supporter memberships
 * ----------------------------------------
 * The payment rail on top of services/subscriptions (which owns the
 * entitlement rows). Feature-flagged on STRIPE_SECRET_KEY — unset means
 * billing reports disabled and memberships stay admin-gift only.
 *
 * Design:
 *   - Prices are AUTO-PROVISIONED by lookup_key (zekktris_scout /
 *     zekktris_guardian / zekktris_legend, $2/$5/$10 monthly) on first use —
 *     no dashboard product setup needed. Existing prices are reused.
 *   - Checkout Sessions carry userId + tier in metadata; the webhook
 *     (checkout.session.completed) activates the row. Renewals
 *     (invoice.paid) push expiresAt forward; deletion hard-locks. The row's
 *     expiresAt = period end + 24h grace, so the hourly expiry sweep is the
 *     fail-safe if a webhook is ever missed.
 *   - Memberships are NON-REFUNDABLE (stated on the pitch AND on the
 *     Checkout submit button).
 *   - Cancel/manage happens in the Stripe Billing Portal (customer keeps
 *     access until the paid period ends — the row expires on schedule).
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

/** lookup_key ↔ tier. Amounts in cents; monthly recurring. */
const TIER_PRICES: Record<Tier, { lookupKey: string; label: string; amount: number }> = {
  scout: { lookupKey: 'zekktris_scout', label: 'Zekktris Scout', amount: 200 },
  guardian: { lookupKey: 'zekktris_guardian', label: 'Zekktris Guardian', amount: 500 },
  legend: { lookupKey: 'zekktris_legend', label: 'Zekktris Legend', amount: 1000 },
};

export function tierForLookupKey(lookupKey: string | null | undefined): Tier | null {
  for (const [tier, meta] of Object.entries(TIER_PRICES)) {
    if (meta.lookupKey === lookupKey) return tier as Tier;
  }
  return null;
}

/** Resolved price ids per tier, cached for the process lifetime. */
const priceCache = new Map<Tier, string>();

async function priceIdForTier(tier: Tier): Promise<string> {
  const cached = priceCache.get(tier);
  if (cached) return cached;
  const meta = TIER_PRICES[tier];
  // Reuse an existing price with our lookup_key…
  const existing = await stripe().prices.list({ lookup_keys: [meta.lookupKey], limit: 1 });
  let priceId = existing.data[0]?.id;
  // …or provision the product + price on first use.
  if (!priceId) {
    const product = await stripe().products.create({
      name: meta.label,
      description: `${meta.label} supporter membership — helps Zekktris stay alive and strong. Non-refundable.`,
    });
    const price = await stripe().prices.create({
      product: product.id,
      unit_amount: meta.amount,
      currency: 'usd',
      recurring: { interval: 'month' },
      lookup_key: meta.lookupKey,
    });
    priceId = price.id;
    log.info('stripe price provisioned', { tier, priceId });
  }
  priceCache.set(tier, priceId);
  return priceId;
}

/** Start a Checkout Session for the tier; returns the redirect URL. */
export async function createCheckoutSession(input: {
  userId: bigint;
  email: string;
  tier: Tier;
}): Promise<string> {
  const own = await subscriptions.getOwnSubscription(input.userId);
  if (own?.source === 'stripe') {
    throw errors.badRequest(
      'You already have an active subscription — use “Manage subscription” to change or cancel it.',
    );
  }
  const priceId = await priceIdForTier(input.tier);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${env.PUBLIC_URL}/settings?billing=success`,
    cancel_url: `${env.PUBLIC_URL}/settings?billing=canceled`,
    client_reference_id: input.userId.toString(),
    // Reuse the Stripe customer when they've paid before (keeps their portal
    // history in one place); otherwise Checkout creates one from the email.
    ...(own?.stripeCustomerId
      ? { customer: own.stripeCustomerId }
      : { customer_email: input.email }),
    metadata: { userId: input.userId.toString(), tier: input.tier },
    subscription_data: {
      metadata: { userId: input.userId.toString(), tier: input.tier },
    },
    custom_text: {
      submit: {
        message:
          'Being a supporter helps Zekktris stay alive and strong. Memberships are non-refundable.',
      },
    },
  });
  if (!session.url) throw errors.internal('Stripe did not return a checkout URL');
  return session.url;
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

/** Remote cancel (admin reset path). Immediate, best-effort at the caller. */
export async function cancelStripeSubscription(stripeSubscriptionId: string): Promise<void> {
  if (!env.STRIPE_SECRET_KEY) return; // nothing to cancel against
  await stripe().subscriptions.cancel(stripeSubscriptionId);
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
      await subscriptions.activateStripeSubscription({
        userId: BigInt(userIdStr),
        tier,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? ''),
        stripeSubscriptionId: subId,
        currentPeriodEnd: periodEndOf(sub),
      });
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
      await subscriptions.renewStripeSubscription(sub.id, periodEndOf(sub), tier);
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
