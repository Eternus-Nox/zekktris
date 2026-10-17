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
- **Sweep leadership** — the same module elects one leader;
  `leaderInterval()` and `leaderTimeout()` (`apps/api/src/lib/leaderTimers.ts`)
  gate the periodic sweeps (retention, attachment GC, invite prune, …) and
  their first run after boot, so only the leader runs them.
- **Rate limits, session revocation and short-lived auth state** (refresh
  replay detection, QR/device login, WebAuthn challenges) live in Redis, so
  they hold across replicas.
- **Sessions** live in the database (`sessions` table): a token issued on
  replica A validates on replica B.
- **Presence** — see [Presence across replicas](#presence-across-replicas)
  below.

## Presence across replicas

A user's effective status (`users.status`) is recomputed from their chosen
status (`users.chosen_status`) and the activity of every live gateway
connection they hold — on any replica (`apps/api/src/gateway/presence.ts`).
A replica only sees its own sockets, so:

- Each replica publishes a per-user summary into the Redis hash
  `zekktris:presence:u:<userId>`: field = the replica's cluster instance id,
  value = `{l: live connections, a: active connections, t: timestamp}` (plus
  `h` / `ha` for a held device, below). It writes it on every recompute
  (connect, `PRESENCE_UPDATE` op, a socket closing, a status change) and
  refreshes all of its entries from a heartbeat every 15 s.
- When a user's last socket on a replica closes, that replica holds the
  device as connected through the full-disconnect grace (the 45 s
  voice-eviction window), so no replica offlines them early. For the first
  5 s (the close grace) the held device still counts with its last activity;
  after that it is settled (`h`: settled holds, `ha`: how many were active):
  it keeps the user from reading offline, but counts as in use only when held
  devices are all that is left anywhere. So the phone leaving while the Mac
  sits idle on another replica reads idle after 5 s, as on one replica.
- A recompute sums every field whose timestamp is under 45 s old (three
  missed heartbeats) and writes the result with a compare-and-set. The
  compare-and-set alone can't order two replicas — one holding an older
  snapshot can still win it after the other wrote — so after every write the
  recompute takes a fresh snapshot and rewrites if it disagrees. The last
  writer has always checked inputs at least as new as anyone else's, so
  concurrent recomputes converge.
- A replica that shuts down gracefully deletes its fields. One that dies
  leaves fields that go stale. The sweep leader
  (`leaderInterval`, every 30 s) recomputes users shown online / idle / dnd
  whose entries are missing or partly stale, deleting the stale fields — so
  "phone on the dead replica" stops counting and the user reads idle or
  offline according to what is still connected.
- At boot, a replica runs that sweep once instead of the single-node blanket
  "everyone offline" reset, so users connected to other replicas are left
  alone. This also applies to a single replica with `REDIS_URL` set (the
  docker-compose default): after a crash, the dead process's fields keep its
  users present until they are stale and swept (about a minute) unless they
  reconnect first.
- Every Redis failure degrades to the replica's own view (the pre-cluster
  behaviour): a recompute never hangs or throws because of Redis. The
  heartbeat heals what that can leave wrong, within one beat of Redis being
  reachable again: it recomputes users whose last recompute on this replica
  ran on its own view, users whose entry had gone missing (the leader swept
  it as stale and recomputed them without this replica's devices), and users
  it holds whose row reads `offline` (e.g. Redis was unreachable at another
  replica's boot, so the blanket reset ran). That last check runs only when
  the beat itself reached Redis: a replica cut off from Redis but not from
  Postgres can't publish, so the leader's sweep reads its users as gone and
  offlines them; re-onlining them from its own view would be undone by the
  next sweep, flapping every co-member's dot offline/online every 30 s.
  Instead they read offline for the length of the partition (their own
  socket is unaffected) and heal on the first beat that reaches Redis again.
  A recompute the partitioned replica runs for its own reasons meanwhile (a
  device connects or reports activity) still writes its own view, and the
  next sweep corrects it.
- During a rolling deploy from a version without this, users connected only
  to old replicas have no entries yet, so a new replica's boot sweep may show
  them offline until their next reconnect.

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
changes that fan out. Today that is:

- `_zk.internal.membership` — guild join/leave/kick/ban, guild delete and DM
  open/close. Published in the same order as the client events around it (a
  join before `GUILD_MEMBER_ADD`, a leave after `GUILD_DELETE`); the bus keeps
  publish order, so a peer's filter sees the same sequence the origin's does.
- `_zk.internal.viewability_invalidate` — permission, role and channel-override
  changes that alter which channels a member can see.
- `_zk.internal.force_disconnect` — bans, session revocation and account
  deletion.

A snapshot mutation that is not handled there only takes effect on the replica
that processed the request — the user's sockets elsewhere keep a stale view
(missing events, or events they should no longer get) until they reconnect.
Add any new snapshot-changing dispatch to that list.

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
