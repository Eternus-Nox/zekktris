-- Zekk Pets: a colour of the pet's own, so both people see the same egg.
--
-- Until now every app drew the pet in the VIEWER's Appearance theme, so two
-- people with different themes saw two different eggs. "color" is the pet's
-- own colour, one of the PetColorId ids in @zekktris/shared/pets ('default',
-- 'sunset', 'forest', 'crimson', 'blossom', 'amethyst': the app's six accent
-- families), and every app draws the pet and its notices in it. The inviter
-- picks it when they send the invite (POST …/pet/invite { color });
-- services/pets.ts writes the DM's own colour (petColorForChannel) when they
-- don't, so a new row always says which egg it is.
--
-- Nullable, with no DEFAULT and no CHECK: a build from before this migration
-- (a rolling deploy, a rollback) still inserts pets without the column, and
-- colours may be added later without a migration. The API reads NULL, or an
-- id it doesn't know, as the DM's own colour (resolvePetColor), which is
-- exactly what the backfill below writes, so such a pet looks the same either
-- way.
--
-- The backfill gives every existing pet and invite its DM's colour:
-- petColorForChannel is the channel id mod 6 into the frozen order default,
-- sunset, forest, crimson, blossom, amethyst (channel ids are positive
-- snowflakes, so "%" is never negative here). The two must stay in step.
ALTER TABLE "dm_pets" ADD COLUMN IF NOT EXISTS "color" text;
--> statement-breakpoint
UPDATE "dm_pets"
SET "color" = (ARRAY['default', 'sunset', 'forest', 'crimson', 'blossom', 'amethyst'])[("channel_id" % 6)::int + 1]
WHERE "color" IS NULL;
