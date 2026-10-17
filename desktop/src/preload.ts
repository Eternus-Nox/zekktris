/**
 * Preload — runs in the renderer with contextIsolation. Exposes a
 * tiny, explicit API on window.zekktris, AND injects the custom
 * frameless title bar (see injectTitleBar below) so the bar is owned
 * entirely by the desktop shell, independent of the web app's code.
 */

import { contextBridge, ipcRenderer, webFrame } from 'electron';

// Who may see the bridge: the chosen server's own pages (main.ts passes its
// origin as --zk-server-origin) and the shell's own file:// pages. Main.ts
// keeps the window on that origin; this is the second line, so a page that
// still ends up somewhere else (a redirect, an error page) gets nothing.
const SERVER_ORIGIN =
  process.argv
    .find((a) => a.startsWith('--zk-server-origin='))
    ?.slice('--zk-server-origin='.length) ?? null;
const IS_SHELL_PAGE = window.location.protocol === 'file:';
const IS_SERVER_PAGE = !!SERVER_ORIGIN && window.location.origin === SERVER_ORIGIN;

if (IS_SERVER_PAGE || IS_SHELL_PAGE) {
  contextBridge.exposeInMainWorld('zekktris', {
    isDesktop: true,
    // The screen-share picker (static/picker.html, a file:// page the shell
    // owns) lists the capturable sources and reports the choice. Remote pages
    // never get these, and main.ts also checks the sender.
    ...(IS_SHELL_PAGE
      ? {
          /** Screen-share picker: list capturable sources. */
          getScreenSources: (): Promise<
            Array<{ id: string; name: string; thumbnail: string; isScreen: boolean }>
          > => ipcRenderer.invoke('zk:get-screen-sources'),
          /** Screen-share picker: report the chosen source id (or null to cancel). */
          pickScreenSource: (sourceId: string | null): Promise<void> =>
            ipcRenderer.invoke('zk:pick-screen-source', sourceId),
        }
      : {}),
    /** Set the native window / taskbar / dock / tray icons from PNG data URLs
        (used to make every app icon track the selected in-app theme). Accepts
        either a single string (legacy: window/dock only) or an object with
        separate `window` and `tray` PNGs. */
    setAppIcon: (
      payload: string | { window?: string; tray?: string },
    ): void => {
      ipcRenderer.send('zk:set-app-icon', payload);
    },
    /** Tell the shell whether a voice/video call is currently connected, so it
        can hold off actions that would destroy the Room (see the unresponsive
        watchdog in main.ts). */
    setCallActive: (active: boolean): void => {
      ipcRenderer.send('zk:call-active', active);
    },
    /** Current idle state (true = system idle/locked). */
    getIdleState: (): Promise<boolean> => ipcRenderer.invoke('zk:get-idle-state'),
    /** Subscribe to idle-state changes (true = idle, false = active).
        Returns an unsubscribe function. */
    onIdleStateChange: (cb: (idle: boolean) => void): (() => void) => {
      const listener = (_e: unknown, idle: boolean) => cb(idle);
      ipcRenderer.on('zk:idle-state', listener);
      return () => ipcRenderer.removeListener('zk:idle-state', listener);
    },
    /** Which Zekktris server the app is loading ({ url, host, isDefault }). */
    getServer: (): Promise<{ url: string; host: string; isDefault: boolean }> =>
      ipcRenderer.invoke('zk:server-current'),
    /** Open the shell's server picker. Picking happens in that window. */
    openServerPicker: (): void => {
      ipcRenderer.send('zk:open-server-picker');
    },
  });
}

// The server picker itself (static/server.html, a file:// page the shell owns)
// gets the calls that actually switch servers. Remote pages never see these,
// and main.ts also checks the sender.
if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('zekktrisServer', {
    current: (): Promise<{ url: string; host: string; isDefault: boolean }> =>
      ipcRenderer.invoke('zk:server-current'),
    /** Resolves to null on success (the app relaunches), else a message. */
    connect: (address: string): Promise<string | null> =>
      ipcRenderer.invoke('zk:server-connect', address),
    reset: (): Promise<string | null> => ipcRenderer.invoke('zk:server-reset'),
    close: (): void => {
      ipcRenderer.send('zk:server-close');
    },
  });
}

// ── Custom title bar (shell-owned, injected into the page) ───────────────────
// The window is frameless (frame:false), so we draw our own 32px title
// bar: gradient wordmark on the left, custom minimize / maximize / close
// buttons on the right, a draggable region, and a bottom hairline that
// runs the full width (buttons included). Injected here so it does not
// depend on the web app's code or deploy.

