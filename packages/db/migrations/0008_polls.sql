-- ───────────────────────────────────────────────────────────────────────────
-- Polls  (Discord-style inline polls)
-- ───────────────────────────────────────────────────────────────────────────
-- One poll per message. Options live in poll_options; votes in poll_votes
-- with a composite PK (poll_id, option_id, user_id) so the same user can
-- have multiple rows on multiple_choice polls but at most one per option.
-- For single-choice polls the service-level vote() routine deletes any
-- existing rows for (poll, voter) before insert, so the multi-row case
-- only happens when multiple_choice is true.

CREATE TABLE IF NOT EXISTS "polls" (
  "id"               bigint NOT NULL,
  "message_id"       bigint NOT NULL,
  "question"         text NOT NULL,
  "multiple_choice"  boolean NOT NULL DEFAULT false,
  "expires_at"       timestamp with time zone,
  "closed_at"        timestamp with time zone,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "polls"
    ADD CONSTRAINT "polls_message_id_messages_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "polls_message_uq" ON "polls" ("message_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poll_options" (
  "id"          bigint NOT NULL,
  "poll_id"     bigint NOT NULL,
  "text"        text NOT NULL,
  "position"    integer NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "poll_options"
    ADD CONSTRAINT "poll_options_poll_id_polls_id_fk"
    FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poll_options_poll_idx" ON "poll_options" ("poll_id", "position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poll_votes" (
  "poll_id"     bigint NOT NULL,
  "option_id"   bigint NOT NULL,
  "user_id"     bigint NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("poll_id", "option_id", "user_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "poll_votes"
    ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk"
    FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "poll_votes"
    ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk"
    FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "poll_votes"
    ADD CONSTRAINT "poll_votes_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poll_votes_user_idx" ON "poll_votes" ("user_id", "poll_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poll_votes_option_idx" ON "poll_votes" ("option_id");
