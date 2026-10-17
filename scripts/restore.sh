#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Rebuild an instance from a bundle written by backup.sh.
#
#   ./scripts/restore.sh --check <bundle>    inspect + verify, change nothing
#   ./scripts/restore.sh <bundle>            restore into an EMPTY instance
#   ./scripts/restore.sh --force <bundle>    restore over existing data
#
# --check first, always. A backup nobody has opened is a hypothesis, and the
# time to discover a truncated dump is not while the server is down.
#
# THE SAFETY RULE, and why it is not just caution: restoring over a live
# database is worse than not restoring at all. pg_restore into a populated
# schema half-applies — some tables replaced, others conflicted and skipped —
# and leaves an instance that looks up but is quietly wrong. So a non-empty
# database aborts unless --force says otherwise.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

if [[ -t 1 ]]; then
    BOLD="$(printf '\033[1m')"; GREEN="$(printf '\033[32m')"
    YELLOW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"; RESET="$(printf '\033[0m')"
else
    BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
step() { echo "${BOLD}▶${RESET} $*"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
fail() { echo "  ${RED}✗${RESET} $*" >&2; exit 1; }

MODE="restore"
case "${1:-}" in
    --check) MODE="check"; shift ;;
    --force) MODE="force"; shift ;;
    ""|-h|--help)
        sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
        exit 0 ;;
esac
BUNDLE="${1:-}"
# No path given: check the newest bundle. `--check` with no argument is the
# natural thing to type, and making it an error taught nothing.
if [[ -z "$BUNDLE" ]]; then
    APPDATA_FOR_DEFAULT="$(grep -E '^APPDATA_PATH=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'' || true)"
    APPDATA_FOR_DEFAULT="${APPDATA_FOR_DEFAULT:-/mnt/user/appdata/zekktris}"
    # $APPDATA_PATH/backups is where backup.sh writes; <repo>/backups is where
    # it wrote before, kept so an older bundle is still found.
    for dir in "$APPDATA_FOR_DEFAULT/backups" "$ROOT/backups"; do
        CANDIDATE="$(ls -1t "$dir"/zekktris-*.tar.gz 2>/dev/null | head -1)"
        [[ -n "$CANDIDATE" ]] && { BUNDLE="$CANDIDATE"; break; }
    done
    [[ -n "$BUNDLE" ]] && echo "  (no bundle given — using the newest: $(basename "$BUNDLE"))"
fi
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || fail "bundle not found: ${1:-<none given, and no backups on disk>}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ── 1. Open and verify the bundle ───────────────────────────────────────────
step "Reading $BUNDLE"
tar -xzf "$BUNDLE" -C "$STAGE" || fail "bundle is not a readable tar.gz — it may be truncated"
for f in db.dump uploads.tar secrets.tar env MANIFEST; do
    [[ -f "$STAGE/$f" ]] || fail "bundle is missing $f — not a backup.sh bundle, or incomplete"
done
echo
sed 's/^/    /' "$STAGE/MANIFEST"
echo

command -v docker >/dev/null 2>&1 || fail "docker not found in PATH"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else fail "docker compose not found"; fi

# wait_for_api, and why the api is started before the rest of the stack.
# shellcheck source=lib/start-stack.sh
. "$SCRIPT_DIR/lib/start-stack.sh"

# Verify the dump is structurally intact BEFORE touching anything. pg_restore
# -l lists the archive's table of contents and fails on a truncated or corrupt
# file — which is the failure a backup script cannot detect at write time.
step "Verifying the database dump"
# Cheap structural check first, no container needed: every pg_dump custom-format
# archive starts with the magic string "PGDMP".
MAGIC="$(head -c 5 "$STAGE/db.dump" 2>/dev/null || true)"
[[ "$MAGIC" == "PGDMP" ]] || fail "not a pg_dump custom-format archive (header reads '${MAGIC}') — this bundle cannot restore an instance"
ok "archive header valid"

