-- Voice channels: an optional "voice disabled" flag. When true, participants
-- join with a non-publishing LiveKit grant (mic disabled at the SFU) so the
-- channel works as a presence/hangout space but no one can talk. Same
-- enforcement path as the guild AFK channel. Idempotent.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS voice_disabled boolean NOT NULL DEFAULT false;
