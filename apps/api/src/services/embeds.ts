/**
 * Embeds service — link preview (Open Graph) resolution
 * -----------------------------------------------------
 * Given message content, find http(s) URLs, fetch their HTML, extract
 * Open Graph + Twitter Card + <title> metadata, and persist the result
 * onto the message row's `embeds` JSONB column. The send path runs
 * this as a fire-and-forget background job — message create returns
 * immediately, the embed resolves seconds later, and a MESSAGE_UPDATE
 * fans the resolved embeds out to connected clients.
 *
 * Security model:
 *   - SSRF protection: hostnames are resolved BEFORE fetch and
 *     rejected if they resolve to a private/loopback/link-local IP.
 *     We pass the resolved IP to the fetcher with a Host header
 *     pinning the original hostname, so DNS rebinding can't swap a
 *     public IP for a private one mid-flight.
 *   - Body size cap: 2 MB. Streamed read aborts past the cap.
 *   - Time cap: 5 seconds total (DNS + connect + body).
 *   - Content-Type filter: only text/html (no other media types).
 *   - Redirect following: max 3 redirects, each re-validated for
 *     SSRF.
 *
 * Limitations (fine for v1, address if real-world abuse appears):
 *   - We don't honor robots.txt — implicit "can a crawler fetch this?"
 *     check. Public web servers expecting bot traffic should be fine.
 *   - We don't dedup across messages — the same URL hit twice in
 *     close succession will be fetched twice. A small in-memory
 *     LRU could fix this; for now we accept the redundancy.
 *   - HTML parsing is regex-based, not a real DOM. Misses pages with
 *     fancy HTML quirks. Trade-off: zero new dependencies.
 */

import { promises as dns } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { log } from '../log';
import * as dispatch from '../gateway/dispatch';
import type { MessageEmbedJson } from '@zekktris/db/schema';

// ── Tunables ───────────────────────────────────────────────────────────────

const MAX_URLS_PER_MESSAGE = 5;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// ── URL extraction ─────────────────────────────────────────────────────────
//
// Conservative regex: requires a scheme + a host that contains at least
// one dot (rules out "http://localhost"-shaped strings outright, though
// the SSRF check below is the real gate). Stops at whitespace, angle
// brackets, and quotes — enough for the inline-text use case. Markdown
// link syntax `[label](url)` matches because the closing paren is part
// of the URL only when it's balanced; for the common case we accept
// trailing `)` as part of the URL and let the fetcher handle it.
//
// We trim a few common trailing punctuation marks (".,;)") so that
// "check this out: https://example.com." doesn't try to resolve
// "https://example.com.".
const URL_RE = /https?:\/\/[^\s<>"]+/gi;

export function extractUrls(content: string): string[] {
  const matches = content.match(URL_RE) ?? [];
  const cleaned = matches.map((m) => {
    let url = m;
    // Strip trailing punctuation that's almost never intended as part
    // of the URL itself.
    while (url.length > 0 && /[.,;!?)]$/.test(url)) url = url.slice(0, -1);
    return url;
  });
  // Dedupe (preserving order) + cap at MAX_URLS_PER_MESSAGE.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of cleaned) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_URLS_PER_MESSAGE) break;
  }
  return out;
}

// ── SSRF defense ───────────────────────────────────────────────────────────

/**
 * Returns true if the IP address is in a private, loopback, link-local,
 * or otherwise "you shouldn't reach this from a server fetching public
 * URLs" range.
 */
