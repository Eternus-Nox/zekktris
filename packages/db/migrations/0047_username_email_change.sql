-- ── v1.76 username + email change ────────────────────────────────────────
--
-- Two additions:
--
-- 1. users.username_changed_at — null until the user changes their
--    username for the first time, then set to the change timestamp.
--    Service-layer cooldown check: (now() - username_changed_at) >=
--    90 days OR username_changed_at IS NULL.
--
-- 2. email_change_requests — same shape as password_resets. The user
--    submits a change with their current password + the desired new
--    email; the server stores a hashed token, then mails a
--    verification link to the NEW address. Clicking the link
--    completes the change. Plaintext token is never stored.
--
--    A unique index on token_hash ensures no two outstanding
--    requests share a token (same defense-in-depth as password
--    resets). The user_id index supports "list any pending requests
--    for this user" which the UI uses to show a pending banner.

ALTER TABLE users ADD COLUMN username_changed_at TIMESTAMPTZ;

CREATE TABLE email_change_requests (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** SHA-256 hex of the plaintext token mailed to the new email
      address. Plaintext is never stored. */
  token_hash TEXT NOT NULL,
  /** The email the user is trying to switch TO. Validated +
      lowercased before insert; checked for uniqueness at confirm
      time (someone else may have grabbed it in the gap between
      request and confirm). */
  new_email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  /** Set on successful confirm. Re-using the same token fails
      because the find-by-hash query gates on used_at IS NULL. */
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX email_change_requests_token_idx
  ON email_change_requests(token_hash);
CREATE INDEX email_change_requests_user_idx
  ON email_change_requests(user_id);
