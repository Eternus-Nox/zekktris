#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Check that this instance is actually set up, and repair what can be repaired.
#
#   ./scripts/doctor.sh          report only, changes nothing
#   ./scripts/doctor.sh --fix    repair what is safely repairable
#
# Exits non-zero when something is still wrong after the run, so it works as a
# cron health check and not only as something you type after noticing trouble.
#
# EVERY CHECK HERE IS A FAILURE THAT ALREADY HAPPENED. None of it is
# hypothetical hardening:
#
#   * FCM_* sat in .env for months while docker-compose never passed them to
#     the api, so every Android push registration 503'd and no Android device
#     could receive anything. Nothing logged it.
#   * LiveKit resolves its public IP once at startup and caches it forever; a
#     WAN change silently broke voice for every off-LAN user for three days.
#   * There were no backups at all, because the thing named "instance backup"
#     captures configuration and not data.
#   * A full disk took out Bash itself mid-session.
#
# What --fix will NOT do: rebuild or restart the stack. That is update.sh's
# job, it is disruptive, and a health check that redeploys production on its
# own is a worse problem than anything it would fix.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

FIX=0
[[ "${1:-}" == "--fix" ]] && FIX=1

if [[ -t 1 ]]; then
    BOLD="$(printf '\033[1m')"; GREEN="$(printf '\033[32m')"
    YELLOW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"; RESET="$(printf '\033[0m')"
else
    BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
PROBLEMS=0
FIXED=0
ok()    { echo "  ${GREEN}✓${RESET} $*"; }
bad()   { echo "  ${RED}✗${RESET} $*"; PROBLEMS=$((PROBLEMS+1)); }
warn()  { echo "  ${YELLOW}!${RESET} $*"; }
fixed() { echo "  ${GREEN}✚${RESET} FIXED: $*"; FIXED=$((FIXED+1)); }
head2() { echo; echo "${BOLD}$*${RESET}"; }

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else COMPOSE=""; fi

APPDATA="$(grep -E '^APPDATA_PATH=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'' || true)"
APPDATA="${APPDATA:-/mnt/user/appdata/zekktris}"

# ── Host ────────────────────────────────────────────────────────────────────
head2 "Host"
if [[ -z "$COMPOSE" ]]; then bad "docker compose not found"; else ok "docker compose: $COMPOSE"; fi

# Git's ownership guard. On an Unraid share the files belong to the share's
# uid while this runs as root, so git refuses every command with a "dubious
# ownership" fatal — which blocks update.sh entirely and reads like the repo
# is broken rather than a one-line config away from working.
if git rev-parse HEAD >/dev/null 2>&1; then
    ok "git can read this repository"
elif git rev-parse HEAD 2>&1 | grep -q 'dubious ownership'; then
    if [[ "$FIX" == "1" ]] && git config --global --add safe.directory "$ROOT" 2>/dev/null; then
        fixed "marked $ROOT as a safe.directory for git"
    else
        bad "git refuses this directory (dubious ownership) — updates cannot run"
    fi
else
    bad "not a usable git repository — updates cannot run"
fi

FREE_G=$(df -Pk / 2>/dev/null | awk 'NR==2{printf "%d", $4/1048576}')
if [[ -n "${FREE_G:-}" ]] && [[ "$FREE_G" -lt 5 ]]; then
    bad "only ${FREE_G}G free on / — builds need ~3G and a full disk takes the box down"
else
    ok "disk: ${FREE_G:-?}G free"
fi

# ── Directories the containers bind-mount ───────────────────────────────────
head2 "Directories"
for d in "$APPDATA/uploads" "$APPDATA/backups" "$APPDATA/control/requests" "$APPDATA/control/status"; do
    if [[ -d "$d" ]]; then
        ok "$(basename "$(dirname "$d")")/$(basename "$d")"
    elif [[ "$FIX" == "1" ]] && mkdir -p "$d" 2>/dev/null; then
        fixed "created $d"
    else
        bad "missing: $d"
    fi
done

