-- Password reset tokens (round 14)
-- ---------------------------------
-- Single-use tokens issued by POST /auth/forgot-password and consumed
-- by POST /auth/reset-password. Plain token (32 random bytes, URL-safe
-- base64) is mailed to the user; only the SHA-256 hash is stored here.

CREATE TABLE "password_resets" (
  "id"            bigint                      PRIMARY KEY,
  "user_id"       bigint                      NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash"    text                        NOT NULL,
  "expires_at"    timestamp with time zone    NOT NULL,
  "used_at"       timestamp with time zone,
  "created_at"    timestamp with time zone    NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "password_resets_token_idx" ON "password_resets" ("token_hash");
CREATE INDEX "password_resets_user_idx" ON "password_resets" ("user_id");
