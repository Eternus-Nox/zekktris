-- 0021_user_banned_at.sql
-- ---------------------------------------------------------------
-- Instance-level user ban marker. Sister column to `is_admin`:
--   - banned_at IS NULL → normal user
--   - banned_at IS NOT NULL → banned, can't sign in
--
-- Soft-ban (a timestamp rather than a hard delete) keeps the user's
-- content intact so message attribution and audit history remain
-- meaningful. The admin can flip the bit back without data loss.
-- Login flow filters on `banned_at IS NULL` to reject the auth.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_at timestamptz;

-- Cheap partial index — most queries care about NULL/NOT NULL, and
-- the banned set is rare. Used by /admin/users?bannedOnly=true and
-- by login-time rejection.
CREATE INDEX IF NOT EXISTS users_banned_at_idx
  ON users (banned_at)
  WHERE banned_at IS NOT NULL;
