-- Audit-log keyset pagination filters guild_id and orders/keysets by id (DESC
-- in the Admin→Audit Log view, ASC in export). The existing
-- (guild_id, created_at) index can't satisfy ORDER BY id — id is a distinct
-- (though correlated) column — so Postgres seeks by guild_id then Sorts the
-- whole guild's audit history per page. This additive (guild_id, id) btree
-- serves both directions (a DESC scan reads the btree backwards). The old
-- index is kept (dropping on a live table is a separate risk).
CREATE INDEX IF NOT EXISTS "audit_log_guild_id_idx" ON "audit_log_entries" USING btree ("guild_id","id");
