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

async function setAutoIdle(userId: bigint): Promise<void> {
  await db
    .update(schema.users)
    .set({ chosenStatus: 'idle', chosenStatusAuto: true })
    .where(eq(schema.users.id, userId));
}

async function chosenOf(userId: bigint): Promise<{ chosenStatus: string; auto: boolean }> {
  const [u] = await db
    .select({ chosenStatus: schema.users.chosenStatus, auto: schema.users.chosenStatusAuto })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u!;
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

  it('a legacy automatic away: updated devices in use and pre-update connections are summed across replicas', async () => {
    const r1 = replica('replica-1');
    const r2 = replica('replica-2');
    const u = await newUser();
    const oldPhone = connect(r1.registry, u, true); // an old phone build: active, never reports
    const mac = connect(r2.registry, u, false);
    mac.reportsActivity = true;
    await r2.engine.recompute(u);
    expect(await r1.engine.recompute(u)).toBe('online');
    // The old phone's automatic away: the old device no longer counts, and
    // the Mac on the other replica is idle.
    await setAutoIdle(u);
    expect(await r1.engine.recompute(u)).toBe('idle');

    // The Mac comes into use: replica 2 publishes it (r)…
    mac.presenceActive = true;
    expect(await r2.engine.recompute(u)).toBe('online');
    expect(JSON.parse((await admin.hget(`zekktris:presence:u:${u}`, 'replica-2'))!)).toMatchObject({
      l: 1,
      a: 1,
      r: 1,
    });
    // …and the old phone on replica 1 (g) keeps the away standing.
    expect(JSON.parse((await admin.hget(`zekktris:presence:u:${u}`, 'replica-1'))!)).toMatchObject({
      l: 1,
      a: 1,
      g: 1,
    });
    expect(await chosenOf(u)).toEqual({ chosenStatus: 'idle', auto: true });
    // The Mac idles again: the old phone, connected but untouched, doesn't
    // hold them online.
    mac.presenceActive = false;
    expect(await r2.engine.recompute(u)).toBe('idle');
    mac.presenceActive = true;
    expect(await r2.engine.recompute(u)).toBe('online');

    // The old phone leaves replica 1; replica 1 sees no old device anywhere
    // and the Mac in use on replica 2: the away ends.
    r1.registry.remove(oldPhone);
    expect(await r1.engine.recompute(u)).toBe('online');
    expect(await chosenOf(u)).toEqual({ chosenStatus: 'online', auto: false });
  });

  it('a legacy automatic away: a held device counts as in use only if it was an updated one', async () => {
    const r1 = replica('replica-1');
    const r2 = replica('replica-2');
    const u = await newUser();
    connect(r1.registry, u, true); // the old phone, auto-idle below
    await setAutoIdle(u);
    expect(await r1.engine.recompute(u)).toBe('idle'); // publishes replica 1's entry
    // The Mac (updated, in use) on replica 2 drops its socket: through the
    // close grace it still counts as in use — no idle blip on a reconnect.
    r2.engine.hold(u, true, true);
    expect(await r2.engine.recompute(u)).toBe('online');
    // Once settled it stops counting (something else is still connected).
    r2.engine.settleHold(u);
    expect(await r2.engine.recompute(u)).toBe('idle');
    r2.engine.release(u);
    // A held pre-update device never counts while the away stands.
    const r3 = replica('replica-3');
    await r3.engine.whenReady(); // else its first recompute runs on its own view
    r3.engine.hold(u, true, false);
    expect(await r3.engine.recompute(u)).toBe('idle');
    r3.engine.release(u);
    await r3.engine.recompute(u);
    expect(await chosenOf(u)).toEqual({ chosenStatus: 'idle', auto: true });
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

  it('a replica cut off from Redis (Postgres still reachable) does not flap its users offline/online every sweep', async () => {
    const leader = replica('replica-leader-p', { staleMs: STALE_MS });
    const part = replica('replica-partitioned', { staleMs: STALE_MS });
    const u = await newUser();
    connect(part.registry, u, true);
    expect(await part.engine.recompute(u)).toBe('online');

    // The partition: the replica's Redis client now reaches nothing.
    const healthy = part.redis;
    const swap = (r: Redis) => {
      (part.engine as unknown as { redis: Redis }).redis = r;
    };
    const dead = client('redis://127.0.0.1:1/0');
    clients.push(dead);
    swap(dead);

    // Its entry goes stale; the leader's sweep reads the user as gone.
    const seen: string[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await sleep(STALE_MS + 50);
      await leader.engine.sweep({ userIds: [u] });
      seen.push(await statusOf(u));
      // The partitioned replica's heartbeat fails its Redis pipeline: it
      // must not "heal" the row from its own view (the next sweep would
      // just undo it, broadcasting both ways every cycle).
      await part.engine.heartbeat();
      seen.push(await statusOf(u));
    }
    expect(seen).toEqual(['offline', 'offline', 'offline', 'offline', 'offline', 'offline']);

    // Redis is back: the first heartbeat re-creates the swept entry and heals.
    swap(healthy);
    await part.engine.heartbeat();
    expect(await statusOf(u)).toBe('online');
    // And the leader agrees from now on.
    await leader.engine.sweep({ userIds: [u] });
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
    // The boot reset resets nothing: a blanket reset would offline users on
    // other replicas, which can't heal them while Redis is down. A stale row
    // waits for the leader's sweep once Redis is back.
    const stranded = await newUser();
    await db.update(schema.users).set({ status: 'online' }).where(eq(schema.users.id, stranded));
    await resetPresenceOnBoot(down.engine, { userIds: [stranded] });
    expect(await statusOf(stranded)).toBe('online');
    const back = replica('replica-back', { staleMs: STALE_MS });
    // A fresh client rejects commands until connected (no offline queue).
    await back.engine.whenReady();
    await back.engine.sweep({ userIds: [stranded] });
    expect(await statusOf(stranded)).toBe('offline');
  });
});
