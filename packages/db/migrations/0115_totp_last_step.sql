-- Single-use TOTP. Record the last TOTP step (the 30-second RFC 6238 counter)
-- a user successfully verified, so a captured 6-digit code can't be replayed
-- within its ±1-window (~90s) validity. Verification now compare-and-sets this
-- column: a code whose step is <= the stored value is rejected as a replay.
-- Nullable: null means "no code consumed yet", so the first verify of any step
-- succeeds.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_last_step" bigint;
