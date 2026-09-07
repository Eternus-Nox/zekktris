#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Host-side runner for admin-triggered maintenance.
#
# Run from cron every minute:
#   * * * * * /mnt/user/appdata/zekktris/scripts/agent.sh >> /var/log/zk-agent.log 2>&1
#
# WHY THIS EXISTS INSTEAD OF THE API RUNNING DOCKER ITSELF.
#
# The admin UI needs a button that takes a backup or updates the stack. Both
# need the host — pg_dump against the db container, and rebuilding the very
# container that would be serving the request. The obvious way is to give the
# API the Docker socket, but that is a root-equivalent handle on this machine
# reachable over HTTP: anything that can talk to the API can then start a
# privileged container and own the box.
#
# So the API only ever WRITES A REQUEST — a small JSON file naming one of the
# actions below. This script, running on the host with the privileges it
# already has, picks it up and runs the matching command.
#
# THE ALLOWLIST IS THE ENTIRE SECURITY BOUNDARY. Nothing from the request file
# is ever interpolated into a command; the action name only selects a branch of
# a fixed `case`. Adding a branch that takes an argument from the request would
# undo the whole point of this design.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

APPDATA="$(grep -E '^APPDATA_PATH=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'' || true)"
APPDATA="${APPDATA:-/mnt/user/appdata/zekktris}"
CONTROL="$APPDATA/control"
REQ_DIR="$CONTROL/requests"
STATUS_DIR="$CONTROL/status"
LOCK="$CONTROL/.agent.lock"
mkdir -p "$REQ_DIR" "$STATUS_DIR"

# One run at a time. A backup and an update overlapping would have them fighting
# over the same containers, and cron fires again while a long job is still going.
exec 9>"$LOCK"
flock -n 9 || exit 0

# ── Scheduled backups ───────────────────────────────────────────────────────
# Managed through the admin toggle, which is why every line we own carries a
# marker: crontab edits are somebody's whole machine, and this must only ever
# add or remove ITS OWN entries, never rewrite what else is in there.
CRON_MARK="# zekktris-backup"
SCHEDULE_DB="30 3 * * * $SCRIPT_DIR/backup.sh --no-uploads >> /var/log/zk-backup.log 2>&1 $CRON_MARK"
SCHEDULE_FULL="0 4 * * 0 $SCRIPT_DIR/backup.sh >> /var/log/zk-backup.log 2>&1 $CRON_MARK"

schedule_enabled() { crontab -l 2>/dev/null | grep -qF "$CRON_MARK"; }

schedule_on() {
    # Nightly database-only (seconds, ~12 MB) plus a weekly full one with
    # attachments. One cadence cannot be both cheap enough to run daily and
    # complete enough to rebuild from, so it is two.
    { crontab -l 2>/dev/null | grep -vF "$CRON_MARK"; echo "$SCHEDULE_DB"; echo "$SCHEDULE_FULL"; } | crontab -
}
schedule_off() { crontab -l 2>/dev/null | grep -vF "$CRON_MARK" | crontab -; }

# Report the real state on EVERY tick, not just after a change — so the toggle
# reflects the crontab even if someone edited it by hand.
write_schedule_status() {
    printf '{"enabled":%s,"nightly":"03:30 database-only","weekly":"Sun 04:00 full"}\n' \
        "$(if schedule_enabled; then echo true; else echo false; fi)" \
        > "$STATUS_DIR/schedule.json"
}
write_schedule_status

