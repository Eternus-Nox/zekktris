-- Stripe billing wiring for supporter memberships. A paid subscription row
-- (source='stripe') tracks its Stripe customer + subscription ids so webhooks
-- can renew/cancel it and the billing portal can be opened. expires_at holds
-- current_period_end + a 24h grace, pushed forward by invoice.paid — so if
-- payments stop (or a webhook is missed) the existing hourly expiry sweep
-- hard-locks the membership automatically. Fail-safe by construction.
ALTER TABLE "subscriptions" ADD COLUMN "stripe_customer_id" text;
ALTER TABLE "subscriptions" ADD COLUMN "stripe_subscription_id" text;
CREATE INDEX "subscriptions_stripe_sub_idx" ON "subscriptions" ("stripe_subscription_id");
