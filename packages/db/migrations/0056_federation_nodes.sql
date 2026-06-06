-- Federation foundations (additive + inert). Registry of enrolled guild nodes
-- + a nullable guilds.node_id pointer (NULL = hosted on this backbone).
CREATE TABLE guild_nodes (
  id                BIGINT PRIMARY KEY,
  name              TEXT NOT NULL,
  owner_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_url          TEXT NOT NULL,
  gateway_url       TEXT,
  public_key        TEXT NOT NULL,
  secret_hash       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  protocol_version  INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ
);
CREATE INDEX guild_nodes_owner_idx ON guild_nodes (owner_id);
CREATE UNIQUE INDEX guild_nodes_base_url_idx ON guild_nodes (base_url);

ALTER TABLE guilds ADD COLUMN node_id BIGINT;
ALTER TABLE guilds ADD CONSTRAINT guilds_node_id_fkey
  FOREIGN KEY (node_id) REFERENCES guild_nodes(id) ON DELETE SET NULL;
CREATE INDEX guilds_node_id_idx ON guilds (node_id);
