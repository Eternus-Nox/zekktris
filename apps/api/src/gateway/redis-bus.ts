/**
 * Redis-backed event bus
 * -----------------------
 * The in-memory bus (bus.ts) only reaches WebSocket connections held by the
 * current process, which is correct for a single API instance. To run several
 * API replicas behind a load balancer, an event published on one replica must
 * also reach connections on the others. This bus adds that cross-instance
 * fan-out using Redis pub/sub, exactly as the bus.ts header anticipated.
 *
 * Design:
 *   - It WRAPS an InMemoryEventBus for local handler management + delivery, so
 *     same-instance delivery is immediate and does NOT depend on a Redis
 *     round-trip (and keeps working — degraded to local-only — if Redis is
 *     temporarily down).
 *   - publish(): deliver locally now, AND publish to a single Redis channel
 *     ("zekktris:gateway") tagged with this process's instance id.
 *   - On a Redis message FROM ANOTHER instance, deliver to local handlers.
 *     Messages tagged with our own instance id are ignored (we already
 *     delivered them locally) — this is what prevents double-delivery, since
 *     Redis echoes a publish back to the publishing subscriber too.
 *
 * Wire format: a single JSON channel keeps subscriptions O(replicas) rather
 * than O(guilds × replicas); the cheap Audience filter runs per-connection on
 * the receiving side after the broadcast (same as in-process). Snowflake ids
 * in the Audience are bigints, which JSON can't represent, so they're encoded
 * to decimal strings here and decoded back to bigint on receipt; the event
 * payload (`d`) is serialized with the same bigint→string replacer the gateway
 * uses when writing to clients, so it crosses the wire in client form.
 */

import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { jsonReplacer } from './connection';
import { log } from '../log';
import { InMemoryEventBus, type EventBus, type PublishedEvent } from './bus';
import type { Audience } from './types';

const CHANNEL = 'zekktris:gateway';

// ── Audience codec ──────────────────────────────────────────────────────────
// Explicit per-kind encode/decode: the receiving registry compares these ids as
// bigints against connection state, so they must survive the round-trip exactly.

type WireAudience =
  | { kind: 'user'; userId: string }
  | { kind: 'dmRecipient'; userId: string; channelId: string }
  | { kind: 'guild'; guildId: string }
  | { kind: 'channel'; channelId: string; guildId: string | null }
  | { kind: 'users'; userIds: string[] }
  | { kind: 'presence'; guildIds: string[]; dmChannelIds: string[]; userIds: string[] }
  | { kind: 'multiUser'; guildIds: string[]; userIds: string[] };

export function encodeAudience(a: Audience): WireAudience {
  switch (a.kind) {
    case 'user':
      return { kind: 'user', userId: a.userId.toString() };
    case 'dmRecipient':
      return { kind: 'dmRecipient', userId: a.userId.toString(), channelId: a.channelId.toString() };
    case 'guild':
      return { kind: 'guild', guildId: a.guildId.toString() };
    case 'channel':
      return {
        kind: 'channel',
        channelId: a.channelId.toString(),
        guildId: a.guildId === null ? null : a.guildId.toString(),
      };
    case 'users':
      return { kind: 'users', userIds: a.userIds.map((id) => id.toString()) };
    case 'presence':
      return {
        kind: 'presence',
        guildIds: a.guildIds.map((id) => id.toString()),
        dmChannelIds: a.dmChannelIds.map((id) => id.toString()),
        userIds: a.userIds.map((id) => id.toString()),
      };
    case 'multiUser':
      return {
        kind: 'multiUser',
        guildIds: a.guildIds.map((id) => id.toString()),
        userIds: a.userIds.map((id) => id.toString()),
      };
  }
}

