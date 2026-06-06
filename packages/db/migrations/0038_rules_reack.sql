-- 0038_rules_reack.sql
--
-- Re-prompting on substantive rules changes. When an admin updates
-- the rules content (not just a typo fix the admin doesn't care
-- about; substantive enough to warrant re-acknowledgment), every
-- member's prior acknowledgment goes "stale" — they're treated as
-- pending until they re-acknowledge.
--
-- This is implemented by:
--
--   1. Adding `rules_acknowledged_at` to guild_members. NULL = never
--      acknowledged. Otherwise the timestamp of last acknowledge.
--
--   2. Comparing against guilds.rules_updated_at at gate-check time:
--      stale iff (rules_acknowledged_at IS NULL OR
--      rules_acknowledged_at < rules_updated_at) AND rules content
--      is non-null.
--
--   3. The acknowledgeRules service stamping rules_acknowledged_at
--      = NOW() on each acknowledge.
--
-- Backfill: existing 'active' members get rules_acknowledged_at set
-- to NOW() during this migration. Without the backfill, every
-- existing active member would be re-prompted immediately on first
-- deploy — surprising and annoying for users who didn't ask for it.
-- After the backfill, existing members effectively "acknowledged"
-- at migration time, and only future rules updates will re-prompt.

ALTER TABLE guild_members ADD COLUMN rules_acknowledged_at TIMESTAMPTZ;

-- Backfill: all currently-active members are deemed to have acknowledged
-- the current rules version. Pending members stay at NULL — their next
-- acknowledgment path is the OnboardingModal as usual.
UPDATE guild_members
   SET rules_acknowledged_at = NOW()
 WHERE membership_state = 'active';
