-- Multi-device presence: split the user's CHOSEN status from their live
-- (effective) one.
--
-- Until now `users.status` was both what the user picked AND what the gateway
-- wrote as they connected, went idle and disconnected — so a disconnect wrote
-- 'offline' over a chosen Do Not Disturb, and a device's auto-idle overwrote
-- what another device in use had reported. From here on:
--   chosen_status — what the user picked (online | idle | dnd | invisible),
--                   changed only by PATCH /users/@me {status}. Never 'offline'.
--   status        — the effective presence everyone sees, recomputed by the
--                   gateway from chosen_status + every live connection's
--                   activity (apps/api/src/gateway/presence.ts).
--
-- Backfill: 'dnd' and 'invisible' carry over. 'idle' does NOT — almost every
-- idle row was written by the old automatic desktop/iOS idle detection, and
-- keeping it as a CHOSEN status would leave those users permanently Away. A
-- user who had picked Away by hand has to pick it once more (release notes).
-- The column default already covers every other row ('online').
ALTER TABLE "users" ADD COLUMN "chosen_status" "user_status" DEFAULT 'online' NOT NULL;
--> statement-breakpoint
UPDATE "users"
SET "chosen_status" = CASE "status"
    WHEN 'dnd' THEN 'dnd'::"user_status"
    WHEN 'invisible' THEN 'invisible'::"user_status"
    ELSE 'online'::"user_status"
  END
WHERE "status" IN ('dnd', 'invisible');
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_chosen_status_not_offline" CHECK ("chosen_status" <> 'offline');
