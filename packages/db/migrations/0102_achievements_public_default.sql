-- Achievements are SHOWN by default (user direction): profile shelves are
-- visible to others unless the owner turns "Public achievements" off in
-- Settings. Flip the column default for new accounts and backfill existing
-- rows — anyone who prefers privacy can re-hide with the existing toggle.
ALTER TABLE "users" ALTER COLUMN "achievements_public" SET DEFAULT true;
UPDATE "users" SET "achievements_public" = true;
