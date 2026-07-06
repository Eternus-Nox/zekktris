-- Achievement notifications: persist which achievements a user has EARNED (and
-- when) so the server can detect the MOMENT one is newly unlocked and notify.
-- Achievements themselves are still computed on the fly (achievementsForUser);
-- this table is only the "already earned" ledger. The composite PK
-- (user_id, achievement_id) is the dedupe key: INSERT ... ON CONFLICT DO
-- NOTHING RETURNING yields exactly the newly-earned ids for a sync.
CREATE TABLE IF NOT EXISTS "user_achievements" (
	"user_id" bigint NOT NULL,
	"achievement_id" text NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_achievements_pk" PRIMARY KEY("user_id","achievement_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- Whether this user's earned-achievement ledger has been seeded. Existing users
-- default false → their current backlog is recorded SILENTLY on the first sync
-- (no notification spam at rollout); new users are set true at signup so every
-- achievement earned after that notifies.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "achievements_seeded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Account-level toggle for achievement-unlock notifications (push + in-app).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_achievements" boolean DEFAULT true NOT NULL;
