-- Per-recipient DM push-notification preview preference. Private to each user
-- (their lock-screen exposure), unlike conversation-scoped dm_settings.
-- show_content = true → show sender/content (E2EE reveals the sender name;
-- body stays generic without an on-device decryptor). No row → default
-- (E2EE generic, plaintext shows content).
CREATE TABLE IF NOT EXISTS "dm_notification_prefs" (
  "user_id"     bigint NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "channel_id"  bigint NOT NULL REFERENCES "channels" ("id") ON DELETE CASCADE,
  "show_content" boolean NOT NULL,
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "channel_id")
);