# ── Cron ────────────────────────────────────────────────────────────────────
head2 "Scheduled jobs"
AGENT_LINE="* * * * * $SCRIPT_DIR/agent.sh >> /var/log/zk-agent.log 2>&1 # zekktris-agent"
# It lives in ops/, not scripts/ — doctor looked in the wrong place and
# silently skipped installing it, which is precisely the sort of quiet gap
# this script exists to catch.
WATCHDOG="$ROOT/ops/livekit-wan-watchdog.sh"
WATCHDOG_LINE="*/5 * * * * $WATCHDOG >> /var/log/zk-livekit.log 2>&1 # zekktris-livekit"

ensure_cron() { # <marker> <line> <description>
    if crontab -l 2>/dev/null | grep -qF "$1"; then
        ok "$3"
    elif [[ "$FIX" == "1" ]]; then
        { crontab -l 2>/dev/null; echo "$2"; } | crontab - && fixed "installed $3"
    else
        bad "$3 is not scheduled"
    fi
}
# The agent's own entry cannot be installed from the admin UI — the request
# would be picked up by the agent that is not running. This script runs on the
# host, so it is the one place that CAN bootstrap it.
ensure_cron "# zekktris-agent" "$AGENT_LINE" "maintenance agent (admin buttons)"
if [[ -f "$WATCHDOG" ]]; then
    ensure_cron "# zekktris-livekit" "$WATCHDOG_LINE" "LiveKit WAN-address watchdog"
fi
if crontab -l 2>/dev/null | grep -qF "# zekktris-backup"; then
    ok "automatic backups"
else
    warn "automatic backups are off (turn on in Admin → Backup & Maintenance)"
fi

# ── Stack ───────────────────────────────────────────────────────────────────
head2 "Services"
if [[ -n "$COMPOSE" ]]; then
    for svc in api db cache proxy; do
        if $COMPOSE ps "$svc" --format '{{.State}}' 2>/dev/null | grep -q running; then
            ok "$svc running"
        else
            bad "$svc is NOT running"
        fi
    done
    if $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then
        ok "api health check passes"
    else
        bad "api is not answering /health"
    fi

    # The bug that hid for months: set in .env, never passed to the process.
    #
    # Only meaningful with the api UP and those keys actually configured.
    # Reporting a tick when neither is true would be the worst failure a health
    # check can have — asserting something is fine without having tested it,
    # which is how the FCM gap survived so long in the first place.
    CONFIGURED_KEYS=""
    for k in FCM_PROJECT_ID FCM_CLIENT_EMAIL FCM_PRIVATE_KEY; do
        grep -qE "^${k}=.+" .env 2>/dev/null && CONFIGURED_KEYS="$CONFIGURED_KEYS $k"
    done
    if [[ -z "$CONFIGURED_KEYS" ]]; then
        warn "no FCM_* in .env — skipped the container env check"
    elif ! $COMPOSE ps api --format '{{.State}}' 2>/dev/null | grep -q running; then
        warn "api not running — could not check that FCM_* reaches it"
    else
        MISSING_ENV=""
        for k in $CONFIGURED_KEYS; do
            LEN=$($COMPOSE exec -T api sh -c "printenv $k 2>/dev/null | wc -c" 2>/dev/null | tr -d '[:space:]')
            [[ "${LEN:-0}" -gt 1 ]] || MISSING_ENV="$MISSING_ENV $k"
        done
        if [[ -n "$MISSING_ENV" ]]; then
            bad "set in .env but NOT reaching the api container:$MISSING_ENV (rebuild: ./scripts/update.sh)"
        else
            ok "push credentials reach the api container"
        fi
    fi
fi

# ── Push ────────────────────────────────────────────────────────────────────
head2 "Push"
if [[ -f "$SCRIPT_DIR/fcm-test.mjs" ]] && grep -qE '^FCM_PROJECT_ID=.+' .env 2>/dev/null; then
    if node "$SCRIPT_DIR/fcm-test.mjs" >/dev/null 2>&1; then
        ok "FCM credentials mint a Google access token"
    else
        bad "FCM credentials do NOT load (run: node scripts/fcm-test.mjs)"
    fi
else
    warn "FCM not configured — Android push is off"
fi

