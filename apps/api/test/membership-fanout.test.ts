import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import * as dispatch from '../src/gateway/dispatch';
import { eventBus, setEventBus, type EventBus } from '../src/gateway/bus';
import { RedisEventBus, type RedisLike } from '../src/gateway/redis-bus';

// Two "replicas" in one process. Replica A handles the REST request (it holds
// no socket for the user); replica B holds the user's gateway connection.
// Whatever A publishes to Redis is captured and then delivered to B's
// subscriber exactly as Redis pub/sub would (in publish order, tagged with A's
// instance id), so B's registry + internal dispatch subscriber see the real
// wire traffic.

function fakeRedis() {
  const listeners: Array<(ch: string, msg: string) => void> = [];
  const api = {
    published: [] as string[],
    publish(_channel: string, message: string) {
      api.published.push(message);
      return Promise.resolve(1);
    },
    subscribe() {
      return Promise.resolve(1);
    },
    on(_event: 'message', listener: (ch: string, msg: string) => void) {
      listeners.push(listener);
      return api;
    },
    emit(channel: string, message: string) {
      for (const l of listeners) l(channel, message);
    },
  };
  return api;
}

function makeConn(): { conn: Connection; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(s),
    close: () => undefined,
  } as unknown as WebSocket;
  return { conn: new Connection(ws), sent };
}

const ids = (sent: string[]) =>
  sent.map((s) => JSON.parse(s) as { t?: string; d?: { id?: string } }).map((f) => `${f.t}:${f.d?.id ?? ''}`);

const U = 9101n;
const PEER = 9102n;
const G = 7101n;
const CH = 5101n;
const DM = 5201n;

