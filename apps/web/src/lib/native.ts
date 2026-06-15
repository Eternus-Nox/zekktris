/**
 * Native bridge
 * -------------
 * Unified surface for capabilities that behave differently in
 * the Capacitor iOS shell vs the web browser. The rest of the
 * app imports from here so it doesn't have to care which
 * runtime it's executing in.
 *
 * Design notes:
 *
 * Lazy imports
 *   Every method that touches a Capacitor plugin does its own
 *   dynamic import. The web build doesn't have Capacitor in
 *   node_modules — or rather, it does, but the plugin code
 *   no-ops without a registered native bridge — and we don't
 *   want to bloat the web bundle with the iOS-only paths.
 *
 * Graceful fallbacks
 *   Each function works in both contexts. On web, calls resolve
 *   with sensible defaults (false for permission, no-op for
 *   side-effect methods). This lets callers stay platform-
 *   agnostic without having to wrap every call in
 *   `if (isNative()) {...}`.
 *
 * CallKit
 *   Capacitor has no first-party CallKit plugin. The
 *   `presentIncomingCall` / `endCall` paths register with a
 *   custom plugin name `ZekktrisCalls`. The iOS shell needs
 *   to provide a corresponding Swift class — see
 *   IOS_BUILD.md for the plugin skeleton.
 */

let _isNativeChecked = false;
let _isNativeCached = false;

/**
 * True when running inside the Capacitor native shell (iOS app),
 * false when running in a browser. Cached after first read.
 *
 * Detection: Capacitor exposes `window.Capacitor.isNativePlatform()`
 * on launch. We probe it once; subsequent calls hit the cache.
 */
export function isNative(): boolean {
  if (_isNativeChecked) return _isNativeCached;
  _isNativeChecked = true;
  try {
    const w = globalThis as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    };
    _isNativeCached = !!w.Capacitor?.isNativePlatform?.();
  } catch {
    _isNativeCached = false;
  }
  return _isNativeCached;
}

/**
 * Platform identifier: 'ios' / 'android' / 'web'. The app uses
 * this for platform-specific UX tweaks (e.g. swipe gestures
 * differ across iOS and Android web).
 */
export function getPlatform(): 'ios' | 'android' | 'web' {
  if (!isNative()) return 'web';
  try {
    const w = globalThis as unknown as {
      Capacitor?: { getPlatform?: () => string };
    };
    const p = w.Capacitor?.getPlatform?.();
    return p === 'ios' || p === 'android' ? p : 'web';
  } catch {
    return 'web';
  }
}

// ── Push notifications ──────────────────────────────────────────────────

/**
 * Request notification permission and register for push.
 * Web context falls through to the existing Notification API
 * + service worker subscription flow.
 *
 * On iOS, this triggers the system "Allow notifications?" prompt
 * AND registers with APNs. The native shell observes the
 * registration token and posts it via the `registration` event,
 * which the existing notification-subscription REST call picks
 * up and ships to the server.
 *
 * Returns 'granted' | 'denied' | 'prompt' — same contract as
 * the Web Notification API so callers can treat both paths
 * uniformly.
 */
export async function requestNotificationPermission(): Promise<
  'granted' | 'denied' | 'prompt'
> {
  if (!isNative()) {
    // Web fallback: use the standard Notification API.
    if (typeof Notification === 'undefined') return 'denied';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    const result = await Notification.requestPermission();
    // The Web Notification API uses 'default' for the initial
    // (un-prompted) state; normalize to our 'prompt' value so
    // callers don't have to handle both shapes.
    if (result === 'default') return 'prompt';
    return result;
  }
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const { receive } = await PushNotifications.requestPermissions();
    if (receive !== 'granted') return receive === 'denied' ? 'denied' : 'prompt';
    await PushNotifications.register();
    return 'granted';
  } catch {
    return 'denied';
  }
}

/**
 * Subscribe to the APNs token registration event. The callback
 * fires once per app launch (after register succeeds). The
 * token is the value the server sends to APNs to deliver pushes.
 *
 * Returns an unsubscribe function. Returns a no-op unsubscribe
 * on web.
 */
