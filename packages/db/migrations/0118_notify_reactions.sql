-- Account-level toggle for reaction notifications: when someone reacts to your
-- message, you get a push. Default true (opt-out), mirroring notify_achievements.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_reactions" boolean NOT NULL DEFAULT true;
