/**
 * Refresh-rotation replay recovery
 * --------------------------------
 * The one failure this exists for: the LOST RESPONSE. `/auth/refresh` rotates
 * T0 → T1 and COMMITS, then the reply never lands (client timeout, dropped
 * connection, the api restarting between the UPDATE and the Set-Cookie, a phone
 * suspending mid-flight). The client still holds T0 and has no way to know it
 * isn't current, so it presents it again — and since nothing on the server can
 * ever issue a token for a superseded hash, every retry is rejected forever and
 * the user has to re-enter their password.
 *
 * Widening the reuse grace window does NOT fix that: it only decides whether we
 * *also* revoke the session. The fix is to make the rotation IDEMPOTENT for the
 * length of the grace window — a replay of T0 gets back the very same T1 that
 * the lost response carried, so the client lands in exactly the state it would
 * have been in if the response had arrived. No re-login, no revocation, and no
 * second rotation (re-rotating from a superseded token would silently kill the
 * T1 that the winner of a multi-tab race is already holding).
 *
 * Storing a live bearer token, safely
 * -----------------------------------
 * The sessions table deliberately stores only hashes so a db dump can't be used
 * to forge sessions, and this must not weaken that. So the retained token is
 * never stored in the clear anywhere:
 *
 *   - the LOOKUP KEY is the same peppered sha256 the sessions row already
 *     stores for the superseded token;
 *   - the VALUE is T1 sealed with AES-256-GCM under a key derived from the
 *     plaintext of T0 itself. T0 is 256 bits of randomness, and only the party
 *     that already holds T0 can derive that key — so a dump of this store is
 *     worthless on its own. It is not a second copy of the credential; it is a
 *     copy that only the credential's holder can open.
 *   - the client's User-Agent is bound in as GCM additional authenticated data.
 *     An honest lost-response retry always comes from the same client, so a
 *     mismatch fails the auth tag, no token comes back, and the caller falls
 *     through to exactly the behaviour it had before this module existed
 *     (409 now, theft-revocation once the grace window closes). Failing that
 *     way round is deliberate: a UA mismatch must never *cause* a revocation,
 *     because a browser that self-updated between the rotation and the retry
 *     would otherwise get its session killed.
 *
 * Entries live only as long as the reuse grace window (the caller passes the
 * TTL, so there is one source of truth for that duration) and are readable more
 * than once on purpose: the recovery response can be lost to the exact same
 * network fault as the original, and a single-use entry would strand the client
 * all over again. But re-readable is not the same as UNLIMITED — each entry
 * carries a small redemption budget, spent through an atomic counter and
 * destroyed the moment its last unit goes. See MAX_REPLAY_RECOVERIES for the
 * size of that budget and for exactly which part of the threat model it closes
 * (and, just as importantly, which part it does not).
 *
 * Backends mirror the session blacklist: shared Redis when REDIS_URL is set —
 * which is what makes recovery survive an api restart and work across replicas,
 * the very cases that motivated this — otherwise an in-memory TTL map, correct
 * for single-node and tests. Every operation FAILS SOFT: if the store is
 * unavailable we simply can't recover, which is the pre-existing behaviour.
 */

import Redis from 'ioredis';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env';
import { hashRefreshToken } from './tokens';

const PREFIX = 'zekktris:refreshreplay:';
/** Per-SESSION recovery windows. A separate namespace from PREFIX (whose keys
    are per-rotation token hashes) so the two can never alias. */
const COUNT_PREFIX = 'zekktris:refreshreplaycount:';

