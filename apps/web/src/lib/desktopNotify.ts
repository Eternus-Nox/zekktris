/**
 * Desktop notifications
 * ---------------------
 * Fires native OS notification pop-ups via the Web Notification API.
 *
 * These run ONLY inside the Electron desktop app — detected via the
 * `window.zekktris.isDesktop` flag the preload exposes. Browser users
 * receive notifications through the service-worker push channel
 * instead, so gating here prevents double-notifying them.
 *
 * The Electron main process auto-grants notification permission for the
 * app origin, so `Notification.permission` is already 'granted' and no
 * prompt appears. We still guard defensively.
 *
 * Sounds are handled separately (lib/sounds.ts) and play in the
 * renderer regardless of platform — a notification and its sound fire
 * together from the same call site.
 */

import { themedNotificationIcon } from './themeIcon';

interface ZekktrisBridge {
  isDesktop?: boolean;
  platform?: string;
}

function bridge(): ZekktrisBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { zekktris?: ZekktrisBridge }).zekktris;
}

/** True when running inside the Electron desktop shell. */
export function isDesktopApp(): boolean {
  return !!bridge()?.isDesktop;
}

let permissionAsked = false;

function ensurePermission(): boolean {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  // 'default' — request once (fire-and-forget). In the desktop app the
  // main process grants it, so the next call will see 'granted'. This
  // instance returns false (the request resolves asynchronously).
  if (!permissionAsked) {
    permissionAsked = true;
    try {
      void Notification.requestPermission().catch(() => undefined);
    } catch {
      // ignore
    }
  }
  return false;
}

export interface DesktopNotifyOptions {
  title: string;
  body?: string;
  /** Notifications with the same tag replace each other (e.g. one per
      channel, or one per call) instead of stacking. */
  tag?: string;
  /** Keep the notification up until the user interacts (used for calls). */
  requireInteraction?: boolean;
  /** Extra handler to run when the notification is clicked, after the
      window is focused. */
  onClick?: () => void;
}

/**
 * Show a native notification. No-op outside the desktop app or when
 * permission isn't granted. Returns the Notification instance so
 * callers can close it later (e.g. dismiss a call notification when the
 * call is answered), or null if nothing was shown.
 */
export function showDesktopNotification(
  opts: DesktopNotifyOptions,
): Notification | null {
  if (!isDesktopApp()) return null;
  if (!ensurePermission()) return null;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      // The current theme's app mark (a PNG data URL theme.ts rasterises on
      // every theme switch), so the banner's image matches the theme; the
      // static default-palette /icon-192.png until that raster is ready.
      icon: themedNotificationIcon(),
      requireInteraction: opts.requireInteraction ?? false,
      silent: true, // we play our own sound via lib/sounds.ts
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      try {
        n.close();
      } catch {
        // ignore
      }
      opts.onClick?.();
    };
    return n;
  } catch {
    return null;
  }
}
