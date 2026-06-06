import { pgTable, bigint, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Reaction-role mapping. A row links a (message, emoji) pair to a
 * role; when a member adds that reaction to that message, the
 * gateway middleware grants the role. Removing the reaction
 * revokes the role.
 *
 * See migration 0017 for schema notes — in particular why we
 * denormalize guild_id + channel_id (gateway hot-path lookup) and
 * why the PK is (message_id, emoji) rather than including role_id
 * (one emoji on one message ⇒ exactly one role).
 */
export const reactionRoles = pgTable(
  'reaction_roles',
  {
    messageId: bigint('message_id', { mode: 'bigint' }).notNull(),
    emoji: text('emoji').notNull(),
    guildId: bigint('guild_id', { mode: 'bigint' }).notNull(),
    channelId: bigint('channel_id', { mode: 'bigint' }).notNull(),
    roleId: bigint('role_id', { mode: 'bigint' }).notNull(),
    createdBy: bigint('created_by', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.emoji] }),
    guildIdx: index('reaction_roles_guild_idx').on(t.guildId),
  }),
);

export type ReactionRole = typeof reactionRoles.$inferSelect;
