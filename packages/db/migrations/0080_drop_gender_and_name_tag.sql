-- Remove the Gender and custom name-tag ("clan tag") profile features.
-- Both were UI-only profile cosmetics that have been pulled from every
-- client; their columns are now dead. IF EXISTS keeps this idempotent and
-- safe to run against databases that never had the columns.
ALTER TABLE "users" DROP COLUMN IF EXISTS "gender";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "gender_visible";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "tag_label";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "tag_color";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "tag_emoji";
