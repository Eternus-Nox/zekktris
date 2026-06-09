import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryBlacklistStore,
  RedisBlacklistStore,
  blacklistSession,
  isSessionBlacklisted,
  __resetBlacklistStoreToMemory,
} from '../src/auth/session-blacklist';

describe('MemoryBlacklistStore', () => {
  it('reports a key present after add, absent before', async () => {
    const s = new MemoryBlacklistStore();
    expect(await s.has('k')).toBe(false);
    await s.add('k', 100);
    expect(await s.has('k')).toBe(true);
  });

  it('expires entries after the TTL (clock-driven, no real wait)', async () => {
    let now = 1_000_000;
    const s = new MemoryBlacklistStore(() => now);
    await s.add('k', 10); // valid until now + 10_000ms
    expect(await s.has('k')).toBe(true);
    now += 9_999;
    expect(await s.has('k')).toBe(true); // still inside the window
    now += 2; // now past expiry
    expect(await s.has('k')).toBe(false);
  });

  it('does not leak one key into another', async () => {
    const s = new MemoryBlacklistStore();
    await s.add('a', 100);
    expect(await s.has('a')).toBe(true);
    expect(await s.has('b')).toBe(false);
  });
});

describe('RedisBlacklistStore (fail-open)', () => {
  it('add never throws when the redis SET fails', async () => {
    const errs: unknown[] = [];
    const store = new RedisBlacklistStore(
      {
        set: async () => {
          throw new Error('redis down');
        },
        exists: async () => 0,
      },
      (e) => errs.push(e),
    );
    await expect(store.add('k', 60)).resolves.toBeUndefined();
    expect(errs.length).toBe(1);
  });

  it('has() returns false (fail open) when EXISTS throws', async () => {
    const store = new RedisBlacklistStore({
      set: async () => 'OK',
      exists: async () => {
        throw new Error('redis down');
      },
    });
    expect(await store.has('k')).toBe(false);
  });

  it('maps EXISTS=1 to true and 0 to false', async () => {
    const present = new RedisBlacklistStore({ set: async () => 'OK', exists: async () => 1 });
    const absent = new RedisBlacklistStore({ set: async () => 'OK', exists: async () => 0 });
    expect(await present.has('k')).toBe(true);
    expect(await absent.has('k')).toBe(false);
  });

  it('passes the TTL to SET with EX', async () => {
    const calls: unknown[][] = [];
    const store = new RedisBlacklistStore({
      set: async (...args: unknown[]) => {
        calls.push(args);
        return 'OK';
      },
      exists: async () => 0,
    });
    await store.add('zekktris:revoked:session:42', 900);
    expect(calls[0]).toEqual(['zekktris:revoked:session:42', '1', 'EX', 900]);
  });
});

describe('blacklistSession / isSessionBlacklisted (module API)', () => {
  beforeEach(() => {
    __resetBlacklistStoreToMemory();
  });

  it('blacklists a session id and detects it', async () => {
    expect(await isSessionBlacklisted(123n)).toBe(false);
    await blacklistSession(123n, 60);
    expect(await isSessionBlacklisted(123n)).toBe(true);
    // a different session is unaffected
    expect(await isSessionBlacklisted(124n)).toBe(false);
  });

  it('entry self-expires after the access-token window', async () => {
    let now = 5_000_000;
    __resetBlacklistStoreToMemory(() => now);
    await blacklistSession(999n, 30);
    expect(await isSessionBlacklisted(999n)).toBe(true);
    now += 30_001;
    expect(await isSessionBlacklisted(999n)).toBe(false);
  });
});
