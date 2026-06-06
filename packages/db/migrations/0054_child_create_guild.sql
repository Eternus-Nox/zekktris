-- Parental controls: add a "create server" privilege toggle to the
-- per-child restriction row. Default true (allowed) like the others.
ALTER TABLE child_restrictions
  ADD COLUMN allow_create_guild BOOLEAN NOT NULL DEFAULT true;
