-- Personal DM nicknames: a viewer-private, one-directional label a user sets
-- for another user, shown in place of that user's name in direct messages only.
-- Keyed by (owner, target) — viewer-state, independent of any DM channel id.
CREATE TABLE IF NOT EXISTS "dm_nicknames" (
	"owner_id" bigint NOT NULL,
	"target_id" bigint NOT NULL,
	"nickname" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_nicknames_owner_id_target_id_pk" PRIMARY KEY("owner_id","target_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_nicknames" ADD CONSTRAINT "dm_nicknames_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_nicknames" ADD CONSTRAINT "dm_nicknames_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_nicknames_target_idx" ON "dm_nicknames" ("target_id");
