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

All your data lives in one folder on the host (`APPDATA_PATH`), and
`./scripts/backup.sh` turns it into a single restorable bundle (§7).

---

## Prerequisites

- A Linux server with **Docker** and the **Docker Compose v2** plugin:
  ```bash
  docker --version && docker compose version
  ```
  If missing, install it from your distribution's packages or
  [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).
  (`./install.sh` can also run Docker's convenience script for you, but only
  if you say yes — it runs a downloaded script as root.)
- **openssl** (almost always preinstalled): `command -v openssl`
- Optional but recommended: a **domain name** (e.g. `chat.example.com`) with a
  DNS **A record** pointing at the server's public IP, and ports **80** + **443**
  open. You need this for real HTTPS.

---

## 1. Get the code onto the server

```bash
git clone https://github.com/Eternus-Nox/zekktris.git
cd zekktris
```

(A git checkout is what `./scripts/update.sh` updates later.)

---

## 2. First run (one command)

```bash
./install.sh            # or: --domain chat.example.com | --ip | --lan
```

The installer:
- asks how people will reach the server (a domain, just your public IP, or
  your home network only) and works out the network side (LAN address, public
  IP, carrier-grade NAT, UPnP port forwarding, ufw/firewalld),
- creates `.env` from the template and **fills in fresh random secrets**
  (database password, JWT and field-encryption keys, LiveKit and Web-Push keys),
- creates the data folder (`APPDATA_PATH` — `<repo>/data` by default,
  `/mnt/user/appdata/zekktris` on Unraid),
- builds and starts the stack and waits for the API's health checks and HTTPS.

Re-running it never replaces your secrets; `--reconfigure` changes how the
server is reached. (`./scripts/setup.sh` still works — it runs the installer.)

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

`./install.sh --domain chat.example.com` does all of this. By hand, edit `.env`
and set these (Caddy will fetch a Let's Encrypt cert automatically):

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
>
> **Behind Cloudflare** (orange-cloud DNS or a Cloudflare Tunnel) also set
> `EDGE_PROXY=cloudflare` and run `docker compose up -d proxy`, or every visitor
> appears to come from Cloudflare/the tunnel, so per-IP rate limits and bans
> hit everyone at once. Leave it at the default `none` everywhere else: it is
> what stops visitors choosing their own address with a forged header. See
> `ops/caddy-modes/README`.

---

## 5. Optional features

Each is independent — skip any you don't want. After editing `.env`, apply with
`docker compose up -d api` (or `proxy` for the cert/port changes above).

### Voice & video

Voice/video is **bundled and self-hosted by default** — the `livekit` service
in `docker-compose.yml` comes up with the rest of the stack, so a standalone
instance hosts its own SFU with no external account.

- `install.sh` generates a `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` for you (and
  leaves `LIVEKIT_WS_URL` empty). If you fill `.env` by hand, set any key plus a
  32+ char secret — the api and the `livekit` container must share the same pair.
- **Signaling** rides your own origin: the api hands clients a same-origin
  `wss://<your host>/livekit` URL that Caddy reverse-proxies to the SFU, so it
  uses your existing host + TLS cert. No extra port to expose for signaling —
  the SFU's port 7880 listens only on 127.0.0.1 and the Docker bridge address
  Caddy and the api reach it through (`LIVEKIT_BIND_ADDRESSES` overrides it;
  see `ops/livekit-entrypoint.sh`).
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
- The bundled server image is pinned to an exact `v1.9.x` patch so it speaks
  the client's signaling protocol; change it deliberately with
  `LIVEKIT_IMAGE_TAG`.

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

The installer already generated `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` for
you, so push works out of the box. (Don't regenerate them once people have
subscribed — it invalidates their subscriptions.)

---

## 6. Updating

```bash
./scripts/update.sh --check   # what an update would bring (new migrations called out)
./scripts/update.sh           # back up, pull, rebuild, health-gate, roll back on failure
```

Migrations run automatically on API boot and are **not** undone by a rollback —
that is what the pre-update backup is for. Local edits to tracked files (an
`ops/livekit.yaml` interface filter, a compose tweak) are kept across the update
and a rollback; if the update itself changes one of those files, the script
stops before touching anything and tells you which.

---

## 7. Backups

```bash
./scripts/backup.sh               # full bundle: database, uploads, .env, secrets/
./scripts/backup.sh --no-uploads  # database + config only (seconds)
./scripts/restore.sh --check      # prove the newest bundle would restore
```

Bundles are written to `$APPDATA_PATH/backups/` — the folder **Admin → Backup &
Maintenance**, the admin's verify/restore buttons and `./scripts/doctor.sh` all
read. (Before this was unified, `backup.sh` wrote to `<repo>/backups/`; move any
bundles left there.) The admin page can also schedule a nightly database-only
and a weekly full backup once the host agent is installed
(`./scripts/doctor.sh --fix`). **Copy bundles off the machine** — a backup on the
disk that died is not a backup.

A bundle holds the whole database, `.env` (with the field-encryption keys) and
the APNs key: treat a copy of it as a copy of the server. Bundles are `0600`,
and `backups/`, `control/` and the `.env.*` copies are git- and docker-ignored.

To move to a new machine, set it up with `./install.sh`, copy the bundle over,
and run `./scripts/restore.sh --force <bundle>`. The restore applies the
bundle's `.env` (keeping this machine's `APPDATA_PATH`) **before** it starts the
database, sets the database password to the bundle's, and stops with an error
rather than reporting success on a half-restored instance.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Can register but never stay logged in | `COOKIE_SECURE` doesn't match `PUBLIC_URL` scheme. https→true, http→false. |
| HTTPS cert never issues | DNS A record not pointing here, or ports 80/443 closed. `docker compose logs proxy`. |
| API won't start | Check `docker compose logs api` — usually a bad `.env` value (e.g. equal JWT secrets, or a missing required var). |
| Voice channels say "audio not configured" | LiveKit not set — see §5. |
| Password reset says email isn't enabled | SMTP not configured — see §5. |
| No admin account | `docker compose exec -w /app/apps/api api node --import tsx/esm scripts/create-admin.ts --email you@example.com` (see §3). |
| Everyone shares one IP in the sessions list / rate limits hit everyone | Behind Cloudflare without `EDGE_PROXY=cloudflare` — see §4. |
| `docker compose up -d` says `container zekktris-api is unhealthy` after an update or restore | The api's one-time handover of `uploads/` is still running (§9). Wait for `api-entrypoint: handed …` in `docker compose logs api` and for the api to show `healthy` in `docker compose ps`, then run `docker compose up -d` again. |

