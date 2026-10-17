import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { env } from '../src/env';
import { errorHandler } from '../src/middleware';
import { mediaProxyRouter } from '../src/routes/mediaProxy';
import { unfurlRouter } from '../src/routes/unfurl';
import { messagesRouter } from '../src/routes/messages';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { __setResolveOverride } from '../src/services/embeds';
import sharp from 'sharp';
import {
  __clearMediaProxyCache,
  checkImage,
  imageDimensions,
  sniffImageType,
  MAX_IMAGE_BYTES,
} from '../src/services/mediaProxy';
import {
  MEDIA_PROXY_PATH,
  proxiedImageUrl,
  signMediaUrl,
  verifyMediaSignature,
} from '../src/lib/mediaProxyUrl';
import { createUser, createGuild, addMember, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping media-proxy tests — no database reachable');
}

// A real 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** A PNG signature + IHDR declaring the given size (no pixel data). */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  PNG.copy(b, 0, 0, 12); // signature + IHDR length
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const app = new Hono();
app.onError(errorHandler);
app.route('/api/v1/media-proxy', mediaProxyRouter);
app.route('/api/v1/unfurl', unfurlRouter);
app.route('/api/v1/channels', messagesRouter);

/** Upstream: a local server reached as <name>.test through the resolve
    override (and refused by the real SSRF check as 127.0.0.1). */
let upstream: Server;
let port = 0;
const hits: Record<string, number> = {};