export async function onPushToken(
  callback: (token: string) => void,
): Promise<() => void> {
  if (!isNative()) return () => undefined;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const handle = await PushNotifications.addListener(
      'registration',
      (token) => {
        callback(token.value);
      },
    );
    return () => {
      void handle.remove();
    };
  } catch {
    return () => undefined;
  }
}

/**
 * Subscribe to push delivery events. Fires when a push arrives
 * while the app is open (foreground delivery). Background
 * deliveries are handled by the native shell directly and don't
 * route through the JS layer; tapping a backgrounded
 * notification fires the actionPerformed event below.
 */
export async function onPushReceived(
  callback: (data: Record<string, unknown>) => void,
): Promise<() => void> {
  if (!isNative()) return () => undefined;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const handle = await PushNotifications.addListener(
      'pushNotificationReceived',
      (n) => callback((n.data ?? {}) as Record<string, unknown>),
    );
    return () => {
      void handle.remove();
    };
  } catch {
    return () => undefined;
  }
}

/**
 * Subscribe to "user tapped the notification" events. Use the
 * routing payload (channelId, messageId) inside the data blob
 * to navigate to the relevant view.
 */
export async function onPushTapped(
  callback: (data: Record<string, unknown>) => void,
): Promise<() => void> {
  if (!isNative()) return () => undefined;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    const handle = await PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (a) =>
        callback(
          (a.notification.data ?? {}) as Record<string, unknown>,
        ),
    );
    return () => {
      void handle.remove();
    };
  } catch {
    return () => undefined;
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────

/**
 * Subscribe to foreground/background transitions. iOS fires
 * this when the user switches apps, the screen locks, or the
 * app is killed. The callback receives `true` for active,
 * `false` for inactive.
 */
export async function onAppStateChange(
  callback: (active: boolean) => void,
): Promise<() => void> {
  if (!isNative()) {
    // Web fallback: use the visibility API.
    const handler = () => {
      callback(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }
  try {
    const { App } = await import('@capacitor/app');
    const handle = await App.addListener('appStateChange', (state) => {
      callback(state.isActive);
    });
    return () => {
      void handle.remove();
    };
  } catch {
    return () => undefined;
  }
}

/**
 * Subscribe to deep-link opens — the custom `zekktris://…` scheme (registered
 * in the iOS scheme / Android intent-filter). Fires when the OS hands the app a
 * URL while it's running, and replays the launch URL once if the app was
 * cold-started from a link. The callback gets the raw URL; the caller maps it
 * to an in-app route. Returns an unsubscribe (no-op on web — browsers route
 * via the address bar / React Router directly).
 */
/** Module-level so the cold-start launch URL is replayed at most once per app
    launch, regardless of how many times onAppUrlOpen is (re)subscribed. */
let launchUrlConsumed = false;

export async function onAppUrlOpen(
  callback: (url: string) => void,
): Promise<() => void> {
  if (!isNative()) return () => undefined;
  try {
    const { App } = await import('@capacitor/app');
    const handle = await App.addListener('appUrlOpen', (event) => {
      if (event?.url) callback(event.url);
    });
    // Cold start: if a link launched the app before this listener attached,
    // replay it — but only ONCE per app process. The caller's effect can
    // re-run (e.g. on a token refresh remount), and replaying the stale launch
    // URL each time would yank the user back to the deep-linked screen.
    if (!launchUrlConsumed) {
      launchUrlConsumed = true;
      void App.getLaunchUrl()
        .then((res) => {
          if (res?.url) callback(res.url);
        })
        .catch(() => undefined);
    }
    return () => {
      void handle.remove();
    };
  } catch {
    return () => undefined;
  }
}

// ── CallKit (custom Swift plugin) ───────────────────────────────────────
//
// Capacitor has no first-party CallKit plugin. The iOS shell
// must provide a custom plugin class called `ZekktrisCalls`
// that exposes these JS-bridge methods:
//
//   presentIncomingCall(callId: string, callerName: string, hasVideo: boolean)
//   endCall(callId: string)
//   reportOutgoingCall(callId: string, calleeName: string)
//
// See IOS_BUILD.md for the Swift skeleton. With that in place,
// these functions trigger the system call UI (locked-screen
// answer screen, in-call audio routing, hardware mute toggle).
//
// Crucially, CallKit lets the audio session stay alive when the
// screen locks — the entire reason for the native shell.

interface CapacitorPluginsGlobal {
  Capacitor?: {
    Plugins?: {
      ZekktrisCalls?: {
        presentIncomingCall(opts: {
          callId: string;
          callerName: string;
          hasVideo: boolean;
        }): Promise<void>;
        endCall(opts: { callId: string }): Promise<void>;
        reportOutgoingCall(opts: {
          callId: string;
          calleeName: string;
        }): Promise<void>;
        addListener(
          eventName: 'callAnswered' | 'callEnded' | 'callReset',
          cb: (data: { callId?: string }) => void,
        ): Promise<{ remove: () => Promise<void> }>;
      };
    };
  };
}

function callKitPlugin() {
  if (!isNative()) return null;
  try {
    const w = globalThis as unknown as CapacitorPluginsGlobal;
    return w.Capacitor?.Plugins?.ZekktrisCalls ?? null;
  } catch {
    return null;
  }
}

/**
 * Present the system incoming-call UI. Called by the gateway's
 * incoming-call event handler. On a locked phone, this displays
 * the full-screen "swipe to answer" interface and rings the
 * phone — same as a regular phone call.
 *
 * On web (or iOS without the plugin installed), this is a no-op;
 * the existing in-app IncomingCallModal handles the UI instead.
 */
export async function presentIncomingCall(opts: {
  callId: string;
  callerName: string;
  hasVideo: boolean;
}): Promise<void> {
  const p = callKitPlugin();
  if (!p) return;
  try {
    await p.presentIncomingCall(opts);
  } catch {
    // Silently ignore — fall back to web UI.
  }
}

/**
 * Tell CallKit the call has ended (either user hung up, or the
 * other side did). Removes the system call UI and releases the
 * audio session.
 */
export async function endNativeCall(callId: string): Promise<void> {
  const p = callKitPlugin();
  if (!p) return;
  try {
    await p.endCall({ callId });
  } catch {
    // ignore
  }
}

/**
 * Notify CallKit that we're starting an outgoing call. Without
 * this, iOS won't grant the elevated audio session, and the mic
 * will mute when the screen locks. This is the whole point of
 * the native shell.
 */
export async function reportOutgoingCall(opts: {
  callId: string;
  calleeName: string;
}): Promise<void> {
  const p = callKitPlugin();
  if (!p) return;
  try {
    await p.reportOutgoingCall(opts);
  } catch {
    // ignore
  }
}

/**
 * Subscribe to the "user answered from the system call UI" event. The
 * ZekktrisCalls plugin fires `callAnswered` when the user swipes to answer
 * on the locked-screen CallKit screen (CXAnswerCallAction → notifyListeners
 * in the Swift plugin; see IOS_BUILD.md). The callback should join the
 * LiveKit room — i.e. run the same path the in-app Answer button takes.
 *
 * Returns an unsubscribe function; a no-op on web or when the plugin isn't
 * present. The event's `callId` is a padded-UUID form of the channel
 * snowflake, so callers already scoped to a single call (IncomingCallModal)
 * can ignore it.
 */
export async function onCallAnswered(
  callback: (callId: string | undefined) => void,
): Promise<() => void> {
  const p = callKitPlugin();
  if (!p) return () => undefined;
  try {
    const handle = await p.addListener('callAnswered', (data) => {
      callback(data?.callId);
    });
    return () => {
      void handle.remove();
    };
  } catch {
    return () => undefined;
  }
}

// ── Status bar / splash ─────────────────────────────────────────────────

/**
 * Hide the launch splash screen. Called from main.tsx once the
 * React tree has mounted and the initial auth/gateway bootstrap
 * has resolved.
 */
export async function hideSplash(): Promise<void> {
  if (!isNative()) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    // ignore — splash may already be hidden
  }
}

/**
 * Apply the iOS status bar style to match the app theme. The
 * app's primary background is the deep navy #050a18, so we want
 * a LIGHT status bar (white text) over it.
 */
export async function configureStatusBar(): Promise<void> {
  if (!isNative()) return;
  // Delegate to applyNativeTheme so the bar matches the stored theme on boot
  // (dynamic import avoids a static import cycle with theme.ts).
  try {
    const { getStoredTheme, THEMES } = await import('./theme');
    const t = THEMES.find((x) => x.id === getStoredTheme()) ?? THEMES[0];
    await applyNativeTheme({ id: t.id, bg: t.bg });
  } catch {
    // ignore
  }
}

/**
 * Apply theme-dependent native chrome on the Capacitor iOS shell:
 *   - tint the status bar background to the theme's surface color;
 *   - switch the home-screen app icon to the matching alternate icon, IF the
 *     @capacitor-community/app-icon plugin is installed and the icon names are
 *     declared in Info.plist (CFBundleAlternateIcons). See
 *     apps/web/ios-icons/README.md. No-op otherwise.
 * Safe no-op on web.
 */
export async function applyNativeTheme(theme: { id: string; bg: string }): Promise<void> {
  if (!isNative()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: theme.bg });
  } catch {
    // ignore — status-bar plugin unavailable
  }
  try {
    // Specifier kept in a variable + @vite-ignore so the web build doesn't try
    // to resolve this optional native-only plugin. iOS alternate-icon names
    // match the theme id; 'default' restores the primary icon (name: null).
    const pkg = '@capacitor-community/app-icon';
    const mod: { AppIcon?: { change: (o: { name: string | null; suppressNotification?: boolean }) => Promise<unknown> } } | null =
      await import(/* @vite-ignore */ pkg).catch(() => null);
    if (mod?.AppIcon) {
      await mod.AppIcon.change({
        name: theme.id === 'default' ? null : theme.id,
        suppressNotification: true,
      });
    }
  } catch {
    // ignore — plugin not installed, or icon name not declared in Info.plist
  }
}

