-- Tracks when a user's current continuous self-mute began. The AFK
-- auto-move sweep relocates anyone self-muted longer than the guild's
-- afk_timeout_seconds into the AFK channel. NULL whenever not self-muted.
ALTER TABLE voice_states ADD COLUMN IF NOT EXISTS self_mute_at timestamptz;
