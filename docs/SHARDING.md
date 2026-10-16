# Multi-node deployments and gateway sharding

This document describes what's required to run Zekktris's API across
more than one process. The default single-node configuration needs no
changes — everything in this file is for operators who want to
horizontally scale the gateway across multiple replicas.

## Single-node is the default and is fine for most deployments

A single Node process handles tens of thousands of concurrent
WebSocket connections comfortably. With the per-guild connection
index (`registry.byGuild`, see fix #16 in `AUDIT_NOTES.md`) the
per-event dispatch cost is O(audience), not O(total connections), so
the headroom is wide. Most self-hosted Zekktris instances will never
need to shard.

Before considering multi-node, exhaust the simpler options:

1. Vertical scaling — Node 20 + ws scales well on bigger boxes.
2. Move the API behind a TCP load balancer that pins WebSocket
   connections to the same backend (session affinity). This gives
   you 2× capacity without solving the cross-node event delivery
   problem because each replica only handles its own subset of
   sessions.
3. Move the database to a beefier host. The Postgres connection
   pool is more often the bottleneck than the gateway is.

If you're past those and genuinely need cross-node event delivery,
read on.

## What multi-node requires

Three things have to work across replicas:

### 1. Cross-node event delivery (the bus)

Today the event bus is `apps/api/src/gateway/bus.ts` —
`InMemoryEventBus` — which delivers events only to handlers in the
same process. When a user on replica A sends a message in a guild
where some members have their gateway connections on replica B,
replica B has no idea the event happened.

**The fix:** swap in a pub/sub-backed bus that broadcasts every
event to every replica. Each replica subscribes and runs its own
audience filter on whoever happens to be locally connected.

The `EventBus` interface in `bus.ts` is already shaped for this
swap. Implementing a new backend is roughly:

```ts
// bus_redis.ts (example)
import type Redis from 'ioredis';
import type { EventBus, PublishedEvent } from './bus';

export class RedisEventBus implements EventBus {
  private handlers = new Set<(e: PublishedEvent) => void>();

  constructor(private pub: Redis, private sub: Redis, private channel = 'zekktris:gateway') {
    this.sub.subscribe(this.channel);
    this.sub.on('message', (_ch, raw) => {
      const event = deserialize(raw);
      for (const h of this.handlers) h(event);
    });
  }

  publish(event: PublishedEvent): void {
    // Local-first for the originating replica — keeps latency low
    // for users on this node and avoids a round-trip to Redis for
    // the common "audience is co-located" case. Then publish to
    // the others.
    for (const h of this.handlers) h(event);
    this.pub.publish(this.channel, serialize(event));
  }

  subscribe(handler: (e: PublishedEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
}
```

Wire it in `main()` BEFORE `attachGateway()`:

```ts
import { setEventBus } from './gateway/bus';
import { RedisEventBus } from './gateway/bus_redis';

async function main() {
  await runStartupChecks();

  if (env.GATEWAY_BUS === 'redis') {
    const pub = new Redis(env.REDIS_URL!);
    const sub = new Redis(env.REDIS_URL!);
    setEventBus(new RedisEventBus(pub, sub));
  }

  // ... attachGateway happens AFTER this, so registry.init()
  //     subscribes to the right bus.
}
```

### 2. Serialization across the wire

`PublishedEvent` contains an `Audience` with `bigint` fields (userIds,
guildId, channelId). `JSON.stringify` throws on bigints by default —
so any cross-process bus needs an explicit serializer that converts
bigints to strings on the way out and back on the way in.

A pattern that works:

```ts
function serialize(e: PublishedEvent): string {
  return JSON.stringify(e, (_key, value) =>
    typeof value === 'bigint' ? `__bigint:${value.toString()}` : value,
  );
}
function deserialize(raw: string): PublishedEvent {
  return JSON.parse(raw, (_key, value) =>
    typeof value === 'string' && value.startsWith('__bigint:')
      ? BigInt(value.slice(9))
      : value,
  );
}
```

`Audience` is the only place bigints appear in event payloads; the
DTO data in `event.d` is already serialized as strings by the DTO
helpers (`toMessage`, `toGuildMember`, etc).

### 3. Per-connection snapshot state stays local

Each `Connection` (in `apps/api/src/gateway/connection.ts`) caches:
- The user's guild membership set (`guildIds`)
- The user's DM channel set (`dmChannelIds`)
- The user's viewable-channel set per guild
  (`viewableGuildChannelIds`)

These are populated at IDENTIFY by reading the DB. They live in the
replica's memory and are NEVER shared across replicas. That's
correct — each replica only needs the snapshot for connections it
itself holds.

When the snapshot needs to change (user joins/leaves a guild, a
permission override flips, etc.), the dispatch helpers in
`dispatch.ts` (e.g. `applyGuildPermissionChange`) call into
`registry.byUserId()` to find the user's local connections and
update their snapshots. That is a node-local write: it only reaches
connections held by the replica that HANDLED THE REQUEST, which is
not necessarily the replica the user is connected to. So every
snapshot change also fans out as an internal signal:

- Guild join/leave/kick/ban, guild delete and DM open/close publish
  `_zk.internal.membership` (Redis-only, no local echo). Every other
  replica applies the same `registry.addGuildToUser` /
  `removeGuildFromUser` / `addDMToUser` / `removeDMFromUser` to its
  own connections. The signal is published in the same order as the
  client events around it (a join before `GUILD_MEMBER_ADD`, a leave
  after `GUILD_DELETE`), and the bus preserves publish order, so the
  peer's filter sees the same sequence the origin's does.
- Permission/role changes publish `_zk.internal.viewability_invalidate`
  (below).

Note that `applyGuildPermissionChange` / `applyMemberRoleChange`
recompute the per-connection snapshot LOCALLY (`registry.byUserId()`
+ `conn.send()`), which is a node-local socket write — it does NOT
ride the bus. So the recompute TRIGGER must be fanned out explicitly,
or a change handled on node A would never invalidate the victim's
cache on node B (and node B would keep delivering messages for a
channel the user can no longer see — a private-channel leak until they
reconnect). This is done via an internal cross-node signal: after the
local recompute, dispatch calls `eventBus().publishRemote(...)` with a
`_zk.internal.viewability_invalidate` event (Redis-only, no local echo,
so the origin doesn't double-run). Every OTHER replica's dispatch
subscriber (`initInternalDispatchBus`) re-runs the recompute against
its own local connections; `registry.onPublished` skips the internal
event so it's never delivered to a client socket. The per-connection
snapshot stays node-local (as designed); only the trigger fans out.

## What doesn't need fixing for multi-node

These are tempting things that don't actually require changes:

- **Session affinity for WebSockets.** Each connection holds its
  own snapshot, so a user can connect to any replica and re-IDENTIFY
  populates the right state for that replica. A TCP-level
  load balancer with sticky sessions is friendlier for reconnect
  latency but isn't required for correctness.

- **Cross-node session storage.** Sessions live in the database
  (`sessions` table), so a token issued on replica A can be
  validated on replica B by reading the row.

- **Event ordering across replicas.** Each conversation/channel has
  a single Postgres row with a monotonic snowflake id, so message
  ordering is preserved at the source. Whether replica A delivers
  event X before replica B sees event Y doesn't matter — the
  client orders by message id.

- **At-least-once delivery from the bus.** The fix-#10 reconnect
  resync (every full re-IDENTIFY refreshes guilds + channels +
  members + read states + relationships) means a dropped event
  during a brief replica disconnect doesn't leave clients with
  stale state. If your pub/sub of choice (Redis) drops the rare
  message, the next reconnect heals it.

## Sketch of what's missing in v1.67 that you'd want to add

In rough order of effort:

1. **The Redis-backed bus implementation itself** (`bus_redis.ts`)
   — ~80 lines as in the example above. Choose your client library;
   `ioredis` and `node-redis` both work.

2. **Env-driven bus selection in `main()`** — three lines of
   if/else before `attachGateway`.

3. **A health-check endpoint that reports bus connectivity** — so
   a load balancer can take the replica out of rotation if its
   Redis connection drops. The existing `startup-checks.ts` would
   be the right shape.

4. **Backpressure on the pub channel** — Redis pub/sub has no
   backpressure; if a subscriber is slow it drops events.
   Realistically this won't matter for typical Zekktris workloads,
   but for very chatty deployments consider a streams-based
   approach (XADD/XREAD) where consumers can lag and catch up.

5. **Operational play-doh** — graceful drain on SIGTERM (already
   there in `detachGateway`), pre-stop hooks to close the bus
   cleanly, healthcheck endpoints on each replica.

## Not done in v1.67

This document is the entirety of the multi-node work. No code in
v1.67 implements Redis/NATS/anything else for the bus. The
`InMemoryEventBus` is the only backend that ships.

The extension point in `bus.ts` (`setEventBus(impl)`) is the
intended hook for operators who want to wire a real backend. It's
been validated end-to-end as a clean swap surface — fixes
introduced in earlier audit rounds maintain the invariant that
nothing outside `bus.ts` references the implementation directly.
