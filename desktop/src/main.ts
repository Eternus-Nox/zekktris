/**
 * Zekktris desktop — main process
 * -------------------------------
 * A thin native shell around a self-hosted Zekktris instance. The
 * shell loads the deployed web app from the user's server URL, so
 * every web deploy reaches the desktop app instantly with no rebuild.
 *
 * Native value-add over a browser tab:
 *   - System tray + minimize/close-to-tray (stays running for
 *     notifications when the window is closed).
 *   - Window size/position persistence.
 *   - Taskbar/dock unread badge, read from the web app's "(N) " title
 *     prefix — no web-app changes needed.
 *   - External links open in the default browser, not inside the app.
 *   - Single-instance lock (second launch focuses the existing window).
 *   - zekktris:// deep-link protocol.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  ipcMain,
  nativeImage,
  desktopCapturer,
  session,
  powerMonitor,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import {
  getWindowBounds,
  saveWindowBounds,
  getCloseToTray,
  setCloseToTray,
  getOpenAtLogin,
  setOpenAtLogin,
  getZoomLevel,
  setZoomLevel,
  getServerUrl,
  setServerUrl,
  DEFAULT_SERVER_URL,
} from './config';
import { findServer, isServerMove, probeServer } from './server';
import { externalUrl, isSameOrigin, permissionAllowed } from './trust';

const PROTOCOL = 'zekktris';

// Which Zekktris server to load: zekktris.com unless the user picked their
// own (tray → "Change server…", or the link on the web sign-in page).
// Switching relaunches the app so the window, session and the switch below
// all start clean for the new server.

// A server on the home network may be plain http. Chromium blocks the mic,
// camera and screen share on insecure origins, so mark that one origin as
// secure — only ever a local-network origin (normalizeServerUrl refuses
// http:// for anything else), and only the one the user chose.
{
  const saved = getServerUrl();
  if (saved.startsWith('http://')) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', saved);
  }
}

// ── Auto-launch (start on login) ────────────────────────────────────────────
// Apply the persisted openAtLogin setting to the OS login items. We
// pass --hidden so a login-triggered launch starts straight to the
// tray without flashing the window open (Windows; macOS has no launch
// args for login items, so there launchedAtLogin() reads
// wasOpenedAtLogin instead — Electron 44 removed `openAsHidden`).
function applyLoginItem(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: enabled ? ['--hidden'] : [],
    });
  } catch {
    // Not supported on this platform/packaging — ignore.
  }
}

// True when this launch was triggered by the OS at login (so we should
// start hidden in the tray rather than popping the window open).
function launchedAtLogin(): boolean {
  if (process.argv.includes('--hidden')) return true;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}

// ── Performance + WebRTC tuning ─────────────────────────────────────────────
// Set before the app is ready. These give smooth voice + screen-share
// and lower CPU on a chat/voice workload:
//   - hardware H.264 encode/decode for video & screen tracks (Linux VAAPI)
//   - PipeWire capturer so screen share works on Linux/Wayland (no-op
//     elsewhere)
//
// DO NOT force GPU rasterization, zero-copy, or OOP canvas raster here.
// Chromium already enables GPU raster by default on every GPU it trusts;
// the `enable-gpu-rasterization` / `enable-zero-copy` switches exist to
// turn those paths on for the GPUs and drivers it has deliberately
// blocklisted for rendering bugs. Forcing them bought nothing on good
// hardware, and on bad drivers they flicker — zero-copy is off by default
// on Windows for that reason. They were the prime suspect for the Windows
// app flickering on a fresh install until the GPU shader cache warmed up.
app.commandLine.appendSwitch(
  'enable-features',
  'WebRtcHideLocalIpsWithMdns,WebRTCPipeWireCapturer,VaapiVideoDecoder,VaapiVideoEncoder',
);
// Don't throttle timers/rendering when the window is backgrounded —
// critical so the gateway WebSocket, voice, and notifications keep
// running smoothly while the window is minimized or behind others.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
/** True while the web app has a live voice/video call. Set from the renderer
 *  (see preload `setCallActive`). A reload during a call destroys the LiveKit
 *  Room — for the user, and for every viewer of their screen share — so the
 *  recovery paths below stand down while it is set. */