shopt -s nullglob
for req in "$REQ_DIR"/*.json; do
    # Read the action with a strict pattern rather than a JSON parser: this runs
    # as root, and the less of an attacker-controlled file we interpret, the
    # better. Anything not matching exactly is ignored.
    ACTION="$(grep -oE '"action"[[:space:]]*:[[:space:]]*"[a-z-]{1,32}"' "$req" 2>/dev/null \
              | head -1 | sed -E 's/.*"([a-z-]+)"$/\1/')"
    NAME="$(basename "$req" .json)"
    STARTED="$(date -Iseconds)"
    LOG="$STATUS_DIR/$NAME.log"

    # Consume the request FIRST. If the command below kills this script (or the
    # box reboots mid-run), a leftover request would otherwise re-run forever —
    # and a re-running RESTORE would be catastrophic. The body is kept aside so
    # the restore branch can still read its (pattern-validated) filename.
    cp -f "$req" "$CONTROL/requests-consumed.json" 2>/dev/null || true
    rm -f "$req"

    case "$ACTION" in
        backup)
            "$SCRIPT_DIR/backup.sh" --no-uploads > "$LOG" 2>&1
            RC=$?
            ;;
        backup-full)
            "$SCRIPT_DIR/backup.sh" > "$LOG" 2>&1
            RC=$?
            ;;
        update)
            # update.sh takes its own pre-update backup and rolls the code back
            # if the new build fails its health checks.
            "$SCRIPT_DIR/update.sh" > "$LOG" 2>&1
            RC=$?
            ;;
        verify)
            # Prove the newest bundle would actually restore. This is the only
            # thing that turns "a backup exists" into "a backup is usable", and
            # it is read-only.
            NEWEST="$(ls -1t "$APPDATA"/backups/zekktris-*.tar.gz 2>/dev/null | head -1)"
            if [[ -z "$NEWEST" ]]; then
                echo "no backups to verify" > "$LOG"; RC=66
            else
                "$SCRIPT_DIR/restore.sh" --check "$NEWEST" > "$LOG" 2>&1
                RC=$?
            fi
            ;;
        restore)
            # DESTRUCTIVE — replaces the entire database with the bundle's.
            #
            # The filename comes from the request, which is the one place this
            # agent accepts caller-controlled input. It is matched against an
            # exact pattern and resolved strictly inside the backups directory,
            # so it cannot escape to another path or carry shell metacharacters.
            # Widening this pattern would hand the caller arbitrary arguments to
            # a root-run command; do not.
            FILE="$(grep -oE '"file"[[:space:]]*:[[:space:]]*"zekktris-[0-9]{8}-[0-9]{6}\.tar\.gz"' "$CONTROL/requests-consumed.json" 2>/dev/null | head -1 | sed -E 's/.*"(zekktris-[0-9]{8}-[0-9]{6}\.tar\.gz)"$/\1/')"
            TARGET="$APPDATA/backups/$FILE"
            if [[ -z "$FILE" || ! -f "$TARGET" ]]; then
                echo "restore refused: no such bundle (${FILE:-<none>})" > "$LOG"; RC=66
            else
                # --force because a live instance always has users; that guard
                # is what stops an ACCIDENTAL restore, and getting here means
                # the admin named this exact bundle on purpose.
                "$SCRIPT_DIR/restore.sh" --force "$TARGET" > "$LOG" 2>&1
                RC=$?
            fi
            ;;
        schedule-on)
            schedule_on > "$LOG" 2>&1; RC=$?
            write_schedule_status
            [[ $RC -eq 0 ]] && echo "scheduled: nightly database-only, weekly full" >> "$LOG"
            ;;
        schedule-off)
            schedule_off > "$LOG" 2>&1; RC=$?
            write_schedule_status
            [[ $RC -eq 0 ]] && echo "automatic backups disabled" >> "$LOG"
            ;;
        restart)
            # Rebuild and recreate, the plain "apply what is on disk" action.
            if docker compose version >/dev/null 2>&1; then
                docker compose up -d --build > "$LOG" 2>&1
            else
                docker-compose up -d --build > "$LOG" 2>&1
            fi
            RC=$?
            ;;
        *)
            echo "ignored unknown action: ${ACTION:-<none>}" > "$LOG"
            RC=64
            ;;
    esac

    # Status is what the admin UI reads back. The log tail is included so a
    # failure explains itself in the UI instead of only in a file on the host.
    {
        printf '{"action":"%s","startedAt":"%s","finishedAt":"%s","exitCode":%d,"ok":%s,"output":' \
            "${ACTION:-unknown}" "$STARTED" "$(date -Iseconds)" "$RC" \
            "$(if [[ $RC -eq 0 ]]; then echo true; else echo false; fi)"
        tail -c 4000 "$LOG" 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'
        printf '}\n'
    } > "$STATUS_DIR/last.json"
    echo "$(date -Iseconds) agent: ${ACTION:-unknown} exit=$RC"
done
