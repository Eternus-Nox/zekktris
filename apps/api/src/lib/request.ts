/**
 * Request helpers
 * ---------------
 * Pull IP and User-Agent off the request consistently. Honors TRUST_PROXY:
 * when true, trust our reverse proxy's forwarding headers; when false, only
 * the connection IP is used.
 *
 * Why bother: the api will run behind Caddy in production. Without proxy
 * trust we'd log Caddy's IP (e.g. 172.x.x.x on the docker network) in every
 * session row, which is useless for the user's sessions UI.
 *
 * SPOOFING: the LEFTMOST X-Forwarded-For entry is fully client-controlled —
 * a client sends `X-Forwarded-For: 1.2.3.4` and Caddy simply appends the real
 * peer to the right (`1.2.3.4, <realIP>`). Trusting the leftmost lets anyone
 * forge their source IP, poisoning rate-limit keys, ban checks, audit logs and
 * the sessions UI. With a single trusted hop (Caddy directly facing clients)
 * the trustworthy signals are, in order:
 *   1. X-Real-IP — Caddy sets this to the actual TCP peer and OVERWRITES any
 *      client-supplied value, so it can't be forged.
 *   2. the RIGHTMOST X-Forwarded-For entry — the one our own proxy appended,
 *      i.e. the peer that actually connected to Caddy.
 * We never trust the leftmost.
 */

import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../env';

/** The resolution order above, over any request shape: a header reader plus
 *  the TCP peer address (the fallback, and the only source without proxy
 *  trust). */
function resolveClientIp(
  header: (name: string) => string | undefined,
  peerAddress: () => string | null,
): string | null {
  if (env.TRUST_PROXY) {
    // X-Real-IP first: Caddy sets it to the real peer and strips any inbound
    // copy, so it is not client-spoofable.
    const xri = header('x-real-ip');
    if (xri) {
      const v = xri.trim();
      if (v) return v;
    }
    // Fall back to the RIGHTMOST X-Forwarded-For entry (appended by our own
    // trusted proxy). Never the leftmost — that half is attacker-controlled.
    const xff = header('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',');
      const last = parts[parts.length - 1]?.trim();
      if (last) return last;
    }
  }
  return peerAddress();
}

export function getClientIp(c: Context): string | null {
  return resolveClientIp(
    (name) => c.req.header(name),
    () => {
      try {
        return getConnInfo(c).remote.address ?? null;
      } catch {
        return null;
      }
    },
  );
}

/** getClientIp for a raw Node request — the gateway's WebSocket upgrade,
 *  which runs at the http.Server level before Hono sees it. */
export function getIncomingClientIp(req: IncomingMessage): string | null {
  return resolveClientIp(
    (name) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v.join(', ') : v;
    },
    () => req.socket.remoteAddress ?? null,
  );
}

export function getUserAgent(c: Context): string | null {
  const ua = c.req.header('user-agent');
  if (!ua) return null;
  // Cap pathological lengths.
  return ua.slice(0, 512);
}
