/**
 * Multi-device presence
 * ---------------------
 * A user's EFFECTIVE status (`users.status`, what everyone sees) is derived,
 * never written by a device directly. Inputs:
 *
 *   - chosen status (`users.chosen_status`): what the user picked — online,
 *     idle ("Away"), dnd or invisible. Only PATCH /users/@me {status} sets
 *     it. One exception: an 'idle' PATCHed WITHOUT the `statusSource:
 *     'manual'` marker (`users.chosen_status_auto`; routes/users.ts says
 *     which ones count) is a pre-update client's AUTOMATIC away, which
 *     really says "this old device is not in use" — see below.
 *   - every live gateway connection's activity (Connection.presenceActive),
 *     reported by its client in IDENTIFY/RESUME and op 3 PRESENCE_UPDATE. A
 *     connection that never reports counts as active (legacy clients).
 *
 * Rule (effectiveStatus below): no live connection anywhere → 'offline'
 * ('invisible' stays 'invisible'); chosen invisible / dnd / idle → that;
 * chosen online → 'online' if ANY live connection is active, else 'idle'.
 * So the dot follows the device actually in use: the phone in hand reads
 * online while the Mac sits idle, and once nothing is in use it reads idle —
 * Zekktris is still open somewhere, nobody is using it.
 *
 * A pre-update client's automatic away: while it stands, connections of
 * pre-update clients that could have set it (old iOS, the old desktop app —
 * lib/legacyClients.ts) count as NOT in use, and the status follows the other
 * devices — updated ones, which report their activity, and old ones that
 * never set Away by themselves: 'online' while one is in use, else 'idle',
 * 'offline' with nothing connected. The chosen status underneath
 * stays 'idle' for the old app — it reads its own `status` as its pick and,
 * told 'online', would PATCH Away again — while updated clients are shown
 * the pick as 'online' (lib/dto.ts shownChosenStatus): the user picked
 * nothing. recomputeNow lists when it ends; any status PATCH but an updated
 * picker's Online also replaces it, e.g. the old app's own return to
 * 'online' when it is touched again. An Away picked in an old iOS build's
 * own picker looks the same and is read the same way.
 *
 * recompute() is the ONE runtime writer of users.status (the other is the
 * boot reset, resetPresenceOnBoot). It is serialized per user within a
 * process, writes with a compare-and-set on the row it read (a concurrent
 * PATCH or recompute that got in first makes it start over), stamps
 * lastSeenAt on transitions to/from offline, and broadcasts PRESENCE_UPDATE
 * ('invisible' masked as 'offline') to the user's guilds, DM peers, friends
 * AND their own connections (whose frame alone also carries chosen_status).
 * Across replicas the compare-and-set is not enough — a recompute holding an
 * older Redis snapshot can still win it after a newer one wrote — so in
 * cluster mode every successful write is re-validated against a snapshot
 * taken after it, and rewritten if that disagrees: the last writer always
 * checks inputs at least as new as everyone else's, so replicas converge.
 *
 * Full-disconnect grace: when a user's last socket on a replica closes, that
 * replica HOLDS the device as connected until the voice-eviction grace ends,
 * so the offline flip keeps today's timing. For the first few seconds (the
 * close grace) the held device still counts with its last activity, so a
 * reconnect blip doesn't flap anyone's dot; after that it is SETTLED: it
 * still keeps the user from reading offline, but its activity only counts
 * when nothing else is connected anywhere — a phone that left while the Mac
 * sits idle on another replica reads idle after the close grace, not online
 * for the whole voice grace.
 *
 * Multi-replica (REDIS_URL): a replica only sees its own sockets, so each one
 * publishes its per-user summary into a Redis hash —
 * `zekktris:presence:u:<userId>`, field = this replica's cluster instance id,
 * value = {l: live, a: active, t: timestamp, + h/ha for a held device, r/hr
 * for updated devices in use, g for pre-update connections, counting one
 * still in its resume window} — on every
 * recompute and from a heartbeat, and recompute sums the fields that aren't
 * stale. A dead
 * replica's fields go stale; the leader's sweep recomputes users carrying a
 * stale field (or none at all) so they don't stay stuck online. Every Redis
 * failure degrades to this replica's own view — exactly the pre-cluster
 * behaviour — rather than failing the gateway path. Without REDIS_URL all of
 * this is skipped and the registry is the whole truth.
 */

