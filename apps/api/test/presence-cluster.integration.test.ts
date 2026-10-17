import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { Connection } from '../src/gateway/connection';
import { Registry } from '../src/gateway/registry';
import { PresenceEngine, resetPresenceOnBoot } from '../src/gateway/presence';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

// Multi-replica presence (acceptance scenario 9): two "replicas" — each its
// own connection Registry and PresenceEngine with its own instance id — share
// the database and a real Redis. A replica can't see the other's sockets, so
// the effective status must come from the per-replica summaries in Redis,
// and a dead replica's summary must stop counting once stale.

const REDIS_URL = process.env.PRESENCE_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/12';
/** Staleness for the tests that wait for an entry to go stale. Every other
 *  test uses a window no test run comes near, so a slow machine can't age a
 *  live replica's entry out mid-test. */
const STALE_MS = 400;
const NEVER_STALE_MS = 60_000;

const dbReady = await probeDb();
async function probeRedis(): Promise<boolean> {
  const r = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1000,
  });
  r.on('error', () => {});
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const redisReady = dbReady && (await probeRedis());
if (!redisReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping presence cluster tests — no database or Redis reachable');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(url = REDIS_URL): Redis {
  // The production options (gateway/presence.ts): no offline queue, hard timeout.
  const r = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1000,
  });
  r.on('error', () => {});
  return r;
}

const clients: Redis[] = [];
const touchedUsers: bigint[] = [];
const liveConns: Array<{ registry: Registry; conn: Connection }> = [];

function replica(
  id: string,
  opts: { url?: string; staleMs?: number } = {},
): { registry: Registry; engine: PresenceEngine; redis: Redis } {
  const registry = new Registry();
  const redis = client(opts.url);
  clients.push(redis);
  const staleMs = opts.staleMs ?? NEVER_STALE_MS;
  return {
    registry,
    redis,
    engine: new PresenceEngine({ source: registry, redis, instanceId: id, staleMs }),
  };
}

/** A live authenticated connection for `userId` on `registry`. */
function connect(registry: Registry, userId: bigint, active: boolean): Connection {
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: () => undefined,
    close: () => undefined,
  } as unknown as WebSocket;
  const conn = new Connection(ws);
  conn.markAuthenticated(userId, [], [], []);
  conn.presenceActive = active;
  registry.add(conn);
  registry.index(conn);
  liveConns.push({ registry, conn });
  return conn;
}

async function newUser(): Promise<bigint> {
  const u = await createUser();
  touchedUsers.push(u);
  return u;
}

