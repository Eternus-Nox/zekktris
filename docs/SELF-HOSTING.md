# Self-Hosting Zekktris

A complete, copy-paste guide to running your own Zekktris instance with Docker
Compose. The whole stack — web app, API, database, cache, and (optionally)
voice — comes up with one command.

---

## What you're running

One `docker compose` stack:

| Service | What it is |
| --- | --- |
| `proxy` | Caddy — serves the web app + API, and gets HTTPS automatically |
| `api` | the Zekktris server (REST + realtime gateway) |
| `db` | Postgres 16 |
| `cache` | Redis 7 |
| `livekit` | voice/video SFU (bundled, on by default) |

All your data lives in one folder on the host (`APPDATA_PATH`), so backups are
just that folder.

---

## Prerequisites

- A Linux server with **Docker** and the **Docker Compose v2** plugin:
  ```bash
  docker --version && docker compose version
  ```
  If missing, install Docker's convenience script:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```
- **openssl** (almost always preinstalled): `command -v openssl`
- Optional but recommended: a **domain name** (e.g. `chat.example.com`) with a
  DNS **A record** pointing at the server's public IP, and ports **80** + **443**
  open. You need this for real HTTPS.

---

## 1. Get the code onto the server

Copy the release zip (e.g. `zekktris-v2_87.zip`) to your server and unzip it:

```bash
unzip zekktris-v2_87.zip
cd zekktris
```

---

## 2. First run (one command)

```bash
./scripts/setup.sh
```

This script:
- creates `.env` from the template and **fills in fresh random secrets**
  (database password, JWT keys, and the Web-Push keys),
- makes sure the data directory exists,
- runs `docker compose up -d`,
- waits for the API's health checks and prints the URL.

When it finishes you'll have a working instance on **http://SERVER-IP:5550**.
Open it, register an account, and you're in.

> By default the data folder is the unraid path `/mnt/user/appdata/zekktris`.
> On a normal server, set `APPDATA_PATH` in `.env` to something like
> `/opt/zekktris-data` (or `./data`) **before** the first `up`, then run
> `./scripts/setup.sh` again.

---

## 3. Make yourself the admin

(`./install.sh` does this for you — it asks for the admin email and password.)

Create the admin account from the server itself:

```bash
docker compose exec -w /app/apps/api api \
  node --import tsx/esm scripts/create-admin.ts --email you@example.com
```

It asks for the password twice (hidden; nothing lands in your shell history)
and creates the account already verified and admin. To pipe the password in
instead, add `-T` and send it on stdin. If an account with that email already
exists — say you registered in the app first — it's made admin and its
password is left alone (press Enter at the prompt). Registration may already
be open, though, so an existing account is only promoted if its address is
verified (`--promote-unverified` overrides that, if you're sure it's yours),
and `--create-only` refuses an existing account outright — the installer uses
that on a fresh install, so someone who registers your address first stops
the install instead of becoming admin. `--check` just reports whether the
server has an admin. Re-running `./install.sh` on a server with no admin asks
for one again.

The older alternative is `BOOTSTRAP_ADMIN_EMAIL=you@example.com` in `.env`:
while no admin exists, an account with that address is promoted once the
address is **verified** (at boot, at signup, or when the emailed link is
clicked). Without SMTP every signup counts as verified, so on a server with
open registration whoever registers that address first becomes admin — use
the command above there.

---

## 4. Put it on your domain with HTTPS

Edit `.env` and set these four (Caddy will fetch a Let's Encrypt cert
automatically):

```
PUBLIC_URL=https://chat.example.com
SITE_ADDRESS=https://chat.example.com
HTTP_PORT=80
HTTPS_PORT=443
COOKIE_SECURE=true
# optional, helps with cert-renewal notices:
ACME_EMAIL=you@example.com
```

Then make sure your DNS A record points at the server and ports 80 + 443 are
open, and apply:

```bash
docker compose up -d proxy
```

Visit `https://chat.example.com`. The cert is issued on first request (give it
a few seconds).

> **The one gotcha:** `COOKIE_SECURE` must match your scheme. `https://` →
> `true`; `http://` → `false`. A mismatch makes login *silently* fail (the
> browser drops the auth cookie). If you can register but never stay logged in,
> this is why.
>
> Behind an edge proxy that already does TLS (Cloudflare Tunnel, nginx, …)?
> Leave `SITE_ADDRESS=:5550` and point the edge proxy at `SERVER-IP:5550`; still
> set `PUBLIC_URL=https://…` and `COOKIE_SECURE=true`.

---

## 5. Optional features

Each is independent — skip any you don't want. After editing `.env`, apply with
`docker compose up -d api` (or `proxy` for the cert/port changes above).

### Voice & video

Voice/video is **bundled and self-hosted by default** — the `livekit` service
in `docker-compose.yml` comes up with the rest of the stack, so a standalone
instance hosts its own SFU with no external account.

