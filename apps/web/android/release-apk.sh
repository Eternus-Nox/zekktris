#!/usr/bin/env bash
# Zekktris Android — build a signed release APK and publish it to the website
# ==========================================================================
# Builds the Capacitor Android app and ships the APK to the SAME folder the
# desktop installers go to, as Zekktris.apk — which the website's Android
# download button points at (/desktop/updates/Zekktris.apk).
#
#   ./release-apk.sh            # build + publish the APK
#   ./release-apk.sh --no-publish   # just build (path printed at the end)
#   ./release-apk.sh --dry-run
#
# Publish target is shared with the desktop pipeline: it reads ZK_PUBLISH_SSH /
# ZK_PUBLISH_DIR from desktop/.env.release (or the environment). See
# [[Android — Build & Release]] and [[Desktop — Build & Release]].
#
# Requires a JDK. macOS with Android Studio installed already has one bundled
# (this script auto-detects it). Sideloaded APKs do NOT auto-update — bump
# versionCode/versionName in app/build.gradle for each public APK so users can
# tell versions apart; the Play Store path (an .aab) is what gives auto-updates.
set -euo pipefail
cd "$(dirname "$0")"            # apps/web/android
REPO_ROOT="$(cd ../../.. && pwd)"

PUBLISH="1"; DRYRUN="0"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-publish) PUBLISH="0"; shift ;;
    --dry-run) DRYRUN="1"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!! \033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mxx \033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRYRUN" = "1" ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

# Shared publish config (same file the desktop release uses).
[ -f "$REPO_ROOT/desktop/.env.release" ] && set -a && . "$REPO_ROOT/desktop/.env.release" && set +a
ZK_PUBLISH_SSH="${ZK_PUBLISH_SSH:-}"
ZK_PUBLISH_DIR="${ZK_PUBLISH_DIR:-}"

# JDK: prefer Android Studio's bundled runtime so this works with zero extra setup.
if [ -z "${JAVA_HOME:-}" ]; then
  for j in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
           "$HOME/Library/Java/JavaVirtualMachines"/*/Contents/Home; do
    [ -x "$j/bin/java" ] && export JAVA_HOME="$j" && break
  done
fi
[ -n "${JAVA_HOME:-}" ] && say "JAVA_HOME=$JAVA_HOME" || warn "JAVA_HOME unset; relying on a java on PATH."

# 1. Build the web app + sync it into the native project.
say "Building web app + syncing into Android (pnpm build && cap sync android)"
run "pnpm -C \"$REPO_ROOT/apps/web\" build"
run "pnpm -C \"$REPO_ROOT/apps/web\" exec cap sync android"

# 2. Assemble the signed release APK (falls back to debug signing if
#    keystore.properties is absent — see the guide).
[ -f keystore.properties ] || warn "No keystore.properties — APK will be DEBUG-signed (fine for testing, not for public distribution)."
say "Assembling release APK (./gradlew assembleRelease)"
run "./gradlew assembleRelease"

APK="app/build/outputs/apk/release/app-release.apk"
[ "$DRYRUN" = "1" ] || [ -f "$APK" ] || die "APK not found at $APK — build failed?"
say "APK: $(pwd)/$APK"

# 3. Publish to the update folder as Zekktris.apk.
if [ "$PUBLISH" = "0" ]; then exit 0; fi
if [ -z "$ZK_PUBLISH_SSH" ] && [ -z "$ZK_PUBLISH_DIR" ]; then
  warn "No publish target (set ZK_PUBLISH_SSH/ZK_PUBLISH_DIR in desktop/.env.release). Built but not shipped."
  exit 0
fi
[ -n "$ZK_PUBLISH_SSH" ] && { say "Publishing → $ZK_PUBLISH_SSH/Zekktris.apk"; run "rsync -av \"$APK\" \"$ZK_PUBLISH_SSH/Zekktris.apk\""; }
[ -n "$ZK_PUBLISH_DIR" ] && { run "mkdir -p \"$ZK_PUBLISH_DIR\""; say "Publishing → $ZK_PUBLISH_DIR/Zekktris.apk"; run "rsync -av \"$APK\" \"$ZK_PUBLISH_DIR/Zekktris.apk\""; }
say "Done. The website's Android button now serves the new APK."
