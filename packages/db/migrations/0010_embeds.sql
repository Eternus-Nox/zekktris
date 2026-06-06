-- ───────────────────────────────────────────────────────────────────────────
-- Link previews (Open Graph / Twitter Card embeds)
-- ───────────────────────────────────────────────────────────────────────────
-- Embeds are stored as a JSON array on the message itself rather than in a
-- separate table:
--   - Read pattern is "always read with the message", never independently
--   - Shape evolves (link / image / video / file kinds) without schema churn
--   - No need to index embed fields
--
-- NULL = "embed resolution hasn't run yet" (for backfill of historical
-- messages, this is the default — clients can show a discreet hint).
-- [] = "no URLs found OR all fetches failed" (terminal state).

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "embeds" jsonb DEFAULT NULL;
