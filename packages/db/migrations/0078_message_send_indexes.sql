-- Two indexes on the per-message-send hot path.
--
-- 1) Replace the bare (author_id) index with (author_id, created_at). The
--    AutoMod repeat_message scan runs `author_id = ? AND created_at > cutoff`
--    on every send; the single-column index forced a scan+filter of the
--    author's entire message history. The composite still serves any
--    author_id-only lookup (leading column), so nothing regresses.
DROP INDEX IF EXISTS "messages_author_idx";
CREATE INDEX IF NOT EXISTS "messages_author_idx"
  ON "messages" ("author_id", "created_at");

-- 2) (channel_id, author_id, id) for the slowmode check, which finds the
--    author's newest message in the channel (`channel_id = ? AND author_id = ?
--    ORDER BY id DESC LIMIT 1`). The existing (channel_id, id) index made that
--    scan every message in the channel.
CREATE INDEX IF NOT EXISTS "messages_channel_author_idx"
  ON "messages" ("channel_id", "author_id", "id");
