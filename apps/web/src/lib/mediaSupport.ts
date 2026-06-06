/**
 * Media-capture capability probing & diagnostics
 * ----------------------------------------------
 * Every voice/video/voice-message path ultimately calls
 * `navigator.mediaDevices.getUserMedia`. In a normal browser over https
 * that object always exists. Inside the iOS Capacitor shell (WKWebView)
 * it does NOT always exist:
 *
 *   - `navigator.mediaDevices` is only exposed in a *secure context*
 *     (https or localhost). A cleartext dev origin hides it entirely.
 *   - Even over https, the iOS *Simulator* frequently does not provide a
 *     working capture stack — `mediaDevices` can be undefined or capture
 *     fails. Voice capture is only reliable on a physical iPhone.
 *
 * When the object is missing and code calls `mediaDevices.getUserMedia`
 * blindly, WebKit throws a bare `TypeError`:
 *   "undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')"
 * which is what users were seeing — cryptic and undiagnosable from a
 * screenshot.
 *
 * This module centralizes (a) the availability check every call site
 * should run first, (b) a native-aware, user-facing explanation, and
 * (c) a compact one-line environment snapshot appended to that message
 * AND logged to the console — so a single screenshot of the error tells
 * us exactly which case it is (insecure origin vs. WebView/iOS limit vs.
 * simulator) without needing a Mac + Safari Web Inspector.
 */

import { isNative } from './native';

/**
 * True when the platform exposes the WebRTC capture API we need to start
 * a microphone or camera. Call this BEFORE touching
 * `navigator.mediaDevices.getUserMedia` so a missing API surfaces as a
 * clear message instead of a raw TypeError crash.
 */
export function isMediaCaptureAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

function safeIsNative(): boolean {
  try {
    return isNative();
  } catch {
    return false;
  }
}

/**
 * A compact, copy-pasteable snapshot of the capture environment. Safe to
 * show to users (no secrets) and the single most useful thing for
 * diagnosing "the mic doesn't work" remotely: it states whether the
 * context is secure, whether we're in the native shell, and exactly which
 * capture APIs are present.
 */
export function describeMediaEnvironment(): string {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return 'env: no window/navigator';
  }
  const md = navigator.mediaDevices as MediaDevices | undefined;
  return [
    `secure=${window.isSecureContext}`,
    `proto=${window.location.protocol}`,
    `native=${safeIsNative()}`,
    `mediaDevices=${md ? 'present' : 'undefined'}`,
    `getUserMedia=${md && typeof md.getUserMedia === 'function' ? 'present' : 'undefined'}`,
    `enumerateDevices=${md && typeof md.enumerateDevices === 'function' ? 'present' : 'undefined'}`,
  ].join(' ');
}

/**
 * Native-aware, user-facing explanation for why mic/camera capture isn't
 * available, with the environment snapshot appended in brackets. Logged
 * to the console too so it's captured even if the toast is dismissed.
 */
export function mediaUnavailableMessage(): string {
  const env = describeMediaEnvironment();
  // eslint-disable-next-line no-console
  console.error('[media] capture API unavailable —', env);

  const insecure = typeof window !== 'undefined' && !window.isSecureContext;
  if (insecure) {
    return (
      'Voice needs a secure (https) connection — the microphone API is ' +
      'hidden on plain HTTP. ' +
      (safeIsNative()
        ? 'Make sure server.url in capacitor.config.ts points at your https:// ' +
          'site, then run `npx cap sync ios` and rebuild. '
        : 'Open the site over https (or localhost) and try again. ') +
      `[${env}]`
    );
  }
  if (safeIsNative()) {
    return (
      "This app's WebView isn't exposing the microphone. The usual cause on " +
      'iOS is a missing microphone permission in the app build: if ' +
      'Settings → (this app) shows no Microphone toggle, the build is ' +
      'missing the NSMicrophoneUsageDescription key, which makes iOS hide ' +
      'the mic API from the WebView. (The site still works in Safari — that ' +
      "doesn't prove the app is configured.) On the iOS Simulator, mic " +
      'capture is unavailable regardless — use a real device. ' +
      `[${env}]`
    );
  }
  return (
    "Your browser didn't expose the microphone API (navigator.mediaDevices " +
    'is unavailable). This usually means an insecure context or an ' +
    `unsupported browser. [${env}]`
  );
}
