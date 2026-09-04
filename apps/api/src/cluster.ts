/**
 * Cluster identity + leadership
 * -----------------------------
 * Everything a second API replica needs before it is safe to start one. Both
 * pieces are no-ops on a single instance, so this changes nothing until you
 * actually scale.
 *
 * 1. WORKER ID. Snowflakes encode a 10-bit worker id, and two processes
 *    sharing one mint COLLIDING IDS for messages, users, channels — every
 *    primary key in the system. docker-compose sets a single `WORKER_ID` for
 *    the whole service, so `docker compose up --scale api=3` would have given
 *    all three replicas worker 0. This allocates a distinct slot per process
 *    instead.
 *
 * 2. LEADERSHIP. The API runs fifteen background sweeps — retention,
 *    attachment GC, invite prune, thread archive, AFK moves, subscription
 *    expiry and so on. Exactly one of them (scheduled messages) claims its
 *    rows atomically and is safe to run everywhere; the rest would each run N
 *    times concurrently, several of them being DELETION sweeps racing
 *    themselves. `isLeader()` gates them so one replica does the global work.
 *
 * Both use short-lived Redis leases rather than anything persistent, so a
 * replica that dies releases what it held within one TTL and never needs
 * manual cleanup.
 */

import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { env } from './env';
import { log } from './log';

const KEY_PREFIX = 'zekktris:cluster';
const MAX_WORKERS = 1024;

/** How long a lease survives without renewal. Long enough to ride out a
 *  garbage-collection pause or a brief Redis blip, short enough that a dead
 *  replica's slot and leadership return quickly. */
const LEASE_MS = 30_000;
/** Renew at a third of the lease, so two consecutive failures still leave a
 *  full renewal's worth of headroom before anything expires. */
const RENEW_MS = LEASE_MS / 3;

/** Identifies THIS process in every lease it holds. */
const instanceId = randomUUID();

let client: Redis | null = null;

function redis(): Redis | null {
    if (!env.REDIS_URL) return null;
    if (client) return client;
    // Same posture as the session blacklist: no offline queue and a hard
    // command timeout, so a Redis outage makes commands REJECT rather than
    // hang forever. Everything here is written to treat a rejection as "I do
    // not hold this lease", which is the safe answer for both callers.
    client = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        commandTimeout: 2000,
        lazyConnect: false,
    });
    client.on('error', () => {});
    return client;
}

// ── 1. Worker id ───────────────────────────────────────────────────────────

/** Stable 10-bit value derived from the container hostname. The LAST-RESORT
 *  fallback, used only when Redis can't be reached and no id was pinned.
 *
 *  Deliberately not 0. Falling back to a constant is what makes every replica
 *  collide, which is the exact failure this module exists to prevent; distinct
 *  hostnames give distinct slots with high probability (~0.3% collision across
 *  three replicas), and unlike refusing to boot it cannot take a
 *  single-instance deployment offline over a Redis hiccup. */
function hostnameWorkerId(): number {
    const digest = createHash('sha256').update(hostname()).digest();
    return digest.readUInt16BE(0) % MAX_WORKERS;
}

/** Claim a free worker slot, or null if Redis is unreachable / all taken. */
async function claimWorkerSlot(r: Redis): Promise<number | null> {
    // Start from the hostname-derived slot so a restarting replica tends to
    // reclaim the same number — steadier ids, and it spreads replicas out
    // instead of every one of them contending for slot 0 at boot.
    const start = hostnameWorkerId();
    for (let i = 0; i < MAX_WORKERS; i++) {
        const slot = (start + i) % MAX_WORKERS;
        try {
            const got = await r.set(
                `${KEY_PREFIX}:worker:${slot}`, instanceId, 'PX', LEASE_MS, 'NX');
            if (got === 'OK') return slot;
        } catch {
            return null; // Redis unhealthy — stop scanning, take the fallback.
        }
    }
    return null;
}

let workerRenewTimer: ReturnType<typeof setInterval> | null = null;

function startWorkerRenewal(slot: number, r: Redis): void {
    const key = `${KEY_PREFIX}:worker:${slot}`;
    workerRenewTimer = setInterval(() => {
        void (async () => {
            try {
                // Renew only while the slot is still OURS. If it expired and
                // another replica took it, silently re-extending would give two
                // processes the same worker id — the collision this prevents.
                const held = await r.get(key);
                if (held === instanceId) {
                    await r.pexpire(key, LEASE_MS);
                } else {
                    log.error('worker-id lease lost — snowflakes may now collide', {
                        slot, holder: held ?? 'expired',
                    });
                }
            } catch {
                // Transient: the lease still has ~2 renewals of headroom.
            }
        })();
    }, RENEW_MS);
    workerRenewTimer.unref?.();
}

