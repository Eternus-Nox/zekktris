# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# Bringing the stack up after a build or a restore: the api first, the rest
# once it is healthy. Sourced by install.sh, scripts/update.sh,
# scripts/restore.sh and scripts/agent.sh, which set $COMPOSE (and install.sh
# $DOCKER) and a warn() first.
#
# WHY NOT ONE `docker compose up -d`. The proxy waits for the api to be
# HEALTHY (depends_on: service_healthy). On its first boot after it stopped
# running as root, the api hands uploads/ to its own user before it starts
# (ops/api-entrypoint.sh), and on a large tree that outlasts the image's
# HEALTHCHECK grace (about two minutes): Docker marks the api unhealthy and a
# plain `up -d` fails with "dependency failed to start: container zekktris-api
# is unhealthy", leaving a just-recreated proxy created but never started.
# `up -d api` waits for the api's own dependencies (db, cache) but not for the
# api itself, so wait_for_api can tell a handover that is still going from a
# real failure, and only then is the rest started.
# ─────────────────────────────────────────────────────────────────────────────

# True while that handover is still going.
handover_running() {
    local last
    last="$($COMPOSE logs --tail 200 api 2>&1 | grep -E 'api-entrypoint: (handing|handed|could not hand)' | tail -1 || true)"
    [[ "$last" == *"api-entrypoint: handing "* ]]
}

# Docker's own verdict, because that is what the proxy's depends_on reads: the
# api answering inside its container is not enough while Docker still holds it
# unhealthy from a long handover (that clears on its next probe, up to 30s
# later). An api without a healthcheck (a compose override) is asked directly.
api_healthy() {
    local id status
    id="$($COMPOSE ps -q api 2>/dev/null | head -1)"
    [[ -n "$id" ]] || return 1
    status="$(${DOCKER:-docker} inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null)" || return 1
    case "$status" in
        healthy) return 0 ;;
        "") $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 ;;
        *) return 1 ;;
    esac
}

# wait_for_api SECONDS [NOTE] → 0 once the api is healthy, 1 after SECONDS
# without it. A handover in progress restarts that clock, for up to an hour,
# and NOTE is printed (warn) the first time one is seen.
wait_for_api() {
    local grace="$1"
    local note="${2:-the api is handing uploads/ to its unprivileged user (once) — waiting for that, up to an hour}"
    local deadline=$(( $(date +%s) + grace )) limit=$(( $(date +%s) + 3600 )) noted=0
    while [[ $(date +%s) -lt $deadline ]]; do
        api_healthy && return 0
        if [[ $(date +%s) -lt $limit ]] && handover_running; then
            [[ $noted -eq 1 ]] || warn "$note"
            noted=1; deadline=$(( $(date +%s) + grace ))
        fi
        sleep 3
    done
    return 1
}
