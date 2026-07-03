-- Scale-hardening indexes for two staff-only read paths.
--
-- 1) Staff-audit log view (Admin → Security → Staff filter). listEvents filters
--    `kind LIKE 'staff\_%'` and pages by `id < before ORDER BY id DESC`. A plain
--    (kind, id) composite can't serve the LIKE under the default collation, so a
--    partial index over just the staff rows serves both the filter and the
--    ordered keyset scan while staying tiny (staff_* events are the minority).
CREATE INDEX IF NOT EXISTS "security_events_staff_id_idx"
  ON "security_events" ("id" DESC)
  WHERE "kind" LIKE 'staff\_%';

-- 2) Admin/moderator user search runs a leading-wildcard ILIKE
--    (%q%) over username/display_name/email — a sequential scan. pg_trgm GIN
--    indexes make that index-usable, BUT `CREATE EXTENSION` needs privileges
--    some self-hosters lack. Best-effort: create the extension + indexes when
--    permitted; otherwise emit a NOTICE and leave the (bounded, staff-only)
--    search on a sequential scan rather than failing the whole migration.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXECUTE 'CREATE INDEX IF NOT EXISTS users_username_trgm_idx ON users USING gin (username gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS users_display_name_trgm_idx ON users USING gin (display_name gin_trgm_ops)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS users_email_trgm_idx ON users USING gin (email gin_trgm_ops)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable (insufficient privilege?); admin user-search stays on a sequential scan. %', SQLERRM;
END $$;
