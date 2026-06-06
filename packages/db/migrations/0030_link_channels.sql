-- Link channels
-- -------------
-- New channel type for URL bookmarks. Clicking a link channel prompts
-- the user with a "leave Commune?" confirmation before opening the
-- target URL in a new tab — it's an explicit nav-off-platform rather
-- than a content stream.
--
-- Two changes:
--
--   1. ALTER TYPE channel_type ADD VALUE 'guild_link' — must run
--      OUTSIDE a transaction (Postgres restriction on enum ALTER).
--      Drizzle's migrator handles this automatically because the
--      enum ALTER is the only statement in this migration when
--      bundled correctly. We also wrap the column ADD in its own
--      ALTER TABLE so the file stays scannable.
--
--   2. ADD COLUMN link_url text on channels. Nullable — only set for
--      guild_link rows; remains NULL for everything else.

ALTER TYPE "channel_type" ADD VALUE IF NOT EXISTS 'guild_link';

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "link_url" text;
