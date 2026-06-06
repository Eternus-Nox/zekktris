-- Raid protection (join gates + raid mode)
-- ----------------------------------------
-- Per-guild controls that blunt raids and low-effort spam accounts:
--   min_account_age_minutes  — reject joins from accounts younger than this
--                              (0 = no requirement).
--   require_verified_email   — reject joins from accounts without a verified
--                              email.
--   raid_mode_enabled        — hard lockdown: refuse all new joins. Toggled
--                              manually by a mod, or flipped on automatically
--                              when the join-rate limit below trips.
--   join_rate_limit_count /  — if both are set, more than <count> joins
--   join_rate_limit_seconds    within <seconds> auto-enables raid mode.
--                              NULL on either disables the auto-trigger.
ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "min_account_age_minutes" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "require_verified_email" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "raid_mode_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "join_rate_limit_count" integer,
  ADD COLUMN IF NOT EXISTS "join_rate_limit_seconds" integer;
