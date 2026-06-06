-- ───────────────────────────────────────────────────────────────────────────
-- Custom guild emoji
-- ───────────────────────────────────────────────────────────────────────────
-- Each guild can upload a set of custom :name: emoji. Members of the guild
-- can use them in messages and reactions; non-members never see them.
-- File storage shares the /uploads tree (keyed by snowflake id) with
-- attachments and avatars; the CDN route resolves all three with progressive
-- fall-through.

CREATE TABLE IF NOT EXISTS "guild_emojis" (
  "id"           bigint NOT NULL,
  "guild_id"     bigint NOT NULL,
  "name"         text   NOT NULL,
  "url"          text   NOT NULL,
  "animated"     boolean NOT NULL DEFAULT false,
  "uploaded_by"  bigint,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "guild_emojis"
    ADD CONSTRAINT "guild_emojis_guild_id_guilds_id_fk"
    FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "guild_emojis"
    ADD CONSTRAINT "guild_emojis_uploaded_by_users_id_fk"
    FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Names are unique within a guild so :pepe: resolves unambiguously. They can
-- repeat across different guilds.
CREATE UNIQUE INDEX IF NOT EXISTS "guild_emojis_guild_name_uq"
  ON "guild_emojis" USING btree ("guild_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guild_emojis_guild_idx"
  ON "guild_emojis" USING btree ("guild_id");
