-- ── v1.71 scheduled messages ─────────────────────────────────────────────
--
-- Queue of messages composed-now-to-send-later. A worker polls this
-- table every minute, finds rows whose scheduled_for has passed,
-- and creates real messages for each.
--
-- Design notes:
--
--   id              Snowflake unique to the SCHEDULE record itself.
--                   When a row is processed, a separate snowflake is
--                   allocated for the resulting real message. The
--                   schedule id is never user-facing on the message —
--                   it just identifies the queued entry.
--
--   author_id       User who scheduled the send. Validated against
--                   the channel at send time (the user may have been
--                   removed from the guild between scheduling and
--                   sending — handled gracefully by the worker).
--
--   channel_id      Denormalized into the row so the worker's poll
--                   query is a single index scan and doesn't need
--                   to join channels.
--
--   content         The message body. Same length limit (4000 chars)
--                   that real messages have.
--
--   attachments_json    Opaque JSON blob the API frontend stuffs with
--                       whatever attachment metadata it has (CDN urls,
--                       filenames, content-types). Passed through to
--                       the actual message at send time.
--
--   reply_to_message_id  Optional — if set, the resulting message
--                        references this as its reply target.
--
--   scheduled_for   When the message should send. Indexed because
--                   the worker's poll is `WHERE scheduled_for <= now`.
--
--   attempts        Bumped by the worker on each send try. After 3
--                   failed attempts the worker stops retrying and
--                   keeps the row for inspection — it appears in the
--                   user's scheduled list with an error tag so they
--                   can investigate and delete/reschedule.
--
--   last_error      Human-readable error from the most recent failed
--                   attempt. Null for fresh / successfully-sent rows.

CREATE TABLE scheduled_messages (
  id BIGINT PRIMARY KEY,
  author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  attachments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to_message_id BIGINT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Worker's poll uses this index. (attempts < 3) is a partial-index
-- predicate so the worker scan ignores permanently-failed rows
-- without filtering them out post-hoc.
CREATE INDEX idx_scheduled_messages_due
  ON scheduled_messages(scheduled_for)
  WHERE attempts < 3;

-- For the "show my scheduled messages" list endpoint. Sorted by
-- scheduled_for ASC (next-to-send first) within the user scope.
CREATE INDEX idx_scheduled_messages_author
  ON scheduled_messages(author_id, scheduled_for);
