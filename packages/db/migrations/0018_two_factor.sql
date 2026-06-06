-- 0017_two_factor.sql
--
-- Two-factor authentication (TOTP).
--
-- Three columns on users + a sibling table for recovery codes.
--
-- totp_secret    base32-encoded shared secret. Stored plaintext on
--                the row; this is standard for TOTP (the secret IS
--                the credential — encrypting it at rest only helps
--                if the db is compromised but the app-server keys
--                aren't, which is a narrow threat model for a
--                self-hosted Discord clone).
-- totp_enabled   boolean gate. Set to true only after the user
--                has confirmed a valid code with the freshly-generated
--                secret — without this an attacker who got mid-flow
--                interrupted could leave a half-finished setup with
--                a known secret hanging on the account.
-- totp_verified_at  for the audit log. Records the most-recent
--                successful TOTP check (or NULL if never).
--
-- Recovery codes are one-shot bypass codes printed during enrollment.
-- Each is stored as a sha256 hash so the plaintext never lives in
-- the database; on consumption the row is deleted.

ALTER TABLE users
  ADD COLUMN totp_secret text,
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_verified_at timestamptz;

CREATE TABLE user_recovery_codes (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

CREATE INDEX user_recovery_codes_user_id_idx ON user_recovery_codes (user_id);
