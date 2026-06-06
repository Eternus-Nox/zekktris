/**
 * PwaBanners
 * ----------
 * Stacked status banners rendered at the top of the app:
 *
 *   - Offline       — fires on navigator offline event; persists until
 *                     network restored. Tells the user why messages
 *                     might not be sending.
 *   - Update ready  — fires when the SW detects a new build is
 *                     installed and waiting. User taps to apply
 *                     (which triggers SKIP_WAITING → reload).
 *   - Install       — Android/Chromium fire beforeinstallprompt;
 *                     we defer it and show a button to invoke the
 *                     native install dialog when the user is ready.
 *                     iOS gets a separate hint elsewhere because
 *                     Safari doesn't fire that event.
 *
 * The component sits above the app shell at z-50 so banners overlay
 * the rail + main areas. Mobile-friendly: full-width tappable buttons,
 * compact text, safe-area-aware padding.
 *
 * Subscribes to the `window.zkPwa` bus set up in main.tsx. Re-renders
 * on state change. Banners can be dismissed individually (state
 * stored in localStorage so dismissal sticks across reloads).
 */

import { useEffect, useState } from 'react';
import { WifiOff, RefreshCw, Download, X, ShareSquare } from '../lib/icons';
import { isNative } from '../lib/native';

// beforeinstallprompt is non-standard but supported by Chromium-based
// browsers (including Android Chrome, Edge, Samsung Internet). The
// event has a `prompt()` method we call after deferring the default,
// plus a `userChoice` promise that resolves with the user's decision.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

// Dismissal flags persist across reloads. We use localStorage rather
// than session-only state so a user who said "not now" doesn't see the
// install prompt every time they reopen the app. The update banner
// IS NOT dismissible — that one matters too much to silence.
const DISMISSED_INSTALL_KEY = 'zekktris.pwa.install-dismissed.v1';

function isStandalone(): boolean {
  // Two signals: display-mode media query (Chromium, modern Safari)
  // and navigator.standalone (legacy iOS). Either one means we're
  // already installed; no point in showing the install prompt.
  if (typeof window === 'undefined') return false;
  // The Capacitor native shell isn't a "PWA install" technically, but it
  // IS the installed app — never show install/add-to-home prompts in it.
  if (isNative()) return true;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    // matchMedia missing — unlikely on real devices
  }
  // navigator.standalone is iOS-only and exists outside the typed
  // Navigator surface; bracket access avoids the TS error.
  const navAny = navigator as Navigator & { standalone?: boolean };
  if (navAny.standalone === true) return true;
  return false;
}

/**
 * Detect iOS Safari (the only browser on iOS that can install PWAs
 * to the home screen). Chrome/Firefox/Edge on iOS use WKWebView and
 * can't install PWAs — those users won't benefit from the hint.
 */
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Capacitor's WKWebView UA contains "Safari" but it's our native shell,
  // not the browser — it can't (and shouldn't) Add to Home Screen.
  if (isNative()) return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua);
  if (!isIos) return false;
  // Chrome/Firefox/Edge on iOS — exclude.
  if (/CriOS|FxiOS|EdgiOS/i.test(ua)) return false;
  // Plain Safari on iOS has Safari in UA + no other browser hints.
  return /Safari/i.test(ua);
}

const DISMISSED_IOS_INSTALL_KEY = 'zekktris.pwa.ios-install-dismissed.v1';

