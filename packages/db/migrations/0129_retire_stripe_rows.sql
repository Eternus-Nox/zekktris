-- Payments are gone for good: the Stripe code (webhook, portal, cancel) was
-- removed, so nothing keeps a paid subscription row in sync any more. Every
-- still-active paid row ('stripe') becomes a forever tier at the same level —
-- what Admin → Perks "End all billing, keep tiers" did, and what the apps told
-- those subscribers ("Zekktris is free now. You keep your tier"). gifted_by
-- stays NULL: no admin gave it.
--
-- Paid rows that already lapsed are deleted, as the expiry sweep would.
--
-- This does NOT stop billing at Stripe. The stripe_* columns are left in place
-- (unused) so an operator can still look up any subscription that is billing
-- and cancel it in the Stripe dashboard:
--   SELECT user_id, stripe_customer_id, stripe_subscription_id
--   FROM subscriptions WHERE stripe_subscription_id IS NOT NULL;
-- Idempotent: a second run finds no 'stripe' rows.
UPDATE "subscriptions"
SET "source" = 'gift',
    "expires_at" = NULL,
    "cancel_at_period_end" = false,
    "updated_at" = now()
WHERE "source" = 'stripe'
  AND ("expires_at" IS NULL OR "expires_at" > now());
--> statement-breakpoint
DELETE FROM "subscriptions" WHERE "source" = 'stripe';