/**
 * How many times a single retained rotation may be redeemed before its entry is
 * spent and destroyed.
 *
 * Why three. An honest client needs ONE — the retry of the request whose
 * response was lost. It can need a SECOND, because the recovery response can be
 * eaten by the very same fault that ate the original. The third is for the
 * multi-tab race this branch was originally built for: when two tabs refresh on
 * the same instant the LOSER also lands on the `concurrent` branch and redeems a
 * unit, with no fault involved at all, so a three-tab browser can legitimately
 * spend two. Below three, ordinary racing tabs start eating the budget that an
 * actually-faulted client needs; above three buys the attacker described below
 * nothing, because he needs exactly one.
 *
 * ── What the cap buys, precisely ──────────────────────────────────────────
 *
 * A captured superseded token is no longer an UNLIMITED oracle for the token
 * that replaced it. Redemptions per rotation go from unbounded to three, and the
 * sealed blob is deleted the instant the budget runs out instead of sitting
 * there for the rest of the grace window — so the wall-clock time during which a
 * redeemable copy of a live credential exists at all collapses to the honest
 * client's actual need, which is usually milliseconds.
 *
 * It also makes honest use and abuse compete for one scarce resource. If the
 * legitimate tabs spend the budget first, the attacker's replay falls through to
 * the 409, and when the grace window closes that same replay is reclassified as
 * `theft` and revokes the session — i.e. in that case the attack self-terminates
 * exactly as it did before this module existed.
 *
 * ── What the cap does NOT buy ─────────────────────────────────────────────
 *
 * It does not stop indefinite evasion of the reuse detector, and it is worth
 * being blunt about that because the opposite is an easy thing to believe. The
 * reasoning "sustained evasion needs a fresh recovery every window, and the cap
 * denies it" is FALSE: the cap is per RETAINED ROTATION, and every rotation the
 * victim performs mints a brand-new entry with a full budget. An attacker
 * holding a cloned cookie and a matching User-Agent needs exactly ONE redemption
 * per window to stay on the chain (recover T1 from T0, then later T2 from T1, …)
 * and one is always available to him.
 *
 * Bounding THAT needs state that survives across rotations — a per-session
 * recovery budget, or tainting a token that was handed out by a recovery so the
 * next rotation retains nothing for it. Both were considered and deliberately
 * not taken here, because both convert a client on a genuinely flaky link (and,
 * for the taint variant, an ordinary multi-tab user) into a 409 and then, at the
 * end of the window, a revoked session — which is precisely the mass-logout this
 * whole path exists to prevent. That is a posture decision with a real
 * availability price, not a code cleanup, so it stays an explicit open item
 * rather than a side effect of this change.
 *
 * The controls that do apply to that attacker are unchanged: he must already
 * hold the cookie, he must match the User-Agent, the grace window is short, and
 * every redemption emits `refresh replay recovered` with the session id. That
 * log line is no longer the end of it: `noteRecoveredRotation` below counts
 * recovered rotations per session across a window far longer than one rotation
 * and raises a real security event once the pattern is unmistakable, which is
 * the only place the chain-riding described here becomes visible.
 */
export const MAX_REPLAY_RECOVERIES = 3;

/**
 * Escalation: repeated recoveries for ONE session.
 * ------------------------------------------------
 * The cap above is per RETAINED ROTATION, so by construction it cannot see the
 * attack it does not stop: one redemption per rotation, forever, each from a
 * fresh entry with a fresh budget. Seeing that needs state that outlives a
 * rotation, which is what these two constants are.
 *
 * WHAT IS COUNTED: distinct ROTATIONS recovered by a session, not redemptions.
 * The member is the (truncated) hash of the superseded token, so every
 * redemption of the same retained rotation collapses to one — which is exactly
 * what a burst of racing tabs is, and what a client retrying a lost response
 * two or three times is. Both are one fault against one rotation and count as
 * one. Riding the chain cannot be collapsed that way: the attacker must recover
 * a NEW rotation (T1 from T0, then T2 from T1, …) every window or he falls off
 * it, and re-redeeming an old entry hands him a token that is no longer
 * current. So the metric is aligned with the attack and blind to the noise.
 *
 * WHY SIX HOURS. It has to be much longer than one rotation or it measures the
 * same thing the cap already does. A client refreshing continuously rotates
 * about every ACCESS_TOKEN_TTL_SECONDS (900s default), so six hours spans on
 * the order of 24 rotations — and 180× the two-minute reuse grace that bounds a
 * single recovery. Long enough for a pattern to be a pattern; short enough that
 * an event still points at something happening now, and that a stale count from
 * this morning can't fire tonight.
 *
 * WHY FIVE. Erring quiet, deliberately. One lost rotation response is one
 * distinct rotation. A phone on a dying link that loses three responses in a
 * row still loses them against three rotations only if it actually rotated
 * three times in between — and if it did, it is a genuinely broken link, which
 * is worth an operator's glance anyway (the event says so rather than crying
 * theft). Below about five, ordinary bad connectivity starts producing events
 * and the alert becomes wallpaper; well above five, an attacker rides for most
 * of a day unremarked. At five, sustained chain-riding trips it in roughly
 * 5 × 15 min ≈ 75 minutes and still has ~19 rotations of headroom left in the
 * window, while at most ONE event can ever be written per session per window —
 * four a day even under a permanent attack.
 *
 * The hard cap bounds the per-session member set so a long-lived session on a
 * pathological link cannot grow it without limit; it must stay above the
 * threshold or the escalation could never be observed.
 */
export const RECOVERY_ALERT_WINDOW_SECONDS = 6 * 60 * 60;
export const RECOVERY_ALERT_THRESHOLD = 5;
const RECOVERY_COUNT_HARD_CAP = 64;

