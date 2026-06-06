-- Federation join requests: a node can self-submit a request to join the
-- backbone, which the admin accepts/rejects. Such a request has no backbone
-- owner and no secret until the node claims one after acceptance, so owner_id
-- and secret_hash become nullable. claim_token_hash authenticates the node's
-- one-time credential pickup.
ALTER TABLE "guild_nodes" ALTER COLUMN "owner_id" DROP NOT NULL;
ALTER TABLE "guild_nodes" ALTER COLUMN "secret_hash" DROP NOT NULL;
ALTER TABLE "guild_nodes" ADD COLUMN "claim_token_hash" text;
