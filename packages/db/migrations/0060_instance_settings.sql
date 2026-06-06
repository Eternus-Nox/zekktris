-- Instance-level settings (key/value)
-- -----------------------------------
-- A tiny singleton-ish key/value table for instance-wide configuration that
-- admins can change at runtime (vs. env, which needs a redeploy). First use:
-- federation auto-approve + enrollment secret, set from the admin Federation
-- tab. env values remain the bootstrap default until a row is written here.
CREATE TABLE IF NOT EXISTS "instance_settings" (
  "key" text PRIMARY KEY,
  "value" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
