# Zekktris — Architecture (v1)

> **"Zekktris"** is a working name. Rename freely later — it only appears in `package.json`, the README, and a few branding strings.

---

## 1. Project Goal

A communications app for communities — chat, voice, and shared spaces. Open-source, with the full feature surface and no paid tier: no boosts, no shop, no premium-locked features. All limits become server-config knobs.

Deployment target: a single `docker compose up` on a Linux host (unraid, a VPS, a homelab box). No external SaaS dependencies.

---

## 2. Scope (v1 — this session)

### In scope

| Area | Features |
|---|---|
| **Auth** | Email + password registration, login, JWT access tokens (15 min), refresh tokens (30 day), logout, session list/revoke, password change |
| **Users** | Profile (username, display name, avatar, banner, bio, status: online/idle/dnd/offline), public user lookup |
| **Servers (guilds)** | Create, edit, delete, transfer ownership, leave; icon and banner upload |
| **Channels** | Text channels, categories, create/rename/delete, topic, position/ordering, NSFW flag |
| **Messages** | Send, edit, delete, reply (referenced message), markdown rendering, code blocks, mentions (`@user`, `@role`, `@everyone`, `@here`, `#channel`), reactions, pinned messages, message history with cursor pagination |
| **Attachments** | File upload (configurable size limit), inline image preview, generic file card |
| **DMs** | 1-on-1 DMs, group DMs (up to N members), DM message history |
| **Roles & permissions** | Discord-style role list with bitfield permissions, role hierarchy by position, channel-level permission overrides for both roles and individual members, per-channel evaluation |
| **Members** | Member list, nickname, kick, ban (with unban), assign/remove roles |
| **Invites** | Invite code generation, max-uses + expiry, join via code |
| **Friends** | Send/accept/decline/cancel friend requests, friend list, block/unblock |
| **Real-time** | WebSocket gateway: live message/channel/role/member/presence/typing events |
| **Read state** | Per-channel "last read" tracking, unread badges, mention counts |
| **Audit log** | Server actions logged (channel/role/member changes, bans, kicks) |
| **Notifications** | In-app unread + mention counts; browser Notification API for desktop pushes |
| **Search** | Basic message search within a channel/server (Postgres full-text) |

### Explicitly out of scope (later sessions, not this one)

- Voice channels (WebRTC + mediasoup) — **next big milestone**
- Video calls and screen sharing — depends on voice infrastructure
- Threads (the Discord "thread" feature within a channel)
- Stage channels / forum channels
- Custom emoji upload, animated emoji, stickers
- Bots / application API / slash commands / webhooks
- Rich embeds beyond basic OpenGraph link previews
- Server discovery / public server browser
- Mobile apps (web is responsive, but no React Native build)
- E2EE for DMs (requires its own design phase)
- Federation / multi-server interconnect

### Explicitly dropped (these are Discord's paid features)

- Server boosts and boost perks
- Nitro tiers, profile customization tiers, larger upload limits as a paid SKU
- Sticker shop, soundboard shop, emoji slot increases as purchases

---

## 3. Service Topology

```
                         ┌──────────────┐
                  HTTPS  │              │
   Browser  ────────────▶│    proxy     │  Caddy: TLS, routing, gzip
                         │  (caddy:2)   │
                         └──────┬───────┘
                                │
                ┌───────────────┼───────────────┐
                │                               │
                ▼                               ▼
        ┌──────────────┐              ┌──────────────┐
        │     web      │              │     api      │
        │ (nginx+SPA)  │              │ (Bun+Hono)   │   :3000
        │   static     │              │ REST + tRPC  │
        └──────────────┘              │ + WebSocket  │
                                      └──┬────────┬──┘
                                         │        │
                          ┌──────────────┘        └─────────────┐
                          ▼                                     ▼
                  ┌───────────────┐                     ┌───────────────┐
                  │      db       │                     │     cache     │
                  │ (postgres:16) │                     │  (redis:7)    │
                  └───────────────┘                     └───────────────┘
                                                                │
                                                                │  pub/sub
                                                                ▼
                                                       (gateway fanout)

                  ┌───────────────────────────────────┐
                  │   uploads volume (host-mounted)   │
                  │   /var/lib/zekktris/uploads        │
                  └───────────────────────────────────┘
```

