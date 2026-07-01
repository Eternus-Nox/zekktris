-- Expand a supervised child's capability toggles beyond voice/friends/create-
-- guild so the supervision restrictions actually cover the high-traffic
-- surfaces: joining servers, sending messages, and direct messages.
--
--   allow_join_guilds — accept invites / join discoverable servers
--   allow_messaging   — post in server channels
--   dm_policy         — who the child may DM: 'none' | 'friends' | 'all'
--
-- Defaults keep every existing linked child usable (all on, DMs friends-only).
-- Unlinked minors are handed the STRICT profile in code (everything off,
-- dm_policy 'none'), so the defaults here only shape parent-configured rows.
ALTER TABLE "child_restrictions" ADD COLUMN "allow_join_guilds" boolean NOT NULL DEFAULT true;
ALTER TABLE "child_restrictions" ADD COLUMN "allow_messaging" boolean NOT NULL DEFAULT true;
ALTER TABLE "child_restrictions" ADD COLUMN "dm_policy" text NOT NULL DEFAULT 'friends';
