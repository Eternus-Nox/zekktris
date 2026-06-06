-- 0036_scheduled_events.sql
--
-- Scheduled events: time-bounded happenings in a guild. Members can
-- RSVP, get notified at start, and see who else is attending.
--
-- Two tables:
--
--   1. scheduled_events
--      Each row is one event. Status transitions:
--        scheduled → active   (sweep at start_at, or admin manual)
--        active    → completed (sweep at end_at, or admin manual)
--        any       → canceled (admin manual; terminal)
--
--      Location is either a guild voice/stage channel (members "join
--      the event" by joining the channel) or external (free-form
--      string for off-platform events: Twitter Spaces, Zoom links,
--      "IRL @ the cafe").
--
--   2. event_rsvps
--      One row per (event, user) at most — PK enforces. Status is
--      'going' / 'maybe' / 'declined'. Member changes their mind
--      by updating; un-RSVPing entirely is a DELETE.
--
-- Indexes:
--   scheduled_events_guild_start_idx — primary listing path
--   scheduled_events_status_start_idx — sweep query
--
-- The status sweep runs in the same in-process scheduler that
-- already handles purgeExpiredSessions and runCompressionSweep.

CREATE TABLE scheduled_events (
  id BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  -- Creator may be deleted later; SET NULL preserves the event row
  -- (event history is community memory; losing it because the
  -- creator left would be bad).
  creator_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  -- Null end_at means open-ended (e.g. "office hours all afternoon",
  -- "happens whenever we get there"). Service treats null end as
  -- never auto-completing — admin manually marks complete.
  end_at TIMESTAMPTZ,
  location_kind TEXT NOT NULL CHECK (
    location_kind IN ('voice_channel', 'external')
  ),
  -- Channel ref for 'voice_channel' kind; null otherwise. SET NULL
  -- on channel delete so the event survives but loses its target —
  -- service detects this and treats it as an external event with
  -- empty location_text (admin can update to fix).
  location_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
  -- Free-form text for 'external' kind; null otherwise.
  location_text TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (
    status IN ('scheduled', 'active', 'completed', 'canceled')
  ),
  -- Optional banner image (CDN path), same shape as guild iconUrl.
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Main listing path: "show me upcoming events in this guild." The
-- (guild_id, start_at) composite supports both filtering by guild
-- and ordering by start time without an extra sort step.
CREATE INDEX scheduled_events_guild_start_idx
  ON scheduled_events (guild_id, start_at);

-- Sweep query: "find events whose status is stale relative to
-- their start/end times." Partial index excludes terminal states
-- (completed, canceled) which the sweep doesn't need to revisit.
CREATE INDEX scheduled_events_active_idx
  ON scheduled_events (status, start_at)
  WHERE status IN ('scheduled', 'active');

CREATE TABLE event_rsvps (
  event_id BIGINT NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('going', 'maybe', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- Reverse-direction index: "what's this user RSVP'd to?" Used by
-- the "your upcoming events" personal-dashboard view.
CREATE INDEX event_rsvps_user_idx ON event_rsvps (user_id);

-- audit target enum extension — events get their own target type
-- so audit log filtering can isolate event-related actions.
ALTER TYPE "audit_target" ADD VALUE IF NOT EXISTS 'scheduled_event';
