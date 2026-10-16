import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import { migrateLegacyStorageKeys } from './lib/storageMigration';
// Run the one-shot commune.*→zekktris.* localStorage migration before
// any module loads its prefs/auth state. Auth, voice prefs, device
// selection, guild folders all read at module-construction time
// (synchronously, before useEffects fire), so the migration has to
// happen before those imports resolve.
migrateLegacyStorageKeys();
import { initTheme } from './lib/theme';
// Apply the saved theme to <html> before React renders, so there's no flash
// of the default palette on load.
initTheme();
import { App } from './App';
import { configureStatusBar, configureKeyboard, hideSplash, isNative } from './lib/native';
import { initKeyboardInset } from './lib/keyboardInset';

// Track the on-screen keyboard on ALL platforms (web + Capacitor webview) so
// the composer can drop its home-indicator padding while typing — closes the
// "textbox floats above the keyboard" gap on web mobile.
initKeyboardInset();

// Native shell setup. Both calls no-op on web (where there's no
// Capacitor runtime) so they're safe unconditionally. Order:
//   1. configureStatusBar — paint the system bar matching app
//      palette before the splash hides, so the transition is
//      seamless rather than flashing the iOS default light bar.
//   2. configureKeyboard — disable WKWebView's redundant focus-scroll
//      and reset document scroll on keyboard close, so dismissing the
//      composer doesn't drag the whole app down.
//   3. hideSplash — fired AFTER React mounts + paints (next tick
//      via setTimeout 0) so users see the rendered UI, not an
//      empty navy frame between splash and first render.
if (isNative()) {
  void configureStatusBar();
  void configureKeyboard();
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

// Hide the native splash after React mounts. The setTimeout 0 yields
// to the browser so first paint happens before we dismiss the splash;
// otherwise the user briefly sees the gap between the bundled splash
// PNG and the live React tree.
if (isNative()) {
  setTimeout(() => void hideSplash(), 0);
}

// ── Resize transition kill ──────────────────────────────────────────────────
//
// While the user drags the window edge to resize, the browser fires
// `resize` events continuously. Any CSS `transition-*` rule on an
// element that moves or recolors then animates each layout shift
// over ~150-300ms — and the trailing edge of those transitions
// keeps animating for one full duration AFTER the user stops
// dragging, producing the "drag continues after I stop" effect.
//
// We mark `<body>` with `.is-resizing` on the first resize event
// and remove it 120ms after the last event. The matching CSS rule
// in index.css overrides every transition-duration to 0 while the
// class is present — so layout snaps instantly during resize and
// returns to its normal animated behavior once the user releases.
//
// 120ms is the smallest debounce that doesn't cause flicker on
// fast drags; the trailing transitions on a desktop browser are
// typically <100ms so we want to outlast them but not so long that
// the class lingers visibly after the drag ends.
{
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener(
    'resize',
    () => {
      if (resizeTimer === undefined) {
        document.body.classList.add('is-resizing');
      } else {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(() => {
        document.body.classList.remove('is-resizing');
        resizeTimer = undefined;
      }, 120);
    },
    { passive: true },
  );
}

// ── PWA status bus ────────────────────────────────────────────────────────
//
// The SW registration code below detects "an update is ready" and the
// offline event listener detects connectivity. Both write to this tiny
// pub-sub so the React tree can subscribe via the usePwaStatus hook
// and render banners (PwaBanners.tsx) without needing to thread refs
// or context through the SW callbacks.
type PwaStatus = {
  updateReady: boolean;
  offline: boolean;
};
type PwaListener = (s: PwaStatus) => void;
const pwaState: PwaStatus = { updateReady: false, offline: !navigator.onLine };
const pwaListeners = new Set<PwaListener>();
function emitPwa() {
  for (const fn of pwaListeners) {
    try {
      fn(pwaState);
    } catch {
      // listener errors shouldn't block the rest
    }
  }
}
function setPwaState(patch: Partial<PwaStatus>) {
  Object.assign(pwaState, patch);
  emitPwa();
}
// Surface the bus on window so React modules can pick it up without
// importing from main.tsx (which would create a cycle). Typed via the
// global augmentation below.
declare global {
  interface Window {
    zkPwa: {
      getStatus: () => PwaStatus;
      subscribe: (fn: PwaListener) => () => void;
      applyUpdate: () => void;
    };
  }
}
window.zkPwa = {
  getStatus: () => ({ ...pwaState }),
  subscribe: (fn) => {
    pwaListeners.add(fn);
    return () => {
      pwaListeners.delete(fn);
    };
  },
  // Called when the user taps "Update" in the banner. Tells the
  // waiting SW to skipWaiting; the controllerchange listener below
  // does the reload after the new SW takes control.
  applyUpdate: () => {
    void navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (reg?.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      })
      .catch(() => undefined);
  },
};

window.addEventListener('online', () => setPwaState({ offline: false }));
window.addEventListener('offline', () => setPwaState({ offline: true }));

// ── Service worker registration ──────────────────────────────────────────────
//
// We register the SW unconditionally on production builds. In dev (Vite
// serve) we DON'T register — Vite's HMR doesn't play well with a
// caching SW, and the SW would intercept module requests in confusing
// ways. The check uses import.meta.env.PROD which is replaced at build
// time by Vite, so the dev branch tree-shakes out of production
// bundles entirely.
//
// Why register here rather than inside an authenticated component:
//   - Push notifications still register their own subscription via
//     `swReg.pushManager.subscribe()` inside SettingsModal, but the
//     SW itself needs to be active before the user even logs in so
//     the offline shell works at the login screen too.
//   - Registering here is idempotent — if the user later flips the
//     push toggle, the registration call there finds the existing
//     SW rather than creating a duplicate.
//
// Update flow (changed in v1.67): the SW's `install` step bumps the
// cache name (build version stamped at build time). When a new build's
// SW finishes installing, we set updateReady=true on the PWA status
// bus — a non-disruptive banner appears in the UI inviting the user
// to refresh when they're ready. We DON'T auto-reload anymore
// (previous behavior could nuke a half-typed message).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        // Reload exactly once when the new SW takes control after
        // the user explicitly applies the update. controllerchange
        // also fires on first install (no existing controller) — we
        // gate by updateReady so the first-install case doesn't
        // trigger an unnecessary reload.
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!pwaState.updateReady) return;
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
        });

        // Surface "update ready" when a new SW finishes installing
        // and there's already a controller (= this is an update,
        // not the first install).
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          if (!newSW) return;
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              setPwaState({ updateReady: true });
            }
          });
        });

        // On registration, if there's ALREADY a waiting SW (e.g. the
        // user opened the app while a new build was waiting from a
        // previous session), surface the banner immediately.
        if (reg.waiting && navigator.serviceWorker.controller) {
          setPwaState({ updateReady: true });
        }
      })
      .catch((err) => {
        // SW registration failures shouldn't block the app from
        // running — log and continue. Common causes: served over
        // HTTP without secure context (dev/local), or the file
        // 404'd because the build artifact wasn't deployed.
        console.warn('[sw] registration failed', err);
      });

    // Listen for messages from the SW (notification interactions).
    //
    //   NAVIGATE     — sent on a notification body tap or Answer action;
    //                  routes the URL through History so React Router
    //                  picks it up without a hard reload.
    //
    // A notification's Decline action is handled entirely in the SW
    // (signed per-call token → POST /call-decline); no page round-trip.
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'NAVIGATE' && typeof event.data.url === 'string') {
        try {
          const url = new URL(event.data.url, window.location.origin);
          // pushState fires "popstate" listeners that React Router
          // observes when configured with BrowserRouter.
          window.history.pushState({}, '', url.pathname + url.search + url.hash);
          window.dispatchEvent(new PopStateEvent('popstate'));
        } catch {
          // Bad URL — ignore.
        }
      }
    });
  });
}
