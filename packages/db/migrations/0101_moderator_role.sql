-- Instance-level MODERATOR role — a scoped staff tier below administrator.
-- Moderators can: list users, ban/unban, force sign-out, reset DOB locks,
-- view memberships + gift up to 3 months, list servers + observe (not
-- delete), and read the admin Security Log. Everything else stays
-- administrator-only (role changes, user deletion, settings, stats…).
-- Enforced server-side in the admin routes (requireStaff vs requireAdmin).
ALTER TABLE "users" ADD COLUMN "is_moderator" boolean NOT NULL DEFAULT false;
