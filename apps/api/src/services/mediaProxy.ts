/**
 * Link-preview image proxy — fetch, validate, cache
 * -------------------------------------------------
 * Backs GET /api/v1/media-proxy (routes/mediaProxy.ts); lib/mediaProxyUrl.ts
 * explains why embed images go through it and how URLs are signed.
 *
 *   - Fetches with embeds.fetchPublic, i.e. the link-preview fetcher's SSRF
 *     defences: DNS resolved and checked against private/loopback/link-local
 *     ranges, the TCP target pinned to the checked IP, every redirect
 *     re-checked, a 5 s deadline. Only fixed headers go upstream.
 *   - Serves real raster images only: the type comes from the magic bytes
 *     (PNG, JPEG, GIF, WebP, ICO), never from the upstream Content-Type, so
 *     SVG, HTML and anything else are refused. Bodies over MAX_IMAGE_BYTES and
 *     images over the dimension caps are refused too.
 *   - Caches in a bounded in-process LRU (bytes and entries), with short-lived
 *     negative entries so a missing favicon isn't re-fetched on every view,
 *     single-flights concurrent misses for the same URL, and caps how many
 *     upstream fetches run at once (MAX_CONCURRENT_FETCHES).
 */

import { fetchPublic } from './embeds';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Longest side, and total pixels, a proxied image may declare. Far above any
    real preview image; stops decompression bombs reaching viewers' decoders.
    What's checked is the largest size a decoder would allocate for: the PNG,
    WebP and JPEG header, a GIF's screen grown to fit every frame, and every
    ICO entry's own PNG/BMP header (not just its 1-byte directory size). */
export const MAX_IMAGE_SIDE = 8192;
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Upstream fetches in flight at once, process-wide. Each may buffer up to
    MAX_IMAGE_BYTES, and the per-IP limit alone doesn't bound the total (many
    IPs, or an IPv6 range), so this caps the proxy's transient memory at
    about MAX_CONCURRENT_FETCHES × MAX_IMAGE_BYTES. Over it, a miss is
    answered 'busy' (not cached) and the client retries later. */
export const MAX_CONCURRENT_FETCHES = 16;

const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 2000;
const TTL_HIT_MS = 24 * 60 * 60 * 1000;
const TTL_MISS_MS = 10 * 60 * 1000;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/x-icon';

export type ProxyResult =
  | { ok: true; body: Buffer; contentType: ImageType }
  | { ok: false; reason: 'unreachable' | 'not-image' | 'too-large' | 'busy' };

// ── Sniffing ───────────────────────────────────────────────────────────────