# ── LiveKit ─────────────────────────────────────────────────────────────────
head2 "Voice"
if [[ -n "$COMPOSE" ]] && docker inspect -f '{{.State.Running}}' zekktris-livekit >/dev/null 2>&1; then
    # Prefer what the watchdog remembered. LiveKit prints its STUN-discovered
    # address once at startup and compose rotates these logs (10 MB × 5), so
    # after a few days there is nothing in the log to read — which is why this
    # check reported "could not compare" on a perfectly healthy server, and why
    # the watchdog itself had quietly stopped working.
    ADVERTISED=""
    if [[ -f "$ROOT/.livekit-wan.state" ]]; then
        read -r _ ADVERTISED < "$ROOT/.livekit-wan.state" || true
    fi
    if [[ -z "$ADVERTISED" ]]; then
        ADVERTISED="$(docker logs zekktris-livekit 2>&1 \
            | grep -o '"externalIP": "[0-9.]*"' | grep -oE '[0-9]+(\.[0-9]+){3}' | tail -1)"
    fi
    ACTUAL="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null)"
    if [[ -z "$ADVERTISED" ]]; then
        # No record and nothing in the log. Running the watchdog once creates
        # the record, so this is fixable rather than merely reportable.
        if [[ "$FIX" == "1" && -x "$WATCHDOG" ]]; then
            "$WATCHDOG" >/dev/null 2>&1
            fixed "ran the LiveKit watchdog to record its advertised address"
        else
            warn "no record of LiveKit's advertised address (run ops/livekit-wan-watchdog.sh once)"
        fi
    elif [[ -z "$ACTUAL" ]]; then
        warn "could not look up the WAN address to compare against"
    elif [[ "$ADVERTISED" == "$ACTUAL" ]]; then
        ok "LiveKit advertises the current WAN address ($ACTUAL)"
    elif [[ "$FIX" == "1" ]]; then
        $COMPOSE restart livekit >/dev/null 2>&1 && fixed "restarted LiveKit — was advertising $ADVERTISED, WAN is $ACTUAL"
    else
        bad "LiveKit advertises $ADVERTISED but the WAN address is $ACTUAL — off-LAN calls will time out"
    fi
else
    warn "LiveKit container not running"
fi

# ── Backups ─────────────────────────────────────────────────────────────────
head2 "Backups"
NEWEST="$(ls -1t "$APPDATA"/backups/zekktris-*.tar.gz 2>/dev/null | head -1)"
if [[ -z "$NEWEST" ]]; then
    if [[ "$FIX" == "1" ]]; then
        "$SCRIPT_DIR/backup.sh" --no-uploads >/dev/null 2>&1 && fixed "took a first backup" \
            || bad "no backups exist and taking one failed"
    else
        bad "NO BACKUPS EXIST — nothing here is recoverable"
    fi
else
    AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST" 2>/dev/null || stat -f %m "$NEWEST") ) / 3600 ))
    if [[ "$AGE_H" -gt 36 ]]; then
        bad "newest backup is ${AGE_H}h old — the schedule may not be running"
    else
        ok "newest backup ${AGE_H}h old"
    fi
    # `head -c 5` closes the pipe as soon as it has its bytes, killing tar with
    # SIGPIPE — and under `pipefail` that made the whole test fail, reporting a
    # perfectly good 1.1 GB bundle as unusable. A health check that cries wolf
    # about the backups is worse than one that stays quiet, so the tar segment
    # is allowed to die: what matters is the five bytes, not how tar exited.
    MAGIC="$({ tar -xzOf "$NEWEST" db.dump 2>/dev/null || true; } | head -c 5)"
    if [[ "$MAGIC" == "PGDMP" ]]; then
        ok "newest bundle's dump header is valid"
    else
        bad "newest bundle does not look like a usable backup (./scripts/restore.sh --check)"
    fi
fi

# ── Verdict ─────────────────────────────────────────────────────────────────
echo
if [[ "$PROBLEMS" -eq 0 ]]; then
    echo "${GREEN}${BOLD}All checks passed${RESET}${FIXED:+ (repaired $FIXED)}"
    exit 0
fi
echo "${RED}${BOLD}$PROBLEMS problem(s) remaining${RESET}${FIXED:+, repaired $FIXED}"
[[ "$FIX" == "1" ]] || echo "Re-run with --fix to repair what is safely repairable."
exit 1
