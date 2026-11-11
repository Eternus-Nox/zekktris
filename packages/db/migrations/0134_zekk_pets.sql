-- Zekk Pets: a shared virtual pet two people raise in their 1:1 DM by keeping
-- their messaging streak going (services/pets.ts has the rules).
--
-- One row per 1:1 DM, keyed by the channel, with the pair sorted like
-- dm_streaks (user_a_id < user_b_id):
--
--   status        — 'invited' (one person asked, the other hasn't answered),
--                   'active', or 'asleep' (a whole UTC day went unfed). A
--                   declined / cancelled / expired invite and a pet that ran
--                   away are deleted, not flagged.
--   invited_by    — who sent the invite.
--   points, level — total points earned and the level they reach (the curve
--                   lives in @zekktris/shared/pets; level 0 is the egg).
--   last_fed_day  — last UTC day (YYYY-MM-DD) both people messaged; set at
--                   adoption to the streak's last_counted_day. The sweep puts
--                   the pet to sleep and later lets it run away from this.
--   task_day      — the UTC day count_a / count_b / tasks_done belong to.
--                   Anything else means "nothing done yet today": the first
--                   activity of a new day resets them.
--   count_a/b     — each side's messages that day (capped at the chatty goal).
--   tasks_done    — that day's completed tasks as a bitmask (1 both_hi,
--                   2 chatty, 4 voice, 8 photo, 16 poke).
--
-- 'system_pet' is the notice posted into the DM when something happens to the
-- pet. drizzle runs every pending migration in ONE transaction, and Postgres
-- won't let a value added there be used before that transaction commits, so
-- nothing in this migration (or any other shipped in the same deploy) may
-- reference it.
ALTER TYPE "message_type" ADD VALUE IF NOT EXISTS 'system_pet';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_pets" (
	"channel_id" bigint PRIMARY KEY NOT NULL,
	"user_a_id" bigint NOT NULL,
	"user_b_id" bigint NOT NULL,
	"status" text NOT NULL,
	"invited_by" bigint,
	"name" text DEFAULT 'Zekk' NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"adopted_at" timestamp with time zone,
	"last_fed_day" text,
	"task_day" text,
	"count_a" integer DEFAULT 0 NOT NULL,
	"count_b" integer DEFAULT 0 NOT NULL,
	"tasks_done" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_pets_status_check" CHECK ("status" IN ('invited', 'active', 'asleep'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_pets" ADD CONSTRAINT "dm_pets_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_pets" ADD CONSTRAINT "dm_pets_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_pets" ADD CONSTRAINT "dm_pets_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- The sweep's scans: active pets fed before yesterday (fall asleep), pets fed
-- four or more days ago (run away), and invites by status. Small table (at
-- most one row per 1:1 DM), so a plain build is fine inside the migrator.
CREATE INDEX IF NOT EXISTS "dm_pets_sweep_idx" ON "dm_pets" ("status", "last_fed_day");
