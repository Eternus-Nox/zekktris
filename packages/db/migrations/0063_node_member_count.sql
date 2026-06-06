-- A node hosts exactly one guild and reports that guild's member count on each
-- heartbeat. Stored here so the admin Federation surface can show "N users" per
-- node. Defaults to 0 until the first heartbeat after upgrade.
ALTER TABLE "guild_nodes"
  ADD COLUMN IF NOT EXISTS "member_count" integer DEFAULT 0 NOT NULL;
