/**
 * Zekktris service worker
 * ----------------------
 * Three responsibilities:
 *   1. Receive Web Push events from the browser's push gateway and show
 *      them as system notifications.
 *   2. Open/focus the Zekktris tab when the user clicks a notification.
 *   3. Provide a minimal offline shell — the user gets a usable app
 *      skeleton (HTML, CSS, JS, icons) when the network is unreachable,
 *      and a "you're offline" indicator. The actual data (messages,
 *      members, etc.) requires connectivity; we don't pretend to be
 *      offline-capable for chat content.
 *
 * Why we DO cache the shell now (changed from previous v1 policy):
 *   - PWAs need offline support to feel like real apps. Without it, a
 *     blank "no internet" page shows when a user opens the home-screen
 *     icon while offline, which is jarring.
 *   - We strictly bound what gets cached: the entry HTML, the build's
 *     hashed assets, and a few static icons. Auth flows hit /api/v1
 *     which is NEVER cached, so the auth token freshness story doesn't
 *     change.
 *
 * Cache invalidation:
 *   - The cache name embeds a build version stamp so a new build's SW
 *     activates a new cache, and the activate handler purges old ones.
 *   - The build version is templated by Vite at build time via
 *     {{BUILD_VERSION}} substitution. In dev (vite serve) this stays
 *     literal which is fine because dev doesn't run the SW anyway.
 */

const BUILD_VERSION = '__BUILD_VERSION__';
const SHELL_CACHE = `zekktris-shell-${BUILD_VERSION}`;
// Static assets we want available offline: just the manifest, icons,
// and root HTML. The hashed JS/CSS bundles get cached on demand below
// so a single hardcoded list doesn't need updating per build.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/favicon-16.png',
];

// ── Themed notification icon ──────────────────────────────────────────────
// The theme lives in the page's localStorage, which a service worker can't
// read, so the page posts us its themed app icon (a PNG data URL of the
// favicon's Z mark in the theme's colours — apps/web/src/lib/themeIcon.ts)
// on boot and on every theme switch. Push notifications use it in place of
// the static, default-palette /icon-192.png. It is kept in its OWN cache,
// outside the 'zekktris-shell-' prefix the activate handler purges, so a new
// build's worker still has it. Nothing serves this cache to fetches.
const STATIC_ICON = '/icon-192.png';
const THEME_CACHE = 'zekktris-theme';
const THEME_ICON_KEY = '/__zk/theme-icon';

// Only a base64 PNG data URL (the page's canvas raster, ~10-30 KB) is ever
// stored or shown, so a notification never loads anything remote.
function isThemeIcon(v) {
  return (
    typeof v === 'string' &&
    v.length <= 512 * 1024 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(v)
  );
}

async function storeThemeIcon(png) {
  const cache = await caches.open(THEME_CACHE);
  await cache.put(
    THEME_ICON_KEY,
    new Response(png, { headers: { 'Content-Type': 'text/plain' } }),
  );
}

// The stored themed icon, or null (none posted yet, or Cache Storage is
// unavailable) — the caller then keeps the static icon.
async function themedIcon() {
  try {
    const cache = await caches.open(THEME_CACHE);
    const res = await cache.match(THEME_ICON_KEY);
    if (!res) return null;
    const png = await res.text();
    return isThemeIcon(png) ? png : null;
  } catch {
    return null;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  // Pre-cache the static shell so first install completes quickly and
  // the next page load is offline-capable. Failure of any single asset
  // shouldn't block install; we use addAll's all-or-nothing only for
  // the must-haves and add the rest opportunistically.
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(SHELL_ASSETS);
      } catch (e) {
        // Leave the cache best-effort. Worst case the runtime path
        // (fetch handler) populates it on the next online request.
        console.warn('[sw] shell precache failed', e);
      }
      // Activate immediately — don't wait for all pages to close.
      // Pairs with clients.claim() in activate.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  // Purge old shell caches from previous builds. The check is by name
  // prefix so we don't accidentally nuke unrelated caches that some
  // future feature (e.g. attachment thumbnails) might add.
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (n) =>
              (n.startsWith('zekktris-shell-') || n.startsWith('commune-shell-')) &&
              n !== SHELL_CACHE,
          )
          .map((n) => caches.delete(n)),
      );
      // Take control of pages that were already open before the SW
      // installed. Without this, an existing tab needs a hard refresh
      // before the SW handles its fetches.
      await self.clients.claim();
    })(),
  );
});

