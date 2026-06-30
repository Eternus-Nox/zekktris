/**
 * WebAuthn challenge store
 * ------------------------
 * A WebAuthn ceremony is two requests: `options` (server issues a random
 * challenge) then `verify` (client signs it). The challenge must be held
 * between them, single-use, and short-lived.
 *
 * Differences from the session blacklist (which this mirrors structurally):
 *   - Keyed by an OPAQUE random `challengeId` returned to the client, NOT a
 *     user id — discoverable login has no user at options-time.
 *   - SINGLE-USE: `take()` deletes on read, so a challenge can't be replayed.
 *   - FAIL-CLOSED: if the store is unavailable, verify finds no challenge and
 *     rejects. A login ceremony failing closed is correct (vs the blacklist,
 *     which fails open so a Redis blip doesn't lock everyone out).
 *
 * Backends: Redis when REDIS_URL is set (so the options + verify requests can
 * land on different replicas), else an in-memory TTL map (correct for
 * single-node + tests).
 */
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { env } from '../env';

const PREFIX = 'zekktris:webauthn:challenge:';
const TTL_SECONDS = 120;

/** Opaque, unguessable id the client echoes back from options → verify. */
export function newChallengeId(): string {
  return randomBytes(18).toString('base64url');
}

interface ChallengeStore {
  put(id: string, challenge: string): Promise<void>;
  /** Returns the challenge and removes it (single-use); null if absent/expired. */
  take(id: string): Promise<string | null>;
}

class MemoryChallengeStore implements ChallengeStore {
  private readonly map = new Map<string, { challenge: string; exp: number }>();
  async put(id: string, challenge: string): Promise<void> {
    const now = Date.now();
    this.map.set(id, { challenge, exp: now + TTL_SECONDS * 1000 });
    // Opportunistic sweep so abandoned ceremonies can't grow the map.
    if (this.map.size > 500) {
      for (const [k, v] of this.map) if (v.exp <= now) this.map.delete(k);
    }
  }
  async take(id: string): Promise<string | null> {
    const v = this.map.get(id);
    this.map.delete(id);
    if (!v || v.exp <= Date.now()) return null;
    return v.challenge;
  }
}

class RedisChallengeStore implements ChallengeStore {
  constructor(private readonly redis: Redis) {}
  async put(id: string, challenge: string): Promise<void> {
    await this.redis.set(PREFIX + id, challenge, 'EX', TTL_SECONDS);
  }
  async take(id: string): Promise<string | null> {
    // GETDEL is atomic single-use (Redis 6.2+).
    return (await this.redis.getdel(PREFIX + id)) ?? null;
  }
}

let store: ChallengeStore;
if (env.REDIS_URL) {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1000,
  });
  // Swallow connection errors — a store error surfaces as a rejected ceremony
  // (fail-closed), not an unhandled crash.
  redis.on('error', () => {});
  store = new RedisChallengeStore(redis);
} else {
  store = new MemoryChallengeStore();
}

export const challengeStore = store;