interface ReplayStore {
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** The sealed blob, WITHOUT spending any of its redemption budget. */
  peek(key: string): Promise<string | null>;
  /**
   * Atomically spend one unit of `key`'s budget. True means this caller is one
   * of the first `maxReads` redeemers and may be served; false means the entry
   * is gone or exhausted. Deletes the entry once the last unit is spent.
   *
   * Atomic, not read-then-write, on purpose: two tabs racing the same lost
   * response arrive here concurrently, and a compare-then-increment would let
   * every one of them through the same remaining unit.
   */
  spend(key: string, maxReads: number): Promise<boolean>;
  /**
   * Record `member` under `key` and return how many DISTINCT members `key` has
   * collected inside its current window, or null if the store can't say (it is
   * down — the caller then simply doesn't escalate).
   *
   * The window is TUMBLING, not sliding: the TTL is set when the first member
   * arrives and is never extended, so the whole set disappears at the end of it
   * and counting restarts from zero. A sliding window would let one recovery
   * every few hours keep a set alive indefinitely and eventually trip on a
   * count accumulated over days, which is the opposite of a signal that
   * something is happening NOW.
   *
   * Atomic like `spend`, and for the same reason plus one more: the caller
   * escalates on the exact transition to the threshold, so if two concurrent
   * recoveries could both observe the same count they would both alert.
   */
  noteDistinct(
    key: string,
    member: string,
    windowSeconds: number,
    hardCap: number,
  ): Promise<number | null>;
}

/** In-memory TTL map with lazy expiry and a cheap periodic sweep. */
class MemoryReplayStore implements ReplayStore {
  private readonly map = new Map<string, { value: string; exp: number; reads: number }>();
  /** Per-session recovery windows (see noteDistinct). Separate map, separate
      lifetime: these live for hours, the sealed blobs for a couple of minutes. */
  private readonly windows = new Map<string, { members: Set<string>; exp: number }>();
  private lastSweep = 0;

  /** Drop expired entries from both maps, at most once a minute. Neither map
      removes anything on read alone, so without this a long-lived process
      accumulates one dead entry per rotation and per session that recovered. */
  private sweep(now: number): void {
    if (now - this.lastSweep <= 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.map) if (v.exp <= now) this.map.delete(k);
    for (const [k, v] of this.windows) if (v.exp <= now) this.windows.delete(k);
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    this.map.set(key, { value, exp: now + Math.max(1, ttlSeconds) * 1000, reads: 0 });
    this.sweep(now);
  }

  /** Live entry or null, dropping it if it has expired. */
  private live(key: string): { value: string; exp: number; reads: number } | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.exp <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return hit;
  }

  async peek(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async spend(key: string, maxReads: number): Promise<boolean> {
    const hit = this.live(key);
    if (!hit) return false;
    // Node runs one request at a time and there is no await between the read
    // and the write below, so this whole block is atomic against every other
    // in-flight redemption — the single-node equivalent of the Lua script the
    // Redis store uses.
    hit.reads += 1;
    const allowed = hit.reads <= maxReads;
    if (hit.reads >= maxReads) this.map.delete(key);
    return allowed;
  }

  async noteDistinct(
    key: string,
    member: string,
    windowSeconds: number,
    hardCap: number,
  ): Promise<number | null> {
    const now = Date.now();
    this.sweep(now);
    let win = this.windows.get(key);
    if (win && win.exp <= now) {
      this.windows.delete(key);
      win = undefined;
    }
    if (!win) {
      // Window opens here and expires on its own schedule — `exp` is never
      // touched again, matching the Redis store's set-TTL-once behaviour.
      win = { members: new Set<string>(), exp: now + Math.max(1, windowSeconds) * 1000 };
      this.windows.set(key, win);
    }
    // Same single-threaded atomicity argument as `spend`: no await between the
    // read and the write, so no two recoveries can observe the same size.
    if (win.members.size < hardCap) win.members.add(member);
    return win.members.size;
  }
}

/**
 * Create the entry and give it a TTL in one shot. Two commands would leave an
 * IMMORTAL key holding a sealed live token if the connection died between them.
 *
 * The counter is written explicitly rather than left for HINCRBY to create, so
 * that a fresh entry always starts with a fresh budget — matching the memory
 * store, and true even if a key somehow survived from a previous generation.
 */