| Service | Image | Internal port | Exposed? | Role |
|---|---|---|---|---|
| `proxy` | `caddy:2-alpine` | 80, 443 | **Yes** (host 8080/8443, configurable) | TLS termination, reverse proxy |
| `web` | local build (nginx-alpine + SPA) | 80 | No | Static frontend assets |
| `api` | local build (Bun) | 3000 | No | HTTP API + WebSocket gateway |
| `db` | `postgres:16-alpine` | 5432 | No | Primary data store |
| `cache` | `redis:7-alpine` | 6379 | No | Session blacklist, presence, pub/sub for WS fanout |

**Why split this way:**
- `db` and `cache` are stock images — never built, never modified.
- `api` and `web` are independently buildable; you can update either without redeploying the whole stack.
- `proxy` is the *only* publicly exposed surface. Everything else stays on the internal docker network.
- Adding a future `media` service for voice/video is a matter of adding one row to compose; nothing else changes.

---

## 4. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| **API runtime** | Bun (fallback Node) | Same as Sharkord; built-in TS, fast, less tooling |
| **HTTP framework** | Hono | Tiny, fast, native Bun support, great WS story |
| **API style** | tRPC + REST | tRPC for typed client calls; REST for file uploads, OAuth callbacks, public endpoints |
| **DB** | Postgres 16 | Multi-service requires a real DB; full-text search; JSON support |
| **ORM** | Drizzle | Lightweight, SQL-first, good migration story, same as Sharkord |
| **Cache / pubsub** | Redis 7 | Standard, presence + WS fanout |
| **Auth** | JWT (jose lib) + bcrypt | Standard, no third-party auth service needed |
| **Validation** | Zod | Shared schemas between client and server |
| **Frontend** | React 18 + Vite | Mature, fast HMR |
| **State** | Zustand + TanStack Query | Zustand for client state, Query for server cache |
| **Styling** | Tailwind + ShadCN/Radix | Same as Sharkord; battle-tested |
| **Routing** | TanStack Router | Type-safe, file-based |
| **Markdown** | `react-markdown` + `remark-gfm` + `rehype-sanitize` | Safe rendering of message content |
| **WebSocket client** | Native `WebSocket` + reconnect wrapper | No need for socket.io complexity |
| **Reverse proxy** | Caddy | Auto-TLS, simpler than nginx for self-host |
| **Monorepo** | pnpm workspaces + Turborepo | Standard |

---

## 5. Data Model

Core entities (Drizzle/Postgres). IDs are 64-bit Snowflakes (timestamp-ordered, sortable, no UUID-vs-ID lookup hop).

```
User                   ── 1:N ──▶  Session
                       ── 1:N ──▶  GuildMember
                       ── 1:N ──▶  Message  (author)
                       ── M:N ──▶  User     (Friend, Block)
                       ── 1:N ──▶  ReadState

Guild (Server)         ── 1:N ──▶  GuildMember
                       ── 1:N ──▶  Channel
                       ── 1:N ──▶  Role
                       ── 1:N ──▶  Invite
                       ── 1:N ──▶  AuditLogEntry
                       ── 1:N ──▶  Ban

Channel                ── 1:N ──▶  Message
                       ── 1:N ──▶  PermissionOverride
                       ── N:1 ──▶  Channel  (parent category)

Role                   ── 1:N ──▶  PermissionOverride
                       ── M:N ──▶  GuildMember (member_roles join)

Message                ── 1:N ──▶  Attachment
                       ── 1:N ──▶  Reaction
                       ── 1:N ──▶  Mention
                       ── N:1 ──▶  Message  (reply_to)

DMChannel              ── 1:N ──▶  Message
                       ── M:N ──▶  User (dm_recipient join)
```