Useful commands:

```bash
./scripts/doctor.sh               # health check; --fix repairs what it safely can
docker compose ps                 # what's running
docker compose logs -f api        # follow the server log
docker compose restart api        # restart just the API
docker compose down               # stop everything (data persists)
```

---

## 9. Security notes for operators

- **The api runs as an unprivileged user** (`node`, uid 1000). On the first
  boot after updating, its entrypoint hands `uploads/` and `control/requests/`
  (written by root until then) to that user before the api starts — on a large
  uploads folder that pass takes a while, and restoring a bundle taken before
  this change brings it back once. `update.sh`, `restore.sh` and `install.sh`
  start the api on its own first, wait for the pass (up to an hour), and only
  then start the proxy and the rest. But the update that first brings this in
  still runs the previous `update.sh`, and a plain `docker compose up -d` does
  not wait: once the pass outlasts the api's health check (about two minutes)
  it stops with `dependency failed to start: container zekktris-api is
  unhealthy`, leaving the site down. The pass carries on regardless; wait for
  `api-entrypoint: handed /data/uploads to 'node'` in `docker compose logs api`
  and for `docker compose ps` to show the api `healthy` (up to half a minute
  later), then run `docker compose up -d` again. With many gigabytes of
  uploads, run `sudo chown -R 1000:1000 <APPDATA_PATH>/uploads` on the host
  before that update instead. If the entrypoint cannot hand them over (an NFS
  export with root_squash, say) the api keeps running as root and says so in
  `docker compose logs api`.
  `control/` itself and `control/status/` stay root's, because the root-run
  `scripts/agent.sh` writes there; the agent refuses to run if they are not. A
  host account that also has uid 1000 can write to `uploads/` and
  `control/requests/`. Caddy keeps running as root (it owns the certificate
  store from earlier installs); Postgres and Redis drop privileges inside
  their official images.
- **Client IPs** are only taken from a proxy when you say one is in front
  (`EDGE_PROXY`, §4).
- **Webhook tokens** are masked in Caddy's logs (`/api/webhooks/<id>/REDACTED`).
- **LiveKit Cloud credential in the git history.** Early versions of the setup
  script committed a LiveKit Cloud API key/secret pair (key id
  `APIAMD7Sj5psuK4`). This repository is public, so that pair must be treated
  as known to everyone. Zekktris refuses to start with it and `install.sh`
  replaces it, but **that does not revoke it**: whoever owns that LiveKit Cloud
  project must delete that key on the project's API-keys page in the LiveKit
  Cloud dashboard. Until then anyone can mint tokens for that project's
  rooms. Self-hosters who never used LiveKit Cloud have nothing to do.

That's it — a single host, one command to start, and one bundle to back up.
