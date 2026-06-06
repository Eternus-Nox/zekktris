-- ───────────────────────────────────────────────────────────────────────────
-- Voice messages
-- ───────────────────────────────────────────────────────────────────────────
-- Voice messages are regular audio attachments with extra metadata: a
-- duration (for the playback UI to show "0:32 / 0:14"), a tiny waveform
-- preview (32-64 bytes, drawn as bars), and a flag distinguishing them
-- from generic audio uploads. Adding these to `attachments` rather than
-- a separate table keeps the storage path identical (CDN, /uploads,
-- existing permissions all carry over).

ALTER TABLE "attachments"
  ADD COLUMN IF NOT EXISTS "is_voice_message" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "attachments"
  ADD COLUMN IF NOT EXISTS "duration_seconds" integer;
--> statement-breakpoint
ALTER TABLE "attachments"
  ADD COLUMN IF NOT EXISTS "waveform" text;
