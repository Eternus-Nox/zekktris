#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Zekktris — one-command first-run setup
#
#   usage: ./scripts/setup.sh
#
# What it does:
#   1. If .env doesn't exist, copies from .env.example and fills in fresh
#      cryptographic secrets (DB_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET).
#   2. Ensures the appdata directory exists and is writable.
#   3. Brings up the Docker stack with `docker compose up -d`.
#   4. Tails the api logs until startup checks pass, then prints the URL.
#
# Idempotent: re-running with an existing .env just (re)starts the stack.
# Refuses to overwrite an existing .env — your secrets are protected.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve to the project root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Pretty colors when stdout is a terminal; plain text when piped (e.g. CI).
if [[ -t 1 ]]; then
    BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
    GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
    RED="$(printf '\033[31m')"; RESET="$(printf '\033[0m')"
else
    BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

step() { echo "${BOLD}▶${RESET} $*"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
fail() { echo "  ${RED}✗${RESET} $*" >&2; exit 1; }

# ── 1. Pre-flight checks ────────────────────────────────────────────────────

step "Checking prerequisites"

command -v docker  >/dev/null 2>&1 || fail "docker not found in PATH"
command -v openssl >/dev/null 2>&1 || fail "openssl not found in PATH"

# `docker compose` (v2 plugin) is the modern path; `docker-compose` is legacy.
# We support both — pick whichever is installed.
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    fail "docker compose not found (need either 'docker compose' v2 plugin or 'docker-compose' v1)"
fi
ok "Using: $COMPOSE"

# ── 2. .env handling ────────────────────────────────────────────────────────

step "Preparing .env"

if [[ -f .env ]]; then
    ok ".env already exists — leaving it alone"
else
    if [[ ! -f .env.example ]]; then
        fail ".env.example missing; can't generate .env"
    fi

    # Same generation logic as scripts/generate-secrets.sh — inlined here so
    # users don't need to chain two scripts. Keep them in sync if the
    # template ever grows new secret placeholders.
    DB_PASSWORD="$(openssl rand -hex 24)"
    JWT_SECRET="$(openssl rand -hex 32)"
    JWT_REFRESH_SECRET="$(openssl rand -hex 32)"
    # At-rest encryption for TOTP secrets and bot tokens. This MUST be
    # substituted: .env.example ships a non-empty placeholder, and env.ts
    # only treats the EMPTY string as "unset" — so leaving the placeholder
    # in place fails validation and the api exits(1) before binding, which
    # `restart: unless-stopped` turns into an endless crash loop.
    FIELD_ENCRYPTION_KEY="$(openssl rand -hex 32)"

    # ── Public URL ─────────────────────────────────────────────────────
    # Default is the production deployment for this fork. Replace if you
    # fork the repo for a different deployment. Override at runtime with
    # `PUBLIC_URL=https://other.example.com ./scripts/setup.sh`.
    PUBLIC_URL_DEFAULT="${PUBLIC_URL:-https://zekktris.com}"
    # Cookie secure flag must match PUBLIC_URL — `true` for https://,
    # `false` for http://. Auto-derive from the URL scheme so users who
    # override one don't have to remember the other.
    if [[ "$PUBLIC_URL_DEFAULT" == https://* ]]; then
        COOKIE_SECURE_DEFAULT="true"
    else
        COOKIE_SECURE_DEFAULT="false"
    fi

    # ── LiveKit (voice/video) — self-hosted by default ─────────────────
    # The stack bundles its own LiveKit SFU (the `livekit` service in
    # docker-compose.yml, on by default), so we generate a fresh API
    # key/secret pair for it here. Both the api and the livekit container
    # read these same values. LIVEKIT_WS_URL is left EMPTY on purpose: the
    # api then derives a same-origin wss://<PUBLIC_URL host>/livekit URL
    # that Caddy proxies to the SFU.
    #
    # To use LiveKit Cloud instead, set LIVEKIT_WS_URL (+ the cloud
    # key/secret) in the generated .env afterward.
    LIVEKIT_WS_URL_DEFAULT=""
    LIVEKIT_API_KEY_DEFAULT="lk_$(openssl rand -hex 8)"
    LIVEKIT_API_SECRET_DEFAULT="$(openssl rand -hex 32)"
    # LIVEKIT_HOST is the media IP advertised to browsers. Leave empty for
    # a public host (LiveKit STUN-detects its public IP); set it to your
    # LAN IP for a LAN-only deployment.
    LIVEKIT_HOST=""

    sed \
        -e "s|change-me-to-a-long-random-string|${DB_PASSWORD}|g" \
        -e "s|replace-with-32-bytes-of-random-hex|${JWT_SECRET}|" \
        -e "s|replace-with-different-32-bytes-of-random-hex|${JWT_REFRESH_SECRET}|" \
        -e "s|replace-with-field-key-32-bytes-of-random-hex-or-leave-blank|${FIELD_ENCRYPTION_KEY}|" \
        -e "s|^PUBLIC_URL=.*|PUBLIC_URL=${PUBLIC_URL_DEFAULT}|" \
        -e "s|^COOKIE_SECURE=.*|COOKIE_SECURE=${COOKIE_SECURE_DEFAULT}|" \
        -e "s|^LIVEKIT_API_KEY=.*|LIVEKIT_API_KEY=${LIVEKIT_API_KEY_DEFAULT}|" \
        -e "s|^LIVEKIT_API_SECRET=.*|LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET_DEFAULT}|" \
        -e "s|^LIVEKIT_WS_URL=.*|LIVEKIT_WS_URL=${LIVEKIT_WS_URL_DEFAULT}|" \
        -e "s|^LIVEKIT_HOST=.*|LIVEKIT_HOST=${LIVEKIT_HOST}|" \
        .env.example >.env
    chmod 600 .env

    ok "Generated .env with fresh secrets (chmod 600)"
    ok "Public URL: ${PUBLIC_URL_DEFAULT}"
    ok "Voice configured for the bundled self-hosted LiveKit (signaling proxied at /livekit)"
fi

# ── 2b. Patch an existing .env that's missing voice config ───────────────────
#
# Top up missing LiveKit values so voice "just works" on the next
# `docker compose up` without a full .env regeneration (which would also
# rotate JWT and DB secrets — disruptive). Self-hosted is the default: we
# generate a local key/secret and leave LIVEKIT_WS_URL EMPTY so the api
# derives a same-origin /livekit URL proxied by Caddy.

# Known leaked LiveKit Cloud creds that earlier versions of this script
# committed to source — migrate anyone still on them onto fresh local keys.
LIVEKIT_LEAKED_WS_URL="wss://zekktris-k8dn39yn.livekit.cloud"
LIVEKIT_LEAKED_API_KEY="APIAMD7Sj5psuK4"
LIVEKIT_LEAKED_API_SECRET="REDACTED-LEAKED-LIVEKIT-SECRET"
LIVEKIT_API_KEY_DEFAULT="lk_$(openssl rand -hex 8)"
LIVEKIT_API_SECRET_DEFAULT="$(openssl rand -hex 32)"
PUBLIC_URL_DEFAULT_PATCH="${PUBLIC_URL:-https://zekktris.com}"

patch_env_if_blank() {
    local key="$1"
    local default_value="$2"
    # Match either "KEY=" with nothing after, or "KEY=" missing entirely.
    if grep -qE "^${key}=$" .env 2>/dev/null; then
        # Has the key but it's empty — replace the line.
        sed -i "s|^${key}=$|${key}=${default_value}|" .env
        echo "  filled in ${key}"
    elif ! grep -qE "^${key}=" .env 2>/dev/null; then
        # Key absent entirely — append.
        echo "${key}=${default_value}" >>.env
        echo "  added ${key}"
    fi
}

# Replace a key's value if it currently matches a known placeholder. Used
# for migrating users off the localhost defaults onto the production URL.
patch_env_if_matches() {
    local key="$1"
    local placeholder="$2"
    local new_value="$3"
    # Escape regex/sed metachars in the placeholder match. We're matching
    # full lines, so this is just basic-regex escaping for the LHS.
    local escaped_placeholder
    escaped_placeholder="$(printf '%s' "$placeholder" | sed -e 's/[\/&|]/\\&/g')"
    if grep -qE "^${key}=${escaped_placeholder}$" .env 2>/dev/null; then
        local escaped_new
        escaped_new="$(printf '%s' "$new_value" | sed -e 's/[\/&|]/\\&/g')"
        sed -i "s|^${key}=${escaped_placeholder}$|${key}=${escaped_new}|" .env
        echo "  updated ${key} (was ${placeholder})"
    fi
}

if [[ -f .env ]]; then
    PATCHED=0

    # Migrate anyone still on the leaked committed LiveKit Cloud creds onto
    # fresh local keys for the bundled SFU, and clear the cloud WS URL so
    # the api falls back to the same-origin /livekit proxy.
    if grep -qE "^LIVEKIT_API_KEY=${LIVEKIT_LEAKED_API_KEY}$" .env 2>/dev/null; then
        step "Migrating off the old shared LiveKit Cloud project to a local SFU"
        patch_env_if_matches "LIVEKIT_WS_URL" "$LIVEKIT_LEAKED_WS_URL" ""
        patch_env_if_matches "LIVEKIT_API_KEY" "$LIVEKIT_LEAKED_API_KEY" "$LIVEKIT_API_KEY_DEFAULT"
        patch_env_if_matches "LIVEKIT_API_SECRET" "$LIVEKIT_LEAKED_API_SECRET" "$LIVEKIT_API_SECRET_DEFAULT"
        PATCHED=1
    fi

    # Fill in blank/missing voice keys (self-hosted SFU). WS_URL is left
    # untouched — empty means "use the bundled SFU via the /livekit proxy".
    if grep -qE "^LIVEKIT_(API_KEY|API_SECRET)=$" .env 2>/dev/null \
       || ! grep -qE "^LIVEKIT_API_KEY=" .env 2>/dev/null; then
        step "Generating local LiveKit key/secret in .env"
        patch_env_if_blank "LIVEKIT_API_KEY" "$LIVEKIT_API_KEY_DEFAULT"
        patch_env_if_blank "LIVEKIT_API_SECRET" "$LIVEKIT_API_SECRET_DEFAULT"
        PATCHED=1
    fi

    # Migrate users still on the localhost-HTTP defaults to the production
    # HTTPS URL. We only patch when the value EXACTLY matches a known
    # placeholder so any custom URL the user typed in is preserved. The
    # cookie flag flips together with the URL — they have to agree or
    # login silently breaks (browser drops Secure cookies on plain HTTP).
    if grep -qE '^PUBLIC_URL=http://localhost:5550$' .env 2>/dev/null; then
        step "Migrating PUBLIC_URL off the localhost default"
        patch_env_if_matches "PUBLIC_URL" "http://localhost:5550" "$PUBLIC_URL_DEFAULT_PATCH"
        if [[ "$PUBLIC_URL_DEFAULT_PATCH" == https://* ]]; then
            patch_env_if_matches "COOKIE_SECURE" "false" "true"
        fi
        PATCHED=1
    fi

    # Migrate the stale eternusnox.com domain (baked into older .env files
    # by previous versions of this script) onto the canonical zekktris.com.
    # Only rewrites an EXACT match, so any custom URL is preserved.
    if grep -qE '^PUBLIC_URL=https://zekktris\.eternusnox\.com$' .env 2>/dev/null; then
        step "Migrating PUBLIC_URL off the old zekktris.eternusnox.com domain"
        patch_env_if_matches "PUBLIC_URL" "https://zekktris.eternusnox.com" "https://zekktris.com"
        PATCHED=1
    fi

    [[ $PATCHED -eq 1 ]] && ok "Config patched"

    # ── Push notifications (VAPID) ──────────────────────────────────────
    # Generate a VAPID keypair if push notifications aren't configured.
    # VAPID is a P-256 ECDSA keypair encoded base64url; we can derive
    # both halves from a single openssl-generated DER private key by
    # slicing the SEC1 structure directly (no Node, no extra deps).
    #
    # Layout of SEC1 EC private key DER for P-256:
    #   30 77                                ; SEQUENCE 119 bytes
    #     02 01 01                           ; version 1
    #     04 20 <32-byte private key>        ; OCTET STRING
    #     A0 0A 06 08 2A 86 48 CE 3D 03 01 07  ; curve OID
    #     A1 44 03 42 00 04 <64-byte pub xy> ; uncompressed point
    #
    # Private = bytes [7..38], Public = last 65 bytes (the leading 04
    # indicates an uncompressed point, which is what VAPID expects).
    # base64url = base64 with +/ → -_ and stripped padding.
    if grep -qE '^VAPID_(PUBLIC|PRIVATE)_KEY=$' .env 2>/dev/null \
       || ! grep -qE '^VAPID_PUBLIC_KEY=' .env 2>/dev/null; then
        step "Generating VAPID keypair for push notifications"
        VAPID_TMP="$(mktemp -t zekktris-vapid.XXXXXX)"
        trap 'rm -f "$VAPID_TMP"' EXIT
        if openssl ecparam -name prime256v1 -genkey -noout -outform DER >"$VAPID_TMP" 2>/dev/null \
           && [[ "$(wc -c <"$VAPID_TMP")" -ge 121 ]]; then
            # base64url helper: pipe binary in, get url-safe base64 out
            b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
            VAPID_PRIVATE="$(dd if="$VAPID_TMP" bs=1 skip=7 count=32 2>/dev/null | b64url)"
            VAPID_TOTAL="$(wc -c <"$VAPID_TMP")"
            VAPID_PUBLIC="$(dd if="$VAPID_TMP" bs=1 skip=$((VAPID_TOTAL - 65)) count=65 2>/dev/null | b64url)"

            if [[ -n "$VAPID_PRIVATE" && -n "$VAPID_PUBLIC" ]]; then
                patch_env_if_blank "VAPID_PUBLIC_KEY"  "$VAPID_PUBLIC"
                patch_env_if_blank "VAPID_PRIVATE_KEY" "$VAPID_PRIVATE"
                # VAPID_CONTACT_EMAIL is whatever ACME_EMAIL was set to,
                # falling back to a generic placeholder. Push providers
                # use this to reach the deploying admin if a subscription
                # endpoint starts misbehaving.
                CONTACT_EMAIL="$(grep -E '^ACME_EMAIL=' .env 2>/dev/null | head -1 \
                    | sed -E 's/^ACME_EMAIL=//; s/^"(.*)"$/\1/')"
                CONTACT_EMAIL="${CONTACT_EMAIL:-admin@example.com}"
                patch_env_if_blank "VAPID_CONTACT_EMAIL" "$CONTACT_EMAIL"
                ok "VAPID keypair written to .env"
                ok "Contact: ${CONTACT_EMAIL}  (edit VAPID_CONTACT_EMAIL in .env to change)"
            else
                warn "openssl produced unexpected DER output; VAPID skipped"
            fi
        else
            warn "openssl ecparam failed; VAPID skipped"
            warn "You can fall back to: npx web-push generate-vapid-keys"
        fi
        rm -f "$VAPID_TMP"
        trap - EXIT
    fi
fi

# Read APPDATA_PATH from the env file (or default if missing). Strip optional
# surrounding quotes — env files use bare values but defensive code is cheap.
APPDATA_PATH_VALUE="$(
    grep -E '^APPDATA_PATH=' .env 2>/dev/null \
        | head -1 \
        | sed -E 's/^APPDATA_PATH=//; s/^"(.*)"$/\1/; s|^'"'"'(.*)'"'"'$|\1|'
)"
APPDATA_PATH_VALUE="${APPDATA_PATH_VALUE:-/mnt/user/appdata/zekktris}"

# ── 3. Appdata directory ────────────────────────────────────────────────────

step "Preparing appdata directory: ${APPDATA_PATH_VALUE}"

# Try to mkdir -p. If it fails (typically permission-denied because we're
# running as a non-root user trying to write to /mnt/user/appdata on a
# system that doesn't have it pre-created), warn but don't abort — Docker
# will create the bind-mount roots itself when the containers start.
if mkdir -p "$APPDATA_PATH_VALUE" 2>/dev/null; then
    ok "Directory ready"
else
    warn "Could not create $APPDATA_PATH_VALUE as the current user."
    warn "Docker will create the bind-mount roots on first 'compose up'."
    warn "If you're not on unraid, set APPDATA_PATH in .env to a path you own."
fi

# ── 4. Bring the stack up ───────────────────────────────────────────────────

step "Building and starting the stack"
$COMPOSE up -d --build

# ── 5. Wait for healthy api ─────────────────────────────────────────────────
#
# The api runs ten startup checks before serving the /health endpoint. Watch
# for it to come up so this script's exit signals "ready to use", not just
# "containers are launched."

step "Waiting for api startup checks (up to 90 seconds)"

# Read PUBLIC_URL + HTTP_PORT to construct the local healthcheck target.
# We probe the api container directly via compose exec to avoid relying on
# host networking — this works the same whether the user changed HTTP_PORT
# or not.
DEADLINE=$(( $(date +%s) + 90 ))
HEALTHY=0
while [[ $(date +%s) -lt $DEADLINE ]]; do
    if $COMPOSE exec -T api wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then
        HEALTHY=1
        break
    fi
    sleep 2
done

if [[ $HEALTHY -eq 1 ]]; then
    ok "api is healthy"
else
    warn "api didn't become healthy within 90s. Surfacing its logs:"
    echo
    echo "${DIM}─── docker compose logs api (last 80 lines) ────────────────${RESET}"
    $COMPOSE logs --tail=80 api || true
    echo "${DIM}─────────────────────────────────────────────────────────────${RESET}"
    echo
    warn "Common causes:"
    warn "  - DATABASE_URL/DB_PASSWORD mismatch (re-run setup with a fresh appdata to reset)"
    warn "  - Stale postgres data on the volume from a previous deploy with different DB_PASSWORD"
    warn "  - Bind-mount permissions on \$APPDATA_PATH (try: sudo chown -R 1000:1000 \"$APPDATA_PATH_VALUE\")"
    warn "  - Migrations folder missing from image (rebuild: $COMPOSE build --no-cache api)"
    echo
    warn "After fixing, re-run: ${BOLD}$COMPOSE restart api${RESET}"
    exit 1
fi

# ── 6. Final report ─────────────────────────────────────────────────────────

PUBLIC_URL_VALUE="$(grep -E '^PUBLIC_URL=' .env | head -1 | sed -E 's/^PUBLIC_URL=//; s/^"(.*)"$/\1/')"
PUBLIC_URL_VALUE="${PUBLIC_URL_VALUE:-http://localhost}"

echo
echo "${BOLD}${GREEN}Zekktris is running.${RESET}"
echo
echo "  Open in your browser:  ${BOLD}${PUBLIC_URL_VALUE}${RESET}"
echo "  Tail logs:             ${DIM}$COMPOSE logs -f${RESET}"
echo "  Stop everything:       ${DIM}$COMPOSE down${RESET}"
echo "  Restart everything:    ${DIM}$COMPOSE restart${RESET}"
echo
echo "First user to register becomes the administrator. The data lives in"
echo "${BOLD}${APPDATA_PATH_VALUE}${RESET} — back up its 'db' and 'uploads' subdirs to preserve state."
