/**
 * Unfurl router
 * -------------
 * Mounted at /api/v1/unfurl.
 *
 *   GET /unfurl?url=<http(s) url>  — resolve a single link preview (embed)
 *
 * The normal embed pipeline (services/embeds.ts) runs server-side on message
 * content and persists embeds onto the message row. But an E2EE DM is
 * ciphertext to the server, so it can't extract or unfurl the URLs inside —
 * E2EE messages always come back with `embeds: []`. This endpoint lets a
 * CLIENT (which CAN decrypt) resolve a preview for a single URL it found in the
 * decrypted plaintext, then render the card locally. Plaintext never leaves the
 * device — only the one URL the user already shared is sent here to unfurl.
 *
 * Security:
 *   - Reuses resolveEmbed(), which carries the SSRF guards (private/loopback
 *     IP rejection with resolved-IP pinning, 2 MB / 5 s caps, text/html only,
 *     re-validated redirects). This endpoint adds NO new fetch surface beyond
 *     what message-send already does server-side.
 *   - Auth required (so it can't be used as an open SSRF/scraping proxy).
 *   - Per-user rate limit bounds how fast any one account can drive outbound
 *     fetches.
 *   - Image URLs in the response point at the media proxy
 *     (lib/mediaProxyUrl.ts), never at the third-party host.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { RateLimiter } from '../lib/rateLimit';
import { errors } from '../errors';
import * as embeds from '../services/embeds';
import { cachedResolveEmbed } from '../services/embedCache';
import { proxyEmbedImages } from '../lib/mediaProxyUrl';

export const unfurlRouter = new Hono();

unfurlRouter.use('*', requireAuth);

// Generous enough for a screenful of links, tight enough to bound SSRF-fetch
// amplification: 60 resolves per minute per user.
const unfurlByUser = new RateLimiter(60, 60_000, 'unfurl-user');

const unfurlQuery = z.object({ url: z.string().url() });

unfurlRouter.get('/', validate('query', unfurlQuery), async (c) => {
  const userId = requireUserId(c);
  const limit = await unfurlByUser.consume(userId.toString());
  if (!limit.ok) throw errors.rateLimited(Math.ceil(limit.retryAfterMs / 1000));

  const { url } = c.req.valid('query');
  // Run the URL through the SAME extractor the message pipeline uses, so a
  // client gets identical normalization (scheme/host check + trailing-
  // punctuation trim) and we never fetch something the server wouldn't have.
  const [normalized] = embeds.extractUrls(url);
  if (!normalized) return c.json({ embed: null });

  // Through the cache: this endpoint is the ONLY thing that resolves previews
  // for E2EE DMs (the server can't read the ciphertext to persist them on the
  // message row the way it does for plaintext), so without it the same URLs
  // were re-fetched on every render, on every device, forever. The cache also
  // single-flights the concurrent burst a client sends when a channel opens.
  const embed = await cachedResolveEmbed(normalized, embeds.resolveEmbed);
  // Image URLs go out as signed media-proxy URLs, exactly as in message DTOs,
  // so the client rendering this card never contacts the image host itself.
  return c.json({ embed: embed ? proxyEmbedImages(embed) : null });
});
