-- ───────────────────────────────────────────────────────────────────────────
-- Stage channels
-- ───────────────────────────────────────────────────────────────────────────
-- Adds the 'guild_stage' channel type and a stage_participants table
-- that tracks who's a speaker / audience and who has a hand raised.
-- Rows are short-lived (created on join, deleted on leave); we use a
-- table rather than Redis so the existing migration / DB-state model
-- carries over without operational complexity.

ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'guild_stage';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stage_participants" (
  "channel_id"   bigint NOT NULL,
  "user_id"      bigint NOT NULL,
  "is_speaker"   boolean NOT NULL DEFAULT false,
  "hand_raised"  boolean NOT NULL DEFAULT false,
  "joined_at"    timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("channel_id", "user_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stage_participants"
    ADD CONSTRAINT "stage_participants_channel_id_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stage_participants"
    ADD CONSTRAINT "stage_participants_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stage_participants_by_channel_idx" ON "stage_participants" ("channel_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stage_participants_by_user_idx" ON "stage_participants" ("user_id");
