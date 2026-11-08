-- Signal-style disappearing messages.
--
-- Until now the DM auto-delete applied the conversation's CURRENT
-- dm_settings.ttl_seconds_after_read to every message's viewed_at: turning it
-- on wiped all history viewed longer ago than the timer (viewed_at is stamped
-- in every DM since 0028), and turning it off rescued anything not yet swept.
-- From here on each message carries the timer it was SENT with, and its own
-- deadline once a recipient has read it:
--
--   expire_after_seconds — the DM's timer at send time (createMessage), or
--                          NULL when the message never disappears. Changing
--                          the setting only affects later messages.
--   expires_at           — read time + expire_after_seconds, stamped by the
--                          first recipient's read ack. NULL until then. The
--                          sweep soft-deletes rows once it has passed; rows
--                          with a NULL expires_at are never swept.
--
-- 'system_disappearing' is the "X set disappearing messages to 1 day" notice
-- posted when the timer changes. drizzle runs every pending migration in ONE
-- transaction, and Postgres won't let a value added there be used before that
-- transaction commits, so nothing in this migration (or any other shipped in
-- the same deploy) may reference it.
ALTER TYPE "message_type" ADD VALUE IF NOT EXISTS 'system_disappearing';
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "expire_after_seconds" integer;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: every undeleted message in a DM with a timer set takes that timer,
-- and an already-viewed one the deadline the old sweep would have given it
-- (viewed_at + timer). That is exactly the set today's sweep would delete, so
-- nothing that vanishes today stops vanishing; unviewed messages start their
-- clock on the recipient's next read, as new ones do. Re-running is a no-op.
UPDATE "messages" AS m
   SET "expire_after_seconds" = s."ttl_seconds_after_read",
       "expires_at" = CASE
         WHEN m."viewed_at" IS NOT NULL
           THEN m."viewed_at" + make_interval(secs => s."ttl_seconds_after_read")
       END
  FROM "dm_settings" AS s
 WHERE m."channel_id" = s."channel_id"
   AND s."ttl_seconds_after_read" IS NOT NULL
   AND m."deleted_at" IS NULL
   AND m."expire_after_seconds" IS NULL;
--> statement-breakpoint
-- The sweep's scan: rows with a deadline that haven't been deleted yet, oldest
-- deadline first. Partial, so it only holds messages that are counting down.
--
-- NOTE FOR LARGE DEPLOYMENTS: like 0089, this runs inside the transactional
-- migrator, so it CANNOT use CREATE INDEX CONCURRENTLY — a plain build takes a
-- SHARE lock that blocks writes to `messages` while it builds. On a very large
-- `messages` table, build it out-of-band BEFORE deploying this migration:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_expires_at_idx
--     ON messages (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
-- The IF NOT EXISTS below then makes this statement a no-op.
CREATE INDEX IF NOT EXISTS "messages_expires_at_idx"
  ON "messages" ("expires_at")
  WHERE "expires_at" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
-- The read ack's clock start (dms.startDisappearingTimers) and the scheduled
-- fire's "anything from the other side still unread?" check: rows of one
-- channel sent with a timer whose clock hasn't started yet, by id. Partial, so
-- it only holds messages waiting for a reader — without it every ack in a DM
-- that ever had a timer walks the channel's whole history (deleted rows
-- included, which DMs never purge) through messages_channel_time_idx.
--
-- NOTE FOR LARGE DEPLOYMENTS: same write lock as the index above. Build it
-- out-of-band BEFORE deploying this migration:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_timer_pending_idx
--     ON messages (channel_id, id)
--     WHERE expire_after_seconds IS NOT NULL AND expires_at IS NULL AND deleted_at IS NULL;
-- The IF NOT EXISTS below then makes this statement a no-op.
CREATE INDEX IF NOT EXISTS "messages_timer_pending_idx"
  ON "messages" ("channel_id", "id")
  WHERE "expire_after_seconds" IS NOT NULL AND "expires_at" IS NULL AND "deleted_at" IS NULL;