/**
 * Keyboard behavior for the iOS shell.
 *
 * The composer is docked at the bottom of a full-height flex column, and
 * Capacitor's `resize: 'native'` already shrinks the WKWebView frame when
 * the keyboard opens — so the composer lifts above the keyboard without
 * anyone needing to scroll. But WKWebView ALSO auto-scrolls its own
 * scrollView to bring the focused input into view, on top of the resize.
 * That extra scroll offset isn't fully restored when the keyboard closes,
 * which is what makes "the whole app drag down" after dismissing the
 * input.
 *
 * Fix:
 *   1. `setScroll({ isDisabled: true })` — stop WKWebView from scrolling
 *      its content on focus. The native resize already makes room, so the
 *      auto-scroll is redundant and is the thing that leaves an offset.
 *   2. On keyboard hide, snap the document scroll back to 0 — a belt-and-
 *      suspenders reset so any residual offset (from rotation, fast
 *      focus-blur, etc.) can't leave the UI shifted.
 *   3. Hide the input accessory bar (the grey "Done" toolbar) — it's not
 *      used and adds height that compounds the shift.
 *
 * Safe no-op on web.
 */
export async function configureKeyboard(): Promise<void> {
  if (!isNative()) return;
  try {
    const { Keyboard } = await import('@capacitor/keyboard');
    // The native resize handles making room; disable the redundant
    // content scroll that leaves an offset behind on dismiss.
    await Keyboard.setScroll({ isDisabled: true }).catch(() => undefined);
    await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);

    const snapScrollToTop = () => {
      // The document itself should never hold a scroll offset (only inner
      // containers scroll), so forcing it to 0 on keyboard close undoes any
      // drag without affecting the message list's own scroll position.
      try {
        window.scrollTo(0, 0);
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      } catch {
        // ignore
      }
    };
    // Mark the document while the keyboard is up. With `resize: 'native'`
    // the WebView frame shrinks, so anything pinned to the bottom of the
    // (now shorter) viewport — like the guild rail's Settings/Sign-out
    // cluster — rises with the keyboard. CSS keyed on `.zk-keyboard-open`
    // hides that cluster while typing (you don't need it mid-message) and
    // restores it on dismiss, so it no longer floats up over the keyboard.
    await Keyboard.addListener('keyboardWillShow', () => {
      document.body.classList.add('zk-keyboard-open');
    });
    // Reset as the keyboard begins to retract (avoids the visible drag
    // during the close animation) and again once it's fully hidden.
    await Keyboard.addListener('keyboardWillHide', () => {
      document.body.classList.remove('zk-keyboard-open');
      snapScrollToTop();
    });
    await Keyboard.addListener('keyboardDidHide', snapScrollToTop);
  } catch {
    // ignore — keyboard plugin unavailable
  }
}