const PUT_LUA = `
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'n', 0)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * Spend one unit of the entry's budget. Returns 1 if the caller may be served.
 *
 * The EXISTS guard is load-bearing: HINCRBY on a missing key CREATES it, so
 * without the guard a redemption that raced the entry's deletion (budget spent
 * by another tab, or TTL expiry) would resurrect a counter key with no
 * expiry — a slow leak of keys that can never be read.
 */
const SPEND_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local n = redis.call('HINCRBY', KEYS[1], 'n', 1)
local cap = tonumber(ARGV[1])
if n >= cap then redis.call('DEL', KEYS[1]) end
if n > cap then return 0 end
return 1
`;

/**
 * Add one recovered rotation to a session's window and return the window's
 * distinct count.
 *
 * The TTL is set only when the key has none (TTL < 0 covers both "missing" and
 * "no expiry"), so the window tumbles instead of sliding — see noteDistinct.
 * The cap check runs BEFORE the SADD so a runaway session can neither grow the
 * set nor keep re-arming it; returning the capped count is harmless because the
 * caller only ever acts on the exact threshold, which is far below the cap.
 */
const NOTE_LUA = `
local cap = tonumber(ARGV[3])
if redis.call('SCARD', KEYS[1]) >= cap then return cap end
redis.call('SADD', KEYS[1], ARGV[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return redis.call('SCARD', KEYS[1])
`;

class RedisReplayStore implements ReplayStore {
  constructor(private readonly redis: Redis) {}
  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.eval(PUT_LUA, 1, key, value, String(Math.max(1, Math.ceil(ttlSeconds))));
    } catch {
      // Best-effort. A failed write only means a lost response won't be
      // recoverable — the same as before this existed.
    }
  }
  async peek(key: string): Promise<string | null> {
    try {
      return (await this.redis.hget(key, 'v')) ?? null;
    } catch {
      return null; // fail soft
    }
  }
  async spend(key: string, maxReads: number): Promise<boolean> {
    try {
      return Number(await this.redis.eval(SPEND_LUA, 1, key, String(maxReads))) === 1;
    } catch {
      // Fail CLOSED, unlike the reads above: if we cannot prove the budget was
      // there to spend, we must not serve a live token. The caller falls through
      // to its 409, which is where it was before recovery existed.
      return false;
    }
  }
  async noteDistinct(
    key: string,
    member: string,
    windowSeconds: number,
    hardCap: number,
  ): Promise<number | null> {
    try {
      const n = Number(
        await this.redis.eval(
          NOTE_LUA,
          1,
          key,
          member,
          String(Math.max(1, Math.ceil(windowSeconds))),
          String(hardCap),
        ),
      );
      return Number.isFinite(n) ? n : null;
    } catch {
      // Fail soft: instrumentation must never affect the refresh. Losing the
      // count means at worst a missed escalation, which is where we were before
      // this existed.
      return null;
    }
  }
}

// Lazily built, like the session blacklist's: importing this module (which any
// import of auth/sessions does, including from tests and one-off scripts) must
// not open a Redis socket on its own.
let store: ReplayStore | null = null;
function getStore(): ReplayStore {
  if (store) return store;
  if (env.REDIS_URL) {
    // Same hardened client options as the session blacklist: no offline queue
    // and a hard command timeout, so a Redis outage rejects fast instead of
    // hanging a request that is sitting in the middle of the refresh path.
    const redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1000,
    });
    redis.on('error', () => {});
    store = new RedisReplayStore(redis);
  } else {
    store = new MemoryReplayStore();
  }
  return store;
}

/** Sealing key for a retained token: derivable only from the plaintext of the
    token being superseded. */
function sealingKey(supersededToken: string): Buffer {
  return createHash('sha256')
    .update('zekktris.refresh-replay.v1')
    .update(supersededToken, 'utf8')
    .digest();
}

/** GCM additional data: the presenting client's User-Agent, so a retained token
    can only be unsealed by the same client the rotation was issued to. */
function clientBinding(userAgent: string | null): Buffer {
  return createHash('sha256').update(userAgent ?? '', 'utf8').digest();
}

/**
 * Retain the token a rotation just issued so a replay of the token it superseded
 * can be answered with that same token. Never throws.
 */
export async function rememberRotatedToken(input: {
  supersededToken: string;
  issuedToken: string;
  userAgent: string | null;
  ttlSeconds: number;
}): Promise<void> {
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sealingKey(input.supersededToken), iv);
    cipher.setAAD(clientBinding(input.userAgent));
    const sealed = Buffer.concat([
      cipher.update(input.issuedToken, 'utf8'),
      cipher.final(),
    ]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64');
    await getStore().put(PREFIX + hashRefreshToken(input.supersededToken), blob, input.ttlSeconds);
  } catch {
    // Recovery is an optimisation over "the user has to log in again"; it must
    // never be able to fail the rotation that already committed.
  }
}

