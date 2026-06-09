-- DM streaks: index the per-user lookup. `bestStreakForUser` (achievements)
-- scans `dm_streaks WHERE user_a_id = $1 OR user_b_id = $1`, which was a full
-- table scan. Two single-column indexes let Postgres BitmapOr the two arms;
-- a composite (user_a_id, user_b_id) would only serve the leading column.

CREATE INDEX IF NOT EXISTS "dm_streaks_user_a_idx" ON "dm_streaks" ("user_a_id");
CREATE INDEX IF NOT EXISTS "dm_streaks_user_b_idx" ON "dm_streaks" ("user_b_id");
