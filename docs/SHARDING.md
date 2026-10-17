# Multi-node deployments and gateway sharding

This document describes what it takes to run Zekktris's API across more than
one process, what is already in place, and what is not. The default
single-node configuration needs no changes — everything here is for operators
who want to scale the API horizontally.

## Single-node is the default and is fine for most deployments

A single Node process handles tens of thousands of concurrent WebSocket
connections comfortably. With the per-guild connection index
(`registry.byGuild`, see fix #16 in `AUDIT_NOTES.md`) the per-event dispatch
cost is O(audience), not O(total connections), so the headroom is wide. Most
self-hosted Zekktris instances will never need more than one replica, and one
replica is the configuration that is actually exercised day to day.

Before considering multi-node, exhaust the simpler options:

1. Vertical scaling — Node 20 + ws scales well on bigger boxes.
2. Move the database to a beefier host. The Postgres connection pool is more
   often the bottleneck than the gateway is.

## What is already in place

All of it keys off `REDIS_URL`. docker-compose always sets it to the bundled
`cache` service; outside compose, leaving it unset gives the single-process
in-memory versions.

- **Cross-replica event bus** — `apps/api/src/gateway/redis-bus.ts`, selected
  in `main()` (`apps/api/src/index.ts`) before `attachGateway()`. It wraps the
  in-memory bus: `publish()` delivers locally at once and also publishes to one
  Redis channel (`zekktris:gateway`) tagged with the instance id; messages from
  other instances are delivered to local handlers and our own echo is ignored.
  Audience snowflakes are bigints, so they are encoded to strings on the wire
  and decoded back on receipt.
- **Snowflake worker ids** — `apps/api/src/cluster.ts` leases a distinct worker
  id per process from Redis (unless `WORKER_ID` is pinned). A shared id would
  mint colliding primary keys, which is why `.env` should leave `WORKER_ID`
  empty.
- **Sweep leadership** — the same module elects one leader; `leaderInterval()`
  in `index.ts` gates the periodic sweeps (retention, attachment GC, invite
  prune, …) so only the leader runs them.
- **Rate limits, session revocation and short-lived auth state** (refresh
  replay detection, QR/device login, WebAuthn challenges) live in Redis, so
  they hold across replicas.
- **Sessions** live in the database (`sessions` table): a token issued on
  replica A validates on replica B.

## What stays per-replica

Each `Connection` (`apps/api/src/gateway/connection.ts`) caches, from the
database at IDENTIFY:

- the user's guild membership set (`guildIds`),
- the user's DM channel set (`dmChannelIds`),
- the viewable-channel set per guild (`viewableGuildChannelIds`),

plus the RESUME replay buffer. These live only in the memory of the replica
that holds the socket, and the bus does not carry them.

So **whenever something changes one of those snapshots, every replica has to
be told to recompute it for its own sockets.** The pattern is an internal
cross-node event: after the local update, `dispatch.ts` calls
`eventBus().publishRemote(...)` (Redis only, no local echo), and every other
replica's `initInternalDispatchBus()` handler re-runs the update against its
own connections; `registry.onPublished` never delivers these internal events
to a client. `initInternalDispatchBus()` is therefore the list of snapshot
changes that fan out. A snapshot mutation that is not handled there only takes
effect on the replica that processed the request — the user's sockets
elsewhere keep a stale view (missing events, or events they should no longer
get) until they reconnect. Check that list before relying on several replicas,
and add any new snapshot-changing dispatch to it.

## Running more than one replica

- The stock `docker-compose.yml` runs a single `api` (it pins
  `container_name`, and Caddy proxies to one upstream). Several replicas need
  your own load balancer in front.
- Use **sticky sessions** for `/gateway`: the RESUME replay buffer is
  per-process, so a reconnect that lands on another replica cannot resume and
  falls back to a full IDENTIFY (harmless, but slower).
- Budget database connections: (replicas × `DB_POOL_MAX`) plus a few for
  migrations/admin must stay under Postgres `max_connections`.
- Leave `WORKER_ID` empty so each replica leases its own.

## Not done

- **Backpressure on the pub channel.** Redis pub/sub has none; a slow
  subscriber drops events. The reconnect resync (every full IDENTIFY refreshes
  guilds, channels, members, read states and relationships) heals a dropped
  event on the next reconnect, but there is no catch-up before that. A
  streams-based bus (XADD/XREAD) would let consumers lag and catch up.
- **Bus health in the readiness probe.** A replica whose Redis connection
  drops degrades to local-only delivery without being taken out of rotation.
