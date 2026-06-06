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
} from './config';

const PROTOCOL = 'zekktris';

// Fixed instance the desktop app connects to. The app is a dedicated
// client for zekktris.com — no server-picker, no setup screen.
const SERVER_URL = 'https://zekktris.com';

// ── Auto-launch (start on login) ────────────────────────────────────────────
// Apply the persisted openAtLogin setting to the OS login items. We
// pass --hidden so a login-triggered launch starts straight to the
// tray without flashing the window open.
function applyLoginItem(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled, // macOS: start hidden
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
//   - hardware H.264 encode/decode for video & screen tracks
//   - GPU rasterization + zero-copy for smoother scrolling/compositing
//   - PipeWire capturer so screen share works on Linux/Wayland (no-op
//     elsewhere)
app.commandLine.appendSwitch(
  'enable-features',
  'WebRtcHideLocalIpsWithMdns,WebRTCPipeWireCapturer,VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization',
);
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// Don't throttle timers/rendering when the window is backgrounded —
// critical so the gateway WebSocket, voice, and notifications keep
// running smoothly while the window is minimized or behind others.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

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
    void mainWindow.loadURL(`${SERVER_URL}/${route}`);
  } catch {
    /* ignore malformed deep links */
  }
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

  // External links + off-origin navigations open in the default browser.
  const isInternal = (url: string) => {
    try {
      return new URL(url).origin === new URL(serverUrl).origin;
    } catch {
      return false;
    }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isInternal(url)) {
      e.preventDefault();
      void shell.openExternal(url);
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
  mainWindow.on('unresponsive', () => {
    // Give it a moment, then reload if still wedged.
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    }, 3000);
  });

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
    createMainWindow(SERVER_URL);
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

// ── Screen-share source picker ────────────────────────────────────────────────
// Shows a small window listing capturable screens + windows with live
// thumbnails. Resolves the pending getDisplayMedia callback with the
// chosen source, or denies it on cancel.

type DisplayMediaCallback = (streams: unknown) => void;
let pickerWindow: BrowserWindow | null = null;
let pendingPickerCallback: DisplayMediaCallback | null = null;
let pendingSources: Electron.DesktopCapturerSource[] = [];

function showSourcePicker(
  sources: Electron.DesktopCapturerSource[],
  callback: DisplayMediaCallback,
): void {
  // Only one picker at a time; deny a new request if one's already open.
  if (pickerWindow) {
    callback({ video: undefined } as never);
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

  pickerWindow.on('closed', () => {
    pickerWindow = null;
    // If it closed without a selection, deny the request so the web
    // app's getDisplayMedia promise rejects cleanly (rather than hanging).
    if (pendingPickerCallback) {
      pendingPickerCallback({ video: undefined } as never);
      pendingPickerCallback = null;
      pendingSources = [];
    }
  });
}

// Picker asks for the source list (id, name, thumbnail data URL).
ipcMain.handle('zk:get-screen-sources', () =>
  pendingSources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    isScreen: s.id.startsWith('screen:'),
  })),
);

// Picker reports the user's choice (sourceId) or null on cancel.
ipcMain.handle('zk:pick-screen-source', (_e, sourceId: string | null) => {
  const cb = pendingPickerCallback;
  pendingPickerCallback = null;
  const chosen = pendingSources.find((s) => s.id === sourceId) ?? null;
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
    cb({ video: chosen, audio: 'loopback' } as never);
  } else {
    cb({ video: undefined } as never);
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
// so the web app can auto-set presence to Away, and back to Online on
// return. Only the native shell can see system-wide idle; a browser tab
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

  // Auto-grant the permissions the web app needs so nothing prompts:
  //   - notifications: native message/call pop-ups
  //   - media / mic / camera: voice + video
  //   - display-capture: screen share (the request handler above does
  //     the actual source selection)
  const allowed = new Set([
    'notifications',
    'media',
    'mediaKeySystem',
    'audioCapture',
    'videoCapture',
    'display-capture',
    // navigator.clipboard.writeText() triggers a clipboard permission check;
    // without these the desktop renderer gets "clipboard access declined".
    'clipboard-read',
    'clipboard-write',
    'clipboard-sanitized-write',
  ]);
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(allowed.has(permission));
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => allowed.has(permission),
  );

  // Screen-share support. getDisplayMedia() does nothing in Electron
  // until we register this handler — this is why screen share was
  // failing. We present a picker of screens + windows and resolve the
  // request with the user's choice.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // macOS 15+ (Sonoma/Sequoia): hand off to the OS-native picker,
      // which also drives the system screen-recording permission flow.
      if (process.platform === 'darwin') {
        try {
          callback({ video: undefined, audio: undefined, useSystemPicker: true } as never);
          return;
        } catch {
          // Older Electron without useSystemPicker — fall through.
        }
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
            callback({ video: undefined } as never);
            return;
          }
          showSourcePicker(sources, callback);
        })
        .catch(() => callback({ video: undefined } as never));
    },
    // useSystemPicker hint (honored on supported platforms).
    { useSystemPicker: true } as never,
  );

  createTray();
  setupJumpList();
  setupAutoUpdater();
  startIdleWatch();
  // Keep the OS login item in sync with the saved setting, then load.
  applyLoginItem(getOpenAtLogin());
  // Fixed instance — always load zekktris.com. No setup screen. If the
  // app was launched at login, start hidden in the tray.
  createMainWindow(SERVER_URL, launchedAtLogin());

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
