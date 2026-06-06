-- Full-text search index on messages.content. Used by the search route
-- (GET /channels/:cid/messages/search) which queries with
-- `to_tsvector('english', content) @@ websearch_to_tsquery(...)`.
--
-- We use an EXPRESSION GIN index rather than a tsvector column for two
-- reasons:
--   1. No second column to keep in sync (no triggers, no INSERT/UPDATE
--      maintenance overhead in the application layer).
--   2. The expression matches the query exactly, so the planner uses the
--      index without a lateral join or stored-generated column.
--
-- 'english' was chosen as the dictionary because it's the default Postgres
-- ships everywhere; for a multi-language deployment, switch to 'simple'
-- (no stemming, no stopword removal — works for any Latin-script language)
-- by editing this file before first run.
CREATE INDEX IF NOT EXISTS "messages_content_fts_idx"
  ON "messages"
  USING gin (to_tsvector('english', "content"));