export function isPrivateIp(ip: string): boolean {
  // Tolerate a bracketed literal ([::1]) and an IPv6 zone id (fe80::1%eth0)
  // so a hostname/URL-literal form can't slip an internal target past us.
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);
  // IPv4
  const v4 = addr.split('.').map(Number);
  if (v4.length === 4 && v4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  // IPv6 — a few well-known prefixes.
  const v6 = addr.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique local fc00::/7
  // Link-local fe80::/10. The /10 prefix means the first 10 bits
  // are 1111111010, which in hex is first byte 0xfe and the high
  // nibble of the second byte being 8, 9, a, or b. So fe80:: through
  // febf:ffff:... are all link-local. The previous code only caught
  // fe80 — fe90 / fea0 / feb0 prefixes were slipping through.
  if (
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb')
  ) {
    return true;
  }
  if (v6.startsWith('ff')) return true; // multicast ff00::/8
  // IPv4-mapped (::ffff:*) or IPv4-compatible (::*) IPv6. An attacker can
  // encode a private IPv4 in EITHER the dotted (::ffff:127.0.0.1) OR the
  // two-hextet (::ffff:7f00:1) textual form, and Node's dns.lookup returns the
  // hextet form verbatim — so decode both and recurse. (The old code only
  // stripped the `::ffff:` prefix, catching the dotted form and letting the
  // hextet form — 127.0.0.1, 169.254.169.254 metadata, RFC1918 — through.)
  const embedded = embeddedIpv4(v6);
  if (embedded) return isPrivateIp(embedded);
  // NAT64 well-known prefix 64:ff9b::/96 also embeds an IPv4 in its low 32
  // bits; the server never legitimately fetches through NAT64, so block it.
  if (v6.startsWith('64:ff9b:')) return true;
  return false;
}

/**
 * The embedded dotted IPv4 of an IPv4-mapped/compatible IPv6, or null.
 * Handles ::ffff:1.2.3.4, ::ffff:0102:0304, ::1.2.3.4, ::0102:0304.
 */
function embeddedIpv4(v6: string): string | null {
  const dotted = v6.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1]!;
  const hex = v6.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Resolve a hostname to a single IPv4 (preferred) or IPv6 address that
 * passes the private-IP check. Returns null if all resolved IPs are
 * private (or DNS fails, which the fetcher should treat as "skip").
 */
async function safeResolve(hostname: string): Promise<{ ip: string; family: 4 | 6 } | null> {
  try {
    // Get all addresses; prefer IPv4 because many container/edge
    // networks have broken IPv6 (AAAA records advertise reachable
    // IPv6 but the actual route fails with EHOSTUNREACH, masking as
    // "fetch failed at 155ms"). Sort v4 first, fall back to v6 only
    // if no v4 records exist.
    const records = await dns.lookup(hostname, { all: true, verbatim: false });
    const v4Records = records.filter((r) => r.family === 4);
    const v6Records = records.filter((r) => r.family === 6);
    const ordered = [...v4Records, ...v6Records];
    for (const r of ordered) {
      if (!isPrivateIp(r.address)) {
        return { ip: r.address, family: r.family as 4 | 6 };
      }
    }
    // All addresses were private — log so admins can diagnose
    // (e.g. hostname pointing to a CGNAT IP because the user's ISP
    // does that). Without this log, all-private failures are silent.
    log.info('embed: all resolved addresses are private', {
      hostname,
      addresses: records.map((r) => r.address),
    });
    return null;
  } catch (e) {
    log.info('embed: DNS lookup failed', {
      hostname,
      err: (e as Error).message,
    });
    return null;
  }
}

// ── HTML parsing ───────────────────────────────────────────────────────────

/**
 * Match an HTML meta tag of the form
 *   <meta property="og:title" content="…">
 * or <meta name="description" content="…">. Tolerant of attribute order
 * and single/double quotes. Returns the matched content value, or null.
 *
 * This is intentionally regex-based rather than a real HTML parser
 * because the universe of pages we care about uses well-formed meta
 * tags and we want to avoid pulling in a parser dependency.
 */
