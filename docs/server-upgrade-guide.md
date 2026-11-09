# Upgrading zekktris.com from the September/October 2026 release

A step-by-step runbook for moving an older zekktris.com server (anything from the root commit 91ec76a, 2026-09-14, up to 7a70f90, 2026-10-05) onto the current release, so the site is back online the moment the new containers start. It was written for the owner, who is guided through it one step at a time; each step gives the exact commands, what you should see, and what to do if you see something else.

Ground rules:

- Run everything on the server, as root over ssh (Unraid has no sudo), inside `tmux` so a dropped connection does not kill a running step.
- Never paste `.env`, a backup, or unmasked `git remote -v` output anywhere: they hold every secret. The commands here print key names, prefixes or counts only.
- Do not run the old `./scripts/update.sh`, `install.sh`, `setup.sh`, or the admin panel's Update/Restart buttons for this upgrade.
- Stop and ask whenever a step says STOP, or the output does not match what is described.

## Part 1 — Which version and install type is this server?

### I1. Open the terminal and set it up (do this in EVERY new terminal, before any other command in this guide)

```
ssh root@<server>   (typed on your own computer; Unraid has no sudo, you are root)
```

```
tmux new -A -s zk
```

```
D="$(docker inspect zekktris-api --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null)"; if [ -n "$D" ]; then cd "$D" && pwd; else echo NOT-STARTED-BY-COMPOSE; fi
```

```
if docker compose version >/dev/null 2>&1; then DC="docker compose"; elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"; else DC=""; fi; echo "DC=[$DC]"
```

```
UP="$(docker inspect zekktris-api --format '{{range .Mounts}}{{if eq .Destination "/data/uploads"}}{{.Source}}{{end}}{{end}}')"; CTL="$(docker inspect zekktris-api --format '{{range .Mounts}}{{if eq .Destination "/data/control"}}{{.Source}}{{end}}{{end}}')"; DB="$(docker inspect zekktris-db --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')"; PRE="$(dirname "$PWD")/zekktris-predeploy"; mkdir -p "$PRE/tmp" && chmod 700 "$PRE"; printf 'UP=%s\nCTL=%s\nDB=%s\nPRE=%s\n' "$UP" "$CTL" "$DB" "$PRE"
```

**How to read it:** tmux keeps the session alive if the browser tab or ssh drops (reattach later with: tmux new -A -s zk). If tmux is missing, stay in plain ssh and keep that window open. The cd command prints the folder the running stack was started from, for example /mnt/user/appdata/zekktris. Write it down: if zekktris-api is ever missing, type cd <that folder> instead. NOT-STARTED-BY-COMPOSE (no container, or one not created by docker compose) = STOP and ask. Bash's cd "" would silently stay where you are, which is why the check is there. DC=[docker compose] is what you want. DC=[docker-compose] (the old v1) or DC=[] = STOP and ask, because the repo's backup and update scripts need Compose v2. The last command prints four paths, for example UP=/mnt/user/appdata/zekktris/uploads, CTL=/mnt/user/appdata/zekktris/control, DB=/mnt/user/appdata/zekktris/db, PRE=/mnt/user/appdata/zekktris-predeploy. Any empty value = STOP and ask. PRE is a private folder next to the Zekktris folder. It sits outside the backups/ folder, which gets pruned, and outside /tmp, which is RAM on Unraid. Every backup and temporary file in this guide goes there. The variables are lost when a terminal closes, so rerun I1 in each new terminal.

### I2. What the api is running right now: old or new release, and how many migrations the database has

```
docker inspect zekktris-api --format '{{json .Config.Entrypoint}}'
```

```
docker exec zekktris-db psql -U commune -d commune -tAc "SELECT count(*)||'|'||max(created_at) FROM drizzle.__drizzle_migrations"
```

**How to read it:** Entrypoint ["/sbin/tini","--"] = an OLD api (every version from 91ec76a to 7a70f90). ["/sbin/tini","--","/usr/local/bin/zekktris-api-entrypoint"] = the NEW api. For the ledger, read the number after the |. It must match exactly; the count before the | can be different on a database that was not built from migration 0000. 1784600330000 = Era 1a, early part (91ec76a…18bf0bf, Stripe billing live, 9 migrations will apply). 1784686730000 = Era 1a, late part (cc57340…774e20b, billing live, 8 migrations). 1784773130000 = Era 1b (444fc62…64ba63a, payments removed, no installer) or Era 3 (d5dfda1…7a70f90, installer), 7 migrations; I3 tells these apart. 1785377930000 = the new api has booted at least once. It is NOT proof that the new release is running: the new api applies migrations at check 6 of 13 and can still refuse at a later check, and a rollback keeps the migrations. With 1785377930000, a NEW entrypoint and edge-cloudflare.servers in I3, the update is already done: go to the after-update checks. With 1785377930000 and an OLD entrypoint, an earlier attempt was rolled back. Do the whole guide. The first boot will then find nothing left to apply ('applied/verified in' a few ms), although ./scripts/update.sh --check still lists 7–9 migration files, because it compares commits, not the database. Any other value = STOP and ask. 'role "commune" does not exist' = .env overrides DATABASE_URL: ask.

### I3. What the proxy is running (Era 1a/1b versus Era 3), and whether the 'End all billing' card exists

```
docker exec zekktris-proxy sh -c 'caddy version; ls /etc/caddy/modes 2>/dev/null'
```

```
docker exec zekktris-proxy sh -c 'grep -l "End all billing" /srv/web/assets/*.js 2>/dev/null | head -1'
```

**How to read it:** If no modes are listed, the proxy was built from pre-installer code (Era 1a or 1b), usually with a Caddy version other than v2.11.4. v2.11.4 plus README ip.global ip.site none.global none.site = Era 3. If edge-cloudflare.servers and edge-none.servers are also listed, the NEW proxy is already running. The second command prints a file name such as /srv/web/assets/index-….js when the admin 'End all billing, keep tiers' card exists (09d6070 and later). It prints nothing in Era 1a and at exactly 444fc62.

### I4. How the code arrives (install type A, B or C)

```
git -c safe.directory="$PWD" rev-parse --short HEAD
```

```
git -c safe.directory="$PWD" remote -v | sed -E 's#//[^/@]*@#//***@#'
```

**How to read it:** 'fatal: not a git repository' = type C (a release-zip folder; the old docs/SELF-HOSTING.md described this). A short sha and no remote lines = type B (this checkout receives pushes from a development machine; the old scripts/update.sh says zekktris.com was set up this way). A sha plus 'origin https://github.com/Eternus-Nox/zekktris… (fetch)' or 'origin git@github.com:Eternus-Nox/zekktris.git (fetch)' = type A. Any other remote = ask. The sed replaces any token in the URL with ***. Never paste unmasked 'git remote -v' output or .git/config anywhere. The '-c safe.directory' form gets past Unraid's 'dubious ownership' refusal without changing a setting.

### I5. Types A and B only: the exact old commit (dates cannot tell the eras apart; Era 1b and Era 3 commits are all dated 2026-10-02)

```
for c in 91ec76a cc57340 444fc62 09d6070 d5dfda1 45c7295 3ebe5fb; do if git -c safe.directory="$PWD" merge-base --is-ancestor $c HEAD 2>/dev/null; then echo "$c yes"; else echo "$c no"; fi; done
```

**How to read it:** 91ec76a no = this checkout does not share history with GitHub (it was cloned before the history squash), so a fast-forward is impossible: STOP and ask. cc57340 no = Era 1a, early (ledger 1784600330000). cc57340 yes and 444fc62 no = Era 1a, late (1784686730000). 444fc62 yes and d5dfda1 no = Era 1b (1784773130000); there, 09d6070 no means exactly 444fc62, with no billing card. d5dfda1 yes = Era 3 (1784773130000); there, 45c7295 no means d5dfda1/b031660, where SOURCE_CODE_URL was still ignored. The result must agree with I2 and I3. 3ebe5fb no with 45c7295 yes = Era 3, 45c7295…7a70f90 (the normal case, most likely 7a70f90). 3ebe5fb yes = the NEW code is already on disk: go to I6, then rerun this loop with "$OLD" in place of HEAD.

### I6. Is the new code already on disk while the old containers run?

```
ls scripts/lib/start-stack.sh 2>/dev/null && echo NEW-CODE-ON-DISK || echo OLD-CODE-ON-DISK
```

```
for s in api proxy; do printf '%s image-on-disk=%s running=%s\n' "$s" "$(docker image inspect zekktris-$s:latest --format '{{.Id}}' | cut -c8-19)" "$(docker inspect zekktris-$s --format '{{.Image}}' | cut -c8-19)"; done
```

```
git -c safe.directory="$PWD" reflog -12 --format='%h %gd %gs'
```

```
OLD=<the sha you picked>; git -c safe.directory="$PWD" merge-base --is-ancestor "$OLD" HEAD && echo OLD-IS-ANCESTOR; git -c safe.directory="$PWD" ls-tree --name-only "$OLD" packages/db/migrations/ | grep -c '\.sql$'
```

**How to read it:** OLD-CODE-ON-DISK with an old entrypoint in I2 is the normal case: skip the last two commands. Different image IDs in the second command only mean a newer image was built but never started. The running containers and I2 are the truth. NEW-CODE-ON-DISK with an OLD entrypoint: someone already pulled, merged, pushed or unzipped the new code. For types A and B, find the commit the running stack was built from. In the reflog, take the line just below the newest 'merge origin/master: Fast-forward', 'pull: Fast-forward', 'push' or 'reset' entry; git rev-parse ORIG_HEAD often names the same commit. Check it with the last command. You must see OLD-IS-ANCESTOR and a count of 124, 125 or 126 that matches I2 (124 = 1784600330000, 125 = 1784686730000, 126 = 1784773130000). Rerun I5 with "$OLD" in place of HEAD. Write OLD down: switchover steps A5/B3 use it instead of HEAD. Without it, the new update.sh finds HEAD = origin/master, prints '✓ already up to date' and does nothing, and the rollback would point at the new commit. Type C with new code already on disk = STOP and ask: the old code is gone, so no code rollback is possible without the old release file. NEW-CODE-ON-DISK with a NEW entrypoint = already updated (see I2). OLD-CODE-ON-DISK with a NEW entrypoint = STOP and ask. Do not judge the version by /health's 'version' field: it reads 'unknown' in every version.

### I7. Type C only: which release the files are, and whether anyone hand-edited them

```
md5sum docker-compose.yml ops/Caddyfile ops/Dockerfile.web ops/Dockerfile.api ops/livekit.yaml
```

**How to read it:** Compare each line with this table (computed from the repository). docker-compose.yml: e75d092a6c40b1cbb405947e9ab955d1 = Era 1a/1b (91ec76a…64ba63a); f7efff94bf5147e5bcf5cc648be80a50 = d5dfda1/b031660; a80f75bff93c1cbe9f3cae73e1d1c348 = 45c7295…7a70f90; 96c08b65c165fd46002782ab4647029e = the NEW release (already on disk: STOP, see I6). ops/Caddyfile: 86306d7cf5892a7172a2c3b186f7b222 = Era 1a/1b; 9cd18fbeef8aa52ccffd9cf7d9fab564 = Era 3; 935278df67a5c9e298a508a4779a5faa = new. ops/Dockerfile.web: ddce0757560825450e0316702c81bea6 = Era 1a/1b; b7ee5a57c89a144d7a76504cf60ac944 = Era 3 or new. ops/Dockerfile.api: d544dc3791ff74fbd97aad0733b4fd2c = every old era; 2879baa8816eb3c4af382b848b7ca6e0 = new. ops/livekit.yaml: e271e735ebf7af8093ad8293390a79ab = unedited (any other value is your own edit; that is allowed and switchover step C7 keeps it). A value in none of these lists means a hand edit, which the copy in step C7 would silently remove (a cloudflared service, an extra network, a changed port). STOP and ask, and keep that file.

### I8. What differs by era: only these things

**How to read it:** (a) Stripe order. Era 1a, and Era 1b at exactly 444fc62 (no card in I3): cancel NOTHING at Stripe before the update. Era 1b from 09d6070, and Era 3: the card can end billing before the update (checklist item 20). (b) The number of migrations applied at first boot: 9, 8 or 7. (c) Era 1a/1b .env files have never had TLS_MODE, PUBLIC_IP, SOURCE_CODE_URL or EDGE_PROXY; Era 3 files have TLS_MODE=none and PUBLIC_IP=, and may have SITE_ADDRESS=https://… with HTTP_PORT=80/HTTPS_PORT=443 if 'install.sh --domain' was used. (d) The proxy build moves from caddy:2-alpine to the pinned caddy:2.11.4-alpine in Era 1a/1b. The deploy mechanics are identical in every era. scripts/update.sh, agent.sh, doctor.sh, backup.sh, restore.sh and ops/Dockerfile.api are byte-identical from 91ec76a to 7a70f90, and that on-disk update.sh must never run this update (checklist item 15).

## Part 2 — Settings and checks before the update

Items marked **(blocks startup)** would stop the new release from starting, or take the site offline, if skipped.

### 1. Compose v2, the right Compose project, no hidden override, a clean .env, and a safety copy of it (blocks startup)

*Applies to:* All eras, all install types (run I1 first)

**Why:** The update must run in the same folder and Compose project that started today's containers. Otherwise Docker tries to create a second set with the same fixed names, refuses ('Conflict. The container name "/zekktris-api" is already in use'), and nothing new starts. An override file can switch off the new start-up behaviour; a 'user:' override, for example, skips the uploads handover. The repo's backup.sh and update.sh call 'docker compose ps --format', which only Compose v2 has: with only docker-compose v1 the backup fails and the update refuses to run. Every later item may edit .env, and the update never restores it (git does not track it), so a copy is the only undo.

```
docker inspect zekktris-api --format 'project={{ index .Config.Labels "com.docker.compose.project" }} files={{ index .Config.Labels "com.docker.compose.project.config_files" }} user=[{{ .Config.User }}]'
```

```
echo "DC=[$DC]"; $DC version; $DC ps db --format '{{.State}}'; $DC ps --format '{{.Name}}' | sort | tr '\n' ' '; echo
```

