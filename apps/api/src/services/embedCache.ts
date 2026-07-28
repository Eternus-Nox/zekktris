/**
 * Embed (link-preview) cache
 * --------------------------
 * A read-through cache + single-flight collapser in front of
 * `embeds.resolveEmbed`, which does a live outbound DNS + TCP + TLS + HTML
 * fetch every time it is called.
 *
 * Why both, and why neither alone is enough:
 *
 *   CACHE — plaintext messages get their embeds resolved once at send time and
 *   persisted onto the message row forever. An E2EE DM is ciphertext to the
 *   server, so it cannot do that; the CLIENT unfurls instead, via
 *   /api/v1/unfurl, and nothing remembered the answer. Every render, on every
 *   device, on every cold app launch, re-fetched the same URLs indefinitely.
 *
 *   SINGLE-FLIGHT — clients fan their unfurls out concurrently (iOS uses a
 *   TaskGroup, one task per URL per decrypted message). A production log showed
 *   ten unfurls landing inside one second for a single channel open. Every one
 *   of them misses a read-through cache, because none has completed to write an
 *   entry yet. The in-process `inFlight` map is what collapses them to one
 *   outbound fetch; without it the cache does nothing on the very burst that
 *   costs the most.
 *
 * Fails OPEN, like lib/rateLimit.ts: any Redis error degrades to a live fetch
 * rather than an error or an empty preview.
 */

import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import type { MessageEmbedJson } from '@zekktris/db/schema';
import { env } from '../env';

const PREFIX = 'zekktris:embed:v1:';

/** Open Graph tags change rarely; a stale card for a few hours is harmless. */
const TTL_HIT_S = 6 * 60 * 60;

/**
 * Negative entries expire much sooner. A null is usually transient — the site
 * was down, rate-limiting us, or WAF-blocking the preview bot — and those cost
 * a full timeout to rediscover, so they are exactly what we want cached. But a
 * 6-hour negative TTL would keep a recovered site preview-less for the rest of
 * the day.
 */
const TTL_MISS_S = 10 * 60;

/**
 * Refuse to cache anything larger than this. A well-formed embed is a few
 * hundred bytes; anything near this is malformed or hostile markup.
 */
const MAX_CACHED_BYTES = 8 * 1024;

/**
 * URLs are unbounded in length and arbitrary in content, and a raw one would
 * land verbatim in SLOWLOG / MONITOR. Hash for a fixed-size, non-leaking key.
 */
const keyFor = (url: string): string =>
  PREFIX + createHash('sha256').update(url).digest('base64url');

let redis: Redis | null = null;
if (env.REDIS_URL) {
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1000,
  });
  // Swallowed deliberately: a cache outage must not take link previews down.
  redis.on('error', () => {});
}

/** Resolves in flight RIGHT NOW, keyed by url. See the single-flight note above. */
const inFlight = new Map<string, Promise<MessageEmbedJson | null>>();

/**
 * Resolve [url] through the cache, falling back to [fetcher] on a miss.
 *
 * The fetcher is injected rather than imported so this module stays free of a
 * cycle: the dependency runs one way only — embeds.ts imports THIS module, and
 * this module imports nothing from embeds.ts.
 */
export async function cachedResolveEmbed(
  url: string,
  fetcher: (u: string) => Promise<MessageEmbedJson | null>,
  opts: {
    /**
     * Honour a cached negative (a stored `null`). Default true.
     *
     * MUST be false for any caller that PERSISTS the result. A negative entry
     * is by definition transient — the site was down, rate-limiting us, or
     * WAF-blocking the preview bot — and the 10-minute TTL bounds the CACHE,
     * not the damage: `resolveAndPersistEmbeds` writes the answer onto the
     * message row once and never retries, so a borrowed null becomes a
     * permanently preview-less message. It also destroys independence — forty
     * messages sharing a link used to roll the dice separately during a
     * partial outage, and some got cards; with a shared negative, one unlucky
     * roll suppresses all of them, forever.
     *
     * A false here still joins the in-flight collapse and still WRITES its
     * result, so /unfurl keeps every benefit.
     */
    acceptNegative?: boolean;
  } = {},
): Promise<MessageEmbedJson | null> {
  const acceptNegative = opts.acceptNegative !== false;
  if (redis) {
    try {
      const raw = await redis.get(keyFor(url));
      // A stored literal "null" is a NEGATIVE entry; only `raw === null` (key
      // absent) is a real miss. Conflating the two would make failing URLs
      // re-fetch on every render forever.
      if (raw !== null) {
        const cached = JSON.parse(raw) as MessageEmbedJson | null;
        if (cached !== null || acceptNegative) return cached;
        // Cached negative, but this caller can't use one — fall through and
        // resolve live.
      }
    } catch {
      // Fail open to a live fetch.
    }
  }

  const existing = inFlight.get(url);
  if (existing) return existing;

  const pending = (async (): Promise<MessageEmbedJson | null> => {
    // resolveEmbed is documented never to throw, but a cache must not be the
    // thing that changes that contract for its callers.
    let embed: MessageEmbedJson | null = null;
    try {
      embed = await fetcher(url);
    } catch {
      embed = null;
    }
    if (redis) {
      const payload = JSON.stringify(embed);
      // Size cap: an embed's url/imageUrl/faviconUrl come straight from
      // attacker-controlled markup, and an `og:image` href can be as large as
      // the page itself. Without this, one account could write ~100 MB/min of
      // 6-hour entries into a Redis that has no maxmemory and `noeviction` —
      // and that Redis also carries the session blacklist, whose lookup FAILS
      // OPEN, so exhausting it would silently un-revoke sessions. Oversized
      // embeds are still returned to the caller, just never stored.
      if (payload.length <= MAX_CACHED_BYTES) {
        try {
          await redis.set(keyFor(url), payload, 'EX', embed ? TTL_HIT_S : TTL_MISS_S);
        } catch {
          // Best effort; the value is still returned to this caller.
        }
      }
    }
    return embed;
  })();

  inFlight.set(url, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(url);
  }
}