let callActive = false;

// ── Single-instance lock ──────────────────────────────────────────────────
// A second launch should focus the running window, not spawn a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv: string[]) => {
    focusMainWindow();
    // Handle a deep link passed on the second-instance argv (Windows/Linux).
    const deepLink = argv.find((a: string) => a.startsWith(`${PROTOCOL}://`));
    if (deepLink) handleDeepLink(deepLink);
  });
}

// ── Deep-link protocol registration ─────────────────────────────────────────
// process.defaultApp is an Electron augmentation of the Node process
// global (true when running via the `electron` binary in dev). Cast so
// the access is robust regardless of how the ambient types are loaded.
const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };
if (electronProcess.defaultApp) {
  // Dev: register with the explicit path to the electron binary + script.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      join(process.argv[1] ?? ''),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function handleDeepLink(url: string): void {
  // zekktris://channel/<id> etc. We translate the deep-link path into a
  // web-app route and navigate the main window there. The web app owns
  // the route semantics; here we just forward the path.
  if (!mainWindow) return;
  try {
    const u = new URL(url);
    const route = `${u.hostname}${u.pathname}`; // e.g. "channel/123"
    void mainWindow.loadURL(`${getServerUrl()}/${route}`);
  } catch {
    /* ignore malformed deep links */
  }
}

// ── Trust boundary: the remote page ─────────────────────────────────────────
// The main window shows whatever server the user picked, so its page is
// untrusted web content: it gets the window.zekktris bridge and the
// permissions below only on that server's own origin, and may only hand
// web and mail links to the OS (see trust.ts).

function openExternalSafely(url: string): void {
  const safe = externalUrl(url);
  if (safe) void shell.openExternal(safe);
}

/** True when `url` (a URL or an origin) is on the chosen server's origin. */
function isServerOrigin(url: string | null | undefined): boolean {
  return isSameOrigin(url, getServerUrl());
}

// ── Badge / unread indicators ──────────────────────────────────────────────
// The web app sets document.title to "(3) #general · Zekktris" when there
// are unread mentions. We extract the leading count and reflect it across
// platforms: numeric dock badge (mac/linux), taskbar overlay dot (win),
// tray icon swap + tooltip, and a taskbar/dock flash when it rises.
function badgeCountFromTitle(title: string): number {
  const m = title.match(/^\((\d+)\+?\)/);
  return m ? Number(m[1]) : 0;
}

// Cached icon assets (loaded lazily; empty if the file is absent).
function assetPath(name: string): string {
  return join(__dirname, '..', 'build', name);
}
let trayNormalImg: Electron.NativeImage | null = null;
let trayUnreadImg: Electron.NativeImage | null = null;
let overlayDotImg: Electron.NativeImage | null = null;

let lastBadgeCount = 0;

function applyBadge(count: number): void {
  // macOS + most Linux DEs support a numeric badge directly.
  if (process.platform === 'darwin' || process.platform === 'linux') {
    app.badgeCount = count;
  }

  // Windows: stamp an overlay dot on the taskbar button (no native
  // numeric badge exists). Clear it at zero.
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    if (count > 0) {
      if (!overlayDotImg) {
        const img = nativeImage.createFromPath(assetPath('overlay-dot.png'));
        overlayDotImg = img.isEmpty() ? null : img;
      }
      mainWindow.setOverlayIcon(overlayDotImg, `${count} unread`);
    } else {
      mainWindow.setOverlayIcon(null, '');
    }
  }

  // Tray: swap to the unread glyph + update tooltip.
  if (tray) {
    if (count > 0 && trayUnreadImg) tray.setImage(trayUnreadImg);
    else if (trayNormalImg) tray.setImage(trayNormalImg);
    tray.setToolTip(count > 0 ? `Zekktris — ${count} unread` : 'Zekktris');
  }

  // Flash the taskbar/dock when the count rises and we're not focused —
  // grabs attention for a new mention without being annoying on every
  // title change.
  if (
    count > lastBadgeCount &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.isFocused()
  ) {
    mainWindow.flashFrame(true);
  }
  if (count === 0 && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(false);
  }
  lastBadgeCount = count;
}