Full DDL goes in `packages/db/schema.ts`. I'll generate it during implementation; it's enumerated in detail there.

**Snowflake ID format** (64-bit): `[42-bit ms-since-epoch][10-bit worker][12-bit seq]`. Same shape Discord uses; sorts chronologically without a separate `created_at` index.

---

## 6. Permissions Model

Discord's exact model. Permissions are a **bitfield** stored as `bigint`.

```
ADMINISTRATOR        = 1 << 0   // bypasses every check
VIEW_CHANNEL         = 1 << 1
SEND_MESSAGES        = 1 << 2
MANAGE_MESSAGES      = 1 << 3
ATTACH_FILES         = 1 << 4
ADD_REACTIONS        = 1 << 5
MENTION_EVERYONE     = 1 << 6
MANAGE_CHANNELS      = 1 << 7
MANAGE_ROLES         = 1 << 8
KICK_MEMBERS         = 1 << 9
BAN_MEMBERS          = 1 << 10
MANAGE_GUILD         = 1 << 11
CREATE_INVITE        = 1 << 12
CHANGE_NICKNAME      = 1 << 13
MANAGE_NICKNAMES     = 1 << 14
VIEW_AUDIT_LOG       = 1 << 15
READ_MESSAGE_HISTORY = 1 << 16
... (room to grow for voice/video later)
```

**Resolution algorithm** (per-channel, per-member):

```
1. If member is guild owner            → ALL_PERMISSIONS, stop
2. base = @everyone role permissions
3. for each role the member has (by position ascending):
       base |= role.permissions
4. If base contains ADMINISTRATOR      → ALL_PERMISSIONS, stop
5. apply channel override for @everyone:
       base = (base & ~override.deny) | override.allow
6. fold all role overrides into one (deny then allow), then apply
7. apply member-specific override (deny then allow)
8. result = final permission bitfield
```

This is the canonical Discord algorithm. It must be implemented identically in two places:
- `apps/api/src/permissions.ts` — server-side, source of truth.
- `apps/web/src/lib/permissions.ts` — client-side, for UI gating only (greying out buttons). Server still re-checks every action.

---

## 7. Real-time (Gateway)

### Wire protocol

WebSocket at `wss://host/gateway`. After upgrade, the client must `IDENTIFY` with their access token within 5 seconds or the connection drops.

Message frames are JSON:

```json
{ "op": 0, "t": "MESSAGE_CREATE", "d": { ... }, "s": 42 }
```

| Op | Name | Direction | Purpose |
|---|---|---|---|
| 0 | DISPATCH | server → client | Real event |
| 1 | HEARTBEAT | both | Keep-alive (every 30s) |
| 2 | IDENTIFY | client → server | Auth handshake |
| 3 | PRESENCE_UPDATE | client → server | Set status |
| 4 | RESUME | client → server | Reconnect with last seq |
| 5 | RECONNECT | server → client | Tell client to reconnect |
| 6 | INVALID_SESSION | server → client | Re-IDENTIFY required |
| 7 | HELLO | server → client | Initial frame, gives heartbeat interval |
| 8 | HEARTBEAT_ACK | server → client | Confirms HB received |

`s` is a per-connection sequence number for `RESUME` after disconnect.

### Event types (v1)

`READY`, `RESUMED`, `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE`, `CHANNEL_PINS_UPDATE`, `GUILD_CREATE`, `GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_MEMBER_ADD`, `GUILD_MEMBER_UPDATE`, `GUILD_MEMBER_REMOVE`, `GUILD_BAN_ADD`, `GUILD_BAN_REMOVE`, `GUILD_ROLE_CREATE`, `GUILD_ROLE_UPDATE`, `GUILD_ROLE_DELETE`, `TYPING_START`, `PRESENCE_UPDATE`, `USER_UPDATE`, `RELATIONSHIP_ADD`, `RELATIONSHIP_UPDATE`, `RELATIONSHIP_REMOVE`.

