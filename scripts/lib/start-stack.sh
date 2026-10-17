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

# Docker's own health status for the api, because that is what the proxy's
# depends_on reads: healthy, starting or unhealthy; "none" for an api without a
# healthcheck (a compose override), nothing when there is no api container.
api_health() {
    local id status
    id="$($COMPOSE ps -q api 2>/dev/null | head -1)"
    [[ -n "$id" ]] || return 0
    status="$(${DOCKER:-docker} inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null)" || return 0
    echo "${status:-none}"
}

# The api answering inside its container — what Docker's next probe will see.
api_answers() {
    $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/health/ready >/dev/null 2>&1
}

# wait_for_api SECONDS [NOTE] → 0 once Docker reports the api healthy, 1 once
# it is clearly not going to. Docker probes every 30s after a 30s start period
# (ops/Dockerfile.api), so it can be a while behind the api; SECONDS is how
# long to wait when nothing below explains the delay.
#  - While Docker still says "starting" the wait goes on, for up to 150s after
#    it began (the start period plus three probes, with slack): a slow boot —
#    a heavy migration — is only a failure once Docker says so, which is also
#    all a plain `up -d` waited for.
#  - A handover in progress restarts the SECONDS clock, for up to an hour, and
#    NOTE is printed (warn) the first time one is seen.
#  - Once the api answers but Docker still holds it unhealthy (from a long
#    handover), Docker gets 45s — one probe interval plus its timeout — to
#    notice.
wait_for_api() {
    local grace="$1"
    local note="${2:-the api is handing uploads/ to its unprivileged user (once) — waiting for that, up to an hour}"
    local t status hold noted=0 flip=0
    t=$(date +%s)
    local deadline=$(( t + grace )) pending=$(( t + 150 )) limit=$(( t + 3600 ))
    while :; do
        status="$(api_health)"
        [[ "$status" == healthy ]] && return 0
        [[ "$status" == none ]] && api_answers && return 0
        t=$(date +%s); hold=0
        if [[ $t -lt $limit ]] && handover_running; then
            [[ $noted -eq 1 ]] || warn "$note"
            noted=1; deadline=$(( t + grace ))
        elif [[ "$status" == starting ]]; then
            [[ $t -ge $pending ]] || hold=1
        elif [[ "$status" == unhealthy ]] && api_answers; then
            [[ $flip -ne 0 ]] || flip=$(( t + 45 ))
            [[ $t -ge $flip ]] || hold=1
        fi
        [[ $hold -eq 1 || $t -lt $deadline ]] || return 1
        sleep 3
    done
}
