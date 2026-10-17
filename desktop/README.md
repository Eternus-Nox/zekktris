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
  (web and `mailto:` links only — see [Security model](#security-model))
- **Single-instance lock** — launching again focuses the running window
- **System idle signal** for presence — the web app's "is this device in
  use" comes from the shell: idle after 10 minutes without input, and idle
  the whole time the screen is locked or the machine sleeps, until it is
  unlocked / resumed (`src/idle.ts`, tested in `test/idle.test.ts`). It is
  shell code, so an installed app only gets a change here with a shell
  update; the web app itself updates from the server.
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

- Node.js 22.18+ (Electron's npm package needs 22.12+; `npm test` runs the
  TypeScript tests directly, which needs 22.18+).
- Internet access the first time: `npm run dev` downloads Electron's
  prebuilt binary on its first run, and `electron-builder` downloads the
  Electron build it packages. (Since Electron 42 nothing is downloaded at
  `npm install` time, so `ELECTRON_SKIP_BINARY_DOWNLOAD` is no longer needed.)
- The app runs on 64-bit Windows 10+, macOS 13+ and 64-bit Linux
  (Electron 44 dropped 32-bit Windows and macOS 12).

## Install

```bash
cd desktop
npm ci
```

(Use `npm` here, not the repo's `pnpm` — this is a standalone project.
`package-lock.json` is committed so every build ships the same dependency
versions: use `npm ci` to install exactly those, and commit the lockfile
whenever you change `package.json`. `release.sh` uses `npm ci`.)

`npm run typecheck` type-checks the shell and `npm test` runs its unit
tests (the trust rules in `src/trust.ts`, server-address handling).

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
> builds work anywhere. For personal use, unsigned builds are fine. Anything
> you hand to other people should be signed: see
> [Signing and update integrity](#signing-and-update-integrity).

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
> Unsigned Windows and Linux builds still update, but nothing checks who
> built the update: see the next section.

### Signing and update integrity

Updates download and install automatically (on quit, or when the user
clicks *Restart*), so **whoever can write to the update feed can run code
on every installed copy** — including copies pointed at someone else's
self-hosted server: the feed is the desktop app's release channel
(`publish.url` in `electron-builder.yml`), not the chat server. TLS and the
`sha512` in `latest*.yml` only prove the file wasn't corrupted in transit;
they come from the same folder as the installer. Code signing is what ties
an update to *you*. The build is wired so that signing, once you set it up,
is enforced on the installed apps; without it everything still builds and
runs, just unchecked.

**Windows** (the check is done by electron-updater):

1. Get an Authenticode code-signing certificate (OV or EV) from a CA, or
   use Azure Trusted Signing. New certificates come on a hardware token or
   a cloud HSM, not as a plain `.pfx`, so how you sign depends on the
   provider:
   - A `.pfx` you can export: set `WIN_CSC_LINK` (path, `https://` URL or
     base64 of the `.pfx`) and `WIN_CSC_KEY_PASSWORD` in the build
     environment (e.g. `desktop/.env.release`; `release.sh` passes them into
     the Docker build). Use a base64 or `https://` value for the Docker
     build: a host path doesn't exist inside the container.
   - Azure Trusted Signing: add `azureSignOptions` (with `publisherName`,
     `endpoint`, `codeSigningAccountName`, `certificateProfileName`) under
     `win:` in `electron-builder.yml` and the `AZURE_*` credentials to the
     environment (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
     `AZURE_CLIENT_SECRET`). It signs through PowerShell's TrustedSigning
     module, so build Windows where that is installed (easiest: on Windows).
   - A hardware token / other HSM: build on the machine that holds it, with
     `win.signtoolOptions.certificateSubjectName` or `certificateSha1`
     pointing at it (or a custom `win.signtoolOptions.sign` hook).
2. Build as usual. electron-builder signs the app and installer, and —
   because `win.verifyUpdateCodeSignature` is `true` — writes the
   certificate's publisher name into the packaged `app-update.yml`.
3. From then on the installed app refuses any update that isn't signed by
   that publisher (electron-updater checks the downloaded installer's
   Authenticode signature before running it). To pin the full subject DN
   rather than the certificate's CN, set
   `win.signtoolOptions.publisherName` (or `azureSignOptions.publisherName`).

An unsigned build writes no publisher name, so it updates without any
check — and so does an install of an unsigned build when it fetches the
first signed one. Only installs of a signed build are protected, so ship a
signed build first and treat it as the new baseline. Keep the same
publisher name when you renew the certificate, or installed apps will
refuse the update signed with the new one.

**macOS** (the check is done by Squirrel.Mac):

1. Join the Apple Developer Program and create a **Developer ID
   Application** certificate. Put it in the build Mac's keychain (or set
   `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD` in `.env.release`; `release.sh`
   hands them to the macOS build only, as `CSC_LINK`, because
   electron-builder would otherwise also sign the Windows build with a
   plain `CSC_LINK` when no `WIN_CSC_LINK` is set — and installs of that
   build would then refuse every properly signed update).
2. For notarization, set **one** of: `APPLE_API_KEY` (path to the `.p8`) +
   `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (recommended), or `APPLE_ID` +
   `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
3. Build with `./release.sh --sign` (or `MAC_SIGN=1` in `.env.release`).
   Without it, `release.sh` turns identity discovery off, passes no
   certificate and builds unsigned (and so not notarized).

A signed app only installs updates signed by the same Developer ID team.
Signed builds use the hardened runtime; `entitlements.mac.plist` grants the
microphone and camera it would otherwise block. Unsigned macOS builds run
(right-click → Open the first time) but never install updates themselves,
and since Electron 42 can't show native notifications.

**Linux:** electron-updater doesn't verify AppImage signatures, so a Linux
install's updates rest on TLS plus the `sha512` in `latest-linux.yml`.
Keep the feed folder writable only by the release account, or don't
publish Linux updates to installs you don't control.

**Protect the feed folder regardless.** Signing stops a stranger's build
from installing, but not a rollback to an older signed release that had a
bug: only someone who can write `desktop-updates/` can do that, so limit
who can.

## Security model

The main window shows whichever server the user picked, so the shell
treats that page as untrusted web content:

- `window.zekktris` is exposed only on the chosen server's own origin and
  on the shell's `file://` pages. A navigation or server-side redirect to
  another origin opens in the default browser instead of loading in the
  window, and the shell hands the OS only `http:`, `https:` and `mailto:`
  links (never `file:`, `smb:`, `search-ms:` or other apps' protocol
  handlers). If the server's own address starts redirecting elsewhere,
  the app follows it only to the same host on `https://` or its
  `www.`/apex twin (after checking it answers as Zekktris); for any other
  target it opens the server picker, explains, and offers the new address.
- The screen-share source list and the choice of source are only
  available to the shell's picker window, while the page's
  `getDisplayMedia()` request is pending. The page can't list windows or
  pick a source itself.
- Only the permissions the web app uses (notifications, mic/camera,
  screen share, fullscreen, screen wake lock, clipboard *write*) are
  granted, and only to the chosen server's origin. Clipboard read is never
  granted.
- Switching servers is only possible from the shell's own server picker.

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
    preload.ts   contextBridge — exposes window.zekktris (server origin only)
    trust.ts     what the remote page may do (links, permissions)
    server.ts    server-address handling for the server picker
    config.ts    persists window bounds (JSON in userData)
  test/          `npm test` (node --test)
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
