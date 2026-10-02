/**
 * Instance routes (non-admin)
 * ---------------------------
 * Instance-wide, read-only config. Distinct from /admin (staff-gated
 * mutations) — clients need these values without staff credentials.
 *
 * Endpoints:
 *   GET /api/v1/instance/info          PUBLIC — "is this a Zekktris server?"
 *   GET /api/v1/instance/monetization  what each perk tier unlocks
 */

import { isIP } from 'node:net';
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import { env } from '../env';
import { getConfig } from '../services/monetization';

export const instanceRouter = new Hono();

// Unauthenticated on purpose: the apps call this BEFORE signing in, when
// someone types a server address, to check it really is a Zekktris server and
// learn what its sign-in screen should offer. Nothing here is private — it's
// what the server's own web page already shows.
instanceRouter.get('/info', (c) => {
  const host = new URL(env.PUBLIC_URL).hostname;
  return c.json({
    software: 'zekktris',
    apiVersion: 1,
    publicUrl: env.PUBLIC_URL,
    registration: env.ALLOW_REGISTRATION,
    // WebAuthn needs a domain name for its relying-party id; a server reached
    // by bare IP can't offer passkeys.
    passkeys: isIP(host) === 0,
  });
});

// The full perk config, defaults filled in. uploadCapsMb values are
// number|null — null means "no override configured; the env cap applies"
// (clients treat it as "no special limit to display").
instanceRouter.get('/monetization', requireAuth, async (c) => {
  const config = await getConfig();
  return c.json({ config });
});