if $COMPOSE ps db --format '{{.State}}' 2>/dev/null | grep -q running; then
    # Copy into the container and list from a REAL FILE. pg_restore needs to
    # seek to read a custom archive's table of contents, and a pipe is not
    # seekable — feeding it through /dev/stdin fails at the header even when
    # the dump is perfect, which is a verification that cries wolf on a good
    # backup. Exactly the wrong failure mode for a tool whose job is to tell
    # you the backup is sound.
    $COMPOSE exec -T db sh -c 'cat > /tmp/zk-verify.dump' < "$STAGE/db.dump"
    if $COMPOSE exec -T db pg_restore -l /tmp/zk-verify.dump > "$STAGE/toc" 2>"$STAGE/toc.err"; then
        ok "dump is readable — $(grep -c ';' "$STAGE/toc" 2>/dev/null || echo '?') archive entries"
    else
        cat "$STAGE/toc.err" >&2
        $COMPOSE exec -T db rm -f /tmp/zk-verify.dump >/dev/null 2>&1 || true
        fail "the dump is CORRUPT or truncated — this bundle cannot restore an instance"
    fi
    $COMPOSE exec -T db rm -f /tmp/zk-verify.dump >/dev/null 2>&1 || true
else
    warn "db container not running — skipped the full table-of-contents check"
fi
UPLOAD_ENTRIES="$(tar -tf "$STAGE/uploads.tar" 2>/dev/null | wc -l | tr -d ' ')"
if grep -q '^includes_uploads=no' "$STAGE/MANIFEST" 2>/dev/null; then
    # A --no-uploads bundle is a legitimate thing to take often, and a
    # legitimate thing to restore ON TOP of an instance that still has its
    # files. It is NOT a complete instance on its own, and restoring one onto
    # a bare machine leaves every image and file in every conversation broken —
    # so say so rather than reporting "0 entries" and looking successful.
    warn "this bundle has NO attachments (--no-uploads)"
    warn "only restore it where the uploads directory already exists, or pair it with a full bundle"
else
    ok "uploads archive: ${UPLOAD_ENTRIES} entries"
fi

if [[ "$MODE" == "check" ]]; then
    echo
    ok "${BOLD}Bundle verified.${RESET} Nothing was changed."
    exit 0
fi

