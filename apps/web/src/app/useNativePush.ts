import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  isNative,
  requestNotificationPermission,
  onPushToken,
  onPushTapped,
} from '../lib/native';

/**
 * Native iOS push bootstrap. On the Capacitor app, once the user is
 * authenticated, request notification permission, register with APNs, and
 * ship the device token to the server. Also routes notification taps to the
 * relevant in-app location.
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
        void rest
          .registerDeviceToken({
            token: deviceToken,
            platform: 'ios',
            label: detectIosLabel(),
          })
          .catch(() => {
            // Server may lack APNs config (503) or be briefly unreachable —
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
 * puts the in-app path on `data.url` (e.g. "/channels/123/456"). We route by
 * pathname only, so a malicious/absolute URL can't bounce the SPA off-app.
 */
function routeFromPush(
  navigate: (to: string) => void,
  data: Record<string, unknown>,
): void {
  const raw = typeof data.url === 'string' ? data.url : null;
  if (!raw) return;
  try {
    let path = raw;
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      path = u.pathname + u.search;
    }
    // Require a single-slash absolute path. Reject protocol-relative
    // ("//host", "/\\host") and backslash-prefixed values, which some
    // browsers treat as protocol-relative and would bounce the WKWebView
    // off-app. Mirrors the ?next= hardening in AuthScreens.tsx.
    if (path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')) {
      navigate(path);
    }
  } catch {
    /* malformed url — ignore */
  }
}

/** Best-effort device label for the manage-devices list. */
function detectIosLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  return 'iOS device';
}
