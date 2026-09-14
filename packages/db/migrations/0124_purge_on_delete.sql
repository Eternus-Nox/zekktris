-- Deleting a server or an account now actually removes the content.
--
-- Until now "delete" was a flag: `deleteGuild` set `deleted_at` on the guild
-- and its channels and every message, member and role row stayed in the
-- database forever. Account deletion did hard-delete the user row, but
-- `messages.author_id` is ON DELETE SET NULL, so everything the person ever
-- wrote stayed in place with no author.
--
-- Both now purge for real (see services/purge.ts). The one thing that must
-- SURVIVE a purge is the moderation record — deleting a server is otherwise an
-- easy way to erase the evidence that it was reported. `reports.guild_id` and
-- `security_events.guild_id` cascaded, which would have taken those rows with
-- the server, so they become nullable references that survive it, with the
-- server's name snapshotted at purge time so staff can still read the row.
ALTER TABLE "reports" ALTER COLUMN "guild_id" DROP NOT NULL;

-- Drop whatever foreign key currently sits on these columns rather than naming
-- it: these tables were created by hand-written migrations, so the constraints
-- carry Postgres's default `<table>_<column>_fkey` name, NOT drizzle's
-- `<table>_<column>_<target>_<target column>_fk`. Dropping the drizzle name
-- alone silently left the CASCADE in place and added a second, contradictory
-- FK beside it — caught by \d reports on a freshly migrated database.
DO $$
DECLARE
  con text;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'reports'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'guilds'::regclass
      AND a.attname = 'guild_id'
  LOOP
    EXECUTE format('ALTER TABLE "reports" DROP CONSTRAINT %I', con);
  END LOOP;

  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'security_events'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'guilds'::regclass
      AND a.attname = 'guild_id'
  LOOP
    EXECUTE format('ALTER TABLE "security_events" DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE "reports" ADD CONSTRAINT "reports_guild_id_guilds_id_fk"
  FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "guild_name" text;

ALTER TABLE "security_events" ADD CONSTRAINT "security_events_guild_id_guilds_id_fk"
  FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "security_events" ADD COLUMN IF NOT EXISTS "guild_name" text;
