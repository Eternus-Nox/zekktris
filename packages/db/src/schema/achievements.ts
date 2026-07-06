/**
 * Earned-achievement ledger
 * --------------------------
 * Achievements are COMPUTED on the fly (see apps/api/src/services/achievements.ts
 * `achievementsForUser`) from underlying stats — there is no stored "earned"
 * state in that path. This table is the small ledger that records WHICH
 * achievements a user has already earned, so the server can detect the exact
 * moment one is newly unlocked and fire a notification.
 *
 * The composite PK (user_id, achievement_id) is the dedupe key: a sync does
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING achievement_id`, and the
 * returned rows are exactly the newly-earned ids for that call — atomic and
 * multi-node safe. Rows are sticky (never deleted) so "newly earned" stays
 * well-defined even for current-state cosmetics that can be un-equipped.
 */
import { bigint, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const userAchievements = pgTable(
  'user_achievements',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The stable Achievement.id, e.g. 'chatterbox_1000', 'veteran_3', 'tagged'. */
    achievementId: text('achievement_id').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.achievementId] }),
  }),
);
