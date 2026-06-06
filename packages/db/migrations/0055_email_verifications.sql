-- Signup email-verification tokens (single-use, hash-only), mirroring
-- password_resets. Consumed by POST /auth/verify-email.
CREATE TABLE email_verifications (
  id          BIGINT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_verifications_token_idx ON email_verifications (token_hash);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id);
