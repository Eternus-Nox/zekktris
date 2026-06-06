#!/usr/bin/env bash
# Zekktris Desktop - update / rebuild script (macOS / Linux)
# ----------------------------------------------------------
# Reinstalls deps, rebuilds the shell, and repackages the installer.
# Only needed when the desktop/ shell code changes - web-app updates
# reach the desktop app automatically since it loads your live server.
#
# Usage (from the desktop/ folder):
#   ./update.sh            # build installer for this OS
#   ./update.sh --run      # build + launch in dev (no installer)
#
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Zekktris Desktop update"
echo "    Folder: $(pwd)"

echo
echo "==> Installing dependencies (npm install)..."
npm install

if [[ "${1:-}" == "--run" ]]; then
  echo
  echo "==> Launching in dev mode..."
  exec npm run dev
fi

# Pick the platform target.
case "$(uname -s)" in
  Darwin) TARGET="dist:mac"; PATTERN="*.dmg" ;;
  Linux)  TARGET="dist:linux"; PATTERN="*.AppImage" ;;
  *)      TARGET="dist"; PATTERN="*" ;;
esac

echo
echo "==> Building installer (npm run $TARGET)..."
npm run "$TARGET"

echo
echo "==> Done. Output in: $(pwd)/release"
ls -1 release/ 2>/dev/null | grep -E "${PATTERN//\*/.*}" || true

# Publish: copy auto-update artifacts to a destination served at
# /desktop/updates/. Pass the path as the 2nd arg (or 1st if not --run).
#   ./update.sh --publish /path/synced/to/server/desktop-updates
PUBLISH=""
if [[ "${1:-}" == "--publish" ]]; then PUBLISH="${2:-}"; fi
if [[ -n "$PUBLISH" ]]; then
  echo
  echo "==> Publishing auto-update artifacts to: $PUBLISH"
  mkdir -p "$PUBLISH"
  shopt -s nullglob
  for f in release/latest*.yml release/*.blockmap release/*.AppImage release/*.dmg release/*.zip; do
    cp -f "$f" "$PUBLISH/" && echo "    + $(basename "$f")"
  done
  echo "==> Published. Installed apps will pick up the update."
fi
