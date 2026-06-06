-- ── v2.45 parental controls (Phase 1: linking + data model) ──────────────
--
-- A guardian account supervises one or more child accounts. The link is
-- consent-gated (pending → active once the child accepts) so it can't be
-- used to surveil a non-consenting party, and supervision is surfaced to
-- the child (never covert).
--
-- An ACTIVE link: grants the parent a scoped read view of the child's
-- messages + contacts, disables E2EE on the child's DMs EXCEPT DMs with
-- their own parent, applies the child_restrictions toggles, and enables
-- watch-word flagging. (Enforcement of monitoring/flagging/restrictions
-- lands in later phases; this migration is the data model + linking.)

CREATE TYPE parent_link_status AS ENUM ('pending', 'active', 'revoked');
CREATE TYPE flag_direction AS ENUM ('sent', 'received');

CREATE TABLE parent_child_links (
  parent_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      parent_link_status NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX parent_child_links_child_idx ON parent_child_links (child_id);

CREATE TABLE child_restrictions (
  child_id           BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  can_add_friends    BOOLEAN NOT NULL DEFAULT true,
  can_remove_friends BOOLEAN NOT NULL DEFAULT true,
  allow_voice        BOOLEAN NOT NULL DEFAULT true,
  allow_video        BOOLEAN NOT NULL DEFAULT true,
  allow_stream       BOOLEAN NOT NULL DEFAULT true,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE child_blocked_guilds (
  child_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  PRIMARY KEY (child_id, guild_id)
);

CREATE TABLE child_watch_words (
  child_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (child_id, word)
);

CREATE TABLE flagged_messages (
  id           BIGINT PRIMARY KEY,
  child_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id   BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id   BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  matched_word TEXT NOT NULL,
  direction    flag_direction NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at  TIMESTAMPTZ
);
CREATE INDEX flagged_messages_child_idx ON flagged_messages (child_id, created_at);
