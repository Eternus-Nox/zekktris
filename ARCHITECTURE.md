# Zekktris — Architecture

This describes the system **as built**. Zekktris is a cross-platform
communications app for communities — text chat, voice/video, and shared spaces
— with native iOS, web, Electron desktop and Android clients. It runs as the
hosted zekktris.com or as anyone's own server (`./install.sh`); the native
clients pick the server at sign-in (iOS/Android `Config`, desktop
`src/server.ts`), checked via the public `GET /api/v1/instance/info`. Everything
is free; Scout / Guardian / Legend are admin-given perk tiers that raise
streaming quality (`services/monetization.ts`).

> **Naming:** "Zekktris" is the working name; it only appears in branding
> strings, `package.json`, and a few URLs.

---

## 1. Service topology

Five containers on one bridge network. Only `proxy` is publicly exposed.

```
                         ┌──────────────┐
                  HTTPS  │    proxy     │  Caddy: TLS, routing, compression,
   Clients ─────────────▶│   (caddy)    │  SPA host, /livekit signaling proxy
                         └──────┬───────┘
                                │
              ┌─────────────────┼───────────────────┐
              ▼                 ▼                    ▼
        ┌──────────┐     ┌──────────┐         ┌──────────────┐
        │   api    │     │  livekit │◀─UDP────│  client WebRTC│
        │ Node+tsx │     │   SFU    │  7882    │  media        │
        │ Hono REST│     └──────────┘         └──────────────┘
        │ + WS     │
        └──┬────┬──┘
           │    │
     ┌─────┘    └──────┐
     ▼                 ▼
┌──────────┐     ┌──────────┐
│   db     │     │  cache   │
│ Postgres │     │  Redis   │  gateway event bus + session blacklist
└──────────┘     └──────────┘
```

| Service | Image / build | Exposed | Role |
|---|---|---|---|
| `proxy` | `ops/Dockerfile.web` (Caddy + baked SPA) | host 80/443 (or 5550/5551) | TLS, reverse proxy, static SPA host |
| `api` | `ops/Dockerfile.api` (Node 20 + tsx) | no | REST API + WebSocket gateway |
| `db` | `postgres:16-alpine` | no | Primary data store |
| `cache` | `redis:7-alpine` | no | Cross-replica gateway bus + session-revocation blacklist |
| `livekit` | `livekit/livekit-server` | host network | WebRTC SFU for voice/video |

- `db`, `cache`, and `livekit` are stock images — never built, never modified.
- `livekit` runs with **host networking** so WebRTC media (UDP 7882, TCP 7881
  fallback) can reach it; the API talks to its admin API at
  `host.docker.internal:7880`. Setting `LIVEKIT_WS_URL` points the stack at
  **LiveKit Cloud** instead of the bundled SFU.
