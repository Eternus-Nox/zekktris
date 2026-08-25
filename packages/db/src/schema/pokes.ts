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
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
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
    /**
     * Unread marker for the poke button's badge. A new poke lands `false`; the
     * history read (GET /channels/:id/pokes, fired when the popover opens)
     * flips the recipient's rows to `true`.
     *
     * Deliberately NOT derived from `read_states`: ack() advances that cursor
     * with GREATEST, so it never moves backwards — a poke arriving after a read
     * could never re-arm the badge. The badge count is bounded by the 6-row
     * buffer, which is fine: it is a "you have new pokes" dot, not a ledger.
     * (Pre-existing rows were migrated in as `true`, so nobody got a phantom
     * badge for old pokes at rollout — see migration 0120.)
     */
    seen: boolean('seen').notNull().default(false),
  },
  (t) => ({
    byChannelRecipient: index('idx_pokes_channel_recipient_id').on(
      t.channelId,
      t.recipientId,
      t.id,
    ),
  }),
);

/**
 * Poke tallies — the DURABLE counterpart to the `pokes` buffer above
 * ------------------------------------------------------------------
 * `pokes` is a display buffer, not a ledger: it is pruned to the newest 6 rows
 * per (channel, RECIPIENT) on every insert, so nothing lifetime-scoped can be
 * read back out of it. This table is the permanent record, one row per ORDERED
 * pair, never pruned.
 *
 * Why keyed by the pair rather than scalar counters on `users`: the poke
 * achievements must not be self-farmable. Poking is trivially repeatable
 * against one alt, so a raw "pokes sent" total is worthless as a badge — and a
 * scalar can never be repaired later, because the identities behind it were
 * never stored. The pair key makes the honest metrics single indexed counts:
 *
 *   distinct people you poked     → COUNT(*) WHERE initiator_id = you   (PK)
 *   distinct people who poked you → COUNT(*) WHERE recipient_id = you   (index)
 *   lifetime pokes sent           → SUM(poke_count) WHERE initiator_id = you
 *
 * Repeat pokes to the same person only bump `pokeCount`, so row growth is
 * bounded by the real DM graph (directed pairs that have ever poked), not by
 * poke volume — an alt-farm loop adds exactly one row and moves the distinct
 * count by exactly one.
 *
 * FKs cascade on user delete, same as `pokes`: a deleted account stops counting
 * toward anyone's distinct total.
 */
export const pokeTallies = pgTable(
  'poke_tallies',
  {
    initiatorId: bigint('initiator_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientId: bigint('recipient_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Lifetime pokes sent along THIS directed edge. */
    pokeCount: integer('poke_count').notNull().default(0),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'poke_tallies_pk', columns: [t.initiatorId, t.recipientId] }),
    // The PK's leading column covers the "people I poked" side; this covers the
    // "people who poked me" side so both distinct counts stay index-only.
    byRecipient: index('idx_poke_tallies_recipient').on(t.recipientId, t.initiatorId),
  }),
);