import Redis from 'ioredis';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { log } from '../log';
import { clusterInstanceId } from '../cluster';
import { runBounded } from '../lib/concurrency';
import { shownChosenStatus } from '../lib/dto';
import { touchLastSeen } from '../services/presence';
import { listAcceptedFriendIds } from '../services/relationships';
import * as dispatch from './dispatch';
import { registry } from './registry';

export type ChosenStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type EffectiveStatus = ChosenStatus | 'offline';

export interface PresenceSummary {
  /** Live (non-detached) connections. */
  live: number;
  /** Of those, how many report their device in use. */
  active: number;
  /** Of the active ones, how many still count while a pre-update client's
   *  automatic away stands: updated clients (they report their activity)
   *  and pre-update ones that never set Away by themselves. Absent = 0. */
  reported?: number;
  /** Pre-update clients that may have set an automatic away (old iOS, the
   *  old desktop app), connected or only reconnecting (a detached
   *  resume-window ghost). Absent = 0. */
  legacy?: number;
  /** Built from this replica's view alone because Redis failed: other
   *  replicas' devices may be missing. */
  partial?: boolean;
}

/** What the engine needs from a connection registry. */
export interface PresenceSource {
  presenceSummary(userId: bigint): PresenceSummary;
  liveUserIds(): Iterable<bigint>;
}

/** The pure rule. See the module comment. */
export function effectiveStatus(chosen: ChosenStatus, summary: PresenceSummary): EffectiveStatus {
  if (chosen === 'invisible') return 'invisible';
  if (summary.live === 0) return 'offline';
  if (chosen === 'online') return summary.active > 0 ? 'online' : 'idle';
  return chosen;
}

/** Recipients of a presence broadcast, when the caller already loaded them. */
export interface PresenceAudience {
  guildIds: bigint[];
  dmChannelIds: bigint[];
  friendIds: bigint[];
}

export interface RecomputeOptions {
  /** 'change' (default): broadcast only when the effective status changed.
   *  'always': also re-broadcast an unchanged one — every connect does this
   *  to heal peers' drifted views, and a status PATCH to confirm it. */
  broadcast?: 'change' | 'always';
  audience?: PresenceAudience;
  /** A pre-update client that may have set an automatic away just started a
   *  new session: IDENTIFY, not after a RESUME refused on the same socket (an
   *  old app launched or signed in — its automatic reconnects RESUME). Ends
   *  an automatic away — see recomputeNow. */
  legacyIdentified?: boolean;
}

const KEY_PREFIX = 'zekktris:presence:u:';
/** An entry not refreshed for this long belongs to a dead replica. Three
 *  missed heartbeats, so one slow heartbeat or Redis blip never counts. */
export const PRESENCE_STALE_MS = 45_000;
/** How often each replica republishes its summaries. */
export const PRESENCE_HEARTBEAT_MS = 15_000;
/** How often the leader looks for users stranded by a dead replica. */
export const PRESENCE_SWEEP_MS = 30_000;
/** Read-compute-write rounds before a recompute gives up: CAS retries plus,
 *  in cluster mode, the re-validation round after each write. */
const MAX_ATTEMPTS = 4;
const SWEEP_PAGE = 500;
const SWEEP_CONCURRENCY = 8;

const keyFor = (userId: bigint): string => KEY_PREFIX + userId.toString();

/**
 * One replica's contribution to a user's presence (the Redis entry, plus `t`).
 * `l` counts live connections AND held devices; `a` the active ones among
 * them, settled holds excluded; `h` settled holds and `ha` how many of those
 * were active when they left. `r` and `hr` are `a` and `ha` counting only
 * devices that count during an automatic away (PresenceSummary.reported); `g`
 * counts pre-update clients that may have set one (PresenceSummary.legacy) on
 * this replica, live or still in their resume window (a detached ghost).
 * It rides on a live or held tally; a replica with only a ghost publishes
 * nothing. See the module comment.
 */
interface Tally {
  l: number;
  a: number;
  h: number;
  ha: number;
  r: number;
  hr: number;
  g: number;
}

