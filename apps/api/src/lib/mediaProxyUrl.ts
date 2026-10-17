/**
 * Link-preview image proxy URLs
 * -----------------------------
 * Embed images (og:image, favicon, webhook author/footer icons, thumbnails)
 * point at whatever host the sender's page or webhook named. Rendering them
 * straight from there would hand every VIEWER's IP and User-Agent to that
 * host (and http ones are mixed content). So every embed image URL leaves the
 * server rewritten to the server's own image proxy (routes/mediaProxy.ts):
 *
 *   /api/v1/media-proxy?u=<encoded upstream url>&s=<signature>
 *
 * Relative on purpose. The web app and the desktop shell load the SPA from
 * the server's own origin (as relative /cdn/... avatars already rely on), and
 * iOS (assetURL) and Android (Config.absoluteUrl) prefix a leading-slash
 * path with the server origin the user signed in to. An absolute
 * PUBLIC_URL-based URL would break whenever the instance is reached under
 * another name (LAN IP, mDNS, a tunnel) than PUBLIC_URL says.
 *
 * <img> can't carry a bearer token, so the proxy is authorised by an HMAC over
 * the upstream URL instead: it only fetches URLs the server itself put into an
 * embed. The signature is deterministic (no expiry) so a given image keeps one
 * URL, which is what lets browsers, CachedImage and Coil cache it. Rewriting
 * happens at serialization time (lib/dto.ts toMessage, the /unfurl response),
 * not on the stored row, so existing messages are covered and rotating the key
 * only costs clients one re-fetch.
 *
 * Key: HMAC-SHA256(JWT_SECRET, a fixed label). JWT_SECRET is already required,
 * secret, and at least 32 characters, so every install gets a strong key with
 * no new setting; the label separates this use from token signing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

export const MEDIA_PROXY_PATH = '/api/v1/media-proxy';

/** Longer URLs are not proxied (the webhook schema caps image URLs at 2048). */
const MAX_PROXIED_URL_CHARS = 2048;

let key: Buffer | null = null;
function signingKey(): Buffer {
  key ??= createHmac('sha256', env.JWT_SECRET).update('zekktris/media-proxy/v1').digest();
  return key;
}

/** base64url HMAC-SHA256 of the upstream URL, truncated to 128 bits. */
export function signMediaUrl(url: string): string {
  return createHmac('sha256', signingKey()).update(url).digest().subarray(0, 16).toString('base64url');
}

export function verifyMediaSignature(url: string, sig: string): boolean {
  const expected = Buffer.from(signMediaUrl(url));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let publicOrigin: string | null | undefined;
function ownOrigin(): string | null {
  if (publicOrigin === undefined) {
    try {
      publicOrigin = new URL(env.PUBLIC_URL).origin;
    } catch {
      publicOrigin = null;
    }
  }
  return publicOrigin;
}

/**
 * The URL a client should load for an embed image.
 *   - null/empty, or anything that isn't http(s) → null (no image)
 *   - already a same-origin path ('/cdn/...') → unchanged
 *   - on this server's own PUBLIC_URL origin → its path (no proxy hop needed)
 *   - any other http(s) URL → a signed proxy URL
 */
export function proxiedImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  if (raw.length > MAX_PROXIED_URL_CHARS) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin === ownOrigin()) return u.pathname + u.search;
  return `${MEDIA_PROXY_PATH}?u=${encodeURIComponent(raw)}&s=${signMediaUrl(raw)}`;
}

type EmbedImageFields = {
  imageUrl?: string | null;
  faviconUrl?: string | null;
  authorIconUrl?: string | null;
  thumbnailUrl?: string | null;
  footerIconUrl?: string | null;
};

/** A copy of an embed with every image field rewritten by proxiedImageUrl.
    Fields the embed doesn't carry stay absent. */
export function proxyEmbedImages<T extends EmbedImageFields>(embed: T): T {
  const out = { ...embed };
  for (const k of ['imageUrl', 'faviconUrl', 'authorIconUrl', 'thumbnailUrl', 'footerIconUrl'] as const) {
    if (k in out) out[k] = proxiedImageUrl(out[k]);
  }
  return out;
}
