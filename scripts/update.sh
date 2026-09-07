#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Update this instance to the latest committed code — safely.
#
#   ./scripts/update.sh            back up, pull, rebuild, health-gate, roll back on failure
#   ./scripts/update.sh --check    report what an update WOULD bring, change nothing
#   ./scripts/update.sh --no-backup    skip the pre-update backup (don't)
#
# WHY THIS IS A HOST SCRIPT AND NOT AN ADMIN BUTTON.
#
# Updating means rebuilding and replacing the very container that would be
# serving the request, which a container cannot do to itself cleanly. Doing it
# from the API would need the Docker socket — a root-equivalent handle on the
# host, reachable over HTTP.
#
# And migrations apply themselves at boot. A one-click update in the admin UI
# would therefore run schema changes against production with nobody looking:
# migration 0123 alters the messages table. That is a thing to do deliberately,
# after a backup, with the output in front of you — which is what this is.
#
# The safety net is the health gate. If the new build fails its startup checks
# the previous image is put back automatically, because an instance that is
# down after an update is far worse than one that is merely out of date.
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

MODE="update"; DO_BACKUP=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --check) MODE="check"; shift ;;
        --no-backup) DO_BACKUP=0; shift ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

command -v docker >/dev/null 2>&1 || fail "docker not found in PATH"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else fail "docker compose not found"; fi

# ── What would change ───────────────────────────────────────────────────────
step "Checking for updates"
CURRENT="$(git rev-parse HEAD)"
git fetch --quiet origin || fail "could not reach the git remote"
TARGET="$(git rev-parse origin/master)"

if [[ "$CURRENT" == "$TARGET" ]]; then
    ok "already up to date ($(git rev-parse --short HEAD))"
    exit 0
fi

echo
git --no-pager log --oneline "$CURRENT..$TARGET" | sed 's/^/    /'
echo

# Migrations are the part that cannot be rolled back by swapping an image, so
# call them out separately and loudly.
PENDING_MIGRATIONS="$(git diff --name-only "$CURRENT..$TARGET" -- packages/db/migrations/ | grep -c '\.sql$' || true)"
if [[ "${PENDING_MIGRATIONS:-0}" -gt 0 ]]; then
    warn "${PENDING_MIGRATIONS} new migration(s) — these apply at boot and a rollback of the image does NOT undo them"
    git diff --name-only "$CURRENT..$TARGET" -- packages/db/migrations/ | grep '\.sql$' | sed 's/^/      /'
fi

if [[ "$MODE" == "check" ]]; then
    echo
    ok "Check only. Nothing was changed."
    exit 0
fi

# ── Back up first ───────────────────────────────────────────────────────────
if [[ "$DO_BACKUP" == "1" ]]; then
    step "Taking a pre-update backup"
    # Database + config only: it is seconds rather than minutes, and the
    # attachments on disk are not what an update can damage. A schema migration
    # is, which is exactly what this protects.
    "$SCRIPT_DIR/backup.sh" --no-uploads >/dev/null || fail "pre-update backup failed — refusing to update without one"
    ok "backup taken"
else
    warn "skipping the pre-update backup (--no-backup)"
fi

# ── Update ──────────────────────────────────────────────────────────────────
step "Pulling $TARGET"
git merge --ff-only origin/master || fail "cannot fast-forward — the working tree has diverged; resolve it by hand"

step "Rebuilding"
$COMPOSE build api proxy

step "Restarting"
$COMPOSE up -d

step "Waiting for startup checks (up to 90 seconds)"
DEADLINE=$(( $(date +%s) + 90 )); HEALTHY=0
while [[ $(date +%s) -lt $DEADLINE ]]; do
    if $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then HEALTHY=1; break; fi
    sleep 3
done

if [[ "$HEALTHY" == "1" ]]; then
    echo
    ok "${BOLD}Updated to $(git rev-parse --short HEAD) and healthy.${RESET}"
    exit 0
fi

# ── Roll back ───────────────────────────────────────────────────────────────
# The code goes back. Any migration that already ran does NOT — which is why
# the backup above is not optional and why new migrations are called out before
# anything is touched.
warn "the new build did not come up healthy — rolling the code back to $CURRENT"
git reset --hard "$CURRENT" >/dev/null
$COMPOSE build api proxy && $COMPOSE up -d
echo
fail "Update failed and was rolled back. Check: $COMPOSE logs api --tail 80
If a migration had already applied, restore the pre-update backup as well."
