-- ── v1.85 bot accounts ───────────────────────────────────────────────────
--
-- Bots are real user rows (so they can be guild members, author
-- messages, hold roles + permissions, appear in member lists) but
-- they authenticate differently from humans:
--
--   - Humans: email + password → JWT access/refresh sessions
--   - Bots:   a static bot token sent as `Authorization: Bot <token>`
--
-- Three new columns on users:
--
--   is_bot          true for bot rows. Drives the BOT badge in the
--                   UI and gates bot-only / human-only behaviors
--                   (e.g. bots can't open DMs, can't be friended,
--                   are excluded from human-presence counts).
--
--   bot_owner_id    the human user who created + manages this bot.
--                   FK to users(id). Null for human rows. When the
--                   owner is deleted the bot is deleted too (cascade)
--                   — an orphaned bot with a live token is a security
--                   risk.
--
--   bot_token_hash  SHA-256 hex of the bot's API token. Only the
--                   hash is persisted; the plaintext token is shown
--                   exactly once at creation (and on regenerate).
--                   Null for human rows. Bots have an unusable
--                   password_hash sentinel so the human login path
--                   can never authenticate them.

ALTER TABLE users ADD COLUMN is_bot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN bot_owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN bot_token_hash TEXT;

-- Lookup by token hash on every bot-authenticated request, so index it.
CREATE UNIQUE INDEX users_bot_token_hash_idx
  ON users(bot_token_hash)
  WHERE bot_token_hash IS NOT NULL;

-- "List the bots I own" — index the owner fk for bot rows.
CREATE INDEX users_bot_owner_idx
  ON users(bot_owner_id)
  WHERE bot_owner_id IS NOT NULL;
