-- Timed instance bans. banned_at alone = permanent ban (today's behaviour).
-- banned_at set + banned_until in the future = a timed ban that auto-lifts at
-- banned_until (an hourly sweep clears it; auth checks also treat an expired
-- timed ban as not-banned so there's no lag between expiry and the sweep).
ALTER TABLE "users" ADD COLUMN "banned_until" timestamp with time zone;

-- Partial index for the auto-unban sweep: only currently-timed-banned rows.
CREATE INDEX IF NOT EXISTS "users_banned_until_idx"
  ON "users" ("banned_until")
  WHERE "banned_until" IS NOT NULL;
