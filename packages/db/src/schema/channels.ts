import {
  pgTable,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
  primaryKey,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './users';
import { guilds } from './guilds';
import { channelTypeEnum, overrideTargetEnum } from './enums';

// ───────────────────────────────────────────────────────────────────────────
// channels
//   - guild_text / guild_category / guild_voice  → guildId is set
//   - dm / group_dm                              → guildId is null
// ───────────────────────────────────────────────────────────────────────────

export const channels = pgTable(
  'channels',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    type: channelTypeEnum('type').notNull(),
    /** Null for DMs. */
    guildId: bigint('guild_id', { mode: 'bigint' }).references(() => guilds.id, {
      onDelete: 'cascade',
    }),
    /** Null for DMs and top-level channels. References another channel of type 'guild_category'. */
    parentId: bigint('parent_id', { mode: 'bigint' }).references(
      (): AnyPgColumn => channels.id,
      { onDelete: 'set null' },
    ),
    /** Null for DMs. Required for guild channels. */
    name: text('name'),
    topic: text('topic'),
    position: integer('position').notNull().default(0),
    nsfw: boolean('nsfw').notNull().default(false),
    /** Snowflake of the most recent message; updated on send for fast unread checks. */
    lastMessageId: bigint('last_message_id', { mode: 'bigint' }),
    /** Slowmode in seconds (0 = off). */
    rateLimitPerUser: integer('rate_limit_per_user').notNull().default(0),

    /**
     * Voice channels only: when true, voice is disabled in this channel —
     * participants join with a non-publishing LiveKit grant (mic hardware-
     * disabled at the SFU), so the channel still works as a presence /
     * hangout space but no one can talk. Ignored on non-voice channels.
     * Same enforcement path as the guild AFK channel.
     */
    voiceDisabled: boolean('voice_disabled').notNull().default(false),

    // ── Link channel ──
    /** For guild_link channels: the external URL the bookmark points to.
        Required when type='guild_link', NULL otherwise. The clicking
        UX shows a confirm-before-navigation prompt so users don't get
        whisked off-platform without consent. */
    linkUrl: text('link_url'),

    // ── Group DM extras ──
    /** Owner of a group DM (the creator). Null otherwise. */
    dmOwnerId: bigint('dm_owner_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Custom group DM icon. Null otherwise. */
    dmIconUrl: text('dm_icon_url'),

    // ── Thread extras ──
    /** For threads: the message in the parent channel that the thread
        was started from. Null for non-thread channels. The parent
        channel itself is referenced via `parentId` above (which for
        threads points at a regular text channel rather than a category). */
    parentMessageId: bigint('parent_message_id', { mode: 'bigint' }),
    /** When this thread was archived. Archived threads are read-only and
        hidden from the channel list by default. Null for active
        threads and non-thread channels. */
    threadArchivedAt: timestamp('thread_archived_at', { withTimezone: true }),
    /** Timestamp of the most recent message posted in this thread.
        Used as the start of the auto-archive countdown — sweep flips
        archived_at = now() when this + auto_archive_minutes has passed.
        Bumped by messages.createMessage when channel.type='public_thread'.
        Null for non-thread channels and archived threads (the column
        is left in place when archiving for forensic value but no
        longer driving anything). */
    threadLastActivityAt: timestamp('thread_last_activity_at', { withTimezone: true }),
    /** Per-thread auto-archive duration in minutes. Discord-standard
        durations: 60 (1h) / 1440 (1d) / 4320 (3d) / 10080 (7d). Default
        4320 set by createThread / createForumPost. Null for non-thread
        channels. */
    threadAutoArchiveMinutes: integer('thread_auto_archive_minutes'),
    /** When non-null, this thread is marked as resolved/complete.
        Soft signal — thread stays open and accepting replies, just
        renders with a checkmark + "Resolved" badge. Toggleable by
        the thread creator and anyone with MANAGE_THREADS on the
        parent forum. Null for non-thread channels and unresolved
        threads. */
    threadResolvedAt: timestamp('thread_resolved_at', {
      withTimezone: true,
    }),

    /**
     * 1:1 DM call state. These three columns track the active call (if
     * any) in this DM channel and are populated only on type='dm'
     * rows. They're cleared together when the last participant leaves
     * voice, at which point a system_call message summarizing the call
     * is written to the channel.
     *
     *   - dmActiveCallStartedAt: when the caller first joined voice in
     *     this DM (initiator's voice_state insertion).
     *   - dmActiveCallAnsweredAt: when the callee joined (the second
     *     participant). NULL until answered — used to distinguish
     *     "completed call" (answered) from "missed call" (caller hung
     *     up before the recipient joined).
     *   - dmActiveCallInitiatorId: the caller's user id, surfaced in
     *     the "Missed call from X" system message.
     */
    dmActiveCallStartedAt: timestamp('dm_active_call_started_at', { withTimezone: true }),
    dmActiveCallAnsweredAt: timestamp('dm_active_call_answered_at', { withTimezone: true }),
    dmActiveCallInitiatorId: bigint('dm_active_call_initiator_id', { mode: 'bigint' }),

    /**
     * Shared-key E2EE for DMs (1:1 only). The whole conversation
     * uses a single symmetric key derived client-side from a
     * passphrase one user picks and shares with the other out-of-
     * band. Server stores ONLY:
     *
     *   e2eeSalt — 16 random bytes (base64) used by PBKDF2 to
     *              deterministically rederive the key from the
     *              passphrase. Same on both clients; required to be
     *              public for the second client to be able to
     *              derive the same key.
     *   e2eeVerifier — SHA-256 of the derived key (base64). Lets a
     *              client confirm "I typed the right password"
     *              without exposing the password or key to the
     *              server.
     *
     * e2eeEnabled is true iff salt + verifier are populated. The
     * boolean is redundant with the not-null check but provides a
     * clear schema intent and a cheap WHERE filter.
     *
     * e2eePurgeProofHash — hex SHA-256 of the client's purgeProof
     * (base64 SHA-256(key || "zkE2EE/purge-v1")). Unlike the verifier
     * it is NEVER sent to clients, so only a key holder can produce
     * the proof that gates the purge. NULL on DMs encrypted before
     * migration 0128 (or by an old client) until a key holder
     * registers one — see services/dms.ts.
     *
     * Disabling clears all four columns AND triggers a server-side
     * purge of every zkE2EE/* message in the channel. Re-enabling
     * generates a new salt; the previous password is dead.
     */
    e2eeEnabled: boolean('e2ee_enabled').notNull().default(false),
    e2eeSalt: text('e2ee_salt'),
    e2eeVerifier: text('e2ee_verifier'),
    e2eePurgeProofHash: text('e2ee_purge_proof_hash'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    guildIdx: index('channels_guild_idx').on(t.guildId, t.position),
    parentIdx: index('channels_parent_idx').on(t.parentId),
    parentMessageIdx: index('channels_parent_message_idx').on(t.parentMessageId),
    activeThreadsIdx: index('channels_active_threads_idx')
      .on(t.threadLastActivityAt)
      .where(
        sql`type = 'public_thread' AND deleted_at IS NULL AND thread_archived_at IS NULL`,
      ),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// permission_overrides
// ───────────────────────────────────────────────────────────────────────────

export const permissionOverrides = pgTable(
  'permission_overrides',
  {
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** Either a role override or a member override. */
    targetType: overrideTargetEnum('target_type').notNull(),
    /** Role ID if targetType=role; user ID if targetType=member. */
    targetId: bigint('target_id', { mode: 'bigint' }).notNull(),
    /** Permissions to explicitly allow (added to the running bitfield). */
    allow: bigint('allow', { mode: 'bigint' }).notNull().default(sql`0`),
    /** Permissions to explicitly deny (removed from the running bitfield). */
    deny: bigint('deny', { mode: 'bigint' }).notNull().default(sql`0`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.channelId, t.targetType, t.targetId] }),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// dm_recipients  (M:N for DMs and group DMs)
// ───────────────────────────────────────────────────────────────────────────

export const dmRecipients = pgTable(
  'dm_recipients',
  {
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Per-DM E2EE public key (X25519, base64). Distinct from the
     * user's global identity key — each DM gets its own keypair on
     * the client, so enabling E2EE in DM-with-Alice doesn't affect
     * DM-with-Bob and vice-versa. Null when this user has not
     * enabled E2EE on this specific DM.
     */
    publicKey: text('public_key'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.channelId, t.userId] }),
    userIdx: index('dm_recipients_user_idx').on(t.userId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// read_states  (per-user, per-channel last-read pointer)
// ───────────────────────────────────────────────────────────────────────────

export const readStates = pgTable(
  'read_states',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** ID of the last message the user has acked as read. */
    lastMessageId: bigint('last_message_id', { mode: 'bigint' }),
    /** Mentions targeting this user since the last read; cleared on ack. */
    mentionCount: integer('mention_count').notNull().default(0),
    /** Last time the user saw the pin list (for the pin-update indicator). */
    lastPinTimestamp: timestamp('last_pin_timestamp', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.channelId] }),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// Drizzle relations
// ───────────────────────────────────────────────────────────────────────────

export const channelsRelations = relations(channels, ({ one, many }) => ({
  guild: one(guilds, { fields: [channels.guildId], references: [guilds.id] }),
  parent: one(channels, {
    fields: [channels.parentId],
    references: [channels.id],
    relationName: 'channel_parent',
  }),
  children: many(channels, { relationName: 'channel_parent' }),
  overrides: many(permissionOverrides),
  recipients: many(dmRecipients),
}));

export const permissionOverridesRelations = relations(permissionOverrides, ({ one }) => ({
  channel: one(channels, {
    fields: [permissionOverrides.channelId],
    references: [channels.id],
  }),
  // Note: targetId polymorphism is application-side; no FK because it could
  // point to either roles or users.
}));

export const dmRecipientsRelations = relations(dmRecipients, ({ one }) => ({
  channel: one(channels, { fields: [dmRecipients.channelId], references: [channels.id] }),
  user: one(users, { fields: [dmRecipients.userId], references: [users.id] }),
}));

export const readStatesRelations = relations(readStates, ({ one }) => ({
  user: one(users, { fields: [readStates.userId], references: [users.id] }),
  channel: one(channels, { fields: [readStates.channelId], references: [channels.id] }),
}));

// ───────────────────────────────────────────────────────────────────────────
// ───────────────────────────────────────────────────────────────────────────
// voice_states  (one row per user currently in a voice channel)
// ───────────────────────────────────────────────────────────────────────────
//
// Voice presence is purely server-tracked: the row exists iff the user is
// currently connected to that channel's voice room. Inserted on join,
// deleted on leave (gateway disconnect or explicit leave). NEVER multiple
// rows per user — joining a different voice channel must DELETE the old
// row and INSERT the new (the unique constraint on userId enforces this).
//
// The `sessionId` column is opaque to us; it's whatever ID the WebRTC SFU
// uses to identify the participant. We store it so we can reconcile
// participant-left webhooks against the right voice_state row even if the
// user has multiple devices that happen to be in different rooms (a thing
// we don't currently support, but will).

export const voiceStates = pgTable(
  'voice_states',
  {
    /** One voice connection per user (server-side enforced via PK). */
    userId: bigint('user_id', { mode: 'bigint' })
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Voice channel they're currently in. */
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /**
     * Convenience denormalization — guildId is on channels too. Null
     * for DM voice (1-on-1 calls have no guild context); the fanout
     * audience for those is the dm_recipients set instead of guild
     * members.
     */
    guildId: bigint('guild_id', { mode: 'bigint' })
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** Opaque SFU session id for webhook reconciliation. */
    sessionId: text('session_id').notNull(),
    /** Self-mute (microphone off, others see them muted). */
    selfMute: boolean('self_mute').notNull().default(false),
    /**
     * When the user's CURRENT continuous self-mute began (set on the
     * false→true transition, cleared to null on unmute). The AFK
     * auto-move sweep uses this: a user self-muted longer than the
     * guild's afkTimeoutSeconds gets relocated to the AFK channel.
     * Null whenever the user is not self-muted.
     */
    selfMuteAt: timestamp('self_mute_at', { withTimezone: true }),
    /** Self-deafen (also doesn't hear others; implies selfMute=true). */
    selfDeaf: boolean('self_deaf').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The channel a moderator move or the AFK sweep took the user OUT of,
     * kept until their own next join. A client that can't follow a move
     * (it never rejoins) still hangs up naming that channel; the scoped
     * leave route matches it here so the hang-up ends the call instead of
     * stranding the row in the channel they were moved to. Across several
     * moves without a rejoin it keeps the FIRST channel — the one that
     * client still thinks it's in. Null after any join.
     */
    movedFromChannelId: bigint('moved_from_channel_id', { mode: 'bigint' }),
  },
  (t) => ({
    byChannel: index('voice_states_by_channel_idx').on(t.channelId),
    byGuild: index('voice_states_by_guild_idx').on(t.guildId),
  }),
);

/**
 * Per-user voice participation counters, maintained by the voice service at
 * join/leave (voice_states rows are live-only, so nothing else records that a
 * session happened). Powers the first_contact / event_horizon achievements.
 * Best-effort: a crash/eviction between join and leave drops that segment's
 * seconds; joins are counted at join time.
 */
export const userVoiceStats = pgTable('user_voice_stats', {
  userId: bigint('user_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  joins: integer('joins').notNull().default(0),
  totalSeconds: bigint('total_seconds', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ───────────────────────────────────────────────────────────────────────────
// stage_participants (Discord-style stage / town-hall channels)
// ───────────────────────────────────────────────────────────────────────────
//
// Stage channels split participants into SPEAKERS (can broadcast audio)
// and AUDIENCE (subscribe-only). Audience members can RAISE A HAND to
// request promotion; moderators (channel-MANAGE_CHANNELS holders) flip
// the speaker bit and the LiveKit token gets re-issued with publish
// permission.
//
// Rows are short-lived: created on stage join, deleted on leave. We
// store separately from `voice_states` so the audience-vs-speaker
// distinction stays explicit and stage-only logic doesn't pollute the
// voice path.

export const stageParticipants = pgTable(
  'stage_participants',
  {
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** True = speaker (publish-allowed), false = audience (subscribe-only).
        New joiners default to false unless they're a stage moderator
        (the join handler grants instant speaker on first-ever join to
        an empty stage so the host isn't stuck as audience). */
    isSpeaker: boolean('is_speaker').notNull().default(false),
    /** Audience-only flag — set when the user clicks "raise hand" to
        request speaker. Cleared on promotion or on lower-hand. The
        list of raised hands shows mods who's asking. */
    handRaised: boolean('hand_raised').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.channelId, t.userId] }),
    byChannel: index('stage_participants_by_channel_idx').on(t.channelId),
    byUser: index('stage_participants_by_user_idx').on(t.userId),
  }),
);

/**
 * Per-DM settings. Currently only carries the auto-delete TTL; the
 * row exists for any DM channel where any setting has ever been
 * non-default. A missing row means "all defaults" — auto-delete off,
 * etc. Either recipient can mutate the row; the change applies to
 * both sides since it's a property of the conversation.
 */
export const dmSettings = pgTable('dm_settings', {
  channelId: bigint('channel_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  /**
   * NULL = no auto-delete (default). Positive integer = seconds after
   * the first non-author recipient views the message before the sweep
   * soft-deletes it. Typical values: 30, 60, 120.
   */
  ttlSecondsAfterRead: integer('ttl_seconds_after_read'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-RECIPIENT push-notification preview preference for a DM. Unlike
 * dm_settings (conversation-scoped — both sides share), this is private to
 * each user, since it controls THEIR device's lock-screen exposure.
 *
 * A row's mere presence is an explicit choice:
 *   - show_content = true  → show the sender + message content (or, for an
 *     E2EE DM, reveal the sender name; the body stays generic server-side
 *     because the server only holds ciphertext — a Notification Service
 *     Extension would decrypt it on-device).
 *   - show_content = false → generic "New message" only.
 * No row → the default (E2EE DMs generic, plaintext DMs show content),
 * preserving today's behavior until the user opts in/out.
 */
export const dmNotificationPrefs = pgTable(
  'dm_notification_prefs',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    showContent: boolean('show_content').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.channelId] }) }),
);

// ───────────────────────────────────────────────────────────────────────────
// Inferred types
// ───────────────────────────────────────────────────────────────────────────

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type PermissionOverride = typeof permissionOverrides.$inferSelect;
export type NewPermissionOverride = typeof permissionOverrides.$inferInsert;
export type DMRecipient = typeof dmRecipients.$inferSelect;
export type ReadState = typeof readStates.$inferSelect;
export type NewReadState = typeof readStates.$inferInsert;
export type VoiceState = typeof voiceStates.$inferSelect;
export type NewVoiceState = typeof voiceStates.$inferInsert;
export type StageParticipant = typeof stageParticipants.$inferSelect;
export type NewStageParticipant = typeof stageParticipants.$inferInsert;
export type DmSettings = typeof dmSettings.$inferSelect;
export type NewDmSettings = typeof dmSettings.$inferInsert;
