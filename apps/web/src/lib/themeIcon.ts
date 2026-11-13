/**
 * The themed app icon, for OS notifications.
 * ------------------------------------------
 * theme.ts rasterises the theme's Z mark (the favicon art: the accent trio
 * on the theme background) to a PNG on every applyTheme and hands it here.
 * Two notification surfaces can't take the SVG favicon and need that PNG:
 *
 *   - Electron's OS notifications (lib/desktopNotify) read it synchronously
 *     through themedNotificationIcon().
 *   - Web Push notifications are shown by the service worker, which can't
 *     read the page's localStorage (where the theme lives), so the page
 *     posts the PNG to it and public/sw.js keeps it in Cache Storage for
 *     the next push.
 *
 * Until the first raster lands (or where canvas is unavailable) both fall
 * back to the static /icon-192.png, which is the default palette's icon.
 */

/** The build-time app icon: the default theme's colours. */
export const STATIC_NOTIFICATION_ICON = '/icon-192.png';

/** The message the service worker (public/sw.js) stores the icon from. */
export const SET_THEME_ICON = 'SET_THEME_ICON';

/** Only a base64 PNG data URL is ever accepted as the themed icon — the same
 *  check sw.js applies, so a notification never fetches anything remote. */
export function isThemeIconPng(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= 512 * 1024 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v)
  );
}

let current: string | null = null;

/** The icon an OS notification should show right now: the current theme's
 *  mark, or the static icon until the first raster is ready. */
export function themedNotificationIcon(): string {
  return current ?? STATIC_NOTIFICATION_ICON;
}

/** Record the current theme's rasterised mark (called by theme.ts) and pass
 *  it on to the service worker for push notifications. */
export function setThemedIcon(png: string): void {
  if (!isThemeIconPng(png)) return;
  current = png;
  sendToServiceWorker();
}

// True while a wait for the service worker is pending, so repeated theme
// switches before it activates queue one wait, not one per switch (and where
// no worker ever registers — dev, native shells — at most one stays pending).
let waitingForWorker = false;

// True once this page listens for a new worker taking control (one listener
// per page, however many times the theme changes).
let watchingController = false;

/** Post the current icon to `worker`, if there is one and an icon to send. */
function send(worker: ServiceWorker | null | undefined): void {
  if (!worker || !current) return;
  try {
    worker.postMessage({ type: SET_THEME_ICON, png: current });
  } catch {
    // The worker's port is gone; the next applyTheme sends again.
  }
}

function sendToServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  // A worker that takes control later gets the icon too. On the first deploy
  // of this feature the worker this page booted under predates SET_THEME_ICON
  // and drops the message; the new sw.js then claims the page (its install
  // skips waiting) and would otherwise show the static icon on every push
  // until the next reload or theme switch.
  if (!watchingController && typeof container.addEventListener === 'function') {
    watchingController = true;
    container.addEventListener('controllerchange', () => send(container.controller));
  }
  if (container.controller) {
    send(container.controller);
    return;
  }
  // Nothing controls this page yet (first visit, or a hard reload): wait for
  // the worker main.tsx registers, then send whatever icon is current then.
  if (waitingForWorker) return;
  waitingForWorker = true;
  container.ready
    .then((reg) => {
      waitingForWorker = false;
      send(reg.active);
    })
    .catch(() => {
      waitingForWorker = false;
    });
}
