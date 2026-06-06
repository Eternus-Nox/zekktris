-- Cosmetic: a role icon (a small badge image shown beside members' names,
-- like Discord role icons). A /cdn/ path uploaded via the role icon endpoint,
-- or NULL for no icon. Members display their highest-positioned role that
-- has an icon.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS icon_url text;
