-- ── v1.69 automod enhancements ──────────────────────────────────────────
--
-- Three additions, all to automod_rules:
--
-- 1. exempt_channel_ids — when populated, the rule does NOT apply in
--    those channels. Symmetric to exempt_role_ids. Use case:
--    profanity allowed in #shitposting but blocked everywhere else.
--    Empty array = applies in all channels (the default).
--
-- 2. rule_type accepts two new values reserved here at the schema
--    layer: 'regex_pattern' (admin-supplied raw regex, no word-
--    boundary wrapping) and 'link_filter' (link/invite blocker
--    keyed on a domain blocklist OR a "block all Zekktris invites"
--    flag stored in the patterns array as the special token
--    'zk:invite').
--
-- 3. action accepts 'log_only' — the rule fires (audit entry
--    written) but the message is NOT blocked. Used by admins who
--    want to observe a rule's hit rate before flipping it to
--    enforcement, OR to silently track suspicious senders.
--
-- The TEXT columns for rule_type and action are unconstrained at
-- the DB level (no CHECK), so new enum values don't need a DDL
-- step — the service code validates allowed values on write.

ALTER TABLE automod_rules
  ADD COLUMN exempt_channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
