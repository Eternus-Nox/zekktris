/**
 * Billing routes — Stripe checkout / portal / webhook for supporter
 * memberships. Mounted at /api/v1/billing.
 *
 *   GET  /status    — { enabled } so clients show/hide the Subscribe buttons
 *   POST /checkout  — { tier } → { url } (Stripe Checkout redirect)
 *   POST /portal    — { url } (Stripe Billing Portal: manage/cancel)
 *   POST /webhook   — Stripe events (signature-verified raw body; NO auth)
 *
 * The webhook is the entitlement writer: checkout.session.completed activates
 * the membership row, invoice.paid/subscription.updated extend it, and
 * subscription.deleted hard-locks it. See services/billing for the design
 * notes (24h grace + hourly sweep = fail-safe).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { RateLimiter } from '../lib/rateLimit';
import { db, schema } from '../db';
import { eq } from 'drizzle-orm';
import { errors } from '../errors';
import { log } from '../log';
import * as billing from '../services/billing';

export const billingRouter = new Hono();

// Checkout-session creation hits Stripe; keep a light per-user lid on it.
const checkoutByUser = new RateLimiter(5, 60_000, 'billing-checkout-user');

billingRouter.get('/status', requireAuth, (c) => {
  return c.json({ enabled: billing.billingEnabled() });
});

billingRouter.post(
  '/checkout',
  requireAuth,
  validate('json', z.object({ tier: z.enum(['scout', 'guardian', 'legend']) })),
  async (c) => {
    if (!billing.billingEnabled()) {
      throw errors.badRequest('Payments are not configured on this server yet.');
    }
    const userId = requireUserId(c);
    const r = await checkoutByUser.consume(userId.toString());
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
    const { tier } = c.req.valid('json');
    const [user] = await db
      .select({ email: schema.users.email, isBot: schema.users.isBot })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user) throw errors.notFound('User');
    if (user.isBot) throw errors.badRequest('Bots cannot subscribe');
    const url = await billing.createCheckoutSession({ userId, email: user.email, tier });
    return c.json({ url });
  },
);

billingRouter.post('/portal', requireAuth, async (c) => {
  if (!billing.billingEnabled()) {
    throw errors.badRequest('Payments are not configured on this server yet.');
  }
  const userId = requireUserId(c);
  const url = await billing.createPortalSession(userId);
  return c.json({ url });
});

// In-app cancel: schedule the paid subscription to end at the period's end
// (non-refundable, so they keep access until then). Reversible via /reactivate.
billingRouter.post('/cancel', requireAuth, async (c) => {
  if (!billing.billingEnabled()) {
    throw errors.badRequest('Payments are not configured on this server yet.');
  }
  const { endsAt } = await billing.cancelOwnSubscriptionAtPeriodEnd(requireUserId(c));
  return c.json({ ok: true, endsAt: endsAt?.toISOString() ?? null });
});

// Undo a scheduled cancel — resume auto-renew.
billingRouter.post('/reactivate', requireAuth, async (c) => {
  if (!billing.billingEnabled()) {
    throw errors.badRequest('Payments are not configured on this server yet.');
  }
  await billing.reactivateOwnSubscription(requireUserId(c));
  return c.json({ ok: true });
});

// ── Stripe webhook ──────────────────────────────────────────────────────────
// NO auth (Stripe calls it); authenticity comes from the signature check over
// the RAW body — don't parse/validate the JSON before verification. Returns
// 2xx quickly; processing failures log + 500 so Stripe retries the event.
billingRouter.post('/webhook', async (c) => {
  if (!billing.billingEnabled()) return c.json({ error: 'billing disabled' }, 404);
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'missing signature' }, 400);
  const rawBody = await c.req.text();
  let event;
  try {
    event = billing.constructWebhookEvent(rawBody, signature);
  } catch {
    return c.json({ error: 'invalid signature' }, 400);
  }
  try {
    await billing.handleWebhookEvent(event);
  } catch (err) {
    // 500 → Stripe retries with backoff; the handlers are idempotent
    // (upserts / keyed deletes), so replays are safe.
    log.error('stripe webhook processing failed', { type: event.type, err });
    return c.json({ error: 'processing failed' }, 500);
  }
  return c.json({ received: true });
});
