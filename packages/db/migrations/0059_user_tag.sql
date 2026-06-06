-- Custom name tag ("clan tag")
-- ----------------------------
-- Three optional columns on users, rendered as a small pill to the right of
-- the user's name (messages, member list, profile card):
--   tag_label — up to 6 chars of text (enforced in the API; column is plain
--               text). NULL = no label.
--   tag_color — hex color string (e.g. #3dd7ec) for the pill. NULL = accent.
--   tag_emoji — a single leading emoji. NULL = none.
-- All nullable, no defaults — existing rows render no tag until the user
-- sets one. No new constraints; validation lives in the API.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tag_label" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tag_color" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tag_emoji" text;
