-- One-time date-of-birth self-change lock + legacy grandfather backfill.
--
-- dob_locked: once true, a user can't change their own date of birth (only an
-- admin can reset it). Defaults TRUE so any NEW account is locked the moment it
-- declares its DOB at signup — a minor can't sign up honestly then flip to 18
-- to escape supervision.
ALTER TABLE "users" ADD COLUMN "dob_locked" boolean NOT NULL DEFAULT true;

-- Grandfather existing accounts that never declared an age. Register has
-- required a DOB since the new system shipped, so a NULL date_of_birth marks a
-- legacy human account (the "joined in June" cohort). Default them to 18
-- (adult) so the new minor-supervision system doesn't lock them out, and UNLOCK
-- their DOB so each can self-correct their age exactly once (an honest minor
-- who was auto-set to 18 can fix it; then it re-locks). Accounts that already
-- have a DOB keep the locked default. Bots are skipped (never age-gated).
UPDATE "users"
   SET "date_of_birth" = '2008-01-01', "dob_locked" = false
 WHERE "date_of_birth" IS NULL AND "is_bot" = false;