/** The raster type the magic bytes say, or null for anything else. */
export function sniffImageType(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6) {
    const sig = b.toString('latin1', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  // ICO: reserved 0, type 1, 1..64 images, and room for their directory.
  if (b.length >= 6 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) {
    const count = b.readUInt16LE(4);
    if (count > 0 && count <= 64 && b.length >= 6 + 16 * count) return 'image/x-icon';
  }
  return null;
}

/** Declared pixel dimensions from the header, or null if they can't be read
    (a truncated or malformed file, which is refused). */
export function imageDimensions(b: Buffer, type: ImageType): { width: number; height: number } | null {
  try {
    switch (type) {
      case 'image/png':
        if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
        return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      case 'image/gif':
        return gifDimensions(b);
      case 'image/webp':
        return webpDimensions(b);
      case 'image/jpeg':
        return jpegDimensions(b);
      case 'image/x-icon':
        return icoDimensions(b);
    }
  } catch {
    return null; // a read past the end of a truncated header
  }
}

/** The logical screen, grown to the furthest edge of any frame: browsers
    enlarge the canvas for a frame that doesn't fit, so a tiny declared screen
    proves nothing. Walks the block structure; a truncated tail just ends the
    walk (what's there is what a browser would draw). */
function gifDimensions(b: Buffer): { width: number; height: number } {
  let width = b.readUInt16LE(6);
  let height = b.readUInt16LE(8);
  const colorTable = (packed: number) => (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  const skipSubBlocks = (i: number) => {
    while (i < b.length && b[i] !== 0) i += b[i]! + 1;
    return i + 1;
  };
  let i = 13 + colorTable(b[10]!);
  while (i < b.length) {
    const block = b[i]!;
    if (block === 0x2c) {
      // Image descriptor: left, top, width, height, packed; then the local
      // colour table, the LZW minimum code size and the data sub-blocks.
      if (i + 10 > b.length) break;
      width = Math.max(width, b.readUInt16LE(i + 1) + b.readUInt16LE(i + 5));
      height = Math.max(height, b.readUInt16LE(i + 3) + b.readUInt16LE(i + 7));
      i = skipSubBlocks(i + 10 + colorTable(b[i + 9]!) + 1);
    } else if (block === 0x21) {
      i = skipSubBlocks(i + 2); // extension: introducer, label, sub-blocks
    } else {
      break; // 0x3b trailer, or garbage a decoder stops at too
    }
  }
  return { width, height };
}

/** The largest entry, by its embedded image's own header: an entry's PNG or
    BMP is decoded at the size IT declares, whatever the 1-byte directory size
    (1..256) says. A directory pointing outside the file is malformed. */
function icoDimensions(b: Buffer): { width: number; height: number } | null {
  const count = b.readUInt16LE(4);
  const dirEnd = 6 + 16 * count;
  let best: { width: number; height: number } | null = null;
  for (let e = 6; e < dirEnd; e += 16) {
    let width = b[e] || 256;
    let height = b[e + 1] || 256;
    const offset = b.readUInt32LE(e + 12);
    if (offset < dirEnd || offset + 24 > b.length) return null;
    if (b.readUInt32BE(offset) === 0x89504e47 && b.readUInt32BE(offset + 4) === 0x0d0a1a0a) {
      if (b.toString('latin1', offset + 12, offset + 16) !== 'IHDR') return null;
      width = Math.max(width, b.readUInt32BE(offset + 16));
      height = Math.max(height, b.readUInt32BE(offset + 20));
    } else {
      // BMP without its file header. Its height covers the XOR and AND
      // masks, i.e. twice the icon's. BITMAPCOREHEADER (12 bytes) has 16-bit
      // fields, the later headers signed 32-bit ones.
      const core = b.readUInt32LE(offset) === 12;
      const w = core ? b.readUInt16LE(offset + 4) : Math.abs(b.readInt32LE(offset + 4));
      const h = core ? b.readUInt16LE(offset + 6) : Math.abs(b.readInt32LE(offset + 8));
      width = Math.max(width, w);
      height = Math.max(height, Math.ceil(h / 2));
    }
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

function webpDimensions(b: Buffer): { width: number; height: number } | null {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte start code, then 14-bit width/height.
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: signature byte 0x2f, then 14-bit (width-1) and (height-1).
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit (canvas width-1) and (canvas height-1).
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function jpegDimensions(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** Validate a fetched body as a servable image. */
export function checkImage(body: Buffer): ProxyResult {
  if (body.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  const type = sniffImageType(body);
  if (!type) return { ok: false, reason: 'not-image' };
  const dims = imageDimensions(body, type);
  if (!dims || dims.width <= 0 || dims.height <= 0) return { ok: false, reason: 'not-image' };
  if (
    dims.width > MAX_IMAGE_SIDE ||
    dims.height > MAX_IMAGE_SIDE ||
    dims.width * dims.height > MAX_IMAGE_PIXELS
  ) {
    return { ok: false, reason: 'too-large' };
  }
  return { ok: true, body, contentType: type };
}

// ── Cache ──────────────────────────────────────────────────────────────────

interface Entry {
  result: ProxyResult;
  expiresAt: number;
  bytes: number;
}

/** Map iteration order is insertion order; a hit re-inserts, so the first
    key is always the least recently used. */
const cache = new Map<string, Entry>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<ProxyResult>>();

function cacheGet(url: string): ProxyResult | null {
  const e = cache.get(url);
  if (!e) return null;
  cache.delete(url);
  if (e.expiresAt <= Date.now()) {
    cacheBytes -= e.bytes;
    return null;
  }
  cache.set(url, e);
  return e.result;
}

function cachePut(url: string, result: ProxyResult): void {
  const bytes = (result.ok ? result.body.length : 0) + url.length;
  const old = cache.get(url);
  if (old) {
    cache.delete(url);
    cacheBytes -= old.bytes;
  }
  cache.set(url, {
    result,
    bytes,
    expiresAt: Date.now() + (result.ok ? TTL_HIT_MS : TTL_MISS_MS),
  });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_ENTRIES) {
    const [oldestKey, oldest] = cache.entries().next().value as [string, Entry];
    cache.delete(oldestKey);
    cacheBytes -= oldest.bytes;
  }
}

/** A cached result for this URL, if any, without fetching. */
export function cachedProxyImage(url: string): ProxyResult | null {
  return cacheGet(url);
}

/** Fetch, validate and cache one upstream image. Never throws. A request
    for a URL already being fetched joins that fetch; a new fetch while
    MAX_CONCURRENT_FETCHES are running gets { reason: 'busy' }. */
export async function fetchProxyImage(url: string): Promise<ProxyResult> {
  const hit = cacheGet(url);
  if (hit) return hit;
  const pending = inFlight.get(url);
  if (pending) return pending;
  if (inFlight.size >= MAX_CONCURRENT_FETCHES) return { ok: false, reason: 'busy' };
  const p = (async (): Promise<ProxyResult> => {
    try {
      const fetched = await fetchPublic(url, {
        // No image/avif or image/svg+xml: neither is served, so don't invite
        // a content-negotiating CDN to pick them.
        accept: 'image/webp,image/png,image/jpeg,image/gif,image/x-icon;q=0.9,*/*;q=0.5',
        maxBytes: MAX_IMAGE_BYTES,
        // Many origins label images application/octet-stream (or worse); the
        // magic-byte sniff decides. Only an explicit markup type is refused
        // up front, to skip reading a body that can't pass the sniff.
        acceptContentType: (ct) => !/html|xml|svg/.test(ct),
        allowPartial: false,
      });
      const result: ProxyResult = fetched ? checkImage(fetched.body) : { ok: false, reason: 'unreachable' };
      cachePut(url, result);
      return result;
    } catch {
      return { ok: false, reason: 'unreachable' };
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, p);
  return p;
}

/** Tests only. */
export function __clearMediaProxyCache(): void {
  cache.clear();
  cacheBytes = 0;
}
