-- Federation node mode: mark mirrored backbone users. Additive + default false,
-- so existing (local) users and the backbone are unaffected.
ALTER TABLE users ADD COLUMN federated BOOLEAN NOT NULL DEFAULT false;
