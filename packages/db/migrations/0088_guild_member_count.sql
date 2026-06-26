-- Denormalized member_count for the discovery directory.
-- The directory listing computed a live COUNT(DISTINCT)/GROUP-BY/ORDER-BY over
-- the whole discoverable catalogue on every open, keystroke-search, and page.
-- This column lets the browse default be index-served; it's kept fresh for
-- discoverable guilds by a periodic sweep + on discovery opt-in (approximate /
-- eventually-consistent, which is fine for a server browser).
ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "member_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- One-time backfill of the exact count (excludes globally-banned + deleted
-- users, matching the directory's prior live filter). COALESCE 0 for guilds
-- with no surviving members.
UPDATE "guilds" g
SET "member_count" = COALESCE(c.cnt, 0)
FROM "guilds" g2
LEFT JOIN LATERAL (
  SELECT COUNT(DISTINCT u.id)::int AS cnt
  FROM "guild_members" gm
  JOIN "users" u ON u.id = gm.user_id
  WHERE gm.guild_id = g2.id
    AND u.banned_at IS NULL
    AND u.deleted_at IS NULL
) c ON true
WHERE g.id = g2.id;
--> statement-breakpoint
-- Partial composite index serving the browse default sort.
CREATE INDEX IF NOT EXISTS "guilds_discoverable_rank_idx"
  ON "guilds" ("member_count" DESC, "id" DESC)
  WHERE "discoverable" AND "deleted_at" IS NULL;
