#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Generate a production .env file with cryptographically strong secrets.
#
#   usage: ./scripts/generate-secrets.sh [target-file]
#
# By default writes to ./.env. If the target already exists, refuses to
# overwrite — the operator is responsible for protecting their secrets.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TARGET="${1:-.env}"
TEMPLATE="${2:-.env.example}"

if [[ -f "$TARGET" ]]; then
    echo "Refusing to overwrite existing $TARGET" >&2
    echo "If you really want fresh secrets, delete or rename it first." >&2
    exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
    echo "Template $TEMPLATE not found." >&2
    exit 1
fi

# Generate three independent secrets:
#  - DB_PASSWORD       — used by both compose (POSTGRES_PASSWORD) and the
#                         api's DATABASE_URL. They must agree, so we
#                         template both with the same value.
#  - JWT_SECRET         — for access-token signing
#  - JWT_REFRESH_SECRET — for refresh-token hashing pepper. Must DIFFER
#                         from JWT_SECRET; we generate independently.
DB_PASSWORD="$(openssl rand -hex 24)"
JWT_SECRET="$(openssl rand -hex 32)"
JWT_REFRESH_SECRET="$(openssl rand -hex 32)"
#  - FIELD_ENCRYPTION_KEY — at-rest encryption for TOTP/bot secrets. 32
#                           bytes of hex; must differ from the JWT secrets.
FIELD_ENCRYPTION_KEY="$(openssl rand -hex 32)"

# sed -i replacement is fragile when secrets contain regex metacharacters,
# but hex strings are safe (no $ / & / etc). Still, we use a delimiter that
# can't appear in hex (|).
sed \
    -e "s|change-me-to-a-long-random-string|${DB_PASSWORD}|g" \
    -e "s|replace-with-32-bytes-of-random-hex|${JWT_SECRET}|" \
    -e "s|replace-with-different-32-bytes-of-random-hex|${JWT_REFRESH_SECRET}|" \
    -e "s|replace-with-field-key-32-bytes-of-random-hex-or-leave-blank|${FIELD_ENCRYPTION_KEY}|" \
    "$TEMPLATE" >"$TARGET"

chmod 600 "$TARGET"

echo "Wrote $TARGET with fresh secrets (chmod 600)."
echo "Review it before bringing the stack up — in particular:"
echo "  - PUBLIC_URL          (default http://localhost)"
echo "  - APPDATA_PATH        (default ./data; set to /mnt/user/appdata/zekktris on unraid)"
echo "  - ALLOW_REGISTRATION  (default open)"
echo "  - HTTP_PORT           (default 80)"
