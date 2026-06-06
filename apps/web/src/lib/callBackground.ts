/**
 * Voice call background-stay-alive
 * --------------------------------
 * Mobile browsers suspend a page's JS/audio aggressively when the
 * screen locks or the user backgrounds the PWA. For voice calls
 * this means the mic stops working mid-conversation — a fatal UX
 * issue.
 *
 * Three mechanisms used together work around it as far as the
 * platforms allow:
 *
 *  1. Screen Wake Lock API. Asks the OS not to auto-lock the
 *     screen. The screen stays on, the page stays foregrounded,
 *     audio + WebRTC stay alive. The user can still manually
 *     press the power button to lock — at that point we lose
 *     the call on iOS (no API allows third-party PWAs to capture
 *     mic while locked) but can sometimes survive on Android
 *     with media-session help.
 *
 *  2. Media Session API. Sets "Now Playing" metadata so the OS
 *     treats the page as an active audio source. Surfaces lock-
 *     screen / Bluetooth media controls and signals to platform
 *     foreground-killer heuristics that this page is doing
 *     something the user cares about.
 *
 *  3. visibilitychange listener. Wake Lock is auto-released when
 *     the page becomes hidden. When the user comes back, we
 *     reacquire so subsequent lock attempts get blocked again.
 *
 * iOS Safari supports Wake Lock as of 16.4 and Media Session
 * since 15+. Android Chrome has supported both for years. Older
 * browsers gracefully skip everything (every API call is feature-
 * detected and try/catch-wrapped).
 *
 * Public API: enterCallBackgroundMode(opts) and
 * exitCallBackgroundMode(). The voice connect path calls enter on
 * a successful join; disconnectVoice calls exit on teardown. Both
 * are idempotent + tolerate being called when the underlying APIs
 * aren't supported.
 */

interface WakeLockSentinel {
  readonly released: boolean;
  release: () => Promise<void>;
  addEventListener: (
    event: 'release',
    handler: () => void,
  ) => void;
}

interface WakeLockAPI {
  request: (type: 'screen') => Promise<WakeLockSentinel>;
}

let currentSentinel: WakeLockSentinel | null = null;
let active = false;
let visibilityHandler: (() => void) | null = null;
// Last-known metadata so we can recreate it on visibility return.
let lastMeta: { title: string; artist?: string } | null = null;

function getWakeLock(): WakeLockAPI | null {
  // Bracket access — TS doesn't ship lib types for navigator.wakeLock
  // in all versions, and this avoids the resulting type complaints
  // without us having to declare a global ambient.
  const nav = navigator as Navigator & { wakeLock?: WakeLockAPI };
  return nav.wakeLock ?? null;
}

async function acquireWakeLock(): Promise<void> {
  const api = getWakeLock();
  if (!api) return;
  // Already have one, no-op. The sentinel's `released` flag flips
  // true when the OS auto-releases (page hidden); a still-held
  // sentinel is reusable.
  if (currentSentinel && !currentSentinel.released) return;
  try {
    currentSentinel = await api.request('screen');
    currentSentinel.addEventListener('release', () => {
      // OS released our lock (typically because the page went
      // hidden). Drop the reference; visibilitychange handler
      // re-acquires when the page returns.
      currentSentinel = null;
    });
  } catch {
    // Permission denied / unsupported / page not visible.
    // Non-fatal — the call still works, just won't survive a
    // screen-off.
    currentSentinel = null;
  }
}

async function releaseWakeLock(): Promise<void> {
  if (!currentSentinel) return;
  try {
    await currentSentinel.release();
  } catch {
    // ignore
  }
  currentSentinel = null;
}

function setMediaSessionMetadata(title: string, artist?: string): void {
  // Bracket access — mediaSession's type narrowing is conservative
  // and complains about MediaMetadata constructor in some env types.
  const nav = navigator as Navigator & {
    mediaSession?: {
      metadata: unknown;
      playbackState?: string;
      setActionHandler?: (
        action: string,
        handler: (() => void) | null,
      ) => void;
    };
  };
  if (!nav.mediaSession) return;
  try {
    const MM = (window as unknown as {
      MediaMetadata?: new (init: {
        title: string;
        artist?: string;
        album?: string;
        artwork?: Array<{ src: string; sizes?: string; type?: string }>;
      }) => unknown;
    }).MediaMetadata;
    if (!MM) return;
    nav.mediaSession.metadata = new MM({
      title,
      artist: artist ?? 'Zekktris',
      album: 'Voice call',
      artwork: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    }) as MediaMetadata;
    if (typeof nav.mediaSession.playbackState !== 'undefined') {
      nav.mediaSession.playbackState = 'playing';
    }
  } catch {
    // ignore — media session is a polish layer, not load-bearing
  }
}

