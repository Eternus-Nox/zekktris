import { describe, it, expect, afterEach } from 'vitest';
import { RateLimiter, __setRateLimitRedis, type RateLimitRedis } from '../src/lib/rateLimit';

/** A fake ioredis that simulates the limiter's fixed-window Lua script
 *  (INCR + set-expiry-on-first + PTTL) entirely in memory, so the Redis code
 *  path is exercised deterministically without a real server. */
function fakeRedis(): RateLimitRedis & { store: Map<string, { count: number; expireAt: number }> } {
  const store = new Map<string, { count: number; expireAt: number }>();
  return {
    store,
    async eval(_script: string, _numKeys: number, ...args: (string | number)[]) {
      const key = String(args[0]);
      const windowMs = Number(args[1]);
      const now = Date.now();
      let e = store.get(key);
      if (!e || e.expireAt <= now) {
        e = { count: 0, expireAt: now + windowMs };
        store.set(key, e);
      }
      e.count++;
      return [e.count, Math.max(0, e.expireAt - now)];
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
  };
}

describe('RateLimiter — in-memory backend (no Redis)', () => {
  afterEach(() => __setRateLimitRedis(undefined));

  it('allows up to max requests per window, then blocks with a retry-after', async () => {
    __setRateLimitRedis(null); // force the in-memory path
    const rl = new RateLimiter(3, 60_000, 't-mem');
    expect((await rl.consume('k')).ok).toBe(true);
    expect((await rl.consume('k')).ok).toBe(true);
    expect((await rl.consume('k')).ok).toBe(true);
    const blocked = await rl.consume('k');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // A different key has its own window.
    expect((await rl.consume('other')).ok).toBe(true);
  });

  it('reset clears the counter for a key', async () => {
    __setRateLimitRedis(null);
    const rl = new RateLimiter(1, 60_000, 't-mem-reset');
    expect((await rl.consume('k')).ok).toBe(true);
    expect((await rl.consume('k')).ok).toBe(false); // 1 allowed, 2nd blocked
    await rl.reset('k');
    expect((await rl.consume('k')).ok).toBe(true); // window cleared
  });
});

describe('RateLimiter — Redis backend', () => {
  afterEach(() => __setRateLimitRedis(undefined));

  it('shares a window across instances (the multi-node property) and enforces the limit', async () => {
    const redis = fakeRedis();
    __setRateLimitRedis(redis);
    // Two SEPARATE limiter instances with the same name = same Redis keyspace,
    // i.e. two replicas. They share one window.
    const a = new RateLimiter(3, 60_000, 'shared');
    const b = new RateLimiter(3, 60_000, 'shared');
    expect((await a.consume('k')).ok).toBe(true); // count 1
    expect((await b.consume('k')).ok).toBe(true); // count 2 (shared!)
    expect((await a.consume('k')).ok).toBe(true); // count 3
    const blocked = await b.consume('k'); // count 4 > 3
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // Distinct limiter names don't collide.
    const other = new RateLimiter(3, 60_000, 'different');
    expect((await other.consume('k')).ok).toBe(true);
  });

  it('reset deletes the Redis key', async () => {
    const redis = fakeRedis();
    __setRateLimitRedis(redis);
    const rl = new RateLimiter(1, 60_000, 'r-reset');
    expect((await rl.consume('k')).ok).toBe(true);
    expect((await rl.consume('k')).ok).toBe(false);
    await rl.reset('k');
    expect(redis.store.has('zekktris:ratelimit:r-reset:k')).toBe(false);
    expect((await rl.consume('k')).ok).toBe(true);
  });

  it('FAILS OPEN when Redis errors — never blocks or throws', async () => {
    const throwing: RateLimitRedis = {
      async eval() {
        throw new Error('redis unreachable');
      },
      async del() {
        throw new Error('redis unreachable');
      },
    };
    __setRateLimitRedis(throwing);
    const rl = new RateLimiter(1, 60_000, 'fail-open');
    // Even past the nominal limit, a Redis error allows the request.
    for (let i = 0; i < 5; i++) {
      const r = await rl.consume('k');
      expect(r.ok).toBe(true);
    }
    // reset never throws either.
    await expect(rl.reset('k')).resolves.toBeUndefined();
  });
});
