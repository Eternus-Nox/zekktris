-- DM read receipts
-- ----------------
-- Adds the two columns needed for Sent / Delivered / Read indicators
-- on 1:1 DMs:
--
--   - messages.delivered_at — stamped server-side when at least one of
--     the recipient's gateway connections receives MESSAGE_CREATE, or
--     on the recipient's next IDENTIFY if no one was online at send.
--   - users.dm_read_receipts_enabled — per-user opt-out. When false,
--     the server skips stamping for messages this user receives,
--     making them invisible to the sender's tracking. Reciprocal:
--     turning it off also hides incoming senders' status from this
--     user.
--
-- The viewed_at column already exists (migration 0026, originally for
-- DM auto-delete). It's reused here for the "Read" status. Both
-- stamps suppress when the recipient has receipts disabled.
--
-- Group DMs are intentionally out of scope — Discord doesn't surface
-- receipts there either; "read by whom" is ambiguous.

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "dm_read_receipts_enabled" boolean NOT NULL DEFAULT true;

-- Partial index: only stamp-eligible rows. Speeds up the per-recipient
-- "find messages I should mark delivered" query at IDENTIFY time, when
-- a recipient with offline backlog reconnects and we backfill. Most
-- messages already have delivered_at set, so a partial index
-- on (channel_id, id) WHERE delivered_at IS NULL stays tiny.
CREATE INDEX IF NOT EXISTS "messages_pending_delivery_idx"
  ON "messages" ("channel_id", "id")
  WHERE "delivered_at" IS NULL;
