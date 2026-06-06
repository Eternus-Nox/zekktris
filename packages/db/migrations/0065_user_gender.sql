-- Cosmetic profile field: a short, free-form gender label shown on the
-- user's profile. NULL = unset. Kept deliberately simple (a plain text
-- field, not an enum) so users can write whatever fits them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender text;
