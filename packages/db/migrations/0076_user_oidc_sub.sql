-- SSO / OIDC: bind an external identity to a user by its subject (`sub`),
-- namespaced by issuer. The STABLE link used to resolve subsequent SSO logins
-- (not email — an email change at the IdP must not re-provision or hijack).
-- Nullable (password-only accounts have none); partial-unique so one account
-- maps to one external identity while allowing many nulls.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "oidc_sub" text;
CREATE UNIQUE INDEX IF NOT EXISTS "users_oidc_sub_idx"
  ON "users" ("oidc_sub") WHERE "oidc_sub" IS NOT NULL;
