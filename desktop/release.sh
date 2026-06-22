#!/usr/bin/env bash
# Zekktris Desktop — one-command release pipeline (run on macOS)
# =============================================================
# Builds the desktop app for macOS + Windows + Linux and publishes the
# installers + the auto-update feed to the server's desktop-updates folder.
# Caddy serves that folder at https://<host>/desktop/updates/ — the SAME
# place the website download buttons AND the Electron auto-updater read from.
# So one run ships an update to every desktop platform at once.
#
#   ./release.sh                 # interactive: pick (1) macOS only, or
#                                #   (2) Linux + Windows via Docker (wine image)
#   ./release.sh --mac-only      # just macOS (fast local iteration; no prompt)
#   ./release.sh --cross docker  # all 3 incl. mac, Win+Linux in Docker (no prompt)
#   ./release.sh --no-bump       # rebuild + republish without bumping the version
#   ./release.sh --set-version 2.1.0
#   ./release.sh --dry-run       # show what it WOULD build/publish, do nothing
#
# Build matrix on a Mac:
#   macOS   — built natively (dmg + zip). The zip is what Squirrel.Mac
#             auto-update consumes; the dmg is the website download.
#   Windows — NSIS installer, built in the official electron-builder Docker
#             image (it bundles wine). `--cross wine` uses a locally-installed
#             wine instead; `--mac-only` skips it.
#   Linux   — AppImage, built in the same Docker image (or locally with wine off).
#
# Configure the publish target ONCE in desktop/.env.release (gitignored) — see
# .env.release.example. Either an SSH target (rsync over SSH to the host) or a
# locally-mounted share:
#   ZK_PUBLISH_SSH="root@tower:/mnt/user/appdata/zekktris/desktop-updates"
#   ZK_PUBLISH_DIR="/Volumes/appdata/zekktris/desktop-updates"
# Optional — fold the freshly-built Android APK into the same publish so the
# website's Android button updates too:
#   ZK_APK_PATH="$HOME/Desktop/zekktris/apps/web/android/app/build/outputs/apk/release/app-release.apk"
set -euo pipefail
cd "$(dirname "$0")"

# ── Defaults (override via flags or .env.release) ───────────────────────────
BUMP="patch"          # patch | minor | major | none
SETVER=""             # explicit X.Y.Z (wins over BUMP)
CROSS="docker"        # docker | wine | skip  (how to build win+linux)
MAC_ARCH="universal"  # universal | arm64 | x64  (universal runs on Intel + Apple Silicon)
MAC_SIGN="0"          # 1 to code-sign+notarize macOS (needs identity set up); 0 = unsigned
ONLY_MAC="0"
DO_MAC="1"            # 0 to skip the macOS build (Linux+Windows-only run)
EXPLICIT_TARGET="0"   # set when --mac-only/--cross is passed → skip the menu
DRYRUN="0"
ZK_PUBLISH_SSH="${ZK_PUBLISH_SSH:-}"
ZK_PUBLISH_DIR="${ZK_PUBLISH_DIR:-}"
ZK_APK_PATH="${ZK_APK_PATH:-}"

# Load saved config (publish target + any overrides). Kept out of git.
if [ -f .env.release ]; then set -a; . ./.env.release; set +a; fi

# ── Args ────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --bump) BUMP="${2:?}"; shift 2 ;;
    --no-bump) BUMP="none"; shift ;;
    --set-version) SETVER="${2:?}"; BUMP="none"; shift 2 ;;
    --cross) CROSS="${2:?}"; EXPLICIT_TARGET="1"; shift 2 ;;
    --mac-only) ONLY_MAC="1"; EXPLICIT_TARGET="1"; shift ;;
    --mac-arch) MAC_ARCH="${2:?}"; shift 2 ;;
    --sign) MAC_SIGN="1"; shift ;;
    --publish-ssh) ZK_PUBLISH_SSH="${2:?}"; shift 2 ;;
    --publish-dir) ZK_PUBLISH_DIR="${2:?}"; shift 2 ;;
    --dry-run) DRYRUN="1"; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!! \033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mxx \033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRYRUN" = "1" ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

[ "$(uname -s)" = "Darwin" ] || warn "This script is meant to run on macOS (you're on $(uname -s)). Continuing anyway."

# ── Interactive build-target menu ────────────────────────────────────────────
# When run from a terminal without an explicit target flag (--mac-only /
# --cross), ask what to build. Flags still bypass this for automated runs.
#   1) macOS only       — native dmg + zip; skips Windows + Linux.
#   2) Linux + Windows  — built in the electron-builder Docker image (bundles
#                         wine); skips mac. Needs the Docker daemon (colima) up.
if [ "$EXPLICIT_TARGET" = "0" ] && [ -t 0 ]; then
  echo
  say "What do you want to build?"
  printf '    1) macOS only\n'
  printf '    2) Linux + Windows (Docker wine image)\n'
  printf '\033[36m==>\033[0m Choose [1/2]: '
  read -r _choice || die "No selection — aborted."
  case "$_choice" in
    1) ONLY_MAC="1" ;;
    2) DO_MAC="0"; ONLY_MAC="0"; CROSS="docker" ;;
    *) die "Invalid choice: '$_choice' (pick 1 or 2)." ;;
  esac
fi

# ── 1. Version ──────────────────────────────────────────────────────────────
# electron-updater only offers an update when the PUBLISHED version is higher
# than the installed one, so the version MUST change for an update to reach
# anyone. Bump it (or set it explicitly) before building.
CUR="$(node -p "require('./package.json').version")"
if [ -n "$SETVER" ]; then
  say "Setting version $CUR → $SETVER"
  run "npm version \"$SETVER\" --no-git-tag-version >/dev/null"
