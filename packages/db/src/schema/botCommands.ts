import {
  pgTable,
  bigint,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { guilds } from './guilds';

// ───────────────────────────────────────────────────────────────────────────
// bot_commands
// ───────────────────────────────────────────────────────────────────────────
//
// Slash commands registered by a bot. When a user runs `/name args` in
// a channel, the server delivers an `interaction.create` event to the
// bot's event callback URL (same signed-webhook channel as message
// events), and the bot responds via the REST API.
//
//   bot_id     the bot that owns this command (FK users, cascade).
//   guild_id   scope. Null = available in every guild the bot is a
//              member of ("global"). Non-null = only that guild.
//   name       the command word (no leading slash), lowercased,
//              unique per (bot, guild scope).
//   description shown in the composer's command picker.

export const botCommands = pgTable(
  'bot_commands',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    botId: bigint('bot_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    guildId: bigint('guild_id', { mode: 'bigint' }).references(
      () => guilds.id,
      { onDelete: 'cascade' },
    ),
    name: text('name').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    botIdx: index('bot_commands_bot_idx').on(t.botId),
    guildIdx: index('bot_commands_guild_idx').on(t.guildId),
    // A bot can't register the same command name twice in the same
    // scope. (Global + per-guild with the same name is allowed — the
    // per-guild one wins in the composer's resolution.)
    uniqueName: uniqueIndex('bot_commands_unique_name_idx').on(
      t.botId,
      t.guildId,
      t.name,
    ),
  }),
);

export type BotCommand = typeof botCommands.$inferSelect;