// ── Fetch handler — offline shell only ────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET. POST/PUT/PATCH/DELETE are auth-mutating and we
  // never want to cache or replay them.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cross-origin requests pass through. We only care about our own
  // origin's static assets.
  if (url.origin !== self.location.origin) return;

  // API + CDN requests pass through to the network without caching.
  // Stale auth tokens or cached 401s would be a security/UX hazard;
  // CDN files are large and have their own immutable caching headers
  // already (handled by browser HTTP cache).
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn/')) return;

  // Navigation requests (top-level HTML) — serve cached shell when
  // offline. Network-first so the latest deploy is used when online.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Update cached shell with the latest HTML so installs that
          // never go through the install handler still get current
          // content.
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/index.html', fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          // Offline — fall back to the cached shell. The SPA will
          // render an offline-aware UI from the existing in-memory
          // state plus any data the gateway already had.
          const cache = await caches.open(SHELL_CACHE);
          const cached = (await cache.match('/index.html')) || (await cache.match('/'));
          if (cached) return cached;
          // No cache hit — synthesize a minimal HTML response so the
          // browser at least shows something readable.
          return new Response(
            '<!doctype html><html><body style="background:#0a0f1c;color:#dbdee1;font-family:system-ui;padding:2rem;text-align:center"><h1>Zekktris</h1><p>You are offline and the app shell is not cached yet. Reconnect and try again.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        }
      })(),
    );
    return;
  }

  // Static-asset requests (hashed JS, CSS, fonts, images) — cache-first
  // so subsequent loads are instant. The hashes mean a new build won't
  // hit a stale cache: the request URL itself changes per build.
  if (
    url.pathname.startsWith('/assets/') ||
    SHELL_ASSETS.includes(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          // Only cache successful responses. 404s/5xx shouldn't
          // poison the cache.
          if (fresh.ok) {
            cache.put(req, fresh.clone()).catch(() => undefined);
          }
          return fresh;
        } catch {
          // Asset miss while offline. Browser will treat this as a
          // load failure; the shell-level offline UI handles the
          // user-visible side.
          return Response.error();
        }
      })(),
    );
    return;
  }

  // Anything else (manifest probes, sw.js itself, etc.): pass through.
});

