-- 0019_discovery_category.sql
--
-- Adds an optional category tag to discoverable guilds. When the
-- owner opts a server into discovery, they pick one of a fixed
-- set of categories (Gaming, Music, Education, etc) — the UI uses
-- it both as a filter (left-rail in DiscoveryView) and as a label
-- shown on the card.
--
-- We store as text rather than an enum so the application layer
-- owns the canonical list. That avoids a schema migration every
-- time a category is added or renamed, and lets the validator
-- reject unknown values without a CHECK constraint.
--
-- Nullable because:
--   - Pre-existing discoverable guilds don't have a category
--     until the owner edits their settings
--   - Non-discoverable guilds shouldn't be required to set one

ALTER TABLE guilds
  ADD COLUMN discovery_category text;

-- Lookups by category will be common ("show me all Gaming servers"),
-- but only across the ~hundreds of discoverable guilds at any one
-- time. A partial b-tree filtered on discoverable=true would be the
-- ideal access pattern; we use a plain index here for simplicity
-- and revisit when row counts justify it.
CREATE INDEX guilds_discovery_category_idx ON guilds (discovery_category)
  WHERE discovery_category IS NOT NULL;
