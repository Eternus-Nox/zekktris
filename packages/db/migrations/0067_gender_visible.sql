-- Whether the user's gender is shown on their public profile. Lets a user set
-- a gender but keep it private (the public DTO hides gender when false).
-- Defaults false so gender is opt-in to display.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender_visible boolean NOT NULL DEFAULT false;