function metaContent(html: string, key: string): string | null {
  // Try property= first (OG convention), then name= (Twitter / generic).
  // The capture group grabs the content attribute.
  const patterns = [
    // <meta property="og:foo" content="…">
    new RegExp(
      `<meta\\s+[^>]*property\\s*=\\s*['"]${escape(key)}['"]\\s+[^>]*content\\s*=\\s*['"]([^'"]*)['"]`,
      'i',
    ),
    // <meta content="…" property="og:foo">  (reversed attr order)
    new RegExp(
      `<meta\\s+[^>]*content\\s*=\\s*['"]([^'"]*)['"]\\s+[^>]*property\\s*=\\s*['"]${escape(key)}['"]`,
      'i',
    ),
    // <meta name="foo" content="…">
    new RegExp(
      `<meta\\s+[^>]*name\\s*=\\s*['"]${escape(key)}['"]\\s+[^>]*content\\s*=\\s*['"]([^'"]*)['"]`,
      'i',
    ),
    new RegExp(
      `<meta\\s+[^>]*content\\s*=\\s*['"]([^'"]*)['"]\\s+[^>]*name\\s*=\\s*['"]${escape(key)}['"]`,
      'i',
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m && m[1] ? decodeEntities(m[1].trim()) : null;
}

function htmlFavicon(html: string, baseUrl: URL): string | null {
  // <link rel="icon" href="…"> or rel="shortcut icon"
  const m = html.match(
    /<link\s+[^>]*rel\s*=\s*['"](?:shortcut\s+icon|icon|apple-touch-icon)['"][^>]*href\s*=\s*['"]([^'"]+)['"]/i,
  );
  if (!m || !m[1]) {
    // Default favicon location.
    return new URL('/favicon.ico', baseUrl.origin).href;
  }
  try {
    const u = new URL(m[1], baseUrl);
    // Only surface http(s) favicons. new URL() ignores the base for an
    // absolute href, so an attacker-controlled <link rel=icon> of
    // javascript:/data:/etc. would otherwise pass straight through to the
    // client's <img src>. Drop non-http(s) schemes at the source.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

// ── HTTP fetch with caps ───────────────────────────────────────────────────

/**
 * Fetch a URL and return the body up to MAX_BODY_BYTES, with a total
 * deadline of FETCH_TIMEOUT_MS, following at most MAX_REDIRECTS hops
 * — each of which is re-validated against the SSRF allowlist.
 *
 * Returns null on any failure (DNS miss, private IP, non-200, non-html
 * Content-Type, body cap hit, timeout). Logs a debug line for ops
 * visibility but never throws — the caller should treat null as
 * "give up on this URL".
 */
async function fetchHtml(rawUrl: string): Promise<{ html: string; finalUrl: URL } | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    log.info('embed fetch: invalid URL', { url: rawUrl });
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    log.info('embed fetch: non-http(s) scheme', { url: rawUrl, protocol: url.protocol });
    return null;
  }

  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let redirects = 0;
  let current = url;

  while (true) {
    // Resolve hostname → IP. Reject if private. Re-resolves on each
    // hop because redirects can target a different host.
    const resolved = await safeResolve(current.hostname);
    if (!resolved) {
      log.info('embed fetch: SSRF/DNS rejection', { url: current.href, hostname: current.hostname });
      return null;
    }
    if (Date.now() >= deadline) {
      log.info('embed fetch: deadline exceeded before connect', { url: current.href });
      return null;
    }

    // DNS-rebinding defense: pin this fetch's TCP target to the IP
    // we just resolved + validated. Without pinning, the underlying
    // fetch implementation does its own DNS lookup at connect time,
    // which on a TTL=0 fast-flux record could return a different IP
    // (e.g. an internal address inside the server's private network)
    // between our safeResolve check and the connect. The result would
    // be a request to an internal service while the SSRF gate
    // thought it was talking to the public one.
    //
    // The lookup override returns the validated IP regardless of
    // hostname, so the TCP target is forced. TLS SNI and the HTTP
    // Host header still use `current.hostname` because we pass the
    // URL unchanged — only the lookup callback is replaced.
    //
    // The agent is created per-hop and torn down with destroy() in
    // the finally block. Reusing it across hops would break when
    // redirects change hosts (the pinned IP no longer matches the
    // new hostname). connect.lookup is the documented hook for
    // exactly this kind of guard.
    const pinnedIp = resolved.ip;
    const pinnedFamily = resolved.family;
    const agent = new Agent({
      connect: {
        // undici's connector calls this with { all: true } and expects
        // the result as an ARRAY of { address, family }. The legacy
        // 3-arg dns.lookup form — callback(null, ip, family) — makes
        // undici read `addresses[0].address` off a bare string, get
        // undefined, and throw ERR_INVALID_IP_ADDRESS before connecting
        // (which killed every link preview). Return the array form when
        // `all` is set, and keep the legacy form as a fallback.
        lookup: (_hostname, opts, callback) => {
          if (opts?.all) {
            (
              callback as unknown as (
                err: null,
                addresses: Array<{ address: string; family: number }>,
              ) => void
            )(null, [{ address: pinnedIp, family: pinnedFamily }]);
          } else {
            callback(null, pinnedIp, pinnedFamily);
          }
        },
      },
    });

    const remainingMs = deadline - Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);

    let res: Response;
    try {
      res = (await undiciFetch(current.href, {
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: agent,
        headers: {
          // Mimic the standard preview-bot pattern (Facebook/Slack/
          // Discord all use this shape). The Mozilla prefix is the
          // magic incantation that bypasses Cloudflare / Akamai / AWS
          // WAF default rules that reject non-major-browser UAs as
          // suspected scrapers. The bot-name + contact URL still
          // self-identifies for admins who want to block us.
          'user-agent':
            'Mozilla/5.0 (compatible; Zekktris-LinkPreview/1.0; +https://zekktris.com)',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          // Allow gzip/deflate/br — most sites only serve gzipped HTML
          // and reject uncompressed accept-encoding. undici decompresses
          // transparently so we don't have to handle the encoded body.
          'accept-encoding': 'gzip, deflate, br',
        },
      })) as unknown as Response;
    } catch (e) {
      // undici wraps lower-level errors in TypeError("fetch failed").
      // The actual cause (DNS/TLS/socket/etc) lives on `.cause`, and
      // typically has a `.code` we can log to identify the layer.
      const err = e as { message?: string; cause?: { message?: string; code?: string; errno?: number } };
      log.info('embed fetch: network/abort error', {
        url: current.href,
        message: err.message ?? String(e),
        causeMessage: err.cause?.message,
        causeCode: err.cause?.code,
        causeErrno: err.cause?.errno,
      });
      // Best-effort agent teardown so we don't leak the connection
      // pool when fetch throws (DNS failure, abort, etc).
      void agent.destroy().catch(() => undefined);
      return null;
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects manually (so we re-validate SSRF).
    if (res.status >= 300 && res.status < 400) {
      // Drain the response body so the agent's connection can be
      // released back to the pool before we tear the agent down.
      // Otherwise Node's open-handle tracker complains under tests
      // and the connection sticks around longer than needed.
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      void agent.destroy().catch(() => undefined);
      const loc = res.headers.get('location');
      if (!loc) {
        log.info('embed fetch: redirect without Location header', { url: current.href, status: res.status });
        return null;
      }
      if (++redirects > MAX_REDIRECTS) {
        log.info('embed fetch: too many redirects', { url: current.href });
        return null;
      }
      try {
        current = new URL(loc, current);
      } catch {
        log.info('embed fetch: invalid redirect target', { url: current.href, location: loc });
        return null;
      }
      continue;
    }

    if (res.status !== 200) {
      log.info('embed fetch: non-200 status', { url: current.href, status: res.status });
      void agent.destroy().catch(() => undefined);
      return null;
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('html')) {
      log.info('embed fetch: non-HTML content type', { url: current.href, contentType: ct });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      void agent.destroy().catch(() => undefined);
      return null;
    }

    // Stream the body up to MAX_BODY_BYTES, then abort.
    if (!res.body) {
      void agent.destroy().catch(() => undefined);
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_BODY_BYTES) {
            try {
              await reader.cancel();
            } catch {
              // Best-effort cancel; if it throws we just bail.
            }
            break;
          }
          chunks.push(value);
        }
        if (Date.now() >= deadline) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          break;
        }
      }
    } catch (e) {
      log.debug?.('embed body read failed', { url: current.href, err: String(e) });
      void agent.destroy().catch(() => undefined);
      return null;
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    // Best-effort utf-8 decode; the meta-tag matches we run later only
    // care about ASCII syntax so misdecoded body bytes mostly lose us
    // non-ASCII title text without breaking the rest of the parse.
    const html = buf.toString('utf8');
    // Release the connection pool now that the body is fully read.
    // Fire-and-forget — the cleanup doesn't need to complete before
    // we return the parsed HTML to the caller.
    void agent.destroy().catch(() => undefined);
    return { html, finalUrl: current };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a single MessageEmbedJson from a URL by fetching + parsing.
 * Returns null if any step fails — callers filter nulls out.
 */
export async function resolveEmbed(rawUrl: string): Promise<MessageEmbedJson | null> {
  const fetched = await fetchHtml(rawUrl);
  if (!fetched) return null;
  const { html, finalUrl } = fetched;

  const title = metaContent(html, 'og:title') ?? htmlTitle(html);
  const description =
    metaContent(html, 'og:description') ?? metaContent(html, 'description');
  const siteName = metaContent(html, 'og:site_name');
  const rawImage = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image');
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      const u = new URL(rawImage, finalUrl);
      // Only surface http(s) images. new URL() ignores the base for an
      // absolute href, so an attacker-controlled og:image of
      // javascript:/data:/etc. would otherwise reach the client's <img src>.
      if (u.protocol === 'http:' || u.protocol === 'https:') imageUrl = u.href;
    } catch {
      // ignore — bad og:image is recoverable, just no image
    }
  }
  const faviconUrl = htmlFavicon(html, finalUrl);

  // Bail if we got literally nothing useful — saves clients from
  // rendering an empty card.
  if (!title && !description && !imageUrl) {
    log.info('embed: no extractable metadata', { url: rawUrl, finalUrl: finalUrl.href });
    return null;
  }

  log.info('embed: extracted', {
    url: rawUrl,
    finalUrl: finalUrl.href,
    hasTitle: !!title,
    hasDescription: !!description,
    hasImage: !!imageUrl,
    siteName: siteName ?? null,
  });

  return {
    url: rawUrl,
    kind: 'link',
    title: title ? truncate(title, 200) : null,
    description: description ? truncate(description, 400) : null,
    imageUrl,
    siteName: siteName ? truncate(siteName, 80) : null,
    faviconUrl,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Resolve all URLs in a message's content concurrently, persist the
 * result, and broadcast a MESSAGE_UPDATE so connected clients see
 * the embeds appear inline.
 *
 * This is fire-and-forget from the route's perspective: the send
 * handler calls `void resolveAndPersistEmbeds(...)` and returns
 * immediately. We swallow all errors here so a misbehaving fetch
 * can't bubble up into the user's send response after the fact.
 */
export async function resolveAndPersistEmbeds(args: {
  messageId: bigint;
  channelId: bigint;
  guildId: bigint | null;
  content: string;
}): Promise<void> {
  const urls = extractUrls(args.content);
  log.info('embed pipeline: start', {
    messageId: args.messageId.toString(),
    urlCount: urls.length,
    urls: urls.slice(0, 5), // cap to avoid spamming the log with mega-messages
  });
  if (urls.length === 0) {
    // No URLs — write [] so the message moves out of "embeds: null"
    // (loading state) into "embeds: []" (terminal state). Saves the
    // client from showing a "loading" hint forever.
    try {
      await db
        .update(schema.messages)
        .set({ embeds: [] })
        .where(eq(schema.messages.id, args.messageId));
    } catch (e) {
      log.warn?.('embed persist (empty) failed', { messageId: args.messageId.toString(), err: String(e) });
    }
    return;
  }

  // Resolve in parallel. Each URL has its own timeout so a slow site
  // doesn't gate the rest. Promise.all without rejection handling is
  // fine because resolveEmbed never throws.
  let resolved: MessageEmbedJson[];
  try {
    const results = await Promise.all(urls.map((u) => resolveEmbed(u)));
    resolved = results.filter((r): r is MessageEmbedJson => r !== null);
    log.info('embed pipeline: resolved', {
      messageId: args.messageId.toString(),
      requested: urls.length,
      succeeded: resolved.length,
    });
  } catch (e) {
    log.warn?.('embed batch resolve threw', { err: String(e) });
    resolved = [];
  }

  try {
    await db
      .update(schema.messages)
      .set({ embeds: resolved })
      .where(eq(schema.messages.id, args.messageId));
    log.info('embed pipeline: persisted', {
      messageId: args.messageId.toString(),
      count: resolved.length,
    });
  } catch (e) {
    log.warn?.('embed persist failed', { messageId: args.messageId.toString(), err: String(e) });
    return;
  }

  // Broadcast a MESSAGE_UPDATE so clients see the embed appear. We
  // don't have a cheap "patch" event — we send the full message DTO,
  // which is what every other message update does. This duplicates
  // a small portion of the route-layer DTO rebuild; promoting it to a
  // shared helper is a fine future cleanup.
  try {
    const { eq: eqOp, and: andOp, isNull: isNullOp } = await import('drizzle-orm');
    const { toMessage, toForwardSource, toPoll } = await import('../lib/dto');
    const messages = await import('./messages');
    const polls = await import('./polls');

    const rows = await db
      .select()
      .from(schema.messages)
      .where(eqOp(schema.messages.id, args.messageId))
      .limit(1);
    const m = rows[0];
    if (!m) return;

    // Parallelize every per-message lookup. They're independent and
    // touch different tables; the previous sequential `await`s here
    // serialized 7+ round-trips, which on a busy channel with many
    // link-bearing messages added several hundred ms of unnecessary
    // wait between the embed save and the gateway broadcast clients
    // actually see. Each promise carries its own narrow shape so the
    // destructuring lines stay readable.
    const [
      authorRows,
      attachmentMap,
      reactionRows,
      umRows,
      rmRows,
      pollMap,
      forwardSources,
    ] = await Promise.all([
      m.authorId !== null
        ? db
            .select()
            .from(schema.users)
            .where(andOp(eqOp(schema.users.id, m.authorId), isNullOp(schema.users.deletedAt)))
            .limit(1)
        : Promise.resolve([]),
      messages.loadAttachments([m.id]),
      db.select().from(schema.reactions).where(eqOp(schema.reactions.messageId, m.id)),
      db
        .select()
        .from(schema.messageUserMentions)
        .where(eqOp(schema.messageUserMentions.messageId, m.id)),
      db
        .select()
        .from(schema.messageRoleMentions)
        .where(eqOp(schema.messageRoleMentions.messageId, m.id)),
      polls.loadPollsForMessages([m.id], null),
      m.forwardedFromMessageId
        ? messages.loadForwardSources([m.forwardedFromMessageId])
        : Promise.resolve(null),
    ]);

    const author = authorRows[0] ?? null;
    const reactionAgg: Array<{ emoji: string; count: number; userIds: bigint[] }> = [];
    for (const r of reactionRows) {
      const ex = reactionAgg.find((x) => x.emoji === r.emoji);
      if (ex) {
        ex.count++;
        ex.userIds.push(r.userId);
      } else reactionAgg.push({ emoji: r.emoji, count: 1, userIds: [r.userId] });
    }

    const pollEntry = pollMap.get(m.id);

    let forwardedFrom = null;
    if (m.forwardedFromMessageId && forwardSources) {
      const sm = forwardSources.messages.get(m.forwardedFromMessageId) ?? null;
      forwardedFrom = toForwardSource({
        sourceMessageId: m.forwardedFromMessageId,
        sourceMessage: sm,
        sourceAuthor: sm?.authorId ? forwardSources.authors.get(sm.authorId) ?? null : null,
        sourceChannel: sm ? forwardSources.channels.get(sm.channelId) ?? null : null,
        sourceAttachments: forwardSources.attachments.get(m.forwardedFromMessageId) ?? [],
      });
    }

    // Sticker snapshot. Same lazy-import pattern as the rest of this
    // dispatch path; only loaded when the message actually has one.
    // Kept out of the parallel block above because it dynamic-imports
    // the stickers module, and the import dance dominates the latency
    // for messages without a sticker — we'd be wasting the cost on
    // most paths. For messages with stickers it's one extra round-trip
    // after the parallel block resolves; the typical Discord-style
    // link-preview message has no sticker.
    let sticker = null;
    if (m.stickerId) {
      const stickers = await import('./stickers');
      const { toSticker } = await import('../lib/dto');
      const sr = await stickers.getSticker(m.stickerId);
      if (sr) sticker = toSticker(sr);
    }

    const dto = toMessage({
      message: m,
      author,
      attachments: attachmentMap.get(m.id) ?? [],
      reactions: reactionAgg,
      mentionedUserIds: umRows.map((x) => x.userId),
      mentionedRoleIds: rmRows.map((x) => x.roleId),
      poll: pollEntry ? toPoll(pollEntry) : null,
      sticker,
      forwardedFrom,
    });
    dispatch.messageUpdate({
      messageDTO: dto,
      channelId: args.channelId,
      guildId: args.guildId,
    });
  } catch (e) {
    log.warn?.('embed dispatch failed', { messageId: args.messageId.toString(), err: String(e) });
  }
}
