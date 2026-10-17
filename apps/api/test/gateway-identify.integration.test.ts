import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';

// Real gateway on a real http.Server, driven by a real ws client: IDENTIFY /
// RESUME ban checks and the connect / identify rate limits. Env is read at
// import, so set the small test limits (and proxy trust, so each test can
// pick its own client IP via X-Real-IP) BEFORE importing the app modules.
const ENV_KEYS = {
  GATEWAY_CONNECTS_PER_MINUTE_PER_IP: '5',
  GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER: '3',
  TRUST_PROXY: 'true',
};
const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(ENV_KEYS)) {
  saved[k] = process.env[k];
  process.env[k] = v;
}

const { default: WebSocket } = await import('ws');
const { eq } = await import('drizzle-orm');
const { GatewayOp } = await import('@zekktris/shared/events');
const { db, schema } = await import('../src/db');
const { attachGateway, detachGateway } = await import('../src/gateway/server');
const { createSession } = await import('../src/auth/sessions');
const { signAccessToken } = await import('../src/auth/tokens');
const { createUser, cleanupAll } = await import('./seed');
const { probeDb, closeDb } = await import('./db-available');

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping gateway identify tests — no database reachable');
}

/** A fresh client IP per test, so per-IP windows never leak between tests
 *  (or between runs, when REDIS_URL backs the limiter). */
const freshIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

type Outcome =
  | { kind: 'ready' }
  | { kind: 'resumed' }
  | { kind: 'invalid_session'; code: number }
  /** RESUME refused non-fatally (INVALID_SESSION, socket left open). */
  | { kind: 'resume_rejected' }
  | { kind: 'closed'; code: number; reason: string }
  | { kind: 'http'; status: number };

