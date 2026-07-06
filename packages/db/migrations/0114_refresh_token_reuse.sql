-- Refresh-token reuse detection (RFC 6819 §5.2.2.3). On each rotation we now
-- remember the hash of the token we just replaced. Presenting that superseded
-- token again — outside a brief concurrency grace that absorbs benign
-- multi-tab / lost-response double-submits — is a strong theft signal, and the
-- affected session is revoked so neither the victim nor the thief can keep
-- using that token family. Nullable: existing sessions simply have no recorded
-- predecessor until their next rotation.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "previous_refresh_token_hash" text;
