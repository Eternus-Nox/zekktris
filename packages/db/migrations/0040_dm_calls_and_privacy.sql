-- DM call records + friends-only privacy policy
--
-- Adds the data model for tracking 1:1 DM voice calls (so we can write
-- a system message summarizing the call when it ends) and a per-user
-- privacy preference controlling who can DM/call.

ALTER TABLE "users"
  ADD COLUMN "allow_dms_from_server_members" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE "channels"
  ADD COLUMN "dm_active_call_started_at" timestamp with time zone,
  ADD COLUMN "dm_active_call_answered_at" timestamp with time zone,
  ADD COLUMN "dm_active_call_initiator_id" bigint;
--> statement-breakpoint

ALTER TABLE "messages"
  ADD COLUMN "metadata" jsonb;
