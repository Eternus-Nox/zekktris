-- Track whether a paid (Stripe) subscription is scheduled to cancel at the end
-- of the current period. Set by the customer.subscription.updated webhook from
-- Stripe's cancel_at_period_end, and surfaced to the client so Settings can
-- show "Cancels on <date> · Resume" vs "Cancel subscription". Reset to false on
-- a fresh checkout activation and on reactivation.
ALTER TABLE "subscriptions"
  ADD COLUMN "cancel_at_period_end" boolean NOT NULL DEFAULT false;
