-- Two-tier banned words. 'blocked' = hard-blocked everywhere (slurs); 'watch'
-- = alert/log only (general profanity). Existing rows default to 'blocked' so
-- current behaviour is preserved (nothing silently stops being enforced).
ALTER TABLE "security_banned_words" ADD COLUMN IF NOT EXISTS "severity" text DEFAULT 'blocked' NOT NULL;
