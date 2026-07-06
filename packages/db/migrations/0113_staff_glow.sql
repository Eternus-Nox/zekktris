-- Optional "slight glow" for the staff name shimmer — a soft text-shadow in the
-- staff member's chosen color layered on top of the shimmer. Only meaningful
-- when staff_color is set, and rendered only for instance staff.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "staff_glow" boolean DEFAULT false NOT NULL;
