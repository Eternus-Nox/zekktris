-- Payments removed: every account gets the base app, and the Scout / Guardian /
-- Legend tiers become perk labels an admin hands out (2026-10-02).
--
-- Reset the stored stream gates so the new ladder applies everywhere, including
-- an instance whose admin once saved the old Monetization tab:
--   everyone 720p30 · Scout 1080p + 60fps · Guardian 2K · Legend 4K
-- Absent keys fall back to the defaults in services/monetization.ts.
--
-- monetize.appearance is dropped for good: cosmetics are free for everyone and
-- the server no longer reads that key.
DELETE FROM "instance_settings"
WHERE "key" IN (
  'monetize.stream.p1080',
  'monetize.stream.k2',
  'monetize.stream.k4',
  'monetize.stream.fps60',
  'monetize.appearance'
);