function routeUpstream(path: string, res: import('node:http').ServerResponse): void {
  switch (path) {
    case '/ok.png':
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      return;
    case '/octet':
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PNG);
      return;
    case '/svg-as-png':
      res
        .writeHead(200, { 'content-type': 'image/png' })
        .end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      return;
    case '/html-as-png':
      res.writeHead(200, { 'content-type': 'image/png' }).end('<!doctype html><script>alert(1)</script>');
      return;
    case '/svg':
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      return;
    case '/bomb.png':
      res.writeHead(200, { 'content-type': 'image/png' }).end(pngHeader(20_000, 20_000));
      return;
    case '/huge-chunked': {
      // No Content-Length: the streamed byte cap has to catch it.
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(PNG);
      res.end(Buffer.alloc(MAX_IMAGE_BYTES));
      return;
    }
    case '/huge-declared':
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) });
      res.end(Buffer.alloc(MAX_IMAGE_BYTES + 1));
      return;
    case '/redirect-private':
      res.writeHead(302, { location: `http://127.0.0.1:${port}/ok.png` }).end();
      return;
    case '/page':
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<html><head><title>T</title>
         <meta property="og:image" content="http://img.test:${port}/ok.png">
         <link rel="icon" href="/fav.ico"></head></html>`,
      );
      return;
    default:
      res.writeHead(404).end();
  }
}

function proxyPath(url: string, sig = signMediaUrl(url)): string {
  return `${MEDIA_PROXY_PATH}?u=${encodeURIComponent(url)}&s=${sig}`;
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    routeUpstream(path, res);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  port = (upstream.address() as AddressInfo).port;
  __setResolveOverride((host) => (host.endsWith('.test') ? { ip: '127.0.0.1', family: 4 } : undefined));
});

afterAll(async () => {
  __setResolveOverride(null);
  await new Promise((r) => upstream.close(r));
});

afterEach(() => __clearMediaProxyCache());

describe('media proxy URLs', () => {
  it('rewrites third-party http(s) URLs to signed same-origin proxy paths', () => {
    const raw = 'https://img.example/a b.png?x=1&y=+';
    const out = proxiedImageUrl(raw)!;
    expect(out.startsWith(`${MEDIA_PROXY_PATH}?`)).toBe(true);
    const q = new URL(out, 'http://h').searchParams;
    expect(q.get('u')).toBe(raw);
    expect(verifyMediaSignature(raw, q.get('s')!)).toBe(true);
    // Deterministic, so clients can cache by URL.
    expect(proxiedImageUrl(raw)).toBe(out);
  });

  it('keeps same-origin paths, unwraps this server’s own origin, drops other schemes', () => {
    expect(proxiedImageUrl('/cdn/1/a.png')).toBe('/cdn/1/a.png');
    expect(proxiedImageUrl(`${new URL(env.PUBLIC_URL).origin}/cdn/1/a.png?v=2`)).toBe('/cdn/1/a.png?v=2');
    expect(proxiedImageUrl('javascript:alert(1)')).toBeNull();
    expect(proxiedImageUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(proxiedImageUrl('//evil.example/a.png')).toBeNull();
    expect(proxiedImageUrl(null)).toBeNull();
    expect(proxiedImageUrl('')).toBeNull();
  });

  it('rejects a signature for a different URL, a tampered one, or none', () => {
    const sig = signMediaUrl('https://a.example/x.png');
    expect(verifyMediaSignature('https://a.example/x.png', sig)).toBe(true);
    expect(verifyMediaSignature('https://a.example/y.png', sig)).toBe(false);
    expect(verifyMediaSignature('https://a.example/x.png', sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(verifyMediaSignature('https://a.example/x.png', '')).toBe(false);
  });
});

describe('image sniffing', () => {
  it('reads type and declared size for every served format', async () => {
    const base = sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } });
    const cases: Array<[string, Buffer]> = [
      ['image/jpeg', await base.clone().jpeg().toBuffer()],
      ['image/gif', await base.clone().gif().toBuffer()],
      ['image/png', await base.clone().png().toBuffer()],
      ['image/webp', await base.clone().removeAlpha().webp().toBuffer()], // VP8
      ['image/webp', await base.clone().webp({ lossless: true }).toBuffer()], // VP8L
      ['image/webp', await base.clone().webp().toBuffer()], // VP8X (alpha)
    ];
    for (const [type, buf] of cases) {
      expect(sniffImageType(buf)).toBe(type);
      expect(imageDimensions(buf, type as 'image/png')).toEqual({ width: 300, height: 200 });
      expect(checkImage(buf).ok).toBe(true);
    }
    // ICO: one 32×32 entry.
    const ico = Buffer.alloc(6 + 16);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    ico[6] = 32;
    ico[7] = 32;
    expect(sniffImageType(ico)).toBe('image/x-icon');
    expect(checkImage(ico).ok).toBe(true);
  });

  it('refuses markup, truncated headers and oversized dimensions', () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<!doctype html>'))).toBeNull();
    expect(checkImage(PNG.subarray(0, 18))).toEqual({ ok: false, reason: 'not-image' });
    expect(checkImage(pngHeader(9000, 10))).toEqual({ ok: false, reason: 'too-large' });
    expect(checkImage(pngHeader(7000, 7000))).toEqual({ ok: false, reason: 'too-large' }); // 49 MP
    expect(checkImage(pngHeader(1200, 630)).ok).toBe(true);
  });
});

describe('GET /api/v1/media-proxy', () => {
  it('serves a signed image with the sniffed type and locked-down headers', async () => {
    const url = `http://img.test:${port}/octet`;
    const res = await app.request(proxyPath(url));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png'); // sniffed, not octet-stream
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d{6,}/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('caches: a second request does not reach the upstream', async () => {
    const url = `http://img.test:${port}/ok.png`;
    const before = hits['/ok.png'] ?? 0;
    expect((await app.request(proxyPath(url))).status).toBe(200);
    expect((await app.request(proxyPath(url))).status).toBe(200);
    expect(hits['/ok.png']).toBe(before + 1);
  });

  it('refuses a bad or missing signature without fetching', async () => {
    const url = `http://img.test:${port}/ok.png`;
    const before = hits['/ok.png'] ?? 0;
    expect((await app.request(proxyPath(url, signMediaUrl(`${url}?other`)))).status).toBe(403);
    expect((await app.request(`${MEDIA_PROXY_PATH}?u=${encodeURIComponent(url)}`)).status).toBe(400);
    expect(hits['/ok.png'] ?? 0).toBe(before);
  });

  it('never fetches private, loopback or link-local targets, even when signed', async () => {
    const before = hits['/ok.png'] ?? 0;
    for (const url of [
      `http://127.0.0.1:${port}/ok.png`,
      `http://localhost:${port}/ok.png`,
      `http://[::1]:${port}/ok.png`,
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/a.png',
      'http://192.168.1.1/a.png',
    ]) {
      expect((await app.request(proxyPath(url))).status, url).toBe(502);
    }
    // A public-looking host that redirects to loopback is caught on the hop.
    const redirects = hits['/redirect-private'] ?? 0;
    expect((await app.request(proxyPath(`http://img.test:${port}/redirect-private`))).status).toBe(502);
    expect(hits['/redirect-private']).toBe(redirects + 1);
    expect(hits['/ok.png'] ?? 0).toBe(before);
  });

  it('refuses anything that is not a raster image, whatever the upstream says', async () => {
    expect((await app.request(proxyPath(`http://img.test:${port}/svg-as-png`))).status).toBe(415);
    expect((await app.request(proxyPath(`http://img.test:${port}/html-as-png`))).status).toBe(415);
    // Declared markup types are refused before the body is read.
    expect((await app.request(proxyPath(`http://img.test:${port}/svg`))).status).toBe(502);
    expect((await app.request(proxyPath(`http://img.test:${port}/page`))).status).toBe(502);
  });

  it('enforces the byte and dimension caps', async () => {
    expect((await app.request(proxyPath(`http://img.test:${port}/huge-chunked`))).status).toBe(502);
    expect((await app.request(proxyPath(`http://img.test:${port}/huge-declared`))).status).toBe(502);
    expect((await app.request(proxyPath(`http://img.test:${port}/bomb.png`))).status).toBe(413);
  });

  it('rate-limits upstream fetches per client IP', async () => {
    const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
    // Distinct URLs, so every request is a cache miss. Blocked targets fail
    // fast without network.
    const statuses: number[] = [];
    for (let i = 0; i < 301; i++) {
      statuses.push((await app.request(proxyPath(`http://10.0.0.1/${i}.png`), {}, from('203.0.113.7'))).status);
    }
    expect(statuses.slice(0, 300).every((s) => s === 502)).toBe(true);
    expect(statuses[300]).toBe(429);
    // Another client is unaffected.
    expect((await app.request(proxyPath('http://10.0.0.1/x.png'), {}, from('203.0.113.8'))).status).toBe(502);
  });
});

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

