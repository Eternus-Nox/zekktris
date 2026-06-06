-- ── v2.47 parental controls (Phase 3: restrictions + approval requests) ──
--
-- The restriction toggles + blocked-guild table already exist (0052).
-- This adds the approval-request queue: when a supervised child is
-- restricted from adding a friend or joining a server, they can ask
-- their parent to approve it. The parent approves (which performs the
-- action on the child's behalf) or denies.

CREATE TYPE child_request_type AS ENUM ('friend', 'guild');
CREATE TYPE child_request_status AS ENUM ('pending', 'approved', 'denied');

CREATE TABLE child_requests (
  id             BIGINT PRIMARY KEY,
  child_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           child_request_type NOT NULL,
  target_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  guild_id       BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  invite_code    TEXT,
  note           TEXT,
  status         child_request_status NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);
CREATE INDEX child_requests_child_idx ON child_requests (child_id, status);
