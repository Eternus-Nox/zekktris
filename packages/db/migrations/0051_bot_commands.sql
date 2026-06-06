-- ── v1.87 bot slash commands ──────────────────────────────────────────────
--
-- Commands a bot registers. When a user runs `/name args`, the server
-- delivers an interaction.create event to the bot (same signed-webhook
-- channel as message events) and the bot replies via REST.
--
--   guild_id NULL = global (available in every guild the bot is in).

CREATE TABLE bot_commands (
  id          BIGINT PRIMARY KEY,
  bot_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id    BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bot_commands_bot_idx ON bot_commands(bot_id);
CREATE INDEX bot_commands_guild_idx ON bot_commands(guild_id);
-- A bot can't register the same name twice in the same scope.
CREATE UNIQUE INDEX bot_commands_unique_name_idx
  ON bot_commands(bot_id, guild_id, name);
