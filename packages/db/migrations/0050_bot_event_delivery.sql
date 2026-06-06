-- ── v1.86 bot event delivery ──────────────────────────────────────────────
--
-- Outgoing event webhooks for bots. When a message is posted in a
-- channel a bot can see, the server POSTs the event to the bot's
-- configured callback URL. This lets bots *react* to activity without
-- maintaining a persistent connection.
--
--   bot_event_url     HTTPS URL the server POSTs events to. Null = the
--                     bot has no event subscription (REST-only bot).
--
--   bot_event_secret  Random secret used to HMAC-SHA256-sign each
--                     event payload. The bot verifies the
--                     X-Zekktris-Signature header to confirm the POST
--                     genuinely came from this server (not a spoofer
--                     who guessed the callback URL). Generated when an
--                     event URL is first set.
--
-- Both are null for human accounts and for bots that haven't opted
-- into event delivery.

ALTER TABLE users ADD COLUMN bot_event_url TEXT;
ALTER TABLE users ADD COLUMN bot_event_secret TEXT;
