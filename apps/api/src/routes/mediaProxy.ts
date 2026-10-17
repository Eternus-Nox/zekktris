/**
 * Media proxy router
 * ------------------
 * Mounted at /api/v1/media-proxy.
 *
 *   GET /media-proxy?u=<http(s) image url>&s=<signature>
 *
 * Serves link-preview images (og:image, favicons, webhook embed icons) from
 * this server so viewers' clients never contact the sender-chosen host. See
 * lib/mediaProxyUrl.ts for how and where the URLs are minted, and
 * services/mediaProxy.ts for the fetch / validation / cache.
 *
 * Security:
 *   - No session: <img> can't send a bearer token. The HMAC signature is the
 *     gate, so only URLs the server itself put into an embed are fetched —
 *     this is not an open proxy.
 *   - Upstream fetches (cache misses) are rate-limited per client IP.
 *   - Only sniffed PNG/JPEG/GIF/WebP/ICO is served, with that sniffed type,
 *     nosniff, and a CSP that forbids everything should a browser ever
 *     navigate to the URL directly.
 */

import { Hono } from 'hono';
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

const query = z.object({
  u: z.string().min(1).max(2048),
  s: z.string().min(1).max(64),
});

/** Failures are cached upstream for 10 minutes (services/mediaProxy.ts);
    let the client do the same instead of retrying on every render. */
const FAILURE_STATUS: Record<Exclude<ProxyResult, { ok: true }>['reason'], 413 | 415 | 502> = {
  'too-large': 413,
  'not-image': 415,
  unreachable: 502,
};

mediaProxyRouter.get('/', validate('query', query), async (c) => {
  const { u, s } = c.req.valid('query');
  if (!verifyMediaSignature(u, s)) {
    return c.body(null, 403, { 'cache-control': 'no-store' });
  }

  let result = cachedProxyImage(u);
  if (!result) {
    const limit = await fetchesByIp.consume(getClientIp(c) ?? 'unknown');
    if (!limit.ok) throw errors.rateLimited(Math.ceil(limit.retryAfterMs / 1000));
    result = await fetchProxyImage(u);
  }

  if (!result.ok) {
    return c.body(null, FAILURE_STATUS[result.reason], {
      'cache-control': 'public, max-age=600',
    });
  }
  return c.body(new Uint8Array(result.body), 200, {
    'content-type': result.contentType,
    'content-length': String(result.body.length),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    // The URL is fixed per upstream image (deterministic signature), so a
    // week is safe; a changed upstream image shows up once this lapses.
    'cache-control': 'public, max-age=604800',
  });
});
