#!/usr/bin/env bash
# Zekktris Desktop — one-command release pipeline
# ===============================================
# Builds the desktop app and publishes the installers + the auto-update feed to
# the server's desktop-updates folder. Caddy serves that folder at
# https://<host>/desktop/updates/ — the SAME place the website download buttons
# AND the Electron auto-updater read from.
#
# WHERE TO RUN IT — two hosts, and they are not interchangeable:
#
#   Unraid (Linux, x86_64) — Windows + Linux. The ONLY place the Windows
#       installer can be built: electron-builder runs the NSIS installer under
#       wine, and wine cannot even boot under emulation on Apple Silicon
#       (proven 2026-08-06 — not a RAM problem, not fixable in config). Needs
#       no Node on the host; the Docker image installs and builds. Publishes
#       straight into ../desktop-updates. Does NOT bump the version: that comes
#       from git, bumped on the Mac and pushed.
#
#         cd /mnt/user/appdata/zekktris/desktop && bash release.sh
#
#       `bash release.sh`, not `./release.sh` — the exec bit does not survive
#       the SMB share.
#
#   macOS — the Mac build (dmg + zip), plus Linux. Bumps the version.
#
#         ./release.sh                   # interactive: (1) macOS, (2) Linux
#         ./release.sh --mac-only        # just macOS, no prompt
#
# Flags:
#   --no-bump                  don't bump (on Unraid: republish a version on purpose)
#   --bump patch|minor|major   Mac only
#   --set-version X.Y.Z        Mac only
#   --mac-only                 Mac only
#   --cross docker|wine|skip   how to build Windows + Linux (default docker)
#   --publish-dir DIR          publish into a local/mounted folder
#   --publish-ssh user@host:DIR
#   --dry-run                  show what it WOULD build/publish, do nothing
#
# On the Mac, set the publish target ONCE in desktop/.env.release (gitignored,
# see .env.release.example):
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
VERSION_FLAG="0"      # --bump / --set-version was passed
NO_BUMP_FLAG="0"      # --no-bump was passed
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
    --bump) BUMP="${2:?}"; VERSION_FLAG="1"; shift 2 ;;
    --no-bump) BUMP="none"; NO_BUMP_FLAG="1"; shift ;;
    --set-version) SETVER="${2:?}"; BUMP="none"; VERSION_FLAG="1"; shift 2 ;;
    --cross) CROSS="${2:?}"; EXPLICIT_TARGET="1"; shift 2 ;;
    --mac-only) ONLY_MAC="1"; EXPLICIT_TARGET="1"; shift ;;
    --mac-arch) MAC_ARCH="${2:?}"; shift 2 ;;
    --sign) MAC_SIGN="1"; shift ;;
    --publish-ssh) ZK_PUBLISH_SSH="${2:?}"; shift 2 ;;
    --publish-dir) ZK_PUBLISH_DIR="${2:?}"; shift 2 ;;
    --dry-run) DRYRUN="1"; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | grep -v '^set -euo'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!! \033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mxx \033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRYRUN" = "1" ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

# Read the version without Node — the Unraid host has none.
pkg_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1
}

# ── Host ────────────────────────────────────────────────────────────────────
ON_MAC="0"; [ "$(uname -s)" = "Darwin" ] && ON_MAC="1"
# Apple Silicon builds macOS + Linux, never Windows (see the header).
WIN_OK="1"; [ "$ON_MAC" = "1" ] && [ "$(uname -m)" = "arm64" ] && WIN_OK="0"

if [ "$ON_MAC" = "0" ]; then
  [ "$ONLY_MAC" = "1" ] && die "macOS builds need a Mac. On this host, run without --mac-only."
  # The version lives in git. Bumping it here would edit a tracked file inside
  # the live server checkout, and the next push from the Mac is refused until
  # someone untangles it.
  [ "$VERSION_FLAG" = "1" ] && die "Bump the version on the Mac, not here: in desktop/ run 'npm version patch --no-git-tag-version', commit, push — then re-run this."
  BUMP="none"; DO_MAC="0"; EXPLICIT_TARGET="1"
  [ "$CROSS" = "skip" ] && die "--cross skip leaves nothing to build on this host."
  # Default publish target: the folder Caddy serves, right beside this checkout.
  if [ -z "$ZK_PUBLISH_SSH" ] && [ -z "$ZK_PUBLISH_DIR" ] && [ -d ../desktop-updates ]; then
    ZK_PUBLISH_DIR="$(cd ../desktop-updates && pwd)"
  fi
fi

# ── Interactive build-target menu (Mac) ──────────────────────────────────────
# When run from a terminal without an explicit target flag (--mac-only /
# --cross), ask what to build. Flags still bypass this for automated runs.
if [ "$EXPLICIT_TARGET" = "0" ] && [ -t 0 ]; then
  echo
  say "What do you want to build?"
  printf '    1) macOS only\n'
  if [ "$WIN_OK" = "1" ]; then
    printf '    2) Linux + Windows (Docker wine image)\n'
  else
    printf '    2) Linux only (Windows is built on Unraid — bash release.sh there)\n'
  fi
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
CUR="$(pkg_version)"
[ -n "$CUR" ] || die "Could not read the version from package.json."
if [ -n "$SETVER" ]; then
  say "Setting version $CUR → $SETVER"
  run "npm version \"$SETVER\" --no-git-tag-version >/dev/null"
elif [ "$BUMP" != "none" ]; then
  say "Bumping version ($BUMP) from $CUR"
  run "npm version \"$BUMP\" --no-git-tag-version >/dev/null"
