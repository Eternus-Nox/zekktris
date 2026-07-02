-- Grandfathered ("founder") memberships keep the Appearance perks but do NOT
-- wear a tier title — the Scout/Guardian/Legend title is for supporters who
-- chose a tier (subscribed or admin-gifted). Founder rows are the 0097
-- backfill inserts, distinguishable as gift-source rows with no gifting
-- admin. Re-gifting by an admin (or a future paid subscription) overwrites
-- source, which re-titles them. Idempotent.
UPDATE "subscriptions" SET "source" = 'founder'
 WHERE "source" = 'gift' AND "gifted_by" IS NULL;
