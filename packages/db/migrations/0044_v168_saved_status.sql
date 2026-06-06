-- ── v1.68 features: saved messages + custom status ──────────────────────

-- Custom status enhancement. The `custom_status` text column already
-- exists on users; v1.68 extends it with two siblings:
--   custom_status_emoji:       a unicode emoji or short code, e.g. "📚"
--   custom_status_expires_at:  optional expiry; the client treats a
--                              past timestamp as "no status" without
--                              waiting on a server cleanup job.
--
-- Both nullable. NULL emoji + NULL custom_status + NULL expires_at =
-- no status set. Text-only and emoji-only states are both valid.
ALTER TABLE users ADD COLUMN custom_status_emoji TEXT;
ALTER TABLE users ADD COLUMN custom_status_expires_at TIMESTAMPTZ;

-- Saved-message bookmarks. One row per (user, message) save. The
-- (user_id, message_id) composite primary key gives us idempotent
-- saves for free (PostgreSQL rejects duplicates; the API wraps that
-- in an ON CONFLICT DO NOTHING so the caller doesn't need to know).
--
-- Both foreign keys cascade on parent delete so a deleted user
-- doesn't leave dangling rows, and a deleted message disappears
-- from everyone's saved list automatically.
--
-- The (user_id, saved_at DESC) index is the index that the /saved
-- listing query uses — we sort by save time descending so the most
-- recently saved appears first.
CREATE TABLE saved_messages (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_saved_messages_user_savedat
  ON saved_messages(user_id, saved_at DESC);
