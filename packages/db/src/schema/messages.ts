import {
  pgTable,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
  primaryKey,
  index,
  jsonb,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './users';
import { channels } from './channels';
import { roles } from './guilds';
import { messageTypeEnum } from './enums';

// ───────────────────────────────────────────────────────────────────────────
// messages
// ───────────────────────────────────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /**
     * Null only if the author was hard-deleted. The message is preserved
     * with a tombstoned author so the channel history doesn't gap.
     */
    authorId: bigint('author_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    type: messageTypeEnum('type').notNull().default('default'),
    content: text('content').notNull().default(''),
    /** Reference to the message being replied to. */
    replyToId: bigint('reply_to_id', { mode: 'bigint' }).references(
      (): AnyPgColumn => messages.id,
      { onDelete: 'set null' },
    ),
    /** True if the message has been pinned in this channel. */
    pinned: boolean('pinned').notNull().default(false),
    /** Set when the message has been edited; same value as updated_at. */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Soft delete; row is kept so reply chains remain navigable. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * First time a non-author participant in this DM channel viewed the
     * message. Only stamped for messages in DMs that have an auto-delete
     * TTL configured (see dm_settings). NULL means either:
     *   - the message lives in a channel without auto-delete, OR
     *   - the message lives in an auto-delete DM but the other party
     *     hasn't fetched it yet.
     * Once stamped, the sweep deletes the message after
     * `dm_settings.ttl_seconds_after_read` seconds have elapsed.
     */
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    /**
     * DM delivery tracking. Stamped once when the recipient's first
     * gateway connection receives the MESSAGE_CREATE dispatch — or, if
     * no recipient was connected at send time, on the recipient's next
     * IDENTIFY backfill. NULL until then.
     *
     * Used by the read-receipt UI to show Sent → Delivered → Read
     * under the sender's last message in a 1:1 DM. Suppressed when
     * the recipient has `dm_read_receipts_enabled = false` — that
     * privacy toggle makes the recipient invisible to the sender's
     * receipt tracking entirely, matching iMessage semantics.
     *
     * Guild messages never set this; the column stays NULL for them.
     */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Precomputed for fast unread-mention queries. */
    mentionsEveryone: boolean('mentions_everyone').notNull().default(false),
    /** Precomputed for fast unread-mention queries. */
    mentionsHere: boolean('mentions_here').notNull().default(false),
    /** When set, this message is a forward of another message. The
        renderer displays a quoted block with the source's content +
        an attribution line ("Forwarded from #channel"). The forwarded
        message can also have its own content (the forwarder's
        comment). Cascade is intentionally NOT set: if the source gets
        deleted we want the forward to remain with a "[unavailable]"
        placeholder rather than disappear silently from history. */
    forwardedFromMessageId: bigint('forwarded_from_message_id', { mode: 'bigint' }),
    /** When set, this message was posted by a webhook. The webhookId is
        the id from the webhooks table. The authorId still points to the
        webhook's owner (createdBy) so audit + mention counts work, but
        the rendered username/avatar come from authorOverride* below. */
    webhookId: bigint('webhook_id', { mode: 'bigint' }),
    /** Display name override for webhook-posted messages. The webhook's
        name is used by default; a per-execute `username` field in the
        request body overrides for that one message. Null for non-webhook
        messages. */
    authorOverrideName: text('author_override_name'),
    /** Avatar URL override for webhook-posted messages. Same precedence
        rules as authorOverrideName. */
    authorOverrideAvatar: text('author_override_avatar'),
    /**
     * Single sticker attachment. When set, the message renders the
     * sticker as the body (≈160px) — text content is allowed alongside
     * but typically empty. Stickers can't combine with attachments or
     * polls in the same message; the route layer enforces this.
     *
     * Cascade is intentionally NOT set: if the sticker gets deleted
     * after the message was sent, the message stays with a "[sticker
     * unavailable]" placeholder rather than disappearing from history.
     */
    stickerId: bigint('sticker_id', { mode: 'bigint' }),
    /**
     * Resolved link previews (Open Graph / Twitter Card metadata) for
     * any http(s) URLs in the content. Populated asynchronously after
     * message create — the message is broadcast immediately, then the
     * embed fetcher resolves URLs (with SSRF protection + size/time
     * caps) and a MESSAGE_UPDATE arrives with this column populated.
     *
     * Stored as JSON because the shape evolves (image / video / article
     * / file types) without schema churn.
     *
     * Empty array = "no URLs in the message OR all fetches failed."
     * Null is reserved for "embed resolution hasn't run yet" — clients
     * render a discreet "loading preview…" hint in that case (or just
     * leave the slot empty for v1, which is what we currently do).
     */
    embeds: jsonb('embeds').$type<MessageEmbedJson[] | null>().default(null),
    /**
     * Structured metadata for system messages and other special types.
     * NULL for ordinary messages. Currently used by:
     *
     *   - system_call: { missed: boolean, durationMs: number,
     *                    initiatorId: string }
     *     where `durationMs` is the answered-to-ended span in
     *     milliseconds (0 when missed=true), and `initiatorId` is the
     *     caller's user id stringified (BigInts don't survive JSON).
     *
     * Future system messages should reuse this column rather than
     * adding new typed columns — keeps the schema narrow and the
     * client-side render switch can read this directly.
     */
    metadata: jsonb('metadata').$type<MessageMetadataJson | null>().default(null),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Primary read pattern: latest N messages in a channel, paginated. */
    channelTimeIdx: index('messages_channel_time_idx').on(t.channelId, t.id),
    authorIdx: index('messages_author_idx').on(t.authorId),
    /** Pin-panel lookups (`WHERE channel_id = ? AND pinned AND deleted_at
     *  IS NULL`). Partial — pinned rows are a tiny fraction of messages, so
     *  a full (channel_id, pinned) btree was near-table-sized for no
     *  selectivity gain. Matches migration 0077. */
    pinnedIdx: index('messages_pinned_idx')
      .on(t.channelId)
      .where(sql`pinned AND deleted_at IS NULL`),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// attachments
// ───────────────────────────────────────────────────────────────────────────

export const attachments = pgTable(
  'attachments',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    url: text('url').notNull(),
    /** For images and videos. Null for other types. */
    width: integer('width'),
    height: integer('height'),
    /**
     * True when this attachment is a voice message recorded inline by
     * the user. Renderers replace the generic file-attachment chip
     * with a custom playback control (play/pause + waveform + duration).
     * Voice messages are subject to extra UX rules: one per message,
     * no text content alongside (the audio is the body).
     */
    isVoiceMessage: boolean('is_voice_message').notNull().default(false),
    /**
     * Duration in seconds (float). Computed client-side during
     * recording; the server trusts the value (a malicious client
     * sending a wrong duration just gets a wrong-duration display
     * — no security implication). Null for non-voice attachments.
     */
    durationSeconds: integer('duration_seconds'),
    /**
     * Waveform preview — base64 of a small Uint8Array (typically 32-64
     * bytes) where each byte is a normalized sample (0-255) from the
     * audio's volume envelope. Renderers draw this as bars beneath the
     * playback control; the audio file itself is the source of truth
     * for actual playback. Null for non-voice attachments.
     */
    waveform: text('waveform'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Stamped by the periodic compression sweep once it has evaluated
     * this row — either after successfully re-encoding the file at
     * lower quality, OR after determining the row isn't a compression
     * candidate (GIF, non-image, already small). Either way the column
     * being non-null tells the sweep "don't look at this again." NULL
     * means "eligible for evaluation once it reaches the age cutoff."
     */
    compressedAt: timestamp('compressed_at', { withTimezone: true }),
  },
  (t) => ({
    messageIdx: index('attachments_message_idx').on(t.messageId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// reactions
// ───────────────────────────────────────────────────────────────────────────
//
// `emoji` for v1 stores the raw unicode codepoint (e.g. "❤️") or the unified
// shortcode (e.g. ":heart:"). When custom server emoji land in v1.x, we'll
// add an `emoji_id` column referencing a guild_emojis table; until then this
// remains a single text column.

export const reactions = pgTable(
  'reactions',
  {
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    /** For aggregating reactions per message. */
    messageEmojiIdx: index('reactions_message_emoji_idx').on(t.messageId, t.emoji),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// message_user_mentions
// ───────────────────────────────────────────────────────────────────────────

export const messageUserMentions = pgTable(
  'message_user_mentions',
  {
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId] }),
    /** "Show me my unread mentions" query. */
    userIdx: index('message_user_mentions_user_idx').on(t.userId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// message_role_mentions
// ───────────────────────────────────────────────────────────────────────────

export const messageRoleMentions = pgTable(
  'message_role_mentions',
  {
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    roleId: bigint('role_id', { mode: 'bigint' })
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.roleId] }),
    roleIdx: index('message_role_mentions_role_idx').on(t.roleId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// Drizzle relations
// ───────────────────────────────────────────────────────────────────────────

export const messagesRelations = relations(messages, ({ one, many }) => ({
  channel: one(channels, { fields: [messages.channelId], references: [channels.id] }),
  author: one(users, { fields: [messages.authorId], references: [users.id] }),
  replyTo: one(messages, {
    fields: [messages.replyToId],
    references: [messages.id],
    relationName: 'message_reply',
  }),
  attachments: many(attachments),
  reactions: many(reactions),
  userMentions: many(messageUserMentions),
  roleMentions: many(messageRoleMentions),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message: one(messages, { fields: [attachments.messageId], references: [messages.id] }),
}));

export const reactionsRelations = relations(reactions, ({ one }) => ({
  message: one(messages, { fields: [reactions.messageId], references: [messages.id] }),
  user: one(users, { fields: [reactions.userId], references: [users.id] }),
}));

export const messageUserMentionsRelations = relations(messageUserMentions, ({ one }) => ({
  message: one(messages, {
    fields: [messageUserMentions.messageId],
    references: [messages.id],
  }),
  user: one(users, { fields: [messageUserMentions.userId], references: [users.id] }),
}));

export const messageRoleMentionsRelations = relations(messageRoleMentions, ({ one }) => ({
  message: one(messages, {
    fields: [messageRoleMentions.messageId],
    references: [messages.id],
  }),
  role: one(roles, { fields: [messageRoleMentions.roleId], references: [roles.id] }),
}));

// ───────────────────────────────────────────────────────────────────────────
// Inferred types
// ───────────────────────────────────────────────────────────────────────────

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type Reaction = typeof reactions.$inferSelect;
export type NewReaction = typeof reactions.$inferInsert;
export type MessageUserMention = typeof messageUserMentions.$inferSelect;
export type MessageRoleMention = typeof messageRoleMentions.$inferSelect;

/**
 * Shape of an embed row in messages.embeds (jsonb). Open Graph and
 * Twitter Card-derived metadata, plus a `kind` discriminator for
 * renderer dispatch:
 *   - 'link'    — generic web page; renders a card with title, desc, image
 *   - 'image'   — direct image URL; renders inline (no scrape needed)
 *   - 'video'   — direct video URL; renders with playback controls
 *
 * For v1 we only generate 'link' embeds (the most common case);
 * future passes can add direct-asset detection by Content-Type.
 */
export interface MessageEmbedJson {
  /** Originally-extracted URL the embed was generated from. Stable
      anchor for client-side dedup + "open" actions. */
  url: string;
  kind: 'link' | 'image' | 'video';
  /** OG title or HTML <title> fallback. */
  title?: string | null;
  /** OG description. */
  description?: string | null;
  /** Resolved og:image URL (absolute). The fetcher rewrites relative
      og:image paths against the page's base URL. */
  imageUrl?: string | null;
  /** og:site_name — usually the owning site's brand. */
  siteName?: string | null;
  /** Page favicon (resolved absolute URL). Used as a small icon next
      to the site name. */
  faviconUrl?: string | null;
}

/**
 * Discriminated metadata payload for system messages and other special
 * message types. Single source of truth for the JSONB column on
 * `messages`. Extend by adding a new kind here when a new system
 * message type needs structured data; the column itself stays JSONB
 * so no migration is needed.
 */
export type MessageMetadataJson =
  | {
      /** Marker for the 'system_call' message type. */
      kind: 'call';
      /** true when the caller hung up before being answered. */
      missed: boolean;
      /** Span from "answered" to "ended" in milliseconds. 0 when
       *  missed=true (the call never connected). */
      durationMs: number;
      /** Caller's user id as a string (JSON can't carry BigInt). */
      initiatorId: string;
    };
