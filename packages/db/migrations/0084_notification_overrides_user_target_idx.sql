-- Back resolveLevelsBulk's hot path (runs for every guild message with
-- mentions, over 50-1000 targeted users): it filters notification_overrides by
-- (user_id, target_id), skipping target_type. The PK is
-- (user_id, target_type, target_id), so its user_id prefix can seek the user
-- but target_id (the 3rd column) isn't usable without target_type fixed. This
-- composite indexes (user_id, target_id) directly. IF NOT EXISTS = idempotent.
CREATE INDEX IF NOT EXISTS "notification_overrides_user_target_idx" ON "notification_overrides" ("user_id", "target_id");
