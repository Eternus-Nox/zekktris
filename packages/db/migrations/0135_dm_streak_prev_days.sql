-- DM streaks: keep each side's previous message day as well as its last one.
--
-- The send route credits a message to the UTC day of its createdAt, but the
-- streak update runs after the send, fire-and-forget, and calls can reach the
-- per-DM lock out of order. A hi sent just before midnight can arrive after a
-- next-day message from either person, which has already moved that person's
-- last_day_* past the old day. With only one stamp per side, "both messaged on
-- that day" could no longer be seen and the day was never credited: the
-- streak restarted at 1 and the Zekk Pet fell asleep although both people
-- messaged every day.
--
-- prev_day_a / prev_day_b hold the day before last_day_a / last_day_b on which
-- that side messaged (the stamp's previous value; a late call for an older day
-- writes its day here). services/streaks.ts counts a side as having messaged on
-- a day when either column equals it. NULL for existing rows: nothing is lost
-- that the old single stamp still knew.
ALTER TABLE "dm_streaks" ADD COLUMN IF NOT EXISTS "prev_day_a" text;
--> statement-breakpoint
ALTER TABLE "dm_streaks" ADD COLUMN IF NOT EXISTS "prev_day_b" text;
