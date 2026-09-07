#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Capture a COMPLETE, restorable snapshot of this instance.
#
# Why this exists: `instanceBackup.ts` sounds like it covers this and does not —
# its own header says it is a *configuration* backup (guilds, roles, channels)
# and that "users, memberships, and messages are out of scope". So until this
# script, there was no path at all from a running instance to a rebuilt one.
#
# What goes in the bundle, and why each part is non-optional:
#
#   db.dump      pg_dump custom format. Every message, account and membership.
#   uploads/     Attachments. The CDN streams straight off this directory, so
#                without it every image in every conversation 404s.
#   .env         Config AND the field-encryption keys. Encrypted DB columns are
#                unreadable without them — a dump alone is NOT a backup.
#   secrets/     The APNs .p8 lives here.
#   MANIFEST     Commit, image tags, timestamp, sizes. What this was taken from.
#
# THE BUNDLE IS AS SENSITIVE AS THE SERVER. It contains the database, the
# encryption keys and the push credentials. It is written 0600; keep it that way
# and treat a copy of it as a copy of the instance.
#
# Safe to run against a live stack: pg_dump takes a consistent snapshot without
# locking writers.
#
# Usage:  ./scripts/backup.sh [output-directory]      (default ./backups)
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

OUT_DIR="${1:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

command -v docker >/dev/null 2>&1 || fail "docker not found in PATH"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else fail "docker compose not found"; fi

[[ -f .env ]] || fail ".env not found — run this from the instance directory"

# APPDATA_PATH decides where uploads actually live; it defaults to the unraid
# path in docker-compose.yml, so read it the same way compose does.
APPDATA="$(grep -E '^APPDATA_PATH=' .env | cut -d= -f2- | tr -d '"'"'"'' || true)"
APPDATA="${APPDATA:-/mnt/user/appdata/zekktris}"

step "Backing up instance from ${ROOT}"

# ── database ────────────────────────────────────────────────────────────────
step "Dumping database"
$COMPOSE ps db --format '{{.State}}' 2>/dev/null | grep -q running \
    || fail "the 'db' service is not running — start the stack before backing up"

# Custom format (-Fc): compressed, and pg_restore can be selective on the way
# back in. Piped straight out of the container so nothing large is staged
# inside it.
if ! $COMPOSE exec -T db pg_dump -U commune -d commune -Fc > "$STAGE/db.dump" 2>"$STAGE/db.err"; then
    cat "$STAGE/db.err" >&2
    fail "pg_dump failed"
fi
DB_BYTES=$(wc -c < "$STAGE/db.dump" | tr -d ' ')
[[ "$DB_BYTES" -gt 1000 ]] || fail "database dump is suspiciously small (${DB_BYTES} bytes) — refusing to write a bundle that probably restores nothing"
ok "database: $(( DB_BYTES / 1024 )) KiB"

# ── uploads ─────────────────────────────────────────────────────────────────
step "Archiving uploads"
if [[ -d "$APPDATA/uploads" ]]; then
    tar -cf "$STAGE/uploads.tar" -C "$APPDATA" uploads 2>/dev/null || \
        warn "some files could not be read (permissions?) — bundle may be incomplete"
    ok "uploads: $(du -h "$STAGE/uploads.tar" | cut -f1)"
else
    warn "no uploads directory at $APPDATA/uploads — skipping (attachments will be missing on restore)"
    tar -cf "$STAGE/uploads.tar" -T /dev/null
fi

# ── config + secrets ────────────────────────────────────────────────────────
step "Capturing config and secrets"
cp .env "$STAGE/env"
if [[ -d secrets ]]; then
    tar -cf "$STAGE/secrets.tar" secrets
    ok "secrets/ included"
else
    tar -cf "$STAGE/secrets.tar" -T /dev/null
    warn "no secrets/ directory — APNs key not captured"
fi

# ── manifest ────────────────────────────────────────────────────────────────
{
    echo "taken_at=$(date -Iseconds)"
    echo "host=$(hostname)"
    echo "git_commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "git_dirty=$(if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then echo yes; else echo no; fi)"
    echo "appdata_path=$APPDATA"
    echo "db_bytes=$DB_BYTES"
    echo "uploads_bytes=$(wc -c < "$STAGE/uploads.tar" | tr -d ' ')"
    echo "images=$($COMPOSE images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | tr '\n' ' ' || echo unknown)"
} > "$STAGE/MANIFEST"

# ── seal ────────────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
BUNDLE="$OUT_DIR/zekktris-$STAMP.tar.gz"
# Created 0600 BEFORE anything is written into it: this file contains the
# database, the field-encryption keys and the push credentials.
( umask 077; tar -czf "$BUNDLE" -C "$STAGE" db.dump uploads.tar secrets.tar env MANIFEST )
chmod 600 "$BUNDLE"

echo
ok "Backup complete: ${BOLD}${BUNDLE}${RESET}"
ok "Size: $(du -h "$BUNDLE" | cut -f1)"
echo
warn "This bundle contains the database, the encryption keys and the push"
warn "credentials. Treat a copy of it as a copy of the server."
echo
echo "A backup you have never restored is a hypothesis. Verify this one:"
echo "  ./scripts/restore.sh --check $BUNDLE"
