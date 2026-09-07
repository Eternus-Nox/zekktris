-- Snapshot a forward's source AT FORWARD TIME instead of dereferencing it live.
--
-- Until now a forward stored only `forwarded_from_message_id` — a live pointer,
-- permission-checked once when the forward was created. Every later render of
-- that forward read the CURRENT source row with no re-check of the current
-- viewer's access. Two consequences, both real:
--
--   * a viewer who can see the forward but NOT the source channel still sees
--     the source's content, and keeps seeing it after access is revoked;
--   * edits to the source rewrite history inside every forward of it.
--
-- Freezing the content at forward time fixes both at once, and matches what
-- WhatsApp and Slack do. The live pointer stays for "jump to original".
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "forwarded_content" text,
  ADD COLUMN IF NOT EXISTS "forwarded_author_name" text,
  ADD COLUMN IF NOT EXISTS "forwarded_author_avatar" text,
  ADD COLUMN IF NOT EXISTS "forwarded_channel_name" text,
  ADD COLUMN IF NOT EXISTS "forwarded_created_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "forwarded_attachments" jsonb;
--> statement-breakpoint

-- Backfill existing forwards from their current source.
--
-- This cannot retroactively verify the permissions that applied when each
-- forward was made — that information is gone. What it does is stop the
-- ongoing leak: after this, an already-created forward shows what the source
-- says TODAY and never changes again, instead of tracking the source forever.
-- Strictly better than leaving them live, and the only option available.
--
-- `forwarded_created_at` doubles as the "has a snapshot" marker, so it is set
-- for every backfilled row even where the source is gone.
UPDATE "messages" AS f
SET
  "forwarded_content"       = COALESCE(s."content", ''),
  "forwarded_author_name"   = u."display_name",
  "forwarded_author_avatar" = u."avatar_url",
  "forwarded_channel_name"  = c."name",
  "forwarded_created_at"    = COALESCE(s."created_at", f."created_at")
FROM "messages" AS s
  LEFT JOIN "users"    AS u ON u."id" = s."author_id"
  LEFT JOIN "channels" AS c ON c."id" = s."channel_id"
WHERE f."forwarded_from_message_id" = s."id"
  AND f."forwarded_created_at" IS NULL;
--> statement-breakpoint

-- A forward whose source row is already gone gets a snapshot too, so the read
-- path can treat "pointer set, no snapshot" as impossible rather than as a
-- reason to fall back to a live read.
UPDATE "messages"
SET "forwarded_created_at" = "created_at",
    "forwarded_content"    = COALESCE("forwarded_content", '')
WHERE "forwarded_from_message_id" IS NOT NULL
  AND "forwarded_created_at" IS NULL;
