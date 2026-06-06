/**
 * Scheduled messages
 * ------------------
 * Queue of messages composed-now-for-send-later. A background
 * worker (see apps/api/src/workers/scheduledMessages.ts) polls
 * this table every minute and processes due rows by creating
 * real messages and deleting the schedule entry.
 *
 * See migration 0046_scheduled_messages.sql for the column
 * rationale.
 */
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { channels } from './channels';

export const scheduledMessages = pgTable(
  'scheduled_messages',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    authorId: bigint('author_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    content: text('content').notNull().default(''),
    /** Opaque JSON blob — the worker passes whatever was put here
        through to the message creator at send time. Typical
        contents: an array of { url, filename, contentType, size }
        objects, but the worker doesn't introspect; the message
        send path knows how to consume it. */
    attachmentsJson: jsonb('attachments_json')
      .notNull()
      .$type<unknown[]>()
      .default([]),
    replyToMessageId: bigint('reply_to_message_id', { mode: 'bigint' }),
    scheduledFor: timestamp('scheduled_for', {
      withTimezone: true,
    }).notNull(),
    /** Send-attempt counter. Bumped by the worker on each try; after
        3 failed attempts the worker stops trying. The row stays
        visible in the user's scheduled list so they can inspect
        the last_error and decide what to do. */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    dueIdx: index('idx_scheduled_messages_due').on(t.scheduledFor),
    authorIdx: index('idx_scheduled_messages_author').on(
      t.authorId,
      t.scheduledFor,
    ),
  }),
);

export type ScheduledMessage = typeof scheduledMessages.$inferSelect;
