-- 0035_self_assignable_roles.sql
--
-- Self-assignable roles. Two new columns on `roles`:
--
--   1. self_assignable: BOOLEAN, default false. When true, members
--      can grant/revoke this role for themselves via the new
--      member-roles REST endpoint. False preserves the existing
--      "only MANAGE_ROLES can grant" behavior for established roles.
--      Admins opt-in per-role via the Roles tab in guild settings.
--
--   2. description: TEXT NULL. Admin-set blurb shown next to the
--      role name in the Browse Roles UI. NULL = no description; the
--      role renders as just name + color.
--
-- Partial index on `WHERE self_assignable = true` keeps the "list
-- assignable roles" query cheap. Most roles in most guilds are
-- admin-controlled (mods, special-access, hoisted name colors);
-- self-assignable is the rare case so the partial index stays small.

ALTER TABLE roles
  ADD COLUMN self_assignable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN description TEXT;

CREATE INDEX roles_self_assignable_idx
  ON roles (guild_id, position DESC)
  WHERE self_assignable = true;
