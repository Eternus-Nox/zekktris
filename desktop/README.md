# Zekktris Desktop

A native desktop app (Windows / macOS / Linux) for Zekktris, the
communications app for communities, built with Electron.

It's a **thin shell**: it loads the live app from **https://zekktris.com**,
so every web deploy reaches the desktop app instantly — you don't rebuild
the desktop app when you change the web app. On top of the web app it adds:

- **System tray** with minimize/close-to-tray (the app keeps running so
  notifications still arrive when the window is closed). Toggle **Close
  to tray** off from the tray menu to make the X quit instead.
- **Start on login** — toggle from the tray menu to launch Zekktris
  automatically when you log in (it starts hidden in the tray).
- **Auto-updates** — checks a release feed on launch (and every 6h),
  downloads in the background, and prompts to restart. Also available
  from the tray → *Check for updates*.
- **Unread indicators** — taskbar overlay dot (Windows), dock badge
  (macOS/Linux), tray-icon dot, and a taskbar/dock flash on new mentions.
- **Zoom** — Ctrl/Cmd + `=` / `-` / `0`, persisted across launches.
- **Right-click menu** with spelling suggestions + cut/copy/paste.
- **Crash recovery** — a crashed or hung renderer auto-reloads instead
  of leaving a blank window.
- **Windows jump list** — right-click the taskbar icon for quick actions.
- **Unread badge** on the macOS dock / Linux taskbar, read from the web
  app's `(N)` title prefix (no web-app changes needed). On Windows the
  unread count shows in the tray tooltip.
- **Window size/position persistence**
- **External links open in your default browser**, not inside the app
- **Single-instance lock** — launching again focuses the running window
- **`zekktris://` deep-link protocol**
- **Screen sharing** — a native source picker (screens + windows) wired
  into `getDisplayMedia`, which Electron requires a handler for
- **Performance tuning** — hardware video encode/decode, GPU
  rasterization, and no background throttling so voice + the gateway
  keep running full-speed when the window is minimized

This project is intentionally **outside** the pnpm workspace (it lives in
`desktop/`, the workspace only covers `apps/*` and `packages/*`) because
Electron's tooling is separate from the monorepo.

---

## Prerequisites

- Node.js 18+
- The dependencies install Electron's prebuilt binary, so the machine you
  build on needs internet access the first time.

## Install

```bash
cd desktop
npm install
```

