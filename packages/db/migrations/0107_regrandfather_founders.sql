-- Safety-net re-grandfather: give EVERY existing human account that still has
-- NO subscription row a forever "founder" membership (untitled — perks without
-- a tier badge). The original 0097 backfill only captured accounts that existed
-- at that moment; anything created between then and now (or any gap) was left
-- without a row and therefore locked out of the Appearance options. This
-- re-runs the grandfather over the current snapshot.
--
-- ON CONFLICT DO NOTHING preserves every existing row — paid (stripe), gifted,
-- and prior founder rows are untouched; only accounts with no row at all get
-- one. New accounts created AFTER this migration are not affected (they don't
-- exist in this snapshot), so "existing users are grandfathered, new users
-- subscribe" still holds. Idempotent.
INSERT INTO "subscriptions" ("user_id", "tier", "source", "expires_at")
SELECT "id", 'scout', 'founder', NULL FROM "users" WHERE "is_bot" = false
ON CONFLICT ("user_id") DO NOTHING;