describe('membership snapshots fan out across replicas', () => {
  const original: EventBus = eventBus();
  let pubA: ReturnType<typeof fakeRedis>;
  let subB: ReturnType<typeof fakeRedis>;
  let busA: RedisEventBus;
  let busB: RedisEventBus;
  let live: Connection[];

  /** Run `fn` as replica A: A's bus is active and A's registry holds none of
   *  B's connections (they are unregistered for the duration — the snapshot
   *  lives on the Connection, so re-indexing restores B exactly). Returns what
   *  A published to Redis. */
  function runOnA(fn: () => void): string[] {
    for (const c of live) registry.remove(c);
    setEventBus(busA);
    try {
      fn();
    } finally {
      setEventBus(busB);
      for (const c of live) {
        registry.add(c);
        registry.index(c);
      }
    }
    return pubA.published.splice(0);
  }

  /** Deliver A's Redis traffic to B, in publish order, as pub/sub would. */
  function deliverToB(raws: string[]): void {
    for (const raw of raws) subB.emit('zk-test', raw);
  }

  const onReplicaA = (fn: () => void) => deliverToB(runOnA(fn));

  beforeEach(() => {
    pubA = fakeRedis();
    subB = fakeRedis();
    busA = new RedisEventBus(pubA as RedisLike, fakeRedis() as RedisLike, {
      instanceId: 'A',
      channel: 'zk-test',
    });
    busB = new RedisEventBus(fakeRedis() as RedisLike, subB as RedisLike, {
      instanceId: 'B',
      channel: 'zk-test',
    });
    // Replica B's gateway wiring: registry + internal dispatch subscriber on B's bus.
    registry.shutdown();
    dispatch.shutdownInternalDispatchBus();
    setEventBus(busB);
    registry.init();
    dispatch.initInternalDispatchBus();
    live = [];
  });

  afterEach(() => {
    for (const c of live) registry.remove(c);
    registry.shutdown();
    dispatch.shutdownInternalDispatchBus();
    setEventBus(original);
  });

  function connectOnB(userId: bigint, guildIds: bigint[], dmIds: bigint[]) {
    const r = makeConn();
    r.conn.markAuthenticated(
      userId,
      guildIds,
      dmIds,
      guildIds.map((guildId) => ({ channelId: CH, guildId })),
    );
    registry.add(r.conn);
    registry.index(r.conn);
    live.push(r.conn);
    return r;
  }

  it('a kick/ban handled on A stops guild events to the user on B', () => {
    const b = connectOnB(U, [G], []);

    const raws = runOnA(() => dispatch.userLeftGuild({ userId: U, guildId: G }));
    expect(b.conn.guildIds.has(G)).toBe(true); // A's local update never touches B
    deliverToB(raws);
    expect(b.conn.guildIds.has(G)).toBe(false);
    // B still delivered the removal frames that preceded the snapshot change.
    expect(ids(b.sent)).toEqual(['GUILD_MEMBER_REMOVE:', `GUILD_DELETE:${G}`]);

    onReplicaA(() => dispatch.messageCreate({ messageDTO: { id: 'after' }, channelId: CH, guildId: G }));
    expect(ids(b.sent)).not.toContain('MESSAGE_CREATE:after');
  });

  it('a join handled on A starts guild events to the user on B, member-add included', () => {
    const b = connectOnB(U, [], []);

    onReplicaA(() =>
      dispatch.userJoinedGuild({
        userId: U,
        guildId: G,
        guildDTO: { id: 'guild' },
        memberDTO: { id: 'member' },
        viewableChannelIds: [CH],
      }),
    );
    expect(b.conn.guildIds.has(G)).toBe(true);
    expect(ids(b.sent)).toEqual(['GUILD_CREATE:guild', 'GUILD_MEMBER_ADD:member']);

    onReplicaA(() => dispatch.messageCreate({ messageDTO: { id: 'm1' }, channelId: CH, guildId: G }));
    expect(ids(b.sent)).toContain('MESSAGE_CREATE:m1');
  });

  it('a guild deleted on A is dropped from every member connection on B', () => {
    const b1 = connectOnB(U, [G], []);
    const b2 = connectOnB(PEER, [G], []);

    // A passes the member list it knows; B must not depend on it.
    onReplicaA(() => dispatch.guildDeletedBroadcast({ guildId: G, memberIds: [] }));
    expect(b1.conn.guildIds.has(G)).toBe(false);
    expect(b2.conn.guildIds.has(G)).toBe(false);
    expect(registry.connectedUsersInGuild(G)).toEqual([]);
  });

  it('a DM opened on A routes its messages to the peer on B; closing it on A stops them', () => {
    const b = connectOnB(PEER, [], []);

    onReplicaA(() =>
      dispatch.dmChannelCreated({ channelDTO: { id: 'dm' }, channelId: DM, recipientIds: [U, PEER] }),
    );
    expect(b.conn.dmChannelIds.has(DM)).toBe(true);
    onReplicaA(() => dispatch.messageCreate({ messageDTO: { id: 'd1' }, channelId: DM, guildId: null }));
    expect(ids(b.sent)).toContain('MESSAGE_CREATE:d1');

    onReplicaA(() =>
      dispatch.dmChannelClosedForUser({ channelDTO: { id: 'dm' }, channelId: DM, userId: PEER }),
    );
    expect(b.conn.dmChannelIds.has(DM)).toBe(false);
    onReplicaA(() => dispatch.messageCreate({ messageDTO: { id: 'd2' }, channelId: DM, guildId: null }));
    expect(ids(b.sent)).not.toContain('MESSAGE_CREATE:d2');

    // A DM message send re-subscribes recipients on every replica.
    onReplicaA(() => dispatch.dmSubscribeRecipients({ channelId: DM, recipientIds: [U, PEER] }));
    expect(b.conn.dmChannelIds.has(DM)).toBe(true);
  });

  it('the internal signal is never delivered to a client socket', () => {
    const b = connectOnB(U, [G], []);
    onReplicaA(() => dispatch.dmSubscribeRecipients({ channelId: DM, recipientIds: [U] }));
    expect(b.sent).toEqual([]);
  });
});
