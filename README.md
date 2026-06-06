# Zekktris

A communications app for communities — chat, voice, and shared spaces. Open-source, with the full feature set and no paid tiers. Runs on a single host with `docker compose up`.

> **Status:** in active development. The foundation (monorepo + database schema + API skeleton) is in place. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and roadmap.

## Build progress

| Stage | Status |
|---|---|
| 1. Monorepo scaffold + db schema + migrations | ✅ done |
| 2. API skeleton (env, db wiring, errors, middleware, /health) | ✅ done |
| 3. Auth + users (register, login, refresh, sessions, profile) | ✅ done |
| 4. Guilds, channels, members, roles, permissions, invites, bans | ✅ done |
| 5. Messages, mentions, reactions, DMs, attachments, file uploads | ✅ done |
| 6. WebSocket gateway (real-time fanout) | ✅ done |
| 7a. Web client foundation (auth, shell, live messages) | ✅ done |
| 7b. Web client polish (markdown, mentions, reactions, attachments, typing, member list) | ✅ done |
| 7c. Web client polish-2 (file upload, fenced code blocks, strikethrough, toast system) | ✅ done |
| 7d. DMs UI + settings modal | ✅ done |
| 7e. Read state stack (server + client) + unread badges + live setUser refresh | ✅ done |
| 7f. Mention-count increment + sound on mention (Web Audio chime) | ✅ done |
| 7g. Remaining polish (avatar upload, emoji picker categories) | ⏳ deferred |
| v1.x.1. Per-channel permission filtering at gateway fanout | ✅ done |
| v1.x.2. Live permission re-evaluation on role grant/revoke (CHANNEL_CREATE/DELETE on visibility flip) | ✅ done |
| v1.x.3. Live permission re-evaluation on channel override change + new-channel create | ✅ done |
| v1.x.4. Live re-evaluation on role permission-bits update; tightened CHANNEL_UPDATE/DELETE audience to viewers only | ✅ done |
| 8. Docker compose + Caddy + unraid deployment | ✅ done |

### Web client features

The client is a React + Vite + Tailwind SPA at `apps/web` consuming the REST API and WebSocket gateway through `@zekktris/client`. Stage 7a/7b ships:

