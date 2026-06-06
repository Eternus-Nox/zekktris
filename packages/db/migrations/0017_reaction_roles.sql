-- 0017_reaction_roles.sql
--
-- Reaction roles: link (message_id, emoji) → role_id so reacting to
-- a designated message auto-grants/revokes the role.
--
-- Schema choices:
--   - Primary key (message_id, emoji): one role per emoji per message.
--     If a server admin wants ONE emoji to grant multiple roles they
--     can stack mappings on DIFFERENT messages — keeps the data model
--     simple and the user-facing UX clear ("react with 🎮 to get @Gamer").
--   - guild_id + channel_id stored for fast lookup without joining
--     messages (avoids extra IO on the gateway hot path that fires
--     on every reaction add/remove).
--   - role_id ON DELETE CASCADE: if the role is deleted the mapping
--     becomes meaningless; drop it. Same for the message (so purges
--     clean up automatically).

CREATE TABLE reaction_roles (
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji      text   NOT NULL,
  guild_id   bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id    bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_by bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, emoji)
);

-- Hot-path lookup index: when a reaction event fires, the gateway
-- needs to check "is there a reaction-role mapping for this
-- (message, emoji)?" — that's already covered by the PK. But the
-- management UI also lists all mappings in a guild, which needs
-- this secondary index.
CREATE INDEX reaction_roles_guild_idx ON reaction_roles (guild_id);
