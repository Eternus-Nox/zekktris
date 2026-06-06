-- ───────────────────────────────────────────────────────────────────────────
-- Forwarded messages
-- ───────────────────────────────────────────────────────────────────────────
-- A forwarded message references the original by id. The renderer
-- displays the source's content (with attribution) inline. The forward
-- can also carry its own content — the forwarder's comment.
--
-- We do NOT cascade on source delete: if the original is gone, the
-- forward stays with a "[unavailable]" placeholder rather than
-- disappearing silently from history.
--
-- We don't denormalize the source channel id — clients fetch the
-- source message in the same batch as their primary list call, and the
-- channel is on the source row. Saves a column write on every forward.

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "forwarded_from_message_id" bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_forwarded_from_idx" ON "messages" ("forwarded_from_message_id");
