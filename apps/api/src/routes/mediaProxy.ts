/**
 * Media proxy router
 * ------------------
 * Mounted at /api/v1/media-proxy.
 *
 *   GET /media-proxy?u=<http(s) image url>&s=<signature>
 *
 * Serves link-preview images (og:image, favicons, webhook embed icons),
 * webhook avatars and event images from this server so viewers' clients
 * never contact the sender-chosen host. See
 * lib/mediaProxyUrl.ts for how and where the URLs are minted, and
 * services/mediaProxy.ts for the fetch / validation / cache.
 *
 * Security:
 *   - No session: <img> can't send a bearer token. The HMAC signature is the
 *     gate, so only URLs the server itself put into an embed are fetched —
 *     this is not an open proxy.
 *   - Upstream fetches (cache misses) are rate-limited per client IP (per
 *     /64 for IPv6, which a single host can hold whole) and capped
 *     process-wide (services/mediaProxy.ts MAX_CONCURRENT_FETCHES; 503 over it).
 *   - Only sniffed PNG/JPEG/GIF/WebP/ICO is served, with that sniffed type,
 *     nosniff, and a CSP that forbids everything (framing included) should a
 *     browser ever navigate to the URL directly.
 */

import { Hono } from 'hono';
import { isIPv6 } from 'node:net';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { RateLimiter } from '../lib/rateLimit';
import { getClientIp } from '../lib/request';
import { errors } from '../errors';
import { verifyMediaSignature } from '../lib/mediaProxyUrl';
import { cachedProxyImage, fetchProxyImage, type ProxyResult } from '../services/mediaProxy';

export const mediaProxyRouter = new Hono();

// Upstream fetches per client IP. Cache hits don't count. Sized for a cold
// scroll through an image-heavy channel, with headroom for several people
// behind one NAT.
const fetchesByIp = new RateLimiter(300, 60_000, 'media-proxy-ip');

/** The rate-limit key for a client address: an IPv6 address's /64 (one
    subscriber's allocation, so rotating within it buys nothing), else the
    address itself. */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return 'unknown';
  if (!isIPv6(ip) || ip.includes('.')) return ip; // v4, or v4-mapped v6
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':') + '::/64';
}

const query = z.object({
  u: z.string().min(1).max(2048),
  s: z.string().min(1).max(64),
});

/** Failures are cached upstream for 10 minutes (services/mediaProxy.ts);
    let the client do the same instead of retrying on every render. 'busy'
    (too many fetches in flight) is the exception: transient, never cached. */
const FAILURE_STATUS: Record<Exclude<ProxyResult, { ok: true }>['reason'], 413 | 415 | 502 | 503> = {
  'too-large': 413,
  'not-image': 415,
  unreachable: 502,
  busy: 503,
};

mediaProxyRouter.get('/', validate('query', query), async (c) => {
  const { u, s } = c.req.valid('query');
  if (!verifyMediaSignature(u, s)) {
    return c.body(null, 403, { 'cache-control': 'no-store' });
  }

  let result = cachedProxyImage(u);
  if (!result) {
    const limit = await fetchesByIp.consume(rateLimitKey(getClientIp(c)));
    if (!limit.ok) throw errors.rateLimited(Math.ceil(limit.retryAfterMs / 1000));
    result = await fetchProxyImage(u);
  }

  if (!result.ok) {
    return c.body(
      null,
      FAILURE_STATUS[result.reason],
      result.reason === 'busy'
        ? { 'cache-control': 'no-store', 'retry-after': '2' } // transient; not cached upstream either
        : { 'cache-control': 'public, max-age=600' },
    );
  }
  // The cached Buffer itself, no per-response copy. It is Buffer.concat's
  // output (fetchPublic), so its backing store is a plain ArrayBuffer.
  return c.body(result.body as Uint8Array<ArrayBuffer>, 200, {
    'content-type': result.contentType,
    'content-length': String(result.body.length),
    'x-content-type-options': 'nosniff',
    // Complete on its own: ops/Caddyfile adds its site-wide frame-ancestors
    // only to responses without a CSP, so framing is ruled out here too.
    'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    // The URL is fixed per upstream image (deterministic signature), so a
    // week is safe; a changed upstream image shows up once this lapses.
    'cache-control': 'public, max-age=604800',
  });
});