// ── Push notifications ────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Zekktris', body: event.data.text() };
  }

  // Use the title from the payload. iOS auto-injects a "from
  // Zekktris" subtitle for every PWA notification (unremovable —
  // it's how iOS identifies which installed PWA fired the push),
  // so the API puts the meaningful identifier (sender's name,
  // caller's name) in the title slot. Forcing "Zekktris" here
  // produced a redundant "Zekktris / from Zekktris / message"
  // layout. Falls back to "Zekktris" only when the payload has no
  // title field set at all, so notifications always have something
  // to render.
  const title = payload.title || 'Zekktris';
  // Rendering differs by notification kind. Calls get the ring
  // treatment (long vibration, persistent until acknowledged,
  // Accept/Decline action buttons); regular messages get the
  // standard soft notification. Server-provided values for
  // vibrate / requireInteraction / actions override the defaults
  // when present, so the API has full control of the shape.
  const isCall = payload.kind === 'call';
  // No icon, or the static app icon (the server names /icon-192.png for
  // friend requests and calls), both mean "the app icon" — shown below in
  // the device's theme when the page has posted one. Any other URL is a
  // deliberate per-notification image and is left alone.
  const wantsAppIcon = !payload.icon || payload.icon === STATIC_ICON;
  const options = {
    body: payload.body || '',
    // Use the manifest icon so the notification looks like the app
    // rather than a generic browser bell.
    icon: payload.icon || STATIC_ICON,
    // The badge stays the static icon: Android draws it as an alpha-only
    // mask in the system's own tint, so it can't carry the theme anyway.
    badge: STATIC_ICON,
    tag: payload.tag,
    // Forward arbitrary server-provided data plus the click URL so
    // the notificationclick handler has everything it needs without
    // re-parsing. Calls carry channelId + callerName here.
    data: {
      ...(payload.data || {}),
      url: payload.url || '/',
      kind: payload.kind || 'message',
    },
    // Vibration pattern. Calls use a longer phone-ring style
    // pattern (3+ bursts); messages use a single soft buzz.
    // navigator.vibrate format: alternating buzz-ms / pause-ms.
    vibrate: payload.vibrate || (isCall ? [300, 150, 300, 150, 300, 150, 300] : [200, 100, 200]),
    // Explicit silent:false so the OS notification sound plays.
    silent: false,
    // Calls force requireInteraction true — the ring must not
    // auto-dismiss before the user picks up the phone. Messages
    // keep the default (auto-dismiss after a few seconds).
    requireInteraction: payload.requireInteraction === true || isCall,
    // Inline action buttons. Web Notification API supports up to
    // two on most platforms. Calls show [Answer, Decline].
    actions: payload.actions || [],
    // iOS-specific hint: time-sensitive notifications break through
    // focus modes if the user has granted that permission. Calls
    // qualify; regular messages don't.
    timestamp: Date.now(),
  };

  // Suppress notifications when the user is already reading this channel
  // in a focused tab. See the long-form rationale below.
  event.waitUntil(
    (async () => {
      try {
        const all = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        const target = payload.url || '/';
        for (const client of all) {
          const isFocused =
            client.visibilityState === 'visible' && client.focused === true;
          if (!isFocused) continue;
          try {
            const clientPath = new URL(client.url).pathname;
            if (clientPath === target) return;
          } catch {
            // Malformed URL — fall through and show.
          }
        }
      } catch {
        // matchAll failed — show the notification rather than dropping it.
      }
      if (wantsAppIcon) {
        const themed = await themedIcon();
        if (themed) options.icon = themed;
      }
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const isCall = data.kind === 'call';
  const action = event.action; // empty string when the body was tapped

  // Decline path: end the ring on the caller's side. No window is
  // opened, since the user said "no" to the call.
  //
  // The SW has no bearer token (it lives in the page) and the API
  // doesn't accept cookies on normal routes, so the ring push carries
  // `declineToken`: a short-lived signed capability that can decline
  // only THIS call, as this user (api auth/callDeclineToken.ts). We
  // send it to POST /call-decline directly — whether or not a tab is
  // open — and the server removes the caller from voice, which also
  // clears any open tab's incoming-call UI via the gateway. Idempotent:
  // a call that already ended or was answered is a no-op.
  if (isCall && action === 'decline-call') {
    const declineToken = data.declineToken;
    if (typeof declineToken === 'string') {
      event.waitUntil(
        fetch('/api/v1/call-decline', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: declineToken }),
        }).catch(() => {
          // Network failure — drop silently; the caller's own
          // ringing-out timeout is the final backstop.
        }),
      );
    }
    return;
  }

  // Accept path: behavior depends on WHICH part of the notification
  // was tapped.
  //
  //   - action === 'accept-call' (explicit Answer button): keep the
  //     autojoin=1 param so the client auto-joins voice on landing.
  //     This is the user explicitly committing to the call.
  //
  //   - action === '' (notification body tapped): the user wants to
  //     OPEN the conversation, not necessarily commit to the call.
  //     Strip autojoin=1 so they land inside the DM with the
  //     IncomingCallStrip visible — they can then choose whether
  //     to answer or dismiss. Auto-answering on body-tap was a bug
  //     ("calls are auto-answering without acceptance").
  //
  // The server attaches `?autojoin=1` to data.url unconditionally;
  // we trust the SW to gate based on tap type rather than relying
  // on the server to encode intent into the URL.
  let targetUrl = data.url || '/';
  try {
    const u = new URL(targetUrl, self.location.origin);
    if (isCall && action !== 'accept-call') {
      u.searchParams.delete('autojoin');
    }
    // Force same-origin navigation for EVERY notification click. No present-day
    // server push sets a cross-origin data.url (all are server-built relative
    // paths), but normalizing unconditionally closes the latent open-redirect /
    // window-injection sink at openWindow before any future payload can carry
    // user-influenced data. A cross-origin URL collapses to root.
    targetUrl =
      u.origin === self.location.origin
        ? u.pathname + (u.search ? u.search : '') + (u.hash ? u.hash : '')
        : '/';
  } catch {
    // Malformed URL — fall back to root rather than risk
    // navigating somewhere unexpected.
    targetUrl = '/';
  }
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        if (client.url && new URL(client.url).origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: 'NAVIGATE', url: targetUrl });
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});

// ── Update prompt support ─────────────────────────────────────────────────
// Allow the page to ask the SW to skipWaiting (so updates take effect
// immediately on the next reload). The page sends {type:'SKIP_WAITING'}
// when the user accepts an "update available" prompt.

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // The page's themed app icon for push notifications — see "Themed
  // notification icon" at the top. Anything but a PNG data URL is ignored.
  if (event.data && event.data.type === 'SET_THEME_ICON') {
    const png = event.data.png;
    if (isThemeIcon(png)) {
      event.waitUntil(storeThemeIcon(png).catch(() => undefined));
    }
  }
  // Close any open call notifications for a given channel — used when
  // the call ends (recipient answers, declines, caller hangs up, or
  // partner leaves) so the ring-with-requireInteraction notification
  // doesn't linger on the OS UI after the underlying call is over.
  // Client posts {type: 'CLEAR_CALL_NOTIFICATION', channelId: '...'}.
  if (event.data && event.data.type === 'CLEAR_CALL_NOTIFICATION') {
    const channelId = event.data.channelId;
    if (typeof channelId === 'string' && self.registration) {
      event.waitUntil(
        (async () => {
          try {
            const notifs = await self.registration.getNotifications({
              tag: `call-${channelId}`,
            });
            for (const n of notifs) {
              try {
                n.close();
              } catch {
                // ignore — already closed or permission revoked
              }
            }
          } catch {
            // getNotifications can fail on older browsers; safe to
            // ignore — the notification just stays visible until
            // dismissed manually.
          }
        })(),
      );
    }
  }
});
