-- Index notification_overrides on target_id alone.
-- listChannelAllSubscribers (run on every non-DM guild message's push fan-out)
-- filters `WHERE target_id IN (channelId, guildId)` — i.e. on target_id ALONE.
-- The existing indexes lead with target_type or user_id, so that query
-- seq-scanned the whole table; this turns it into an index seek.
-- Not partial on level='all': the query post-filters level in JS (channel
-- override precedence needs the non-'all' rows), so a level predicate would
-- make the index unusable by the planner.
CREATE INDEX IF NOT EXISTS "notification_overrides_target_id_idx" ON "notification_overrides" ("target_id");