// ── Windows ────────────────────────────────────────────────────────────────
function createMainWindow(serverUrl: string, startHidden = false): void {
  const bounds = getWindowBounds();
  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 480,
    minHeight: 560,
    show: !startHidden, // login launches start hidden in the tray
    backgroundColor: '#0e1422', // bg-1 (main content) — seamless load
    title: 'Zekktris',
    autoHideMenuBar: true,
    // Fully frameless: the preload injects a custom title bar with its
    // own window-control buttons and the gradient wordmark. This makes
    // the bar entirely shell-owned (always present after a desktop
    // rebuild, independent of the web app deploy).
    frame: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow the web app's own service worker / notifications.
      spellcheck: true,
      // Keep timers, audio, and the gateway socket running at full
      // rate when the window is minimized or in the background — a
      // chat/voice app must not stall when it loses focus.
      backgroundThrottling: false,
      // Tells the preload which origin may see window.zekktris.
      additionalArguments: [`--zk-server-origin=${new URL(serverUrl).origin}`],
    },
  });

  void mainWindow.loadURL(serverUrl);

  // Persist window geometry on resize/move (debounced via close too).
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized() || mainWindow.isMaximized()) return;
    saveWindowBounds(mainWindow.getBounds());
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  wireMaximizeEvents(mainWindow);

  // Unread badge from the page title.
  mainWindow.on('page-title-updated', (_e, title) => {
    applyBadge(badgeCountFromTitle(title));
  });

  // Close behavior: with "close to tray" on (default), closing hides
  // the window to the tray so notifications/voice keep running. With
  // it off, closing the window quits the app.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    if (getCloseToTray()) {
      e.preventDefault();
      mainWindow?.hide();
    } else {
      isQuitting = true;
      app.quit();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links + off-origin navigations open in the default browser
  // (http/https/mailto only, see openExternalSafely) and never load here.
  const isInternal = (url: string) => isSameOrigin(url, serverUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => {
    if (!isInternal(e.url)) {
      e.preventDefault();
      openExternalSafely(e.url);
    }
  });
  // A server-side redirect to another origin never fires will-navigate, and
  // without this it would load in the app window with the preload attached.
  // Cancelling leaves whatever page the window already shows; when it shows
  // none yet (the server's own address now redirects), say so instead of
  // leaving a blank frameless window — see serverRedirected.
  mainWindow.webContents.on('will-redirect', (e) => {
    if (e.isMainFrame && !isInternal(e.url)) {
      e.preventDefault();
      if (mainWindow && !isInternal(mainWindow.webContents.getURL())) {
        void serverRedirected(e.url);
      } else {
        openExternalSafely(e.url);
      }
    }
  });

  // Clear the attention flash once the user looks at the window.
  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false);
  });

  // ── Zoom: restore saved level, and handle Ctrl/Cmd +/-/0 ──────────────
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomLevel(getZoomLevel());
  });
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (!mainWindow) return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || input.type !== 'keyDown') return;
    const wc = mainWindow.webContents;
    let next: number | null = null;
    if (input.key === '=' || input.key === '+') next = wc.getZoomLevel() + 0.5;
    else if (input.key === '-') next = wc.getZoomLevel() - 0.5;
    else if (input.key === '0') next = 0;
    if (next !== null) {
      const clamped = Math.max(-3, Math.min(5, next));
      wc.setZoomLevel(clamped);
      setZoomLevel(clamped);
    }
  });

  // ── Crash recovery: reload a dead/hung renderer instead of leaving a
  //    blank window. ─────────────────────────────────────────────────────
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });
  // A reload destroys the renderer's LiveKit Room, killing an in-progress
  // screen share for the streamer and every viewer at once. Encoding a
  // high-resolution share routinely stalls the main thread long enough to
  // fire 'unresponsive', so the recovery must only fire for a renderer that
  // is genuinely wedged: cancel on 'responsive', and wait far longer than
  // any plausible encode hiccup.
  let unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelUnresponsiveReload = () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  };
  mainWindow.on('unresponsive', () => {
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      // Never reload out from under a live call. A wedged renderer is
      // annoying; dropping a call in progress — and everyone watching the
      // screen share with it — is worse, and encoding a share is the most
      // likely reason the main thread stalled in the first place. The user can
      // still reload by hand from the tray.
      if (callActive) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }, 45_000);
  });
  mainWindow.on('responsive', cancelUnresponsiveReload);
  mainWindow.on('closed', cancelUnresponsiveReload);

  // ── Right-click context menu: spelling suggestions + edit actions ─────
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const template: Parameters<typeof Menu.buildFromTemplate>[0] = [];
    for (const suggestion of params.dictionarySuggestions) {
      template.push({
        label: suggestion,
        click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
      });
    }
    if (params.dictionarySuggestions.length > 0) {
      template.push({ type: 'separator' });
    }
    if (params.misspelledWord) {
      template.push({
        label: 'Add to dictionary',
        click: () =>
          mainWindow?.webContents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord,
          ),
      });
      template.push({ type: 'separator' });
    }
    if (params.isEditable) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy' }, { role: 'selectAll' });
    }
    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup();
    }
  });
}

function focusMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow(getServerUrl());
  }
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function createTray(): void {
  // Tray glyphs ship in build/. The unread variant (with a dot) is
  // optional — if absent we just keep the normal glyph and rely on the
  // tooltip. Falls back to an empty image if even the base is missing.
  const normal = nativeImage.createFromPath(assetPath('trayTemplate.png'));
  trayNormalImg = normal.isEmpty() ? nativeImage.createEmpty() : normal;
  const unread = nativeImage.createFromPath(assetPath('trayUnread.png'));
  trayUnreadImg = unread.isEmpty() ? null : unread;

  tray = new Tray(trayNormalImg);
  tray.setToolTip('Zekktris');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Zekktris', click: () => focusMainWindow() },
    {
      label: 'Reload',
      click: () => mainWindow?.webContents.reload(),
    },
    {
      label: 'Check for updates…',
      click: () => checkForUpdates(true),
    },
    {
      label: `Change server… (${new URL(getServerUrl()).host})`,
      click: () => showServerPicker(),
    },
    { type: 'separator' },
    {
      label: 'Start on login',
      type: 'checkbox',
      checked: getOpenAtLogin(),
      click: (item: { checked: boolean }) => {
        setOpenAtLogin(item.checked);
        applyLoginItem(item.checked);
      },
    },
    {
      label: 'Close to tray',
      type: 'checkbox',
      checked: getCloseToTray(),
      click: (item: { checked: boolean }) => {
        setCloseToTray(item.checked);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => focusMainWindow());
}

// ── Server picker ─────────────────────────────────────────────────────────────
// A small shell-owned window for choosing which Zekktris server to load.
// Switching is only possible from THIS window (a file:// page the shell
// controls) — never from the remote app — so a compromised or malicious
// server page can't quietly move someone onto a lookalike server.

let serverWindow: BrowserWindow | null = null;

/** Set when the picker was opened because the server moved (see
    serverRedirected): the app has nothing to show, so closing it quits. */
let pickerForMovedServer = false;

function showServerPicker(moved?: { from: string; to: string | null }): void {
  if (serverWindow) {
    serverWindow.focus();
    return;
  }
  pickerForMovedServer = !!moved;
  // A moved server's picker stands alone: the main window is hidden then.
  const parent = moved ? undefined : (mainWindow ?? undefined);
  serverWindow = new BrowserWindow({
    width: 460,
    height: moved ? 440 : 400,
    parent,
    modal: !!parent,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0a0f1c',
    title: 'Server',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void serverWindow.loadFile(join(__dirname, 'static', 'server.html'), {
    query: moved ? { from: moved.from, to: moved.to ?? '' } : {},
  });
  keepOnShellPage(serverWindow);
  serverWindow.on('closed', () => {
    serverWindow = null;
    if (pickerForMovedServer && !isQuitting) {
      isQuitting = true;
      app.quit();
    }
  });
}

/**
 * The window's own load of the chosen server was redirected to another
 * origin, so the app has no page to show (the window only ever shows the
 * chosen origin). The same server at a new address — moved to https, or its
 * www/apex twin, and answering as Zekktris there — is followed by switching to
 * it. Anything else is the user's call: the server picker explains, offering
 * the new address.
 */
let handlingServerRedirect = false;
async function serverRedirected(target: string): Promise<void> {
  if (handlingServerRedirect) return;
  handlingServerRedirect = true;
  const saved = getServerUrl();
  let to: string | null = null;
  try {
    const u = new URL(target);
    if (u.protocol === 'https:' || u.protocol === 'http:') to = u.origin;
  } catch {
    /* not a URL: nothing to offer */
  }
  if (to && isServerMove(saved, to)) {
    const probed = await probeServer(to);
    if (probed.ok && probed.origin === to) {
      switchServer(to);
      return;
    }
  }
  mainWindow?.hide();
  showServerPicker({ from: new URL(saved).host, to });
}

/** The shell's own file:// windows never leave the page they were opened on,
    so the bridge calls only they may make stay with that page. */
function keepOnShellPage(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** Only the shell's own server window may switch servers. */
function fromServerWindow(e: Electron.IpcMainInvokeEvent): boolean {
  return !!serverWindow && e.sender === serverWindow.webContents;
}

function switchServer(origin: string | null): void {
  setServerUrl(origin);
  isQuitting = true;
  app.relaunch();
  app.exit(0);
}

// Any page (including the remote app's sign-in screen) may ask to OPEN the
// picker; choosing still happens in the shell's window.
ipcMain.on('zk:open-server-picker', () => showServerPicker());

ipcMain.handle('zk:server-current', () => {
  const url = getServerUrl();
  return { url, host: new URL(url).host, isDefault: url === DEFAULT_SERVER_URL };
});

ipcMain.handle('zk:server-connect', async (e, address: unknown) => {
  if (!fromServerWindow(e) || typeof address !== 'string') return 'Not allowed.';
  const found = await findServer(address);
  if (!found.ok) return found.error;
  switchServer(found.origin);
  return null;
});

ipcMain.handle('zk:server-reset', (e) => {
  if (!fromServerWindow(e)) return 'Not allowed.';
  switchServer(null);
  return null;
});

ipcMain.on('zk:server-close', (e) => {
  if (serverWindow && e.sender === serverWindow.webContents) serverWindow.close();
});

// ── Screen-share source picker ────────────────────────────────────────────────
// Shows a small window listing capturable screens + windows with live
// thumbnails. Resolves the pending getDisplayMedia callback with the
// chosen source, or denies it on cancel.

// Electron's own callback shape. Deny with `null`, the documented way (the
// page's getDisplayMedia rejects). The old `{ video: undefined }` denied too,
// but only by tripping Electron's "Video was requested, but no video stream
// was provided" TypeError.
type DisplayMediaCallback = (streams: Electron.Streams | null) => void;
let pickerWindow: BrowserWindow | null = null;
let pendingPickerCallback: DisplayMediaCallback | null = null;
let pendingSources: Electron.DesktopCapturerSource[] = [];

function showSourcePicker(
  sources: Electron.DesktopCapturerSource[],
  callback: DisplayMediaCallback,
): void {
  // Only one picker at a time; deny a new request if one's already open.
  if (pickerWindow) {
    callback(null);
    return;
  }
  pendingPickerCallback = callback;
  pendingSources = sources;

  // Size the window to fit the tiles exactly — no scrollbars. The
  // picker lays out a fixed 3-column grid of small tiles; we compute
  // the height from the number of rows. These constants MUST match
  // the CSS in picker.html (COLS, tile + gap + chrome sizes).
  const COLS = 3;
  const TILE_H = 152; // thumbnail (96) + label block + padding
  const GAP = 10;
  const H_PADDING = 16; // top/bottom body padding
  const HEADER = 40; // title row
  const FOOTER = 56; // cancel-button bar
  const rows = Math.max(1, Math.ceil(sources.length / COLS));
  const contentH =
    HEADER + H_PADDING + rows * TILE_H + (rows - 1) * GAP + FOOTER + H_PADDING;
  // Clamp: never smaller than one row, never taller than a sane max
  // (a machine with a huge number of open windows is the only way to
  // hit this, and then a scrollbar inside the grid is acceptable).
  const height = Math.min(Math.max(contentH, 240), 760);

  pickerWindow = new BrowserWindow({
    width: 600,
    height,
    parent: mainWindow ?? undefined,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0a0f1c',
    title: 'Choose what to share',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void pickerWindow.loadFile(join(__dirname, 'static', 'picker.html'));
  keepOnShellPage(pickerWindow);

  pickerWindow.on('closed', () => {
    pickerWindow = null;
    // If it closed without a selection, deny the request so the web
    // app's getDisplayMedia promise rejects cleanly (rather than hanging).
    if (pendingPickerCallback) {
      pendingPickerCallback(null);
      pendingPickerCallback = null;
      pendingSources = [];
    }
  });
}

/** The source list and the choice belong to the shell's picker page alone,
    and only while a getDisplayMedia request is waiting on it. The remote page
    must never list windows (titles + thumbnails) or pick a source itself:
    that would share the whole screen without the user choosing it. */
function fromPickerWindow(e: Electron.IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  return (
    !!pickerWindow &&
    !!pendingPickerCallback &&
    e.sender === pickerWindow.webContents &&
    !!frame &&
    frame.parent === null &&
    frame.url.startsWith('file:')
  );
}

// Picker asks for the source list (id, name, thumbnail data URL).
ipcMain.handle('zk:get-screen-sources', (e) => {
  if (!fromPickerWindow(e)) return [];
  return pendingSources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    isScreen: s.id.startsWith('screen:'),
  }));
});

// Picker reports the user's choice (sourceId) or null on cancel.
ipcMain.handle('zk:pick-screen-source', (e, sourceId: unknown) => {
  if (!fromPickerWindow(e)) return;
  const cb = pendingPickerCallback;
  pendingPickerCallback = null;
  const chosen =
    typeof sourceId === 'string'
      ? (pendingSources.find((s) => s.id === sourceId) ?? null)
      : null;
  pendingSources = [];
  if (pickerWindow) {
    const w = pickerWindow;
    pickerWindow = null;
    w.destroy();
  }
  if (!cb) return;
  if (chosen) {
    // Include system/loopback audio with the shared video. 'loopback'
    // captures the machine's audio output on Windows; on Linux it's
    // honored where the audio backend supports it, and is ignored
    // gracefully otherwise (video still shares).
    cb({ video: chosen, audio: 'loopback' });
  } else {
    cb(null);
  }
});

// ── Auto-updater ──────────────────────────────────────────────────────────
// Uses electron-updater. The feed is configured via the `publish` block
// in electron-builder.yml (a generic provider pointing at your server).
// Updates download in the background; the user is prompted to restart.
let updateCheckInFlight = false;

function setupAutoUpdater(): void {
  // No-op in dev (no packaged app-update.yml).
  if (electronProcess.defaultApp) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    updateCheckInFlight = false;
    void import('electron').then(({ dialog }) => {
      dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          title: 'Update ready',
          message: `Zekktris ${info.version} has been downloaded.`,
          detail: 'Restart to finish installing the update.',
        })
        .then((r) => {
          if (r.response === 0) {
            isQuitting = true;
            autoUpdater.quitAndInstall();
          }
        });
    });
  });

  autoUpdater.on('error', () => {
    updateCheckInFlight = false;
  });
}