elif [ "$ON_MAC" = "1" ]; then
  warn "Not bumping (current $CUR). Clients already on $CUR will NOT see this as an update."
fi
VER="$(pkg_version)"

# On Unraid the version comes from git, so the easy mistake is forgetting to
# bump it on the Mac: the build succeeds, publishes, and no client ever sees
# it as an update. Catch that before spending minutes on a build.
if [ "$ON_MAC" = "0" ] && [ "$NO_BUMP_FLAG" = "0" ] && [ -n "$ZK_PUBLISH_DIR" ] \
   && [ -f "$ZK_PUBLISH_DIR/latest.yml" ]; then
  PUB="$(sed -n 's/^version:[[:space:]]*//p' "$ZK_PUBLISH_DIR/latest.yml" | head -1 | tr -d "\"'")"
  NEWEST="$(printf '%s\n%s\n' "$PUB" "$VER" | sort -V | tail -1)"
  if [ -n "$PUB" ] && { [ "$PUB" = "$VER" ] || [ "$NEWEST" != "$VER" ]; }; then
    die "package.json says v$VER but v$PUB is already published, so no client would see this as an update. Bump it on the Mac (desktop/: npm version patch --no-git-tag-version), commit, push, then re-run. (--no-bump republishes the same version on purpose.)"
  fi
fi
say "Releasing Zekktris desktop v$VER"

# ── 2. Build the shell bundles on the host (only when the host builds) ──────
# The Docker path installs and builds inside the container, so a Windows +
# Linux run needs no Node on the host — which is what lets it run on Unraid.
if [ "$DO_MAC" = "1" ] || [ "$CROSS" = "wine" ]; then
  # npm ci: exactly the versions in package-lock.json, so every release ships
  # the same Electron/updater it was tested with.
  say "Installing deps + building main/preload (npm ci && npm run build)"
  run "npm ci"
  run "npm run build"
fi

# ── Clear the previous run's artifacts ──────────────────────────────────────
# Publishing copies every matching file in release/, so a leftover from an
# older build ships as if it were new. Not hypothetical: the server checkout's
# release/ held a June macOS dmg + latest-mac.yml that a Windows run there
# would have published over the current Mac download. Each run publishes only
# what it built.
PUBLISH_GLOBS=('latest.yml' 'latest-mac.yml' 'latest-linux.yml' '*.blockmap'
               'Zekktris.exe' 'Zekktris.dmg' 'Zekktris.zip' 'Zekktris.AppImage')
if [ -d release ]; then
  for g in "${PUBLISH_GLOBS[@]}"; do
    for f in release/$g; do
      [ -e "$f" ] || continue
      if [ "$DRYRUN" = "1" ]; then echo "  [dry-run] rm $f"; else rm -f "$f"; fi
    done
  done
fi

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
  TARGETS="--win --linux"
  if [ "$WIN_OK" = "0" ]; then
    TARGETS="--linux"
    warn "Skipping Windows: it cannot be built on Apple Silicon. Build it on Unraid (bash release.sh)."
  fi
  case "$CROSS" in
    docker)
      command -v docker >/dev/null || die "Docker not found. Install Docker, or use --cross wine, or --mac-only."
      say "Building ($TARGETS) in the electron-builder Docker image"
      # Mount the project; shadow node_modules with an anonymous volume so the
      # container's Linux/wine npm install never clobbers the host's macOS
      # node_modules (esbuild/electron are platform-specific). Cache electron
      # downloads on the host so repeat runs are fast. Pass the Windows
      # signing certificate through when one is configured (README: "Signing
      # and update integrity"); unset, the build is unsigned as before.
      run "docker run --rm \
        -e WIN_CSC_LINK -e WIN_CSC_KEY_PASSWORD \
        -v \"\$PWD\":/project \
        -v /project/node_modules \
        -v \"\${HOME}/.cache/electron\":/root/.cache/electron \
        -v \"\${HOME}/.cache/electron-builder\":/root/.cache/electron-builder \
        electronuserland/builder:wine \
        /bin/bash -c \"cd /project && npm ci && npm run build && npx electron-builder $TARGETS --publish never\""
      ;;
    wine)
      command -v wine >/dev/null || die "wine not found. 'brew install --cask wine-stable', or use --cross docker."
      say "Building ($TARGETS) locally (wine)"
      run "npx electron-builder $TARGETS --publish never"
      ;;
    *) die "Unknown --cross value: $CROSS (use docker|wine|skip)" ;;
  esac
fi

# ── 5. Publish to the update folder (website + auto-update feed) ─────────────
# These are exactly what electron-updater + the website need: the installers,
# the per-OS manifests, and the .blockmap delta files. We push a curated list
# (not the whole release/ dir, which also has unpacked app folders).
# A dry run built nothing and deleted nothing, so whatever sits in release/
# now is exactly the stale leftovers a real run would have cleared. Listing
# them as "would publish" would be a lie.
if [ "$DRYRUN" = "1" ]; then
  say "[dry-run] would publish this run's installers + latest*.yml + *.blockmap → ${ZK_PUBLISH_DIR:-${ZK_PUBLISH_SSH:-<no publish target set>}}"
  exit 0
fi
[ -d release ] || die "release/ not found — the build produced no output."
cd release
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
  return 0
}

[ -n "$ZK_PUBLISH_SSH" ] && publish 1 "$ZK_PUBLISH_SSH"
[ -n "$ZK_PUBLISH_DIR" ] && publish 0 "$ZK_PUBLISH_DIR"

say "Done. v$VER is live — the website serves the new installers and Electron"
say "clients will auto-update within ~6h (or on next launch)."
