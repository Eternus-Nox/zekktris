# Zekktris

A cross-platform communications app for communities — text chat, voice & video,
and shared spaces — with native iOS, web, Electron desktop and Android clients.
Use the hosted server at zekktris.com, or run your own: `./install.sh` sets one
up on any Linux machine, reachable by a domain, just your public IP, or only
your home network. The apps connect to any server from their sign-in screen
("Server · Change").

Everything is free, cosmetics included. Scout / Guardian / Legend are perk
tiers a server's admins hand out for higher streaming quality (by default:
everyone 720p30, Scout 1080p + 60fps, Guardian 2K, Legend 4K). The quality
ladder is applied by the apps; LiveKit tokens can't limit resolution or frame
rate, so the server doesn't enforce it. Per-tier upload caps are enforced by
the server.

> **Status:** active development, but well past "skeleton" — Zekktris is a
> working v1.x platform with voice/video calls, end-to-end-encrypted DMs,
> threads & forums, roles & permissions, parental controls, a bot platform,
> admin tooling, and three clients (web, native iOS, desktop). See
> [ARCHITECTURE.md](./ARCHITECTURE.md) for the as-built design.

## Feature overview

**Messaging** — guilds (servers) with categorised text channels; messages with
edit/delete, replies, markdown (bold/italic/strike/`code`/fenced blocks,
auto-links), `@user`/`@role`/`@everyone`/`@here`/`#channel` mentions, reactions
(unicode + custom emoji), pins, attachments with inline image preview, polls,
stickers, message search (Postgres full-text), saved messages, and
scheduled messages. Per-channel slowmode and an "(edited)" marker.

**DMs & friends** — 1:1 and group DMs, friend requests, block/unblock, DM call
buttons, and **end-to-end-encrypted DMs** (AES-256-GCM, see below).

**Voice & video** — voice channels, 1:1 DM calls, stage channels, mute/deafen,
per-participant presence, screen share — powered by a bundled (or external)
**LiveKit** SFU. DM calls can be end-to-end encrypted.

**Threads & forums** — threads spun off messages, and forum-style channels with
posts.

**Roles & permissions** — Discord-style bitfield permissions, role hierarchy by
position, channel-level overrides for roles and individual members, evaluated
per-channel both server-side (source of truth) and client-side (UI gating).
Self-assignable roles and reaction roles.

**Moderation & safety** — bans/kicks, audit log, AutoMod (keyword/regex rules),
raid protection, a reports queue, and an instance security log. **Parental
controls / family supervision**: link a child account, restrict guild/DM/voice
access, block guilds, watch-words, and a flagged-message feed.

**Accounts & auth** — email + password, JWT access tokens + rotating refresh
tokens, session list/revoke, password change, password reset (SMTP), email
verification, **TOTP 2FA** with recovery codes, and prompt session revocation
on logout/ban.

**Community** — guild discovery/browser, custom emoji & stickers, scheduled
events with RSVPs, achievements & DM streaks, invite preview-then-join,
webhooks, and a **bot platform** (bot tokens, per-guild install, slash
commands).

**Admin** — instance stats, user ban/management, guild list + delete, storage
breakdown + GC, security tab, ghost-mode observe, and instance settings.

**Clients** — a React web SPA, a **native SwiftUI iOS app** ([`ios-native/`](./ios-native)),
and an **Electron desktop app** ([`desktop/`](./desktop)). Web push (VAPID) and
native APNs/PushKit notifications.

## Tech stack

