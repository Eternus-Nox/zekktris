-- 0039_thread_archive.sql
--
-- Thread archive lifecycle: track activity and per-thread auto-archive
-- duration so the periodic sweep can flip idle threads to archived.
--
-- Two columns on channels:
--
--   thread_last_activity_at: bumped on every message post into the
--     thread. The auto-archive countdown starts here — sweep flips
--     archived_at = now() when last_activity_at + auto_archive_minutes
--     has passed. NULL for non-thread channels.
--
--   thread_auto_archive_minutes: per-thread idle duration. Discord
--     uses 60 / 1440 / 4320 / 10080 (1h / 1d / 3d / 7d). Default
--     4320 (3 days) for backfill of existing threads. NULL for
--     non-thread channels.
--
-- Backfill:
--   - Existing active threads: thread_last_activity_at = updated_at
--     (the column is bumped on archive/unarchive, so it's a
--     reasonable proxy for "last touched"). Conversations resume
--     normally — next message post will set the real activity stamp.
--   - Archived threads: leave both columns NULL. They aren't part
--     of the sweep target set.
--
-- Partial index supports the sweep predicate. WHERE filters to just
-- active threads, so the index size stays bounded even on guilds
-- with thousands of historical archived posts.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS thread_last_activity_at TIMESTAMPTZ;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS thread_auto_archive_minutes INTEGER;

-- Backfill active threads with sensible defaults so the sweep has
-- valid input from day one. The 3-day default matches Discord's
-- ergonomic middle option (long enough for asynchronous discussions
-- to breathe, short enough to keep the active-thread list tidy).
UPDATE channels
   SET thread_last_activity_at = updated_at,
       thread_auto_archive_minutes = 4320
 WHERE type = 'public_thread'
   AND deleted_at IS NULL
   AND thread_archived_at IS NULL;

-- Sweep target: active threads ordered by their auto-archive deadline.
-- WHERE filters by type + non-archived so the index doesn't include
-- the much larger archived set. Index expression sorts by the
-- computed deadline so a single ORDER BY on the index can pick the
-- next-to-archive batch without a sort step at scan time.
CREATE INDEX IF NOT EXISTS channels_active_threads_idx
  ON channels (thread_last_activity_at)
  WHERE type = 'public_thread'
    AND deleted_at IS NULL
    AND thread_archived_at IS NULL;
