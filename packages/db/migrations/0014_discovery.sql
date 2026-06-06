-- ───────────────────────────────────────────────────────────────────────────
-- Server discovery
-- ───────────────────────────────────────────────────────────────────────────
-- Opt-in directory: guilds set `discoverable=true` and provide an optional
-- long-form pitch in `discovery_description`. The /discover route lists
-- discoverable guilds with member counts; non-members can join with one
-- click, no invite code required.

ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "discoverable" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "guilds"
  ADD COLUMN IF NOT EXISTS "discovery_description" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guilds_discoverable_idx" ON "guilds" ("discoverable");
