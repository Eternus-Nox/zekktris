-- WebAuthn passkeys. One row per registered credential. credential_id is
-- globally unique (discoverable login looks it up before the user is known).
-- public_key + counter are the verification material (counter = replay guard).
-- Binary values stored base64url as text.
CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
  "id" bigint PRIMARY KEY NOT NULL,
  "user_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL UNIQUE,
  "public_key" text NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0,
  "transports" text,
  "device_name" text,
  "backed_up" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "webauthn_credentials_user_idx" ON "webauthn_credentials" ("user_id");
