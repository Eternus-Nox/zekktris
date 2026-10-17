#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Starts livekit-server with its signalling + admin API port (7880) listening
# only where something legitimately connects to it, instead of on every
# interface of the host (LiveKit runs on host networking, so "every interface"
# includes the public one on a VPS with no firewall).
#
# Who connects to 7880: Caddy's /livekit proxy and the api, both through
# host.docker.internal — which Docker resolves to the default bridge's gateway,
# the docker0 address. Browsers never do (signalling rides the app's own
# origin through Caddy). So by default this binds 127.0.0.1 + the docker0
# address. Media ports (7881/tcp, 7882/udp) are not affected.
#
# LIVEKIT_BIND_ADDRESSES (in .env) overrides it: space- or comma-separated
# addresses, or "all" for every interface (the old behaviour). Every interface
# is also kept, with a log line, when no docker0 address is found, and on
# Docker Desktop / WSL kernels, where host networking and host.docker.internal
# do not map onto docker0 like this.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

binds="$(printf '%s' "${LIVEKIT_BIND_ADDRESSES:-}" | tr ',' ' ')"
if [ -z "$(printf '%s' "$binds" | tr -d ' ')" ]; then
    case "$(uname -r)" in
        *linuxkit*|*microsoft*|*WSL*)
            echo "livekit-entrypoint: Docker Desktop/WSL — port 7880 listens on every interface" >&2
            binds=all ;;
        *)
            gateway="$(ip -4 addr show dev docker0 2>/dev/null | awk '/inet /{split($2, a, "/"); print a[1]; exit}')"
            if [ -n "$gateway" ]; then
                binds="127.0.0.1 $gateway"
            else
                echo "livekit-entrypoint: no docker0 address found — port 7880 listens on every interface" \
                     "(set LIVEKIT_BIND_ADDRESSES to restrict it)" >&2
                binds=all
            fi ;;
    esac
fi

if [ "$binds" != "all" ]; then
    for address in $binds; do
        set -- "$@" --bind "$address"
    done
    echo "livekit-entrypoint: port 7880 listens on: $binds" >&2
fi
exec /livekit-server "$@"
