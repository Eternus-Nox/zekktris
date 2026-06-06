-- Threads MVP. Adds:
--   1. 'public_thread' to the channel_type enum.
--   2. parent_message_id + thread_archived_at columns on channels.
--   3. Index on parent_message_id for "list threads under message X" queries.
--
-- Threads are modelled as channels with type='public_thread', parent_id
-- pointing at the text channel they belong to, and parent_message_id
-- pointing at the message that started them. Permissions are inherited
-- from the parent channel; we don't store per-thread overrides yet.

ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'public_thread';
--> statement-breakpoint

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "parent_message_id" bigint;
--> statement-breakpoint

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "thread_archived_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "channels_parent_message_idx"
  ON "channels" USING btree ("parent_message_id");
