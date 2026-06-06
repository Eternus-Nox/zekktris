-- 0033_automod_rules.sql
--
-- Automod rules: per-guild policies that block message sends matching
-- configured patterns. First rule type shipped is `word_blocklist`;
-- `repeat_message` and `mention_spam` reserved for future migrations.
-- The CHECK constraint on rule_type prevents typos at insert time and
-- documents the supported set inline.

-- Extend the audit-target enum so audit log entries about automod
-- rules use a precise target type rather than reusing 'guild'. This
-- runs first because the CREATE TABLE below doesn't depend on it,
-- but conceptually the enum extension is a small DDL bump and we
-- want it visible at the top of the migration.
ALTER TYPE "audit_target" ADD VALUE IF NOT EXISTS 'automod_rule';
--
-- patterns: JSONB array of strings (case-insensitive substring/word-
-- boundary matches at enforcement time). JSONB rather than text[] so
-- we can extend each entry into a structured object later (per-pattern
-- whole-word toggle, etc.) without a schema migration. For the v1
-- ship, we expect bare strings.
--
-- exempt_role_ids: JSONB array of role-id strings whose holders bypass
-- this rule. Common patterns: exempt moderators, exempt verified roles.
--
-- action: 'block' rejects the message with a friendly error code;
-- 'block_and_timeout' additionally applies a timeout of timeout_seconds
-- duration to the sender (uses the same timeout mechanism as manual
-- moderator-issued timeouts).
--
-- Partial index on enabled=true because the hot read path (per-send
-- enforcement query in every guild that has any automod) only cares
-- about enabled rules. Disabled rules are kept for "temporarily off
-- but don't lose the config" UX. Index size scales with active rule
-- count rather than total config count.

CREATE TABLE automod_rules (
  id BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (
    rule_type IN ('word_blocklist', 'repeat_message', 'mention_spam')
  ),
  enabled BOOLEAN NOT NULL DEFAULT true,
  patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- For repeat_message: how many identical-content messages within
  -- window_seconds trigger the rule. Null/unused for other types.
  threshold INTEGER,
  window_seconds INTEGER,
  action TEXT NOT NULL DEFAULT 'block' CHECK (
    action IN ('block', 'block_and_timeout')
  ),
  -- When action = 'block_and_timeout', how long. Null when action is
  -- just 'block'. Capped to 28 days at the API layer to match manual
  -- timeouts.
  timeout_seconds INTEGER,
  exempt_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX automod_rules_guild_enabled_idx
  ON automod_rules (guild_id)
  WHERE enabled = true;
