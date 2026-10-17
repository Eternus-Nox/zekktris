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
# down after an update is far worse than one that is merely out of date. A
# build that fails puts the previous code back without restarting anything,
# and an update that stopped halfway is picked up again by the next run.
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
        -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

command -v docker >/dev/null 2>&1 || fail "docker not found in PATH"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else fail "docker compose not found"; fi

# wait_for_api and why the api is started before the rest. Read now, before
# the merge below can change or (on a rollback) remove it.
# shellcheck source=lib/start-stack.sh
. "$SCRIPT_DIR/lib/start-stack.sh"

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
# Where an update that moved the code started from, until it ends healthy or
# rolled back. Inside .git, so it is neither tracked nor a local edit.
UNFINISHED="$(git rev-parse --git-path zekktris-update-unfinished)"

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
    # An update that stopped after the code moved (the rest of the stack did
    # not start, or the run was killed) left the checkout at its target, which
    # would read as "already up to date" from then on while the containers ran
    # something else. Start from where that update started instead, so this
    # run finishes it and can still roll back to there.
    PREV="$(cat "$UNFINISHED" 2>/dev/null || true)"
    if [[ -n "$PREV" && "$PREV" != "$CURRENT" ]] && git merge-base --is-ancestor "$PREV" HEAD 2>/dev/null; then
        CURRENT="$(git rev-parse "$PREV")"
        warn "the update from $(git rev-parse --short "$CURRENT") did not finish — $([[ "$MODE" == check ]] && echo "the next update picks it up again" || echo "picking it up again")"
    fi
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

# Local edits to tracked files — ops/livekit.yaml asks for one, and compose or
# Caddyfile tweaks are common — survive the update and a rollback, EXCEPT in a
# file the update itself changes: git would refuse the merge halfway through,
# so say which files up front instead.
LOCAL_EDITS="$(git diff --name-only HEAD 2>/dev/null || true)"
if [[ -n "$LOCAL_EDITS" ]]; then
    CLASHES="$(comm -12 <(echo "$LOCAL_EDITS" | sort) <(git diff --name-only "$CURRENT" "$TARGET" | sort))"
    if [[ -n "$CLASHES" ]]; then
        echo "$CLASHES" | sed 's/^/      /'
        fail "these files have local edits AND are changed by the update. Save your
    changes (git diff > ~/zekktris-local.patch), then 'git checkout -- <file>' or
    'git stash', update, and re-apply them."
    fi
    ok "local edits kept across the update: $(echo "$LOCAL_EDITS" | tr '\n' ' ')"
fi

# Trusting Cloudflare's client-IP header is opt-in (EDGE_PROXY). An install
# behind a Cloudflare Tunnel that has not opted in would, after this update, see
# every visitor as the tunnel's address — and rate-limit and ban them as one.
EDGE_WARNING=""
EDGE_PROXY_SET="$(grep -E '^EDGE_PROXY=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"'' || true)"
if [[ "${EDGE_PROXY_SET:-none}" != "cloudflare" ]] \
    && grep -q '"Cf-Warp-Tag-Id"' <<<"$(docker logs --tail 300 zekktris-proxy 2>&1 || true)"; then
    EDGE_WARNING="requests arrive through a Cloudflare Tunnel but .env does not set EDGE_PROXY=cloudflare — add it, then: $COMPOSE up -d proxy"
    warn "$EDGE_WARNING"
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
    echo "$CURRENT" > "$UNFINISHED"
    git merge --ff-only origin/master || fail "cannot fast-forward — the working tree has diverged; resolve it by hand"
fi

step "Rebuilding"
if ! $COMPOSE build api proxy; then
    # Nothing has been restarted, so the previous build is still what runs.
    echo
    if [[ "$DEPLOY_ONLY" == "1" ]]; then
        fail "The build failed. Nothing was restarted and the code is unchanged.
    Fix the error above, then run this again."
    fi
    # The code goes back too: left at $TARGET, every later run would find it
    # already up to date and never build it again.
    git reset --keep "$CURRENT" >/dev/null || fail "The build failed, and the code could not be rolled back (git reset --keep $CURRENT failed).
    Nothing was restarted. Check 'git status'; the next update run tries again."
    rm -f "$UNFINISHED"
    # A service that finished building before the failure is already tagged
    # with the new code, and the next plain `up -d` would start it. Build the
    # previous code again (from cache, mostly) so the tags match what runs.
    $COMPOSE build api proxy >/dev/null 2>&1 \
        || warn "could not rebuild the previous images; do not run '$COMPOSE up -d' by hand before the next update"
    fail "Update failed: the build did not complete. Nothing was restarted and the code is back
    at $(git rev-parse --short HEAD). Fix the error above (a network failure, a full disk, or a
    setting the new docker-compose.yml requires in .env), then run the update again."
fi

# The api alone first (scripts/lib/start-stack.sh says why); the proxy and the
# rest follow once it is healthy. A failure here is not fatal: the wait below
# then fails too, and that is what rolls back.
step "Restarting the api"
API_STARTED=1
$COMPOSE up -d api || API_STARTED=0

step "Waiting for startup checks (up to about 3 minutes)"
HEALTHY=0
if [[ "$API_STARTED" == "1" ]] && wait_for_api 90; then HEALTHY=1; fi

if [[ "$HEALTHY" == "1" ]]; then
    step "Starting the rest of the stack"
    # The update stays marked unfinished here, so running it again finishes it.
    $COMPOSE up -d || fail "the api is healthy on the new code, but the rest of the stack did not start.
    Fix the error above, then run: $COMPOSE up -d (or run the update again)"
    rm -f "$UNFINISHED"
    echo
    ok "${BOLD}Updated to $(git rev-parse --short HEAD) and healthy.${RESET}"
    [[ -z "$EDGE_WARNING" ]] || warn "$EDGE_WARNING"
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
    Check: $COMPOSE logs api --tail 80
    Once the cause is fixed, start it with: $COMPOSE up -d"
fi

warn "the new build did not come up healthy — rolling the code back to $CURRENT"
# --keep, never --hard: it moves only the files the update changed and keeps
# the operator's uncommitted edits (which the check above guarantees are in
# other files). --hard silently threw those edits away.
git reset --keep "$CURRENT" >/dev/null || fail "could not roll the code back (git reset --keep $CURRENT failed).
    The code is still at $TARGET. Check 'git status', then roll back by hand."
rm -f "$UNFINISHED"
if ! { $COMPOSE build api proxy && $COMPOSE up -d api && wait_for_api 90 && $COMPOSE up -d; }; then
    echo
    fail "Update failed. The code is back at $(git rev-parse --short HEAD), but the previous build did not come up
    healthy either. Check: $COMPOSE logs api --tail 80
    Once the cause is fixed, start it with: $COMPOSE up -d
    If a migration had already applied, restore the pre-update backup as well."
fi
echo
fail "Update failed and was rolled back. Check: $COMPOSE logs api --tail 80
If a migration had already applied, restore the pre-update backup as well."