describe.runIf(dbReady)('gateway IDENTIFY/RESUME (integration)', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer();
    // No boot presence reset: it would offline other test files' users.
    attachGateway(server, { resetPresenceOnBoot: false });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
  });

  afterAll(async () => {
    detachGateway();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanupAll();
    await closeDb();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function tokenFor(userId: bigint): Promise<string> {
    const { session } = await createSession({ userId, userAgent: 'vitest', ipAddress: null });
    return signAccessToken({ userId, sessionId: session.id });
  }

  /** Open a socket from `ip`, answer HELLO with `first`, report what happened. */
  function attempt(
    ip: string,
    first: (ws: InstanceType<typeof WebSocket>) => void,
  ): Promise<Outcome> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers: { 'x-real-ip': ip } });
      let invalid = false;
      const done = (o: Outcome) => {
        resolve(o);
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
      };
      ws.on('unexpected-response', (_req, res) => done({ kind: 'http', status: res.statusCode ?? 0 }));
      ws.on('error', () => {});
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as { op: number; t?: string };
        if (f.op === GatewayOp.HELLO) first(ws);
        else if (f.op === GatewayOp.INVALID_SESSION) {
          invalid = true;
          // A fatal rejection closes right after; a refused RESUME leaves the
          // socket open for IDENTIFY. Give the close a moment to arrive.
          setTimeout(() => done({ kind: 'resume_rejected' }), 200);
        }
        else if (f.op === GatewayOp.DISPATCH && f.t === 'READY') done({ kind: 'ready' });
        else if (f.op === GatewayOp.DISPATCH && f.t === 'RESUMED') done({ kind: 'resumed' });
      });
      ws.on('close', (code, reason) =>
        done(invalid ? { kind: 'invalid_session', code } : { kind: 'closed', code, reason: reason.toString() }),
      );
    });
  }

  const identify = (ip: string, token: string) =>
    attempt(ip, (ws) => ws.send(JSON.stringify({ op: GatewayOp.IDENTIFY, d: { token } })));

  const resume = (ip: string, token: string) =>
    attempt(ip, (ws) =>
      ws.send(JSON.stringify({ op: GatewayOp.RESUME, d: { token, session_id: 'none', seq: 0 } })),
    );

  async function ban(userId: bigint, bannedUntil: Date | null): Promise<void> {
    await db
      .update(schema.users)
      .set({ bannedAt: new Date(Date.now() - 60_000), bannedUntil })
      .where(eq(schema.users.id, userId));
  }

  it('IDENTIFY: an EXPIRED timed ban is not a ban (READY)', async () => {
    const u = await createUser();
    await ban(u, new Date(Date.now() - 1000));
    expect(await identify(freshIp(), await tokenFor(u))).toEqual({ kind: 'ready' });
  });

  it('IDENTIFY: an ACTIVE timed ban and a permanent ban are rejected (4004)', async () => {
    const timed = await createUser();
    await ban(timed, new Date(Date.now() + 3_600_000));
    expect(await identify(freshIp(), await tokenFor(timed))).toEqual({
      kind: 'invalid_session',
      code: 4004,
    });

    const perm = await createUser();
    await ban(perm, null);
    expect(await identify(freshIp(), await tokenFor(perm))).toEqual({
      kind: 'invalid_session',
      code: 4004,
    });
  });

  it('RESUME: an expired timed ban falls through to the session lookup; an active one is rejected', async () => {
    const expired = await createUser();
    await ban(expired, new Date(Date.now() - 1000));
    // Authenticated fine; the unknown session id then asks for a fresh
    // IDENTIFY (INVALID_SESSION without closing the socket), not a 4004.
    const r = await new Promise<Outcome>((resolve) => {
      void tokenFor(expired).then((token) => {
        const ws = new WebSocket(url, { headers: { 'x-real-ip': freshIp() } });
        ws.on('message', (raw) => {
          const f = JSON.parse(raw.toString()) as { op: number };
          if (f.op === GatewayOp.HELLO) {
            ws.send(JSON.stringify({ op: GatewayOp.RESUME, d: { token, session_id: 'none', seq: 0 } }));
          } else if (f.op === GatewayOp.INVALID_SESSION) {
            // Socket must still be open (non-fatal) → re-IDENTIFY succeeds.
            ws.send(JSON.stringify({ op: GatewayOp.IDENTIFY, d: { token } }));
          } else if (f.op === GatewayOp.DISPATCH) {
            resolve({ kind: 'ready' });
            ws.terminate();
          }
        });
        ws.on('close', (code, reason) => resolve({ kind: 'closed', code, reason: reason.toString() }));
      });
    });
    expect(r).toEqual({ kind: 'ready' });

    const active = await createUser();
    await ban(active, new Date(Date.now() + 3_600_000));
    expect(await resume(freshIp(), await tokenFor(active))).toEqual({
      kind: 'invalid_session',
      code: 4004,
    });
  });

  it('IDENTIFY/RESUME attempts are limited per user with 4008 and no INVALID_SESSION', async () => {
    const u = await createUser();
    const token = await tokenFor(u);
    // Budget 3, shared by IDENTIFY and RESUME, across different IPs.
    expect(await identify(freshIp(), token)).toEqual({ kind: 'ready' });
    expect(await resume(freshIp(), token)).toEqual({ kind: 'resume_rejected' });
    expect(await identify(freshIp(), token)).toEqual({ kind: 'ready' });
    expect(await identify(freshIp(), token)).toEqual({
      kind: 'closed',
      code: 4008,
      reason: 'rate limited',
    });
    expect(await resume(freshIp(), token)).toEqual({
      kind: 'closed',
      code: 4008,
      reason: 'rate limited',
    });
    // Another user is unaffected.
    const other = await createUser();
    expect(await identify(freshIp(), await tokenFor(other))).toEqual({ kind: 'ready' });
  });

  it('upgrades are limited per client IP with HTTP 429; other IPs are unaffected', async () => {
    const ip = freshIp();
    const noop = () => {};
    for (let i = 0; i < 5; i++) {
      // Within budget: the upgrade completes (HELLO arrives) — we just hang up
      // before IDENTIFY, which still counts as a connect.
      const r = await new Promise<string>((resolve) => {
        const ws = new WebSocket(url, { headers: { 'x-real-ip': ip } });
        ws.on('error', noop);
        ws.on('unexpected-response', (_q, res) => resolve(`http ${res.statusCode}`));
        ws.on('message', () => {
          resolve('hello');
          ws.terminate();
        });
      });
      expect(r).toBe('hello');
    }
    expect(await identify(ip, 'unused')).toEqual({ kind: 'http', status: 429 });
    expect((await identify(freshIp(), 'not-a-token')).kind).toBe('invalid_session');
  });
});
