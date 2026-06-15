import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  isNative,
  getPlatform,
  requestNotificationPermission,
  onPushToken,
  onPushTapped,
  onAppUrlOpen,
} from '../lib/native';

/**
 * Native push bootstrap (iOS = APNs, Android = FCM). On the Capacitor app,
 * once the user is authenticated, request notification permission, register for
 * push, and ship the device token to the server tagged with the platform. Also
 * routes notification taps to the relevant in-app location.
 *
 * No-op on the web build — browsers/PWAs use Web Push, wired separately in
 * Settings. Safe to mount once near the authenticated app root; it guards
 * against double-init and tears its listeners down on unmount/sign-out.
 */
export function useNativePush(): void {
  const { token, rest } = useAuth();
  const navigate = useNavigate();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!isNative()) return;
    if (!token) return; // only once authenticated (token-bound REST call)
    if (startedRef.current) return;
    startedRef.current = true;

    const cleanups: Array<() => void> = [];
    let active = true;

    void (async () => {
      // Wire the token listener BEFORE requesting/registering so the
      // registration event can't fire before we're listening for it.
      const offToken = await onPushToken((deviceToken) => {
        // Capacitor's push plugin yields an APNs token on iOS and an FCM
        // registration token on Android; tag it so the server delivers via the
        // right transport (services/apns.ts vs services/fcm.ts).
        const platform = getPlatform() === 'android' ? 'android' : 'ios';
        void rest
          .registerDeviceToken({
            token: deviceToken,
            platform,
            label: detectDeviceLabel(),
          })
          .catch(() => {
            // Server may lack APNs/FCM config (503) or be briefly unreachable —
            // non-fatal; the token re-registers on the next launch.
          });
      });
      if (!active) {
        offToken();
        return;
      }
      cleanups.push(offToken);

      const offTap = await onPushTapped((data) => {
        routeFromPush(navigate, data);
      });
      if (!active) {
        offTap();
        return;
      }
      cleanups.push(offTap);

      // Deep links: a zekktris:// link (or cold-start launch URL) routes into
      // the SPA, same path-safety as a notification tap.
      const offUrl = await onAppUrlOpen((url) => {
        navigateToTarget(navigate, url);
      });
      if (!active) {
        offUrl();
        return;
      }
      cleanups.push(offUrl);

      // Requests permission (shows the iOS prompt only the first time) and,
      // when granted, registers with APNs → fires the token listener above.
      await requestNotificationPermission();
    })();

    return () => {
      active = false;
      for (const fn of cleanups) fn();
      // Allow a clean re-init if this remounts under a new session.
      startedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
}

/**
 * Pull a routing path out of a push data blob and navigate to it. The server
 * puts the in-app path on `data.url` (e.g. "/channels/123/456").
 */
function routeFromPush(
  navigate: (to: string) => void,
  data: Record<string, unknown>,
): void {
  const raw = typeof data.url === 'string' ? data.url : null;
  if (raw) navigateToTarget(navigate, raw);
}

/**
 * Map a raw target — an in-app path, an `https://<host>/path`, or a custom
 * `zekktris://…` deep link — to a safe in-app route and navigate. We route by
 * PATH only: a single-slash absolute path. Protocol-relative ("//host",
 * "/\\host") and off-app values are rejected, so a crafted link can't bounce
 * the WebView off-app. Mirrors the ?next= hardening in AuthScreens.tsx.
 */
function navigateToTarget(navigate: (to: string) => void, raw: string): void {
  if (!raw) return;
  try {
    let path: string;
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      path = u.pathname + u.search;
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      // Custom scheme (zekktris://…): strip "scheme://" and treat the remainder
      // as the in-app path, normalizing to exactly one leading slash. Handles
      // both zekktris://channels/x and zekktris:///channels/x.
      const afterScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      path = '/' + afterScheme.replace(/^\/+/, '');
    } else {
      path = raw; // already a path
    }
    if (path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')) {
      navigate(path);
    }
  } catch {
    /* malformed url — ignore */
  }
}

/** Best-effort device label for the manage-devices list. */
function detectDeviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (getPlatform() === 'android' || /Android/.test(ua)) return 'Android device';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  return 'iOS device';
}