export function decodeAudience(a: WireAudience): Audience {
  switch (a.kind) {
    case 'user':
      return { kind: 'user', userId: BigInt(a.userId) };
    case 'dmRecipient':
      return { kind: 'dmRecipient', userId: BigInt(a.userId), channelId: BigInt(a.channelId) };
    case 'guild':
      return { kind: 'guild', guildId: BigInt(a.guildId) };
    case 'channel':
      return {
        kind: 'channel',
        channelId: BigInt(a.channelId),
        guildId: a.guildId === null ? null : BigInt(a.guildId),
      };
    case 'users':
      return { kind: 'users', userIds: a.userIds.map((id) => BigInt(id)) };
    case 'presence':
      return {
        kind: 'presence',
        guildIds: a.guildIds.map((id) => BigInt(id)),
        dmChannelIds: a.dmChannelIds.map((id) => BigInt(id)),
        userIds: a.userIds.map((id) => BigInt(id)),
      };
    case 'multiUser':
      return {
        kind: 'multiUser',
        guildIds: a.guildIds.map((id) => BigInt(id)),
        userIds: a.userIds.map((id) => BigInt(id)),
      };
    default:
      throw new Error(`unknown audience kind: ${JSON.stringify(a)}`);
  }
}

interface WireMessage {
  /** Publishing instance id — used to drop our own echo. */
  i: string;
  t: PublishedEvent['t'];
  d: unknown;
  a: WireAudience;
}

export function serializeEvent(instanceId: string, event: PublishedEvent): string {
  const msg: WireMessage = {
    i: instanceId,
    t: event.t,
    d: event.d,
    a: encodeAudience(event.audience),
  };
  // jsonReplacer mirrors the gateway's client serialization (bigint → string),
  // so any stray bigint in `d` crosses the wire exactly as a client would see it.
  return JSON.stringify(msg, jsonReplacer);
}

export function deserializeEvent(raw: string): {
  instanceId: string;
  event: PublishedEvent;
} {
  const msg = JSON.parse(raw) as WireMessage;
  return {
    instanceId: msg.i,
    event: { t: msg.t, d: msg.d, audience: decodeAudience(msg.a) },
  };
}

// ── Bus ──────────────────────────────────────────────────────────────────────

/** The subset of an ioredis client this bus uses. Lets tests inject fakes. */
export interface RedisLike {
  publish(channel: string, message: string): Promise<unknown> | unknown;
  subscribe(channel: string): Promise<unknown> | unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit?(): Promise<unknown> | unknown;
  /** Liveness probe (ioredis exposes this). Optional so fakes need not. */
  ping?(): Promise<unknown> | unknown;
  /** Connection state (ioredis: 'ready' when commands can be sent). Optional
   *  so fakes need not; absent is treated as ready. */
  readonly status?: string;
}

export interface RedisEventBusOptions {
  instanceId?: string;
  channel?: string;
  /** Reported on serialize/deserialize/transport failures. Never throws into delivery. */
  onError?: (err: unknown) => void;
}

export class RedisEventBus implements EventBus {
  private readonly local = new InMemoryEventBus();
  private readonly instanceId: string;
  private readonly channel: string;
  private readonly onError?: (err: unknown) => void;
  /** True while cross-replica publishes are failing / being skipped, so an
   *  outage is reported once instead of once per event. */
  private publishDegraded = false;
  /** Events skipped or failed during the current outage (reported on recovery). */
  private droppedPublishes = 0;

  constructor(
    private readonly pub: RedisLike,
    private readonly sub: RedisLike,
    opts: RedisEventBusOptions = {},
  ) {
    this.instanceId = opts.instanceId ?? randomUUID();
    this.channel = opts.channel ?? CHANNEL;
    this.onError = opts.onError;

    Promise.resolve(this.sub.subscribe(this.channel)).catch((e) => this.onError?.(e));
    this.sub.on('message', (channel, raw) => {
      if (channel !== this.channel) return;
      let decoded: { instanceId: string; event: PublishedEvent };
      try {
        decoded = deserializeEvent(raw);
      } catch (e) {
        this.onError?.(e);
        return;
      }
      // Our own publish is echoed back by Redis — we already delivered it
      // locally, so skip it here to avoid double-delivery.
      if (decoded.instanceId === this.instanceId) return;
      this.local.publish(decoded.event);
    });
  }

