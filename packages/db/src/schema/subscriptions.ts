import { pgTable, bigint, boolean, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Perk tiers — Scout / Guardian / Legend (admin-given; there are no payments).
 *
 * One row per member. `expiresAt` NULL = unlimited/forever; a timed gift sets
 * it N months out. `source` is 'gift' for admin grants (the only grant path)
 * or 'founder' for the grandfathered rows. An ACTIVE row (expiresAt NULL or
 * future) unlocks the tier's perks and the profile tier title. A supervising
 * parent's tier passes down to supervised children at read time — see
 * services/subscriptions.getEffectiveSubscription.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'scout' | 'guardian' | 'legend' (text, not an enum — no migration per tier). */
    tier: text('tier').notNull().default('scout'),
    /** 'gift' (admin grant) | 'founder' (grandfathered, untitled). */
    source: text('source').notNull().default('gift'),
    giftedBy: bigint('gifted_by', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** NULL = unlimited/forever; the expiry sweep deletes lapsed rows. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** LEGACY, unused: payments and all Stripe code are gone (migration 0129
     *  turned the paid rows into forever gifts). Nothing reads or writes these;
     *  the ids are kept only so an operator can find any subscription still
     *  billing in the Stripe dashboard. */
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStripeSub: index('subscriptions_stripe_sub_idx').on(t.stripeSubscriptionId),
  }),
);
