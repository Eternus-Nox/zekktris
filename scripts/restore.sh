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
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || fail "bundle not found: ${BUNDLE:-<none>}"

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

# Verify the dump is structurally intact BEFORE touching anything. pg_restore
# -l lists the archive's table of contents and fails on a truncated or corrupt
# file — which is the failure a backup script cannot detect at write time.
step "Verifying the database dump"
if $COMPOSE ps db --format '{{.State}}' 2>/dev/null | grep -q running; then
    if $COMPOSE exec -T db pg_restore -l /dev/stdin < "$STAGE/db.dump" > "$STAGE/toc" 2>"$STAGE/toc.err"; then
        ok "dump is readable — $(grep -c ';' "$STAGE/toc" 2>/dev/null || echo '?') archive entries"
    else
        cat "$STAGE/toc.err" >&2
        fail "the dump is CORRUPT or truncated — this bundle cannot restore an instance"
    fi
else
    warn "db container not running — skipped dump verification"
fi
ok "uploads archive: $(tar -tf "$STAGE/uploads.tar" 2>/dev/null | wc -l | tr -d ' ') entries"

if [[ "$MODE" == "check" ]]; then
    echo
    ok "${BOLD}Bundle verified.${RESET} Nothing was changed."
    exit 0
fi

# ── 2. Refuse to overwrite a populated instance ─────────────────────────────
step "Checking the target instance is empty"
$COMPOSE up -d db >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
    $COMPOSE exec -T db pg_isready -U commune >/dev/null 2>&1 && break
    sleep 1
done
USERS="$($COMPOSE exec -T db psql -U commune -d commune -tAc \
    "select count(*) from users" 2>/dev/null | tr -d '[:space:]' || echo 0)"
if [[ "${USERS:-0}" -gt 0 ]]; then
    if [[ "$MODE" != "force" ]]; then
        echo
        fail "target already has ${USERS} users. Restoring over live data half-applies and leaves an instance that looks up but is quietly wrong. Re-run with --force ONLY if you mean to replace it."
    fi
    warn "overwriting an instance with ${USERS} existing users (--force)"
fi

# ── 3. Config and secrets first ─────────────────────────────────────────────
# Before the database, because the field-encryption keys live in .env: restoring
# rows we then cannot decrypt is a worse outcome than stopping here.
step "Restoring config and secrets"
if [[ -f .env ]]; then
    cp .env ".env.before-restore-$(date +%Y%m%d-%H%M%S)"
    ok "existing .env preserved alongside"
fi
cp "$STAGE/env" .env
chmod 600 .env
tar -xf "$STAGE/secrets.tar" -C . 2>/dev/null || true
ok "config in place"

APPDATA="$(grep -E '^APPDATA_PATH=' .env | cut -d= -f2- | tr -d '"'"'"'' || true)"
APPDATA="${APPDATA:-/mnt/user/appdata/zekktris}"

# ── 4. Database ─────────────────────────────────────────────────────────────
step "Restoring database"
# --clean --if-exists drops what is there first, so a --force restore replaces
# rather than merges. Ordinary object-ownership noise is expected on a fresh
# volume, so a non-zero exit is reported but not fatal; the row counts below
# are the real check.
$COMPOSE exec -T db pg_restore -U commune -d commune --clean --if-exists --no-owner < "$STAGE/db.dump" \
    2>"$STAGE/restore.err" || warn "pg_restore reported issues (often harmless ownership noise)"
RESTORED="$($COMPOSE exec -T db psql -U commune -d commune -tAc "select count(*) from users" 2>/dev/null | tr -d '[:space:]' || echo 0)"
[[ "${RESTORED:-0}" -gt 0 ]] || { sed -n '1,20p' "$STAGE/restore.err" >&2; fail "restore produced no users — the instance is NOT usable"; }
ok "${RESTORED} users restored"

# ── 5. Uploads ──────────────────────────────────────────────────────────────
step "Restoring uploads to $APPDATA"
mkdir -p "$APPDATA"
tar -xf "$STAGE/uploads.tar" -C "$APPDATA" || warn "some uploads could not be written"
ok "attachments in place"

# ── 6. Bring it up and wait for it to actually be ready ─────────────────────
step "Starting the stack"
$COMPOSE up -d
step "Waiting for api startup checks (up to 90 seconds)"
DEADLINE=$(( $(date +%s) + 90 ))
HEALTHY=0
while [[ $(date +%s) -lt $DEADLINE ]]; do
    if $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then
        HEALTHY=1; break
    fi
    sleep 3
done

echo
if [[ "$HEALTHY" == "1" ]]; then
    ok "${BOLD}Restore complete and the API is healthy.${RESET}"
    echo
    echo "Migrations apply themselves at boot, so a bundle from an older commit"
    echo "is brought up to the current schema automatically."
else
    warn "Restore finished but the API did not report healthy within 90s."
    warn "Check: $COMPOSE logs api --tail 50"
fi