- Attachments live on a host-mounted `uploads` volume shared between `api`
  (writes) and `proxy` (serves `/cdn/*` directly off disk, API fallback for
  misses).

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| API runtime | Node 20 + `tsx` | No bundling step — `tsx` runs the TS directly; sidesteps workspace-symlink + migrations-folder fragility |
| HTTP / WS | [Hono](https://hono.dev) | REST routers + a `ws`-based WebSocket gateway |
| DB | PostgreSQL 16 | Full-text search, JSON, real relational integrity |
| ORM | [Drizzle](https://orm.drizzle.team) | SQL-first; migrations auto-applied on boot |
| Cache / fanout | Redis 7 (`ioredis`) | Gateway pub/sub bus + shared session blacklist (both fail-soft) |
| Realtime media | [LiveKit](https://livekit.io) | SFU; server SDK mints join tokens, client SDKs publish/subscribe |
| Auth | JWT (`jose`, HS256) + `scrypt` | Access + rotating refresh tokens; 2FA via TOTP |
| Validation | Zod | Schemas shared between client and server via `@zekktris/shared` |
| Email | `nodemailer` (SMTP) | Verification, password reset, email-change |
| Push | `web-push` (VAPID) + APNs | Web push and native iOS push |
| Images | `sharp` | Dimension extraction, WebP recompression, decompression-bomb guard |
| Reverse proxy | Caddy | Auto-TLS, single TLS provisioning point |
| Web client | React 18 + Vite + Tailwind | `react-router`, `use-context-selector` state, `livekit-client`, `tweetnacl-util` |
| iOS client | Native SwiftUI | URLSession + URLSessionWebSocketTask + LiveKit Swift SDK |
| Desktop client | Electron | Thin shell over the web app |
| Monorepo | pnpm workspaces + Turborepo | |

The web client deliberately uses **no heavy state library** — state is a single
reducer (`apps/web/src/state/AppState.tsx`) exposed through
`use-context-selector` so components subscribe to narrow slices. Markdown is
rendered by a small in-house parser (no `react-markdown`), and there is no tRPC
— the API is plain REST plus the gateway.

---

## 3. Monorepo layout

```
apps/
  api/   src/{routes,services,gateway,auth,lib}/, db.ts, env.ts, index.ts
  web/   src/{app,state,auth,lib}/
packages/
  db/      Drizzle schema (src/schema/*.ts) + SQL migrations + journal
  client/  @zekktris/client — typed REST + gateway clients (no React)
  shared/  permissions, snowflakes, gateway event names, constants
  tsconfig/
ios-native/  native SwiftUI app (own README + xcodegen project)
desktop/     Electron shell
ops/         Dockerfile.api, Dockerfile.web, Caddyfile
scripts/     setup.sh, generate-secrets.sh
```

`apps/api/src/routes/` holds the HTTP routers; `apps/api/src/services/` holds
the business logic each router calls (one service per domain: messages, voice,
dms, supervision, automod, bots, events, …). The gateway dispatch layer
(`apps/api/src/gateway/`) is the only thing that talks to live connections;
services emit events through `dispatch.*`, never to sockets directly.

---

## 4. Data model

IDs are 64-bit **Snowflakes**: `[42-bit ms-since-2024-epoch][10-bit worker][12-bit
sequence]` — chronologically sortable without a separate `created_at` index,
1024 workers × 4096 IDs/ms. Generated in `packages/shared/src/snowflake.ts`;
each API process gets a `WORKER_ID`.

The schema (`packages/db/src/schema/`) spans **~55 tables / 75 migrations**
across these domains:

- **Identity & auth** — users, sessions, signup_codes, password_resets,
  email_verifications, email_change_requests, user_recovery_codes (2FA),
  apns_device_tokens, push_subscriptions.
- **Guilds** — guilds, guild_members, roles, member_roles,
  permission_overrides, channels (text/category/voice/stage/DM/group-DM),
  invites, bans, audit_log_entries, webhooks.
- **Messaging** — messages, attachments, reactions, message_user_mentions,
  message_role_mentions, read_states, saved_messages, scheduled_messages,
  pins (on messages), polls/poll_options/poll_votes.
- **DMs & social** — dm_recipients, dm_settings, dm_streaks, relationships
  (friends + blocks).
- **Voice** — voice_states, stage_participants.
- **Community** — guild_emojis, stickers, scheduled_events, event_rsvps,
  reaction_roles, achievements (+ streaks), discovery.
- **Safety & family** — security_config, security_events,
  security_banned_words, automod_rules, reports, flagged_messages,
  parent_child_links, child_restrictions, child_blocked_guilds,
  child_watch_words, child_requests, notification_overrides.
- **Platform** — bots/bot_commands, instance_settings.

Sensitive fields (TOTP secrets, bot tokens) are encrypted at rest with an
envelope keyed by `FIELD_ENCRYPTION_KEY` (with `FIELD_ENCRYPTION_KEYS_OLD` for
rotation). Migrations are forward-only and applied automatically at boot — back
up before updating.

---

## 5. Permissions model

Discord's model: a **bitfield** stored as `bigint`. The full set is defined in
`packages/shared/src/permissions.ts` (34 permissions, including voice ones):

```
ADMINISTRATOR VIEW_CHANNEL READ_MESSAGE_HISTORY SEND_MESSAGES MANAGE_MESSAGES
ATTACH_FILES EMBED_LINKS ADD_REACTIONS USE_EXTERNAL_EMOJIS MENTION_EVERYONE
MANAGE_CHANNELS CREATE_INVITE MANAGE_ROLES KICK_MEMBERS BAN_MEMBERS
CHANGE_NICKNAME MANAGE_NICKNAMES MODERATE_MEMBERS MANAGE_GUILD VIEW_AUDIT_LOG
MANAGE_WEBHOOKS MANAGE_EMOJIS MANAGE_INVITES CONNECT SPEAK MUTE_MEMBERS
DEAFEN_MEMBERS MOVE_MEMBERS USE_VAD PRIORITY_SPEAKER STREAM
USE_EMBEDDED_ACTIVITIES MANAGE_EVENTS MANAGE_THREADS
```

Per-channel, per-member resolution:

```
1. guild owner               → ALL_PERMISSIONS, stop
2. base = @everyone role permissions
3. base |= each of the member's roles' permissions
4. base contains ADMINISTRATOR → ALL_PERMISSIONS, stop
5. apply @everyone channel override   (deny then allow)
6. fold + apply all role overrides    (deny then allow)
7. apply member-specific override     (deny then allow)
```

The algorithm lives in `@zekktris/shared` so the web client can mirror it for
UI gating (greying out buttons), while the API (`apps/api/src/services/
permissions.ts`) is the enforced source of truth and re-checks every action.
Role hierarchy (you must be *above* a target to manage it) is enforced
separately. The convention `@everyone role id === guild id` gives O(1) lookup.

---

## 6. Realtime gateway

A single WebSocket endpoint at `/gateway`. After upgrade, the client `IDENTIFY`s
with its access token; the server replies `READY` with a session snapshot
(guilds, DM channels, read states, voice states). Frames are JSON
`{ op, t?, d, s? }`:

| Op | Name | Direction |
|---|---|---|
| 0 | DISPATCH | server → client |
| 1 | HEARTBEAT | client → server |
| 2 | IDENTIFY | client → server |
| 3 | PRESENCE_UPDATE | client → server |
| 4 | RESUME | client → server |
| 6 | INVALID_SESSION | server → client |
| 7 | HELLO | server → client |
| 8 | HEARTBEAT_ACK | server → client |

- **Sequence + RESUME.** Every `DISPATCH` carries a monotonic per-session `s`.
  Each session keeps a bounded ring buffer of the frames it was sent (already
  permission-filtered). On reconnect the client sends
  `RESUME {token, session_id, seq}` and the server replays everything after
  `seq` in order; if the gap is too large or the session is unknown it answers
  `INVALID_SESSION{resumable:false}` and the client does a fresh IDENTIFY.
- **Multi-device presence.** A user's chosen status (`users.chosen_status`,
  set by `PATCH /users/@me {status}`) is kept apart from the effective one
  everyone sees (`users.status`). Each connection reports its device's
  activity — `presence: {active}` in IDENTIFY/RESUME, then op 3
  `PRESENCE_UPDATE {active}` on each change (READY advertises
  `features.presence_activity`) — and the server recomputes: offline with no
  connection, the chosen dnd / idle / invisible as is, and chosen online reads
  online if any device is in use, else idle. A client that never reports
  counts as in use. `PRESENCE_UPDATE` dispatches also reach the user's own
  devices, whose frame alone carries `chosen_status`. Across replicas the per-replica summaries meet in Redis (see
  `docs/SHARDING.md`). Code: `apps/api/src/gateway/presence.ts`.
- **Permission-filtered fanout.** Each connection caches its viewable-channel
  set (computed once at IDENTIFY). Channel-scoped events are filtered against
  it; the cache is refreshed live on any visibility-changing mutation, and
  newly-visible / newly-hidden channels emit `CHANNEL_CREATE` / `CHANNEL_DELETE`
  to the affected connection — no reconnect needed, no leak of private-channel
  names/messages/existence.
- **Multi-node fanout.** Services publish events to an in-process event bus. When
  `REDIS_URL` is set the bus is swapped for a Redis pub/sub backend on a single
  channel — every API replica sees every event and applies its own audience
  filter. This is what lets you run more than one `api` replica. The RESUME ring
  buffer is per-process, so multi-replica deployments need **sticky sessions**
  on the gateway (a reconnect must land on the same replica, else it falls back
  to IDENTIFY).

Events cover messages, reactions, channels, guilds, members, roles, bans,
typing, presence, voice/stage state, DM read receipts, polls, threads, and
relationships.

---

## 7. Auth model

- **Access token** — JWT (HS256, `jose`), 15 min default
  (`ACCESS_TOKEN_TTL_SECONDS`), carries `{ userId, sessionId }`, sent as
  `Authorization: Bearer`.
- **Refresh token** — opaque random string, stored **hashed** in `sessions`,
  delivered in an httpOnly/SameSite cookie, 30 day default. `/auth/refresh`
  validates and **rotates** it (new hash written).
- **Passwords** — `scrypt` (Node crypto) with per-user salt and
  `timingSafeEqual` comparison; min 8 chars.
- **Prompt revocation** — logout/ban/password-reset write to a session
  blacklist (Redis-backed when `REDIS_URL` is set, in-memory otherwise) that the
  auth middleware checks, so a revoked session stops working without waiting for
  the access token to expire. Both the blacklist read and Redis itself fail
  open/soft so an outage degrades rather than locks everyone out.
- **2FA** — optional TOTP with encrypted secret + single-use recovery codes.
- **Registration** — `ALLOW_REGISTRATION` = `open` | `invite-only` | `closed`;
  invite-only requires an admin-issued signup code. Email verification,
  password reset, and email-change all run over SMTP when configured.

---

## 8. End-to-end encryption

**DMs** can be end-to-end encrypted. The model is a shared passphrase, not a
key-exchange:

- Algorithm: **PBKDF2-SHA-256 (250 000 iterations, 32-byte output)** over a
  server-stored 16-byte salt → a 256-bit key → **AES-256-GCM** with a fresh
  12-byte IV per message. Wire format `zkE2EE/3:<base64(iv || ciphertext||tag)>`.
- The server stores only the **salt** and a **verifier** (SHA-256 of the derived
  key) — never the passphrase or plaintext. Each device/participant enters the
  passphrase once and re-derives the identical key locally; there is no
  automatic cross-device key sync (the correct E2EE property). Cached keys are
  re-checked against the channel's current verifier on every use, so a re-key
  drops stale keys and re-prompts.
- The web (`apps/web/src/lib/e2ee.ts`) and native (`E2EE.swift`) implementations
  are byte-compatible. Disabling E2EE requires the verifier (you can't purge
  encrypted history without proving you hold the key).

**Calls** in an unlocked E2EE DM use LiveKit's media E2EE, keyed from the same
DM key (the base64 of the 32-byte key fed through LiveKit's shared-key
provider). Both web and native derive the LiveKit key identically, so calls
interoperate in all directions. The unlock verifier guarantees both sides hold
matching keys before a call starts.

Encrypted channels are excluded from server-side search and AutoMod (the server
only ever sees ciphertext).

---

## 9. Voice & video

Voice channels, 1:1 DM calls, and stage channels run on **LiveKit**. The API
mints scoped join tokens (`livekit-server-sdk`); clients connect with the
LiveKit web/Swift SDK to publish mic/camera/screen and subscribe to others. A
`voice_states` table is the source of truth for who's where, fanned out as
`VOICE_STATE_UPDATE` / `STAGE_PARTICIPANTS_UPDATE`. A 45-second grace period
keeps a user "in" voice across brief reconnects (mobile WS suspension) without
double-evicting. Permission loss or eviction removes the user and re-broadcasts
the roster.

---

## 10. File uploads & CDN

`multipart/form-data` uploads validate size/MIME, write to
`${UPLOAD_DIR}/…/<snowflake>-<name>`, and return `{ id, url, size, contentType }`.
Images get `width`/`height` extracted via `sharp` (with a decompression-bomb
pixel cap) and are recompressed to WebP. Files are public-read by URL (the
URL contains a non-guessable snowflake; channel access is gated by *not handing
out the URL*) — Discord's model. Caddy serves `/cdn/*` straight off the shared
`uploads` volume, falling back to the API for misses.

Configurable limits: `MAX_UPLOAD_SIZE_MB` (default 100), `MAX_FILES_PER_MESSAGE`.

---

## 11. Clients

- **Web** (`apps/web`) — React 18 + Vite + Tailwind SPA; the primary, most
  complete client. Four-column shell (guild rail → channel list → message view →
  member list), consuming the REST API + gateway through `@zekktris/client`.
- **Native iOS** (`ios-native`) — a from-scratch SwiftUI app (not a web wrapper)
  hitting the same API + gateway, with LiveKit voice, E2EE DMs/calls, threads,
  polls, search, push (APNs), and CallKit/PushKit call UI. See its README.
- **Desktop** (`desktop`) — an Electron thin shell that loads the live web app
  and adds tray, close-to-tray, start-on-login, unread badges, zoom, and
  auto-updates.

The web app also carries an optional Capacitor bridge layer (`src/lib/native.ts`)
for running inside a native wrapper, but the supported, first-class mobile
client is the native SwiftUI app.

---

## 12. Deployment & operations

`docker-compose.yml` defines the five services; `scripts/setup.sh` is the
one-command bootstrap (secrets → build → up → wait healthy). Configuration is
all environment (`.env`), validated by `apps/api/src/env.ts` at startup. Caddy
decides TLS from `PUBLIC_URL` (a real domain → Let's Encrypt; `http://…` →
plaintext for LAN).

On boot the API runs a series of **startup checks** (environment, snowflake,
password hashing, JWT, DB connection, migrations, schema, upload dir, Redis,
LiveKit config, gateway, …) and only binds the HTTP port once they pass —
operators see them tick green in `docker compose logs -f api`. Migrations are
one of those checks: a fresh DB is created in ~150 ms, and subsequent boots are
a no-op verified against Drizzle's `__drizzle_migrations` table.

Stateful data is the Postgres volume and the uploads volume under
`APPDATA_PATH`; everything else rebuilds from the repo. See the README for TLS,
unraid, LiveKit/UDP-7882, backup, and multi-node specifics.

---

## 13. Development

```bash
pnpm install
./scripts/generate-secrets.sh          # writes .env (set APPDATA_PATH=./data for local)
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=zekktris \
  --name zekktris-dev-db postgres:16-alpine
pnpm db:migrate
pnpm --filter @zekktris/api dev         # http://localhost:3000
pnpm --filter @zekktris/web dev         # http://localhost:5173 (proxies /api + /gateway)
```

`pnpm typecheck` · `pnpm test` (Vitest; integration tests need a reachable
Postgres) · `pnpm build` run across the workspace via Turborepo. Redis and
LiveKit are optional in dev — without `REDIS_URL` the gateway uses an in-process
bus; without LiveKit creds, voice is simply unavailable.