| Layer | Choice |
|---|---|
| API runtime | Node 20 + `tsx` (no build step) |
| HTTP / WS framework | [Hono](https://hono.dev) — REST API + WebSocket gateway |
| Database | PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team) |
| Cache / fanout | Redis 7 (`ioredis`) — cross-replica gateway bus + session blacklist |
| Realtime media | [LiveKit](https://livekit.io) SFU (bundled, or LiveKit Cloud) |
| Auth | JWT (`jose`, HS256) + `scrypt` password hashing |
| Validation | Zod (shared client/server schemas) |
| Reverse proxy | Caddy (auto-TLS) |
| Web client | React 18 + Vite + Tailwind, `react-router`, `use-context-selector` state, `livekit-client`, `tweetnacl-util` |
| iOS client | Native SwiftUI (URLSession + WebSocket + LiveKit Swift SDK) |
| Desktop client | Electron thin shell |
| Monorepo | pnpm workspaces + Turborepo |

## Project layout

```
zekktris/
├── apps/
│   ├── api/                # Hono REST + WebSocket gateway (Node + tsx)
│   │   └── src/            # routes/, services/, gateway/, auth/, lib/, db
│   └── web/                # React + Vite + Tailwind SPA
│       └── src/            # app/ (views), state/, auth/, lib/
├── packages/
│   ├── db/                 # Drizzle schema + SQL migrations (auto-applied on boot)
│   ├── client/             # @zekktris/client — REST + gateway protocol clients
│   ├── shared/             # permissions, snowflakes, gateway events, constants
│   └── tsconfig/           # shared TS configs
├── ios-native/            # native SwiftUI iOS client (see its README)
├── desktop/               # Electron desktop shell
├── ops/
│   ├── Dockerfile.api      # multi-stage: pnpm install → tsx runtime
│   ├── Dockerfile.web      # multi-stage: vite build → Caddy with SPA baked in
│   └── Caddyfile           # reverse proxy + SPA host + /livekit proxy
├── scripts/
│   ├── setup.sh            # one-shot: secrets → build → up → wait healthy
│   └── generate-secrets.sh # writes .env with fresh JWT/DB/LiveKit secrets
├── docker-compose.yml     # 5 services: proxy, api, db, cache, livekit
├── .env.example
└── ARCHITECTURE.md
```

## Running for development (without Docker)

You need Node 20+, pnpm 9+, and Postgres 16 (Redis and LiveKit are optional in
dev — the API degrades to an in-memory event bus and voice is simply
unavailable without LiveKit creds).

```bash
pnpm install

# Generate dev secrets into .env (refuses to overwrite an existing one)
./scripts/generate-secrets.sh
# For local dev, point uploads at the repo and DATABASE_URL at your Postgres:
#   APPDATA_PATH=./data
#   DATABASE_URL=postgres://postgres:dev@localhost:5432/zekktris

# Postgres anywhere — a one-off container works:
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=zekktris \
  --name zekktris-dev-db postgres:16-alpine

# Apply migrations (the API also auto-applies them on boot)
pnpm db:migrate

# Terminal 1 — API at http://localhost:3000
pnpm --filter @zekktris/api dev
# Terminal 2 — web at http://localhost:5173 (Vite proxies /api and /gateway)
pnpm --filter @zekktris/web dev
```

Monorepo tasks run through Turborepo: `pnpm typecheck`, `pnpm test` (Vitest),
`pnpm build`. Database: `pnpm db:migrate` (apply against `$DATABASE_URL`).

Migrations are hand-written SQL. To change the schema, add the next numbered
file in `packages/db/migrations/` (`NNNN_my_change.sql`, with NNNN the next
unused number), append a matching entry to
`packages/db/migrations/meta/_journal.json` (next `idx`, the file name without
`.sql` as `tag`, a `when` later than the previous entry), and update the
Drizzle schema in `packages/db/src/schema/` to match. Don't use `drizzle-kit
generate` or `push`: its snapshots stop at 0004, so it would try to re-create
existing tables or drop objects that exist only in SQL.

Quick auth smoke test:

```bash
curl -i -c jar.txt -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","username":"alice","displayName":"Alice","password":"correct-horse-battery"}'
# Response includes { accessToken, user }. Use it:
TOKEN="<paste accessToken>"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/users/@me
```

## API surface

The REST API is versioned under `/api/v1`. Routers live in
[`apps/api/src/routes/`](./apps/api/src/routes) — browse them for the exact,
current endpoint list. The route groups:

`auth` · `users` · `guilds` · `channels` · `messages` · `dms` · `invites` ·
`voice` · `stage` · `emojis` · `stickers` · `webhooks` · `discovery` · `family`
(parental controls) · `admin` · `cdn` (attachment streaming) · `health`.

All errors share the envelope `{ "error": { "code", "message", "details?" } }`.
Most endpoints take a `Bearer` access token; refresh uses an httpOnly cookie.

### Gateway protocol

A WebSocket endpoint at `/gateway`. Frames use the JSON shape
`{ op, t?, d, s? }` (Discord-style vocabulary). The handshake is
**HELLO → IDENTIFY → READY**, after which the server pushes `DISPATCH` frames
as state changes. Clients heartbeat every 30s; missing two drops the
connection.

- **Sequence numbers + RESUME.** Each `DISPATCH` carries a monotonic `s`. On a
  reconnect within the resume window the client sends `RESUME {token,
  session_id, seq}` and the server replays the missed, already-permission-
  filtered frames from a bounded per-session buffer — no full re-sync. If the
  gap is too large (or the session is unknown), the server answers
  `INVALID_SESSION{resumable:false}` and the client falls back to a fresh
  IDENTIFY.
- **Permission-filtered fanout.** Each connection caches the channels it can
  `VIEW_CHANNEL` (computed at IDENTIFY). Channel-scoped events are filtered
  against that set, and the cache is refreshed live on any visibility-changing
  mutation (role grant/revoke, override change, role-bit edit, channel create)
  — so a private channel leaks neither its messages, name, nor existence.

## Deploying

The repo ships a 5-service `docker-compose.yml`:

| Service | Image / Build | Public? | Purpose |
|---|---|---|---|
| `proxy` | `ops/Dockerfile.web` (Caddy + SPA bundle) | yes (80/443 or 5550/5551) | TLS, reverse-proxies `/api`, `/cdn`, `/gateway`, `/livekit`, `/health`; serves the SPA |
| `api`   | `ops/Dockerfile.api` (Node + tsx) | no | REST + WebSocket gateway; runs migrations + startup checks before binding |
| `db`    | `postgres:16-alpine` | no | Primary data store; schema auto-migrated on api boot |
| `cache` | `redis:7-alpine` | no | Cross-replica gateway event bus + session-revocation blacklist (fail-soft) |
| `livekit` | `livekit/livekit-server` | host network | Bundled SFU for voice/video (or point at LiveKit Cloud) |

Only `proxy` exposes ports to the host. The `livekit` service uses host
networking so WebRTC media can reach it directly.

### Quick start (any Linux box)

```bash
git clone <repo-url> zekktris
cd zekktris
./install.sh
```

The installer checks Docker (and offers to install it), finds this machine's
LAN address and the network's public IP, tells you if your ISP uses
carrier-grade NAT, asks the router to forward ports over UPnP when it can, opens
ufw/firewalld, writes `.env` with fresh secrets, starts the stack, and waits for
HTTPS. Three ways to be reached:

| | How | HTTPS |
|---|---|---|
| `./install.sh --ip` | your public IP + port forwarding — no domain needed | Let's Encrypt **IP certificate** (6-day, auto-renewed) |
| `./install.sh --domain chat.example.com` | a DNS A record pointing here | Let's Encrypt |
| `./install.sh --lan` | home network only | none (apps work; browser calls need HTTPS) |

Router ports for `--ip` / `--domain`: TCP 80, 443, 7881 and UDP 443, 7882.
The installer asks for an admin email and password and, once the server is
up, creates that account itself (already verified, already admin) — sign in
with it. For scripted installs pass `--admin-email` plus `--admin-password-file`
(or set `ZEKKTRIS_ADMIN_PASSWORD`). Re-run `./install.sh` any time (it never
replaces your secrets); `--reconfigure` changes how the server is reached,
`--admin-email` on an existing install makes that account an admin (creating it
if needed; an existing account must have verified its address), and a server
left without an admin by an interrupted install is offered one again.

Then set `ALLOW_REGISTRATION=invite-only` (or `closed`) in `.env` and
`docker compose up -d` if you want a private server. To drive it manually:

```bash
./scripts/generate-secrets.sh    # write .env with fresh secrets
$EDITOR .env                     # PUBLIC_URL, ports, registration mode, …
docker compose up -d --build
docker compose logs -f api
# then create the admin account (asks for its password, hidden):
docker compose exec -w /app/apps/api api node --import tsx/esm scripts/create-admin.ts --email you@example.com
```

### TLS

The default `PUBLIC_URL=http://localhost:5550` is plaintext HTTP for LAN-only
use or behind another TLS-terminating proxy. For Caddy's built-in Let's
Encrypt automation, point `PUBLIC_URL` at a real domain and expose port 80 (the
ACME HTTP-01 challenge requires it) and 443:

```
PUBLIC_URL=https://chat.example.com
SITE_ADDRESS=https://chat.example.com
HTTP_PORT=80
HTTPS_PORT=443
COOKIE_SECURE=true
```

No domain: use the public IP with `TLS_MODE=ip` (see `ops/caddy-modes/README`)
— `./install.sh --ip` writes all of it.

The 5550/5551 defaults are deliberately non-standard so a fresh stack doesn't
fight other services for ports. If you front this with an existing reverse
proxy (NPM, SWAG, edge Caddy, Cloudflare Tunnel, …), keep the 5550 default and
forward `/api/*`, `/cdn/*`, `/gateway` (with WebSocket upgrades), `/livekit/*`,
and `/` (the SPA).

### Voice / LiveKit

The bundled `livekit` container runs the SFU and is reached by the API at
`host.docker.internal:7880`; the browser/native clients reach signaling through
the proxy at `/livekit`. **WebRTC media flows over UDP 7882** (with a TCP 7881
fallback) — that port must be reachable for calls to connect, and is the #1
self-host gotcha. To skip running the SFU yourself, point `LIVEKIT_WS_URL` (plus
the API key/secret) at **LiveKit Cloud** instead.

### Unraid

Use the **Docker Compose Manager** plugin from Community Apps:

```bash
mkdir -p /mnt/user/appdata/zekktris && cd /mnt/user/appdata/zekktris
git clone <repo-url> .
./install.sh
```

`APPDATA_PATH` already defaults to `/mnt/user/appdata/zekktris`, so a stock box
needs no edit. The bind mounts (`db`, `uploads`, `caddy-data`, `caddy-config`)
auto-create on first start. For non-unraid hosts set `APPDATA_PATH` to a path
that exists — `./data` inside the repo is a sensible choice.

### Operational notes

- **Backups**: snapshot `${APPDATA_PATH}/db` (Postgres) and
  `${APPDATA_PATH}/uploads` (attachments) — both are stateful and
  irreplaceable. Migrations are forward-only and auto-apply on boot, so **back
  up before updating**. Caddy's cert directory re-provisions itself on restore.
- **Logs**: `docker compose logs -f api` (structured JSON at `LOG_LEVEL=info`);
  `docker compose logs -f proxy` for Caddy access logs.
- **Updates**: `./scripts/update.sh` — backs up, pulls, rebuilds, and rolls
  back if the new build fails its health check. The api applies new migrations
  before serving traffic.
- **Phone push notifications**: the official iOS/Android apps receive push only
  from servers holding the app's APNs/FCM keys; on other servers everything else
  works and browsers use web push.
- **Multi-node**: supported when `REDIS_URL` is set (it is, by default, pointing
  at the `cache` service): the gateway event bus and session-revocation
  blacklist fan out through Redis so multiple API replicas stay consistent.
  Caveat — **gateway RESUME needs sticky sessions**: the replay buffer is
  per-process, so a load balancer must route a reconnecting socket back to the
  same replica (or the client harmlessly falls back to a full IDENTIFY).

## License

Zekktris is free software: you can redistribute it and/or modify it under the
terms of the **GNU Affero General Public License, version 3** — see
[LICENSE](./LICENSE).

In short: anyone may run, self-host, study, modify and share it. If you run a
**modified** version for other people over a network, you must offer them your
modified source (set `SOURCE_CODE_URL` in `.env` — the web app links to it).

Copyright © 2026 Eternus Nox.
