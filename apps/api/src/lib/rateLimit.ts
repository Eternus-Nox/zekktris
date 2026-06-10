/**
 * Rate limiter
 * ------------
 * Fixed-window limiter used to throttle abuse-prone endpoints:
 *   - login per email (against credential stuffing)
 *   - login per IP   (against IP-targeted brute force)
 *   - register per IP (against signup flooding)
 *   - webhook execution, family-link + friend-request bursts
 *
 * Two backends, selected at runtime (mirrors auth/session-blacklist.ts):
 *   - REDIS_URL set  → a SHARED Redis counter (atomic INCR + PEXPIRE via a tiny
 *     Lua script). All api replicas share one window, so the effective limit is
 *     the configured limit regardless of replica count — the multi-node story.
 *   - REDIS_URL unset → an in-memory per-process counter. Correct + free for
 *     single-node and tests. **This path is behavior-identical to the original
 *     limiter**, so single-node deployments see no change.
 *
 * Availability: the Redis path FAILS OPEN. Any Redis error (blip, timeout,
 * unreachable) is swallowed and the request is ALLOWED — a cache problem must
 * never lock every user out or hard-fail requests. The trade-off during an
 * outage is the same as having no limiter, which is acceptable (and bounded —
 * the window self-heals when Redis returns).
 *
 * Each limiter instance carries a unique `name` so its Redis keys don't collide
 * with another limiter's. In-memory buckets are swept lazily on access.
 */

import Redis from 'ioredis';
import { env } from '../env';

interface Bucket {
  count: number;
  resetAt: number;
}

export type ConsumeResult = { ok: true } | { ok: false; retryAfterMs: number };

/** The minimal ioredis surface this module uses. Lets tests inject a fake. */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

// Atomic fixed-window: increment the counter; on the FIRST hit of a window set
// the expiry (so the window doesn't slide on later hits); return the post-incr
// count and the remaining TTL (ms) for the retry-after.
const WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {c, redis.call('PTTL', KEYS[1])}
`;

// ── Shared Redis client (lazy, one per process, reused by every limiter) ─────

let redisClient: RateLimitRedis | null = null;
let redisInit = false;
/** When set by a test, overrides env-based init (null = force in-memory). */
let redisOverride: RateLimitRedis | null | undefined;

function getRedis(): RateLimitRedis | null {
  if (redisOverride !== undefined) return redisOverride;
  if (redisInit) return redisClient;
  redisInit = true;
  if (env.REDIS_URL) {
    // The fail-open guarantee above depends on commands REJECTING when Redis
    // is unhealthy. With ioredis defaults (offline queue on, unlimited
    // retries) a command issued during an outage is queued indefinitely —
    // `await eval` neither resolves nor rejects, and every limited endpoint
    // (login, register, …) hangs instead of failing open. So: no offline
    // queue (reject immediately while disconnected), one retry, and a hard
    // per-command timeout for the connected-but-unresponsive case.
    const client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1000,
      lazyConnect: false,
    });
    // Swallow connection-level errors; per-op try/catch handles request-time
    // failures (fail open). Without this listener a transient blip would emit
    // an unhandled 'error' event and crash the process.
    client.on('error', () => {});
    redisClient = client;
  } else {
    redisClient = null;
  }
  return redisClient;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly maxCount: number,
    private readonly windowMs: number,
    /** Unique namespace so this limiter's Redis keys don't collide with
     *  another's. Defaults to the limit shape if omitted (back-compat). */
    private readonly name: string = `rl-${maxCount}-${windowMs}`,
  ) {}

  private redisKey(key: string): string {
    return `zekktris:ratelimit:${this.name}:${key}`;
  }

  /**
   * Returns { ok: true } if this consume is within the limit, or
   * { ok: false, retryAfterMs } if blocked. Async: the Redis backend is
   * network-bound; the in-memory backend resolves synchronously.
   */
  async consume(key: string): Promise<ConsumeResult> {
    const redis = getRedis();
    if (!redis) return this.consumeMemory(key);
    try {
      const res = (await redis.eval(WINDOW_LUA, 1, this.redisKey(key), this.windowMs)) as
        | [number | string, number | string]
        | null;
      const count = Number(res?.[0] ?? 0);
      const ttl = Number(res?.[1] ?? 0);
      if (count > this.maxCount) {
        // PTTL can be -1 (no expiry, shouldn't happen) / -2 (key gone) — fall
        // back to the full window so retry-after is never negative.
        return { ok: false, retryAfterMs: ttl > 0 ? ttl : this.windowMs };
      }
      return { ok: true };
    } catch {
      // Fail OPEN — a Redis problem must not block or hard-fail requests.
      return { ok: true };
    }
  }

  /** Reset the counter for a key — e.g. after a successful login. */
  async reset(key: string): Promise<void> {
    const redis = getRedis();
    if (!redis) {
      this.buckets.delete(key);
      return;
    }
    try {
      await redis.del(this.redisKey(key));
    } catch {
      // Best-effort; a missed reset just means the existing window stands.
    }
  }

  // ── In-memory backend (behavior-identical to the original limiter) ─────────

  private consumeMemory(key: string): ConsumeResult {
    const now = Date.now();
    this.maybeSweep(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true };
    }
    if (bucket.count >= this.maxCount) {
      return { ok: false, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count++;
    return { ok: true };
  }

  /** Drop expired buckets at most once per window. Cheap and prevents leak. */
  private maybeSweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) {
      if (b.resetAt < now) this.buckets.delete(k);
    }
  }
}

// ── Test seams ───────────────────────────────────────────────────────────────

/** Override the backing Redis client. `null` forces the in-memory path;
 *  `undefined` restores env-based selection. Tests only. */
export function __setRateLimitRedis(client: RateLimitRedis | null | undefined): void {
  redisOverride = client;
  // Reset the lazy-init latch so a subsequent real getRedis() re-evaluates env.
  if (client === undefined) {
    redisInit = false;
    redisClient = null;
  }
}
