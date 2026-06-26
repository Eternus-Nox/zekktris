-- Drop the name-tag emoji part — clan tags are now label-only (a short,
-- color-tinted text pill). The emoji column was added in 0086 this cycle and
-- is being removed before it sees real use. IF EXISTS keeps it idempotent.
ALTER TABLE "users" DROP COLUMN IF EXISTS "tag_emoji";
