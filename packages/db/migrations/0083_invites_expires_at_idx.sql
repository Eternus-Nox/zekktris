-- Back the periodic dead-invite prune sweep (services/invites.pruneDeadInvites),
-- which deletes invites where expires_at < (now - grace). Without an index this
-- is a full table scan every 6h; nearly every invite carries a 24h TTL so the
-- table can grow large between prunes. IF NOT EXISTS keeps this idempotent.
CREATE INDEX IF NOT EXISTS "invites_expires_at_idx" ON "invites" ("expires_at");
