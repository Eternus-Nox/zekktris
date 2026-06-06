-- 0025_guild_forum_channel_type.sql
-- ---------------------------------------------------------------
-- Adds `guild_forum` to the channel_type enum. Forum channels are
-- post containers: each forum holds a list of public_thread children
-- where each thread is a post. The UI surface for a forum is a list
-- of posts rather than a message stream; clicking a post opens its
-- thread as a regular message view.
--
-- This is purely additive — existing channel rows keep their types
-- unchanged. The enum addition is backwards-compatible: code that
-- pattern-matches on known types will continue to work, and code that
-- needs to handle the new type will fail loudly via the TypeScript
-- type checker (we updated the union type in lockstep with this
-- migration).

ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'guild_forum';
