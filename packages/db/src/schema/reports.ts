import { pgTable, bigint, text, timestamp, index } from 'drizzle-orm/pg-core';
import { guilds } from './guilds';
import { users } from './users';

/**
 * Member reports + moderation queue.
 *
 * A report is filed by a guild member against either a message or a user,
 * and lands in that guild's moderation queue for a moderator to resolve or
 * dismiss. We capture a snapshot of the reported message's content at file
 * time (`messageContent`) so the queue stays useful even after the message
 * is deleted; `messageId`/`channelId` are plain columns (no FK) for the
 * same reason — the underlying message may be gone.
 *
 * All user pointers are ON DELETE SET NULL so a report survives the
 * deletion of anyone involved, leaving an audit trail with a null pointer.
 */
export const reports = pgTable(
  'reports',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    /** Null once the server has been purged — the report outlives it, because
        deleting a server must not erase the record that it was reported. */
    guildId: bigint('guild_id', { mode: 'bigint' }).references(() => guilds.id, {
      onDelete: 'set null',
    }),
    /** The server's name, snapshotted at purge time so a report whose server
        is gone still says where it happened. */
    guildName: text('guild_name'),
    reporterId: bigint('reporter_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** 'message' | 'user'. */
    targetType: text('target_type').$type<'message' | 'user'>().notNull(),
    /** The reported user, or the author of the reported message. */
    targetUserId: bigint('target_user_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The reported message (when targetType='message'). No FK — may be
        hard-deleted; the snapshot below preserves what was reported. */
    messageId: bigint('message_id', { mode: 'bigint' }),
    channelId: bigint('channel_id', { mode: 'bigint' }),
    /** Snapshot of the reported message content at file time. */
    messageContent: text('message_content'),
    /** Category: 'spam' | 'harassment' | 'nsfw' | 'violence' | 'other'. */
    reason: text('reason').notNull(),
    /** Optional free-text context from the reporter. */
    details: text('details'),
    /** 'open' | 'resolved' | 'dismissed'. */
    status: text('status').$type<'open' | 'resolved' | 'dismissed'>().notNull().default('open'),
    handledById: bigint('handled_by_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    handledAt: timestamp('handled_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildStatusIdx: index('reports_guild_status_idx').on(t.guildId, t.status, t.id),
  }),
);

export type Report = typeof reports.$inferSelect;