elif [ "$BUMP" != "none" ]; then
  say "Bumping version ($BUMP) from $CUR"
  run "npm version \"$BUMP\" --no-git-tag-version >/dev/null"
else
  warn "Not bumping (current $CUR). Clients already on $CUR will NOT see this as an update."
fi
VER="$(node -p "require('./package.json').version")"
say "Releasing Zekktris desktop v$VER"

# ── 2. Install deps + build the shell bundles ───────────────────────────────
say "Installing deps + building main/preload (npm install && npm run build)"
run "npm install"
run "npm run build"

# ── 3. macOS (native) ───────────────────────────────────────────────────────
if [ "$DO_MAC" = "1" ]; then
  MAC_ENV=""
  if [ "$MAC_SIGN" != "1" ]; then
    # Disable auto-discovery of a signing identity so an unsigned local build
    # doesn't fail trying to sign. (Unsigned mac apps download + run via
    # right-click→Open, but macOS auto-update requires a SIGNED build.)
    MAC_ENV="CSC_IDENTITY_AUTO_DISCOVERY=false"
  fi
  say "Building macOS ($MAC_ARCH) dmg + zip"
  run "$MAC_ENV npx electron-builder --mac --$MAC_ARCH --publish never"
else
  warn "Skipping macOS build."
fi

# ── 4. Windows + Linux ──────────────────────────────────────────────────────
if [ "$ONLY_MAC" = "1" ] || [ "$CROSS" = "skip" ]; then
  warn "Skipping Windows + Linux (mac-only)."
else
  case "$CROSS" in
    docker)
      command -v docker >/dev/null || die "Docker not found. Install Docker Desktop, or use --cross wine, or --mac-only."
      say "Building Windows + Linux in the electron-builder Docker image (wine)"
      # Mount the project; shadow node_modules with an anonymous volume so the
      # container's Linux/wine npm install never clobbers the host's macOS
      # node_modules (esbuild/electron are platform-specific). Cache electron
      # downloads on the host so repeat runs are fast.
      run "docker run --rm \
        -v \"\$PWD\":/project \
        -v /project/node_modules \
        -v \"\${HOME}/.cache/electron\":/root/.cache/electron \
        -v \"\${HOME}/.cache/electron-builder\":/root/.cache/electron-builder \
        electronuserland/builder:wine \
        /bin/bash -c \"cd /project && npm install && npm run build && npx electron-builder --win --linux --publish never\""
      ;;
    wine)
      command -v wine >/dev/null || die "wine not found. 'brew install --cask wine-stable', or use --cross docker."
      say "Building Windows + Linux locally (wine)"
      run "npx electron-builder --win --linux --publish never"
      ;;
    *) die "Unknown --cross value: $CROSS (use docker|wine|skip)" ;;
  esac
fi

# ── 5. Publish to the update folder (website + auto-update feed) ─────────────
# These are exactly what electron-updater + the website need: the installers,
# the per-OS manifests, and the .blockmap delta files. We push a curated list
# (not the whole release/ dir, which also has unpacked app folders).
if [ ! -d release ]; then
  if [ "$DRYRUN" = "1" ]; then
    say "[dry-run] would collect installers + latest*.yml + *.blockmap from release/ and publish them"
    exit 0
  fi
  die "release/ not found — the build produced no output."
fi
cd release
PUBLISH_GLOBS=(latest.yml latest-mac.yml latest-linux.yml *.blockmap \
               Zekktris.exe Zekktris.dmg Zekktris.zip Zekktris.AppImage)
PRESENT=()
for g in "${PUBLISH_GLOBS[@]}"; do
  for f in $g; do [ -e "$f" ] && PRESENT+=("$f"); done
done
[ "${#PRESENT[@]}" -gt 0 ] || die "No artifacts found in release/ — did the build fail?"

say "Built artifacts:"
printf '    %s\n' "${PRESENT[@]}"

if [ -z "$ZK_PUBLISH_SSH" ] && [ -z "$ZK_PUBLISH_DIR" ]; then
  warn "No publish target set (ZK_PUBLISH_SSH or ZK_PUBLISH_DIR). Built but NOT shipped."
  warn "Set one in desktop/.env.release (see .env.release.example), then re-run --no-bump to publish."
  exit 0
fi

publish() { # publish <dest-is-ssh:0|1> <dest>
  local ssh="$1" dest="$2"
  say "Publishing ${#PRESENT[@]} file(s) → $dest"
  if [ "$ssh" = "1" ]; then
    run "rsync -av --progress ${PRESENT[*]} \"$dest/\""
    [ -n "$ZK_APK_PATH" ] && [ -f "$ZK_APK_PATH" ] && run "rsync -av \"$ZK_APK_PATH\" \"$dest/Zekktris.apk\""
  else
    run "mkdir -p \"$dest\""
    run "rsync -av ${PRESENT[*]} \"$dest/\""
    [ -n "$ZK_APK_PATH" ] && [ -f "$ZK_APK_PATH" ] && run "rsync -av \"$ZK_APK_PATH\" \"$dest/Zekktris.apk\""
  fi
}

[ -n "$ZK_PUBLISH_SSH" ] && publish 1 "$ZK_PUBLISH_SSH"
[ -n "$ZK_PUBLISH_DIR" ] && publish 0 "$ZK_PUBLISH_DIR"

say "Done. v$VER is live — the website serves the new installers and Electron"
say "clients will auto-update within ~6h (or on next launch)."