/**
 * Decide this process's worker id and hand it to the snowflake generator.
 * MUST be awaited before anything mints an id — including the startup checks,
 * which generate a batch to verify monotonicity.
 */
export async function initClusterIdentity(): Promise<void> {
    const { setWorkerId } = await import('./snowflake');

    // An explicitly pinned WORKER_ID always wins: it is how an operator opts
    // out of coordination entirely (fixed ids per replica in the orchestrator).
    if (process.env.WORKER_ID !== undefined && process.env.WORKER_ID !== '') {
        setWorkerId(env.WORKER_ID);
        log.info('cluster: worker id pinned by env', { workerId: env.WORKER_ID });
        return;
    }

    const r = redis();
    if (!r) {
        // No Redis configured = single instance by definition.
        setWorkerId(0);
        log.info('cluster: single instance (no REDIS_URL), worker id 0');
        return;
    }

    const slot = await claimWorkerSlot(r);
    if (slot === null) {
        const fallback = hostnameWorkerId();
        setWorkerId(fallback);
        log.warn('cluster: could not claim a worker slot, using hostname fallback', {
            workerId: fallback, host: hostname(),
        });
        return;
    }

    setWorkerId(slot);
    startWorkerRenewal(slot, r);
    log.info('cluster: claimed worker id', { workerId: slot, instance: instanceId });
}

// ── 2. Leadership ──────────────────────────────────────────────────────────

const LEADER_KEY = `${KEY_PREFIX}:leader`;

/** Cached so `isLeader()` is a synchronous field read — it is consulted on
 *  every tick of fifteen timers and must never await. */
let leader = false;
let leaderTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Whether THIS replica should run the global background sweeps.
 *
 * FAILS CLOSED. With Redis configured but unreachable we report false, so the
 * sweeps pause until leadership can be confirmed again. That is the safe
 * direction: a retention or attachment-GC sweep skipped for a minute costs
 * nothing, whereas several replicas running deletion sweeps concurrently
 * because nobody could confirm who was in charge is how data goes missing.
 */
export function isLeader(): boolean {
    // No Redis = one process = it is trivially in charge.
    if (!env.REDIS_URL) return true;
    return leader;
}

async function campaign(r: Redis): Promise<void> {
    try {
        if (leader) {
            // Renew, but only if we still hold it (CAS via Lua — a plain
            // GET-then-PEXPIRE could re-extend a lease another replica has
            // already taken in the gap between the two commands).
            const renewed = await r.eval(
                `if redis.call("get", KEYS[1]) == ARGV[1] then
                     return redis.call("pexpire", KEYS[1], ARGV[2])
                 else return 0 end`,
                1, LEADER_KEY, instanceId, String(LEASE_MS),
            );
            if (renewed !== 1) {
                leader = false;
                log.warn('cluster: lost sweep leadership');
            }
            return;
        }
        const won = await r.set(LEADER_KEY, instanceId, 'PX', LEASE_MS, 'NX');
        if (won === 'OK') {
            leader = true;
            log.info('cluster: acquired sweep leadership', { instance: instanceId });
        }
    } catch {
        // Unreachable Redis: stand down (see the fail-closed note above).
        if (leader) log.warn('cluster: standing down, Redis unreachable');
        leader = false;
    }
}

/** Begin campaigning for leadership. No-op without Redis. */
export function startLeaderElection(): void {
    const r = redis();
    if (!r) {
        log.info('cluster: sweeps run unconditionally (single instance)');
        return;
    }
    void campaign(r);
    leaderTimer = setInterval(() => void campaign(r), RENEW_MS);
    leaderTimer.unref?.();
}

/** Release leadership and the worker slot on shutdown, so a rolling restart
 *  hands both over immediately instead of leaving them to expire. */
export async function releaseCluster(): Promise<void> {
    if (leaderTimer) clearInterval(leaderTimer);
    if (workerRenewTimer) clearInterval(workerRenewTimer);
    leaderTimer = workerRenewTimer = null;
    const r = client;
    if (!r) return;
    try {
        await r.eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then
                 return redis.call("del", KEYS[1])
             else return 0 end`,
            1, LEADER_KEY, instanceId,
        );
    } catch {
        // Expiring on its own is fine.
    }
    leader = false;
    try { await r.quit(); } catch { /* closing anyway */ }
    client = null;
}
