-- Remove the federation / "self-host your own node" registry.
--
-- The federated guild-node feature was removed from the app. guild_nodes is
-- empty (no nodes were ever enrolled in this deployment) and guilds.node_id is
-- always NULL (every guild is local), so dropping them loses no data. All
-- statements use IF EXISTS so this is safe to run even if a prior partial
-- cleanup already removed some of these objects.

-- Drop the FK + index + column on guilds first (they reference guild_nodes).
ALTER TABLE guilds DROP CONSTRAINT IF EXISTS guilds_node_id_fkey;
DROP INDEX IF EXISTS guilds_node_id_idx;
ALTER TABLE guilds DROP COLUMN IF EXISTS node_id;

-- Then the registry table itself.
DROP TABLE IF EXISTS guild_nodes;

-- Drop the node-mirror flag on users (set only when mirroring backbone
-- users onto a node; always false in a standalone deployment).
ALTER TABLE users DROP COLUMN IF EXISTS federated;
