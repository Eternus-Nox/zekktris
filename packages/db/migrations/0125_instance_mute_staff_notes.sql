-- Instance-wide mute + staff notes (admin Account Info page).
--
-- MUTE mirrors the instance ban's shape (banned_at + banned_until): muted_at
-- set = muted; muted_until NULL = permanent, otherwise it lapses on its own
-- with no sweeper. A muted account can still sign in and read, but can't
-- send, edit, react, vote, poke, or publish audio in voice — enforced at each
-- write path by services/instanceMutes.ts.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "muted_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "muted_until" timestamptz;
--> statement-breakpoint

-- STAFF NOTES: free-text notes staff keep about an account. Visible to staff
-- only (admins + moderators), never to the account itself. author_id is SET
-- NULL so a note survives its author losing staff or being removed — the
-- record matters more than the byline (same reasoning as security_events).
-- user_id CASCADEs, but users are tombstoned (deleted_at), not hard-deleted,
-- so in practice notes outlive account deletion too.
CREATE TABLE IF NOT EXISTS "staff_notes" (
  "id" bigint PRIMARY KEY,
  "user_id" bigint NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "author_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_notes_user_created_idx"
  ON "staff_notes" ("user_id", "created_at");
