-- Pinned-messages index: make it partial. The old (channel_id, pinned)
-- btree covered EVERY message row even though pinned=true rows are a tiny
-- fraction, so it was nearly as large as the table's PK for no selectivity
-- benefit. Pin lookups are `WHERE channel_id = $1 AND pinned AND deleted_at
-- IS NULL`, which the partial index serves exactly while staying orders of
-- magnitude smaller (and cheaper to maintain on every message insert).

DROP INDEX IF EXISTS "messages_pinned_idx";
CREATE INDEX IF NOT EXISTS "messages_pinned_idx" ON "messages" ("channel_id")
  WHERE "pinned" AND "deleted_at" IS NULL;
