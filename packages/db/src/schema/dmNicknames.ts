/**
 * Personal DM nicknames
 * ---------------------
 * A viewer-private, one-directional label a user sets for ANOTHER user, shown
 * in place of that user's name in DIRECT MESSAGES only. Only the setter sees
 * it (like Discord friend nicknames). It is viewer-state, not channel-state —
 * keyed by (owner, target), independent of any DM channel id, so it survives
 * closing + re-opening the DM.
 *
 * A mirror of the `relationships` table: composite PK (owner_id, target_id),
 * both FKs ON DELETE cascade (a deleted account drops the nicknames it set AND
 * the nicknames others set for it), and an index on target_id. CLEARING a
 * nickname deletes the row.
 */
import { bigint, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const dmNicknames = pgTable(
  'dm_nicknames',
  {
    /** The viewer who set the nickname (only they see it). */
    ownerId: bigint('owner_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The user being renamed. */
    targetId: bigint('target_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nickname: text('nickname').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerId, t.targetId] }),
    targetIdx: index('dm_nicknames_target_idx').on(t.targetId),
  }),
);

export type DmNickname = typeof dmNicknames.$inferSelect;
