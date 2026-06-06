-- 0026_dm_auto_delete.sql
-- ---------------------------------------------------------------
-- DM auto-delete (Snapchat-style ephemeral messages). Two pieces:
--
--   1. dm_settings — per-DM-channel config. For now only `ttl_seconds_after_read`
--      lives here (NULL = no auto-delete = unbounded retention, the default).
--      Either recipient can change the setting; the change applies to BOTH
--      sides immediately (it's a property of the conversation, not a per-user
--      preference).
--
--   2. messages.viewed_at — first time a NON-AUTHOR participant actually saw
--      this message. Stamped lazily on message-fetch in DMs that have a TTL
--      configured. NULL means "never viewed by the other party"; once
--      stamped it sticks, and the sweep deletes messages whose viewed_at
--      is older than (now - ttl_seconds_after_read) seconds. Group DMs
--      use first-viewer-among-recipients (we don't track per-user viewing).
--
-- Why a separate column vs. piggybacking on read_states? read_states is
-- per-(user, channel) and tracks the LAST acked message id; we need
-- per-message timing so a slow reader doesn't extend the lifetime of
-- old messages while they're scrolling through them.

CREATE TABLE IF NOT EXISTS dm_settings (
  channel_id          BIGINT  PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  -- NULL = auto-delete off. Positive integer = seconds after a message
  -- is viewed by the other party before it gets soft-deleted by the
  -- sweep. Common values: 30, 60, 120.
  ttl_seconds_after_read INTEGER,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMP WITH TIME ZONE;

-- Sweep query needs to find messages where viewed_at is past TTL.
-- The sweep is bounded by which DMs even have a TTL set, but for
-- those it scans by viewed_at + channel_id. Partial index keeps the
-- on-disk footprint small for non-TTL DMs (the vast majority).
CREATE INDEX IF NOT EXISTS messages_viewed_at_idx
  ON messages (channel_id, viewed_at)
  WHERE viewed_at IS NOT NULL AND deleted_at IS NULL;
