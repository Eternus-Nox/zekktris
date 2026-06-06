-- Cosmetic: a per-user avatar decoration (a CSS-rendered ring/glow overlay
-- around the avatar, chosen from a preset registry on the client). NULL or
-- 'none' = no decoration. Stored as a short id string.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_decoration text;