  publish(event: PublishedEvent): void {
    // Deliver to this instance's own connections immediately, independent of
    // Redis (so local realtime survives a Redis hiccup).
    this.local.publish(event);
    this.fanToRedis(event);
  }

  /**
   * Fan to OTHER replicas only (no local delivery). For internal cross-node
   * signals where the origin already handled the effect locally and must not
   * re-run on its own echo. Redis echoes our own publish back, but the
   * subscriber self-skips by instanceId — so this never round-trips to us.
   */
  publishRemote(event: PublishedEvent): void {
    this.fanToRedis(event);
  }

  private fanToRedis(event: PublishedEvent): void {
    // Redis down / reconnecting: skip the cross-replica publish rather than
    // queue it. The publisher has no offline queue (see createRedisEventBus),
    // so it would reject anyway; checking first avoids an error per event.
    // Realtime events are worthless once stale — a reconnecting client
    // resyncs over REST — so dropping beats buffering an outage's worth of
    // events in memory and flushing them late in one burst.
    if (this.pub.status !== undefined && this.pub.status !== 'ready') {
      this.notePublishFailure(new Error(`redis bus publisher not ready (${this.pub.status})`));
      return;
    }
    let raw: string;
    try {
      raw = serializeEvent(this.instanceId, event);
    } catch (e) {
      this.onError?.(e);
      return;
    }
    Promise.resolve(this.pub.publish(this.channel, raw)).then(
      () => this.notePublishSuccess(),
      (e) => this.notePublishFailure(e),
    );
  }

  /** Log the FIRST failure of an outage; count the rest silently. */
  private notePublishFailure(err: unknown): void {
    this.droppedPublishes++;
    if (this.publishDegraded) return;
    this.publishDegraded = true;
    log.warn('gateway redis bus: cross-replica publish failing, dropping events until Redis recovers', {
      err: (err as Error)?.message ?? String(err),
    });
  }

  private notePublishSuccess(): void {
    if (!this.publishDegraded) return;
    this.publishDegraded = false;
    log.info('gateway redis bus: cross-replica publish recovered', {
      dropped: this.droppedPublishes,
    });
    this.droppedPublishes = 0;
  }

  subscribe(handler: (event: PublishedEvent) => void): () => void {
    return this.local.subscribe(handler);
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      Promise.resolve(this.pub.quit?.()),
      Promise.resolve(this.sub.quit?.()),
    ]);
  }

  /**
   * Bounded liveness probe for observability. PINGs the publish connection
   * (the subscribe connection is in subscriber mode and can't run commands).
   * Resolves false on error OR if the ping doesn't return within `timeoutMs`
   * — never hangs the caller (the metrics endpoint must stay fast).
   */
  async health(timeoutMs = 1000): Promise<boolean> {
    if (typeof this.pub.ping !== 'function') return false;
    try {
      const ping = Promise.resolve(this.pub.ping());
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('redis ping timeout')), timeoutMs),
      );
      await Promise.race([ping, timeout]);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Build a RedisEventBus backed by two real ioredis connections (pub/sub mode
 * requires a dedicated subscriber connection). Error listeners are attached so
 * a connection blip emits to `onError` instead of crashing the process; ioredis
 * reconnects automatically.
 *
 * The publisher matches every other Redis client in the API: no offline queue
 * and a hard per-command timeout. With ioredis defaults, every publish issued
 * during an outage (one per message, typing and presence event) would be
 * buffered in memory without bound and flushed late on reconnect. The
 * subscriber keeps the defaults: it issues one SUBSCRIBE, which ioredis
 * replays on reconnect.
 */
export function createRedisEventBus(
  url: string,
  onError?: (err: unknown) => void,
): RedisEventBus {
  const pub = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1000,
    lazyConnect: false,
  });
  const sub = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  pub.on('error', (e) => onError?.(e));
  sub.on('error', (e) => onError?.(e));
  return new RedisEventBus(pub, sub, { onError });
}
