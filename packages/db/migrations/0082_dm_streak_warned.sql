-- DM streak "expires soon" warning support. Add a per-DM watermark for the
-- UTC day a warning was last sent, so the sweep warns at most once per day per
-- channel (set atomically inside the sweep's UPDATE so two ticks/replicas never
-- double-send). IF NOT EXISTS keeps this idempotent.
ALTER TABLE "dm_streaks" ADD COLUMN IF NOT EXISTS "streak_warned_for_day" text;
--> statement-breakpoint
-- Partial index for the sweep's hot path:
--   WHERE streak > 0 AND last_counted_day = :yesterday
-- Only live streaks (streak > 0) are ever candidates, so index just those.
CREATE INDEX IF NOT EXISTS "dm_streaks_warn_sweep_idx" ON "dm_streaks" ("last_counted_day") WHERE "streak" > 0;
