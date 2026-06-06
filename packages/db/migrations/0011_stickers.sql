-- ───────────────────────────────────────────────────────────────────────────
-- Stickers
-- ───────────────────────────────────────────────────────────────────────────
-- Like emoji but rendered as standalone message bodies at ~160px. Gated
-- behind MANAGE_EMOJIS (which conceptually covers MANAGE_EMOJIS_AND_STICKERS,
-- matching Discord's combined permission).
--
-- Storage shares the /uploads/<id>/<filename> tree with attachments,
-- emojis, and avatars. The CDN handler's progressive fall-through
-- resolves sticker URLs by id.

-- Extend the audit_target enum first so audit-log inserts naming the
-- new 'sticker' kind don't fail. ALTER TYPE … ADD VALUE has been
-- transactionally safe since Postgres 12; we're on 16.
ALTER TYPE "audit_target" ADD VALUE IF NOT EXISTS 'sticker';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stickers" (
  "id"           bigint NOT NULL,
  "guild_id"     bigint NOT NULL,
  "name"         text NOT NULL,
  "description"  text,
  "url"          text NOT NULL,
  "animated"     boolean NOT NULL DEFAULT false,
  "uploaded_by"  bigint,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stickers"
    ADD CONSTRAINT "stickers_guild_id_guilds_id_fk"
    FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stickers"
    ADD CONSTRAINT "stickers_uploaded_by_users_id_fk"
    FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stickers_guild_name_uq" ON "stickers" ("guild_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stickers_guild_idx" ON "stickers" ("guild_id");
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sticker_id" bigint;