async function statusOf(userId: bigint): Promise<string> {
  const [u] = await db
    .select({ status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u!.status;
}

describe.runIf(redisReady)('presence across replicas (integration, Redis)', () => {
  let admin: Redis;
  beforeAll(() => {
    admin = client();
  });
  afterEach(() => {
    for (const { registry, conn } of liveConns) registry.remove(conn);
    liveConns.length = 0;
  });
  afterAll(async () => {
    if (touchedUsers.length > 0) {
      await admin.del(...touchedUsers.map((u) => `zekktris:presence:u:${u}`));
    }
    for (const r of [admin, ...clients]) r.disconnect();
    await cleanupAll();
    await closeDb();
  });

  it('scenario 9: A idle on replica 1 + B active on replica 2 → online; replica 2 dies → idle after staleness + sweep', async () => {
    const r1 = replica('replica-1', { staleMs: STALE_MS });
    const r2 = replica('replica-2', { staleMs: STALE_MS });
    const u = await newUser();

    connect(r1.registry, u, false);
    expect(await r1.engine.recompute(u)).toBe('idle');
    connect(r2.registry, u, true);
    expect(await r2.engine.recompute(u)).toBe('online');
    // Replica 1 alone would say idle; aggregated it agrees with replica 2.
    expect(await r1.engine.recompute(u)).toBe('online');
    expect(await statusOf(u)).toBe('online');

    // Replica 2 dies: no more heartbeats, no close hooks. Its entry still
    // counts while fresh…
    expect(await r1.engine.sweep({ userIds: [u] })).toBe(0);
    expect(await statusOf(u)).toBe('online');

    // …and stops counting once stale; replica 1 keeps its own fresh.
    await sleep(STALE_MS + 100);
    await r1.engine.heartbeat();
    expect(await r1.engine.sweep({ userIds: [u] })).toBe(1);
    expect(await statusOf(u)).toBe('idle'); // A still connected — not offline, not stuck online
    // The dead replica's field is gone, the live one's kept.
    expect(Object.keys(await admin.hgetall(`zekktris:presence:u:${u}`))).toEqual(['replica-1']);
  });

  it('a replica losing its last socket does not offline a user connected to another replica', async () => {
    const r1 = replica('replica-a');
    const r2 = replica('replica-b');
    const u = await newUser();
    const onR1 = connect(r1.registry, u, true);
    connect(r2.registry, u, false);
    await r1.engine.recompute(u);
    expect(await r2.engine.recompute(u)).toBe('online');

    r1.registry.remove(onR1);
    expect(await r1.engine.recompute(u)).toBe('idle');
    expect(await admin.hexists(`zekktris:presence:u:${u}`, 'replica-a')).toBe(0);
  });

  it('concurrent recomputes on two replicas converge (a stale snapshot cannot win for good)', async () => {
    const A = replica('replica-race-a');
    const B = replica('replica-race-b');
    const u = await newUser();
    const a = connect(A.registry, u, true);
    const b = connect(B.registry, u, true);
    expect(await A.engine.recompute(u)).toBe('online');
    expect(await B.engine.recompute(u)).toBe('online');

    // Both devices go idle at about the same moment. Replica A takes its
    // Redis snapshot while B's entry still reads active, then stalls before
    // reading the row; meanwhile replica B writes online → idle. A then
    // reads 'idle' and its compare-and-set idle → online succeeds.
    a.presenceActive = false;
    b.presenceActive = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = A.engine.clusterSummary.bind(A.engine);
    let calls = 0;
    A.engine.clusterSummary = async (id: bigint) => {
      const summary = await original(id);
      if (++calls === 1) await gate;
      return summary;
    };
    const pending = A.engine.recompute(u);
    await sleep(100);
    expect(await B.engine.recompute(u)).toBe('idle');
    release();
    // A re-validates its write against a fresh snapshot and corrects it.
    expect(await pending).toBe('idle');
    expect(calls).toBeGreaterThan(1);
    expect(await statusOf(u)).toBe('idle');
  });

  it('a device whose replica holds it after its last socket closed stops counting as in use after the close grace', async () => {
    const r1 = replica('replica-mac');
    const r2 = replica('replica-phone');
    const u = await newUser();
    connect(r1.registry, u, false); // the Mac, idle
    const phone = connect(r2.registry, u, true);
    await r1.engine.recompute(u);
    expect(await r2.engine.recompute(u)).toBe('online');

    // The phone's socket was replica 2's last for this user: the gateway
    // holds it through the voice grace (onUserFullyDisconnected)…
    r2.registry.remove(phone);
    liveConns.splice(
      liveConns.findIndex((c) => c.conn === phone),
      1,
    );
    r2.engine.hold(u, true);
    // …counting as in use only until the close grace settles it.
    expect(await r2.engine.recompute(u)).toBe('online');
    expect(r2.engine.settleHold(u)).toBe(true);
    expect(await r2.engine.recompute(u)).toBe('idle');
    // What replica 2 publishes says the same to every replica.
    await r2.engine.heartbeat();
    expect(await r1.engine.recompute(u)).toBe('idle');
    // The hold still keeps the user from reading offline: the Mac leaves too.
    const [mac] = liveConns.filter((c) => c.registry === r1.registry);
    r1.registry.remove(mac!.conn);
    expect(await r1.engine.recompute(u)).toBe('online'); // only held devices left: the last activity, as before
    r2.engine.release(u);
    expect(await r2.engine.recompute(u)).toBe('offline');
  });

  it('a settled hold alone keeps its last activity until released (single-device disconnect timing unchanged)', async () => {
    const r = replica('replica-solo');
    const u = await newUser();
    const dev = connect(r.registry, u, true);
    expect(await r.engine.recompute(u)).toBe('online');
    r.registry.remove(dev);
    r.engine.hold(u, true);
    r.engine.settleHold(u);
    expect(await r.engine.recompute(u)).toBe('online');
    r.engine.release(u);
    expect(await r.engine.recompute(u)).toBe('offline');
  });

  it('the heartbeat recomputes a user whose entry had gone missing (another replica computed without it)', async () => {
    const r1 = replica('replica-mac-2');
    const r2 = replica('replica-phone-2');
    const u = await newUser();
    connect(r1.registry, u, false);
    connect(r2.registry, u, true);
    await r1.engine.recompute(u);
    expect(await r2.engine.recompute(u)).toBe('online');

    // Replica 2 was cut off from Redis long enough for the leader's sweep to
    // drop its entry and recompute the user without the phone.
    await admin.hdel(`zekktris:presence:u:${u}`, 'replica-phone-2');
    expect(await r1.engine.recompute(u)).toBe('idle');
    // Its next heartbeat re-creates the entry, notices, and heals.
    await r2.engine.heartbeat();
    expect(await statusOf(u)).toBe('online');
  });

  it("the heartbeat recomputes users whose last recompute ran on this replica's view alone", async () => {
    const r1 = replica('replica-mac-3');
    const r2 = replica('replica-phone-3');
    const u = await newUser();
    connect(r1.registry, u, true); // the Mac, in use
    const phone = connect(r2.registry, u, true);
    await r1.engine.recompute(u);
    expect(await r2.engine.recompute(u)).toBe('online');

    // Redis fails for replica 2 while its phone goes idle: it can only see
    // its own idle phone and writes idle.
    const failing = r2.redis as unknown as { multi: () => never };
    failing.multi = () => {
      throw new Error('redis down');
    };
    phone.presenceActive = false;
    expect(await r2.engine.recompute(u)).toBe('idle');
    delete (failing as { multi?: unknown }).multi; // Redis is back
    await r2.engine.heartbeat();
    expect(await statusOf(u)).toBe('online'); // the Mac is still in use
  });

  it('boot reset in cluster mode keeps users connected to other replicas', async () => {
    const live = replica('replica-live');
    const connected = await newUser();
    const stranded = await newUser();
    connect(live.registry, connected, true);
    expect(await live.engine.recompute(connected)).toBe('online');
    // A row left "online" by a replica that crashed, with no entry anywhere.
    await db.update(schema.users).set({ status: 'online' }).where(eq(schema.users.id, stranded));

    const booting = replica('replica-booting');
    await resetPresenceOnBoot(booting.engine, { userIds: [connected, stranded] });
    expect(await statusOf(connected)).toBe('online');
    expect(await statusOf(stranded)).toBe('offline');
  });

  it('a gracefully stopping replica withdraws its entries at once', async () => {
    const leaving = replica('replica-leaving');
    const other = replica('replica-staying');
    const u = await newUser();
    connect(leaving.registry, u, true);
    connect(other.registry, u, false);
    await other.engine.recompute(u);
    expect(await leaving.engine.recompute(u)).toBe('online');
    await leaving.engine.withdraw();
    expect(Object.keys(await admin.hgetall(`zekktris:presence:u:${u}`))).toEqual([
      'replica-staying',
    ]);
    // No staleness wait: the next recompute already reads idle.
    expect(await other.engine.recompute(u)).toBe('idle');
  });

  it('the heartbeat heals a user it holds whose row reads offline', async () => {
    const r1 = replica('replica-heal');
    const u = await newUser();
    connect(r1.registry, u, true);
    expect(await r1.engine.recompute(u)).toBe('online');
    // e.g. another replica's boot reset ran while Redis was unreachable.
    await db.update(schema.users).set({ status: 'offline' }).where(eq(schema.users.id, u));
    await r1.engine.heartbeat();
    expect(await statusOf(u)).toBe('online');
  });

  it("Redis unreachable: falls back to this replica's own view (never hangs, never throws)", async () => {
    const down = replica('replica-down', { url: 'redis://127.0.0.1:1/0' });
    const u = await newUser();
    connect(down.registry, u, false);
    const started = Date.now();
    expect(await down.engine.recompute(u)).toBe('idle');
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(down.engine.heartbeat()).resolves.toBeUndefined();
    // The boot reset falls back to the blanket reset (scoped here).
    const stranded = await newUser();
    await db.update(schema.users).set({ status: 'online' }).where(eq(schema.users.id, stranded));
    await resetPresenceOnBoot(down.engine, { userIds: [stranded] });
    expect(await statusOf(stranded)).toBe('offline');
  });
});
