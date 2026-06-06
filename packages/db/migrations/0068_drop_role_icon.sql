-- Role icons removed (the cosmetic role-icon feature was dropped). Drop the
-- now-unused column. Idempotent so re-running is safe.
ALTER TABLE roles DROP COLUMN IF EXISTS icon_url;
