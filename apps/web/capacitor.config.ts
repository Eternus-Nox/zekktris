/// <reference types="@capacitor/cli" />

/**
 * Capacitor configuration
 * -----------------------
 * Controls how the native iOS shell wraps the web app.
 *
 * appId       — reverse-DNS bundle identifier. Must be unique on
 *               the App Store; matches what you'll set in Xcode's
 *               Signing & Capabilities. Change this to your own
 *               domain before submitting to TestFlight.
 *
 * appName     — display name shown under the home-screen icon and
 *               in the App Store listing.
 *
 * webDir      — directory the Capacitor CLI bundles into the
 *               native shell. Vite's build output is `dist`; we
 *               point Capacitor at the same directory so
 *               `pnpm build && npx cap sync ios` ships the latest
 *               compiled web app to the native project.
 *
 * server      — for development, you can point `server.url` at the
 *               Vite dev server (e.g. http://192.168.1.x:5173) to
 *               get HMR inside the iOS simulator. Production builds
 *               omit this and load the bundled assets. See
 *               IOS_BUILD.md for the toggle.
 *
 * ios         — native-platform settings:
 *                - scheme: URL scheme for deep links (zekktris://...)
 *                - backgroundColor: matches the app's #050a18 navy
 *                  so the splash → app transition is invisible
 *                - contentInset: scroll behavior under the notch
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zekktris.app',
  appName: 'Zekktris',
  webDir: 'dist',
  server: {
    // The iOS app is a thin native shell: it loads the live web app
    // from the production origin, exactly like the desktop shell does.
    // This is REQUIRED — the web app talks to a relative `/api/v1` and a
    // same-origin gateway (wss://<host>/gateway), so the WebView must be
    // served from that origin for networking to resolve. Bundling the
    // local `dist` (capacitor://localhost) would break every API call.
    //
    // Point this at your own deployment before shipping.
    //
    // For local dev with HMR in the simulator, override with your Vite
    // dev server instead, e.g.:
    //   url: 'http://192.168.1.10:5173',
    //   cleartext: true,
    url: 'https://zekktris.com',
  },
  ios: {
    scheme: 'zekktris',
    backgroundColor: '#050a18',
    // Don't inset under the status bar — we paint our own header.
    // 'automatic' lets iOS adjust for the notch on supported devices.
    contentInset: 'automatic',
    // Inline media playback (don't open YouTube/Spotify embeds in
    // a separate Safari sheet).
    allowsLinkPreview: false,
  },
  plugins: {
    SplashScreen: {
      // The launch screen is now a plain navy (#050a18) screen with no
      // logo (see apps/web/ios-launch/LaunchScreen.storyboard) — it blends
      // into the app's own navy background, so there's effectively no
      // visible "splash". We still hide it fast: launchAutoHide dismisses
      // it after launchShowDuration as a backstop, and main.tsx calls
      // SplashScreen.hide() the moment React paints. Because the WebView
      // background is also navy (ios.backgroundColor below / above), the
      // whole launch -> load -> app sequence is one continuous navy with no
      // white flash and no logo flash.
      launchShowDuration: 600,
      launchAutoHide: true,
      launchFadeOutDuration: 200,
      backgroundColor: '#050a18',
      androidSplashResourceName: 'splash',
    },
    PushNotifications: {
      // Request permission lazily — only when the user enables
      // notifications in settings, never on first launch (which
      // would create an immediate "Allow notifications?" prompt
      // before the user has seen the app).
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Keyboard: {
      // 'native' resize: WKWebView resizes its OWN frame when the keyboard
      // shows, so a bottom-docked composer is lifted above the keyboard
      // instead of being covered by it. 'body' only shrinks document.body,
      // which a flex/sticky composer doesn't reliably follow on iOS — that
      // was leaving the input hidden behind the keyboard.
      resize: 'native' as const,
      style: 'DARK' as const,
    },
  },
};

export default config;