interface ClusterEntry extends Tally {
  t: number;
}

const EMPTY_TALLY: Tally = { l: 0, a: 0, h: 0, ha: 0, r: 0, hr: 0, g: 0 };

function parseEntry(raw: string): ClusterEntry | null {
  try {
    const e = JSON.parse(raw) as Partial<ClusterEntry>;
    if (typeof e.l !== 'number' || typeof e.a !== 'number' || typeof e.t !== 'number') return null;
    // h / ha are absent from entries written before holds settled.
    const h = typeof e.h === 'number' ? e.h : 0;
    const ha = typeof e.ha === 'number' ? e.ha : 0;
    // r / hr / g are absent when 0.
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    return { l: e.l, a: e.a, h, ha, r: num(e.r), hr: num(e.hr), g: num(e.g), t: e.t };
  } catch {
    return null;
  }
}

function serializeEntry(t: Tally, now: number): string {
  return JSON.stringify({
    l: t.l,
    a: t.a,
    ...(t.h > 0 ? { h: t.h, ha: t.ha } : {}),
    ...(t.r > 0 ? { r: t.r } : {}),
    ...(t.hr > 0 ? { hr: t.hr } : {}),
    ...(t.g > 0 ? { g: t.g } : {}),
    t: now,
  });
}

/** A settled hold's activity only counts when held devices are all there is
 *  (the single-device disconnect keeps reading as before until offline). */
function reduceTally(t: Tally): PresenceSummary {
  const onlyHolds = t.l === t.h;
  return {
    live: t.l,
    active: onlyHolds ? t.ha : t.a,
    reported: onlyHolds ? t.hr : t.r,
    legacy: t.g,
  };
}

/** Restricts a sweep / boot reset to these users (tests share a database). */
export interface PresenceScope {
  userIds: bigint[];
}

export interface PresenceEngineOptions {
  source: PresenceSource;
  /** Null = single replica: the source is the whole truth. */
  redis: Redis | null;
  instanceId: string;
  staleMs?: number;
}

export class PresenceEngine {
  private readonly source: PresenceSource;
  private readonly redis: Redis | null;
  private readonly instanceId: string;
  private readonly staleMs: number;
  /** Per-user tail of the recompute chain (in-process serialization). */
  private readonly chains = new Map<bigint, Promise<unknown>>();
  /**
   * Users whose last live connection closed and who are inside the gateway's
   * full-disconnect grace (voice-eviction window), with the activity of that
   * last connection and whether its close grace has passed (settled). They
   * count as one connection until the grace ends, so no recompute in the
   * meantime flips them offline early — the offline flip keeps today's
   * timing. See the module comment for what settling changes.
   */
  private readonly holds = new Map<
    bigint,
    { active: boolean; reported: boolean; settled: boolean }
  >();
  /** Users for whom a pre-update client started a new session while Redis
   *  was failing: the automatic away it ends waits for a full view. */
  private readonly pendingLegacyIdentify = new Set<bigint>();
  /** Users this replica has a field for in Redis (so it can delete them). */
  private readonly published = new Set<bigint>();
  /** Users whose last recompute here fell back to this replica's own view
   *  (Redis failing): recomputed again by the next heartbeat that reaches
   *  Redis, since that view may have missed other replicas' devices. */
  private readonly degraded = new Set<bigint>();
  private lastRedisWarnAt = 0;

  constructor(opts: PresenceEngineOptions) {
    this.source = opts.source;
    this.redis = opts.redis;
    this.instanceId = opts.instanceId;
    this.staleMs = opts.staleMs ?? PRESENCE_STALE_MS;
  }

  /** Whether summaries are aggregated across replicas through Redis. */
  get clustered(): boolean {
    return this.redis !== null;
  }