(Use `npm` here, not the repo's `pnpm` — this is a standalone project.)

## Run in development

```bash
npm run dev
```

This compiles `src/main.ts` + `src/preload.ts` with esbuild, copies the
setup page, and launches Electron — it connects straight to
https://zekktris.com.

## Package installers

```bash
npm run dist          # current platform
npm run dist:win      # Windows .exe (NSIS installer)
npm run dist:mac      # macOS .dmg
npm run dist:linux    # Linux AppImage
```

Output lands in `desktop/release/`.

> Cross-compiling has caveats: building a macOS `.dmg` requires macOS;
> Windows builds are easiest on Windows (or via Wine on Linux). Linux
> builds work anywhere. For personal use, unsigned builds are fine — code
> signing / notarization is only needed for public distribution and is
> configured in `electron-builder.yml`.

---

## Auto-updates

The app checks for updates on launch and every 6 hours, downloads them in
the background, and prompts to restart. The feed is configured in
`electron-builder.yml` under `publish` (a **generic** provider pointing
at `https://zekktris.com/desktop/updates/`).

To publish an update:

1. Bump `version` in `package.json`.
2. Build + publish in one step with the update script:
   ```powershell
   # Windows — copies installer + latest.yml + blockmaps to the destination
   powershell -ExecutionPolicy Bypass -File .\update.ps1 -Publish \\TOWER\appdata\zekktris\desktop-updates
   ```
   ```bash
   # macOS / Linux
   ./update.sh --publish /path/synced/to/desktop-updates
   ```
   The `-Publish` destination is whatever maps to the server's
   `desktop-updates` directory — a mapped drive, a UNC share to your
   Unraid appdata, or a local folder you sync over. You can also copy the
   files by hand from `release/`.

3. Installed apps poll the feed and update automatically.

### Server side (already wired)

The stack serves the feed via Caddy with zero extra services:

- **docker-compose** mounts `…/appdata/zekktris/desktop-updates` into the
  proxy container at `/srv/desktop-updates`.
- **Caddyfile** serves it at `/desktop/updates/` (with HTTP range support,
  which electron-updater needs).

So dropping the artifacts into that appdata folder on the server is all
that's required — `https://zekktris.com/desktop/updates/latest.yml`
becomes live immediately. After pulling these config changes, redeploy
the proxy once: `docker compose up -d --build proxy`.

The files electron-updater needs in that folder:
- the installer (`Zekktris.exe`)
- `latest.yml` (Windows manifest; `latest-mac.yml` / `latest-linux.yml`
  for those platforms)
- any `*.blockmap` (enables fast delta updates)

### Linux (AppImage) specifics

Auto-update is **not** Windows-only — it runs on Linux too, with no extra
code. The same feed serves all platforms: on Linux the app fetches
`latest-linux.yml` from the same `/desktop/updates/` URL and replaces the
`.AppImage` in place. To enable it you just publish the Linux build's
artifacts to the feed, which `./update.sh --publish <dest>` does
automatically when run on Linux (it copies `latest-linux.yml` and the
`*.AppImage`).

> **No separate `.blockmap` on Linux — this is normal.** Unlike the
> Windows installer (which gets a standalone `Zekktris.exe.blockmap`),
> the AppImage target *embeds* its blockmap inside the `.AppImage` file
> and records its size as `blockMapSize` in `latest-linux.yml`. Delta
> updates still work — electron-updater reads the embedded blockmap from
> the end of the AppImage. You only publish `latest-linux.yml` + the
> `.AppImage`.

Two requirements for AppImage self-update to actually apply, both of which
are true for normal use:

- **Run it as an AppImage.** electron-updater locates the file to replace
  via the `APPIMAGE` env var, which is only set when you launch the
  `.AppImage` directly (e.g. `./Zekktris.AppImage` or via a desktop
  launcher). Running an *extracted* AppImage (`--appimage-extract-and-run`)
  disables auto-update.
- **Keep it user-writable.** The updater rewrites the AppImage on disk, so
  store it somewhere the user owns (e.g. `~/Applications/…`), not a
  root-only path. If it can't write the file, the download succeeds but the
  install is skipped.

The first install is always manual (download the `.AppImage` once);
every release after that is picked up automatically, same as Windows.

> Auto-update only runs in the **installed** app, not `npm run dev`.
> Unsigned builds update fine for personal use; code signing only
> affects the SmartScreen prompt on first install.

---

## Updating the desktop app

When you get a new version of the `desktop/` folder (e.g. a screen-share
fix or new shell feature), rebuild the installer with the update script:

```powershell
# Windows — from the desktop/ folder
powershell -ExecutionPolicy Bypass -File .\update.ps1            # build installer
powershell -ExecutionPolicy Bypass -File .\update.ps1 -Install   # build + open installer
powershell -ExecutionPolicy Bypass -File .\update.ps1 -Run       # just run in dev
```

```bash
# macOS / Linux — from the desktop/ folder
./update.sh           # build installer for this OS
./update.sh --run     # build + launch in dev
```

The script runs `npm install`, rebuilds the main/preload bundles, and
repackages the installer into `release/`.

**You only need this when the desktop shell itself changes.** Because the
app loads your live server, normal **web-app updates reach the desktop
app automatically** — no rebuild needed.

---

## Icons

Drop your icons in `desktop/build/` before packaging:

| File | Used for | Size |
| --- | --- | --- |
| `icon.png` | Linux app icon | 512×512 (or 1024) |
| `icon.ico` | Windows app icon | multi-size .ico |
| `icon.icns` | macOS app icon | .icns bundle |
| `trayTemplate.png` | system tray glyph | 16×16 / 32×32 (a "Template" suffix makes macOS auto-invert it for light/dark menubars) |

If `trayTemplate.png` is missing the app still runs (the tray uses a blank
icon) — but you'll want a real glyph before shipping. You can generate the
`.ico`/`.icns` set from a single 1024×1024 PNG with tools like
`electron-icon-builder` or any online icon generator.

---

## How it fits together

```
desktop/
  src/
    main.ts      Electron main process (windows, tray, badge, deep links)
    preload.ts   contextBridge — exposes window.zekktris.{saveServerUrl,…}
    config.ts    persists window bounds (JSON in userData)
  static/
  build/         your icons (see table above)
  electron-builder.yml
```

Window geometry is stored in
`<userData>/zekktris-desktop.json` (e.g. on macOS:
`~/Library/Application Support/Zekktris/`).

## Notes

- The web app's notifications, service worker, and WebRTC voice all work
  inside Electron's Chromium exactly as they do in a browser tab.
- The app is hardwired to **https://zekktris.com**. To change the target
  (e.g. to develop against a local server), edit `SERVER_URL` near the top
  of `src/main.ts` and rebuild.
