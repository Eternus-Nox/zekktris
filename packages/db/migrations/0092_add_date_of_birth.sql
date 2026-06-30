-- Add date_of_birth for age gating (13+ required at signup) and the
-- minor-supervision lifecycle (13–17 = supervised; auto-release at 18).
-- Nullable: existing accounts predate the field and have no DOB on record;
-- new signups always supply it (the /auth/register schema requires it).
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;
