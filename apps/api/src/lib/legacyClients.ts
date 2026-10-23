/**
 * Pre-update clients and their automatic away
 * -------------------------------------------
 * Before multi-device presence, old iOS builds and the old desktop app set the
 * user Away by themselves (an unmarked PATCH /users/@me {status:'idle'} after
 * a few idle minutes); old Android builds and the web app in a browser never
 * did. The server can only tell them apart by User-Agent, which is enough
 * here: it decides whether an unmarked 'idle' may be automatic
 * (routes/users.ts) and whether a pre-update connection is one whose device
 * such an away says is idle (gateway/presence.ts).
 */

/**
 * A client that never set Away by itself: old Android builds (their Ktor
 * client sends its default `ktor-client` User-Agent, or OkHttp's own without
 * Ktor) and a web page in a browser (pre-update web never auto-awayed; the
 * desktop app did, and its Electron User-Agent says so). Old iOS builds send
 * their own ("Zekktris/<build> CFNetwork/…"); anything unrecognised is
 * treated like them.
 */
export function clientHasNoAutomaticAway(userAgent: string | undefined): boolean {
  const ua = userAgent ?? '';
  if (/^(ktor-client|okhttp\/)/i.test(ua)) return true;
  return /^Mozilla\//.test(ua) && !/\bElectron\//.test(ua);
}
