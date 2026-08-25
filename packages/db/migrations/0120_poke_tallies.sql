-- Durable poke tallies + the deferred unread-poke marker.
--
-- WHY A PAIR TABLE AND NOT COUNTERS ON `users`
-- -------------------------------------------
-- `pokes` is a DISPLAY BUFFER, not a ledger: the send path prunes it to the
-- newest 6 rows per (channel_id, recipient_id) on every insert — note the key
-- is channel+RECIPIENT, not initiator, so one person poking repeatedly deletes
-- an earlier poker's rows. Nothing durable can be read back out of it.
--
-- Two shapes could hold the durable count: scalar columns on `users`, or this
-- (initiator, recipient) pair table. The deciding requirement is that the poke
-- achievements must not be self-farmable. Poking is trivially repeatable
-- against one alt, so a raw "pokes sent" scalar is worthless as a badge — and
-- a scalar can never be refined later, because the identities behind it were
-- never recorded. Keying by the ORDERED PAIR makes the meaningful,
-- non-farmable metrics single indexed counts:
--   distinct people you poked     = COUNT(*) WHERE initiator_id = you   (PK)
--   distinct people who poked you = COUNT(*) WHERE recipient_id = you   (index)
--   lifetime pokes sent           = SUM(poke_count) WHERE initiator_id = you
-- Repeat pokes to the same person only bump `poke_count`, so rows are bounded
-- by the real DM graph (one per directed pair that has ever poked), not by poke
-- volume — an alt-farm loop adds ONE row and moves the distinct count by one,
-- exactly what the badge claims.
--
-- No backfill: the pruned history is genuinely gone, so everyone starts at 0.
-- Every column is NOT NULL with a default, so the migration cannot fail on
-- existing rows and the API behaves identically until the next poke lands.
CREATE TABLE IF NOT EXISTS "poke_tallies" (
	"initiator_id" bigint NOT NULL,
	"recipient_id" bigint NOT NULL,
	"poke_count" integer NOT NULL DEFAULT 0,
	"first_at" timestamp with time zone NOT NULL DEFAULT now(),
	"last_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "poke_tallies_pk" PRIMARY KEY ("initiator_id","recipient_id")
);
--> statement-breakpoint
-- Same cascade rules as `pokes` (0108): a deleted account stops counting toward
-- anyone's distinct total, rather than leaving a dangling tally.
DO $$ BEGIN
	ALTER TABLE "poke_tallies" ADD CONSTRAINT "poke_tallies_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "poke_tallies" ADD CONSTRAINT "poke_tallies_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- The PK's leading column already serves the "people I poked" side; this index
-- serves the "people who poked me" side. Both distinct-person counts stay
-- index-only lookups.
CREATE INDEX IF NOT EXISTS "idx_poke_tallies_recipient" ON "poke_tallies" ("recipient_id","initiator_id");
--> statement-breakpoint
-- UNREAD-POKE MARKER
-- ------------------
-- Per-poke seen flag so the poke button can badge "you have new pokes" and
-- clear it when opened. This cannot be derived from `read_states`: ack()
-- advances that cursor with GREATEST, so it never moves backwards and a poke
-- arriving after a read could never re-arm the badge.
--
-- Two-step default is deliberate. Adding the column with DEFAULT true marks
-- every PRE-EXISTING poke as already seen (they were never badge-able, so the
-- badge must be empty the instant this deploys); flipping the default to false
-- afterwards means every NEW poke starts unseen. Both steps are metadata-only
-- in PG11+ — no table rewrite — and re-running them is a no-op, unlike a
-- one-shot UPDATE, which would silently mark fresh pokes seen.
ALTER TABLE "pokes" ADD COLUMN IF NOT EXISTS "seen" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "pokes" ALTER COLUMN "seen" SET DEFAULT false;
