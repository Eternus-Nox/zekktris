/**
 * Quick-login code store
 * ----------------------
 * "Log in on another device": a LOGGED-IN device mints a short-lived, single-
 * use 16-digit code (also encoded in a QR). A LOGGED-OUT device redeems it to
 * receive a brand-new session. This holds the pending code between mint and
 * redeem — single-use, short-lived, and per-user (minting a new code
 * invalidates the user's prior one, so "re-randomize" makes the old one dead).
 *
 * Mirrors the WebAuthn challenge store: Redis (GETDEL single-use) when
 * REDIS_URL is set so mint + redeem can land on different replicas, else an
 * in-memory TTL map. FAIL-CLOSED — if the store is unavailable, redeem finds
 * nothing and rejects, which is the right posture for a login primitive.
 *
 * Security: the code is the whole credential, so it is crypto-random, 90s-TTL,
 * single-use (deleted on redeem), and its redemption is rate-limited per IP in
 * the route. Never logged.
 */
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { env } from '../env';

const CODE_PREFIX = 'zekktris:quicklogin:code:';
const USER_PREFIX = 'zekktris:quicklogin:user:';
const TTL_SECONDS = 90;

/** A crypto-strong 16-digit numeric code (single-use + short-lived, so ~53
    bits of entropy is safe here). */
export function newQuickLoginCode(): string {
  const n = randomBytes(8).readBigUInt64BE() % 10_000_000_000_000_000n;
  return n.toString().padStart(16, '0');
}

interface QuickLoginStore {
  /** Mint a code for a user; invalidates any prior code for that user. */
  create(userId: string): Promise<{ code: string; expiresIn: number }>;
  /** Single-use: return the userId for a code and delete it; null if absent. */
  consume(code: string): Promise<string | null>;
  /** Invalidate the user's active code (they left the section / logged out). */
  cancel(userId: string): Promise<void>;
}

class MemoryQuickLoginStore implements QuickLoginStore {
  private readonly byCode = new Map<string, { userId: string; exp: number }>();
  private readonly byUser = new Map<string, string>(); // userId → active code

  async create(userId: string): Promise<{ code: string; expiresIn: number }> {
    const prior = this.byUser.get(userId);
    if (prior) this.byCode.delete(prior);
    const now = Date.now();
    // Guarantee the code is not already active for ANY user — two users must
    // never hold the same code at once (a collision would let one redeem the
    // other's session). A free-or-expired slot is claimable; retry on the
    // (astronomically rare, ~1e-15/attempt) clash. Single-threaded JS + no
    // await between check and set makes this atomic.
    let code = '';
    for (let i = 0; i < 6; i++) {
      const candidate = newQuickLoginCode();
      const ex = this.byCode.get(candidate);
      if (!ex || ex.exp <= now) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('quick-login: could not allocate a unique code');
    this.byCode.set(code, { userId, exp: now + TTL_SECONDS * 1000 });
    this.byUser.set(userId, code);
    // Opportunistic sweep so abandoned codes can't grow the map.
    if (this.byCode.size > 500) {
      for (const [k, v] of this.byCode) if (v.exp <= now) this.byCode.delete(k);
    }
    return { code, expiresIn: TTL_SECONDS };
  }
  async consume(code: string): Promise<string | null> {
    const v = this.byCode.get(code);
    this.byCode.delete(code);
    if (!v || v.exp <= Date.now()) return null;
    if (this.byUser.get(v.userId) === code) this.byUser.delete(v.userId);
    return v.userId;
  }
  async cancel(userId: string): Promise<void> {
    const code = this.byUser.get(userId);
    this.byUser.delete(userId);
    if (code) this.byCode.delete(code);
  }
}

class RedisQuickLoginStore implements QuickLoginStore {
  constructor(private readonly redis: Redis) {}
  async create(userId: string): Promise<{ code: string; expiresIn: number }> {
    const prior = await this.redis.get(USER_PREFIX + userId);
    if (prior) await this.redis.del(CODE_PREFIX + prior);
    // SET ... NX claims the code atomically ONLY if no other user already holds
    // it, so two users can never share a code (which would cross their
    // sessions). Retry on the astronomically rare clash.
    let code = '';
    for (let i = 0; i < 6; i++) {
      const candidate = newQuickLoginCode();
      const ok = await this.redis.set(CODE_PREFIX + candidate, userId, 'EX', TTL_SECONDS, 'NX');
      if (ok) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('quick-login: could not allocate a unique code');
    await this.redis.set(USER_PREFIX + userId, code, 'EX', TTL_SECONDS);
    return { code, expiresIn: TTL_SECONDS };
  }
  async consume(code: string): Promise<string | null> {
    // GETDEL is atomic single-use (Redis 6.2+).
    const userId = (await this.redis.getdel(CODE_PREFIX + code)) ?? null;
    if (!userId) return null;
    // Clear the user pointer if it still references this (now-consumed) code.
    const cur = await this.redis.get(USER_PREFIX + userId);
    if (cur === code) await this.redis.del(USER_PREFIX + userId);
    return userId;
  }
  async cancel(userId: string): Promise<void> {
    const code = (await this.redis.getdel(USER_PREFIX + userId)) ?? null;
    if (code) await this.redis.del(CODE_PREFIX + code);
  }
}

let store: QuickLoginStore;
if (env.REDIS_URL) {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1000,
  });
  redis.on('error', () => {});
  store = new RedisQuickLoginStore(redis);
} else {
  store = new MemoryQuickLoginStore();
}

export const quickLoginStore = store;