export function PwaBanners() {
  const [updateReady, setUpdateReady] = useState(false);
  const [offline, setOffline] = useState<boolean>(
    typeof navigator !== 'undefined' && !navigator.onLine,
  );
  const [installPromptEvent, setInstallPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISSED_INSTALL_KEY) === '1';
    } catch {
      return false;
    }
  });
  // iOS Safari install hint state. Separate from the Android install
  // prompt because iOS has no programmatic install API — we can only
  // show an explanatory hint pointing at the Share button.
  const [iosHintDismissed, setIosHintDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISSED_IOS_INSTALL_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [iosShowHint, setIosShowHint] = useState(false);

  // Subscribe to the PWA bus from main.tsx for update + offline state.
  useEffect(() => {
    const bus = window.zkPwa;
    if (!bus) return;
    const apply = (s: { updateReady: boolean; offline: boolean }) => {
      setUpdateReady(s.updateReady);
      setOffline(s.offline);
    };
    apply(bus.getStatus());
    return bus.subscribe(apply);
  }, []);

  // Capture beforeinstallprompt. The event is fired ONCE per page
  // load when Chromium decides the PWA criteria are met; we stash it
  // and surface our own UI. Calling preventDefault here suppresses the
  // browser's mini-infobar so we control the install UX.
  //
  // We also listen for `appinstalled` to know when the user has gone
  // through with the install — at that point we hide the banner and
  // never show it again this session.
  useEffect(() => {
    if (isStandalone()) return;
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPromptEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // iOS install hint visibility. Defer the show by a short delay so a
  // brand-new visitor doesn't see "install this app" before they've
  // even explored what the app does. Once visible it stays until
  // dismissed or until the user installs (at which point isStandalone
  // flips true and the check fails).
  useEffect(() => {
    if (iosHintDismissed) return;
    if (isStandalone()) return;
    if (!isIosSafari()) return;
    const t = setTimeout(() => setIosShowHint(true), 30_000);
    return () => clearTimeout(t);
  }, [iosHintDismissed]);

  function applyUpdate() {
    window.zkPwa?.applyUpdate();
  }

  async function doInstall() {
    if (!installPromptEvent) return;
    try {
      await installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      // Whether accepted or dismissed, the event can only be used
      // once. Clear our reference so the button hides.
      setInstallPromptEvent(null);
      if (choice.outcome === 'dismissed') {
        // User said no — remember so we don't pester. They can
        // still install later via the browser menu.
        try {
          localStorage.setItem(DISMISSED_INSTALL_KEY, '1');
        } catch {
          // localStorage unavailable — fine, just won't persist
        }
        setInstallDismissed(true);
      }
    } catch {
      // prompt() can throw if called twice or in invalid state.
      // We just clear the event reference and move on.
      setInstallPromptEvent(null);
    }
  }

  function dismissInstall() {
    setInstallPromptEvent(null);
    setInstallDismissed(true);
    try {
      localStorage.setItem(DISMISSED_INSTALL_KEY, '1');
    } catch {
      // ignore
    }
  }

  function dismissIosHint() {
    setIosShowHint(false);
    setIosHintDismissed(true);
    try {
      localStorage.setItem(DISMISSED_IOS_INSTALL_KEY, '1');
    } catch {
      // ignore
    }
  }

  // Nothing to show — render null so the layout doesn't reserve
  // space when there are no banners. Avoids a permanent gap.
  const showInstall = !!installPromptEvent && !installDismissed && !isStandalone();
  const showIosHint = iosShowHint && !iosHintDismissed && !isStandalone();
  if (!offline && !updateReady && !showInstall && !showIosHint) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {offline && (
        <div className="flex items-center justify-center gap-2 bg-red-600/95 backdrop-blur px-3 py-1.5 text-xs text-white">
          <WifiOff size={12} />
          <span>You're offline — messages will send when you reconnect.</span>
        </div>
      )}
      {updateReady && (
        <button
          type="button"
          onClick={applyUpdate}
          className="flex items-center justify-center gap-2 bg-accent hover:bg-accent/90 px-3 py-2 text-sm text-white transition-colors"
        >
          <RefreshCw size={13} />
          <span>A new version is available — tap to reload.</span>
        </button>
      )}
      {showInstall && (
        <div className="flex items-center gap-2 bg-bg-2/95 backdrop-blur border-b border-line px-3 py-2 text-sm">
          <Download size={13} className="text-accent shrink-0" />
          <span className="flex-1 min-w-0 text-ink-1 truncate">
            Install Zekktris for a better mobile experience
          </span>
          <button
            type="button"
            onClick={() => void doInstall()}
            className="px-3 py-1 rounded-md bg-accent hover:bg-accent/90 text-white text-xs shrink-0"
          >
            Install
          </button>
          <button
            type="button"
            onClick={dismissInstall}
            className="w-7 h-7 flex items-center justify-center text-ink-3 hover:text-ink-1 rounded-md shrink-0"
            aria-label="Dismiss install prompt"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {showIosHint && (
        <div className="flex items-center gap-2 bg-bg-2/95 backdrop-blur border-b border-line px-3 py-2 text-sm">
          <ShareSquare size={13} className="text-accent shrink-0" />
          <span className="flex-1 min-w-0 text-ink-1 leading-snug">
            Install: tap{' '}
            <ShareSquare size={12} className="inline align-middle text-accent" />
            {' '}then "Add to Home Screen"
          </span>
          <button
            type="button"
            onClick={dismissIosHint}
            className="w-7 h-7 flex items-center justify-center text-ink-3 hover:text-ink-1 rounded-md shrink-0"
            aria-label="Dismiss install hint"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
