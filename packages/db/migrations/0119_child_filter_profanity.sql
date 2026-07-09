-- Parental content filter: when on, swear/vulgar words are masked (f•••) in the
-- supervised child's message views on every client. Defaults ON (protective);
-- the parent can turn it off per child. Purely a client-side render control —
-- the server only stores + surfaces the flag via getEffectiveRestrictions and
-- the /family/me + parent restrictions endpoints.
ALTER TABLE "child_restrictions" ADD COLUMN IF NOT EXISTS "filter_profanity" boolean NOT NULL DEFAULT true;
