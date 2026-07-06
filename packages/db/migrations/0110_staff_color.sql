-- Optional per-user "staff shimmer" color. Instance admins/moderators can give
-- their display name an animated shimmer in this #rrggbb hex color, which
-- overrides guild role colors. NULL = no shimmer (the Settings toggle sets or
-- clears it). Only rendered for instance staff; ignored for everyone else.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "staff_color" text;