```
ls -la docker-compose.override.yml docker-compose.override.yaml compose.yaml compose.yml compose.override.yml compose.override.yaml 2>/dev/null; grep -E '^COMPOSE_' .env
```

```
cut -d= -f1 .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' | sort | uniq -d; grep -c $'\r' .env
```

```
cp -p .env ".env.bak.$(date +%Y%m%d-%H%M%S)" && ls -l .env .env.bak.*
```

**You should see:** 1: 'project=zekktris files=<folder>/docker-compose.yml user=[]'. files may also list <folder>/docker-compose.override.yml if you have one. 2: DC=[docker compose], a 'Docker Compose version v2…' (or newer) line, 'running', then 'zekktris-api zekktris-cache zekktris-db zekktris-livekit zekktris-proxy'. 3: nothing. Once item 9 creates docker-compose.override.yml on purpose, that file shows here. 4: no names, then 0. 5: the new .env.bak.<date> has exactly the same size as .env.

**If not:** 2 prints an error for 'ps db --format', or DC is not 'docker compose': STOP and ask (install Compose v2, normally from the Compose Manager plugin). If 2 lists fewer than five names while 'docker ps' shows them running: when files= is this folder's docker-compose.yml, run printf '\nCOMPOSE_PROJECT_NAME=%s\n' '<the project= value from 1>' >> .env and repeat 2 (that is the only COMPOSE_ line allowed in .env). When files= points somewhere else, for example under /boot/config/plugins/compose.manager, STOP and ask: the running stack is not this folder. If 3 lists a file you did not create on purpose, show it (cat <file>). Remove any 'user:', 'entrypoint:', 'healthcheck:' or 'depends_on:' lines under api, livekit or proxy, or ask. compose.yaml or compose.yml existing = STOP and ask, because Compose prefers it. user=[something] in 1 = an override sets it: remove it. If 4 prints a name, keep only one line for it (nano .env; Ctrl+O, Enter, Ctrl+X). If the count in 4 is above 0, the file has Windows line endings: sed -i 's/\r$//' .env. Never paste .env or a .bak copy anywhere: they hold every secret.

### 2. Prove which .env the running stack actually read (Unraid Compose Manager can pass its own --env-file) (blocks startup)

*Applies to:* All eras, all install types. Do it before any .env edit.

**Why:** update.sh, agent.sh, backup.sh and doctor.sh read only <folder>/.env, and docker-compose.yml has no env_file line. If the stack was started by Compose Manager with --env-file pointing at another file, every .env edit in this guide goes into a file the stack never reads. The update would then start the new containers with a different configuration: other secrets, everyone signed out, or a database password Postgres rejects. The Compose label names the env file, and comparing fingerprints of a few values proves the running containers got them from this file. Only the first 8 characters of a sha256 are printed, never a value.

```
docker inspect zekktris-api --format 'envfile=[{{ index .Config.Labels "com.docker.compose.project.environment_file" }}]'
```

```
for v in PUBLIC_URL JWT_SECRET; do a=$(grep "^$v=" .env | tail -1 | cut -d= -f2- | tr -d '"\r\n' | sha256sum | cut -c1-8); b=$(docker exec zekktris-api printenv "$v" | tr -d '\r\n' | sha256sum | cut -c1-8); echo "$v env-file=$a running=$b"; done
```

```
a=$(grep '^DB_PASSWORD=' .env | tail -1 | cut -d= -f2- | tr -d '"\r\n' | sha256sum | cut -c1-8); b=$(docker exec zekktris-db printenv POSTGRES_PASSWORD | tr -d '\r\n' | sha256sum | cut -c1-8); echo "DB_PASSWORD env-file=$a running=$b"
```

```
ls -d /boot/config/plugins/compose.manager/projects/*/ 2>/dev/null
```

**You should see:** 1: envfile=[<folder>/.env], or envfile=[] on an older Compose. 2 and 3: each line shows the same 8 characters twice. 4: nothing, or Compose Manager stack folders. If one of them is for Zekktris, Compose Manager may start this stack by itself at boot (see the window rules).

**If not:** envfile names any other path (for example under /boot/config/plugins/compose.manager/projects/<name>/), or any pair differs: STOP and ask. Do not copy files around yourself: the right fix depends on which file holds the real values.

### 3. The data folder and the required secrets resolve exactly as they do today (blocks startup)

*Applies to:* All eras

**Why:** The database, uploads and certificates live under APPDATA_PATH (default /mnt/user/appdata/zekktris), and these mounts are identical in the old and new compose files. If .env names a different folder than the running containers use, the new database starts on an empty folder: the site comes up with no users and no attachments. Compose refuses to start without DB_PASSWORD, JWT_SECRET and JWT_REFRESH_SECRET (unchanged rule). Every psql command in this guide assumes the built-in user 'commune', which is used unless .env overrides DATABASE_URL.

```
echo "$DB"; $DC config | grep -E 'source: .*/db$'
```

```
grep -n '^APPDATA_PATH=' .env
```

```
$DC config -q && echo CONFIG-OK
```

```
awk -F= '/^(DB_PASSWORD|JWT_SECRET|JWT_REFRESH_SECRET|FIELD_ENCRYPTION_KEY)=/{v=substr($0,index($0,"=")+1); print $1, length(v)}' .env
```

```
grep -c '^DATABASE_URL=' .env
```

**You should see:** 1: the same path twice, for example /mnt/user/appdata/zekktris/db. 2: APPDATA_PATH=<that path without /db>, or nothing (the default /mnt/user/appdata/zekktris then applies). 3: CONFIG-OK. 4: only names and lengths. DB_PASSWORD above 0 (48 if generated); JWT_SECRET and JWT_REFRESH_SECRET 32 or more (64 if generated); FIELD_ENCRYPTION_KEY 64 or 44. 5: 0. The switchover runs 1 and 3 again with the new docker-compose.yml before anything restarts. Never paste the full '$DC config' output: it contains your secrets.

**If not:** Paths differ: STOP. Run nano .env, set APPDATA_PATH= to the path from 1 without /db, and repeat. 'required variable DB_PASSWORD is missing a value': .env is damaged; put the copy back with cp -p .env.bak.<date> .env. A length of 0, or 5 printing 1: STOP and ask. Never change DB_PASSWORD: Postgres keeps the password it was created with ('password authentication failed'). Never change the JWT secrets (everyone is signed out) or FIELD_ENCRYPTION_KEY (2FA, bot and SSO secrets become unreadable).

### 4. Database ledger, table sizes, and the first-boot time budget

*Applies to:* All eras (9, 8 or 7 migrations apply)

**Why:** The new api applies the missing migrations by itself on first boot, in one transaction, before it listens. For types A and B, update.sh gives the new api about 2 minutes to answer (Docker's start period of 30 s plus three failed probes 30 s apart, with a hold of up to 150 s while Docker says 'starting'). Otherwise it rolls the update back: safely, because the transaction is undone, but the update window is wasted. If the rollback stops the api in the middle of a long index build, Postgres keeps the migration's locks on messages until that statement ends, so chat stays blocked a little longer. The indexes in 0133 cannot be built ahead of time, because the columns they index are created in the same file. Type C is not affected, because its wait loop has no 2-minute limit. Preflight step PF8 measures the real migration time on a copy of your data. The migrator only applies migrations newer than the newest recorded one, so an unexpected ledger means migrations could be skipped silently.

```
docker exec zekktris-db psql -U commune -d commune -tAc "SELECT count(*)||'|'||max(created_at) FROM drizzle.__drizzle_migrations"
```

```
docker exec zekktris-db psql -U commune -d commune -tAc "SELECT pg_size_pretty(pg_total_relation_size('messages'))||' / about '||reltuples::bigint||' rows' FROM pg_class WHERE relname='messages'"
```

```
du -sh "$DB"
```

**You should see:** 1: the same as I2: <count>|1784600330000, |1784686730000 or |1784773130000. Write the count down: after the update it is the count + 9, 8 or 7, and the max is exactly 1785377930000. 2: the messages size, typically up to a few GB. In a test, 7 migrations on a 1.2 GB table with 3,000,000 rows took 1.1 s. 3: the database folder size, needed for item 18.

**If not:** Any other max: STOP and ask. Max 1785377930000: see I2. Messages far above about 10 GB, or PF8 later showing 'applied/verified in' above 60000ms: ask before updating (types A/B would hit the 2-minute rollback).

### 5. The LiveKit key pair is not a published one, and both halves are set (blocks startup)

*Applies to:* All eras (the old api already refused these since 91ec76a; this bites if .env changed after the api last started)

**Why:** The new api refuses to start in three cases: the LiveKit key is APIAMD7Sj5psuK4 (leaked) or devkey; the secret is the published devsecret value; or only one of key and secret is set. The log then shows '[11/13] Voice / video (LiveKit) … ✗' and '1 check(s) failed in …ms — refusing to start'. The proxy waits for a healthy api, so the site stays down. Because check 6 runs before check 11, the migrations are already applied when it refuses.

```
grep -cE '^LIVEKIT_API_KEY=(APIAMD7Sj5psuK4|devkey)$' .env; grep -c 'devsecret-do-not-use-in-production-32chars' .env
```

```
awk -F= '/^LIVEKIT_API_(KEY|SECRET)=/{v=substr($0,index($0,"=")+1); print $1, length(v)}' .env
```

```
for v in LIVEKIT_API_KEY LIVEKIT_API_SECRET; do a=$(grep "^$v=" .env | tail -1 | cut -d= -f2- | tr -d '"\r\n' | sha256sum | cut -c1-8); b=$(docker exec zekktris-api printenv "$v" | tr -d '\r\n' | sha256sum | cut -c1-8); echo "$v env-file=$a running=$b"; done
```

```
grep -E '^LIVEKIT_WS_URL=' .env
```

**You should see:** 1: 0 and 0. 2: both names with a length above 0, the secret 32 or more (64 if generated). 0 and 0 is also fine (voice off). 3: each pair of fingerprints is equal. 4: 'LIVEKIT_WS_URL=' with nothing after it (bundled SFU), or wss://<project>.livekit.cloud.

**If not:** If 1 prints 1, or 2 shows only one of the pair, choose one fix. (A) Bundled SFU: K="lk_$(openssl rand -hex 8)"; S="$(openssl rand -hex 32)"; sed -i -e "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=$K|" -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=$S|" -e "s|^LIVEKIT_WS_URL=.*|LIVEKIT_WS_URL=|" .env; unset K S. Then repeat 2. If a line was missing, sed changed nothing: add it with nano. Outside callers need UDP 7882 and TCP 7881 forwarded to this server. (B) LiveKit Cloud: create a new key in your own Cloud project, then put only the two values into .env with nano. Either way, delete key APIAMD7Sj5psuK4 in the LiveKit Cloud dashboard, because refusing it here does not revoke it. Fingerprints differ in 3: .env was edited after the api started. The .env value is what the update will use, so confirm it was intended and that it passes 1 and 2.

### 6. .env lines the old version silently ignored and the new one obeys (blocks startup)

*Applies to:* All eras. TLS_MODE and PUBLIC_IP are new for Era 1a/1b; SOURCE_CODE_URL is new for everything before 45c7295.

**Why:** The old compose file dropped these lines, and the new one passes them on, so a forgotten line takes effect for the first time at the update. A badly written value stops the api before it touches the database, for example '✗ Invalid environment configuration:' followed by '  - INACTIVITY_TTL_DAYS: Expected number, received nan' or '  - SOURCE_CODE_URL: Invalid url'. Any TLS_MODE other than none or ip stops Caddy. Some valid values do lasting things. INACTIVITY_TTL_DAYS permanently deletes accounts idle that many days. ATTACHMENT_RETENTION_REAP_UNTHUMBED=true deletes originals that have no thumbnail. A filled-in APNS_KEY_P8 overrides the key file in ./secrets. Without any of these lines nothing changes: the defaults equal today's built-in ones, and only the new gateway limits are new. The preflight test catches a bad value with no outage.

```
grep -nE '^(INACTIVITY_TTL_DAYS|INACTIVITY_SWEEP_INTERVAL_HOURS|STREAK_WARN_ENABLED|STREAK_WARN_HOURS_BEFORE|INVITE_PRUNE_ENABLED|INVITE_PRUNE_GRACE_DAYS|PARENT_LINK_AGE_CHECK_ENABLED|PARENT_LINK_AGE_CHECK_INTERVAL_HOURS|ATTACHMENT_RETENTION_REAP_UNTHUMBED|GATEWAY_CONNECTS_PER_MINUTE_PER_IP|GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER|SOURCE_CODE_URL|TLS_MODE|PUBLIC_IP)=' .env
```

```
awk -F= '/^(FIELD_ENCRYPTION_KEYS_OLD|APNS_KEY_P8)=/{v=substr($0,index($0,"=")+1); print $1, length(v)}' .env
```

```
grep -E '^FIELD_ENCRYPTION_KEYS_OLD=' .env | cut -d= -f2- | tr ',' '\n' | tr -d ' "' | awk 'NF{print length($0)}'
```

```
ls secrets/*.p8 2>/dev/null
```

**You should see:** 1 (none of these are secrets): nothing, or only lines you set on purpose with allowed values. Allowed: whole numbers; INACTIVITY_TTL_DAYS 0 or more (0 = off); *_INTERVAL_HOURS 0.25 or more; STREAK_WARN_HOURS_BEFORE 1–23; INVITE_PRUNE_GRACE_DAYS 0–365; GATEWAY_* 0 or more (0 = no limit); *_ENABLED true or false; SOURCE_CODE_URL empty or a full https:// address; TLS_MODE=none or absent; PUBLIC_IP empty or absent. Era 3 files normally show TLS_MODE=none and PUBLIC_IP=, plus SOURCE_CODE_URL= from 45c7295. 2: nothing, or lengths of 0. 3: nothing, or only 64 (or 44) on each line. 4: your AuthKey_<KEYID>.p8 if you use iOS push.

**If not:** Turn off a line you do not recognise with a # in front: sed -i 's/^NAME=/#&/' .env (replace NAME), for example sed -i 's/^ATTACHMENT_RETENTION_REAP_UNTHUMBED=/#&/' .env. 3 shows another length: sed -i 's/^FIELD_ENCRYPTION_KEYS_OLD=/#&/' .env. APNS_KEY_P8 above 0 while you use the file in ./secrets: sed -i 's/^APNS_KEY_P8=.*/APNS_KEY_P8=/' .env. TLS_MODE other than none (ip is wrong behind a tunnel): sed -i 's/^TLS_MODE=.*/TLS_MODE=none/' .env. SOURCE_CODE_URL without https://: sed -i 's/^SOURCE_CODE_URL=.*/SOURCE_CODE_URL=/' .env. The running server never received these lines, so turning them off changes nothing that works today. Never comment out FIELD_ENCRYPTION_KEY itself. Leave FCM_* and VAPID_* alone: new VAPID keys would cancel every browser's push subscription.

### 7. Add EDGE_PROXY=cloudflare to .env, spelled exactly like that (blocks startup)

*Applies to:* All eras (a new setting that only the new proxy reads)

**Why:** Today's proxy trusts Cloudflare and the Docker range 172.16.0.0/12 by itself, so it knows each visitor's real address. The new proxy trusts nobody unless EDGE_PROXY says so. Without the line, every visitor through the tunnel looks like one address, the tunnel's 172.x address. The new limit of 120 WebSocket connects per minute per address then throttles the whole site: right after the update, most apps get HTTP 429 and chat sits on 'connecting'. Login limits and IP bans also hit everyone together. A misspelt value (Cloudflare, cloudfare, quoted, a trailing space or a Windows line ending) is worse. Caddy fails with 'File to import not found: /etc/caddy/modes/edge-<value>.servers, at /etc/caddy/Caddyfile:67', keeps restarting, and the whole site is down. The value restores exactly today's trust list. Nothing changes until the update, because the running proxy never receives this variable.

```
docker logs --tail 300 zekktris-proxy 2>&1 | grep -c '"Cf-Connecting-Ip"'
```

```
docker logs --tail 2000 zekktris-proxy 2>&1 | grep -oE '"remote_ip": "[^"]*"' | sort | uniq -c
```

```
grep -q '^EDGE_PROXY=' .env && sed -i 's/^EDGE_PROXY=.*/EDGE_PROXY=cloudflare/' .env || printf '\nEDGE_PROXY=cloudflare\n' >> .env
```

```
grep -cx 'EDGE_PROXY=cloudflare' .env; grep -c '^EDGE_PROXY=' .env
```

**You should see:** 1: a number above 0, meaning requests reach this box through Cloudflare. 2: counts for 172.16–172.31.x.x addresses (the tunnel), perhaps 192.168.x.x (your own LAN use). Cloudflare-owned addresses such as 162.158.x.x, 172.64–71.x.x or 104.16–31.x.x mean proxied DNS without a tunnel, which EDGE_PROXY=cloudflare also covers. 4: 1 and 1. Preflight PF2/PF3 later prove the new proxy accepts it.

**If not:** 1 prints 0: open the site in a browser and repeat. Still 0: traffic does not come through Cloudflare; STOP and ask. 2 shows a public address that is not Cloudflare's: a router forward reaches Caddy directly. Keep EDGE_PROXY=cloudflare (it is exactly today's list) and have the forward reviewed later. 4 prints 0 first: the value is misspelt, quoted or has a CR. Run 3 again, then sed -i 's/\r$//' .env. Second number above 1: delete the extra EDGE_PROXY lines with nano. If you ever change it after the update, use $DC up -d proxy, never 'restart' (restart does not re-read .env). Do not run '$DC up -d proxy' before the update.

