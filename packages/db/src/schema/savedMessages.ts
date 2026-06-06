/**
 * Saved-message bookmarks
 * -----------------------
 * One row per (user, message) save. The user-facing affordance is
 * a bookmark icon on each message row; tapping it adds/removes a
 * row here, and the user views their saves at /saved.
 *
 * The composite primary key (user_id, message_id) gives us
 * idempotent saves at the storage layer — duplicate inserts error
 * out with a PK violation, which the service catches and returns
 * a no-op success. This avoids an extra existence check before
 * insert.
 *
 * Foreign keys cascade on parent delete:
 *   - User deleted → all their saves vanish (no dangling rows in
 *     case of a future hard-delete pathway)
 *   - Message deleted → that save vanishes from everyone's list
 *     automatically; the user just sees one fewer entry next time
 *     they open /saved.
 *
 * The (user_id, saved_at DESC) index supports the primary listing
 * query: "show me my saves, newest first."
 */
import {
  bigint,
  index,
  pgTable,
  primaryKey,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { messages } from './messages';

export const savedMessages = pgTable(
  'saved_messages',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    savedAt: timestamp('saved_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.messageId] }),
    byUserSavedAt: index('idx_saved_messages_user_savedat').on(
      t.userId,
      t.savedAt,
    ),
  }),
);

export type SavedMessage = typeof savedMessages.$inferSelect;
