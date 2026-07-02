-- Supporter memberships ("subscriptions"): Scout / Guardian / Legend tiers.
--
-- One row per member. expires_at NULL = unlimited/forever; a timed gift sets
-- it N months out. `source` is 'gift' for admin grants (the only grant path
-- until card payments are wired); gifted_by records which admin granted it.
--
-- Entitlement model: an ACTIVE membership (expires_at NULL or in the future)
-- unlocks the Appearance options (themes, avatar frames, clan tags) and shows
-- the tier title on the profile (unless the user opts out via
-- users.show_subscription_tier). A supervising parent's membership passes
-- down to their supervised children at read time (no child rows written).
CREATE TABLE "subscriptions" (
  "user_id" bigint PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "tier" text NOT NULL DEFAULT 'scout',
  "source" text NOT NULL DEFAULT 'gift',
  "gifted_by" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Profile privacy: whether the tier title shows on the user's profile popup.
ALTER TABLE "users" ADD COLUMN "show_subscription_tier" boolean NOT NULL DEFAULT true;

-- Founding grandfather: every EXISTING human account gets an UNLIMITED
-- (forever) membership so the new hard lock takes nothing away from anyone
-- who was here before memberships shipped. Accounts created after this
-- migration start without one. Admins can retier/remove via the admin panel.
INSERT INTO "subscriptions" ("user_id", "tier", "source", "expires_at")
SELECT "id", 'scout', 'gift', NULL FROM "users" WHERE "is_bot" = false
ON CONFLICT ("user_id") DO NOTHING;
