/**
 * Request helpers
 * ---------------
 * Pull IP and User-Agent off the request consistently. Honors TRUST_PROXY:
 * when true, X-Forwarded-For (leftmost) and X-Real-IP are trusted as the
 * source of truth; when false, only the connection IP is used.
 *
 * Why bother: the api will run behind Caddy in production. Without proxy
 * trust we'd log Caddy's IP (e.g. 172.x.x.x on the docker network) in every
 * session row, which is useless for the user's sessions UI.
 */

import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../env';

export function getClientIp(c: Context): string | null {
  if (env.TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      // Leftmost is the original client; intermediate proxies append themselves.
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const xri = c.req.header('x-real-ip');
    if (xri) return xri.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function getUserAgent(c: Context): string | null {
  const ua = c.req.header('user-agent');
  if (!ua) return null;
  // Cap pathological lengths.
  return ua.slice(0, 512);
}
