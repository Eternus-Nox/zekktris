-- Poke history: a small, bounded log of pokes in 1:1 DMs so the poke button
-- can show recent pokes and offer a poke-back. The send path caps this to the
-- newest 6 rows per (channel, recipient), so it can't grow unbounded.
CREATE TABLE IF NOT EXISTS "pokes" (
	"id" bigint PRIMARY KEY NOT NULL,
	"channel_id" bigint NOT NULL,
	"initiator_id" bigint NOT NULL,
	"recipient_id" bigint NOT NULL,
	"poke_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "pokes" ADD CONSTRAINT "pokes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "pokes" ADD CONSTRAINT "pokes_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "pokes" ADD CONSTRAINT "pokes_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pokes_channel_recipient_id" ON "pokes" ("channel_id","recipient_id","id");