// `interactive` = the user asked via the tray; show "no updates" / errors.
function checkForUpdates(interactive = false): void {
  if (electronProcess.defaultApp) {
    if (interactive) {
      void import('electron').then(({ dialog }) =>
        dialog.showMessageBox({
          type: 'info',
          message: 'Updates are only available in the installed app.',
        }),
      );
    }
    return;
  }
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  if (interactive) {
    autoUpdater.once('update-not-available', () => {
      updateCheckInFlight = false;
      void import('electron').then(({ dialog }) =>
        dialog.showMessageBox({
          type: 'info',
          message: "You're on the latest version.",
        }),
      );
    });
  }
  autoUpdater.checkForUpdates().catch(() => {
    updateCheckInFlight = false;
  });
}

// ── Idle / away detection ───────────────────────────────────────────────────
// Tells the renderer when the machine has been idle (or locked/suspended)
// and when it's back. The web app reports that as this device's activity
// (apps/web/src/lib/usePresenceActivity.ts), so the user's presence follows
// the device in use; against an older server it auto-sets Away / Online
// instead. Only the native shell can see system-wide idle; a browser tab
// can't. Threshold: 10 minutes.
const IDLE_THRESHOLD_SEC = 600;
const IDLE_POLL_MS = 30_000;
let idleState = false;
let idleTimer: ReturnType<typeof setInterval> | null = null;

