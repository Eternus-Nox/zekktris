import { pgTable, bigint, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { guilds } from './guilds';

/**
 * Instance security log + word-ban list (Admin → Security).
 *
 * `security_events` records malicious/abusive behavior detected by the
 * message pipeline: spam bursts (rate-limit applied), banned-word hits
 * (message rejected), and room for future detectors. Events reference the
 * actor with SET NULL so the trail survives account deletion.
 *
 * E2EE content is NEVER inspected — encrypted channels are exempt from
 * both detectors (ciphertext is opaque; the spam counter could technically
 * run on metadata, but encrypted DMs are deliberately out of scope).
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    /** 'spam_limited' | 'banned_word' — extend as detectors are added. */
    kind: text('kind').$type<'spam_limited' | 'banned_word'>().notNull(),
    userId: bigint('user_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    guildId: bigint('guild_id', { mode: 'bigint' }).references(() => guilds.id, {
      onDelete: 'cascade',
    }),
    channelId: bigint('channel_id', { mode: 'bigint' }),
    /** Human-readable summary ("matched word: …", "23 msgs in 10s"). */
    detail: text('detail').notNull(),
    /** Snapshot of the offending content (NOT stored for E2EE — exempt). */
    contentSnapshot: text('content_snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('security_events_created_idx').on(t.createdAt),
    index('security_events_user_idx').on(t.userId),
    index('security_events_kind_idx').on(t.kind),
  ],
);

/** Instance-wide banned words (case-insensitive whole-word match). */
export const securityBannedWords = pgTable('security_banned_words', {
  word: text('word').primaryKey(),
  addedBy: bigint('added_by', { mode: 'bigint' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Singleton config row (id = 1) for the spam throttle. Admins tune it from
 * the Security tab; the message pipeline reads it through a short cache.
 */
export const securityConfig = pgTable('security_config', {
  id: integer('id').primaryKey().default(1),
  spamEnabled: boolean('spam_enabled').notNull().default(true),
  /** A user sending more than `spamMaxMessages` in `spamWindowSeconds`… */
  spamMaxMessages: integer('spam_max_messages').notNull().default(8),
  spamWindowSeconds: integer('spam_window_seconds').notNull().default(10),
  /** …is limited to one message per minute for `spamCooldownSeconds`. */
  spamCooldownSeconds: integer('spam_cooldown_seconds').notNull().default(600),
  wordFilterEnabled: boolean('word_filter_enabled').notNull().default(true),
});

/**
 * Daily messaging streaks for 1:1 DMs. A streak day counts when BOTH
 * participants message within the same UTC calendar day; consecutive
 * counted days build the streak (capped at 10,000 in the API). Computed
 * from message timestamps only, so E2EE conversations work — content is
 * never read.
 */
export const dmStreaks = pgTable(
  'dm_streaks',
  {
    channelId: bigint('channel_id', { mode: 'bigint' }).primaryKey(),
    userAId: bigint('user_a_id', { mode: 'bigint' }).notNull(),
    userBId: bigint('user_b_id', { mode: 'bigint' }).notNull(),
    /** Last UTC day (YYYY-MM-DD) each side messaged. */
    lastDayA: text('last_day_a'),
    lastDayB: text('last_day_b'),
    /** Last UTC day the streak was credited. */
    lastCountedDay: text('last_counted_day'),
    streak: integer('streak').notNull().default(0),
    bestStreak: integer('best_streak').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // `bestStreakForUser` filters `userAId = $1 OR userBId = $1`; two
    // single-column indexes let Postgres BitmapOr them (a composite would
    // only serve the leading column). The primary key already covers
    // `channelId` lookups used by the per-DM streak read.
    byUserA: index('dm_streaks_user_a_idx').on(t.userAId),
    byUserB: index('dm_streaks_user_b_idx').on(t.userBId),
  }),
);
