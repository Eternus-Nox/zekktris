-- Per-user notification overrides for guilds + channels. Two-tier:
-- a guild-level row mutes (or sets level for) every channel in the
-- guild, while a channel-level row takes precedence for that channel.
-- The service layer reads both and resolves channel > guild > default.
--
-- target_id is NOT FK'd because polymorphism: it points at either
-- guilds.id or channels.id depending on target_type. Cascade is via
-- the user_id link; orphan rows pointing at deleted guilds/channels
-- are harmless (they just never match a real lookup) and can be
-- garbage-collected later if it becomes a problem.

DO $$ BEGIN
  CREATE TYPE "notification_target" AS ENUM ('guild', 'channel');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "notification_level" AS ENUM ('all', 'mentions', 'nothing');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_overrides" (
  "user_id"     bigint NOT NULL,
  "target_type" "notification_target" NOT NULL,
  "target_id"   bigint NOT NULL,
  "level"       "notification_level" NOT NULL,
  "updated_at"  timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "target_type", "target_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_overrides"
    ADD CONSTRAINT "notification_overrides_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_overrides_target_idx"
  ON "notification_overrides" USING btree ("target_type", "target_id");