const TITLEBAR_H = 32;

const ICONS = {
  min: '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor"/></svg>',
  max: '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/><path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" fill="none" stroke="currentColor"/></svg>',
  close:
    '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.2"/></svg>',
};

function injectTitleBar(): void {
  if (document.getElementById('zk-frame-bar')) return;
  if (!document.body) return;

  // Injected through webFrame, not a <style> element: the page's
  // Content-Security-Policy (style-src 'self', no 'unsafe-inline') governs
  // elements the preload inserts too, and would drop the bar's CSS — leaving
  // a frameless window that can't be dragged. Injected sheets are exempt.
  webFrame.insertCSS(`
    html.zk-frame, html.zk-frame body { height: calc(100dvh - ${TITLEBAR_H}px) !important; }
    html.zk-frame body { margin-top: ${TITLEBAR_H}px !important; }
    html.zk-frame .min-h-screen { min-height: calc(100dvh - ${TITLEBAR_H}px) !important; }
    #zk-frame-bar {
      position: fixed; top: 0; left: 0; right: 0; height: ${TITLEBAR_H}px;
      box-sizing: border-box; display: flex; align-items: center;
      background: rgb(var(--c-bg-0, 10 15 28));
      border-bottom: 1px solid var(--zk-line-soft, rgba(120,140,190,0.22));
      z-index: 2147483647; -webkit-app-region: drag; user-select: none;
      font-family: Inter, system-ui, sans-serif;
    }
    #zk-frame-bar .zk-frame-title {
      margin-left: 12px; font-size: 14px; font-weight: 700; letter-spacing: 0.04em;
      background: linear-gradient(90deg, var(--accent, #3dd7ec), var(--accent-2, #9d7bff));
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent; color: transparent;
    }
    #zk-frame-bar .zk-frame-spacer { flex: 1; }
    #zk-frame-bar .zk-frame-btn {
      -webkit-app-region: no-drag; width: 46px; height: ${TITLEBAR_H}px;
      border: 0; background: transparent; color: #aab4d4;
      display: inline-flex; align-items: center; justify-content: center;
      cursor: default; transition: background 0.12s, color 0.12s; padding: 0;
    }
    #zk-frame-bar .zk-frame-btn:hover { background: rgba(255,255,255,0.08); color: #e6ecf7; }
    #zk-frame-bar .zk-frame-btn.close:hover { background: #e23b3b; color: #fff; }
  `);
  document.documentElement.classList.add('zk-frame');

  const bar = document.createElement('div');
  bar.id = 'zk-frame-bar';
  const title = document.createElement('span');
  title.className = 'zk-frame-title';
  title.textContent = 'Zekktris';
  const spacer = document.createElement('span');
  spacer.className = 'zk-frame-spacer';
  bar.appendChild(title);
  bar.appendChild(spacer);

  const mk = (cls: string, html: string, label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.className = `zk-frame-btn ${cls}`;
    b.innerHTML = html;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  };
  mk('min', ICONS.min, 'Minimize', () => ipcRenderer.send('zk:win-minimize'));
  const maxBtn = mk('max', ICONS.max, 'Maximize', () =>
    ipcRenderer.send('zk:win-maximize'),
  );
  mk('close', ICONS.close, 'Close', () => ipcRenderer.send('zk:win-close'));

  // Double-clicking the drag area toggles maximize (standard behaviour).
  bar.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.zk-frame-btn')) return;
    ipcRenderer.send('zk:win-maximize');
  });

  // Swap the middle glyph between maximize / restore with window state.
  const setMax = (isMax: boolean) => {
    maxBtn.innerHTML = isMax ? ICONS.restore : ICONS.max;
    maxBtn.title = isMax ? 'Restore' : 'Maximize';
  };
  ipcRenderer.invoke('zk:win-is-maximized').then(setMax).catch(() => undefined);
  ipcRenderer.on('zk:win-maximized-changed', (_e, isMax: boolean) => setMax(isMax));

  document.body.appendChild(bar);
}

// Only the main remote app (https) gets the custom frameless title
// bar. Local helper windows — notably the screen-share picker, loaded
// via file:// — keep their own native frame, so we must NOT inject
// there (otherwise the picker shows both a custom bar and the native
// window controls).
function shouldInjectTitleBar(): boolean {
  try {
    return window.location.protocol !== 'file:';
  } catch {
    return false;
  }
}

if (shouldInjectTitleBar()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTitleBar);
  } else {
    injectTitleBar();
  }
}