### 8. Today's real-visitor-address baseline (GATEWAY_CONNECTS_PER_MINUTE_PER_IP=0 only if it fails)

*Applies to:* All eras

**Why:** EDGE_PROXY=cloudflare only gives real addresses if cloudflared reaches Caddy from a Docker bridge address (172.16–172.31.x.x), which is what the old doctor check proves today. If cloudflared comes from elsewhere, for example a container on Unraid's br0/macvlan with a 192.168.x address, real addresses are already lost today. Then the new limit of 120 WebSocket connects per minute per address would throttle everyone at once right after the restart.

```
./scripts/doctor.sh 2>&1 | grep -A1 '^Client IP'
```

```
docker logs --tail 300 zekktris-proxy 2>&1 | grep '"Cf-Connecting-Ip"' | tail -1 | grep -oE '"(remote_ip|client_ip)": "[^"]*"'
```

```
docker ps --format '{{.Names}} | {{.Image}} | {{.Networks}}' | grep -i cloudflared; pgrep -l cloudflared
```

**You should see:** Open https://www.zekktris.com in a browser first. 1: '✓ the API sees the real visitor address (<your public IP>)'. Without --fix, doctor.sh changes nothing. 2: remote_ip is 172.16–172.31.x.x and client_ip is your public IP. 3 shows where cloudflared runs: a host process ('<pid> cloudflared') or a container with its networks. Never use 'pgrep -a' or 'docker inspect' without a --format on cloudflared: the command line and the environment carry the tunnel token.

