-- Inline thumbnail support for the DM image pipeline.
--  • Non-E2EE: a server-generated ~480px webp thumbnail (sharp), stored as its
--    OWN attachments row; the MAIN row's thumbnail_url holds that thumb's /cdn URL.
--  • E2EE: a client-generated, channel-key-encrypted (.zke) thumbnail uploaded
--    as a separate file, also its own attachments row; same idea.
-- Each thumbnail is its own row so the CDN (which serves /cdn/<id>/<name> only
-- when <id> has a row whose filename == <name>) can fetch it and the attachment
-- GC keeps it referenced. NULL thumbnail_url = "no thumbnail; load the full
-- image inline" (back-compat: every existing row, non-images, and E2EE images
-- from old clients). Image DIMENSIONS reuse the existing width/height columns.
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "thumbnail_url" text;--> statement-breakpoint
-- Marks rows that are THEMSELVES a thumbnail, so they're excluded from the media
-- gallery + attachment listings (they're previews, not standalone items).
-- Existing rows default to false (real attachments).
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "is_thumbnail" boolean DEFAULT false NOT NULL;
