import { pgTable, bigint, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
    /** Automated detectors ('spam_limited' | 'banned_word') plus staff-action
        audit kinds ('staff_ban', 'staff_gift', …). Text — extend freely. */
    kind: text('kind').notNull(),
    /** The TARGET of the event (message author / actioned user). */
    userId: bigint('user_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** WHO performed a staff action (null for automated detections). */
    actorId: bigint('actor_id', { mode: 'bigint' }).references(() => users.id, {
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
    /** UTC day (YYYY-MM-DD) the "streak expires soon" warning was last sent for
     *  this DM. A text watermark (not a bool) so it self-resets across days:
     *  "already warned today" == (streakWarnedForDay === today). Set atomically
     *  by the warning sweep so two ticks/replicas never double-send. */
    streakWarnedForDay: text('streak_warned_for_day'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // `bestStreakForUser` filters `userAId = $1 OR userBId = $1`; two
    // single-column indexes let Postgres BitmapOr them (a composite would
    // only serve the leading column). The primary key already covers
    // `channelId` lookups used by the per-DM streak read.
    byUserA: index('dm_streaks_user_a_idx').on(t.userAId),
    byUserB: index('dm_streaks_user_b_idx').on(t.userBId),
    // Hot path for the expiry-warning sweep: WHERE streak > 0 AND
    // last_counted_day = :yesterday. Partial (live streaks only).
    warnSweep: index('dm_streaks_warn_sweep_idx')
      .on(t.lastCountedDay)
      .where(sql`${t.streak} > 0`),
  }),
);

/**
 * WebAuthn passkeys. One row per registered credential (a user can have many —
 * a phone, a laptop, a hardware key). `credentialId` is GLOBALLY unique because
 * discoverable login looks it up before the user is known. `publicKey` +
 * `counter` are the verification material; the counter guards against
 * cloned-authenticator replay. Binary fields are stored base64url as text
 * (matches @simplewebauthn's isoBase64URL helpers + the rest of our text
 * key storage).
 */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** base64url of the raw credential ID. Globally unique. */
    credentialId: text('credential_id').notNull().unique(),
    /** base64url of the COSE public key bytes. */
    publicKey: text('public_key').notNull(),
    /** Authenticator signature counter (replay guard). */
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    /** JSON array string of transports, e.g. ["internal","hybrid"]. */
    transports: text('transports'),
    /** User-facing label, e.g. "iPhone". */
    deviceName: text('device_name'),
    /** credentialBackedUp hint (synced passkey) — for UX only. */
    backedUp: boolean('backed_up').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    byUser: index('webauthn_credentials_user_idx').on(t.userId),
  }),
);
