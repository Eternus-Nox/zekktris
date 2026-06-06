-- 0027_dm_voice_calls.sql
-- ---------------------------------------------------------------
-- Make voice_states.guild_id nullable so 1-on-1 DM calls can use
-- the same voice_states table. Previously voice was guild-only; DM
-- calls need a voice state row but have no guild context (the
-- "audience" for VOICE_STATE_UPDATE in a DM is the dm_recipients
-- set, not a guild member list).
--
-- This is the minimum schema change required for DM calls. Service
-- code that reads `guildId` from voice_states now has to handle null
-- (the type checker enforces this once the drizzle schema is updated
-- to match — see channels.ts).

ALTER TABLE voice_states
  ALTER COLUMN guild_id DROP NOT NULL;
