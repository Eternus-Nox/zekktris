-- Staff-action auditing: every admin/moderator action (ban/unban, sign-out,
-- membership gift/reset, DOB reset, role changes, server observe/delete,
-- account delete) is recorded in the existing security_events log the admin
-- Security tab already displays. actor_id = WHO performed the action
-- (user_id stays the TARGET). New kinds use the 'staff_' prefix; the
-- automated kinds (spam_limited, banned_word) have no actor.
ALTER TABLE "security_events" ADD COLUMN "actor_id" bigint REFERENCES "users"("id") ON DELETE SET NULL;
