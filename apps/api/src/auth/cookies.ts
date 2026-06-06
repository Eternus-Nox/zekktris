/**
 * Refresh-token cookie helpers
 * ----------------------------
 * The refresh token lives in an httpOnly cookie scoped to /api/v1/auth.
 * Setting it elsewhere or with mismatched flags would create a footgun
 * (cookies are matched by name + path + domain; a clear with wrong path
 * silently does nothing). Centralizing the path/flag values here.
 */

import type { Context } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { env } from '../env';

// Refresh-token cookie name. Renamed from the legacy 'commune_refresh'
// during the brand cleanup. Consequence: every currently-logged-in
// user's browser still has the OLD cookie set, but the server no
// longer looks up cookies by that name — the next refresh attempt
// returns 401, the client falls back to the login screen, and on
// re-login a fresh 'zekktris_refresh' cookie is set. This was a
// one-time cost the user accepted to clean up the codebase fully.
export const REFRESH_COOKIE_NAME = 'zekktris_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

interface CookieFlags {
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  domain?: string;
}

function flags(): CookieFlags {
  const f: CookieFlags = {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'Lax',
  };
  if (env.COOKIE_DOMAIN) f.domain = env.COOKIE_DOMAIN;
  return f;
}

export function setRefreshCookie(c: Context, token: string): void {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    ...flags(),
    maxAge: env.REFRESH_TOKEN_TTL_SECONDS,
  });
}

export function clearRefreshCookie(c: Context): void {
  // deleteCookie sends a Max-Age=0 + matching path/domain — the same flags
  // used at set time, otherwise the browser keeps the cookie.
  deleteCookie(c, REFRESH_COOKIE_NAME, flags());
}

export function readRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE_NAME);
}
