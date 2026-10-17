#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Zekktris API entrypoint: start as root just long enough to hand the writable
# mounts to the unprivileged `node` user (uid 1000), then run the API as `node`.
#
# The api used to run as root, inside a container with a writable uploads
# volume and the control directory the root-run host agent (scripts/agent.sh)
# reads. Dropping root limits what a bug in the API could do to either.
#
# Only uploads/ and control/requests/ are handed over. control/ itself and
# control/status/ stay root's: the agent writes its lock, status and logs there
# as root, and a folder `node` owned would let it plant a symlink for root to
# write through.
#
# Existing installs are carried over, not broken:
#   * uploads and control/requests were written by root until now, so anything
#     there not already owned by `node` is chowned on the first boot (once —
#     see below). That can take a while on a large uploads tree.
#   * if that is impossible (an NFS export with root_squash, say) and `node`
#     still cannot write the uploads, the API keeps running as root, as before,
#     and says so in the log.
#   * an APNs key in ./secrets (mounted read-only at /keys) that `node` cannot
#     read is copied, as root, to a private directory only `node` can read.
#
# `docker compose exec api …` still runs as root; this only changes the server
# process.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

RUN_AS=node
as_node() { setpriv --reuid "$RUN_AS" --regid "$RUN_AS" --clear-groups "$@"; }

if [ "$(id -u)" != "0" ]; then
    # Already unprivileged (a `user:` override in compose): nothing to hand over.
    exec "$@"
fi

UPLOADS="${UPLOAD_DIR:-/data/uploads}"
CONTROL="${CONTROL_DIR:-/data/control}"

# The agent creates control/requests as root when it first runs. Create it here
# first so the API can always drop a request in.
mkdir -p "$UPLOADS" "$CONTROL/requests" 2>/dev/null || true
uploads_incomplete=0
for dir in "$UPLOADS" "$CONTROL/requests"; do
    # A folder already owned by `node` was handed over completely: its contents
    # are chowned first and the top folder only once every one of them
    # succeeded, so an interrupted or partly failed pass is redone next boot and
    # a finished one is not rescanned (uploads can be a very large tree).
    # chown -h: a symlink in there is re-owned itself, never what it points at.
    if [ "$(stat -c %U "$dir" 2>/dev/null)" != "$RUN_AS" ]; then
        echo "api-entrypoint: handing $dir to '$RUN_AS'" >&2
        if errors="$(find "$dir" -mindepth 1 ! -user "$RUN_AS" -exec chown -h "$RUN_AS:$RUN_AS" {} + 2>&1 >/dev/null)" \
            && [ -z "$errors" ] && chown -h "$RUN_AS:$RUN_AS" "$dir"; then
            echo "api-entrypoint: handed $dir to '$RUN_AS'" >&2
        else
            echo "api-entrypoint: could not hand all of $dir to '$RUN_AS':" >&2
            printf '%s\n' "$errors" | head -5 >&2
            [ "$dir" = "$UPLOADS" ] && uploads_incomplete=1
        fi
    fi
done

# Some of the uploads still root's would surface later as EACCES on a write
# into one of those folders, so that counts as "not writable" too.
if [ "$uploads_incomplete" = "1" ] || ! as_node test -w "$UPLOADS"; then
    echo "api-entrypoint: $UPLOADS is not writable by '$RUN_AS' or could not be handed over completely —" \
         "running as root as before. To drop root: chown -R 1000:1000 the uploads folder on the host." >&2
    exec "$@"
fi
if ! as_node test -w "$CONTROL/requests"; then
    echo "api-entrypoint: $CONTROL/requests is not writable by '$RUN_AS' — admin maintenance buttons will not queue" \
         "(chown -R 1000:1000 the control/requests folder on the host)." >&2
fi

# APNs drag-and-drop key (APNS_KEY_P8_FILE defaults to the /keys mount).
case "${APNS_KEY_P8_FILE:-}" in
    /keys|/keys/*)
        unreadable=0
        as_node test -r /keys -a -x /keys || unreadable=1
        for key in /keys/*.p8; do
            [ -e "$key" ] || continue
            as_node test -r "$key" || unreadable=1
        done
        if [ "$unreadable" = "1" ] && ls /keys/*.p8 >/dev/null 2>&1; then
            private=/run/zekktris-keys
            mkdir -p "$private"
            cp /keys/*.p8 "$private"/
            chown -R "$RUN_AS:$RUN_AS" "$private"
            chmod 700 "$private"
            chmod 400 "$private"/*.p8
            APNS_KEY_P8_FILE="$private${APNS_KEY_P8_FILE#/keys}"
            export APNS_KEY_P8_FILE
        fi
        ;;
esac

# setpriv changes ids only; HOME would still say /root.
export HOME=/home/node
exec setpriv --reuid "$RUN_AS" --regid "$RUN_AS" --clear-groups "$@"
