import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { adminRouter } from '../src/routes/admin';
import { healthRouter } from '../src/routes/health';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, createGuild, cleanupAll } from './seed';
import { gatherMetrics, toPrometheus } from '../src/services/metrics';
import { env } from '../src/env';
import { timingSafeEqual } from 'node:crypto';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping metrics tests — no database reachable');
}

// Mount the real admin router (carries requireAuth + requireAdmin). The
// Prometheus /metrics handler lives in server.ts; rather than spin up the full
// app we replicate its exact gating logic here against the same `env` value,
// and assert the default-deny behavior the security model depends on.
const app = new Hono();
app.onError(errorHandler);
app.route('/admin', adminRouter);
app.route('/health', healthRouter);
app.get('/metrics', async (c) => {
  const token = env.METRICS_TOKEN;
  if (!token) return c.notFound();
  const auth = c.req.header('authorization');
  const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return c.text('unauthorized\n', 401);
  const m = await gatherMetrics();
  return c.text(toPrometheus(m), 200, { 'content-type': 'text/plain; version=0.0.4' });
});

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
async function makeAdmin(userId: bigint): Promise<void> {
  await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId));
}
function authedGet(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

describe.runIf(dbReady)('instance metrics', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('gatherMetrics returns the full shape with real numbers', async () => {
    const u = await createUser();
    await createGuild(u, 0n);
    const m = await gatherMetrics();

    // Structure
    expect(m.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof m.process.workerId).toBe('number');
    expect(m.gateway).toHaveProperty('connections');
    expect(m.gateway).toHaveProperty('onlineUsers');
    // DB health was just exercised by the counts → ok + a measured latency.
    expect(m.db.ok).toBe(true);
    expect(m.db.latencyMs).toBeGreaterThanOrEqual(0);
    // Counts reflect at least what we just created.
    expect(m.counts.users).toBeGreaterThanOrEqual(1);
    expect(m.counts.guilds).toBeGreaterThanOrEqual(1);
    expect(m.voice).toEqual({ rooms: expect.any(Number), participants: expect.any(Number) });
    expect(m.scheduledMessages).toEqual({ pending: expect.any(Number), due: expect.any(Number) });
    // redis.healthy is null unless a Redis bus is active (tests use in-memory).
    expect(m.redis.configured).toBe(!!env.REDIS_URL);
    expect(typeof m.generatedAt).toBe('string');
  });

  it('toPrometheus renders valid exposition text', async () => {
    const m = await gatherMetrics();
    const text = toPrometheus(m);
    expect(text).toMatch(/# TYPE zekktris_gateway_connections gauge/);
    expect(text).toMatch(/^zekktris_uptime_seconds \d+$/m);
    expect(text).toMatch(/^zekktris_db_up [01]$/m);
    expect(text).toMatch(/^zekktris_users_total \d+$/m);
    // Every metric line is `name value` with a numeric value.
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      expect(line).toMatch(/^zekktris_[a-z0-9_]+ -?\d+(\.\d+)?$/);
    }
  });

  it('GET /admin/metrics: 403 for a non-admin, 200 + metrics for an admin', async () => {
    const plain = await createUser();
    const admin = await createUser();
    await makeAdmin(admin);

    const denied = await authedGet('/admin/metrics', await tokenFor(plain));
    expect(denied.status).toBe(403);

    const ok = await authedGet('/admin/metrics', await tokenFor(admin));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { metrics: { gateway: unknown; counts: { users: number } } };
    expect(body.metrics).toHaveProperty('gateway');
    expect(body.metrics.counts.users).toBeGreaterThanOrEqual(2);
  });

  it('GET /admin/metrics requires authentication', async () => {
    const res = await app.request('/admin/metrics');
    expect(res.status).toBe(401);
  });

  it('GET /metrics is disabled (404) when METRICS_TOKEN is unset', async () => {
    // The test env sets no METRICS_TOKEN, so the scrape endpoint must be
    // off entirely — the default-deny security property.
    expect(env.METRICS_TOKEN).toBeUndefined();
    const res = await app.request('/metrics');
    expect(res.status).toBe(404);
    // And even with a bogus token it stays 404 (no existence signal).
    const res2 = await app.request('/metrics', { headers: { authorization: 'Bearer anything' } });
    expect(res2.status).toBe(404);
  });
});