  /**
   * Resolves once the Redis client can take commands, or after `timeoutMs`
   * (callers then run into the usual failure handling). Without an offline
   * queue ioredis REJECTS anything issued before it has connected, and the
   * boot reset runs right after the client is created.
   */
  async whenReady(timeoutMs = 5000): Promise<void> {
    const r = this.redis;
    if (!r || r.status === 'ready') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        r.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      r.once('ready', done);
    });
  }

  // ── Full-disconnect grace ────────────────────────────────────────────────

  /** `reported`: the device still counts during an automatic away (see
   *  PresenceSummary.reported). */
  hold(userId: bigint, active: boolean, reported = false): void {
    this.holds.set(userId, { active, reported, settled: false });
  }

  /** The held device's close grace has passed (see the module comment).
   *  Returns whether the user was held. */
  settleHold(userId: bigint): boolean {
    const held = this.holds.get(userId);
    if (!held) return false;
    held.settled = true;
    return true;
  }

  release(userId: bigint): void {
    this.holds.delete(userId);
  }

  /** This replica's contribution, a held user counting as one connection. */
  private localTally(userId: bigint): Tally {
    const s = this.source.presenceSummary(userId);
    // g also counts a pre-update device's resume-window ghost.
    const g = s.legacy ?? 0;
    if (s.live > 0) return { ...EMPTY_TALLY, l: s.live, a: s.active, r: s.reported ?? 0, g };
    const held = this.holds.get(userId);
    if (!held) return EMPTY_TALLY;
    const active = held.active ? 1 : 0;
    const reported = held.active && held.reported ? 1 : 0;
    return held.settled
      ? { ...EMPTY_TALLY, l: 1, h: 1, ha: active, hr: reported, g }
      : { ...EMPTY_TALLY, l: 1, a: active, r: reported, g };
  }

  /** This replica's view of the user, a held user counting as one connection. */
  localSummary(userId: bigint): PresenceSummary {
    return reduceTally(this.localTally(userId));
  }

  // ── Recompute ────────────────────────────────────────────────────────────

  /**
   * Recompute the user's effective status, write it if it changed, and
   * broadcast. Resolves to the effective status, or null if it could not be
   * determined (user gone, persistent CAS conflict, DB error — logged).
   * Never rejects: presence is soft state and must not break a gateway or
   * REST path.
   */
  recompute(userId: bigint, opts: RecomputeOptions = {}): Promise<EffectiveStatus | null> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const run = prev.then(() => this.recomputeNow(userId, opts));
    this.chains.set(userId, run);
    void run.then(() => {
      if (this.chains.get(userId) === run) this.chains.delete(userId);
    });
    return run;
  }

  private async recomputeNow(
    userId: bigint,
    opts: RecomputeOptions,
  ): Promise<EffectiveStatus | null> {
    try {
      /** What this call last wrote (and broadcast), if anything. */
      let wrote: EffectiveStatus | null = null;
      // A pre-update app's new session, now or seen while Redis was failing.
      const newLegacySession =
        opts.legacyIdentified === true || this.pendingLegacyIdentify.has(userId);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const summary = await this.clusterSummary(userId);
        const [row] = await db
          .select({
            status: schema.users.status,
            chosenStatus: schema.users.chosenStatus,
            chosenStatusAuto: schema.users.chosenStatusAuto,
          })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        if (!row) return null;
        // A pre-update client's AUTOMATIC away (chosen 'idle' from a PATCH
        // without the manual marker — users.chosenStatusAuto) says its device
        // is not in use, not that the user picked Away: while it stands, the
        // status follows the other devices alone (`reported`), connections
        // of pre-update apps that could have set it counting as not in use
        // (`legacy`). So an old phone left open and
        // untouched can't hold the user Away while they type on the Mac, nor
        // leave them online once the Mac goes idle too. A picked Away stays.
        //
        // It ends (chosen back to 'online', in this same write) when:
        //   - nothing is left: no device at all, as the old server's
        //     disconnect → reconnect did — an old app killed while auto-idle
        //     can't un-idle itself; this includes an automatic idle PATCHed
        //     while the row ALREADY reads offline (an old app whose socket
        //     was down);
        //   - no such pre-update device is about (not even reconnecting) while
        //     another device is in use, so the old app reads Online when it's
        //     opened again;
        //   - such a pre-update app starts a new session (IDENTIFY, not after
        //     a refused RESUME on the same socket): launched again, it doesn't
        //     know it was auto-idle (that lived in its memory) and, used,
        //     would otherwise never count — even if its last socket is still
        //     in its resume window.
        // The first two read the same effective status either way. Never on a
        // partial view (Redis failing): another replica's old device may be
        // missing from it, and the end can't be undone — a new session seen
        // then still ends it on the next full view (pendingLegacyIdentify).
        const autoIdle = row.chosenStatus === 'idle' && row.chosenStatusAuto;
        const legacy = summary.legacy ?? 0;
        const reported = summary.reported ?? 0;
        // Kept for this call's compare-and-set retries; remembered across a
        // partial view only while an automatic away stands (one set later is
        // another away, which that session never saw).
        if (!autoIdle) this.pendingLegacyIdentify.delete(userId);
        else if (summary.partial && newLegacySession) this.pendingLegacyIdentify.add(userId);
        else if (!summary.partial) this.pendingLegacyIdentify.delete(userId);
        const autoIdleOver =
          autoIdle &&
          !summary.partial &&
          (summary.live === 0 || (legacy === 0 && reported > 0) || newLegacySession);
        const chosen: ChosenStatus = autoIdleOver ? 'online' : row.chosenStatus;
        const next =
          autoIdle && !autoIdleOver
            ? effectiveStatus('online', { live: summary.live, active: reported })
            : effectiveStatus(chosen, summary);
        const resetAutoIdle = chosen !== row.chosenStatus;
        const changed = next !== row.status;
        if (!changed && !resetAutoIdle) {
          if (opts.broadcast === 'always' && wrote === null) {
            const shown = shownChosenStatus(row.chosenStatus, row.chosenStatusAuto);
            await this.broadcast(userId, next, shown, opts.audience);
          }
          return next;
        }
        // Compare-and-set on exactly what we read: if another recompute (or a
        // chosen-status PATCH) got in between, this matches nothing and we
        // start over from fresh inputs instead of overwriting newer truth.
        const updated = await db
          .update(schema.users)
          .set(
            resetAutoIdle
              ? { status: next, chosenStatus: chosen, chosenStatusAuto: false }
              : { status: next },
          )
          .where(
            and(
              eq(schema.users.id, userId),
              eq(schema.users.status, row.status),
              eq(schema.users.chosenStatus, row.chosenStatus),
              eq(schema.users.chosenStatusAuto, row.chosenStatusAuto),
            ),
          )
          .returning({ id: schema.users.id });
        if (updated.length === 0) continue;
        // "Last online", as before: the moment they came or went VISIBLY. The
        // stamp is gated on status <> 'invisible' in SQL (services/presence),
        // which covers arriving invisible; leaving invisible → offline (they
        // dropped Invisible while disconnected) was never a visible moment,
        // so it must not stamp either.
        if (changed && ((next === 'offline' && row.status !== 'invisible') || row.status === 'offline')) {
          await touchLastSeen(userId);
        }
        // Only the chosen status changed (an automatic away ended): others
        // see nothing new and the user's updated clients were already shown
        // 'online' as the pick, so no frame unless asked.
        if (changed || opts.broadcast === 'always') {
          const shown = shownChosenStatus(chosen, !resetAutoIdle && row.chosenStatusAuto);
          await this.broadcast(userId, next, shown, opts.audience);
        }
        // One replica: recomputes are serialized here and every input change
        // queues one of its own, so what we read is what we wrote against.
        if (!this.clustered) return next;
        // Cluster: re-validate against a snapshot taken AFTER the write (next
        // round). Another replica may have written between our snapshot and
        // our compare-and-set from newer inputs; if so this round sees them
        // and writes the status they give.
        wrote = next;
      }
      log.warn('presence: recompute did not settle', { userId: userId.toString() });
      return wrote;
    } catch (err) {
      log.warn('presence: recompute failed', {
        userId: userId.toString(),
        err: (err as Error).message,
      });
      return null;
    }
  }

  /** `chosen`: the pick as updated clients are shown it (shownChosenStatus). */
  private async broadcast(
    userId: bigint,
    status: EffectiveStatus,
    chosen: ChosenStatus,
    audience?: PresenceAudience,
  ): Promise<void> {
    let a = audience;
    if (!a) {
      const [memberRows, dmRows, friendIds] = await Promise.all([
        db
          .select({ guildId: schema.guildMembers.guildId })
          .from(schema.guildMembers)
          .where(eq(schema.guildMembers.userId, userId)),
        db
          .select({ channelId: schema.dmRecipients.channelId })
          .from(schema.dmRecipients)
          .where(eq(schema.dmRecipients.userId, userId)),
        listAcceptedFriendIds(userId),
      ]);
      a = {
        guildIds: memberRows.map((r) => r.guildId),
        dmChannelIds: dmRows.map((r) => r.channelId),
        friendIds,
      };
    }
    dispatch.presenceUpdate({
      userId,
      // 'invisible' is private: everyone else sees plain 'offline'. The
      // user's own clients know the difference from their chosenStatus.
      status: status === 'invisible' ? 'offline' : status,
      guildIds: a.guildIds,
      dmChannelIds: a.dmChannelIds,
      // Friends (who may share no guild/DM) + the user's OWN connections, so
      // each of their devices shows their current effective dot…
      userIds: a.friendIds.includes(userId) ? a.friendIds : [...a.friendIds, userId],
      // …and, on their frame only, what they picked: a pick made on one
      // device (Invisible arrives as plain 'offline') reaches the pickers of
      // the others.
      self: { userId, chosenStatus: chosen },
    });
  }

  // ── Cluster aggregation ──────────────────────────────────────────────────

  /**
   * The user's summary across every replica: publish ours, read everyone's,
   * sum the fresh ones. Single replica, or Redis failing: ours alone.
   */
  async clusterSummary(userId: bigint): Promise<PresenceSummary> {
    const local = this.localTally(userId);
    const r = this.redis;
    if (!r) return reduceTally(local);
    try {
      const key = keyFor(userId);
      const now = Date.now();
      const tx = r.multi();
      if (local.l > 0) {
        tx.hset(key, this.instanceId, serializeEntry(local, now));
        tx.pexpire(key, this.staleMs * 2);
      } else {
        tx.hdel(key, this.instanceId);
      }
      tx.hgetall(key);
      const res = await tx.exec();
      if (!res) throw new Error('transaction aborted');
      for (const [err] of res) if (err) throw err;
      if (local.l > 0) this.published.add(userId);
      else this.published.delete(userId);
      this.degraded.delete(userId);
      const all = res[res.length - 1]![1] as Record<string, string>;
      const total = { ...local };
      for (const [field, raw] of Object.entries(all)) {
        if (field === this.instanceId) continue;
        const e = parseEntry(raw);
        if (!e || now - e.t > this.staleMs) continue;
        total.l += e.l;
        total.a += e.a;
        total.h += e.h;
        total.ha += e.ha;
        total.r += e.r;
        total.hr += e.hr;
        total.g += e.g;
      }
      return reduceTally(total);
    } catch (err) {
      this.warnRedis(err);
      this.degraded.add(userId);
      return { ...reduceTally(local), partial: true };
    }
  }

  /** Close the Redis client (shutdown). */
  async closeRedis(): Promise<void> {
    try {
      await this.redis?.quit();
    } catch {
      // closing anyway
    }
  }

  private warnRedis(err: unknown): void {
    const now = Date.now();
    if (now - this.lastRedisWarnAt < 60_000) return;
    this.lastRedisWarnAt = now;
    log.warn('presence: redis unavailable, using this replica only', {
      err: (err as Error)?.message ?? String(err),
    });
  }

  /**
   * Heartbeat (every replica, cluster mode): refresh this replica's entry for
   * every user it holds so it doesn't go stale, drop entries for users it no
   * longer holds, and heal what other replicas may have computed without
   * this one's devices:
   *   - users whose entry had gone missing (the HSET created the field) —
   *     e.g. this replica couldn't reach Redis long enough for the leader's
   *     sweep to drop it as stale and recompute them without it;
   *   - users whose last recompute here ran on this replica's view alone
   *     because Redis was failing;
   *   - users this replica holds whose row reads 'offline' (e.g. offlined by
   *     the blanket boot reset of a node running without REDIS_URL) — only when
   *     this beat reached Redis. A replica cut off from Redis (but not from
   *     Postgres) can't publish its entries, so the leader's sweep rightly
   *     reads its users as gone and offlines them; healing them back from
   *     this replica's own view would be undone by the next sweep, flapping
   *     every member's dot offline/online for as long as the partition
   *     lasts. They stay offline until a beat reaches Redis again, and that
   *     beat's HSET re-creates the swept field, which heals them above.
   */
  async heartbeat(): Promise<void> {
    const r = this.redis;
    if (!r) return;
    const users = [...new Set<bigint>([...this.source.liveUserIds(), ...this.holds.keys()])];
    const heal = new Set<bigint>();
    const now = Date.now();
    let redisOk = false;
    try {
      const p = r.pipeline();
      for (const userId of users) {
        const key = keyFor(userId);
        p.hset(key, this.instanceId, serializeEntry(this.localTally(userId), now));
        p.pexpire(key, this.staleMs * 2);
      }
      const userSet = new Set(users);
      const gone = [...this.published].filter((u) => !userSet.has(u));
      for (const userId of gone) p.hdel(keyFor(userId), this.instanceId);
      if (users.length > 0 || gone.length > 0) {
        const res = (await p.exec()) ?? [];
        for (const [err] of res) if (err) throw err;
        // HSET replies with the number of fields it CREATED (1 = was missing).
        users.forEach((userId, i) => {
          if (res[i * 2]?.[1] === 1) heal.add(userId);
        });
      }
      for (const userId of gone) this.published.delete(userId);
      for (const userId of users) this.published.add(userId);
      for (const userId of this.degraded) heal.add(userId);
      this.degraded.clear();
      redisOk = true;
    } catch (err) {
      this.warnRedis(err);
    }
    if (heal.size > 0) {
      await runBounded(
        [...heal].map((userId) => async () => {
          await this.recompute(userId);
        }),
        SWEEP_CONCURRENCY,
      );
    }

    // Heal rows read as offline (one indexed read per 1000 users) — not
    // while this replica is cut off from Redis (see above).
    if (!redisOk) return;
    const ids = [...this.source.liveUserIds()];
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      try {
        const rows = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(inArray(schema.users.id, chunk), eq(schema.users.status, 'offline')));
        await runBounded(
          rows.map((row) => async () => {
            await this.recompute(row.id);
          }),
          SWEEP_CONCURRENCY,
        );
      } catch (err) {
        log.warn('presence: heartbeat heal failed', { err: (err as Error).message });
      }
    }
  }

  /**
   * Graceful shutdown: delete this replica's entries, so the next boot (or
   * another replica's sweep) doesn't count this process's users for the
   * staleness window after they're gone. Best-effort. A crash skips this;
   * its entries then simply age out.
   */
  async withdraw(): Promise<void> {
    const r = this.redis;
    if (!r) return;
    const users = new Set<bigint>([
      ...this.published,
      ...this.source.liveUserIds(),
      ...this.holds.keys(),
    ]);
    if (users.size === 0) return;
    try {
      const p = r.pipeline();
      for (const userId of users) p.hdel(keyFor(userId), this.instanceId);
      await p.exec();
      this.published.clear();
    } catch (err) {
      this.warnRedis(err);
    }
  }

  /**
   * Find users shown present (online / idle / dnd) whose Redis entries are
   * missing or partly stale — their replica died — and recompute them. Drops
   * the stale fields first, so the recompute (and later sweeps) ignore them.
   * Run by the leader on an interval, and by every replica once at boot.
   * Throws when Redis is unreachable (the boot path then falls back).
   * `scope` limits it to some users (tests sharing a database).
   */
  async sweep(scope?: PresenceScope): Promise<number> {
    const r = this.redis;
    if (!r) return 0;
    let recomputed = 0;
    let after = 0n;
    for (;;) {
      const page = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            inArray(schema.users.status, ['online', 'idle', 'dnd']),
            gt(schema.users.id, after),
            scope ? inArray(schema.users.id, scope.userIds) : undefined,
          ),
        )
        .orderBy(asc(schema.users.id))
        .limit(SWEEP_PAGE);
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;

      const p = r.pipeline();
      for (const { id } of page) p.hgetall(keyFor(id));
      const res = await p.exec();
      if (!res) throw new Error('pipeline aborted');
      const now = Date.now();
      const stale = r.pipeline();
      let staleCount = 0;
      const toRecompute: bigint[] = [];
      page.forEach(({ id }, i) => {
        const [err, value] = res[i]!;
        if (err) throw err;
        let fresh = 0;
        let hasStale = false;
        for (const [field, raw] of Object.entries(value as Record<string, string>)) {
          const e = parseEntry(raw);
          if (e && now - e.t <= this.staleMs) {
            fresh++;
            continue;
          }
          hasStale = true;
          stale.hdel(keyFor(id), field);
          staleCount++;
        }
        if (fresh === 0 || hasStale) toRecompute.push(id);
      });
      if (staleCount > 0) await stale.exec();
      await runBounded(
        toRecompute.map((id) => async () => {
          await this.recompute(id);
        }),
        SWEEP_CONCURRENCY,
      );
      recomputed += toRecompute.length;
      if (page.length < SWEEP_PAGE) break;
    }
    return recomputed;
  }
}

