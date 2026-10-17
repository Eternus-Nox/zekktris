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
const STALE_MS = 400;

const dbReady = await probeDb();
async function probeRedis(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1000 });
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

function replica(id: string, url?: string): { registry: Registry; engine: PresenceEngine } {
  const registry = new Registry();
  const redis = client(url);
  clients.push(redis);
  return { registry, engine: new PresenceEngine({ source: registry, redis, instanceId: id, staleMs: STALE_MS }) };
}

/** A live authenticated connection for `userId` on `registry`. */
function connect(registry: Registry, userId: bigint, active: boolean): Connection {
  const ws = { readyState: 1, OPEN: 1, send: () => undefined, close: () => undefined } as unknown as WebSocket;
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
    const r1 = replica('replica-1');
    const r2 = replica('replica-2');
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
    expect(Object.keys(await admin.hgetall(`zekktris:presence:u:${u}`))).toEqual(['replica-staying']);
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

  it('Redis unreachable: falls back to this replica\'s own view (never hangs, never throws)', async () => {
    const down = replica('replica-down', 'redis://127.0.0.1:1/0');
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
