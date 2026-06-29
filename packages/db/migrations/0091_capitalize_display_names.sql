-- Backfill: capitalize the first character of every existing display name so
-- the stored data matches the on-write rule (validation.displayNameSchema →
-- capitalizeFirst, added earlier this cycle). New/edited names are already
-- capitalized on save; this fixes accounts created before that.
--
-- Only rows whose first character actually differs from its uppercase form are
-- touched, so already-capitalized names, digit/symbol-first names, and
-- emoji-first names are left alone (and the UPDATE stays cheap + idempotent —
-- re-running is a no-op). substring(... from 1 for 1) is codepoint-aware, so a
-- multibyte first character is handled correctly (and upper() of a non-letter
-- is a no-op, matching JS's charAt(0).toUpperCase()).
UPDATE "users"
SET "display_name" = upper(substring("display_name" from 1 for 1)) || substring("display_name" from 2)
WHERE "display_name" <> ''
  AND substring("display_name" from 1 for 1) <> upper(substring("display_name" from 1 for 1));