function setIdle(next: boolean): void {
  if (next === idleState) return;
  idleState = next;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('zk:idle-state', next);
  }
}

function startIdleWatch(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    try {
      const idleSec = powerMonitor.getSystemIdleTime();
      setIdle(idleSec >= IDLE_THRESHOLD_SEC);
    } catch {
      // getSystemIdleTime can throw on some Linux setups — ignore.
    }
  }, IDLE_POLL_MS);

  // Lock / suspend → immediately idle; unlock / resume → active.
  powerMonitor.on('lock-screen', () => setIdle(true));
  powerMonitor.on('suspend', () => setIdle(true));
  powerMonitor.on('unlock-screen', () => setIdle(false));
  powerMonitor.on('resume', () => setIdle(false));
}

// The renderer asks for the current idle state on load (so it can sync
// presence immediately after a reload).
ipcMain.handle('zk:get-idle-state', () => idleState);

// Theme-aware app icons. The web app rasterizes the Zekktris mark in the
// active theme's colors to PNGs (one window-sized, one tray-sized) and sends
// them here; we apply them to the window (Windows/Linux taskbar), the macOS
// dock, and the system tray so every native icon for the app tracks the
// selected theme. Best-effort: malformed/empty images are ignored.
//
// Accepts both shapes for forward/backward compatibility: a single string
// (legacy — window/dock only) or { window?, tray? }. The tray's unread
// variant stays as the static asset so unread remains visually distinct.
ipcMain.on(
  'zk:set-app-icon',
  (_e, payload: string | { window?: string; tray?: string }) => {
    try {
      const obj =
        typeof payload === 'string' ? { window: payload } : payload ?? {};
      const isPng = (s: unknown): s is string =>
        typeof s === 'string' && s.startsWith('data:image/');
      if (isPng(obj.window)) {
        const img = nativeImage.createFromDataURL(obj.window);
        if (!img.isEmpty()) {
          mainWindow?.setIcon(img);
          if (process.platform === 'darwin' && app.dock) app.dock.setIcon(img);
        }
      }
      // Tray theming is intentionally skipped on Windows — the tray keeps its
      // normal (build-time) glyph there. macOS/Linux still recolor to match.
      if (isPng(obj.tray) && process.platform !== 'win32') {
        const img = nativeImage.createFromDataURL(obj.tray);
        if (!img.isEmpty()) {
          // Replace the "normal" tray glyph and re-apply via the badge logic
          // so the currently-visible image (normal vs. unread) updates without
          // losing the unread state.
          trayNormalImg = img;
          applyBadge(lastBadgeCount);
        }
      }
    } catch {
      /* ignore — keep the build-time icons */
    }
  },
);

