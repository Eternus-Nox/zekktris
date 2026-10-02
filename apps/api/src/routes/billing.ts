/**
 * Billing routes — LEGACY Stripe wind-down. Mounted at /api/v1/billing.
 *
 * Payments were removed on 2026-10-02 (see services/billing). Nothing here
 * can start a subscription; these routes only serve subscriptions bought
 * before then:
 *   GET  /status    — always { enabled: false }: older apps hide Subscribe
 *   POST /portal    — { url } (Stripe Billing Portal: cancel / card details)
 *   POST /cancel    — end the paid subscription at the period's end
 *   POST /webhook   — Stripe events (signature-verified raw body; NO auth)
 */

import { Hono } from 'hono';
import { requireAuth, requireUserId } from '../auth/middleware';
import { errors } from '../errors';
import { log } from '../log';
import * as billing from '../services/billing';

export const billingRouter = new Hono();

billingRouter.get('/status', requireAuth, (c) => {
  return c.json({ enabled: false });
});

billingRouter.post('/portal', requireAuth, async (c) => {
  if (!billing.billingEnabled()) {
    throw errors.badRequest('This server doesn’t take payments.');
  }
  const userId = requireUserId(c);
  const url = await billing.createPortalSession(userId);
  return c.json({ url });
});

// In-app cancel: schedule the paid subscription to end at the period's end
// (they keep the tier until then).
billingRouter.post('/cancel', requireAuth, async (c) => {
  if (!billing.billingEnabled()) {
    throw errors.badRequest('This server doesn’t take payments.');
  }
  const { endsAt } = await billing.cancelOwnSubscriptionAtPeriodEnd(requireUserId(c));
  return c.json({ ok: true, endsAt: endsAt?.toISOString() ?? null });
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
