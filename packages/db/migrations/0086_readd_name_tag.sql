-- Re-add the custom name-tag ("clan tag") profile feature (dropped in 0080).
-- Three independent, nullable cosmetic columns on the users row. The tag now
-- renders IN FRONT of the user's name (was after it before removal). IF NOT
-- EXISTS keeps this idempotent and safe on databases that still have the
-- columns from before the 0080 drop.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tag_label" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tag_color" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tag_emoji" text;
