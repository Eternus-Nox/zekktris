-- ───────────────────────────────────────────────────────────────────────────
-- Webhooks  (Discord-compatible incoming webhooks)
-- ───────────────────────────────────────────────────────────────────────────
-- A webhook is a (channel, secret-token) pair that lets external services
-- POST a message to a channel without holding a user account. Tokens are
-- ~190 bits of entropy; rotation = delete + recreate.
--
-- The execute endpoint is unauthed (the secret token in the URL is the
-- gate). Posted messages set `webhook_id` so the renderer knows to use
-- the per-message author override (username + avatar).

CREATE TABLE IF NOT EXISTS "webhooks" (
  "id"            bigint NOT NULL,
  "channel_id"    bigint NOT NULL,
  "guild_id"      bigint NOT NULL,
  "name"          text   NOT NULL,
  "avatar_url"    text,
  "token"         text   NOT NULL,
  "created_by"    bigint,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webhooks"
    ADD CONSTRAINT "webhooks_channel_id_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webhooks"
    ADD CONSTRAINT "webhooks_guild_id_guilds_id_fk"
    FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "webhooks"
    ADD CONSTRAINT "webhooks_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhooks_channel_idx" ON "webhooks" USING btree ("channel_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhooks_guild_idx" ON "webhooks" USING btree ("guild_id");
--> statement-breakpoint
-- Token lookup is the critical hot path on every execute. Standard btree
-- is fine — tokens are uniformly random so equality lookups are cheap.
CREATE INDEX IF NOT EXISTS "webhooks_token_idx" ON "webhooks" USING btree ("token");
--> statement-breakpoint
-- Per-message webhook attribution. Null for normal user-authored messages.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "webhook_id" bigint;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "author_override_name" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "author_override_avatar" text;