// ── Process singleton ──────────────────────────────────────────────────────

let engine: PresenceEngine | null = null;

/** The engine the gateway and routes use: this process's registry, plus Redis
 *  aggregation when REDIS_URL is set. */
export function presence(): PresenceEngine {
  if (engine) return engine;
  let client: Redis | null = null;
  if (env.REDIS_URL) {
    // Same posture as the session blacklist / cluster leases: no offline
    // queue and a hard command timeout, so an outage makes commands REJECT
    // (→ this replica's own view) instead of hanging a gateway path.
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 2000,
      lazyConnect: false,
    });
    client.on('error', () => {});
  }
  engine = new PresenceEngine({ source: registry, redis: client, instanceId: clusterInstanceId() });
  return engine;
}

/** Shutdown hook (index.ts): withdraw this replica's Redis entries and close
 *  the client. No-op if the engine was never created or has no Redis. */
export async function shutdownPresence(): Promise<void> {
  const eng = engine;
  if (!eng) return;
  await eng.withdraw();
  await eng.closeRedis();
}

/**
 * Boot-time reset. Presence is persisted on users.status, and a process that
 * died never ran its close hooks, so rows still assert "present" for users
 * with no connection.
 *
 * Single replica: there are no connections at boot by definition, so every
 * online / idle / dnd row is stale — reset them all to 'offline' ('invisible'
 * is preserved: it already reads as offline and is the user's choice), and
 * end a legacy client's automatic away the way recompute does.
 *
 * Cluster: users connected to OTHER replicas are live; a blanket reset would
 * offline them. Run the sweep instead (it only touches users without a fresh
 * entry). If Redis can't be reached, reset nothing: a blanket reset would
 * offline users on the other replicas, and their heartbeats can't heal them
 * while Redis is down (a beat that can't reach Redis must not heal — see
 * heartbeat). Rows left by a dead replica stay until Redis is back, when the
 * leader's sweep (every SWEEP_INTERVAL) offlines them.
 */
