/**
 * What the shell lets the remote page do. The main window shows whichever
 * server the user picked, so its page is untrusted web content: it may hand
 * only web and mail links to the OS, and gets permissions only on that
 * server's own origin. Pure functions (no Electron imports) so they can be
 * tested with plain Node — see test/trust.test.ts.
 */

/** Schemes the OS may open for the page. Anything else (file:, smb:,
    search-ms:, ms-*:, other apps' protocol handlers) is dropped. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** The URL to hand to shell.openExternal, or null when it must not be opened. */
export function externalUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return EXTERNAL_PROTOCOLS.has(u.protocol) ? u.href : null;
}

/** True when `url` (a URL or an origin) is on `origin`. */
export function isSameOrigin(url: string | null | undefined, origin: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

// The permissions the web app needs, auto-granted so nothing prompts:
//   - notifications: native message/call pop-ups
//   - media: mic + camera for voice and video
//   - display-capture: screen share (main.ts's display-media handler does
//     the actual source selection)
//   - fullscreen: a video tile's fullscreen button
//   - screen-wake-lock: keeps the display on during a call
//   - clipboard-sanitized-write: navigator.clipboard.writeText() (copy link,
//     copy text); without it the renderer gets "clipboard access declined".
// Never clipboard-read: the web app doesn't read the clipboard, and the grant
// would let the page read whatever was copied (passwords included) whenever
// the window has focus.
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media',
  'display-capture',
  'fullscreen',
  'screen-wake-lock',
  'clipboard-sanitized-write',
]);

/** Whether to grant `permission` to a page at `requestingUrl` (a URL or an
    origin) when the chosen server is `serverOrigin`. The caller also checks
    the request comes from the main window. */
export function permissionAllowed(
  permission: string,
  requestingUrl: string | null | undefined,
  serverOrigin: string,
): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isSameOrigin(requestingUrl, serverOrigin);
}
