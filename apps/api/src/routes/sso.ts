/**
 * SSO / OIDC routes
 * -----------------
 * Browser-redirect endpoints (NOT XHR) that drive the OIDC login:
 *   GET /auth/sso/config    public — { enabled, buttonLabel } for the login page
 *   GET /auth/sso/login     start the flow → 302 to the provider (sets the
 *                           encrypted state cookie)
 *   GET /auth/sso/callback  provider redirects back here → validate, resolve the
 *                           user, issue the app's NORMAL session (refresh
 *                           cookie), and bounce to the SPA's /sso/complete
 *
 * On any failure we redirect to the web login with a `sso_error` query param so
 * the user sees a message rather than a raw API error.
 */

import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import * as oidc from '../services/oidc';
import { createSession } from '../auth/sessions';
import { setRefreshCookie } from '../auth/cookies';
import { getClientIp, getUserAgent } from '../lib/request';
import { AppError } from '../errors';
import { env } from '../env';
import { log } from '../log';

export const ssoRouter = new Hono();

const STATE_COOKIE = 'zk_sso_state';
const STATE_COOKIE_PATH = '/api/v1/auth/sso';

function webBase(): string {
  return env.PUBLIC_URL.replace(/\/+$/, '');
}
function loginError(message: string): string {
  return `${webBase()}/login?sso_error=${encodeURIComponent(message)}`;
}

ssoRouter.get('/config', async (c) => {
  return c.json(await oidc.getPublicOidcConfig());
});

ssoRouter.get('/login', async (c) => {
  try {
    const cfg = await oidc.getOidcConfig();
    if (!cfg) return c.redirect(loginError('SSO is not enabled on this instance.'));
    const { url, stateCookie } = await oidc.buildAuthRequest(oidc.redirectUri());
    setCookie(c, STATE_COOKIE, stateCookie, {
      path: STATE_COOKIE_PATH,
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'Lax', // must survive the top-level redirect back from the IdP
      maxAge: 600,
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    });
    return c.redirect(url);
  } catch (e) {
    return c.redirect(loginError(e instanceof AppError ? e.message : 'Could not start SSO login.'));
  }
});

ssoRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const providerError = c.req.query('error');
  const cookie = getCookie(c, STATE_COOKIE);
  // Single-use: clear the state cookie regardless of outcome.
  deleteCookie(c, STATE_COOKIE, { path: STATE_COOKIE_PATH });

  if (providerError) {
    return c.redirect(loginError(`SSO provider error: ${providerError}`));
  }
  if (!code || !state) {
    return c.redirect(loginError('SSO callback was missing required parameters.'));
  }

  try {
    const blob = oidc.consumeStateCookie(cookie, state);
    const userId = await oidc.completeLogin({
      code,
      codeVerifier: blob.codeVerifier,
      nonce: blob.nonce,
      redirectUri: oidc.redirectUri(),
    });
    // Issue the app's NORMAL session — SSO only establishes a session, it does
    // not replace the session/token machinery.
    const { refreshToken } = await createSession({
      userId,
      userAgent: getUserAgent(c),
      ipAddress: getClientIp(c),
    });
    setRefreshCookie(c, refreshToken);
    return c.redirect(`${webBase()}/sso/complete`);
  } catch (e) {
    log.warn('sso callback failed', { err: e instanceof Error ? e.message : String(e) });
    return c.redirect(loginError(e instanceof AppError ? e.message : 'SSO login failed.'));
  }
});
