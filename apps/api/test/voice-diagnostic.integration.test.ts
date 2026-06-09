import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { adminRouter } from '../src/routes/admin';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, cleanupAll } from './seed';
import { diagnoseLivekit } from '../src/services/livekitDiagnostic';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping voice-diagnostic route tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/admin', adminRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
async function makeAdmin(userId: bigint): Promise<void> {
  await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId));
}
function get(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

describe('LiveKit diagnostic (service)', () => {
  it('reports per-step pass/fail and never leaks secrets', async () => {
    // The test env sets LIVEKIT_API_KEY/SECRET and LIVEKIT_WS_URL=wss://livekit.test
    // (a non-resolvable .test host), so: credentials/url/token pass, and the
    // server-reachability step fails with a classified message.
    const d = await diagnoseLivekit();
    expect(d.configured).toBe(true);
    const byId = Object.fromEntries(d.checks.map((c) => [c.id, c]));
    expect(byId.credentials!.status).toBe('pass');
    expect(byId.ws_url!.status).toBe('pass');
    expect(byId.token!.status).toBe('pass'); // can sign a token from the key/secret
    expect(byId.server!.status).toBe('fail'); // livekit.test is unreachable
    expect(byId.server!.detail.length).toBeGreaterThan(0);
    expect(d.ok).toBe(false); // a failing step → not OK overall

    // No secret material in the serialized output (only config URLs).
    const blob = JSON.stringify(d);
    expect(blob).not.toContain(process.env.LIVEKIT_API_SECRET);
    expect(blob).not.toContain(process.env.LIVEKIT_API_KEY);
  });
});

describe.runIf(dbReady)('GET /admin/voice-diagnostic (route)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('is admin-gated: 401 unauth, 403 non-admin, 200 for admin', async () => {
    const plain = await createUser();
    const admin = await createUser();
    await makeAdmin(admin);

    expect((await app.request('/admin/voice-diagnostic')).status).toBe(401);
    expect((await get('/admin/voice-diagnostic', await tokenFor(plain))).status).toBe(403);

    const ok = await get('/admin/voice-diagnostic', await tokenFor(admin));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { diagnostic: { configured: boolean; checks: unknown[] } };
    expect(body.diagnostic.configured).toBe(true);
    expect(Array.isArray(body.diagnostic.checks)).toBe(true);
    expect(body.diagnostic.checks.length).toBeGreaterThanOrEqual(3);
  });
});
