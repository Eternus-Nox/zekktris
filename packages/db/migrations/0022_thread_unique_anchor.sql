-- 0022_thread_unique_anchor.sql
-- ---------------------------------------------------------------
-- Threads are channels with type='public_thread' that anchor to a
-- specific message. The createThread service does SELECT-then-INSERT
-- on (parent_message_id, type='public_thread', deleted_at IS NULL),
-- and without a uniqueness constraint two concurrent calls (the user
-- mashes the "Create Thread" button twice, or two tabs both click it)
-- can each pass the SELECT and each INSERT, producing two parallel
-- threads anchored to the same message that then work independently.
--
-- This index makes the second INSERT fail with Postgres 23505 so the
-- service can catch the conflict and return the winning thread.
--
-- Partial on (type='public_thread' AND deleted_at IS NULL) so:
--   - non-thread channel rows aren't constrained
--   - a thread that was soft-deleted (rare; threads are typically
--     archived, not deleted) doesn't block creating a fresh one on
--     the same anchor message later
--   - parent_message_id NULL rows (every non-thread channel) are
--     excluded by Postgres's NULL handling on UNIQUE anyway, but the
--     partial predicate is cheaper than a global index over a column
--     that's mostly NULL.

CREATE UNIQUE INDEX IF NOT EXISTS channels_thread_anchor_unique_idx
  ON channels (parent_message_id)
  WHERE type = 'public_thread' AND deleted_at IS NULL;
