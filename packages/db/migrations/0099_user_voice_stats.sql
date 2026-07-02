-- Per-user voice participation counters, maintained by the voice service at
-- join/leave time (voice_states rows are live-only — deleted on leave — so
-- nothing else records that a session ever happened). Powers the voice
-- achievements: first_contact (joined a call) and event_horizon (an hour of
-- total voice time). Best-effort stats: a crash/eviction between join and
-- leave can drop that segment's seconds; joins are counted at join time.
CREATE TABLE "user_voice_stats" (
  "user_id" bigint PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "joins" integer NOT NULL DEFAULT 0,
  "total_seconds" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
