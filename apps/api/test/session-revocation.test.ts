import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requireAuth, requireUserId } from '../src/auth/middleware';
import { signAccessToken } from '../src/auth/tokens';
import { errorHandler } from '../src/middleware';
import { blacklistSession, __resetBlacklistStoreToMemory } from '../src/auth/session-blacklist';

// Builds a tiny app whose single route requires auth — exercises the REST
// hot path (requireAuth) end to end without a database. The human JWT path in
// requireAuth does no DB lookup, so this is a faithful integration of the
// revocation check.
function makeApp() {
  const app = new Hono();
  app.onError(errorHandler);
  app.use('*', requireAuth);
  app.get('/me', (c) => c.json({ userId: requireUserId(c).toString() }));
  return app;
}

async function get(app: Hono, token: string) {
  return app.request('/me', { headers: { authorization: `Bearer ${token}` } });
}

describe('session revocation on REST (blacklist)', () => {
  beforeEach(() => {
    __resetBlacklistStoreToMemory();
  });

  it('a valid token authenticates before revocation', async () => {
    const app = makeApp();
    const token = await signAccessToken({ userId: 1n, sessionId: 100n });
    const res = await get(app, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: '1' });
  });

  it('rejects PROMPTLY once its session is blacklisted (not waiting for expiry)', async () => {
    const app = makeApp();
    const token = await signAccessToken({ userId: 1n, sessionId: 200n });

    expect((await get(app, token)).status).toBe(200); // works first

    await blacklistSession(200n); // simulate revokeSession()

    const res = await get(app, token); // same still-valid (unexpired) JWT
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('TOKEN_INVALID');
  });

  it('leaves OTHER sessions unaffected when one is revoked', async () => {
    const app = makeApp();
    const revoked = await signAccessToken({ userId: 1n, sessionId: 300n });
    const kept = await signAccessToken({ userId: 1n, sessionId: 301n });

    await blacklistSession(300n);

    expect((await get(app, revoked)).status).toBe(401);
    expect((await get(app, kept)).status).toBe(200); // a different device keeps working
  });

  it('a fresh session id (re-login) is never caught by a prior revoke', async () => {
    const app = makeApp();
    await blacklistSession(400n); // old session revoked
    const fresh = await signAccessToken({ userId: 1n, sessionId: 401n }); // new login
    expect((await get(app, fresh)).status).toBe(200);
  });

  it('the block lifts after the access-token window elapses (clock-driven)', async () => {
    let now = 2_000_000;
    __resetBlacklistStoreToMemory(() => now);
    const app = makeApp();
    // Re-sign each request so the JWT itself never expires during the test;
    // only the blacklist entry's TTL is under test here.
    await blacklistSession(500n, 30);
    expect((await get(app, await signAccessToken({ userId: 1n, sessionId: 500n }))).status).toBe(401);

    now += 30_001; // blacklist entry has now self-expired
    expect((await get(app, await signAccessToken({ userId: 1n, sessionId: 500n }))).status).toBe(200);
  });
});
