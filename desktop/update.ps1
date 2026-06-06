# Zekktris Desktop - update / rebuild script (Windows PowerShell)
# ----------------------------------------------------------------
# Run this whenever you get a new version of the desktop shell
# (the desktop/ folder). It reinstalls dependencies, rebuilds the
# main/preload bundles, and produces a fresh Windows installer.
#
# NOTE: you do NOT need to run this when the *web app* changes - the
# desktop app loads your live server, so web updates arrive
# automatically. This script is only for updating the desktop shell
# itself (new features in main.ts, screen-share fixes, etc.).
#
# Usage (from the desktop/ folder):
#   powershell -ExecutionPolicy Bypass -File .\update.ps1
# or, if your execution policy allows scripts:
#   .\update.ps1
#
# Optional flags:
#   -Run      launch the app in dev after building (no installer)
#   -Install  open the freshly built installer when done

param(
  [switch]$Run,
  [switch]$Install,
  [string]$Publish
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host "==> Zekktris Desktop update" -ForegroundColor Cyan
Write-Host "    Folder: $PSScriptRoot"

# 1. Install / update dependencies. `npm install` is a no-op if nothing
#    changed, so it's safe to run every time.
Write-Host "`n==> Installing dependencies (npm install)..." -ForegroundColor Cyan
& npm.cmd install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

# 2. Dev run mode: build + launch, skip packaging.
if ($Run) {
  Write-Host "`n==> Launching in dev mode..." -ForegroundColor Cyan
  & npm.cmd run dev
  exit $LASTEXITCODE
}

# 3. Build the Windows installer.
Write-Host "`n==> Building Windows installer (npm run dist:win)..." -ForegroundColor Cyan
& npm.cmd run dist:win
if ($LASTEXITCODE -ne 0) { throw "build failed" }

# 4. Find and report the installer.
$release = Join-Path $PSScriptRoot 'release'
$setup = Get-ChildItem -Path $release -Filter 'Zekktris*.exe' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($setup) {
  Write-Host "`n==> Done. Installer:" -ForegroundColor Green
  Write-Host "    $($setup.FullName)"
  if ($Install) {
    Write-Host "==> Launching installer..." -ForegroundColor Cyan
    Start-Process $setup.FullName
  } else {
    Write-Host "    Run it to install the update, or re-run with -Install."
  }
} else {
  Write-Host "`n==> Build finished but no Setup .exe found in $release" -ForegroundColor Yellow
  Write-Host "    Check the build output above for errors."
}

# 5. Publish: copy the auto-update artifacts to the destination the
#    server serves at /desktop/updates/. The destination can be a mapped
#    drive, a UNC share (\\TOWER\appdata\zekktris\desktop-updates), or a
#    local folder you rsync/Unraid-sync to the server.
if ($Publish) {
  Write-Host "`n==> Publishing auto-update artifacts to:" -ForegroundColor Cyan
  Write-Host "    $Publish"
  if (-not (Test-Path $Publish)) {
    New-Item -ItemType Directory -Force -Path $Publish | Out-Null
  }
  # electron-updater needs: latest.yml (the manifest), the installer
  # .exe, and any .blockmap files (for delta downloads).
  $patterns = @('latest.yml', 'latest-*.yml', 'Zekktris*.exe', '*.blockmap')
  $copied = 0
  foreach ($pat in $patterns) {
    Get-ChildItem -Path $release -Filter $pat -ErrorAction SilentlyContinue | ForEach-Object {
      Copy-Item $_.FullName -Destination $Publish -Force
      Write-Host "    + $($_.Name)"
      $copied++
    }
  }
  if ($copied -eq 0) {
    Write-Host "    (nothing matched - did the build produce artifacts?)" -ForegroundColor Yellow
  } else {
    Write-Host "==> Published $copied file(s). Installed apps will pick up the update." -ForegroundColor Green
  }
}