- `setup.sh` generates a `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` for you (and
  leaves `LIVEKIT_WS_URL` empty). If you fill `.env` by hand, set any key plus a
  32+ char secret — the api and the `livekit` container must share the same pair.
- **Signaling** rides your own origin: the api hands clients a same-origin
  `wss://<your host>/livekit` URL that Caddy reverse-proxies to the SFU, so it
  uses your existing host + TLS cert. No extra port to expose for signaling.
- **Host networking is required.** The SFU runs with `network_mode: host` so it
  can advertise the host's real LAN IP as an ICE candidate. On the default
  Docker bridge it would only see its bridge IP (e.g. `192.168.144.2`) and
  advertise that — an address no browser can reach, so every candidate pair
  fails and voice loops on "negotiation timed out". This is LiveKit's
  documented Docker setup.
- **Media** is WebRTC over **UDP 7882** (primary) + **TCP 7881** (fallback);
  with host networking the SFU binds these directly on the host. Same-LAN
  clients connect automatically via the host LAN IP. For clients off the LAN,
  open/forward UDP 7882 + TCP 7881 in the firewall/router.
- **Advertised IP**: host networking gives the LAN-IP candidate for free.
  `LIVEKIT_USE_EXTERNAL_IP=true` (default) also STUN-discovers the public IP
  for remote clients. Pin a single address only if STUN misbehaves: set
  `LIVEKIT_HOST` to a reachable IP **and** `LIVEKIT_USE_EXTERNAL_IP=false`.
- Because the SFU is on host networking it isn't reachable as `livekit` from
  the bridge; the api and Caddy reach it via `host.docker.internal` (declared
  under `extra_hosts`). This needs Docker 20.10+ (unraid has it). To confirm
  what the SFU advertised, check `docker logs zekktris-livekit` at startup.
- The bundled server image tracks the `v1.9` line so it speaks the client's
  signaling protocol; override with `LIVEKIT_IMAGE_TAG` to pin a patch.

Prefer a managed SFU? Set `LIVEKIT_WS_URL=wss://<project>.livekit.cloud` plus
its `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`; the bundled container then goes
unused (you can stop it).

If LiveKit keys are blank, the app still runs — voice channels just show "audio
not configured".

### Email (password resets & verification)

Point at any SMTP relay (Resend, Brevo, SendGrid, etc.):

```
SMTP_HOST=smtp.resend.com
SMTP_USER=resend
SMTP_PASS=your-api-key
SMTP_FROM=Zekktris <noreply@example.com>
```

Without SMTP, password-reset just returns a "email isn't enabled" message —
everything else works.

### Push notifications

The setup script already generated `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` for
you, so push works out of the box. (Don't regenerate them once people have
subscribed — it invalidates their subscriptions.)

### Federation (let others host guilds on your instance)

Turn your instance into a **backbone** that other operators can attach guild
nodes to:

```
FEDERATION_ENABLED=true
```
plus a signing key — generate one with:
```bash
openssl genpkey -algorithm ed25519 -outform DER 2>/dev/null | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='
```
```
FEDERATION_SIGNING_KEY=<the value above>
```
Apply with `docker compose up -d api`, then verify:
```bash
curl -s https://chat.example.com/api/v1/federation/info   # → "enabled": true
```
Enroll and moderate nodes from **admin → Federation**. To hand someone a ready
node deployment, see the node hosting bundle (`node-host/` / `scripts/package-node.sh`).

---

## 6. Updating

```bash
# unzip the new release over the same folder (your .env + data are untouched),
# then:
docker compose build && docker compose up -d
```

Migrations run automatically on API boot.

---

## 7. Backups

Everything is under `APPDATA_PATH`:

```bash
# stop, copy the data folder, restart
docker compose down
tar czf zekktris-backup-$(date +%F).tar.gz -C "$(grep '^APPDATA_PATH=' .env | cut -d= -f2-)" .
docker compose up -d
```

Back up `.env` too — it holds your secrets. Restoring is the reverse: drop the
folder back and `docker compose up -d`.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Can register but never stay logged in | `COOKIE_SECURE` doesn't match `PUBLIC_URL` scheme. https→true, http→false. |
| HTTPS cert never issues | DNS A record not pointing here, or ports 80/443 closed. `docker compose logs proxy`. |
| API won't start | Check `docker compose logs api` — usually a bad `.env` value (e.g. equal JWT secrets, or a missing required var). |
| Voice channels say "audio not configured" | LiveKit not set — see §5. |
| Password reset says email isn't enabled | SMTP not configured — see §5. |
| Federation tab 503s | `FEDERATION_ENABLED=true` **and** a valid `FEDERATION_SIGNING_KEY` both required — see §5. |
| No admin account | `docker compose exec -w /app/apps/api api node --import tsx/esm scripts/create-admin.ts --email you@example.com` (see §3). |

Useful commands:

```bash
docker compose ps                 # what's running
docker compose logs -f api        # follow the server log
docker compose restart api        # restart just the API
docker compose down               # stop everything (data persists)
```

That's it — a single host, one command to start, and one folder to back up.
