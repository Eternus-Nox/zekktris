-- Security system (Admin → Security): event log, banned words, throttle
-- config; DM messaging streaks; achievements visibility toggle.

CREATE TABLE IF NOT EXISTS "security_events" (
  "id" bigint PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "user_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "guild_id" bigint REFERENCES "guilds"("id") ON DELETE CASCADE,
  "channel_id" bigint,
  "detail" text NOT NULL,
  "content_snapshot" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_created_idx" ON "security_events" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_user_idx" ON "security_events" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "security_events_kind_idx" ON "security_events" ("kind");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_banned_words" (
  "word" text PRIMARY KEY NOT NULL,
  "added_by" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_config" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "spam_enabled" boolean DEFAULT true NOT NULL,
  "spam_max_messages" integer DEFAULT 8 NOT NULL,
  "spam_window_seconds" integer DEFAULT 10 NOT NULL,
  "spam_cooldown_seconds" integer DEFAULT 600 NOT NULL,
  "word_filter_enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
INSERT INTO "security_config" ("id") VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dm_streaks" (
  "channel_id" bigint PRIMARY KEY NOT NULL,
  "user_a_id" bigint NOT NULL,
  "user_b_id" bigint NOT NULL,
  "last_day_a" text,
  "last_day_b" text,
  "last_counted_day" text,
  "streak" integer DEFAULT 0 NOT NULL,
  "best_streak" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "achievements_public" boolean DEFAULT false NOT NULL;
