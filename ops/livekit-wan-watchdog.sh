#!/bin/bash
#
# LiveKit WAN-address watchdog.
#
# WHY THIS EXISTS. livekit-server STUN-discovers its public IP exactly once, at
# process start, and advertises that address as an ICE candidate for the life of
# the container. On a connection with a dynamic WAN address the discovered IP
# eventually stops being ours, and from then on every OFF-LAN client is handed a
# dead address: the room connects over signalling (that rides 443 through the
# proxy) and then the media never arrives. There is no error and no log line at
# the moment it breaks — calls simply stop working for anyone not on the LAN,
# and stay broken until someone restarts the container. That failure ran for
# three days before it was noticed on 2026-09-04.
#
# Run from cron (Unraid: Settings -> User Scripts). Every 5 minutes is plenty —
# the WAN address changes on the order of days.
#
#   */5 * * * * /mnt/user/appdata/zekktris/ops/livekit-wan-watchdog.sh
#
# Restarting the SFU DROPS EVERY CALL IN PROGRESS, including the LAN ones that
# were still working. That is the deliberate trade: a WAN change has already
# broken every remote participant, and a few seconds of reconnect beats days of
# silent breakage. Everything below exists to make sure we only pay that cost
# when the address has genuinely moved.

set -uo pipefail

CONTAINER="${LIVEKIT_CONTAINER:-zekktris-livekit}"

log() { printf '%s livekit-watchdog: %s\n' "$(date -Is)" "$*"; }

is_ipv4() {
    [[ "${1:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

# What the SFU is CURRENTLY telling clients to send media to. Read from the
# container's own log rather than a state file we keep alongside it: a state
# file can drift out of agreement with reality (someone restarts the container
# by hand, the file is lost, the SFU picks a different address), whereas the log
# is the SFU's own account of what it decided. Bounded by the container's start
# time so this stays cheap on a long-running container.
# Where the discovered address is remembered between runs. See below for why
# reading the log is not enough on its own.
STATE="${LIVEKIT_WAN_STATE:-$(dirname "$0")/../.livekit-wan.state}"

advertised_ip() {
    local started state_started state_ip from_log
    started=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null) || return 1

    # THE LOG IS NOT A DURABLE SOURCE. LiveKit prints its STUN-discovered
    # address once, at startup, and compose rotates these logs (10 MB × 5). On
    # a busy server those lines are gone within days — after which this
    # function returned nothing, the watchdog skipped every run, and the thing
    # written to catch silent voice breakage broke silently itself. Exactly the
    # failure it exists to prevent.
    #
    # So the log is read only when it is FRESH — when the container has
    # restarted since we last looked, which is also the only moment the address
    # can have changed. Otherwise the remembered value stands.
    if [[ -f "$STATE" ]]; then
        read -r state_started state_ip < "$STATE" || true
        if [[ "$state_started" == "$started" && -n "${state_ip:-}" ]]; then
            printf '%s' "$state_ip"
            return 0
        fi
    fi

    # Container is new (or nothing is remembered): the startup lines are recent,
    # so take the LAST one — that is this boot's discovery.
    from_log="$(docker logs "$CONTAINER" 2>&1 \
        | grep -o '"externalIP": "[0-9.]*"' \
        | grep -oE '[0-9]+(\.[0-9]+){3}' \
        | tail -1)"
    if is_ipv4 "$from_log"; then
        printf '%s %s\n' "$started" "$from_log" > "$STATE" 2>/dev/null || true
        printf '%s' "$from_log"
        return 0
    fi
    return 1
}

# Our WAN address right now. Two independent providers must AGREE before we
# believe it. A single flaky lookup returning a captive-portal address or a
# CDN's own IP would otherwise restart the SFU and drop every live call for
# nothing — the one failure mode that would make this script worse than the
# problem it fixes.
current_ip() {
    local a b
    a=$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null)
    is_ipv4 "$a" || return 1
    b=$(curl -fsS -m 10 https://ifconfig.me/ip 2>/dev/null)
    is_ipv4 "$b" || return 1
    [[ "$a" == "$b" ]] || return 1
    printf '%s' "$a"
}

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    # Not running is somebody else's problem — a restart here would fight
    # whatever is already trying to bring it up (or crash-loop it every 5 min).
    log "container $CONTAINER is not running; nothing to do"
    exit 0
fi

advertised=$(advertised_ip)
if ! is_ipv4 "$advertised"; then
    # Usually means the container restarted seconds ago and has not logged its
    # STUN result yet. Next run will catch it.
    log "no advertised external IP in the log yet; skipping"
    exit 0
fi

if ! current=$(current_ip); then
    log "WAN lookup failed or the two providers disagreed; skipping (advertised=$advertised)"
    exit 0
fi

if [[ "$advertised" == "$current" ]]; then
    log "ok — advertised and actual WAN address agree ($current)"
    exit 0
fi

log "WAN address changed: SFU is advertising $advertised, we are actually $current"
log "restarting $CONTAINER so it re-discovers (this drops calls in progress)"
if docker restart "$CONTAINER" >/dev/null 2>&1; then
    # Remember what it will now be advertising, keyed to the NEW start time, so
    # the next run compares against reality rather than re-reading a log that
    # will rotate away again.
    NEW_STARTED=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null)
    printf '%s %s\n' "$NEW_STARTED" "$current" > "$STATE" 2>/dev/null || true
    log "restarted $CONTAINER"
else
    log "ERROR: failed to restart $CONTAINER"
    exit 1
fi
