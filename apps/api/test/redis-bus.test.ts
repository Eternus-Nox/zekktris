import { describe, it, expect } from 'vitest';
import {
  encodeAudience,
  decodeAudience,
  serializeEvent,
  deserializeEvent,
  RedisEventBus,
  type RedisLike,
} from '../src/gateway/redis-bus';
import type { PublishedEvent } from '../src/gateway/bus';
import type { Audience } from '../src/gateway/types';

const ev = (over: Partial<PublishedEvent> = {}): PublishedEvent => ({
  t: 'MESSAGE_CREATE' as PublishedEvent['t'],
  d: {},
  audience: { kind: 'user', userId: 1n },
  ...over,
});

/** Minimal in-test stand-in for an ioredis client. */
function fakeRedis() {
  const listeners: Array<(ch: string, msg: string) => void> = [];
  const api = {
    published: [] as Array<{ channel: string; message: string }>,
    subscribedTo: [] as string[],
    publish(channel: string, message: string) {
      api.published.push({ channel, message });
      return Promise.resolve(1);
    },
    subscribe(channel: string) {
      api.subscribedTo.push(channel);
      return Promise.resolve(1);
    },
    on(_event: 'message', listener: (ch: string, msg: string) => void) {
      listeners.push(listener);
      return api;
    },
    quit() {
      return Promise.resolve('OK');
    },
    /** test helper — simulate Redis delivering a message on a channel */
    emit(channel: string, message: string) {
      for (const l of listeners) l(channel, message);
    },
  };
  return api;
}

describe('audience codec', () => {
  it('round-trips every audience kind, preserving bigints', () => {
    const cases: Audience[] = [
      { kind: 'user', userId: 123n },
      { kind: 'guild', guildId: 456n },
      { kind: 'channel', channelId: 789n, guildId: 42n },
      { kind: 'channel', channelId: 789n, guildId: null }, // DM channel
      { kind: 'users', userIds: [1n, 2n, 3n] },
    ];
    for (const a of cases) {
      expect(decodeAudience(encodeAudience(a))).toEqual(a);
    }
  });
});

describe('event serialization', () => {
  it('round-trips the instance id and audience exactly', () => {
    const { instanceId, event } = deserializeEvent(
      serializeEvent('inst-A', ev({ audience: { kind: 'channel', channelId: 789n, guildId: 42n } })),
    );
    expect(instanceId).toBe('inst-A');
    expect(event.t).toBe('MESSAGE_CREATE');
    expect(event.audience).toEqual({ kind: 'channel', channelId: 789n, guildId: 42n });
  });

  it('serializes bigints in the payload to strings (client wire form)', () => {
    const { event } = deserializeEvent(
      serializeEvent('x', ev({ d: { id: 999n, nested: { ownerId: 7n }, name: 'general' } })),
    );
    expect(event.d).toEqual({ id: '999', nested: { ownerId: '7' }, name: 'general' });
  });
});

describe('RedisEventBus', () => {
  it('delivers locally and publishes to Redis on the configured channel', () => {
    const pub = fakeRedis();
    const sub = fakeRedis();
    const bus = new RedisEventBus(pub as RedisLike, sub as RedisLike, {
      instanceId: 'A',
      channel: 'test',
    });
    const got: PublishedEvent[] = [];
    bus.subscribe((e) => got.push(e));

    bus.publish(ev({ d: { x: 1 }, audience: { kind: 'user', userId: 5n } }));

    expect(got).toHaveLength(1); // immediate local delivery
    expect(got[0]!.audience).toEqual({ kind: 'user', userId: 5n });
    expect(sub.subscribedTo).toContain('test'); // subscriber subscribed on construct
    expect(pub.published).toHaveLength(1); // also fanned out to Redis
    expect(pub.published[0]!.channel).toBe('test');
  });

  it("ignores its own echo but delivers other instances' events", () => {
    const pub = fakeRedis();
    const sub = fakeRedis();
    const bus = new RedisEventBus(pub as RedisLike, sub as RedisLike, {
      instanceId: 'A',
      channel: 'test',
    });
    const got: PublishedEvent[] = [];
    bus.subscribe((e) => got.push(e));

    // Redis echoes our own publish back to us → must be dropped (already
    // delivered locally), else every event delivers twice.
    sub.emit('test', serializeEvent('A', ev()));
    expect(got).toHaveLength(0);

    // A genuine event from another replica → delivered.
    sub.emit('test', serializeEvent('B', ev({ audience: { kind: 'guild', guildId: 9n } })));
    expect(got).toHaveLength(1);
    expect(got[0]!.audience).toEqual({ kind: 'guild', guildId: 9n });
  });

  it('reports malformed messages to onError without throwing or delivering', () => {
    const errors: unknown[] = [];
    const pub = fakeRedis();
    const sub = fakeRedis();
    const bus = new RedisEventBus(pub as RedisLike, sub as RedisLike, {
      instanceId: 'A',
      channel: 'test',
      onError: (e) => errors.push(e),
    });
    const got: PublishedEvent[] = [];
    bus.subscribe((e) => got.push(e));

    sub.emit('test', 'not-json {{{');

    expect(got).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });
});
