-- Server (guild-member) nicknames removed — only the private DM nickname
-- system remains (dm_nicknames). Drop the now-unused column.
ALTER TABLE "guild_members" DROP COLUMN IF EXISTS "nickname";
