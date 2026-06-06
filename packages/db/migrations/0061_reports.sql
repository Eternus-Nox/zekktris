-- Member reports + moderation queue
-- ---------------------------------
-- A per-guild queue of reports filed by members against a message or a
-- user. Moderators (anyone with a moderation permission) review and either
-- resolve or dismiss them. We snapshot the reported message's content at
-- file time so the queue is still useful after the message is deleted.
--
-- reporter_id / target_user_id / handled_by_id are ON DELETE SET NULL so a
-- report survives the deletion of any user involved (the row stays as an
-- audit trail with a null pointer). message_id / channel_id are plain
-- columns (no FK) — the referenced message may be hard-deleted, and we keep
-- the snapshot regardless.
CREATE TABLE IF NOT EXISTS "reports" (
  "id" bigint PRIMARY KEY,
  "guild_id" bigint NOT NULL REFERENCES "guilds"("id") ON DELETE CASCADE,
  "reporter_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "target_type" text NOT NULL,
  "target_user_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "message_id" bigint,
  "channel_id" bigint,
  "message_content" text,
  "reason" text NOT NULL,
  "details" text,
  "status" text NOT NULL DEFAULT 'open',
  "handled_by_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "handled_at" timestamptz,
  "resolution_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Queue is read as "open reports for this guild, newest first" — the index
-- covers that filter + ordering.
CREATE INDEX IF NOT EXISTS "reports_guild_status_idx" ON "reports" ("guild_id", "status", "id");
