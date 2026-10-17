import {
  pgTable,
  bigint,
  text,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { guilds } from './guilds';
import { channels } from './channels';

// ───────────────────────────────────────────────────────────────────────────
// webhooks
// ───────────────────────────────────────────────────────────────────────────
//
// Discord-compatible incoming webhooks. Each row is a (channel, secret-token)
// pair that lets external services POST a message to the channel without
// holding a user account.
//
// Wire shape: clients POST to /api/webhooks/:id/:token with a JSON body
// {content, username?, avatar_url?, embeds?, ...}. The route is unauthed
// and rate-limited per webhook; the secret token in the URL is the only
// gate. Compromised tokens can be rotated by deleting + recreating the
// webhook.
//
// Author override: when a webhook executes, the message gets author_id =
// the webhook's owner (createdBy) but the rendered username/avatar come
// from the webhook's stored name + avatarUrl OR from per-request overrides
// in the POST body. The MessageItem renderer prefers any populated
// `webhookId` on the message + the row's effective name/avatar from the
// webhook + body.

export const webhooks = pgTable(
  'webhooks',
  {
    /** Snowflake id. Forms half of the public URL: /api/webhooks/<id>/<token> */
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    /** The channel this webhook posts INTO. Hard-cascade on channel delete —
        a webhook without a target is meaningless and we don't want orphan
        rows lingering with valid tokens. */
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** Denormalized for permission checks + audit grouping. The channel
        carries the same value, but joining on every execute would be
        wasteful since this never changes after creation. */
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** Display name shown on messages this webhook posts. Defaults to
        "Webhook" if the creator didn't set one. The execute body can
        override per-message via `username` field. */
    name: text('name').notNull(),
    /** Avatar URL for messages this webhook posts. Optional — falls back
        to the default avatar tone derived from the webhook id. The
        execute body can override per-message via `avatar_url` field. */
    avatarUrl: text('avatar_url'),
    /** Secret token. Rotation = delete + create new. Stored in plaintext
        (unlike bot tokens, which are shown once and kept as a hash) because
        list/get re-return it to MANAGE_WEBHOOKS holders, as Discord does,
        which a one-way hash can't serve. The token is generated as 32
        random urlsafe-base64 chars, ~190 bits of entropy. */
    token: text('token').notNull(),
    /** Whoever created the webhook. Used for audit + as the
        message.authorId on executed messages. SET NULL on user delete so
        the webhook keeps working but loses attribution. */
    createdBy: bigint('created_by', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelIdx: index('webhooks_channel_idx').on(t.channelId),
    guildIdx: index('webhooks_guild_idx').on(t.guildId),
    // Token lookup is the critical hot path on every execute. A standard
    // btree index is enough — tokens are uniformly random so cardinality
    // is high and equality lookups land in O(log n).
    tokenIdx: index('webhooks_token_idx').on(t.token),
  }),
);

export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;