### Multi-instance fanout

Single API instance is a closed loop. To support running 2+ API replicas behind a load balancer (homelab → small community scale), we use Redis pub/sub:

- Each API instance subscribes to: `guild:<id>`, `user:<id>`, `dm:<id>` channels for connected sockets only.
- When mutating an entity, the API publishes the event to the relevant channel(s).
- All subscribed instances forward to their local sockets.

For v1 the expected deployment is a single API container, but designing for fanout from day one costs nothing and avoids a refactor later.

---

## 8. Auth Model

### Tokens

- **Access token**: JWT, 15 min lifetime, signed with `JWT_SECRET` (HS256). Carries `{ userId, sessionId, iat, exp }`. Sent in `Authorization: Bearer ...` header.
- **Refresh token**: Opaque random 256-bit string. Stored hashed (SHA-256) in `Session` table. Sent in `httpOnly`, `Secure`, `SameSite=Lax` cookie.

### Session lifecycle

1. `POST /auth/register` or `POST /auth/login` → returns `{ accessToken }`, sets refresh cookie, creates `Session` row.
2. Client uses access token for all calls. When server returns 401, client calls `POST /auth/refresh`.
3. `/auth/refresh` reads the cookie, looks up `Session`, validates not-expired and not-revoked, rotates refresh token (writes new hash), returns new access token.
4. `POST /auth/logout` revokes the current session.
5. `GET /users/@me/sessions` lists all sessions; `DELETE /users/@me/sessions/:id` revokes a specific one.

### Password

