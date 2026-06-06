-- ── E2EE for DMs: shared-key model ───────────────────────────────────────
--
-- Both users of a 1:1 DM share a single symmetric encryption key,
-- derived from a passphrase one of them picks and tells the other
-- via any out-of-band channel. The server NEVER sees the passphrase
-- or the derived key — only:
--
--   e2ee_salt:     16 random bytes (base64), used by PBKDF2 on the
--                  client to deterministically rederive the key from
--                  the passphrase. Must be the same on both clients.
--   e2ee_verifier: SHA-256 of the derived key (base64). Lets each
--                  client verify "I typed the right password" without
--                  the server learning the key. The verifier is
--                  one-way: the password is offline-crackable from
--                  it, but only for weak passwords (high-entropy
--                  passphrases are computationally safe).
--
-- e2ee_enabled is true iff salt + verifier are populated. The boolean
-- is redundant with the not-null check but makes the schema's intent
-- crystal-clear and gives us a cheap WHERE filter.
--
-- These columns are NULL until a user enables E2EE on the DM. Once
-- enabled, the channel's existing message history is preserved (those
-- messages remain plaintext); only NEW messages are encrypted.
-- Disabling resets all three columns AND purges any zkE2EE/* messages
-- (the user's stated intent: "If disabled chat is purged"). Re-enabling
-- generates a fresh salt and a fresh password is required.
ALTER TABLE channels
  ADD COLUMN e2ee_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE channels
  ADD COLUMN e2ee_salt TEXT;

ALTER TABLE channels
  ADD COLUMN e2ee_verifier TEXT;
