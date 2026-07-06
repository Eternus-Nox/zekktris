/**
 * Poke history
 * ------------
 * One row per poke sent in a 1:1 DM. Pokes used to be fully ephemeral
 * (a live gateway event + a push, no persistence); we now keep a small
 * bounded history so the poke button can show "who poked you recently"
 * and offer a poke-back.
 *
 * The history is capped per (channel, recipient): the send path prunes
 * to the newest 6 rows on every insert, so a busy pair can never grow
 * this table without bound. Ordering + pruning key off the snowflake
 * `id` (monotonic, collision-free) rather than `created_at` to sidestep
 * the timestamptz microsecond-vs-millisecond comparison foot-gun.
 *
 * Foreign keys cascade on parent delete:
 *   - Channel deleted → its poke history vanishes.
 *   - Either user deleted → their pokes vanish.
 *
 * The (channel_id, recipient_id, id DESC) index serves both the
 * "newest 6 for this recipient on this channel" prune and the history
 * read.
 */
import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';
import { channels } from './channels';

export const pokes = pgTable(
  'pokes',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    initiatorId: bigint('initiator_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientId: bigint('recipient_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pokeType: text('poke_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byChannelRecipient: index('idx_pokes_channel_recipient_id').on(
      t.channelId,
      t.recipientId,
      t.id,
    ),
  }),
);