- bcrypt with cost factor 12.
- Minimum 8 chars, no max (bcrypt's 72-byte cap is handled by pre-hashing with SHA-256 if needed).
- Reset flow deferred — needs SMTP. v1 ships an admin "reset password for user X" CLI inside the API container.

### Registration controls

Env var `ALLOW_REGISTRATION` (`open` | `invite-only` | `closed`). Invite-only requires an admin-issued signup code.

---

## 9. File Uploads

- POST `multipart/form-data` to `/uploads`. API validates size and MIME, writes to `${UPLOAD_DIR}/<yyyy>/<mm>/<snowflake>-<filename>`, returns `{ id, url, size, contentType }`.
- Uploaded files are **public-read by URL** but URLs contain a snowflake ID — non-guessable. Auth-gated channels are protected by *not handing out the URL* unless the user can view the channel; the file itself is not auth-walled (Discord's model — same tradeoff).
- Image attachments get on-the-fly `width`/`height` extracted via `sharp` for layout stability.
- Volume `uploads` is mounted into the `api` container at `/data/uploads` and into `proxy` at the same path so Caddy can serve `/cdn/*` directly without round-tripping to the API.

Limits, all configurable:
- `MAX_UPLOAD_SIZE_MB` per file (default 100)
- `MAX_FILES_PER_MESSAGE` (default 10)
- `MAX_TOTAL_UPLOAD_PER_USER_GB` (default 10, optional, off by default)

---

## 10. Project Structure

```
zekktris/
├── apps/
│   ├── api/                       # Bun + Hono backend
│   │   ├── src/
│   │   │   ├── index.ts           # Server entry
│   │   │   ├── routes/            # REST + tRPC routers
│   │   │   ├── gateway/           # WebSocket gateway
│   │   │   ├── permissions.ts     # Permission resolver
│   │   │   ├── auth/              # JWT, sessions, bcrypt
│   │   │   ├── uploads/           # File handling
│   │   │   ├── snowflake.ts       # ID generation
│   │   │   └── pubsub.ts          # Redis fanout
│   │   ├── Dockerfile
│   │   └── package.json
│   └── web/                       # React + Vite frontend
│       ├── src/
│       │   ├── routes/            # TanStack Router pages
│       │   ├── components/        # UI components
│       │   ├── lib/               # API client, ws client, utils
│       │   ├── stores/            # Zustand stores
│       │   └── styles/
│       ├── Dockerfile
│       └── package.json
├── packages/
│   ├── db/                        # Drizzle schema + migrations
│   │   ├── schema.ts
│   │   ├── migrations/
│   │   └── package.json
│   ├── shared/                    # Shared Zod schemas + types + permission constants
│   │   ├── permissions.ts
│   │   ├── events.ts              # Gateway event type definitions
│   │   └── package.json
│   ├── client/                    # Browser-side REST + gateway client (no React)
│   │   └── package.json
│   └── tsconfig/                  # Shared TS configs
├── ops/
│   ├── Dockerfile.api             # Multi-stage: pnpm install → tsx runtime
│   ├── Dockerfile.web             # Multi-stage: vite build → Caddy with SPA baked in
│   └── Caddyfile                  # Reverse proxy + SPA host
├── scripts/
│   └── generate-secrets.sh        # Generates .env with fresh JWT + DB secrets
├── docker-compose.yml             # 4-service production stack (proxy/api/db/cache)
├── .dockerignore
├── .env.example
├── README.md
├── ARCHITECTURE.md                # This file
├── package.json                   # Root, workspaces config
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 11. Deployment

### Service topology

Four containers on one bridge network:

```
                    host:80  host:443
                       │        │
                       ▼        ▼
                 ┌──────────────────┐
                 │  proxy (Caddy)   │   ops/Dockerfile.web
                 │  + SPA bundle    │   ops/Caddyfile
                 └──────────────────┘
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
      ┌─────────┐   ┌─────────┐   ┌─────────┐
      │   api   │   │   db    │   │  cache  │
      │ Node20  │   │  PG 16  │   │ Redis 7 │
      └─────────┘   └─────────┘   └─────────┘
```

Only `proxy` exposes ports to the host. The other three are reachable only over the internal `zekktris` bridge network.

### Image build

The two Dockerfiles in `ops/` use the workspace pnpm install pattern:

- **`Dockerfile.api`**: stage 1 copies the workspace manifests and runs `pnpm install --filter @zekktris/api...`; stage 2 brings the source in on top of those resolved deps and runs the api with `tsx` directly. No tsc-output bundling step — `tsx`'s ~200 ms startup cost is fine for a long-lived service, and avoiding bundling sidesteps the workspace-symlink+migrations-folder fragility that bundlers typically introduce. Tini is the entrypoint so SIGTERM propagates cleanly to Node and the api's graceful-shutdown handler runs.
- **`Dockerfile.web`**: stage 1 runs `pnpm vite build`; stage 2 is a Caddy alpine image with `dist/` copied to `/srv/web` and the Caddyfile baked in. One container handles both static SPA serving AND reverse proxying, so there's a single TLS provisioning point.

### Caddy routing (`ops/Caddyfile`)

Site address comes from the `PUBLIC_URL` env var, which is what makes Caddy decide whether to provision TLS:

- `https://chat.example.com` → auto-issued Let's Encrypt cert via HTTP-01
- `http://zekktris.local` or `http://localhost` → plain HTTP

Path matchers route `/api/*`, `/cdn/*`, `/health`, and `/gateway` (with WebSocket-friendly `keepalive 5m` transport) to `api:3000`. Everything else falls through to the SPA file_server with `try_files {path} /index.html` so client-side routes survive a hard refresh. Modest security headers (Referrer-Policy, X-Frame-Options, X-Content-Type-Options, Permissions-Policy) and zstd/gzip compression complete the config.

### Migrations on startup

The api container does NOT run a separate migration step. Instead, `runMigrations()` is one of the 10 startup checks (`[6/10] Database migrations`). On a fresh empty database the schema is applied in ~150 ms; on subsequent boots drizzle's `__drizzle_migrations` tracking table makes the call a no-op verifying that all migrations are present. Operators see `[6/10] Database migrations ✓ (Nms)` in the docker logs alongside every other thing that has to be healthy before the HTTP port binds.

### Required env vars

Generated by `./scripts/generate-secrets.sh`, read from `.env` by docker compose:

```
PUBLIC_URL=https://chat.example.com   # or http://localhost for LAN
APPDATA_PATH=/mnt/user/appdata/zekktris # bind-mount root; default ./data
HTTP_PORT=80                           # Caddy listener
HTTPS_PORT=443
DB_PASSWORD=<openssl rand -hex 24>
JWT_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32 — must differ>
ALLOW_REGISTRATION=open                # open | invite-only | closed
MAX_UPLOAD_SIZE_MB=100
```

Bind-mount paths under `APPDATA_PATH`:

- `${APPDATA_PATH}/db` — Postgres data
- `${APPDATA_PATH}/uploads` — message attachments
- `${APPDATA_PATH}/caddy-data` — Caddy certs (persisted across recreations to avoid Let's Encrypt rate limits)
- `${APPDATA_PATH}/caddy-config` — Caddy auto-managed config

### Unraid

Unraid 6.12+ supports docker-compose natively via the **Compose Manager** plugin. Operators set `APPDATA_PATH=/mnt/user/appdata/zekktris` in `.env` and add the stack via Compose Manager — no separate Community Apps XML template is needed because the compose file is the deliverable.

---

## 12. Development workflow

```bash
git clone ...
cd zekktris
cp .env.example .env
./scripts/generate-secrets.sh
pnpm install
# Postgres anywhere — host install or a one-off container:
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=zekktris --name zekktris-dev-db postgres:16-alpine
# Edit .env so DATABASE_URL points at it: postgres://postgres:dev@localhost:5432/zekktris
pnpm --filter @zekktris/api dev   # api on http://localhost:3000
pnpm --filter @zekktris/web dev   # web on http://localhost:5173 (Vite proxies /api and /gateway)
```

Migrations apply automatically on api boot (one of the startup checks); `pnpm db:migrate` is also exposed for explicit one-off use.

---

## 13. Roadmap (after v1 ships)

| Milestone | Adds |
|---|---|
| **v1.1** | Voice channels (mediasoup SFU service), voice connect/disconnect events, mute/deafen |
| **v1.2** | Video calls + screen sharing |
| **v1.3** | Threads, polls, link embeds (OpenGraph) |
| **v1.4** | Bots / webhooks / minimal application API |
| **v1.5** | Push notifications (Web Push), mobile-PWA polish |
| **v2.0** | Federation (Matrix-style or custom) — large design phase |

---

## 14. Risks & open questions

- **Snowflake collisions** under high concurrency: mitigated by per-process worker ID; documented setup for multi-replica.
- **Permission resolver correctness**: I'll write an exhaustive unit test suite mirroring the documented algorithm, since this is the easiest place for bugs to hide.
- **Postgres + Redis on small unraid boxes**: both are lightweight at this scale; combined ~150 MB RAM for a small server. Acceptable.
- **TLS for first-time users on a LAN**: Caddy auto-TLS won't work without a real domain. README will document running `proxy` in HTTP-only mode for LAN use, with a clear security warning.
- **Search at scale**: Postgres full-text is fine for v1. Beyond ~10M messages we'd want Meilisearch or Tantivy as a separate service.

---

## 15. What I need from you

Please confirm or push back on:

1. The split of services (proxy / web / api / db / cache).
2. The choice to defer voice/video and focus v1 on text + structure.
3. The Discord-identical permission model (vs simplified roles).
4. The auth model (email + password, JWT + refresh, no SSO in v1).
5. The "Zekktris" working name (or supply one).

Once you green-light, I'll begin implementation in this order:
- Monorepo scaffold + `packages/db` schema + migrations
- `apps/api` auth + users
- `apps/api` guilds + channels + members + roles + permissions
- `apps/api` messages + DMs + uploads
- `apps/api` gateway (WebSocket)
- `apps/web` shell, auth flow, app layout
- `apps/web` server/channel browsing + chat UI + DMs
- `apps/web` settings/profile/admin panels
- Docker compose + Caddy + unraid template
- README + run instructions
