import { pgTable, bigint, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Supporter memberships — Scout ($2) / Guardian ($5) / Legend ($10).
 *
 * One row per member. `expiresAt` NULL = unlimited/forever; a timed gift sets
 * it N months out. `source` is 'gift' for admin grants (the only grant path
 * until card payments are wired; 'stripe' reserved for later). An ACTIVE row
 * (expiresAt NULL or future) unlocks the Appearance perks and the profile
 * tier title. A supervising parent's membership passes down to supervised
 * children at read time — see services/subscriptions.getEffectiveSubscription.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'scout' | 'guardian' | 'legend' (text, not an enum — no migration per tier). */
    tier: text('tier').notNull().default('scout'),
    /** 'gift' (admin grant) | 'founder' (grandfathered, untitled) | 'stripe' (paid). */
    source: text('source').notNull().default('gift'),
    giftedBy: bigint('gifted_by', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** NULL = unlimited/forever. Stripe rows hold current_period_end + 24h
        grace, pushed forward by invoice.paid — the hourly expiry sweep is the
        fail-safe if payments stop or a webhook is missed. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Stripe linkage (source='stripe' rows only). */
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStripeSub: index('subscriptions_stripe_sub_idx').on(t.stripeSubscriptionId),
  }),
);