/**
 * Given a superseded token being replayed, return the token the rotation that
 * superseded it issued — or null if there is nothing retained, it expired, the
 * presenting client isn't the one the rotation was issued to, or the entry's
 * redemption budget (MAX_REPLAY_RECOVERIES) is exhausted. Never throws.
 *
 * The caller must still verify the returned token is the session's CURRENT one
 * before handing it back; this store knows nothing about what happened after
 * the rotation it recorded.
 *
 * Unseal FIRST, spend SECOND. The order matters: a caller that cannot open the
 * blob is by definition not the client the rotation was issued to, and letting
 * it burn units would hand anyone who merely holds the cookie a way to starve
 * the honest client's recovery — turning a failed impersonation into a logout.
 * The cost of that order is one extra round trip on a path that only runs when a
 * rotation response was lost, and one wasted unit in the rare case where the
 * caller unseals fine but the token has since been rotated past (the entry is
 * stale anyway, and a genuine key-holder did make the attempt).
 */
export async function recallRotatedToken(input: {
  supersededToken: string;
  userAgent: string | null;
}): Promise<string | null> {
  try {
    const store = getStore();
    const key = PREFIX + hashRefreshToken(input.supersededToken);
    const blob = await store.peek(key);
    if (!blob) return null;
    const raw = Buffer.from(blob, 'base64');
    if (raw.length <= 28) return null; // iv(12) + tag(16) + at least one byte
    const decipher = createDecipheriv('aes-256-gcm', sealingKey(input.supersededToken), raw.subarray(0, 12));
    decipher.setAAD(clientBinding(input.userAgent));
    decipher.setAuthTag(raw.subarray(12, 28));
    const recovered = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
    if (!(await store.spend(key, MAX_REPLAY_RECOVERIES))) return null;
    return recovered;
  } catch {
    // Wrong key, wrong client (AAD mismatch → bad auth tag), corrupt blob, or
    // the store is down. All mean "no recovery available".
    return null;
  }
}

/**
 * Record that `sessionId` just recovered the rotation that superseded
 * `supersededToken`, and report an ESCALATION when that session has recovered
 * RECOVERY_ALERT_THRESHOLD distinct rotations inside
 * RECOVERY_ALERT_WINDOW_SECONDS. Returns null every other time — including on
 * every recovery past the threshold, so one alert is raised per window and a
 * client that flaps cannot spam the security log. See the constants above for
 * what is counted and why those two numbers.
 *
 * Call AFTER a recovery has actually been served. Never throws, and the caller
 * should not await it on the response path: this is instrumentation sitting on
 * the auth hot path and it must not be able to fail, delay, or otherwise change
 * a refresh. A store outage yields null (no alert), which is exactly where we
 * were before this existed.
 *
 * The returned User-Agent hash is the same digest already used as the seal's
 * AAD, truncated: enough to correlate one persistent client across events and
 * sessions, not enough to be a fingerprint of the user's browser in a log, and
 * never the raw header. Nothing here returns or stores token material — the
 * member written to the store is the peppered hash the sessions table already
 * holds, truncated, and it is a set member, not a lookup key for anything.
 */
export async function noteRecoveredRotation(input: {
  sessionId: bigint;
  supersededToken: string;
  userAgent: string | null;
}): Promise<{ count: number; windowSeconds: number; userAgentHash: string } | null> {
  try {
    // One member per ROTATION: every redemption of the same retained rotation
    // (racing tabs, a client retrying a lost response) hashes to the same value
    // and collapses. 64 bits of a sha256 is ample to keep a handful of rotations
    // per session distinct.
    const member = hashRefreshToken(input.supersededToken).slice(0, 16);
    const count = await getStore().noteDistinct(
      COUNT_PREFIX + input.sessionId.toString(),
      member,
      RECOVERY_ALERT_WINDOW_SECONDS,
      RECOVERY_COUNT_HARD_CAP,
    );
    // Strict equality, not >=: the store's counter is atomic, so exactly one
    // caller can ever observe the transition. This is what makes it one event
    // per escalation instead of one per recovery from here on. (Also covers the
    // null the store returns when it is unavailable.)
    if (count !== RECOVERY_ALERT_THRESHOLD) return null;
    return {
      count,
      windowSeconds: RECOVERY_ALERT_WINDOW_SECONDS,
      userAgentHash: clientBinding(input.userAgent).toString('hex').slice(0, 12),
    };
  } catch {
    return null; // fail soft — never let instrumentation break a refresh
  }
}