- Email + password login and registration with persistent session
- 4-column shell: server rail → channel list → message view → member list
- Live messages over the gateway: `MESSAGE_CREATE/UPDATE/DELETE` arrive without polling
- Inline markdown: `**bold**`, `*italic*`/`_italic_`, `~~strikethrough~~`, `` `code` ``, fenced ```` ```code blocks``` ```` with optional language hint, auto-linked URLs
- Mention rendering: `<@id>`, `<@&id>`, `<#id>`, `@everyone`/`@here` resolve into chips with display names; clicking a channel mention navigates
- Reactions: aggregated pills under each message, click-to-toggle, emoji picker for adding new reactions
- Attachments: images render inline with click-to-zoom, other files as download cards with size
- File upload from composer: paperclip button + drag-drop, image thumbnails / file cards in preview, multipart submit, capped at `MAX_FILES_PER_MESSAGE`
- Toast system: app-wide notifications for invite-copy, reaction failures, send/edit/delete errors
- DMs UI: Home button at the top of the guild rail routes to `/channels/@me`; second column lists DM channels with online dots; member rows in any guild are click-to-DM; DM message view shows recipient name (`@Name`) instead of `#channel`
- Settings modal: edit display name, bio (500-char cap), and online status (online/idle/dnd/invisible); read-only username + email; opens from the gear icon in the guild rail; saved values reflect immediately in the rail without reload
- Unread badges: per-channel and per-DM; bold + dot for unread, red mention chip when `mentionCount > 0`; read state ships in `READY` for first-paint accuracy and via `GET /users/@me/read-states` for refresh; `POST /channels/:cid/messages/:mid/ack` advances the marker (`GREATEST` upsert refuses backwards moves); auto-acks on channel open and on every new message; `CHANNEL_ACK` events keep multi-tab clients in sync; mention-count increments atomically on message create (excludes self-mentions); resets on ack
- Notification ping: short two-note Web Audio chime when a message mentions the current user; rate-limited to one per second; degrades silently if the browser blocks the AudioContext until user gesture
- Typing indicators: "Alice is typing…" pings throttled to once per 4s on the sender side, auto-expire after 5s on the receiver
- Member list with live-updating online/offline dots
- Auto-scroll-to-bottom that respects user scroll position (won't yank when reading history)
- Reconnect indicator when the gateway drops
- Channel categories with collapse/expand, invite creation with copy-to-clipboard, server creation modal

## Project layout

```
zekktris/
├── apps/
│   ├── api/            # Hono REST + WebSocket gateway
│   │   ├── src/        # 49 .ts files: routes, services, gateway/, auth/, db
│   │   └── Dockerfile  # Multi-stage build for the api image
│   └── web/            # React + Vite + Tailwind SPA
│       └── src/        # 17 .tsx/.ts files: auth, app shell, state, lib
├── packages/
│   ├── db/             # Drizzle schema + initial migration SQL
│   ├── client/         # @zekktris/client — REST + WebSocket protocol clients
│   ├── shared/         # Permissions, snowflakes, gateway events, constants
│   └── tsconfig/       # Shared TS configs
├── ops/
│   ├── Dockerfile.api  # Multi-stage: pnpm install → tsx runtime
│   ├── Dockerfile.web  # Multi-stage: vite build → caddy with SPA baked in
│   └── Caddyfile       # Reverse proxy + SPA host config
├── scripts/
│   └── generate-secrets.sh  # Writes .env with fresh JWT + DB secrets, chmod 600
├── docker-compose.yml  # 4 services: proxy, api, db, cache
├── .dockerignore
├── .env.example
└── ARCHITECTURE.md     # The full design document
```

## Running locally

You need: Node 20+, pnpm 9+, and Postgres 16 (running locally or in a container).

```bash
pnpm install

# Generate dev secrets and write them into .env
cp .env.example .env
sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env
sed -i.bak "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -hex 32)|" .env
rm -f .env.bak

# Point DATABASE_URL at your local postgres, e.g.
# DATABASE_URL=postgres://postgres@127.0.0.1:5432/zekktris
# then create the db:
createdb zekktris

# Apply migrations
pnpm db:migrate

# Start the API at http://localhost:3000
pnpm --filter @zekktris/api dev
```

Try the auth flow with curl:
```bash
# Register
curl -i -c jar.txt -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","username":"alice","displayName":"Alice","password":"hunter2hunter2"}'

# The response includes { accessToken, expiresIn, user }. Use the token:
TOKEN="<paste accessToken>"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/users/@me

# Refresh (uses the cookie set during register)
curl -b jar.txt -c jar.txt -X POST http://localhost:3000/api/v1/auth/refresh

# Logout
curl -b jar.txt -X POST http://localhost:3000/api/v1/auth/logout
```

## API surface (v1 so far)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET    | `/health`                                 | — | Process is up |
| GET    | `/health/ready`                           | — | DB is reachable (503 if not) |
| **Auth** | | | |
| POST   | `/api/v1/auth/register`                   | — | Create account; sets refresh cookie |
| POST   | `/api/v1/auth/login`                      | — | Sign in; sets refresh cookie |
| POST   | `/api/v1/auth/refresh`                    | cookie | Rotate refresh + new access token |
| POST   | `/api/v1/auth/logout`                     | cookie | Revoke session, clear cookie |
| **Users** | | | |
| GET    | `/api/v1/users/@me`                       | bearer | Self profile |
| PATCH  | `/api/v1/users/@me`                       | bearer | Update displayName/bio/status/customStatus/locale |
| POST   | `/api/v1/users/@me/password`              | bearer | Change password (optionally revokes other sessions) |
| GET    | `/api/v1/users/@me/sessions`              | bearer | List active sessions |
| DELETE | `/api/v1/users/@me/sessions`              | bearer | Revoke all *other* sessions |
| DELETE | `/api/v1/users/@me/sessions/:id`          | bearer | Revoke a specific session |
| GET    | `/api/v1/users/:id`                       | — | Public profile |
| **Guilds** | | | |
| POST   | `/api/v1/guilds`                          | bearer | Create guild (returns guild + defaultChannelId) |
| GET    | `/api/v1/guilds`                          | bearer | List guilds I'm a member of |
| GET    | `/api/v1/guilds/:guildId`                 | bearer | Get one guild |
| PATCH  | `/api/v1/guilds/:guildId`                 | bearer + MANAGE_GUILD | Update name/description/icon/etc. |
| DELETE | `/api/v1/guilds/:guildId`                 | bearer + owner | Soft-delete the guild |
| POST   | `/api/v1/guilds/:guildId/transfer`        | bearer + owner | Transfer to another existing member |
| POST   | `/api/v1/guilds/:guildId/leave`           | bearer | Leave (non-owner only) |
| **Members** | | | |
| GET    | `/api/v1/guilds/:guildId/members`         | bearer + member | Paginated member list (`?limit=&after=`) |
| GET    | `/api/v1/guilds/:guildId/members/:userId` | bearer + member | One member with roles |
| PATCH  | `/api/v1/guilds/:guildId/members/:userId` | bearer + perm | Set nickname or roleIds (`@me` allowed) |
| DELETE | `/api/v1/guilds/:guildId/members/:userId` | bearer + KICK_MEMBERS | Kick member |
| **Roles** | | | |
| GET    | `/api/v1/guilds/:guildId/roles`           | bearer + member | List roles ordered by position |
| POST   | `/api/v1/guilds/:guildId/roles`           | bearer + MANAGE_ROLES | Create role |
| PATCH  | `/api/v1/guilds/:guildId/roles`           | bearer + MANAGE_ROLES | Bulk reorder |
| PATCH  | `/api/v1/guilds/:guildId/roles/:roleId`   | bearer + MANAGE_ROLES + hierarchy | Update role |
| DELETE | `/api/v1/guilds/:guildId/roles/:roleId`   | bearer + MANAGE_ROLES + hierarchy | Delete role (not @everyone) |
| **Bans** | | | |
| GET    | `/api/v1/guilds/:guildId/bans`            | bearer + BAN_MEMBERS | List bans |
| PUT    | `/api/v1/guilds/:guildId/bans/:userId`    | bearer + BAN_MEMBERS | Ban (also kicks) |
| DELETE | `/api/v1/guilds/:guildId/bans/:userId`    | bearer + BAN_MEMBERS | Unban |
| **Channels** | | | |
| GET    | `/api/v1/guilds/:guildId/channels`        | bearer + member | List guild channels |
| POST   | `/api/v1/guilds/:guildId/channels`        | bearer + MANAGE_CHANNELS | Create channel/category |
| GET    | `/api/v1/channels/:channelId`             | bearer + VIEW_CHANNEL | Get channel |
| PATCH  | `/api/v1/channels/:channelId`             | bearer + MANAGE_CHANNELS | Update channel |
| DELETE | `/api/v1/channels/:channelId`             | bearer + MANAGE_CHANNELS | Soft-delete channel |
| GET    | `/api/v1/channels/:channelId/permissions` | bearer + MANAGE_ROLES | List overrides |
| PUT    | `/api/v1/channels/:channelId/permissions/:targetId?type=role\|member` | bearer + MANAGE_ROLES | Upsert override |
| DELETE | `/api/v1/channels/:channelId/permissions/:targetId?type=role\|member` | bearer + MANAGE_ROLES | Remove override |
| POST   | `/api/v1/channels/:channelId/invites`     | bearer + CREATE_INVITE | Mint a new invite code |
| **Invites** | | | |
| GET    | `/api/v1/guilds/:guildId/invites`         | bearer + MANAGE_INVITES | List invites |
| GET    | `/api/v1/invites/:code`                   | — | Public preview |
| POST   | `/api/v1/invites/:code`                   | bearer | Accept (join the guild) |
| DELETE | `/api/v1/invites/:code`                   | bearer + MANAGE_INVITES | Revoke an invite |
| **Messages** | | | |
| POST   | `/api/v1/channels/:channelId/messages`    | bearer + SEND_MESSAGES | Send message (JSON or multipart with files) |
| GET    | `/api/v1/channels/:channelId/messages`    | bearer + READ_MESSAGE_HISTORY | List (`?before=&after=&limit=`) |
| GET    | `/api/v1/channels/:channelId/messages/:messageId` | bearer + READ_MESSAGE_HISTORY | Get one |
| PATCH  | `/api/v1/channels/:channelId/messages/:messageId` | bearer + author | Edit own message |
| DELETE | `/api/v1/channels/:channelId/messages/:messageId` | bearer + author/MANAGE_MESSAGES | Delete |
| **Reactions** | | | |
| PUT    | `/api/v1/channels/:channelId/messages/:messageId/reactions/:emoji/@me` | bearer + ADD_REACTIONS | Add own |
| DELETE | `/api/v1/channels/:channelId/messages/:messageId/reactions/:emoji/@me` | bearer | Remove own |
| DELETE | `/api/v1/channels/:channelId/messages/:messageId/reactions/:emoji/:userId` | bearer + MANAGE_MESSAGES | Remove someone's |
| DELETE | `/api/v1/channels/:channelId/messages/:messageId/reactions/:emoji` | bearer + MANAGE_MESSAGES | Clear emoji |
| DELETE | `/api/v1/channels/:channelId/messages/:messageId/reactions` | bearer + MANAGE_MESSAGES | Clear all |
| GET    | `/api/v1/channels/:channelId/messages/:messageId/reactions/:emoji` | bearer + member | Who reacted |
| **DMs** | | | |
| POST   | `/api/v1/users/@me/channels`              | bearer | Open or fetch a 1:1 DM |
| GET    | `/api/v1/users/@me/channels`              | bearer | List my DMs |
| **Attachments** | | | |
| GET    | `/cdn/:attachmentId/:filename`            | bearer + permission | Stream attachment file |
| **Gateway (WebSocket)** | | | |
| WS     | `/gateway`                                | IDENTIFY frame | Long-lived bidirectional event stream |

All errors share the envelope `{ "error": { "code", "message", "details?" } }`.

### Gateway protocol

The gateway is a WebSocket endpoint at `/gateway`. Frames use the JSON shape `{ op, t?, d, s? }` mirroring Discord's vocabulary so any Discord-protocol-aware client library can be ported. The handshake is `HELLO → IDENTIFY → READY`, after which the server pushes DISPATCH frames as state changes. The client must heartbeat every 30 s; missing two in a row drops the connection. Events emitted in v1: `MESSAGE_CREATE/UPDATE/DELETE`, `MESSAGE_REACTION_ADD/REMOVE/REMOVE_ALL`, `CHANNEL_CREATE/UPDATE/DELETE`, `CHANNEL_ACK`, `GUILD_CREATE/DELETE`, `GUILD_MEMBER_ADD/REMOVE`, `GUILD_ROLE_UPDATE`, `TYPING_START`. Permission filtering happens at fanout: each connection caches the channels it has `VIEW_CHANNEL` on (computed at IDENTIFY by the permission resolver). Channel-scoped events — messages, reactions, typing, channel-create / channel-update / channel-delete — are filtered against this cache, so a member with `VIEW_CHANNEL` denied on one channel via override won't receive its events (no name leak on rename of a private channel, no delete leak, no message leak). The cache is refreshed live on every mutation that can flip visibility: role grant/revoke, channel override upsert/delete, role permission-bits edit, and new-channel create. When visibility flips for a connected user, the api dispatches `CHANNEL_CREATE` (with full DTO) for newly-visible channels and `CHANNEL_DELETE` for newly-hidden ones — the cache stays accurate without requiring reconnect. The only path still requiring reconnect to refresh is role-position edits (which can affect role hierarchy assertions but not VIEW_CHANNEL directly), and that's a v1.x housekeeping concern. `RESUME` (replay buffer for missed events on reconnect) is also deferred to v1.x; for now, on reconnect the client should re-IDENTIFY and backfill missed messages via REST `GET /channels/:id/messages?after=<lastSeenId>`.

## Generating database migrations

```bash
pnpm db:generate    # diffs the schema and writes a new SQL file in packages/db/migrations
pnpm db:migrate     # applies pending migrations against $DATABASE_URL
```

The current schema (`packages/db/src/schema/`) covers 20 tables — users, sessions, signup codes, guilds, roles, members, member_roles, channels (incl. categories, DMs, group DMs), permission_overrides, dm_recipients, read_states, messages, attachments, reactions, message mentions (user + role), invites, bans, audit log entries, and relationships (friends + blocks).

## Deploying

The repo ships with a 4-service `docker-compose.yml`:

| Service | Image / Build | Public? | Purpose |
|---|---|---|---|
| `proxy` | `ops/Dockerfile.web` (Caddy + SPA bundle) | yes (80/443) | TLS, reverse-proxies /api, /cdn, /gateway, /health to api; serves the SPA for everything else |
| `api`   | `ops/Dockerfile.api` (Node + tsx) | no | REST + WebSocket gateway. Runs migrations + 10-step startup checks before binding the port |
| `db`    | `postgres:16-alpine` | no | Schema is created automatically by the api's migration startup check on first boot |
| `cache` | `redis:7-alpine` | no | Reserved for the gateway pubsub backend — currently unused but the service is up so swapping the bus to Redis is a no-op config change |

Only `proxy` exposes ports to the host. `api`, `db`, and `cache` sit on an internal bridge network.

### Quick start (any Linux box with Docker)

```bash
git clone <repo-url> zekktris
cd zekktris
./scripts/setup.sh
```

That's it. The setup script:

1. Generates a `.env` with cryptographically strong random secrets (chmod 600)
2. Ensures the appdata directory exists (default `/mnt/user/appdata/zekktris`)
3. Builds and brings up the four containers
4. Waits for the api's ten startup checks to pass, then prints the URL

You'll see the startup checks tick green:

```
[ 1/10] Environment configuration            ... ✓
[ 2/10] Snowflake ID generator               ... ✓
[ 3/10] Password hashing (scrypt)            ... ✓
[ 4/10] JWT secrets                          ... ✓
[ 5/10] Database connection                  ... ✓
[ 6/10] Database migrations                  ... ✓ (applied/verified)
[ 7/10] Database schema                      ... ✓
[ 8/10] Upload directory                     ... ✓
[ 9/10] Redis (optional)                     ... ✓
[10/10] Gateway (WebSocket)                  ... ✓
```

Browse to `${PUBLIC_URL}` and register the first account. Once you're done, set `ALLOW_REGISTRATION=invite-only` (or `closed`) in `.env` and run `docker compose up -d` to apply.

If you'd rather drive things manually, the script is just a wrapper:

```bash
./scripts/generate-secrets.sh   # one-shot: write .env with fresh secrets
$EDITOR .env                    # tweak PUBLIC_URL, ports, registration mode, ...
docker compose up -d --build
docker compose logs -f api
```

### TLS

The default `PUBLIC_URL=http://localhost:5550` is plaintext HTTP, intended for LAN-only use or when this stack sits behind another reverse proxy that terminates TLS.

To enable Caddy's built-in Let's Encrypt automation, edit `.env`:

```
PUBLIC_URL=https://chat.example.com:5551   # or :443 if you'd rather expose standard ports
HTTP_PORT=80                               # ACME HTTP-01 challenge needs port 80 reachable
HTTPS_PORT=443                             # standard HTTPS port for browser access
```

The HTTP-01 challenge requires port 80 specifically (not configurable on Let's Encrypt's side), so for a real public deployment you'll want both 80 and 443 exposed. The 5550-5551 defaults are deliberately non-standard so a fresh stack doesn't fight other services for those ports.

If you front this stack with an existing reverse proxy (NPM, SWAG, edge Caddy, Cloudflare Tunnel, …), keep the 5550 default — your edge proxy listens on 80/443 publicly and forwards to `http://<host>:5550`. Forward `/api/*`, `/cdn/*`, `/gateway` (with WebSocket upgrades), and `/` (the SPA).

### Deploying on unraid

The intended path is the **Docker Compose Manager** plugin from Community Apps:

1. Install **Docker Compose Manager** from the Apps tab (search "compose").
2. SSH to the unraid box and put the repo at the standard appdata path:
   ```bash
   mkdir -p /mnt/user/appdata/zekktris
   cd /mnt/user/appdata/zekktris
   git clone <repo-url> .
   ./scripts/setup.sh
   ```
   The script generates secrets, fills in `.env`, and brings up the stack. `APPDATA_PATH` already defaults to `/mnt/user/appdata/zekktris` so no edit is needed for a stock unraid box.
3. (Optional) edit `.env` afterwards if you want to set:
   ```
   PUBLIC_URL=https://chat.example.com:5551    # for TLS via Let's Encrypt (also raise HTTP_PORT/HTTPS_PORT to 80/443 for ACME)
   ALLOW_REGISTRATION=invite-only              # after creating the first account
   ```
   then `docker compose up -d` to apply.
4. The Docker Compose Manager UI will show the stack running. You can manage it from there going forward — start, stop, view logs, edit compose, etc.

The bind mounts (`/mnt/user/appdata/zekktris/db`, `/uploads`, `/caddy-data`, `/caddy-config`) are auto-created by Docker on first start. They show up in unraid's **Shares** view alongside other apps' appdata.

For local development or non-unraid hosts, set `APPDATA_PATH` in your `.env` to a path that exists on your box — `./data` inside the repo is a sensible choice.

### Operational notes

- **Backups**: snapshot `${APPDATA_PATH}/db` (Postgres data) and `${APPDATA_PATH}/uploads` (attachments) — both are stateful and irreplaceable; everything else is rebuilt from the repo. The Caddy data directory holds TLS certs that will simply be re-provisioned on restore.
- **Logs**: `docker compose logs -f` for everything; `docker compose logs -f api` for the api alone (structured JSON at `LOG_LEVEL=info`); `docker compose logs -f proxy` for Caddy access logs.
- **Updates**: `git pull && docker compose build && docker compose up -d` rebuilds the api + proxy in place. The api's migration startup check applies any new schema versions before serving traffic — no separate migration step.
- **Resetting**: `docker compose down -v` removes containers AND named volumes; combined with `rm -rf ${APPDATA_PATH}/{db,uploads,caddy-data,caddy-config}` this returns you to a fresh install. Don't run this against a real deployment.
- **Multi-node**: not supported in v1. The gateway uses an in-memory event bus, so a second api replica would only see events for connections it owns. v1.x adds a Redis-backed bus; the `cache` service is already up in compose so this becomes a config change, not a topology one.

### Local dev (without docker)

For hacking on the code, the docker stack isn't ideal — you want hot reload. The path is:

```bash
pnpm install
# Postgres anywhere — host install, or a one-off container:
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=zekktris --name zekktris-dev-db postgres:16-alpine
# Configure dev env
cp .env.example .env  # then edit: DATABASE_URL=postgres://postgres:dev@localhost:5432/zekktris
# Terminal 1: api
pnpm --filter @zekktris/api dev
# Terminal 2: web client (Vite proxies /api and /gateway to localhost:3000)
pnpm --filter @zekktris/web dev
```

Then browse to `http://localhost:5173`.

## License

AGPL-3.0