**If not:** '! no Cloudflare-fronted request in the recent proxy log to check': reload the site and repeat. '✗ Caddy resolves visitors to X but Cloudflare says Y', or a remote_ip outside 172.16–172.31 (and not Cloudflare's): before the update run printf '\nGATEWAY_CONNECTS_PER_MINUTE_PER_IP=0\n' >> .env (0 turns the new limit off). Ask later for help moving cloudflared onto a Docker bridge network.

### 9. Tunnel target: the Cloudflare Tunnel must aim at the host or a stable name, never a container IP; site address unchanged; never run install.sh or setup.sh here

*Applies to:* All eras, all install types

**Why:** The update recreates zekktris-proxy (its image and environment change), and Docker gives the new container whatever address is free on the bridge, because this compose file pins no IP. A Public Hostname whose Service is the proxy CONTAINER's own address (for example http://172.19.0.5:5550) then points at nothing: Cloudflare shows 502 for good, while every on-server check (docker port, curl 127.0.0.1:5550) still passes. Safe targets survive the recreate: localhost or 127.0.0.1, the Unraid LAN IP, the docker0 address (usually 172.17.0.1) or the zekktris network's gateway, always on the published port; or the name zekktris-proxy on a network cloudflared shares. A network that someone attached to the proxy by hand ('docker network connect') is dropped by the recreate, because the new compose puts the proxy on the zekktris network only. A docker-compose.override.yml keeps it. The published port and default site address :5550 are the same in every version. The danger is 'install.sh --domain', 'install.sh --reconfigure', 'scripts/setup.sh' or docs/zekktris-com-setup.md §2: they rewrite SITE_ADDRESS, HTTP_PORT=80 and HTTPS_PORT=443 and restart the stack, so Caddy stops listening where the tunnel connects.

```
grep -E '^(SITE_ADDRESS|HTTP_PORT|HTTPS_PORT|TLS_MODE|PUBLIC_IP|PUBLIC_URL|COOKIE_SECURE)=' .env
```

```
docker port zekktris-proxy
```

```
docker inspect zekktris-proxy --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} ip={{$v.IPAddress}} gateway={{$v.Gateway}}{{println}}{{end}}'
```

```
ip -4 addr show dev docker0 | grep -oE 'inet [0-9.]+'; ip -4 route get 1.1.1.1 | grep -oE 'src [0-9.]+'
```

```
P=$(grep -E '^HTTP_PORT=' .env | tail -1 | cut -d= -f2 | tr -d '"\r'); curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${P:-5550}/health"; curl -sL -o /dev/null -w '%{http_code}\n' https://www.zekktris.com/health; curl -sL -o /dev/null -w '%{http_code}\n' https://zekktris.com/health
```

```
N='<the extra network name from command 3>'; test -e docker-compose.override.yml && echo OVERRIDE-EXISTS-ASK || printf 'services:\n  proxy:\n    networks:\n      - zekktris\n      - %s\nnetworks:\n  %s:\n    external: true\n' "$N" "$N" > docker-compose.override.yml; cat docker-compose.override.yml
```

```
$DC config -q && echo CONFIG-OK; $DC config | sed -n '/^  proxy:/,/^  [a-z]*:$/p' | grep -A3 '^    networks:'
```

**You should see:** 1: PUBLIC_URL=https://zekktris.com or https://www.zekktris.com with no port; COOKIE_SECURE=true; SITE_ADDRESS absent or :5550 (equal to HTTP_PORT); HTTP_PORT absent or 5550; TLS_MODE absent or none; PUBLIC_IP empty or absent. An Era-3 box set up with 'install.sh --domain' may show SITE_ADDRESS=https://zekktris.com, HTTP_PORT=80, HTTPS_PORT=443: if the site works today, change NONE of them. 2: for example '5550/tcp -> 0.0.0.0:5550'. 3: one line, '<project>_zekktris ip=172.x.x.x gateway=172.x.0.1'. 4: 'inet 172.17.0.1' and 'src <LAN IP>'. 5: 200, 200, 200. Then, in Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public Hostname (newer dashboards say 'Published application routes'), write down the Service of zekktris.com and www.zekktris.com. A tunnel run from a config.yml lists them as 'service:' lines. It is safe when its host is localhost, 127.0.0.1, the LAN IP from 4, 172.17.0.1, or the gateway= from 3, with the port from 2. It is also safe as zekktris-proxy:<port> when cloudflared is on a network listed in 3. Commands 6 and 7 are only for the extra-network case below.

**If not:** Service host equals the ip= in 3, or is any other 172.16–31.x.x address that is not a gateway: before the update, change it in Cloudflare to http://localhost:<HTTP_PORT> (cloudflared on the host or with host networking) or http://<LAN IP from 4>:<HTTP_PORT> (cloudflared in a bridge container). Save, reload the site, and repeat 5. If 3 lists a second network (the tunnel reaches the proxy there): run 6 with N set to that exact name. It writes docker-compose.override.yml (item 1 command 3 will now list it on purpose), then run 7, which must print CONFIG-OK and both networks. Do not run 'up -d' now: the update applies it. OVERRIDE-EXISTS-ASK: STOP and ask (an override already exists; do not overwrite it). PUBLIC_URL carrying a port (the old doc's example https://zekktris.com:5551): sed -i -E 's|^(PUBLIC_URL=https://[^/:]+):[0-9]+/?$|\1|' .env. Never change the host name in PUBLIC_URL: passkeys are tied to it. cloudflared on br0/macvlan with its own 192.168.x address: STOP and ask. A Service ending in :7880: see item 10.

### 10. LiveKit: port 7880, LIVEKIT_HTTP_URL, and what the new LiveKit start script needs in the image

*Applies to:* All eras

**Why:** The new compose replaces LiveKit's entrypoint with ops/livekit-entrypoint.sh. It needs sh, ip, awk, tr and uname in the image and finally runs the hard-coded /livekit-server. It opens the signalling port 7880 only on 127.0.0.1 and the docker0 address (usually 172.17.0.1), not on every interface. The proxy's /livekit route and the api reach it through host.docker.internal (= docker0), so voice keeps working. Only things that used <LAN-IP>:7880 directly break. Media ports 7881/7882 are unchanged. A missing binary or tool makes LiveKit crash-loop while the proxy starts anyway (it waits only for 'started'). The image itself does not change: the same LIVEKIT_IMAGE_TAG default is used in old and new compose. LiveKit Cloud needs LIVEKIT_HTTP_URL pointed at the cloud, or kicked users keep their audio.

```
grep -E '^LIVEKIT_(WS_URL|HTTP_URL|BIND_ADDRESSES|IMAGE_TAG|HOST|USE_EXTERNAL_IP)=' .env
```

```
ip -4 addr show dev docker0 | grep inet; docker exec zekktris-proxy grep host.docker.internal /etc/hosts
```

```
ss -tn state established '( sport = :7880 )'
```

```
docker exec zekktris-livekit sh -c 'test -x /livekit-server || echo MISSING-livekit-server; for t in ip awk tr uname; do command -v $t >/dev/null || echo MISSING-$t; done; echo TOOLS-CHECKED'
```

**You should see:** 1: LIVEKIT_WS_URL empty (bundled) or wss://<project>.livekit.cloud. LIVEKIT_HTTP_URL absent, empty or http://host.docker.internal:7880 (bundled), or https://<same project>.livekit.cloud (Cloud). LIVEKIT_BIND_ADDRESSES absent. LIVEKIT_IMAGE_TAG absent, v1.9 or v1.9.12: leave it. 2: the same address twice, usually 172.17.0.1. 3 (ideally during a call): peers only on 127.0.0.1 or 172.x.x.x. 4: only TOOLS-CHECKED. No tunnel Service ends in :7880. Preflight PF4 repeats 4 with the new compose.

**If not:** Something uses <LAN-IP>:7880: point it at http://127.0.0.1:7880 (from the host) or host.docker.internal:7880. A LAN-address LIVEKIT_HTTP_URL with the bundled SFU: sed -i 's/^LIVEKIT_HTTP_URL=/#&/' .env. Not possible to change (a tunnel hostname on :7880, a LAN tool): printf '\nLIVEKIT_BIND_ADDRESSES=all\n' >> .env (the old behaviour). LiveKit Cloud with no LIVEKIT_HTTP_URL: printf '\nLIVEKIT_HTTP_URL=https://<project>.livekit.cloud\n' >> .env (the host of LIVEKIT_WS_URL, https instead of wss). MISSING-ip alone only means 7880 stays on every interface, which still works. MISSING-livekit-server, MISSING-awk, MISSING-tr, MISSING-uname, or 'executable file not found' for sh: STOP using this image. Set LIVEKIT_IMAGE_TAG=v1.9.12 in .env (sed -i 's/^LIVEKIT_IMAGE_TAG=.*/LIVEKIT_IMAGE_TAG=v1.9.12/' .env, or printf '\nLIVEKIT_IMAGE_TAG=v1.9.12\n' >> .env if absent), then docker pull livekit/livekit-server:v1.9.12. That image was checked to contain them. Never forward 7880 on the router.

### 11. Cloudflare features that inject scripts, versus the new Content-Security-Policy; and Cloudflare caching of the page

*Applies to:* All eras (no old version had a CSP)

**Why:** The new page carries a strict Content-Security-Policy that no old era had: script-src 'self'. Only the app's own scripts from this site may run; inline scripts and scripts from other sites are refused. Cloudflare can add or rewrite scripts on the way. Rocket Loader rewrites the page's script tags and runs them through its own loader, which can leave a blank page. Zaraz and Bot Fight Mode's JavaScript detections insert inline script, which is now refused. Web Analytics' automatic setup inserts a script from static.cloudflareinsights.com, which is now refused (only the statistics are lost). Email Address Obfuscation adds /cdn-cgi/…/email-decode.min.js from this same site, which is allowed, and the app page contains no addresses. Separately, if a Cache Rule makes Cloudflare cache the HTML page, visitors keep getting the old page after the update. The new proxy itself sends 'Cache-Control: no-cache' for the page.

```
curl -s -A 'Mozilla/5.0 (X11; Linux x86_64)' -H 'Accept: text/html' https://www.zekktris.com/ | grep -oE 'rocket-loader|rocketscript|cloudflareinsights|beacon\.min\.js|/cdn-cgi/[a-z_-]+' | sort | uniq -c; echo SCAN-DONE
```

```
curl -sI https://www.zekktris.com/ | grep -iE '^(cf-cache-status|cache-control|content-security-policy):'
```

**You should see:** 1: only SCAN-DONE. 2: 'cf-cache-status: DYNAMIC' (or MISS, BYPASS, or no such line). In the Cloudflare dashboard for zekktris.com (menu names from general knowledge; they move): Speed → Optimization → Content Optimization → Rocket Loader is Off. Zaraz is off or has no tools. Analytics & Logs → Web Analytics has automatic setup / JS snippet injection off for this site, or you accept losing that analytics. Security → Bots: JavaScript detections are off, or you accept that their script is refused.

**If not:** 1 shows rocket-loader or rocketscript: turn Rocket Loader off now (it changes nothing for the old site). cloudflareinsights or beacon.min.js: turn off automatic injection, or accept losing those statistics. /cdn-cgi/zaraz: turn Zaraz off for this site. /cdn-cgi/challenge-platform: JavaScript detections are on; turn them off, or accept that and watch for extra challenges after the update. /cdn-cgi/scripts or email-decode only: allowed, nothing to do. 2 shows HIT: a rule caches the page. Right after the update, use Caching → Configuration → Purge Everything, or remove that rule now.

### 12. BOOTSTRAP_ADMIN_EMAIL: confirm an admin exists, then empty it

*Applies to:* All eras (install.sh filled it in Era 3)

**Why:** It never blocks startup, and while an admin exists it does nothing. But it re-arms whenever no admin is left: whoever then registers and verifies that address becomes admin. Emptying it now costs no extra restart, because the update recreates the api from .env anyway.

```
docker exec zekktris-db psql -U commune -d commune -tAc "select count(*) from users where is_admin and deleted_at is null"
```

```
awk -F= '/^BOOTSTRAP_ADMIN_EMAIL=/{print $1, (length(substr($0,index($0,"=")+1))?"set":"empty")}' .env
```

```
sed -i 's/^BOOTSTRAP_ADMIN_EMAIL=.*/BOOTSTRAP_ADMIN_EMAIL=/' .env
```

**You should see:** 1: 1 or more. Only then run 3. Afterwards 2 prints 'BOOTSTRAP_ADMIN_EMAIL empty', or nothing if the line never existed.

**If not:** 1 prints 0: do NOT run 3. After the update, promote your own account (new code only): $DC exec -w /app/apps/api api node --import tsx/esm scripts/create-admin.ts --email '<your account email>' --promote-unverified. --promote-unverified also marks the address verified; an existing account keeps its password and is asked for none. Without it, an unverified account is refused.

### 13. Email (SMTP via Resend): nothing to change, but record a baseline

*Applies to:* All eras

**Why:** The same six SMTP settings reach the api and are checked the same way in every version; the new code only sends a few more kinds of mail. The api logs nothing about SMTP at startup, so the old doc's 'grep -i smtp' check never shows anything.

```
grep -E '^SMTP_(HOST|PORT|USER|FROM|SECURE)=' .env
```

```
docker exec zekktris-api sh -c 'echo "host=[$SMTP_HOST] port=[$SMTP_PORT] user=[$SMTP_USER] from=[$SMTP_FROM] secure=[$SMTP_SECURE] pass=[${SMTP_PASS:+set}]"'
```

**You should see:** host=[smtp.resend.com] port=[587] user=[resend] from=[noreply@zekktris.com] secure=[false] pass=[set], or your own values. The password only ever shows as 'set'. Run 2 again after the update and expect identical output.

**If not:** Nothing to fix for the update. An empty host or from means email is off today as well.

### 14. Hand uploads/ to uid 1000 ahead of time (measure and do a first pass now; the final pass is in the switchover) (blocks startup)

*Applies to:* All eras (the old api ran as root, so every upload belongs to root)

**Why:** The new api no longer runs as root. On its first boot, before it serves anything, it changes the owner of every file in uploads/ that uid 1000 does not own. Chat and the API are down for that whole pass, while the old proxy still shows the page, and on a large folder on Unraid's /mnt/user that can take many minutes. The new update.sh waits for it, up to an hour. A plain 'docker compose up -d' gives up after about 2 minutes and leaves the proxy never started. If you do the handover now while the old site runs, the new api finds the folder already handed over and starts at once. The old root api can still read and write everything, but files it adds afterwards belong to root again, so a final pass runs right before the restart and one more after it.

```
echo "$UP"; du -sh "$UP"; time find "$UP" ! -uid 1000 | wc -l
```

```
find "$UP" -mindepth 1 ! -uid 1000 -exec chown -h 1000:1000 {} + && chown -h 1000:1000 "$UP" && echo HANDED-OVER
```

```
find "$UP" ! -uid 1000 | wc -l; stat -c %u "$UP"
```

**You should see:** 1: a host path such as /mnt/user/appdata/zekktris/uploads (never empty), its size, the number of files not yet owned by 1000, and a 'real' time, which is how long one walk takes. 2: HANDED-OVER (run it once any time beforehand, even the day before). 3: 0, then 1000. A few minutes later 3 may show a small number again (new uploads): expected.

**If not:** Empty path: STOP and ask. 'Operation not permitted' (an NFS or SMB mount): STOP and ask. The new api would fall back to running as root ('running as root as before'), which works but should be looked at. Touch only uploads/. Never chown control/, control/status/, db/, caddy-data/, caddy-config/, backups/ or the appdata folder itself. Unraid Tools → New Permissions or Docker Safe New Perms on appdata undoes this.

### 15. Never start this update with the old update routine; know the private deploy scripts (blocks startup)

*Applies to:* All eras, all install types

**Why:** The update script on disk today is the same file in every old version. It restarts everything with one 'docker compose up -d' and waits 90 seconds. The new api's first boot can outlast Docker's grace of about 2 minutes, and Compose then stops with 'dependency failed to start: container zekktris-api is unhealthy'. The new proxy is left 'Created' but never started, and Cloudflare shows 502 until someone starts it by hand. The same old script rebuilds the old code when 'git fetch' fails and still reports success, and its rollback ('git reset --hard') wipes local edits. Admin → Backup & Maintenance → Update runs that same file through the host agent. The old docs' zip route ('docker compose build && docker compose up -d') has the same single-'up -d' problem. The new script starts the api first, waits for it, and only then starts the rest.

```
grep -c wait_for_api scripts/update.sh
```

```
ls -l update.sh update.ps1 2>/dev/null
```

**You should see:** 1: 0 today (the old script). It must print 3 before you ever run ./scripts/update.sh for this update; the switchover puts the new file on disk first. 2: nothing.

**If not:** 2 lists a file: it is a private deploy script in the folder root (the old .gitignore lists /update.sh and /update.ps1). Do not use it for this update. Until the after-update checks pass, never: run ./scripts/update.sh while 1 prints 0; press any Admin → Backup & Maintenance button; run '$DC up -d --build'; or run '$DC up -d' after a build except where this guide says so.

### 16. GitHub access and the release on master (type A); who pushes (type B); other installs that follow master

*Applies to:* Type A (git with origin); type B for whoever pushes; any other server that updates from GitHub

**Why:** The release is branch fix/health-check (d1d3e3a), 221 commits ahead of master and 0 behind. Both update scripts deploy only origin/master, so master on GitHub has to be moved to it, in the window (switchover A3), after the host agent is paused. Once master moves, any box whose Update button or ./scripts/update.sh is still the old file does the single-'up -d' update with no EDGE_PROXY and no uploads handover. The repository is private: without read access the server cannot fetch. A token in the remote URL survives Unraid reboots, because .git/config lives on the share, but it then shows in 'git remote -v', so every such command here is masked. Unraid forgets git's safe.directory at every reboot, because /root is in RAM.

```
git -c safe.directory="$PWD" remote -v | sed -E 's#//[^/@]*@#//***@#'
```

```
GIT_TERMINAL_PROMPT=0 git -c safe.directory="$PWD" ls-remote origin refs/heads/master refs/heads/fix/health-check
```

```
read -rsp 'GitHub token: ' T; echo; git -c safe.directory="$PWD" remote set-url origin "https://x-access-token:$T@github.com/Eternus-Nox/zekktris.git"; unset T
```

```
GIT_TERMINAL_PROMPT=0 git -c safe.directory="$PWD" fetch origin && git -c safe.directory="$PWD" merge-base --is-ancestor HEAD origin/master && echo FAST-FORWARD-OK
```

**You should see:** 1: origin with github.com/Eternus-Nox/zekktris (type A). 2: two lines, '<sha>	refs/heads/master' and 'd1d3e3addbbda347bd78496f55d66b9be9052a9b	refs/heads/fix/health-check', with no password prompt. Run 3 only if 2 fails. 4: FAST-FORWARD-OK. Also list every other Zekktris server or test box that updates from this GitHub repository (a git clone with this origin): each needs this same guide before master moves, or its admins must not press Update or run ./scripts/update.sh. For type B, name the person and machine that push into this server.

**If not:** 'Authentication failed', 'could not read Username' or 'Repository not found' in 2: the GitHub owner creates a fine-grained token for Eternus-Nox/zekktris only, with Contents: Read-only. Run 3 and paste the token at the prompt: nothing shows, and the token stays out of shell history and the screen. Then repeat 2. From then on .git/config holds a secret: never paste it or unmasked 'git remote -v'. A ~/.git-credentials file would avoid the token in the URL, but /root is erased at every Unraid reboot. An ssh origin (git@github.com:…) that fails: the key in /root/.ssh was also lost at reboot. Use 3 instead. FAST-FORWARD-OK missing: STOP and ask (history differs from GitHub). Moving master (switchover A3) must use a pull request merged with 'Create a merge commit', or 'git push origin fix/health-check:master' from a developer clone. Never squash or rebase.

### 17. No local edit or stray file stands in the way of the new code (types A/B); no hand-edited files (type C)

*Applies to:* Types A and B (a push into a dirty tree is refused too); type C via identify step I7

**Why:** Git refuses to bring in new code over a hand-edited file that the update also changes (docker-compose.yml, ops/Caddyfile, ops/Dockerfile.*, scripts/*, .env.example and more), or over an untracked file where the update adds one. Forcing past it throws away a host-specific tweak, such as a port the tunnel relies on. An edit to ops/livekit.yaml is fine: the update does not change that file. For type C the copy over the folder would silently overwrite such edits, so I7's checksums must all match a known release.

```
git -c safe.directory="$PWD" status --short --untracked-files=no
```

```
git -c safe.directory="$PWD" diff --stat | tail -1
```

*type A only:*

```
comm -12 <(git -c safe.directory="$PWD" diff --name-only HEAD | sort) <(git -c safe.directory="$PWD" diff --name-only HEAD origin/master | sort)
```

*type A only:*

```
git -c safe.directory="$PWD" diff --name-only --diff-filter=A HEAD origin/master | while read -r f; do [ -e "$f" ] && echo "IN THE WAY: $f"; done; echo CHECKED
```

**You should see:** 1: nothing, or only ' M ops/livekit.yaml'. 3 (type A, after item 16's fetch and once master has moved): nothing. 4: only CHECKED. Type C: every line of I7 matches the table.

**If not:** Many ' M' lines for files you never edited, with 2 showing only mode changes, are Unraid/SMB permission noise: git -c safe.directory="$PWD" config core.fileMode false, then repeat 1. 3 prints a file with a real edit: save it with git -c safe.directory="$PWD" diff > ../zekktris-local-edits-$(date +%Y%m%d).patch and ask. The change moves into .env or docker-compose.override.yml, and then git checkout -- <file>. A port mapping for the tunnel must be moved before the file is reset. 'IN THE WAY: <file>': mv <file> ../ (it is not part of the repository). Type B (no origin): commands 3 and 4 do not apply. An untracked file in the way makes the push in B5 fail with "untracked working tree files would be overwritten": move that file out of the folder (mv <file> ../) and push again. Whoever pushes can pre-check on their computer with git diff --name-only --diff-filter=A <server HEAD> fix/health-check and look for each path on the server.

### 18. Unraid host: room to build and to test on a copy of the database, base images pre-pulled, a terminal that survives, the clock

*Applies to:* All eras

**Why:** The update builds new api and proxy images inside docker.img. The preflight test also restores a full copy of the database into a temporary container there. A failed build is safe, because nothing restarts, but it wastes the window. The build pulls caddy:2.11.4-alpine (new for Era 1a/1b), node:20-alpine and the docker/dockerfile:1.7 frontend from Docker Hub, which limits anonymous pulls. Pulling them a day ahead changes nothing that runs. The Unraid web terminal kills a running command when its tab closes.

```
df -h /var/lib/docker | tail -1; du -sh "$DB"
```

```
docker pull caddy:2.11.4-alpine && docker pull node:20-alpine && docker pull docker/dockerfile:1.7
```

```
docker image inspect postgres:16-alpine --format 'postgres image present'
```

```
command -v tmux || command -v screen
```

```
date
```

**You should see:** 1: Avail at least 5G plus twice the database size from the second line (the build plus the preflight copy). 2: three 'Status: …' lines ('Downloaded newer image' or 'Image is up to date'). 3: 'postgres image present'. 4: a path. 5: the server time, used for item 21.

**If not:** Too little room: docker image prune (it removes only unused images and asks first), then repeat 1. Still short: enlarge docker.img (Settings → Docker, with the Docker service stopped, which you should do on a separate day). Or skip PF5–PF8 and use PF-lite in the preflight. Pull errors such as 'toomanyrequests': wait an hour and repeat; the build itself still contacts Docker Hub for the frontend. No tmux: use ssh and keep that window open throughout.

### 19. A baseline backup kept outside the pruned folder and not staged in /tmp, taken AFTER all .env edits

*Applies to:* All eras, all install types (the switchover takes another fresh, verified one right before the restart)

**Why:** Rolling the code back does not undo migrations; only a database restore does. Every backup.sh run keeps only the newest 7 bundles in its folder, so the update's own backup plus the nightly ones can push out an older bundle you rely on. The '--keep 0 <folder>' form prunes nothing and writes to $PRE. backup.sh and restore.sh build the bundle in a temporary folder (mktemp). On Unraid /tmp is RAM, and a large database dump, or a full bundle with uploads/, there can fill memory and take Docker down, so TMPDIR points at $PRE/tmp on disk. A restore also puts back the .env stored in the bundle, which is why the bundle must hold the edited .env.

```
df -h "$PRE" | tail -1; du -sh "$UP"
```

```
TMPDIR="$PRE/tmp" ./scripts/backup.sh --no-uploads --keep 0 "$PRE" 2>&1 | grep -E 'Backup complete|Size:|✗'
```

```
TMPDIR="$PRE/tmp" ./scripts/restore.sh --check "$(ls -1t "$PRE"/zekktris-*.tar.gz | head -1)" 2>&1 | tail -3
```

```
for f in $(ls -1t "${UP%/uploads}"/backups/zekktris-*.tar.gz 2>/dev/null | head -7); do printf '%s ' "$f"; tar -xzOf "$f" MANIFEST | grep includes_uploads; done; echo LISTED
```

```
ls -la "$PRE"
```

**You should see:** 1: free space on that share, and the uploads size. 2: '✓ Backup complete: <PRE>/zekktris-YYYYMMDD-HHMMSS.tar.gz' and a size. The '--no-uploads' warnings are expected: the update never changes the content of uploads, only their owner. 3: '✓ Bundle verified. Nothing was changed.' 4: older bundles with includes_uploads=yes or no, then LISTED. This is slow on full bundles because MANIFEST is the last member, but it is harmless. 5: -rw------- zekktris-*.tar.gz files and the tmp folder.

**If not:** 2 fails with 'db service is not running': item 1 (Compose project). Optional full bundle, only if 1 shows free space of at least twice the uploads size: TMPDIR="$PRE/tmp" ./scripts/backup.sh --keep 0 "$PRE". Never run it without TMPDIR on Unraid. If the appdata share is exported to other people, move $PRE to a private share (set PRE=/mnt/user/<private share>/zekktris-predeploy in I1): bundles hold the database, .env and the encryption keys. Never run '$DC down -v'.

### 20. Stripe leftovers: the order depends on your era

*Applies to:* All eras. Era 1a (ledger 1784600330000/1784686730000), and Era 1b at exactly 444fc62 (no card in I3), have billing still live and no card.

**Why:** Startup is not affected: the new code no longer reads STRIPE_*, and /api/v1/billing/* returns 404. On first boot, migration 0129 turns every still-active paid row into a permanent tier and deletes lapsed ones. But Stripe keeps charging subscribers until each subscription is cancelled at Stripe, and keeps retrying the dead webhook. Without the card, cancelling at Stripe BEFORE the update fires the live webhook, which deletes that user's tier. The card (from 09d6070) cancels at Stripe and keeps the tiers, but it also erases the Stripe IDs, so save them first. Take item 19's backup before using the card. The STRIPE_* lines in .env are harmless leftovers and are removed after the update.

```
awk -F= '/^STRIPE_[A-Z_]*=/{print $1, (length(substr($0,index($0,"=")+1))?"set":"empty")}' .env
```

```
docker exec zekktris-db psql -U commune -d commune -tAc "select count(*) from subscriptions where source='stripe' and (expires_at is null or expires_at > now())"
```

```
docker exec zekktris-db psql -U commune -d commune -tAc "select stripe_subscription_id from subscriptions where stripe_subscription_id is not null"
```

```
curl -s -o /dev/null -w '%{http_code}\n' https://www.zekktris.com/api/v1/billing/status
```

**You should see:** 1: names with 'set' or 'empty' only. Both empty and 2 printing 0: billing was never wired; nothing to do now. Otherwise copy the sub_… IDs from 3 into a private note. 4: 401 now (404 after the update).

**If not:** No card (Era 1a, or exactly 444fc62): cancel NOTHING at Stripe before the update; finish in after-update check 15. Card present (I3 printed a file): after item 19, sign in as admin, open Admin → Perks and click 'End all billing, keep tiers'. Then confirm in Stripe (live mode) that no active subscription is left, and delete the webhook endpoint ending in /api/v1/billing/webhook. No restart is needed. Do not edit .env for Stripe before the update.

### 21. Host agent: queued jobs, the maintenance-button freeze, other admins, and the window time

*Applies to:* All eras, all install types

**Why:** The host agent (cron, every minute) runs every request file in control/requests/ with root rights: update, restart, restore and so on. On Unraid the cron lines vanish at reboot, and a button pressed since then (Update, Restart, even Restore) stays queued. The new api hands that file to uid 1000 at first boot. The first agent run after the cron line comes back would then do it unattended: a full rebuild and restart, or a restore that replaces the database. Once the new code is on disk, a pressed Restart builds and starts it without your checks. Once master moves, a pressed Update on the old code runs the old single-'up -d' update. The switchover therefore pauses the agent before master moves and clears the queue twice. Scheduled backups (03:30 daily, 04:00 Sundays) only add noise during the switch.

```
crontab -l 2>/dev/null | grep -E '# zekktris-(agent|livekit|backup)'
```

```
for f in "$CTL"/requests/*.json; do [ -e "$f" ] && { printf '%s ' "$f"; grep -oE '"action"[[:space:]]*:[[:space:]]*"[a-z-]+"' "$f"; }; done; echo QUEUE-LISTED
```

```
tail -5 /var/log/zk-agent.log 2>/dev/null; date
```

**You should see:** 1: '* * * * * <folder>/scripts/agent.sh >> /var/log/zk-agent.log 2>&1 # zekktris-agent', '*/5 * * * * <folder>/ops/livekit-wan-watchdog.sh … # zekktris-livekit', and two '# zekktris-backup' lines if scheduled backups are on. Missing lines (after a reboot) change nothing for the update. 2: only QUEUE-LISTED, or file names with the action of each. 3: the last agent runs and the server time. Pick a quiet time outside 03:20–04:30 server time. Tell every admin of this instance not to press any Admin → Backup & Maintenance button, and not to start or stop the stack from the Unraid Docker or Compose Manager pages, until you say the update is finished.

**If not:** 2 lists a job you do not want run: rm -f "$CTL"/requests/*.json, then repeat 2 (only QUEUE-LISTED). The switchover repeats this check right before the agent comes back. Making cron lines survive reboots (User Scripts plugin, or a .cron file under /boot/config/plugins) is general Unraid knowledge, not part of the repository.

## Part 3 — Test the new release against your real settings (no downtime)

**Why:** This test tries the newly built images against your real .env before anything restarts. Nothing is published, nothing replaces a running container, and the old site keeps serving. It catches the problems that would otherwise appear only at the restart, all of which cause an outage: a proxy that crashes on a misspelt EDGE_PROXY or TLS_MODE; an api that refuses an invalid setting, a published or half-set LiveKit pair, or short JWT secrets; a migration that fails on your data or runs too long; and a LiveKit image that cannot run the new start script. The api's full 13 startup checks, migrations included, run in a one-off container that exits before it would serve. They run against a temporary COPY of your database (zk-scratch-db), never the live one: on the live database the migrations would apply while the old api still runs. A guard in the command refuses to run unless the database address is the copy. '--no-deps' starts nothing else, '--name' avoids the fixed container names, and none of these one-off containers publishes ports or answers to the service names. Run it after the build (A9/B8/C10) and before the final uploads pass. The test was checked here, without Docker, on a scratch Postgres 16 at the 7a70f90 schema: 126 → 133 migrations, all 13 checks passed, exit 0. With a published LiveKit key it showed '✗' plus 'refusing to start' and exit 1. Caddy validate was checked the same way: 'Valid configuration' for cloudflare and none, 'File to import not found … Caddyfile:67' for Cloudflare.

*PF1 (images are the new build):*

```
for s in api proxy; do printf '%s built=%s running=%s\n' "$s" "$(docker image inspect zekktris-$s:latest --format '{{.Id}}' | cut -c8-19)" "$(docker inspect zekktris-$s --format '{{.Image}}' | cut -c8-19)"; done; docker image inspect zekktris-api:latest --format '{{json .Config.Entrypoint}}'
```

*PF2 (what the new proxy will receive):*

```
$DC run --rm --no-deps -T --name zk-preflight-proxyenv --entrypoint printenv proxy EDGE_PROXY TLS_MODE SITE_ADDRESS HTTP_PORT
```

*PF3 (Caddy accepts the real settings):*

```
$DC run --rm --no-deps -T --name zk-preflight-proxy --entrypoint caddy proxy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
```

*PF4 (LiveKit image can run the new start script):*

```
$DC run --rm --no-deps -T --name zk-preflight-livekit --entrypoint /bin/sh livekit -c 'test -x /livekit-server || echo MISSING-livekit-server; for t in ip awk tr uname; do command -v $t >/dev/null || echo MISSING-$t; done; test -r /etc/livekit-entrypoint.sh || echo MISSING-entrypoint-file; echo LK-CHECKED'
```

*PF5 (temporary database container on the stack's network):*

```
NET="$(docker inspect zekktris-db --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"; echo "NET=$NET"; docker run -d --name zk-scratch-db --network "$NET" -e POSTGRES_USER=commune -e POSTGRES_DB=commune -e POSTGRES_PASSWORD=scratch postgres:16-alpine
```

*PF6 (wait until it is ready):*

```
for i in $(seq 1 60); do docker exec zk-scratch-db pg_isready -h 127.0.0.1 -U commune >/dev/null 2>&1 && { echo SCRATCH-READY; break; }; sleep 2; done
```

*PF7 (copy the live database into it, container to container, nothing on the host):*

```
docker exec zekktris-db pg_dump -U commune -d commune -Fc | docker exec -i zk-scratch-db sh -c 'cat > /tmp/live.dump' && docker exec zk-scratch-db pg_restore -U commune -d commune --no-owner /tmp/live.dump 2>&1 | tail -5; docker exec zk-scratch-db psql -U commune -d commune -tAc "SELECT count(*)||'|'||max(created_at) FROM drizzle.__drizzle_migrations"
```

*PF8 (the new api's 13 startup checks and migrations, on the copy):*

```
$DC run --rm --no-deps -T --name zk-preflight-checks -e DATABASE_URL=postgres://commune:scratch@zk-scratch-db:5432/commune -e REDIS_URL= -e UPLOAD_DIR=/tmp/zk-preflight-uploads --entrypoint node api --import tsx/esm --input-type=module -e 'const u = process.env.DATABASE_URL || ""; if (u.includes("@zk-scratch-db:5432/") === false) { console.log("STOPPED: not the scratch copy"); process.exit(2); } const m = await import("./src/startup-checks.ts"); await m.runStartupChecks(); process.exit(0);' 2>&1 | grep -vE '^[{}]|^  [a-z_]+: '
```

*PF9 (remove the copy and its data):*

```
docker rm -fv zk-scratch-db; docker ps -a --filter name=zk- --format '{{.Names}}'
```

*PF-lite (ONLY if item 18 showed too little room for PF5–PF8; it checks the settings but not the migrations):*

```
$DC run --rm --no-deps -T --name zk-preflight-env --entrypoint node api --import tsx/esm --input-type=module -e 'const { env } = await import("./src/env.ts"); const k = env.LIVEKIT_API_KEY || "", s = env.LIVEKIT_API_SECRET || ""; const bad = []; if ((k ? 1 : 0) + (s ? 1 : 0) === 1) bad.push("LIVEKIT-HALF-SET"); if (["devkey", "APIAMD7Sj5psuK4"].includes(k) || s === "devsecret-do-not-use-in-production-32chars") bad.push("LIVEKIT-PUBLISHED"); if (env.JWT_SECRET.length < 32 || env.JWT_REFRESH_SECRET.length < 32) bad.push("JWT-TOO-SHORT"); console.log(bad.length ? "PREFLIGHT-FAIL " + bad.join(" ") : "PREFLIGHT-ENV-OK"); process.exit(bad.length ? 1 : 0);'
```

**You should see:** PF1: for both api and proxy, built= differs from running=, and the entrypoint is ["/sbin/tini","--","/usr/local/bin/zekktris-api-entrypoint"]. PF2: four lines, cloudflare, none, :5550 (or your SITE_ADDRESS) and 5550 (or your HTTP_PORT). PF3: 'Valid configuration'. PF4: only LK-CHECKED. PF5: NET=<project>_zekktris, then a long container id. PF6: SCRATCH-READY. PF7: pg_restore prints nothing, or only warnings. The last line equals your ledger from I2/item 4. PF8: '[ 1/13] … ✓' through '[13/13] … ✓'. Check that '[ 5/13] Database connection' shows 'zk-scratch-db:5432/commune (Postgres 16.…)', which proves it used the copy. '[ 6/13] Database migrations … ✓' is followed by 'applied/verified in <N>ms', which is how long the first boot's migrations will take on your data. '[ 7/13] … 23 tables present, <your count + 9/8/7> migration(s) applied'. '[11/13] Voice / video (LiveKit)' shows 'configured (…)' or 'skipped'. The last lines read 'All 13 checks passed in …ms — starting HTTP server': the words are the report's fixed text, and this one-off exits right there and serves nothing. A line like 'APNs: cannot read …' only matters if you use iOS push. PF9: 'zk-scratch-db', then nothing. PF-lite: PREFLIGHT-ENV-OK.

**If not:** PF1: built= equals running=, or an old entrypoint: the build did not run or failed. Run '$DC build api proxy' again and read its last lines. PF2 or PF3 'File to import not found … edge-<value>.servers' or '<value>.global': EDGE_PROXY or TLS_MODE is misspelt or has a CR. Fix .env (items 6 and 7) and repeat PF2/PF3; nothing is running yet, so no restart is needed. PF4 MISSING-…: item 10's fix (LIVEKIT_IMAGE_TAG=v1.9.12), then repeat PF4. PF6 without SCRATCH-READY, or PF7 failing on space: run PF9 and use PF-lite. PF8 'STOPPED: not the scratch copy': nothing ran. Copy the command again exactly. PF8 '✗ Invalid environment configuration:' with '  - NAME: message' lines, or a check marked ✗ with the reason on the next line: fix that setting in .env (items 3–7), then repeat PF8. The copy already holds the migrations now, so PF8's step 6 will be quick on a repeat; to time the migrations again, run PF9 and PF5–PF8 again. PF8 'applied/verified in' above 60000ms (types A/B): STOP and ask (item 4). Leftover one-off containers after a Ctrl-C: docker ps -a --filter name=zk- --format '{{.Names}}', then docker rm -fv <name>. Always finish with PF9 before the restart: the copy holds all your data.

## Part 4 — The switch-over

### ALL TYPES: window rules and era notes (read before A, B or C)

#### W1. The window: one sitting, in this order

```
date; uptime
```

**You should see:** A time outside 03:20–04:30 server time. Checklist items 1–21 are done and item 19's backup was taken after the last .env edit. The whole window happens in one sitting, over ssh as root, inside tmux, in the Zekktris folder (I1): pausing the agent, moving master or pushing (A/B), putting the code on disk, the build, the preflight test, the final uploads pass, the fresh backup, and the restart. Nothing touches a running container before '▶ Restarting the api' (A/B) or step C14. Expected outage with uploads handed over beforehand: chat and the API are down for about 30–90 s while the new api runs its 13 checks and migrations and Docker's first health probe passes. The web page still loads through the old proxy during that time. Then the proxy and LiveKit are recreated: a few seconds of 502 through the tunnel, and calls in progress drop once. The database and cache containers are not recreated, because their settings are identical.

**If not:** If the server reboots during the window: once Unraid is back, run I1. Compose Manager autostart may already have run a single 'up -d' with the new images. Check with: docker ps -a --filter name=zekktris- --format '{{.Names}}: {{.Status}}'. Type A: run ./scripts/update.sh again; its marker makes it finish or roll back. Type B or C, or any proxy shown as 'Created': run the wait loop (C15), then $DC up -d. After a reboot, also repeat the safe.directory line from A3/B3, because /root is in RAM.

#### W2. Era 1a (91ec76a…774e20b; ledger 1784600330000 or 1784686730000)

```
docker exec zekktris-db psql -U commune -d commune -tAc "select count(*) from subscriptions where source='stripe' and (expires_at is null or expires_at > now())"
```

**You should see:** The number of live Stripe subscriptions. Cancel NOTHING at Stripe before the update; only save the IDs (item 20). Expect '! 9 new migration(s)' (0125…0133) from 91ec76a…18bf0bf, or '! 8 new migration(s)' (0126…0133) from cc57340…774e20b. The proxy build moves from caddy:2-alpine to the pinned caddy:2.11.4-alpine and adds /etc/caddy/modes: nothing to set, but Docker Hub must be reachable (item 18). TLS_MODE, PUBLIC_IP and SOURCE_CODE_URL are new to this .env: leave them absent (item 6). After the update, close out Stripe the same day (after-update check 15).

**If not:** A count above 0 with no saved IDs: run item 20 command 3 before going on.

#### W3. Era 1b (444fc62…64ba63a; ledger 1784773130000, no install.sh, no /etc/caddy/modes)

```
docker exec zekktris-proxy sh -c 'grep -l "End all billing" /srv/web/assets/*.js 2>/dev/null | head -1'
```

**You should see:** A file name = the card exists (09d6070 or later). Use it before the window, after item 19 (item 20). Nothing = exactly 444fc62: follow the Era 1a Stripe order. Expect '! 7 new migration(s)' (0127_reaction_roles_creator_set_null.sql … 0133_disappearing_messages.sql). The same Caddy image change and the same new TLS_MODE, PUBLIC_IP and SOURCE_CODE_URL notes as Era 1a apply.

**If not:** —

#### W4. Era 3 (d5dfda1…7a70f90; ledger 1784773130000, install.sh present, Caddy v2.11.4 with modes)

```
grep -E '^(TLS_MODE|PUBLIC_IP|SITE_ADDRESS|HTTP_PORT|HTTPS_PORT)=' .env; awk -F= '/^BOOTSTRAP_ADMIN_EMAIL=/{print $1, (length(substr($0,index($0,"=")+1))?"set":"empty")}' .env
```

**You should see:** TLS_MODE=none and PUBLIC_IP= from install.sh: leave them. SITE_ADDRESS/HTTP_PORT/HTTPS_PORT: if the site works today, leave them (item 9). BOOTSTRAP_ADMIN_EMAIL empty (item 12). The Stripe card exists (item 20). Expect '! 7 new migration(s)' (0127…0133). SOURCE_CODE_URL was ignored before 45c7295 (d5dfda1, b031660), so item 6 matters there.

**If not:** BOOTSTRAP_ADMIN_EMAIL set: item 12.

### A: git checkout with origin = github.com/Eternus-Nox/zekktris (https or ssh), any era

#### A1. Start the window

```
tmux new -A -s zk
```

```
(then run all of identify step I1)
```

**You should see:** The folder path, DC=[docker compose], and the four paths UP, CTL, DB and PRE.

**If not:** See I1.

#### A2. Pause the host agent and empty its queue, BEFORE master moves (no container is touched)

```
pgrep -af 'scripts/agent.sh' || echo NO-AGENT-JOB-RUNNING
```

```
C="$PRE/crontab-before.txt"; crontab -l > "$C" && test -s "$C" && grep -vF '# zekktris-agent' "$C" | crontab - && echo AGENT-PAUSED; crontab -l 2>/dev/null | grep -cF '# zekktris-agent'
```

```
for f in "$CTL"/requests/*.json; do [ -e "$f" ] && { printf '%s ' "$f"; grep -oE '"action"[[:space:]]*:[[:space:]]*"[a-z-]+"' "$f"; }; done; echo QUEUE-LISTED
```

```
rm -f "$CTL"/requests/*.json; ls "$CTL"/requests/ | grep -c '\.json$'
```

**You should see:** NO-AGENT-JOB-RUNNING; AGENT-PAUSED, then 0; QUEUE-LISTED (with any queued action shown before it); 0. The admin buttons now only queue a file that nothing runs. Scheduled backups keep their own cron lines.

**If not:** pgrep shows a running agent.sh: a job is in progress. Wait and repeat it every minute until it prints NO-AGENT-JOB-RUNNING. 'no crontab for root' or no AGENT-PAUSED while the count prints 0: the agent was already off (a reboot); that is fine. Count still 1: STOP and ask. Never run 'crontab -r'.

#### A3. Move master on GitHub now, then check the server can fetch it

```
(done by whoever has GitHub access) merge a pull request fix/health-check → master with 'Create a merge commit', OR from a developer clone: git push origin fix/health-check:master
```

```
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$PWD" || git config --global --add safe.directory "$PWD"; git status >/dev/null && echo GIT-OK
```

```
GIT_TERMINAL_PROMPT=0 git fetch origin && git merge-base --is-ancestor HEAD origin/master && git merge-base --is-ancestor d1d3e3a origin/master && echo READY
```

**You should see:** GIT-OK, then READY.

**If not:** Authentication errors: item 16 (token). READY missing because of the d1d3e3a test: master was squashed or rebased, or not moved yet; ask. READY missing because of the HEAD test: STOP and ask.

#### A4. Nothing stands in the way

```
git status --short --untracked-files=no
```

```
comm -12 <(git diff --name-only HEAD | sort) <(git diff --name-only HEAD origin/master | sort)
```

```
git diff --name-only --diff-filter=A HEAD origin/master | while read -r f; do [ -e "$f" ] && echo "IN THE WAY: $f"; done; echo CHECKED
```

**You should see:** 1: nothing, or ' M ops/livekit.yaml'. 2: nothing. 3: only CHECKED.

**If not:** Item 17.

#### A5. Write down where you start from

```
git rev-parse HEAD > "$(git rev-parse --git-path zekktris-before-update)" && cat "$(git rev-parse --git-path zekktris-before-update)"
```

```
git ls-tree --name-only "$(cat "$(git rev-parse --git-path zekktris-before-update)")" packages/db/migrations/ | grep -c '\.sql$'
```

**You should see:** 1: the old sha (write it down). 2: 124, 125 or 126, matching I2.

**If not:** If I6 found the new code already on disk, use instead: git rev-parse "$OLD" > "$(git rev-parse --git-path zekktris-before-update)" && cat "$(git rev-parse --git-path zekktris-before-update)". 2 printing 133 means HEAD is already the new code: go back to I6.

#### A6. Put the new code on disk and mark the update as started (files only; no container is touched)

```
git merge --ff-only origin/master && cp "$(git rev-parse --git-path zekktris-before-update)" "$(git rev-parse --git-path zekktris-update-unfinished)" && echo CODE-ON-DISK
```

**You should see:** 'Updating <old>..<new>', 'Fast-forward', a file list, then CODE-ON-DISK. The marker tells the NEW update.sh that this is an update from the old sha. It then backs up, builds, starts the api first, waits out the handover, and rolls back to the old sha by itself on failure.

**If not:** New code already on disk (I6): skip the merge and run only: cp "$(git rev-parse --git-path zekktris-before-update)" "$(git rev-parse --git-path zekktris-update-unfinished)" && echo MARKER-WRITTEN. 'Not possible to fast-forward': STOP and ask.

#### A7. The new compose file renders with your settings

```
grep -c wait_for_api scripts/update.sh
```

```
$DC config -q && echo CONFIG-OK
```

```
$DC config | grep -E 'source: .*/db$|EDGE_PROXY:|LIVEKIT_BIND_ADDRESSES:|TLS_MODE:|SITE_ADDRESS:'
```

```
$DC config --services | sort | tr '\n' ' '; echo
```

```
$DC config | sed -n '/^  proxy:/,/^  [a-z]*:$/p' | grep -A3 '^    networks:'
```

**You should see:** 1: 3. 2: CONFIG-OK. 3: 'source: <the DB path from I1>', 'EDGE_PROXY: cloudflare', 'LIVEKIT_BIND_ADDRESSES: ""' (or all), 'TLS_MODE: none', and 'SITE_ADDRESS: :5550' (or yours). 4: 'api cache db livekit proxy'. 5: zekktris, plus the extra network if item 9 created the override.

**If not:** Wrong db path or anything missing: abandon (A-abandon) and ask. Never paste the full '$DC config' output.

#### A8. Dry run of the new update script

```
GIT_TERMINAL_PROMPT=0 ./scripts/update.sh --check
```

**You should see:** '! the update from <old short sha> did not finish — the next update picks it up again', the commit list, '! 9/8/7 new migration(s) — these apply at boot …' with the file names, possibly '✓ local edits kept across the update: ops/livekit.yaml', no EDGE_PROXY warning, and '✓ Check only. Nothing was changed.'

**If not:** '✓ already up to date': the marker is missing. Redo A5/A6 (the I6 case) and repeat; never go on. '! upstream unreachable': fix the fetch (item 16) and repeat. A line about EDGE_PROXY: item 7.

#### A9. Build the new images (the old site keeps serving)

```
$DC build api proxy
```

**You should see:** It ends without 'ERROR' or 'failed to solve'.

**If not:** Network or rate-limit errors: wait and run it again. Still failing: A-abandon, then ask. Nothing live has changed.

#### A10. Preflight test

```
Run PF1–PF9 from the preflight test (or PF1–PF4 plus PF-lite).
```

**You should see:** Every PF step as expected, and PF9 done.

**If not:** Fix as the preflight says. If you cannot, use A-abandon.

#### A11. Final uploads pass

```
find "$UP" -mindepth 1 ! -uid 1000 -exec chown -h 1000:1000 {} + ; chown -h 1000:1000 "$UP" && find "$UP" ! -uid 1000 | wc -l && stat -c %u "$UP"
```

**You should see:** 0, then 1000 (it only touches files uploaded since item 14).

**If not:** Item 14.

#### A12. Fresh verified backup, right before the step that cannot be undone

```
TMPDIR="$PRE/tmp" ./scripts/backup.sh --no-uploads --keep 0 "$PRE" 2>&1 | grep -E 'Backup complete|Size:|✗'
```

```
TMPDIR="$PRE/tmp" ./scripts/restore.sh --check "$(ls -1t "$PRE"/zekktris-*.tar.gz | head -1)" 2>&1 | tail -3
```

**You should see:** '✓ Backup complete: <PRE>/zekktris-<now>.tar.gz', then '✓ Bundle verified. Nothing was changed.' The time in the file name is a minute or two ago. These are the new scripts; they work against the running old stack.

**If not:** Do not go on to A13 unless both lines printed.

#### A13. Run the update (the restart and the migrations happen here)

```
(optional, a second tmux window: Ctrl-b c, then) $DC logs -f --tail 20 api
```

```
GIT_TERMINAL_PROMPT=0 TMPDIR="$PRE/tmp" ./scripts/update.sh 2>&1 | tee -a ../zekktris-update-$(date +%Y%m%d).log
```

**You should see:** In order: '! the update from … did not finish — picking it up again', the commit and migration list, '▶ Taking a pre-update backup', '✓ backup taken', '▶ Pulling <sha>', '▶ Rebuilding' (quick, mostly from cache), '▶ Restarting the api', '▶ Waiting for startup checks (up to about 3 minutes)', possibly '! the api is handing uploads/ …', '▶ Starting the rest of the stack', '✓ Updated to <sha> and healthy.'

**If not:** '! upstream unreachable — deploying the working tree as it stands' near the top: press Ctrl-C at once, before '▶ Restarting the api'. Fix the fetch (item 16) and run A13 again. '✗ Update failed and was rolled back': the rollback section (automatic case). '…the previous build did not come up healthy either': the rollback section (manual A), and ask. 'the api is healthy on the new code, but the rest of the stack did not start': read the error above it, then run ./scripts/update.sh again (it only starts the rest).

#### A14. Immediately: the after-update checks

```
(after_update_checks, in order)
```

**You should see:** All pass.

**If not:** The rollback section.

#### A-abandon (only between A6 and A13; nothing was restarted)

```
git reset --keep "$(cat "$(git rev-parse --git-path zekktris-before-update)")" && rm -f "$(git rev-parse --git-path zekktris-update-unfinished)" && echo CODE-BACK
```

```
$DC build api proxy
```

```
docker rm -fv zk-scratch-db 2>/dev/null; echo CLEAN
```

**You should see:** CODE-BACK. The build re-tags the images to the old code (run it if A9 ran). CLEAN.

**If not:** Leave the agent PAUSED until the retry. Master has moved, so Admin → Update on the old code would run the old single-'up -d' update. Scheduled backups still run.

### B: git checkout with no origin that receives pushes (the old update.sh says zekktris.com is set up this way)

#### B0. Recommended: turn it into type A, which can roll back by itself

```
read -rsp 'GitHub token: ' T; echo; git -c safe.directory="$PWD" remote add origin "https://x-access-token:$T@github.com/Eternus-Nox/zekktris.git"; unset T
```

```
GIT_TERMINAL_PROMPT=0 git -c safe.directory="$PWD" fetch origin && git -c safe.directory="$PWD" merge-base --is-ancestor HEAD origin/master && echo FAST-FORWARD-OK
```

**You should see:** FAST-FORWARD-OK. Then follow type A from A1 and ignore B1–B12. Future pushes from the development machine still work.

**If not:** No token, or FAST-FORWARD-OK missing: stay type B (B1–B12).

#### B1. Start the window

```
tmux new -A -s zk
```

```
(then run all of identify step I1)
```

**You should see:** As in A1.

**If not:** See I1.

#### B2. Pause the host agent and empty its queue

```
(the four commands of A2)
```

**You should see:** As in A2.

**If not:** As in A2.

#### B3. Write down where you start from

```
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$PWD" || git config --global --add safe.directory "$PWD"; git status >/dev/null && echo GIT-OK
```

```
git rev-parse HEAD > ../zekktris-before-update.txt && cat ../zekktris-before-update.txt; git ls-tree --name-only HEAD packages/db/migrations/ | grep -c '\.sql$'
```

**You should see:** GIT-OK; the old sha (write it down); 124, 125 or 126, matching I2.

**If not:** New code already on disk (I6): git rev-parse "$OLD" > ../zekktris-before-update.txt && cat ../zekktris-before-update.txt, then skip B4–B5.

#### B4. A clean tree, so the push is accepted

```
git status --short --untracked-files=no
```

```
cp -p ops/livekit.yaml ../livekit.yaml.mine && git checkout -- ops/livekit.yaml && echo SAVED-ASIDE
```

**You should see:** 1: nothing (then skip the second command), or ' M ops/livekit.yaml' (then run it: SAVED-ASIDE, and 1 prints nothing).

**If not:** Any other file: item 17.

#### B5. The pusher pushes the release; nothing restarts

```
(on the development machine, the usual way, for example) git push <this-server-remote> fix/health-check:master
```

```
git log -1 --format='%h %s'; git merge-base --is-ancestor d1d3e3a HEAD && echo TARGET-ON-DISK; git status --short --untracked-files=no
```

**You should see:** d1d3e3a (or the merge commit) and TARGET-ON-DISK; status prints nothing.

**If not:** Push refused with 'dubious ownership': repeat B3's first command (an Unraid reboot forgets it), then push again. Refused because the tree is not clean: B4.

#### B6. Put your LiveKit edit back (only if B4 printed SAVED-ASIDE)

```
cp -p ../livekit.yaml.mine ops/livekit.yaml && git status --short --untracked-files=no
```

**You should see:** ' M ops/livekit.yaml'.

**If not:** —

#### B7. The new compose file renders with your settings

```
(the five commands of A7)
```

**You should see:** As in A7.

**If not:** B-abandon, and ask.

#### B8. Build the new images

```
$DC build api proxy
```

**You should see:** Ends without errors.

**If not:** As in A9 (B-abandon if it keeps failing).

#### B9. Preflight test

```
PF1–PF9 (or PF1–PF4 plus PF-lite)
```

**You should see:** As in the preflight.

**If not:** As in the preflight.

#### B10. Final uploads pass

```
(the A11 command)
```

**You should see:** 0, then 1000.

**If not:** Item 14.

#### B11. Fresh verified backup, right before the restart

```
(the two A12 commands)
```

**You should see:** As in A12.

**If not:** Do not go on unless both lines printed.

#### B12. Run the update (no automatic rollback in this mode)

```
TMPDIR="$PRE/tmp" ./scripts/update.sh 2>&1 | tee -a ../zekktris-update-$(date +%Y%m%d).log
```

**You should see:** '✓ no upstream — this checkout receives pushes directly', '✓ deploying <short sha>', possibly a 'migrations added in the last 7 days' list (it can be incomplete; that is harmless), '✓ backup taken', '▶ Rebuilding', '▶ Restarting the api', '▶ Waiting for startup checks …', '▶ Starting the rest of the stack', '✓ Updated to <sha> and healthy.' Then the after-update checks.

**If not:** 'The rebuild did not come up healthy. The code is unchanged…': in this case the code DID change. Use the type-B rollback.

#### B-abandon (only before B12)

```
git reset --keep "$(cat ../zekktris-before-update.txt)" && echo CODE-BACK
```

```
$DC build api proxy
```

```
docker rm -fv zk-scratch-db 2>/dev/null; crontab "$PRE/crontab-before.txt" && echo AGENT-BACK
```

**You should see:** CODE-BACK, the images rebuilt (if B8 ran), AGENT-BACK. Tell the pusher not to push again until the retry.

**If not:** Ask.

### C: release folder with no .git (zip install)

#### C1. Start the window

```
tmux new -A -s zk
```

```
(then run all of identify step I1)
```

**You should see:** As in A1.

**If not:** See I1.

#### C2. Pause the host agent and empty its queue

```
(the four commands of A2)
```

**You should see:** As in A2.

**If not:** As in A2.

#### C3. The old files have no hand edits that the copy would erase

```
md5sum docker-compose.yml ops/Caddyfile ops/Dockerfile.web ops/Dockerfile.api ops/livekit.yaml
```

```
$DC config --services | sort | tr '\n' ' '; echo; docker port zekktris-proxy; docker inspect zekktris-proxy --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

**You should see:** 1: every value matches I7's table (ops/livekit.yaml may differ: that is your allowed edit; note whether it does). 2: 'api cache db livekit proxy', only ports 5550/5551 (or yours from item 9), and only '<project>_zekktris' (plus a network from your override).

**If not:** Anything else: STOP and ask.

#### C4. Keep a copy of the old code

```
tar -czf ../zekktris-code-before-update.tgz apps packages ops scripts marketing docker-compose.yml package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .dockerignore .env.example && tar -tzf ../zekktris-code-before-update.tgz | wc -l
```

**You should see:** A number in the thousands.

**If not:** Any 'Cannot stat' error: STOP and ask.

#### C5. Download the exact release

```
(Option 1, in a browser signed in to GitHub) https://github.com/Eternus-Nox/zekktris/archive/d1d3e3addbbda347bd78496f55d66b9be9052a9b.tar.gz, then copy that file next to the Zekktris folder as zk-new.tgz (for example through the appdata share)
```

```
(Option 2, on the server, with item 16's read-only token) read -rsp 'GitHub token: ' T; echo; curl -fL -H "Authorization: Bearer $T" -o ../zk-new.tgz https://api.github.com/repos/Eternus-Nox/zekktris/tarball/d1d3e3addbbda347bd78496f55d66b9be9052a9b; unset T; ls -l ../zk-new.tgz
```

```
zcat ../zk-new.tgz | head -c 4096 | grep -ao 'comment=[0-9a-f]*'
```

**You should see:** The file exists (tens of MB). The last command prints comment=d1d3e3addbbda347bd78496f55d66b9be9052a9b. If it prints nothing, go on: C6 checks the content.

**If not:** 404 or 401: the token or sign-in lacks access to the private repo.

#### C6. Unpack next to the folder and check it

```
rm -rf ../zk-new && mkdir ../zk-new && tar -xzf ../zk-new.tgz -C ../zk-new && NEW="$(ls -d ../zk-new/*/ | head -1)" && echo "NEW=$NEW"
```

```
ls "$NEW"packages/db/migrations | grep -c '\.sql$'; grep -c wait_for_api "$NEW"scripts/update.sh; md5sum "$NEW"docker-compose.yml
```

**You should see:** NEW=../zk-new/<one folder>/; then 133; 3; and 96c08b65c165fd46002782ab4647029e.

**If not:** Other values: wrong download; repeat C5. NEW is lost in a new terminal: repeat the NEW=… part.

#### C7. Copy the new code over the old one (files only; no container is touched)

```
cp -a "$NEW". . && echo COPIED
```

```
tar -xzf ../zekktris-code-before-update.tgz ops/livekit.yaml && echo LIVEKIT-YAML-KEPT
```

```
rm -f apps/api/src/routes/billing.ts apps/api/src/services/billing.ts apps/web/src/app/AdminVoiceLiveTab.tsx apps/web/src/lib/useDesktopIdleStatus.ts; chmod 755 scripts/*.sh scripts/lib/*.sh ops/*.sh install.sh; echo CLEANED
```

**You should see:** COPIED; LIVEKIT-YAML-KEPT (run the second command only if C3 showed your own ops/livekit.yaml edit); CLEANED. .env, db/, uploads/, backups/, control/, secrets/*.p8 and docker-compose.override.yml are not in the release and stay untouched. The four removed files would otherwise break the web build's type check.

**If not:** Errors: C-abandon.

#### C8. Check the files

```
ls packages/db/migrations/0133_disappearing_messages.sql ops/livekit-entrypoint.sh scripts/lib/start-stack.sh ops/caddy-modes/edge-cloudflare.servers; ls apps/api/src/routes/billing.ts 2>&1; md5sum docker-compose.yml
```

**You should see:** Four paths listed; 'No such file or directory' for billing.ts; 96c08b65c165fd46002782ab4647029e.

**If not:** C-abandon, and ask.

#### C9. The new compose file renders with your settings

```
(A7 commands 2–5)
```

**You should see:** As in A7.

**If not:** C-abandon, and ask.

#### C10. Build the new images (the old site keeps serving)

```
$DC build api proxy
```

**You should see:** Ends without errors.

**If not:** Run it again. Still failing: C-abandon (nothing live has changed).

#### C11. Preflight test

```
PF1–PF9 (or PF1–PF4 plus PF-lite)
```

**You should see:** As in the preflight.

**If not:** As in the preflight.

#### C12. Final uploads pass

```
(the A11 command)
```

**You should see:** 0, then 1000.

**If not:** Item 14.

#### C13. Fresh verified backup, right before the restart (this is your only automatic-free safety net)

```
(the two A12 commands)
```

**You should see:** As in A12.

**If not:** Do not go on to C14 unless both lines printed.

#### C14. The restart: the api alone first (the migrations apply now)

```
$DC up -d api
```

**You should see:** 'Container zekktris-api Recreated/Started', with db and cache shown as running (not recreated).

**If not:** An error: read it. The old proxy still serves the page. Rollback C if it cannot be fixed.

#### C15. Wait for the api, and see failures as they happen

```
for i in $(seq 1 240); do H="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' zekktris-api 2>/dev/null)"; R="$(docker inspect -f '{{.RestartCount}}' zekktris-api 2>/dev/null)"; echo "$(date +%T) health=${H:-none} restarts=${R:-none}"; [ -z "$R" ] && { echo NO-API-CONTAINER; break; }; docker logs --tail 60 zekktris-api 2>&1 | grep -E -A1 'api-entrypoint|✗|refusing to start|^  - ' | grep -vE '^--$|^═|^$' | tail -6; [ "$H" = healthy ] && { echo API-HEALTHY; break; }; [ "$R" -gt 0 ] && { echo API-CRASHED; break; }; sleep 15; done
```

**You should see:** A line every ~15 s, then API-HEALTHY. While uploads are still being handed over, 'health=unhealthy restarts=0' together with "api-entrypoint: handing /data/uploads to 'node'" is normal. It ends with a 'handed …' line and turns healthy at the next probe.

**If not:** API-CRASHED: the api exited and Docker restarted it. The lines above show why: a '✗ …' check with its reason, '✗ Invalid environment configuration:' with '  - NAME: message', or 'refusing to start'. Fix that setting in .env, run C14 again, then this loop. No fix: rollback C. NO-API-CONTAINER: C14 did not create it; read C14's output.

#### C16. Start the rest of the stack

```
$DC up -d
```

```
docker ps --filter name=zekktris- --format '{{.Names}}: {{.Status}}'
```

**You should see:** Five lines, all 'Up', zekktris-api '(healthy)'. Then the after-update checks.

**If not:** After-update check 1.

#### C-abandon (only before C14)

```
test -f ../zekktris-code-before-update.tgz && test -d apps/api && rm -rf apps packages ops scripts marketing && tar -xzf ../zekktris-code-before-update.tgz && echo CODE-RESTORED
```

```
$DC build api proxy
```

```
docker rm -fv zk-scratch-db 2>/dev/null; crontab "$PRE/crontab-before.txt" && echo AGENT-BACK
```

**You should see:** CODE-RESTORED, the images rebuilt (if C10 ran; otherwise the tags still match), AGENT-BACK. Leftover new top-level files (install.sh, LICENSE, docs) are harmless.

**If not:** Ask.

## Part 5 — Checks right after the update

- 1. Within a minute of '✓ Updated … and healthy.' (or C16): docker ps --filter name=zekktris- --format '{{.Names}}: {{.Status}}' → five lines, all 'Up', with zekktris-api 'Up … (healthy)'. Run it again 30 s later: zekktris-proxy and zekktris-livekit must not show 'Restarting'. If zekktris-proxy is missing, run docker ps -a --filter name=zekktris-proxy --format '{{.Names}}: {{.Status}}'. 'Created' means it never started: run the C15 wait loop until API-HEALTHY, then $DC up -d.

- 2. The new proxy is healthy: docker inspect -f '{{.RestartCount}} {{.State.Status}}' zekktris-proxy → '0 running'. docker logs zekktris-proxy 2>&1 | grep -E 'Error: |File to import not found' → nothing. docker exec zekktris-proxy printenv EDGE_PROXY → cloudflare. (Do not grep the proxy log for 'error': it logs every request, and /livekit errors while LiveKit restarts are normal.) If it restarts: fix EDGE_PROXY or TLS_MODE in .env, then $DC up -d proxy (never 'restart', which does not re-read .env).

- 3. Uploads written during the switch (run I1 first in a new terminal): find "$UP" -mindepth 1 ! -uid 1000 -exec chown -h 1000:1000 {} + ; find "$UP" ! -uid 1000 | wc -l → 0.

- 4. The site really answers through the tunnel: curl -sL -o /dev/null -w '%{http_code}\n' https://www.zekktris.com/ → 200; same for https://zekktris.com/ → 200. curl -s https://www.zekktris.com/health → {"status":"ok","uptimeSeconds":<small>,"version":"unknown"}. curl -s -o /dev/null -w '%{http_code}\n' https://www.zekktris.com/api/v1/billing/status → 404 (only the new code answers 404). A 502 that lasts: the tunnel Service points at the old container address (item 9). Change it to http://localhost:<HTTP_PORT> or http://<LAN IP>:<HTTP_PORT> in Cloudflare.

- 5. Startup checks and migrations: docker logs zekktris-api 2>&1 | grep -E 'applied/verified in|tables present|checks passed|failed in' → 'applied/verified in …ms', '23 tables present, <item-4 count + 9, 8 or 7> migration(s) applied', and 'All 13 checks passed in …ms — starting HTTP server'. Then the item-4 ledger query → <that same count>|1785377930000. The max must be exactly 1785377930000; the count depends on where your database started. Columns: docker exec zekktris-db psql -U commune -d commune -tAc "SELECT table_name||'.'||column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('chosen_status','chosen_status_auto','muted_at','e2ee_purge_proof_hash','moved_from_channel_id','expire_after_seconds') ORDER BY 1" → 6 lines: channels.e2ee_purge_proof_hash, messages.expire_after_seconds, users.chosen_status, users.chosen_status_auto, users.muted_at, voice_states.moved_from_channel_id.

- 6. The api no longer runs as root: docker top zekktris-api -eo pid,uid,args | grep -v tini | grep 'node --import' → '<pid> 1000 node --import tsx/esm src/index.ts'. Without the filter you would also see tini's line, '0 /sbin/tini -- /usr/local/bin/zekktris-api-entrypoint node --import tsx/esm src/index.ts'. tini stays root by design and is normal. Only a '0 node --import …' line means it fell back to root. docker logs zekktris-api 2>&1 | grep api-entrypoint → at most the 'handing/handed /data/control/requests' lines; never 'running as root as before' or 'could not hand'.

- 7. Real visitor addresses: open https://www.zekktris.com in a browser, then ./scripts/doctor.sh 2>&1 | grep -A1 '^Client IP' → '✓ the API sees the real visitor address (<your public IP>)'.

- 8. Voice: docker logs zekktris-livekit 2>&1 | grep livekit-entrypoint | tail -1 → 'livekit-entrypoint: port 7880 listens on: 127.0.0.1 172.17.0.1'. A line ending '… no docker0 address found — port 7880 listens on every interface …' is also fine, and with LIVEKIT_BIND_ADDRESSES=all there is no line. docker inspect -f '{{.RestartCount}} {{.State.Status}}' zekktris-livekit → '0 running'. docker logs zekktris-api 2>&1 | grep -A1 'Voice / video' | tail -2 → a ✓ line, then 'configured (bundled SFU, same-origin /livekit)' or 'configured (external SFU)'. Bundled only: curl -s -o /dev/null -w '%{http_code}\n' https://www.zekktris.com/livekit/ → anything except 502 or 504. Finish with a test call between a LAN device and a phone on mobile data.

- 9. Push and mail: docker logs zekktris-api 2>&1 | grep -E 'APNs: (configured|cannot|failed)' → 'APNs: configured (key …, topic …, production)' if you use iOS push. docker exec zekktris-api sh -c 'test -n "$FCM_PROJECT_ID" && test -n "$FCM_CLIENT_EMAIL" && test -n "$FCM_PRIVATE_KEY" && echo FCM-set' → FCM-set if you use Android push. Item 13 command 2 → identical to before. Request a password reset for your own account at https://www.zekktris.com/forgot-password: the mail arrives, and Resend → Logs shows it.

- 10. Tunnel and ports: docker port zekktris-proxy → the same as in item 9. docker inspect zekktris-proxy --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} ip={{$v.IPAddress}} gateway={{$v.Gateway}}{{println}}{{end}}' → the same network names (plus your override network); ip= may have changed, which is fine because the tunnel now targets the host or a name (check 4 proved it).

- 11. In a browser with the developer console open (F12 → Console), reload https://www.zekktris.com: the sign-in or chat appears (not a blank page), and there are no 'Refused to load the script' or 'Refused to execute inline script … Content Security Policy' lines that mention rocket-loader, cloudflareinsights, zaraz or /cdn-cgi/. A blank page: turn Rocket Loader off (item 11) and reload with Ctrl+Shift+R. curl -sI https://www.zekktris.com/ | grep -i cf-cache-status → not HIT; if it says HIT or the page looks old, purge everything in Cloudflare's Caching settings.

- 12. Type A only, the update finished cleanly: test -e "$(git rev-parse --git-path zekktris-update-unfinished)" || echo marker-cleared → marker-cleared. GIT_TERMINAL_PROMPT=0 ./scripts/update.sh --check → '✓ already up to date (…)'.

- 13. Host agent back, with an empty queue: for f in "$CTL"/requests/*.json; do [ -e "$f" ] && { printf '%s ' "$f"; grep -oE '"action"[[:space:]]*:[[:space:]]*"[a-z-]+"' "$f"; }; done; echo QUEUE-LISTED → only QUEUE-LISTED. Otherwise run rm -f "$CTL"/requests/*.json unless you really want that job, and repeat. Then crontab "$PRE/crontab-before.txt" && ./scripts/doctor.sh --fix (it adds any line a reboot removed). crontab -l | grep -E '# zekktris-(agent|livekit|backup)' → the lines from item 21. A minute later, tail -3 /var/log/zk-agent.log → no 'refusing to run'. stat -c '%u %a %n' "$CTL" "$CTL/status" "$CTL/requests" → '0 755 …/control', '0 755 …/control/status', '1000 … …/control/requests'. Tell the other admins the buttons may be used again.

- 14. The whole health report: ./scripts/doctor.sh → read every ✗ line (doctor.sh without --fix changes nothing).

- 15. Stripe close-out (Era 1a, or 444fc62, or any era where item 20 found live rows): with billing/status returning 404, cancel every saved sub_… ID in the Stripe dashboard (live mode), delete the webhook endpoint ending in /api/v1/billing/webhook (live and test mode), and roll the secret key. Every era, then: sed -i -E '/^STRIPE_(SECRET_KEY|WEBHOOK_SECRET)=/d' .env; grep -c '^STRIPE_' .env → 0. No restart is needed (the new compose no longer passes them). The item-20 live-row count → 0.

- 16. Admin: the item-12 admin count → 1 or more. If 0: $DC exec -w /app/apps/api api node --import tsx/esm scripts/create-admin.ts --email '<your account email>' --promote-unverified.

- 17. If the LiveKit Cloud key APIAMD7Sj5psuK4 still exists in any LiveKit Cloud project, delete it there.

- 18. Optional: SOURCE_CODE_URL defaults to https://github.com/Eternus-Nox/zekktris, which is private, so the AGPL source link on the Terms and Privacy pages leads visitors to a 404. To fix it, make the repo public, or set SOURCE_CODE_URL to a public copy (a full https:// URL) and run $DC up -d api later.

- 19. Clean up: rm -rf "$PRE/tmp" now. Keep the $PRE bundles, ../zekktris-update-<date>.log, ../zekktris-code-before-update.tgz (type C) and any ../zekktris-db-after-update-* folder until the site has run normally for a few days, then delete them: the bundles and the database copy hold every secret. Type C can also delete ../zk-new and ../zk-new.tgz.

- 20. Other installs that follow master (item 16): give each one this guide now.


## Part 6 — If it goes wrong (rollback)

- R0. The decision, and what stays. A rollback puts back the old code and images. The 7–9 migrations stay applied in every case. They only add nullable columns or columns with defaults, one table (staff_notes, Era 1a), check constraints that those defaults satisfy and two indexes, and they rewrite Stripe rows, so the old code is expected to run on them. That combination was not tested. Restore the database (R5) only if the old code misbehaves on it. A restore loses everything written after the bundle was taken. The wait loop used below is exactly the C15 command: for i in $(seq 1 240); do H="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' zekktris-api 2>/dev/null)"; R="$(docker inspect -f '{{.RestartCount}}' zekktris-api 2>/dev/null)"; echo "$(date +%T) health=${H:-none} restarts=${R:-none}"; [ -z "$R" ] && { echo NO-API-CONTAINER; break; }; docker logs --tail 60 zekktris-api 2>&1 | grep -E -A1 'api-entrypoint|✗|refusing to start|^  - ' | grep -vE '^--$|^═|^$' | tail -6; [ "$H" = healthy ] && { echo API-HEALTHY; break; }; [ "$R" -gt 0 ] && { echo API-CRASHED; break; }; sleep 15; done

- R1. Type A, automatic: update.sh rolls back by itself on a build failure ('✗ Update failed: the build did not complete. Nothing was restarted …') or a health failure ('! the new build did not come up healthy — rolling the code back to <sha>' … '✗ Update failed and was rolled back'). Check: docker inspect zekktris-api --format '{{json .Config.Entrypoint}}' → ["/sbin/tini","--"]; the I2 ledger query (1785377930000 = the migrations applied before it refused); curl -sL -o /dev/null -w '%{http_code}\n' https://www.zekktris.com/ → 200. Read why with: $DC logs api --tail 80 (or grep the log in ../zekktris-update-<date>.log). Leave the agent PAUSED: master has moved, and Admin → Update on the old code would run the old single-'up -d' update. Scheduled backups keep running.

- R2. Type A, by hand (later problems, or '…the previous build did not come up healthy either'): run I1, then git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$PWD" || git config --global --add safe.directory "$PWD"; then git reset --keep "$(cat "$(git rev-parse --git-path zekktris-before-update)")" && rm -f "$(git rev-parse --git-path zekktris-update-unfinished)" && echo CODE-BACK; then $DC build api proxy (old-code builds are slower: the old .dockerignore sends db/ and uploads/ to the build); then $DC up -d api; then the wait loop until API-HEALTHY; then $DC up -d. Leave the agent paused (R1).

- R3. Type B, by hand: as R2, but with git reset --keep "$(cat ../zekktris-before-update.txt)" && echo CODE-BACK. Tell whoever pushes not to push again until the cause is fixed. The agent may come back afterwards: crontab "$PRE/crontab-before.txt".

- R4. Type C, by hand: test -f ../zekktris-code-before-update.tgz && test -d apps/api && rm -rf apps packages ops scripts marketing && tar -xzf ../zekktris-code-before-update.tgz && echo CODE-RESTORED. This touches code folders only; your data in db/, uploads/, backups/, control/ and .env is untouched. Then $DC build api proxy; $DC up -d api; the wait loop until API-HEALTHY; $DC up -d. The agent may come back afterwards: crontab "$PRE/crontab-before.txt".

- R5. Database restore (ONLY after R1–R4 put the OLD code back, and only if it misbehaves on the migrated database). Never restore while the new code is on disk: its api would apply the migrations again. Do not use 'restore.sh --force' here. In Era 1a, migration 0125's staff_notes table references users and is not in the old dump, so pg_restore --clean cannot drop users: every other table goes back, users silently does not, and the script still reports success. Restore into an EMPTY data folder instead, for every era. (a) Pick the bundle: ls -lt "$PRE"/zekktris-*.tar.gz "${UP%/uploads}"/backups/zekktris-*.tar.gz 2>/dev/null | head -4. Use the newest one taken BEFORE '▶ Restarting the api' (or C14): A12/B11/C13's bundle in $PRE, or for A/B update.sh's own bundle in backups/, which is seconds newer (compare with the time of '▶ Restarting the api' in ../zekktris-update-<date>.log). (b) TMPDIR="$PRE/tmp" ./scripts/restore.sh --check <that bundle> 2>&1 | tail -3 → '✓ Bundle verified. Nothing was changed.' (otherwise take the other bundle). (c) $DC stop api && $DC stop db && echo STOPPED. (d) mv "$DB" "$(dirname "$PWD")/zekktris-db-after-update-$(date +%Y%m%d-%H%M)" && mkdir -p "$DB" && echo MOVED-ASIDE (nothing is deleted; keep that folder for some days). (e) $DC up -d db; for i in $(seq 1 60); do docker exec zekktris-db pg_isready -h 127.0.0.1 -U commune >/dev/null 2>&1 && { echo DB-READY; break; }; sleep 2; done. Postgres creates a fresh, empty database with the DB_PASSWORD from .env. (f) docker exec zekktris-db psql -U commune -d commune -tAc "select to_regclass('public.users')" → an empty line (empty database). (g) TMPDIR="$PRE/tmp" ./scripts/restore.sh <that bundle> (no --force). Expect '✓ <N> users restored', then 'Restore complete and the API is healthy.' The old restore.sh starts the whole stack itself. (h) The I2 ledger query → the pre-update value again. To undo the restore instead: stop db, put the moved folder back in place of "$DB", start db.

- R6. After any rollback, before a retry: repeat item 14 command 2, because the old root api makes new uploads root-owned again. Repeat the A2 queue check. Find the cause from the saved log (../zekktris-update-<date>.log) and the api log lines shown by the wait loop. Retry with the whole switchover for your type: A5 then records the current old sha again, and the preflight test runs again.
