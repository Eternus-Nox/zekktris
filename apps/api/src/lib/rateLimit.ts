/**
 * Rate limiter
 * ------------
 * In-memory sliding-window limiter. Used to throttle auth endpoints:
 *   - login per email (against credential stuffing)
 *   - login per IP   (against IP-targeted brute force)
 *   - register per IP (against signup flooding)
 *
 * Limitations (acceptable for v1):
 *   - State is per-process. With multiple api replicas the effective rate is
 *     roughly N × the configured limit. Document this; switch to Redis-backed
 *     limiter when we add multi-replica support.
 *   - State doesn't survive process restart. Fine — the primary risk is
 *     in-progress brute force, which restarts don't help an attacker with.
 *
 * Buckets are swept lazily on access; no background timer needed.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    private readonly maxCount: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Returns { ok: true } if this consume is within the limit, or
   * { ok: false, retryAfterMs } if blocked.
   */
  consume(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
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

  /** Reset the counter for a key — e.g. after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key);
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
