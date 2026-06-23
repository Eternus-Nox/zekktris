/**
 * Session revocation blacklist
 * ----------------------------
 * `requireAuth` deliberately avoids a per-request DB lookup — the access-token
 * JWT signature + expiry is enough for the hot path. The cost is that a revoked
 * session's still-valid access token keeps authenticating on REST until the
 * token expires (ACCESS_TOKEN_TTL_SECONDS, 15 min default). The gateway already
 * re-checks and evicts on revoke, but REST didn't.
 *
 * This closes that window. On revoke we add the *session id* to a short-lived
 * blacklist; the auth middleware rejects any access token whose `sid` is listed.
 *
 * Why session id (not a token jti):
 *   - The access JWT carries `sid` (the session id) and has no jti.
 *   - Revocation is per-session (revokeSession / revokeAllUserSessions), so one
 *     blacklist entry per revoked session invalidates *every* access token ever
 *     minted for it — including ones issued seconds before the revoke.
 *   - A fresh login mints a NEW session id, so the blacklist never affects new
 *     sessions. No false positives, no need to track individual tokens.
 *
 * TTL = ACCESS_TOKEN_TTL_SECONDS. A token issued at T is valid until T+TTL; a
 * revoke at R ≥ T sets an entry living [R, R+TTL] ⊇ [R, T+TTL], so the entry
 * always outlives every token it must block, then self-expires — bounding
 * memory. Past that point the JWT `exp` does the rejecting on its own.
 *
 * Backends:
 *   - REDIS_URL set  → a shared Redis key (SET … EX / EXISTS). A revoke on one
 *     replica is seen by all — the same shared-Redis approach the gateway bus
 *     uses for multi-node. One EXISTS per authed REST request.
 *   - REDIS_URL unset → an in-memory TTL map. Correct + free for single-node
 *     (and for tests).
 *
 * Availability: reads fail OPEN (a Redis blip degrades to the old behaviour —
 * eventual revocation via token expiry — rather than locking everyone out).
 */

import Redis from 'ioredis';
import { env } from '../env';

const PREFIX = 'zekktris:revoked:session:';
const keyFor = (sessionId: bigint): string => PREFIX + sessionId.toString();

export interface BlacklistStore {
  add(key: string, ttlSeconds: number): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * In-memory TTL map. The clock is injectable so expiry is testable without
 * real time. Lazy expiry on read keeps it allocation-light; add() also runs a
 * cheap periodic sweep so a burst of revocations (mass-ban, or a password
 * reset revoking many sessions) that are never read back can't grow the map
 * unbounded.
 */
export class MemoryBlacklistStore implements BlacklistStore {
  private readonly map = new Map<string, number>(); // key -> expiry epoch ms
  private lastSweep = 0;
  constructor(private readonly now: () => number = Date.now) {}

  async add(key: string, ttlSeconds: number): Promise<void> {
    const now = this.now();
    this.map.set(key, now + Math.max(1, ttlSeconds) * 1000);
    // At most once a minute, drop expired entries (cheap; prevents a leak
    // under heavy revocation churn that's never read back).
    if (now - this.lastSweep > 60_000) {
      this.lastSweep = now;
      for (const [k, exp] of this.map) {
        if (exp <= now) this.map.delete(k);
      }
    }
  }

  async has(key: string): Promise<boolean> {
    const expiry = this.map.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /** Test helper. */
  clear(): void {
    this.map.clear();
  }
}

/** The tiny slice of an ioredis client this store needs (lets tests inject a
 *  fake without matching ioredis's heavily-overloaded `set` signature). */
export interface RedisKV {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  exists(key: string): Promise<number>;
}

/** Redis-backed store. Both ops fail soft so Redis trouble never breaks auth. */
export class RedisBlacklistStore implements BlacklistStore {
  constructor(
    private readonly redis: RedisKV,
    private readonly onError?: (err: unknown) => void,
  ) {}

  async add(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, '1', 'EX', Math.max(1, Math.ceil(ttlSeconds)));
    } catch (err) {
      // Best-effort: a failed write means the token isn't blocked early, but
      // it still expires on its own. Surface for ops, don't throw.
      this.onError?.(err);
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      return (await this.redis.exists(key)) === 1;
    } catch (err) {
      this.onError?.(err); // fail open
      return false;
    }
  }
}

// ── Module store (lazy-initialized from env) ─────────────────────────────────

let store: BlacklistStore | null = null;
let redisClient: Redis | null = null;

function getStore(): BlacklistStore {
  if (store) return store;
  if (env.REDIS_URL) {
    // Fail-open requires commands to REJECT when Redis is unhealthy. With
    // ioredis defaults (offline queue + unlimited retries) a command issued
    // during an outage is queued forever — `await exists` never settles, and
    // since isSessionBlacklisted is awaited inside requireAuth, EVERY
    // authenticated request on the instance would hang. No offline queue,
    // one retry, hard per-command timeout.
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1000,
      lazyConnect: false,
    });
    // Swallow connection errors here; the per-op try/catch handles request-time
    // failures (fail open). Without this listener ioredis would emit 'error' as
    // an unhandled event and crash the process on a transient blip.
    redisClient.on('error', () => {});
    store = new RedisBlacklistStore(redisClient);
  } else {
    store = new MemoryBlacklistStore();
  }
  return store;
}

/** Add a revoked session to the blacklist for the access-token lifetime. */
export async function blacklistSession(
  sessionId: bigint,
  ttlSeconds: number = env.ACCESS_TOKEN_TTL_SECONDS,
): Promise<void> {
  await getStore().add(keyFor(sessionId), ttlSeconds);
}

/** True if this session was revoked within the access-token window. */
export async function isSessionBlacklisted(sessionId: bigint): Promise<boolean> {
  return getStore().has(keyFor(sessionId));
}

// ── Test seams ───────────────────────────────────────────────────────────────

/** Reset to a fresh in-memory store (tests). Returns it for direct assertions. */
export function __resetBlacklistStoreToMemory(now?: () => number): MemoryBlacklistStore {
  const mem = new MemoryBlacklistStore(now);
  store = mem;
  return mem;
}
