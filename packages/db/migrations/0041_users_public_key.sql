-- ── E2EE for DMs: per-user X25519 identity public key ───────────────────────
--
-- Stored as TEXT (base64-encoded 32-byte Curve25519 public key, ~44 chars).
-- Generated lazily on the client when a user first sends to a DM; uploaded
-- via PATCH /users/@me. The corresponding private key never leaves the
-- client's localStorage.
--
-- Nullable: users who have not yet sent an E2EE message have no public key.
-- Their conversations fall back to plaintext until they generate one.
ALTER TABLE users
  ADD COLUMN public_key TEXT;
