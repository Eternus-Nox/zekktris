-- Scheduled messages: atomic worker claim. `claimed_at` is stamped when a
-- worker claims a due row for sending so concurrent ticks / replicas can't
-- both reify the same row (double-send). Cleared on failure (retry), the row
-- is deleted on success; a stale claim (worker died mid-send) is reclaimable.

ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
