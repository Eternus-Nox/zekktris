-- Partial index on messages(reply_to_id) for the "First Responder" achievement
-- self-join (parent.id = messages.reply_to_id). Partial over reply rows only
-- (reply_to_id IS NOT NULL) so it stays small relative to the messages table.
--
-- NOTE FOR LARGE DEPLOYMENTS: this migration runs inside the transactional
-- migrator, so it CANNOT use CREATE INDEX CONCURRENTLY — a plain build takes a
-- SHARE lock that blocks writes to `messages` for the duration. On a small/
-- growing instance that's a brief blip. On a very large `messages` table,
-- build the index out-of-band BEFORE deploying this migration:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_reply_to_idx
--     ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
-- The IF NOT EXISTS below then makes this migration a no-op.
CREATE INDEX IF NOT EXISTS "messages_reply_to_idx"
  ON "messages" ("reply_to_id")
  WHERE "reply_to_id" IS NOT NULL;
