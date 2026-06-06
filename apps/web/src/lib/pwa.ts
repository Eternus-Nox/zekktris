/**
 * usePwaInstall
 * -------------
 * Wraps the browser's `beforeinstallprompt` event so React components
 * can offer an "Install Zekktris" affordance when the platform supports
 * it (Chrome/Edge on Android + desktop). On iOS Safari the event isn't
 * fired — Apple requires the user to use Share → Add to Home Screen
 * manually — so the hook also detects the iOS-without-standalone case
 * and reports it as a different `mode` value, letting the UI show
 * platform-appropriate instructions.
 *
 * State machine:
 *   - `unavailable`  : not installable from this browser AND not iOS
 *                      (e.g. desktop Firefox, Safari on macOS)
 *   - `ios-pending`  : on an iOS device + not yet installed; show
 *                      manual instructions
 *   - `available`    : Chrome/Edge captured a beforeinstallprompt and
 *                      we can call promptInstall() to show the native
 *                      install dialog
 *   - `installed`    : already running in standalone mode
 *
 * Lifecycle: the beforeinstallprompt event fires at most once per page
 * load (and only in supported browsers). We capture it, suppress the
 * default banner, and stash the event so the UI can re-fire it on
 * demand. After the user accepts/dismisses, the event is consumed
 * and we move to `installed` or back to `unavailable` accordingly.
 */
import { useCallback, useEffect, useState } from 'react';
import { isNative } from './native';

type Mode = 'unavailable' | 'ios-pending' | 'available' | 'installed';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // Standard CSS media query — works everywhere modern.
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // iOS-specific: navigator.standalone is true when launched from home
  // screen. Not standardised but the only reliable iOS check.
  const navStandalone = (window.navigator as Navigator & { standalone?: boolean })
    .standalone;
  return navStandalone === true;
}

function detectIos(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  // iPhone, iPad (legacy UA), iPod. Newer iPads identify as Mac with
  // touch support; we include that case as iOS for installability
  // purposes since the install affordance is the same.
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

export function usePwaInstall() {
  const [mode, setMode] = useState<Mode>(() => {
    // The native Capacitor app IS the installed app — never offer install
    // or "Add to Home Screen" affordances inside it.
    if (isNative()) return 'installed';
    if (detectStandalone()) return 'installed';
    if (detectIos()) return 'ios-pending';
    return 'unavailable';
  });
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    function onBeforeInstall(e: Event) {
      // Stash the event and surface our own UI; without preventDefault
      // some browsers show a browser-rendered install banner that we
      // want to replace with a contextual prompt.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setMode('available');
    }
    function onInstalled() {
      setMode('installed');
      setDeferredPrompt(null);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable';
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    // The event can only be used once per capture; null it out so the
    // next prompt requires a fresh beforeinstallprompt firing.
    setDeferredPrompt(null);
    if (choice.outcome === 'accepted') {
      setMode('installed');
    } else {
      // User dismissed — go back to "unavailable" since we can't
      // re-trigger from JS until the browser fires the event again
      // (which won't happen in this session typically).
      setMode('unavailable');
    }
    return choice.outcome;
  }, [deferredPrompt]);

  return { mode, promptInstall };
}

/**
 * useOnlineStatus
 * ---------------
 * Reflects navigator.onLine into React state. Useful for showing an
 * "offline" banner so users don't think the app is broken when their
 * connection drops. We listen for online/offline events; the initial
 * value uses `navigator.onLine` which is reliably correct at mount.
 *
 * Caveat: navigator.onLine reports the OS-level connectivity, not
 * whether the API server is reachable. A user can be "online" while
 * the gateway connection is severed (proxy issue, server down). The
 * app's own gateway connection-state indicator (separate component)
 * reflects that more accurately; this hook is the cheap win for
 * losing wifi entirely.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.navigator.onLine,
  );
  useEffect(() => {
    function on() {
      setOnline(true);
    }
    function off() {
      setOnline(false);
    }
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
