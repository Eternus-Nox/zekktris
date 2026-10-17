-- reaction_roles.created_by was created in 0017 with a bare REFERENCES
-- users(id), i.e. ON DELETE NO ACTION — the only users FK without an ON
-- DELETE rule. Deleting any account that ever set up a reaction role (the
-- inactivity sweep, bot deletion, account self-delete) failed with an FK
-- violation, and the sweep lost the whole 500-id chunk with it.
--
-- The creator is attribution only; the mapping keeps working without it, so
-- SET NULL like every other "who made this" column (webhooks.created_by).
--
-- Drop whatever FK currently sits on the column rather than naming it (see
-- 0124: hand-written migrations carry Postgres's default names).
DO $$
DECLARE
  con text;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'reaction_roles'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'users'::regclass
      AND a.attname = 'created_by'
  LOOP
    EXECUTE format('ALTER TABLE "reaction_roles" DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE "reaction_roles"
  ADD CONSTRAINT "reaction_roles_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;
