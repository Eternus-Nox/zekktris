CREATE TABLE IF NOT EXISTS "voice_states" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"channel_id" bigint NOT NULL,
	"guild_id" bigint NOT NULL,
	"session_id" text NOT NULL,
	"self_mute" boolean DEFAULT false NOT NULL,
	"self_deaf" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_states" ADD CONSTRAINT "voice_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_states" ADD CONSTRAINT "voice_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_states" ADD CONSTRAINT "voice_states_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_states_by_channel_idx" ON "voice_states" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_states_by_guild_idx" ON "voice_states" USING btree ("guild_id");