// ── Custom title bar window controls ────────────────────────────────────────
// The preload injects a frameless title bar whose buttons send these.
ipcMain.on('zk:call-active', (_e, active: unknown) => {
  callActive = active === true;
});

ipcMain.on('zk:win-minimize', () => {
  mainWindow?.minimize();
});
ipcMain.on('zk:win-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('zk:win-close', () => {
  // Honour the close-to-tray preference (same path as the window's own
  // close button used to take).
  if (mainWindow) mainWindow.close();
});
// Let the renderer query + observe maximize state so the middle button
// can switch between the "maximize" and "restore" glyphs.
ipcMain.handle('zk:win-is-maximized', () => mainWindow?.isMaximized() ?? false);

function wireMaximizeEvents(win: BrowserWindow): void {
  const send = () => {
    if (!win.isDestroyed())
      win.webContents.send('zk:win-maximized-changed', win.isMaximized());
  };
  win.on('maximize', send);
  win.on('unmaximize', send);
}

// ── Windows jump list ──────────────────────────────────────────────────────
function setupJumpList(): void {
  if (process.platform !== 'win32') return;
  try {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: '',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'Open Zekktris',
        description: 'Open the Zekktris window',
      },
    ]);
  } catch {
    // Jump list is best-effort.
  }
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Windows: the App User Model ID must match the installed shortcut's
  // AUMID (electron-builder sets it from appId) for native
  // notifications to appear with the correct app name + icon instead
  // of a generic "electron.app.Electron" toast.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.zekktris.desktop');
  }

  // Auto-grant the permissions the web app needs so nothing prompts — and
  // only those (the list and why is in trust.ts), only to the chosen
  // server's own pages in the main window: not the shell's file:// windows,
  // not a third-party iframe. webContents is null for checks that don't come
  // from a page (e.g. the service worker); the origin still has to match.
  const inMainWindow = (wc: Electron.WebContents | null): boolean =>
    wc === null || (!!mainWindow && wc === mainWindow.webContents);
  session.defaultSession.setPermissionRequestHandler(
    (wc, permission, callback, details) => {
      callback(
        inMainWindow(wc) &&
          permissionAllowed(permission, details.requestingUrl, getServerUrl()),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission, requestingOrigin) =>
      inMainWindow(wc) && permissionAllowed(permission, requestingOrigin, getServerUrl()),
  );

  // Screen-share support. getDisplayMedia() does nothing in Electron
  // until we register this handler — this is why screen share was
  // failing. We present a picker of screens + windows and resolve the
  // request with the user's choice.
  //
  // Every platform, macOS included, goes through that picker. Electron's
  // OS-native picker (`useSystemPicker`) is still marked experimental and is
  // macOS 15+ only, so Windows, Linux and older Macs need this picker anyway;
  // one shell-owned picker keeps screen share the same everywhere.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Only the chosen server's own page may ask (not an iframe it embeds:
      // its securityOrigin is the iframe's).
      if (!isServerOrigin(request.securityOrigin || request.frame?.url)) {
        callback(null);
        return;
      }
      void desktopCapturer
        .getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 320, height: 200 },
          fetchWindowIcons: true,
        })
        .then((sources) => {
          if (sources.length === 0) {
            // Nothing to share — deny cleanly.
            callback(null);
            return;
          }
          showSourcePicker(sources, callback);
        })
        .catch(() => callback(null));
    },
  );

  createTray();
  setupJumpList();
  setupAutoUpdater();
  startIdleWatch();
  // Keep the OS login item in sync with the saved setting, then load.
  applyLoginItem(getOpenAtLogin());
  // Load the chosen server (zekktris.com by default). If the app was
  // launched at login, start hidden in the tray.
  createMainWindow(getServerUrl(), launchedAtLogin());

  // Background update check shortly after launch, then every 6 hours.
  setTimeout(() => checkForUpdates(false), 8000);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);

  app.on('activate', () => {
    // macOS: re-open a window when the dock icon is clicked.
    focusMainWindow();
  });
});

// macOS deep-link delivery.
app.on('open-url', (e, url) => {
  e.preventDefault();
  handleDeepLink(url);
});

app.on('before-quit', () => {
  isQuitting = true;
});

// Keep running in the tray when all windows are closed (except macOS,
// where the app staying alive with no windows is the platform norm and
// handled by `activate`). We deliberately do NOT quit here so the tray
// stays put and notifications keep arriving.
app.on('window-all-closed', () => {
  // no-op: tray keeps the app alive. Quit only via tray/menu.
});
