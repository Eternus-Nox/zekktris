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
# Git refuses to operate on a repo owned by another user, which is the normal
# state on an Unraid share (the files belong to the share's uid, this runs as
# root). The raw "dubious ownership" fatal reads like corruption, so name it.
if ! git rev-parse HEAD >/dev/null 2>&1; then
    if git rev-parse HEAD 2>&1 | grep -q 'dubious ownership'; then
        fail "git refuses this directory because it is owned by another user. Fix it once with:
      git config --global --add safe.directory $ROOT
    (or run ./scripts/doctor.sh --fix, which does it for you)"
    fi
    fail "not a usable git repository: $ROOT"
fi
CURRENT="$(git rev-parse HEAD)"

# TWO TOPOLOGIES, and this box is the second one.
#
# A clone that PULLS has an upstream to fetch from. But this checkout IS the
# origin — the development machine pushes straight into it (receive.
# denyCurrentBranch=updateInstead), so the working tree is already whatever was
# last pushed and there is nothing upstream to fetch. Fetching from a
# non-existent remote was a hard failure at the first step.
DEPLOY_ONLY=0
if ! git remote get-url origin >/dev/null 2>&1; then
    DEPLOY_ONLY=1
    ok "no upstream — this checkout receives pushes directly"
elif ! git fetch --quiet origin 2>/dev/null; then
    DEPLOY_ONLY=1
    warn "upstream unreachable — deploying the working tree as it stands"
fi

if [[ "$DEPLOY_ONLY" == "1" ]]; then
    TARGET="$CURRENT"
    ok "deploying $(git rev-parse --short HEAD)"
    # Which migrations are on disk but not yet applied is the API's business —
    # it runs them at boot and its startup checks are the gate. What can be said
    # here is which ones arrived recently, so a schema change is not a surprise.
    RECENT="$(git log --since='7 days ago' --name-only --pretty=format: -- packages/db/migrations/ 2>/dev/null | grep '\.sql$' | sort -u || true)"
    if [[ -n "$RECENT" ]]; then
        warn "migrations added in the last 7 days (applied at boot, NOT undone by a rollback):"
        echo "$RECENT" | sed 's/^/      /'
    fi
else
    TARGET="$(git rev-parse origin/master)"
    if [[ "$CURRENT" == "$TARGET" ]]; then
        ok "already up to date ($(git rev-parse --short HEAD))"
        exit 0
    fi
    echo
    git --no-pager log --oneline "$CURRENT..$TARGET" | sed 's/^/    /'
    echo
fi

# Migrations are the part that cannot be rolled back by swapping an image, so
# call them out separately and loudly.
PENDING_MIGRATIONS="$(git diff --name-only "$CURRENT..$TARGET" -- packages/db/migrations/ 2>/dev/null | grep -c '\.sql$' || true)"
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
    # A stopped stack still has a database volume worth protecting — a
    # migration applies at boot, and "the stack was down" is no reason to skip
    # the safety net. backup.sh needs the db container, so start just that one
    # and wait, rather than refusing to run or silently backing up nothing.
    if ! $COMPOSE ps db --format '{{.State}}' 2>/dev/null | grep -q running; then
        step "Starting the database for the pre-update backup"
        $COMPOSE up -d db >/dev/null 2>&1 || fail "could not start the db service"
        for _ in $(seq 1 30); do
            $COMPOSE exec -T db pg_isready -U commune >/dev/null 2>&1 && break
            sleep 1
        done
    fi
    step "Taking a pre-update backup"
    # Database + config only: it is seconds rather than minutes, and the
    # attachments on disk are not what an update can damage. A schema migration
    # is, which is exactly what this protects.
    if "$SCRIPT_DIR/backup.sh" --no-uploads >/dev/null 2>&1; then
        ok "backup taken"
    elif $COMPOSE exec -T db psql -U commune -d commune -tAc 'select 1' >/dev/null 2>&1; then
        fail "pre-update backup failed — refusing to update without one"
    else
        # A database with nothing in it yet (first run on a fresh volume) has
        # nothing to lose, and demanding a backup of it would block the very
        # first deploy. Anything else is a real failure and stops above.
        warn "no database to back up yet — continuing (first deploy)"
    fi
else
    warn "skipping the pre-update backup (--no-backup)"
fi

# ── Update ──────────────────────────────────────────────────────────────────
if [[ "$DEPLOY_ONLY" == "0" ]]; then
    step "Pulling $TARGET"
    git merge --ff-only origin/master || fail "cannot fast-forward — the working tree has diverged; resolve it by hand"
fi

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
if [[ "$DEPLOY_ONLY" == "1" ]]; then
    # Nothing to roll back TO: the code never moved, this was a rebuild of what
    # was already checked out. Pretending to roll back would just rebuild the
    # same failing tree.
    echo
    fail "The rebuild did not come up healthy. The code is unchanged, so this is
    a build or runtime failure rather than a bad update.
    Check: $COMPOSE logs api --tail 80"
fi

warn "the new build did not come up healthy — rolling the code back to $CURRENT"
git reset --hard "$CURRENT" >/dev/null
$COMPOSE build api proxy && $COMPOSE up -d
echo
fail "Update failed and was rolled back. Check: $COMPOSE logs api --tail 80
If a migration had already applied, restore the pre-update backup as well."