function clearMediaSessionMetadata(): void {
  const nav = navigator as Navigator & {
    mediaSession?: {
      metadata: unknown;
      playbackState?: string;
      setActionHandler?: (
        action: string,
        handler: (() => void) | null,
      ) => void;
    };
  };
  if (!nav.mediaSession) return;
  try {
    nav.mediaSession.metadata = null;
    if (typeof nav.mediaSession.playbackState !== 'undefined') {
      nav.mediaSession.playbackState = 'none';
    }
    // Best-effort: clear all action handlers so any registered hangup
    // button doesn't linger on the lock screen after the call ends.
    for (const action of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto', 'hangup'] as const) {
      try {
        nav.mediaSession.setActionHandler?.(action, null);
      } catch {
        // not all action names supported in all browsers
      }
    }
  } catch {
    // ignore
  }
}

function setHangupHandler(handler: () => void): void {
  const nav = navigator as Navigator & {
    mediaSession?: {
      setActionHandler?: (
        action: string,
        handler: (() => void) | null,
      ) => void;
    };
  };
  if (!nav.mediaSession?.setActionHandler) return;
  // The 'hangup' action is the canonical way to expose a Hang Up
  // button on the lock-screen media controls (Android). iOS uses
  // 'stop' as the analog. We register both — the platform that
  // doesn't recognize the action throws, which we swallow.
  for (const action of ['hangup', 'stop'] as const) {
    try {
      nav.mediaSession.setActionHandler?.(action, handler);
    } catch {
      // unsupported action on this platform — fine
    }
  }
}

/**
 * Enter "call background mode": acquire wake lock, register media
 * session, listen for visibility changes. Call when voice connects.
 *
 * @param title Display title for the media-session "Now Playing"
 *              entry (typically the other party's name or channel
 *              name).
 * @param onHangup Called if the user taps the platform Hang Up
 *                 button on the lock-screen media controls. Used
 *                 by voice.ts to disconnect cleanly.
 */
export async function enterCallBackgroundMode(opts: {
  title: string;
  artist?: string;
  onHangup: () => void;
}): Promise<void> {
  if (active) {
    // Already in mode — update metadata in case the title changed
    // (e.g. switching DMs while in voice), but don't re-acquire the
    // wake lock unnecessarily.
    lastMeta = { title: opts.title, artist: opts.artist };
    setMediaSessionMetadata(opts.title, opts.artist);
    setHangupHandler(opts.onHangup);
    return;
  }
  active = true;
  lastMeta = { title: opts.title, artist: opts.artist };

  await acquireWakeLock();
  setMediaSessionMetadata(opts.title, opts.artist);
  setHangupHandler(opts.onHangup);

  visibilityHandler = () => {
    // Wake Lock auto-releases on hidden. When the user comes back
    // to the tab, reacquire so the next screen-lock attempt is
    // blocked again. This is the documented usage pattern from
    // the spec.
    if (document.visibilityState === 'visible' && active) {
      void acquireWakeLock();
      // Re-set media session metadata too — some browsers clear
      // it on long backgrounding.
      if (lastMeta) {
        setMediaSessionMetadata(lastMeta.title, lastMeta.artist);
      }
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

/**
 * Exit "call background mode": release wake lock, clear media
 * session, detach visibility listener. Call from voice
 * disconnectVoice().
 */
export async function exitCallBackgroundMode(): Promise<void> {
  if (!active) return;
  active = false;
  lastMeta = null;
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  await releaseWakeLock();
  clearMediaSessionMetadata();
}

/**
 * Update the title shown on the lock-screen / media controls
 * mid-call (e.g. when the user switches between DMs while voice
 * stays connected to a different channel — though in this app
 * the voice always tracks the active DM). Safe to call when not
 * in call mode (no-op).
 */
export function updateCallTitle(title: string, artist?: string): void {
  if (!active) return;
  lastMeta = { title, artist };
  setMediaSessionMetadata(title, artist);
}
