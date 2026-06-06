-- AFK channel + welcome message
-- ------------------------------
-- Five new columns on guilds, all opt-in:
--
--   afk_channel_id           — voice channel id where users get parked
--                              when idle. Joining auto-mutes their mic
--                              at the LiveKit level. NULL = no AFK
--                              channel configured (default).
--   afk_timeout_seconds      — idle threshold for the (v1.x) auto-move
--                              sweep. Default 300 (5 min). The column
--                              is reserved now so we don't need a
--                              follow-up migration when auto-move
--                              lands.
--   welcome_channel_id       — channel where the welcome message goes
--                              when a new member joins. Falls back to
--                              system_channel_id, then to the first
--                              viewable text channel.
--   welcome_message_enabled  — gate. When false (default), no welcome
--                              message is posted regardless of the
--                              other welcome columns.
--   welcome_message_template — plain-text template with optional
--                              {user} placeholder rendering an
--                              @mention. NULL → default greeting.
--
-- All five are nullable / have defaults so existing rows stay valid
-- without any data migration. No new FK constraints — invalid ids
-- (e.g. a deleted channel referenced by afk_channel_id) are
-- treated as "no AFK channel" by the resolver at runtime.

ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "afk_channel_id" bigint;

ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "afk_timeout_seconds" integer NOT NULL DEFAULT 300;

ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "welcome_channel_id" bigint;

ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "welcome_message_enabled" boolean NOT NULL DEFAULT false;

ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "welcome_message_template" text;
