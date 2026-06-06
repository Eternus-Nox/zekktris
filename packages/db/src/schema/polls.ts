import {
  pgTable,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { messages } from './messages';
import { users } from './users';

// ───────────────────────────────────────────────────────────────────────────
// polls
// ───────────────────────────────────────────────────────────────────────────
//
// One poll per message (1:1). Storing in a separate table rather than a
// JSON blob on messages because:
//   - votes get their own table for cheap aggregation queries
//   - multi-row updates are atomic when expiring polls in batch
//   - the message stays a small, fixed-size row
//
// Lifecycle:
//   open  — votes accepted, expiresAt in the future, closedAt is null
//   closed — votes rejected (server clears the row from "open" view) but
//            the poll renders with final tallies forever. closedAt set.
//
// Authors can end their own polls early; admins with MANAGE_MESSAGES on
// the channel can end any poll.

export const polls = pgTable(
  'polls',
  {
    /** Snowflake id. Distinct from the message id so the embed remains
        stable if we ever decide to support multiple polls per message. */
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    /** The message that hosts this poll. Cascade on message delete:
        deleting a message removes its poll + all votes. */
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** The poll question. Up to 300 chars, validated server-side. */
    question: text('question').notNull(),
    /** When true, voters can pick any number of options. When false,
        voting for option B retracts a previous vote for option A. */
    multipleChoice: boolean('multiple_choice').notNull().default(false),
    /** Hard end time. Server rejects votes after this timestamp. NULL =
        never expires (admin closes manually); the UI shows "no end". */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Set when the poll is closed (either by expiry or admin action).
        Once non-null, the poll renders as final results — bars stop
        animating, vote buttons disable, "Final results" footer shows. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Unique constraint expressed as an index because Drizzle's
        primary-key shape doesn't compose with the FK above. We enforce
        message_id uniqueness so a buggy create-flow can't end up with
        two polls attached to the same message. */
    messageUq: index('polls_message_uq').on(t.messageId),
  }),
);

export const pollOptions = pgTable(
  'poll_options',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    pollId: bigint('poll_id', { mode: 'bigint' })
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    /** Option label. Up to 80 chars, ≥ 1 char. */
    text: text('text').notNull(),
    /** Display order. Stable, set at create time; we don't reorder
        options once a poll is live (would invalidate cast votes). */
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pollIdx: index('poll_options_poll_idx').on(t.pollId, t.position),
  }),
);

export const pollVotes = pgTable(
  'poll_votes',
  {
    pollId: bigint('poll_id', { mode: 'bigint' })
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    optionId: bigint('option_id', { mode: 'bigint' })
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    /** The voter. Cascade-on-user-delete since a deleted user's votes
        shouldn't keep counting toward live tallies (the poll's still
        public; votes from ghosts would be misleading). */
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Composite primary key — one row per (poll, option, voter). For
        single-choice polls, the service-level vote() routine deletes
        any existing rows for the (poll, voter) before inserting the
        new one, so the multi-row case only happens for multipleChoice
        polls. */
    pk: primaryKey({ columns: [t.pollId, t.optionId, t.userId] }),
    /** Voter-facing index: "what are my votes?" — used by the vote()
        path to decide whether the user already voted for an option. */
    userIdx: index('poll_votes_user_idx').on(t.userId, t.pollId),
    /** Tally index: counts per option are computed via SELECT COUNT(*)
        GROUP BY option_id; this index makes that O(log n + k) where k
        is the number of options. */
    optionIdx: index('poll_votes_option_idx').on(t.optionId),
  }),
);

export type Poll = typeof polls.$inferSelect;
export type NewPoll = typeof polls.$inferInsert;
export type PollOption = typeof pollOptions.$inferSelect;
export type NewPollOption = typeof pollOptions.$inferInsert;
export type PollVote = typeof pollVotes.$inferSelect;
export type NewPollVote = typeof pollVotes.$inferInsert;
