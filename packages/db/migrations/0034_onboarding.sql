-- 0034_onboarding.sql
--
-- Onboarding flow: per-guild rules screening that gates new members
-- behind a rules-acknowledgment step before they can send messages,
-- react, or join voice.
--
-- Three columns added:
--   1. guild_members.membership_state
--      Text column constrained to 'pending' | 'active'. Set to 'pending'
--      when a member joins a guild that has rules_content configured.
--      Cleared to 'active' when the member POSTs the acknowledgment.
--      Existing rows default to 'active' so we don't retroactively gate
--      established members behind a rules wall they never agreed to.
--
--   2. guilds.rules_content
--      Markdown text of the server rules. NULL = no onboarding gate;
--      non-null = new joiners start pending. Bounded at 10 KB at the
--      API layer (a few thousand words of rules is plenty).
--
--   3. guilds.rules_updated_at
--      When admins last edited the rules. Future feature can use this
--      to optionally re-prompt established members when rules change
--      substantively. v1 just tracks it — no re-prompting yet.
--
-- The text-with-CHECK pattern (vs pgEnum) lets us add new states
-- ('kicked_pending_rejection', 'paused_for_review', etc.) later
-- without a schema migration. Audit action codes use the same
-- pattern for the same reason.

ALTER TABLE guild_members
  ADD COLUMN membership_state TEXT NOT NULL DEFAULT 'active'
    CHECK (membership_state IN ('pending', 'active'));

ALTER TABLE guilds
  ADD COLUMN rules_content TEXT,
  ADD COLUMN rules_updated_at TIMESTAMPTZ;

-- Partial index for the "find all pending members in this guild"
-- query that admin tooling will eventually use. Most members are
-- 'active' so the index size is small relative to the full table.
-- Also makes "is THIS member pending?" lookups cheaper for guilds
-- with rules_content set.
CREATE INDEX guild_members_pending_idx
  ON guild_members (guild_id, user_id)
  WHERE membership_state = 'pending';