# ── 2. Work out the configuration the restored instance will run with ───────
# The bundle's .env, because it holds the field-encryption keys and the
# database password the dump belongs with. EXCEPT APPDATA_PATH when this host
# already has one: where the data disk lives is a fact about this machine, not
# about the backup (an Unraid bundle names /mnt/user/appdata, which a VPS does
# not have), and the database, the uploads and the restarted stack must all
# use the SAME path.
#
# Everything from here on runs compose against this file. Starting the db under
# the OLD .env and swapping the file afterwards restored into one volume and
# then booted the stack on another, with a password the database had never
# been given.
# A missing key is an empty value, not an error (set -e + pipefail would
# otherwise end the script on the first unset key without a word).
envval() { { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'; }
FINAL_ENV="$STAGE/env.final"
cp "$STAGE/env" "$FINAL_ENV"
if [[ -f .env ]]; then
    HOST_APPDATA="$(envval APPDATA_PATH .env)"
    HOST_APPDATA="${HOST_APPDATA:-/mnt/user/appdata/zekktris}"
    BUNDLE_APPDATA="$(envval APPDATA_PATH "$STAGE/env")"
    if [[ "${BUNDLE_APPDATA:-/mnt/user/appdata/zekktris}" != "$HOST_APPDATA" ]]; then
        { grep -vE '^APPDATA_PATH=' "$STAGE/env" || true; echo "APPDATA_PATH=$HOST_APPDATA"; } > "$FINAL_ENV"
        warn "keeping this host's APPDATA_PATH ($HOST_APPDATA), not the bundle's (${BUNDLE_APPDATA:-<default>})"
    fi
fi
# Compose refuses to start anything while a `${VAR:?}` variable is empty, and
# it reads FINAL_ENV — so a bundle taken before one of them became required
# could never be restored, whatever this host's .env said. Fill those from this
# host's .env (a JWT secret from here just signs everyone out once).
for key in $(grep -oE '\$\{[A-Z0-9_]+:\?' docker-compose.yml | sed -E 's/^\$\{([A-Z0-9_]+):\?$/\1/' | sort -u); do
    [[ -n "$(envval "$key" "$FINAL_ENV")" ]] && continue
    [[ -f .env && -n "$(envval "$key" .env)" ]] \
        || fail "the bundle's .env has no $key, which docker-compose.yml requires, and this host's .env has none either. Add $key=… to .env and run this again."
    { grep -vE "^$key=" "$FINAL_ENV" || true; grep -E "^$key=" .env | tail -1; } > "$FINAL_ENV.new"
    mv "$FINAL_ENV.new" "$FINAL_ENV"
    warn "the bundle's .env has no $key — using this host's"
done
APPDATA="$(envval APPDATA_PATH "$FINAL_ENV")"
APPDATA="${APPDATA:-/mnt/user/appdata/zekktris}"
DB_PASSWORD_FINAL="$(envval DB_PASSWORD "$FINAL_ENV")"
[[ -n "$DB_PASSWORD_FINAL" ]] || fail "the bundle's .env has no DB_PASSWORD — cannot start the database for it"
RCOMPOSE="$COMPOSE --env-file $FINAL_ENV"

# ── 3. Refuse to overwrite a populated instance ─────────────────────────────
# Prints the target's user count, 0 on a fresh volume. Asks whether the table
# exists first, so "fresh volume" and "cannot query the database" are not both
# read as zero users. $1 is the compose command to ask through.
count_users() {
    local has
    has="$($1 exec -T db psql -U commune -d commune -tAc \
        "select to_regclass('public.users') is not null" 2>"$STAGE/psql.err" | tr -d '[:space:]')" \
        || { cat "$STAGE/psql.err" >&2; return 1; }
    if [[ "$has" != "t" ]]; then echo 0; return 0; fi
    $1 exec -T db psql -U commune -d commune -tAc "select count(*) from users" 2>"$STAGE/psql.err" \
        | tr -d '[:space:]' || { cat "$STAGE/psql.err" >&2; return 1; }
}
refuse_if_populated() {
    if [[ "${1:-0}" -gt 0 && "$MODE" != "force" ]]; then
        echo
        fail "target already has ${1} users. Restoring over live data half-applies and leaves an instance that looks up but is quietly wrong. Re-run with --force ONLY if you mean to replace it."
    fi
}

step "Checking the target instance is empty"
# A database that is already running is asked first, as it is: starting it
# under the bundle's settings below recreates its container when they differ
# (another DB_PASSWORD), and an instance we are about to refuse should not have
# its database restarted for nothing.
if [[ "$MODE" != "force" ]] && $COMPOSE ps db --format '{{.State}}' 2>/dev/null | grep -q running; then
    USERS="$(count_users "$COMPOSE")" || fail "could not query the target database — nothing has been changed"
    refuse_if_populated "$USERS"
fi
if ! $RCOMPOSE up -d db >"$STAGE/up.log" 2>&1; then
    cat "$STAGE/up.log" >&2
    fail "could not start the database — nothing has been changed"
fi
# Over TCP, not the socket: on a fresh volume the image's entrypoint first runs
# a socket-only server to initialise it and then restarts it, and a check that
# lands on that temporary one would race the restart.
READY=0
for _ in $(seq 1 60); do
    if $RCOMPOSE exec -T db pg_isready -h 127.0.0.1 -U commune >/dev/null 2>&1; then READY=1; break; fi
    sleep 1
done
[[ "$READY" == "1" ]] || fail "the database did not become ready within 60s ($COMPOSE logs db) — nothing has been changed"
USERS="$(count_users "$RCOMPOSE")" || fail "could not query the target database — nothing has been changed"
refuse_if_populated "$USERS"
if [[ "${USERS:-0}" -gt 0 ]]; then
    warn "overwriting an instance with ${USERS} existing users (--force)"
fi

# ── 4. Config and secrets first ─────────────────────────────────────────────
# Before the database, because the field-encryption keys live in .env: restoring
# rows we then cannot decrypt is a worse outcome than stopping here.
step "Restoring config and secrets"
if [[ -f .env ]]; then
    cp .env ".env.before-restore-$(date +%Y%m%d-%H%M%S)"
    ok "existing .env preserved alongside"
fi
cp "$FINAL_ENV" .env
chmod 600 .env
tar -xf "$STAGE/secrets.tar" -C . || fail "could not unpack secrets/ (APNs key) from the bundle"
ok "config in place"

# The api must not write into the database while it is replaced (and its open
# connections would hold the locks pg_restore --clean needs to drop tables).
$COMPOSE stop api >/dev/null 2>&1 || warn "could not stop the api before restoring"

# The role's password is fixed when a volume is first initialised and pg_dump
# does not carry it. On a volume another .env initialised (a host freshly set up
# by install.sh, say) it is not the bundle's DB_PASSWORD, and the api would come
# back unable to log in. Set it to the bundle's. Fed through stdin as a psql
# variable, so it is neither on a command line nor parsed as SQL.
if [[ -n "$(envval DATABASE_URL .env)" ]]; then
    warn "DATABASE_URL is set in .env — not touching database passwords; make sure it matches"
elif printf '\\set pw '"'"'%s'"'"'\nALTER ROLE commune WITH PASSWORD :'"'"'pw'"'"';\n' \
        "$(printf '%s' "$DB_PASSWORD_FINAL" | sed -e 's/\\/\\\\/g' -e "s/'/''/g")" \
        | $COMPOSE exec -T db psql -v ON_ERROR_STOP=1 -q -U commune -d commune >/dev/null 2>"$STAGE/pw.err"; then
    ok "database password matches the restored .env"
else
    cat "$STAGE/pw.err" >&2
    fail "could not set the database password to the bundle's DB_PASSWORD"
fi

# ── 5. Database ─────────────────────────────────────────────────────────────
step "Restoring database"
# --clean --if-exists drops what is there first, so a --force restore replaces
# rather than merges. Ordinary object-ownership noise is expected on a fresh
# volume, so a non-zero exit is reported but not fatal; the row counts below
# are the real check.
# Same reason as the verification above: land the archive as a real file inside
# the container rather than piping it, so pg_restore can seek.
$COMPOSE exec -T db sh -c 'cat > /tmp/zk-restore.dump' < "$STAGE/db.dump" \
    || fail "could not copy the dump into the db container"
if ! $COMPOSE exec -T db pg_restore -U commune -d commune --clean --if-exists --no-owner /tmp/zk-restore.dump \
    2>"$STAGE/restore.err"; then
    warn "pg_restore reported $(grep -c 'error' "$STAGE/restore.err" || true) issue(s) (often harmless ownership noise); first lines:"
    sed -n '1,5p' "$STAGE/restore.err" | sed 's/^/      /' >&2
fi
$COMPOSE exec -T db rm -f /tmp/zk-restore.dump >/dev/null 2>&1 || true
RESTORED="$($COMPOSE exec -T db psql -U commune -d commune -tAc "select count(*) from users" 2>/dev/null | tr -d '[:space:]' || echo 0)"
[[ "${RESTORED:-0}" -gt 0 ]] || { sed -n '1,20p' "$STAGE/restore.err" >&2; fail "restore produced no users — the instance is NOT usable"; }
ok "${RESTORED} users restored"

# ── 6. Uploads ──────────────────────────────────────────────────────────────
step "Restoring uploads to $APPDATA"
{ mkdir -p "$APPDATA" && tar -xf "$STAGE/uploads.tar" -C "$APPDATA"; } \
    || fail "could not unpack the uploads into $APPDATA. The database and .env ARE restored;
    fix the cause above, then run this again with --force (the api is left stopped)."
ok "attachments in place"

# ── 7. Bring it up and wait for it to actually be ready ─────────────────────
# The api alone first: a bundle taken while the api still ran as root restores
# root-owned uploads, which its next boot hands over before it starts — longer
# than the proxy's wait for a healthy api allows (scripts/lib/start-stack.sh).
step "Starting the api"
$COMPOSE up -d api || fail "could not start the api. The database, .env and uploads ARE restored;
    fix the cause above, then run: $COMPOSE up -d"
step "Waiting for api startup checks (up to about 3 minutes)"
if ! wait_for_api 90 "the api is handing the restored uploads to its unprivileged user — waiting for that, up to an hour"; then
    echo
    warn "Restore finished but the API did not report healthy, so the rest of"
    warn "the stack was not restarted with the restored settings. Check: $COMPOSE logs api --tail 50"
    fail "Once the api is healthy, run: $COMPOSE up -d"
fi
step "Starting the rest of the stack"
$COMPOSE up -d || fail "the restore is complete and the api is healthy, but the rest of the stack did not start.
    Fix the error above, then run: $COMPOSE up -d"

echo
ok "${BOLD}Restore complete and the API is healthy.${RESET}"
echo
echo "Migrations apply themselves at boot, so a bundle from an older commit"
echo "is brought up to the current schema automatically."
