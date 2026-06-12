-- Remove SSO/OIDC entirely. Drop the per-user external-identity binding
-- (oidc_sub + its partial unique index) and purge the instance_settings
-- rows that held the OIDC provider config. IF EXISTS keeps this idempotent
-- and safe on databases that never enabled SSO.

-- Dropping the column also drops users_oidc_sub_idx; the explicit DROP INDEX
-- is defensive in case the column was already removed by hand.
DROP INDEX IF EXISTS "users_oidc_sub_idx";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "oidc_sub";
--> statement-breakpoint
-- Purge the OIDC config key/value rows. Do NOT drop instance_settings itself —
-- it is generic runtime-settings infrastructure.
DELETE FROM "instance_settings" WHERE "key" IN (
  'oidc.enabled',
  'oidc.issuer',
  'oidc.clientId',
  'oidc.clientSecret',
  'oidc.scopes',
  'oidc.buttonLabel',
  'oidc.allowLinking'
);