describe.runIf(dbReady)('embed image URLs leave the server proxied (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('message DTOs carry proxy URLs for every embed image field', async () => {
    const owner = await createUser();
    const guild = await createGuild(owner);
    await addMember(guild, owner);
    const channel = await createChannel(guild);
    const messageId = await createMessage(channel, { authorId: owner, content: 'https://site.example' });
    await db
      .update(schema.messages)
      .set({
        embeds: [
          {
            url: 'https://site.example',
            kind: 'link',
            title: 'Site',
            description: null,
            imageUrl: 'https://cdn.site.example/og.png',
            siteName: 'Site',
            faviconUrl: 'http://site.example/favicon.ico',
          },
          {
            url: '',
            kind: 'rich',
            title: 'Hook',
            description: null,
            imageUrl: `${new URL(env.PUBLIC_URL).origin}/cdn/9/own.png`,
            siteName: null,
            faviconUrl: null,
            authorName: 'A',
            authorIconUrl: 'https://a.example/icon.png',
            thumbnailUrl: 'https://a.example/thumb.png',
            footerText: 'F',
            footerIconUrl: 'https://a.example/foot.png',
          },
        ],
      })
      .where(eq(schema.messages.id, messageId));

    const res = await app.request(`/api/v1/channels/${channel}/messages?limit=5`, {
      headers: { authorization: `Bearer ${await tokenFor(owner)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const list = (Array.isArray(body) ? body : (body as { messages: unknown[] }).messages) as Array<{
      id: string;
      embeds: Array<Record<string, string | null>>;
    }>;
    const msg = list.find((m) => m.id === messageId.toString())!;
    const [link, rich] = msg.embeds as [Record<string, string | null>, Record<string, string | null>];

    const expectProxied = (value: string | null | undefined, upstreamUrl: string) => {
      expect(value).toBe(proxiedImageUrl(upstreamUrl));
      expect(value!.startsWith(`${MEDIA_PROXY_PATH}?u=`)).toBe(true);
    };
    expectProxied(link.imageUrl, 'https://cdn.site.example/og.png');
    expectProxied(link.faviconUrl, 'http://site.example/favicon.ico');
    expectProxied(rich.authorIconUrl, 'https://a.example/icon.png');
    expectProxied(rich.thumbnailUrl, 'https://a.example/thumb.png');
    expectProxied(rich.footerIconUrl, 'https://a.example/foot.png');
    expect(rich.imageUrl).toBe('/cdn/9/own.png');
    // The link itself is untouched.
    expect(link.url).toBe('https://site.example');

    // The row keeps the raw URLs; only the wire form is rewritten.
    const [row] = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
    expect((row!.embeds as Array<{ imageUrl: string }>)[0]!.imageUrl).toBe('https://cdn.site.example/og.png');
  });

  it('/unfurl returns proxy URLs, and they load through the proxy', async () => {
    const user = await createUser();
    const res = await app.request(
      `/api/v1/unfurl?url=${encodeURIComponent(`http://page.test:${port}/page`)}`,
      { headers: { authorization: `Bearer ${await tokenFor(user)}` } },
    );
    expect(res.status).toBe(200);
    const { embed } = (await res.json()) as { embed: Record<string, string | null> };
    expect(embed.url).toBe(`http://page.test:${port}/page`);
    expect(embed.imageUrl).toBe(proxiedImageUrl(`http://img.test:${port}/ok.png`));
    expect(embed.faviconUrl).toBe(proxiedImageUrl(`http://page.test:${port}/fav.ico`));

    const img = await app.request(embed.imageUrl!);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
  });
});