export async function resetPresenceOnBoot(
  eng: PresenceEngine = presence(),
  scope?: PresenceScope,
): Promise<void> {
  if (eng.clustered) {
    try {
      await eng.whenReady();
      const n = await eng.sweep(scope);
      if (n > 0) log.info('gateway: reset stale presence on boot', { count: n, mode: 'cluster' });
      return;
    } catch (err) {
      log.warn('gateway: cluster presence reset skipped (Redis unreachable); the sweep will catch up', {
        err: (err as Error).message,
      });
      return;
    }
  }
  // Like a recompute to 'offline', this ends a legacy client's automatic
  // away (users.chosenStatusAuto — only ever set alongside chosen 'idle').
  const reset = await db
    .update(schema.users)
    .set({
      status: 'offline',
      chosenStatus: sql`CASE WHEN ${schema.users.chosenStatusAuto} THEN 'online'::user_status ELSE ${schema.users.chosenStatus} END`,
      chosenStatusAuto: false,
    })
    .where(
      and(
        inArray(schema.users.status, ['online', 'idle', 'dnd']),
        scope ? inArray(schema.users.id, scope.userIds) : undefined,
      ),
    )
    .returning({ id: schema.users.id });
  if (reset.length > 0) {
    log.info('gateway: reset stale presence on boot', { count: reset.length });
  }
}
