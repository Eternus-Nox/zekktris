-- Voice prefs sync (round 13)
-- ----------------------------
-- Adds a JSONB column on users for the client's voice-prefs blob:
-- master/mic gains, processing flags, gain mode, and per-user
-- volume/mute overrides. The shape is owned by apps/web; the API
-- just persists and returns it. Default empty object — clients
-- merge their local defaults on read.

ALTER TABLE "users"
  ADD COLUMN "voice_prefs" jsonb NOT NULL DEFAULT '{}'::jsonb;
