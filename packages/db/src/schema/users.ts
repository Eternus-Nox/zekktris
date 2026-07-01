import {
  pgTable,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
  date,
  primaryKey,
  uniqueIndex,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { userStatusEnum, relationshipTypeEnum, notificationTargetEnum, notificationLevelEnum } from './enums';

/** Stored shape of a single rail folder on the `users.guild_folders`
    JSONB column. Public API DTO mirrors this with the same shape. */
export interface GuildFolderRow {
  id: string;
  name: string;
  color: string | null;
  guildIds: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// users
// ───────────────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    /** Lowercased; unique account handle. */
    username: text('username').notNull(),
    /** Free-form display name. */
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** Date of birth (YYYY-MM-DD), collected at signup. Drives the 13+ age
        gate and the minor-supervision lifecycle (13–17 supervised, released
        at 18 — age is derived from this on the fly, no separate flag). Stored
        as a SQL `date` (no time/zone). Nullable: accounts created before this
        field have none on record; new signups always supply it. */
    dateOfBirth: date('date_of_birth'),
    /** Once true, the user can't change their own DOB (admin reset only).
        Defaults true so new signups lock immediately; legacy accounts were
        unlocked by migration 0096 for a single self-correction. */
    dobLocked: boolean('dob_locked').notNull().default(true),
    avatarUrl: text('avatar_url'),
    bannerUrl: text('banner_url'),
    bio: text('bio'),
    /** Cosmetic avatar decoration id (a CSS ring/glow overlay rendered by the
     *  client from a preset registry). NULL / 'none' = no decoration. */
    avatarDecoration: text('avatar_decoration'),
    /** Last status the user actively set; what others see when online. */
    status: userStatusEnum('status').notNull().default('offline'),
    customStatus: text('custom_status'),
    /** Instance-level admin (server owner / operator), not per-guild. */
    isAdmin: boolean('is_admin').notNull().default(false),
    /** Achievements visibility: false = only the owner sees them. */
    achievementsPublic: boolean('achievements_public').notNull().default(false),
    /** True for bot accounts. Bots are real user rows that authenticate
        via a static bot token rather than password+JWT. Drives the BOT
        badge + bot-only/human-only behavior gates. */
    isBot: boolean('is_bot').notNull().default(false),
    /** For bots: the human user who owns + manages this bot. Null for
        humans. Cascade-deletes the bot when its owner is deleted. */
    botOwnerId: bigint('bot_owner_id', { mode: 'bigint' }),
    /** For bots: SHA-256 hex of the API token. Only the hash is stored;
        plaintext shown once at creation/regenerate. Null for humans. */
    botTokenHash: text('bot_token_hash'),
    /** For bots with event delivery: HTTPS callback the server POSTs
        events to. Null = REST-only bot (no event subscription). */
    botEventUrl: text('bot_event_url'),
    /** For bots with event delivery: HMAC-SHA256 signing secret. The
        bot verifies the X-Zekktris-Signature header against this. */
    botEventSecret: text('bot_event_secret'),
    /** Locale tag, e.g. 'en-US'. Used for date/time formatting. */
    locale: text('locale').notNull().default('en-US'),
    /** Per-user guild rail ordering — array of guild-id strings in
        the user's preferred display order. Null = no preference,
        client falls back to the natural API order. Stored as JSONB
        for atomic whole-list writes; the list is small enough that
        a separate (user, guild, position) row would be overkill. */
    guildOrder: jsonb('guild_order').$type<string[] | null>(),
    /** Per-user rail folders. Each folder bundles a set of guild
        ids under a named, optionally colored container in the rail.
        Stored as JSONB (rather than a separate folders table) for
        the same atomicity + small-list reasons as guildOrder above.
        Shape: Array<{ id, name, color, guildIds }>. The folder's
        position in the rail is derived from its first member guild's
        position in guildOrder — we don't store folder ordinals
        separately to keep the data model simple. */
    guildFolders: jsonb('guild_folders').$type<GuildFolderRow[]>().notNull().default([]),
    /** Synced voice preferences. Stores the whole VoicePrefsState
        client-side blob: master/mic gains, processing flags, gain
        mode, and per-user volume/mute overrides. The shape is owned
        by apps/web; the API just persists and returns it as opaque
        JSONB. Default empty object — clients merge their local
        defaults on read. Small enough (a few KB even with hundreds
        of per-user entries) that a separate table would be
        over-engineered, and the entire blob is read/written together
        on settings load + save anyway. */
    voicePrefs: jsonb('voice_prefs').notNull().default({}),
    /* Per-user DM read-receipt opt-out. Defaults to true (receipts
       on) for new accounts. When false, this user becomes invisible
       to the sender's receipt tracking — neither delivered nor
       viewed timestamps get stamped on messages this user receives,
       so the sender sees "Sent" forever. The toggle is reciprocal:
       turning it off ALSO hides the sender's status from this user.
       Matches iMessage's "Send Read Receipts" semantics. Applies
       to 1:1 DMs only — group DMs don't surface receipts. */
    dmReadReceiptsEnabled: boolean('dm_read_receipts_enabled').notNull().default(true),
    /* Mentions inbox watermark. The id of the most recent message that
       existed at the moment this user last tapped "Clear all" on the
       Mentions inbox. listUserMentions filters to id > watermark to
       hide everything the user already dismissed across reloads;
       newly-arriving mentions (with a higher id) still surface
       normally. NULL means "never cleared" — the default for fresh
       accounts. */
    mentionsClearedMessageId: bigint('mentions_cleared_message_id', { mode: 'bigint' }),
    /* Two-factor authentication (TOTP). `totpSecret` is base32-encoded
       and stored verbatim — TOTP secrets ARE the credential, so
       additional at-rest encryption only protects against narrow
       threat models. `totpEnabled` flips to true only after the
       user has confirmed a valid 6-digit code with the freshly-
       issued secret; this prevents half-finished setups from
       blocking login. `totpVerifiedAt` records the most-recent
       successful TOTP check for audit logs. */
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    totpVerifiedAt: timestamp('totp_verified_at', { withTimezone: true }),
    /** Instance-level ban marker. Null = normal user. When set, the
        login flow rejects the credentials with a generic "account
        disabled" response. Soft-ban (timestamp) rather than hard
        delete preserves message attribution and audit trails. */
    bannedAt: timestamp('banned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete; set when the user deletes their account. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** Anchor for the 90-day username-change cooldown. Null = the
        user has never changed their username; service treats
        (now() - usernameChangedAt) >= 90d as eligible. */
    usernameChangedAt: timestamp('username_changed_at', {
      withTimezone: true,
    }),
    /**
     * Custom status enhancement (v1.68). The pre-existing
     * `customStatus` text column above stores the text portion;
     * these two additions surround it with an emoji and an
     * optional auto-clear timestamp:
     *
     *   customStatusEmoji:     a unicode emoji or short code,
     *                          e.g. "📚" or ":books:"
     *   customStatusExpiresAt: optional auto-clear time. Client
     *                          treats any past timestamp as "no
     *                          status set," so we don't need a
     *                          server cleanup job to enforce it.
     *
     * Either text-only or emoji-only states are valid.
     */
    customStatusEmoji: text('custom_status_emoji'),
    customStatusExpiresAt: timestamp('custom_status_expires_at', {
      withTimezone: true,
    }),
    /**
     * Custom name tag ("clan tag") — a small pill rendered IN FRONT of
     * the user's name everywhere it appears (messages, member list,
     * profile, DM list). Both parts are optional and independent:
     *   tagLabel  — up to 4 characters of text (NULL = no text)
     *   tagColor  — hex color (e.g. #3dd7ec) for the pill (NULL = accent)
     * The tag renders only when a label is set. (An emoji part existed
     * briefly; removed in migration 0090 — labels only.)
     */
    tagLabel: text('tag_label'),
    tagColor: text('tag_color'),
    /**
     * Privacy preference controlling who can open a DM with this user
     * and ring them for a 1:1 call.
     *
     *   - false (default): friends-only. Only users with a 'friend'
     *     relationship row in BOTH directions can DM or call.
     *   - true: also accepts DMs/calls from anyone who shares at least
     *     one guild with this user.
     *
     * Blocks always take precedence over both — a blocked user can't
     * DM/call regardless of this setting, and the recipient never
     * appears in the blocker's relationships UI.
     *
     * Enforced server-side at DM creation (dms.getOrCreateDM) and at
     * voice join time for 1:1 DM channels (voice.joinVoice). Existing
     * DMs are NOT retroactively closed when this is flipped to false;
     * the setting gates NEW conversations and call initiations.
     */
    allowDmsFromServerMembers: boolean('allow_dms_from_server_members')
      .notNull()
      .default(false),
    /**
     * E2EE identity: per-user X25519 public key, base64-encoded.
     *
     * Generated client-side (tweetnacl) the first time the user sends
     * to a DM; uploaded via PATCH /users/@me. The matching private key
     * is stored exclusively in the sender's localStorage and never
     * leaves the device. Server treats this as opaque text — the
     * encrypt/decrypt happens entirely on the client.
     *
     * Encryption uses crypto_box's precomputed-shared-key flavor:
     * shared = X25519(theirPub, myPriv) — symmetric on both sides, so
     * the sender can also decrypt their own past messages without
     * having to store a self-copy. Nonce is 24 random bytes per
     * message, prepended to the ciphertext.
     *
     * Nullable: users who haven't yet sent a DM have no key. When the
     * recipient of a fresh conversation has no key, the sender's
     * client falls back to plaintext (best-effort: a partial E2EE
     * rollout is better than no rollout).
     */
    publicKey: text('public_key'),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    usernameIdx: uniqueIndex('users_username_idx').on(t.username),
    // Bot-token auth runs this equality lookup in the auth middleware on
    // every bot REST call. Created by migration 0049; declared here so a
    // future drizzle-kit generate/push doesn't drop it.
    botTokenHashIdx: uniqueIndex('users_bot_token_hash_idx')
      .on(t.botTokenHash)
      .where(sql`bot_token_hash IS NOT NULL`),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// sessions
// ───────────────────────────────────────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the opaque refresh token (never store the token itself). */
    refreshTokenHash: text('refresh_token_hash').notNull(),
    userAgent: text('user_agent'),
    /** IPv4 /24 or IPv6 /48 truncated for privacy. */
    ipAddress: text('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    refreshIdx: uniqueIndex('sessions_refresh_idx').on(t.refreshTokenHash),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// relationships  (friends + blocks)
// ───────────────────────────────────────────────────────────────────────────
//
// Relationships are stored from the perspective of `userId`. When user A
// requests user B as a friend:
//   (A, B, 'outgoing_request')
//   (B, A, 'incoming_request')
// On accept, both rows become 'friend'. On block, only one row exists:
//   (A, B, 'blocked')   ← any inverse rows are deleted by the API.

export const relationships = pgTable(
  'relationships',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetId: bigint('target_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: relationshipTypeEnum('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.targetId] }),
    targetIdx: index('relationships_target_idx').on(t.targetId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// password_resets
// ───────────────────────────────────────────────────────────────────────────
//
// Single-use password reset tokens. Created by POST /auth/forgot-password,
// consumed by POST /auth/reset-password. Plain token (32 random bytes,
// URL-safe base64) is mailed to the user; only the SHA-256 hash is
// stored here, so a DB read can't recover working reset codes.
//
// We don't delete used or expired rows immediately — keeping the row
// with `used_at` set acts as a tamper-evident record (if the same
// token was used twice, the second attempt fails because the hash
// lookup finds a row with used_at != null). A periodic GC could
// prune rows older than ~30 days; for v1 the table is small enough
// that it's not worth scheduling.

export const passwordResets = pgTable(
  'password_resets',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the plaintext token sent in the email.
        Plaintext is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on successful reset. Re-using the same token (e.g. clicking
        the email link twice) fails because the lookup-by-hash query
        gates on used_at IS NULL. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('password_resets_token_idx').on(t.tokenHash),
    userIdx: index('password_resets_user_idx').on(t.userId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// email_verifications
// ───────────────────────────────────────────────────────────────────────────
//
// Single-use signup email-verification tokens. Created at registration
// (and on resend) when email is configured; consumed by POST
// /auth/verify-email, which flips users.email_verified to true. Same
// hash-only storage posture as password_resets.
export const emailVerifications = pgTable(
  'email_verifications',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the plaintext token sent in the email. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('email_verifications_token_idx').on(t.tokenHash),
    userIdx: index('email_verifications_user_idx').on(t.userId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// email_change_requests
// ───────────────────────────────────────────────────────────────────────────
//
// Single-use email-change verification tokens. Created when a logged-in
// user submits a desired new email + their current password to the
// change endpoint. The server mails a verification link to the NEW
// address; clicking it consumes the token and applies the email update.
//
// Same security posture as password_resets: only the hash of the
// plaintext token is stored, so a DB compromise can't be used to
// fast-forward email changes for arbitrary users.
//
// Why verify the new email rather than the old: the user might be
// changing emails BECAUSE they lost access to the old one. Sending the
// verification to the old address would lock them out of the very
// migration the feature exists to support.

export const emailChangeRequests = pgTable(
  'email_change_requests',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the plaintext token in the verification link. */
    tokenHash: text('token_hash').notNull(),
    /** Target address. Lowercased + validated at request time;
        uniqueness re-checked at confirm time (another user might
        have grabbed the address in the meantime). */
    newEmail: text('new_email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on successful confirm. Re-using the link fails because
        the find-by-hash query gates on used_at IS NULL. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('email_change_requests_token_idx').on(t.tokenHash),
    userIdx: index('email_change_requests_user_idx').on(t.userId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// Drizzle relations (for query convenience; not constraints)
// ───────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  outgoingRelationships: many(relationships, { relationName: 'rel_user' }),
  incomingRelationships: many(relationships, { relationName: 'rel_target' }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const relationshipsRelations = relations(relationships, ({ one }) => ({
  user: one(users, {
    fields: [relationships.userId],
    references: [users.id],
    relationName: 'rel_user',
  }),
  target: one(users, {
    fields: [relationships.targetId],
    references: [users.id],
    relationName: 'rel_target',
  }),
}));

// ───────────────────────────────────────────────────────────────────────────
// Inferred types for use throughout the codebase
// ───────────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Relationship = typeof relationships.$inferSelect;
export type NewRelationship = typeof relationships.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// signup_codes
// ───────────────────────────────────────────────────────────────────────────
//
// Used when ALLOW_REGISTRATION=invite-only. An admin issues codes; new
// users must supply a valid, unused, unexpired code at registration. If
// `email` is set, the code is bound to that email address.

export const signupCodes = pgTable(
  'signup_codes',
  {
    code: text('code').primaryKey(),
    /** Admin who issued this code. Null if that admin's account was deleted. */
    issuerId: bigint('issuer_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** If set, only this email can redeem this code. */
    email: text('email'),
    note: text('note'),
    /** How many registrations this code can authorize. */
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    /** Null = never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    issuerIdx: index('signup_codes_issuer_idx').on(t.issuerId),
  }),
);

export type SignupCode = typeof signupCodes.$inferSelect;
export type NewSignupCode = typeof signupCodes.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// push_subscriptions
// ───────────────────────────────────────────────────────────────────────────
//
// One row per browser/device the user has opted into Web Push from. The
// `endpoint` is opaque per-browser (Chrome/Firefox/Safari each generate
// their own URL) and serves as the unique identity for the subscription.
// `p256dh` + `auth` are public key material the server signs payloads
// with; `web-push` library wants both verbatim.

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Browser-issued push endpoint URL. Unique per device. */
    endpoint: text('endpoint').notNull(),
    /** Subscription public key (base64url, untouched). */
    p256dh: text('p256dh').notNull(),
    /** Subscription auth secret (base64url, untouched). */
    auth: text('auth').notNull(),
    /** Free-form, e.g. "MacBook · Chrome 142" — surfaced in settings. */
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bumped every time we successfully send to this endpoint; used for
        eventual cleanup of stale subscriptions. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('push_subscriptions_user_idx').on(t.userId),
    // Unique on endpoint so re-subscribing from the same browser
    // overwrites the existing row instead of creating duplicates.
    endpointIdx: uniqueIndex('push_subscriptions_endpoint_idx').on(t.endpoint),
  }),
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// apns_device_tokens  (native iOS push via APNs)
// ───────────────────────────────────────────────────────────────────────────
//
// One row per iOS device the user has registered for native push from the
// Capacitor app. Kept separate from `push_subscriptions` (browser Web Push)
// because APNs uses an opaque device-token string and a different delivery
// transport (HTTP/2 to Apple) — the two can't share a table or a send path,
// and Web Push doesn't work inside the iOS WKWebView at all. The token is
// unique server-wide so a device re-registering upserts cleanly.

export const apnsDeviceTokens = pgTable(
  'apns_device_tokens',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** APNs device token (hex string from the registration event). Unique. */
    token: text('token').notNull(),
    /** Platform discriminator — only 'ios' today, room to grow. */
    platform: text('platform').notNull().default('ios'),
    /** Free-form, e.g. "iPhone" — surfaced in the manage-devices list. */
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bumped on every successful send; used for stale-token cleanup. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('apns_device_tokens_user_idx').on(t.userId),
    // Unique on token so re-registering the same device overwrites the row.
    tokenIdx: uniqueIndex('apns_device_tokens_token_idx').on(t.token),
  }),
);

export type ApnsDeviceToken = typeof apnsDeviceTokens.$inferSelect;
export type NewApnsDeviceToken = typeof apnsDeviceTokens.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// notification_overrides  (per-user mute / level overrides for guilds + channels)
// ───────────────────────────────────────────────────────────────────────────
//
// Two-tier model that matches Discord's UX:
//   - Guild override: applies to every channel in the guild unless
//     overridden by a per-channel row.
//   - Channel override: takes precedence for that channel.
//
// `level` controls how aggressively notifications surface; v1 only uses
// `nothing` ("mute") in practice but the column is wide enough to add
// "mentions only" / "all" toggles later without a migration.
//
// PK is (user_id, target_type, target_id) so each user has at most one
// row per target. Updates upsert via ON CONFLICT in the service.

export const notificationOverrides = pgTable(
  'notification_overrides',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: notificationTargetEnum('target_type').notNull(),
    /** Guild id or channel id depending on `targetType`. We don't FK
        this — channels and guilds are different tables and Postgres
        doesn't support polymorphic FKs cleanly. The service keeps it
        consistent. */
    targetId: bigint('target_id', { mode: 'bigint' }).notNull(),
    level: notificationLevelEnum('level').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.targetType, t.targetId] }),
    targetIdx: index('notification_overrides_target_idx').on(t.targetType, t.targetId),
    // Backs resolveLevelsBulk's hot path (every mentioned message): filters
    // (user_id, target_id) skipping target_type, so the PK's user_id prefix
    // alone can't seek target_id. This composite covers it directly.
    userTargetIdx: index('notification_overrides_user_target_idx').on(t.userId, t.targetId),
    // Backs listChannelAllSubscribers (every non-DM guild message's push
    // fan-out): WHERE target_id IN (channelId, guildId), filtering on
    // target_id ALONE. None of the indexes above lead with target_id (they
    // lead with target_type or user_id), so that query seq-scanned the whole
    // table. NOT a partial WHERE level='all' index — the query post-filters
    // level in JS (channel-override precedence needs to see non-'all' rows),
    // so a level-predicated partial index would be unusable by the planner.
    targetOnlyIdx: index('notification_overrides_target_id_idx').on(t.targetId),
  }),
);

export type NotificationOverride = typeof notificationOverrides.$inferSelect;
export type NewNotificationOverride = typeof notificationOverrides.$inferInsert;

// ───────────────────────────────────────────────────────────────────────────
// userRecoveryCodes
// ───────────────────────────────────────────────────────────────────────────
//
// One-shot bypass codes generated during 2FA enrollment. The user is shown
// the plaintext exactly once; only the sha256 hash is persisted. On use
// we mark the row by setting `usedAt`, leaving it in place for audit but
// rejecting reuse.

export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.codeHash] }),
    userIdx: index('user_recovery_codes_user_id_idx').on(t.userId),
  }),
);

export type UserRecoveryCode = typeof userRecoveryCodes.$inferSelect;
