/**
 * Sessions
 * --------
 * Each row in `sessions` represents one logged-in device. The row stores
 * the *hash* of a refresh token, never the token itself — so a leaked db
 * dump can't be used to forge sessions.
 *
 * Lifecycle:
 *   create  → on register or login
 *   rotate  → on refresh; new token returned, old hash overwritten
 *   revoke  → on logout, password change, or explicit user action
 *   purge   → cron-style cleanup of long-expired rows (deferred to v1.x)
 */

import { and, desc, eq, gt, isNull, ne, lt } from 'drizzle-orm';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { env } from '../env';
import { generateRefreshToken, hashRefreshToken } from './tokens';
import { blacklistSession } from './session-blacklist';
import { rememberRotatedToken, recallRotatedToken } from './refresh-replay';
import type { Session } from '@zekktris/db';

interface CreateSessionInput {
  userId: bigint;
  userAgent: string | null;
  ipAddress: string | null;
}

export interface CreateSessionResult {
  session: Session;
  refreshToken: string;
}

export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
  const { token, hash } = generateRefreshToken();
  const id = nextSnowflake();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

  const [session] = await db
    .insert(schema.sessions)
    .values({
      id,
      userId: input.userId,
      refreshTokenHash: hash,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
      expiresAt,
    })
    .returning();

  if (!session) throw new Error('Failed to create session');
  return { session, refreshToken: token };
}

/**
 * Look up an active session by its refresh token (plaintext). Returns null
 * if the token is unknown, the session was revoked, or the session expired.
 */
export async function findActiveSessionByRefreshToken(token: string): Promise<Session | null> {
  const hash = hashRefreshToken(token);
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.refreshTokenHash, hash),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Rotate a session's refresh token. Returns the new plaintext token,
 * or null if the session was revoked or expired between find-time
 * and rotate-time (the caller should then treat it as an expired
 * refresh and force the client to log in again). Also bumps
 * last_used_at and extends expires_at by the configured TTL.
 *
 * Why the null return: there's a TOCTOU window between
 * `findActiveSessionByRefreshToken` and this call. Another tab
 * could log out (revoking the session) or the row could lapse the
 * expiry instant. Filtering on `revokedAt IS NULL AND expiresAt > now`
 * inside the UPDATE WHERE makes the rotation atomic — if zero rows
 * match, we know not to issue a new token and can wipe the cookie
 * cleanly.
 */
export async function rotateSession(
  sessionId: bigint,
  expectedCurrentHash: string,
  /**
   * The plaintext token being superseded plus the presenting client's
   * User-Agent. Supplying it lets the rotation be REPLAYED — see
   * `recoverRotatedRefreshToken` — which is what makes a lost response
   * recoverable. Optional only so tests and any non-HTTP caller can rotate
   * without it; the /refresh route always passes it.
   */
  replay?: { supersededToken: string; userAgent: string | null },
): Promise<{ refreshToken: string } | null> {
  const { token, hash } = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);
  // The expectedCurrentHash clause makes rotation atomic against
  // concurrent rotations using the same source token. Without it,
  // two parallel /refresh calls with the same cookie value (both
  // read the cookie before either UPDATE committed) would both
  // succeed: both find the same session via hash(T0), both UPDATE
  // (the WHERE doesn't include hash, so both match), and the
  // result is one row in the DB with hash(T2) while T1 was also
  // issued but never settled — phantom valid-but-unused tokens
  // and broken reuse detection. With the hash predicate, only the
  // rotation that has the truly current hash succeeds; the other
  // gets 0 rows back and returns null, which the route surfaces
  // as 401. Same WHERE conditions as before are retained: a
  // concurrent logout (sets revokedAt) or expiry between the
  // route's find and this UPDATE makes us match 0 rows too, also
  // surfacing 401.
  const result = await db
    .update(schema.sessions)
    .set({
      refreshTokenHash: hash,
      // Remember the hash we just replaced so a later reuse of that superseded
      // token is detectable as theft (see detectRefreshTokenReuse).
      previousRefreshTokenHash: expectedCurrentHash,
      lastUsedAt: new Date(),
      expiresAt,
    })
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.refreshTokenHash, expectedCurrentHash),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .returning({ id: schema.sessions.id });
  if (result.length === 0) return null;
  // The rotation is committed. Retain the token we just issued, sealed so only
  // the holder of the token we just superseded can open it, so that a replay of
  // that superseded token inside the grace window can be answered with THIS
  // token instead of a rejection. This is the whole lost-response fix; see
  // refresh-replay.ts. Awaited (not fire-and-forget) so the response can't
  // race the write — but it never throws, so it can't fail the rotation.
  if (replay) {
    await rememberRotatedToken({
      supersededToken: replay.supersededToken,
      issuedToken: token,
      userAgent: replay.userAgent,
      ttlSeconds: Math.ceil(REFRESH_REUSE_GRACE_MS / 1000),
    });
  }
  return { refreshToken: token };
}

/**
 * The lost-response recovery. Given a superseded refresh token that
 * `detectRefreshTokenReuse` classified as `concurrent`, return the token the
 * rotation that superseded it issued — but only if that token is STILL the
 * session's current one and the session is still active.
 *
 * Mechanism, end to end:
 *   1. `/refresh` rotates T0 → T1 and commits; `rotateSession` retains T1
 *      sealed under a key derived from T0 (see refresh-replay.ts).
 *   2. The response is lost. The client still holds T0 and presents it again.
 *   3. T0 no longer matches any CURRENT hash, but it matches the session's
 *      PREVIOUS hash inside the grace window → `concurrent`.
 *   4. This call unseals T1 and re-verifies it against the live session, and
 *      the route hands the client T1 plus a fresh access token.
 * The client ends up exactly where the lost response would have put it: no
 * password re-entry, no revocation, and — because we do NOT rotate again — the
 * token a multi-tab winner is already holding stays valid.
 *
 * What this deliberately does not do: bump `lastUsedAt` (a replay must not be
 * able to slide the grace window forward) and re-key the session (re-rotating
 * from a superseded token would invalidate the winner's live token and hand the
 * loser a token nobody else can see, which is strictly worse than the bug).
 *
 * Honest cost. A holder of a superseded token can now obtain the live one for
 * the length of the grace window, where before it got nothing. Three things
 * bound that:
 *
 *   1. the retained token is unsealable only by someone who already holds the
 *      superseded PLAINTEXT — i.e. someone who, if they are an attacker, was
 *      already in a position to race the rotation itself;
 *   2. it is bound to the User-Agent the rotation was issued to (a mismatch
 *      simply yields null, back to the old behaviour — never a revocation);
 *   3. each retained rotation can be redeemed at most MAX_REPLAY_RECOVERIES
 *      times, counted atomically, after which the entry is destroyed and the
 *      caller falls through to the ordinary 409.
 *
 * What (3) is and is not worth is spelled out at MAX_REPLAY_RECOVERIES in
 * refresh-replay.ts, and the short version belongs here too because it is the
 * security posture of this function: the cap stops a captured superseded token
 * from being an unlimited oracle and shrinks the lifetime of the redeemable
 * copy to the honest client's real need, but it does NOT make the reuse detector
 * un-evadable. The cap is per rotation, and every rotation the victim performs
 * mints a fresh budget, while an attacker holding a cloned cookie and a matching
 * User-Agent needs only ONE redemption per window to ride the chain. Bounding
 * that needs cross-rotation state (a per-session recovery budget, or refusing to
 * retain after a recovery), and every version of it turns a flaky link into a
 * revoked session — the exact failure this path exists to prevent — so it is an
 * open posture decision, not something quietly closed here. Meanwhile the grace
 * window must stay short rather than be widened further, and repeated
 * recoveries for one session are the signal to act on — which is no longer left
 * to whoever happens to be reading logs: `/auth/refresh` feeds every recovery to
 * `noteRecoveredRotation` (auth/refresh-replay.ts), which counts DISTINCT
 * rotations recovered per session over hours and writes a
 * `refresh_replay_repeated` security event once the count says this is a
 * pattern rather than a lost response. That is detection, not prevention: the
 * posture above is unchanged, an operator still has to look and revoke.
 */
export async function recoverRotatedRefreshToken(
  supersededToken: string,
  userAgent: string | null,
  sessionId: bigint,
): Promise<{ refreshToken: string; session: Session } | null> {
  const recovered = await recallRotatedToken({ supersededToken, userAgent });
  if (!recovered) return null;
  // Re-verify against the live row: the recovered token must still be the
  // session's CURRENT hash (nobody rotated past it) and the session must still
  // be unrevoked and unexpired. If anything moved on, there is nothing safe to
  // hand back and the caller falls through to its rejection path. Returning the
  // row too saves the caller a second lookup for the owner's id.
  const live = await findActiveSessionByRefreshToken(recovered);
  if (!live || live.id !== sessionId) return null;
  return { refreshToken: recovered, session: live };
}

/**
 * How long after a rotation the token that rotation superseded is still
 * tolerated as a benign replay rather than treated as theft. Measured from
 * `lastUsedAt`, which `rotateSession` stamps at the instant it swapped the
 * hash — so it is literally "how long ago was this token superseded".
 *
 * Why two minutes and not the thirty seconds this used to be: the replay we
 * have to absorb isn't only the multi-tab double-submit (which is over in
 * milliseconds) — it's the LOST RESPONSE. The server rotates and commits, and
 * the reply never lands: the client timed out, the connection dropped, the api
 * restarted between the UPDATE and the Set-Cookie, the phone suspended
 * mid-flight. The client is still holding the superseded token and has no way
 * to know it isn't current, so it presents it again. Our slowest client gives
 * up at 30 s (Android OkHttp; iOS at 20 s) and the web client then retries on a
 * bounded backoff ladder of a few more seconds — so an entirely honest replay
 * can legitimately arrive well over a minute after the rotation it lost. At
 * 30 s all of those were classified as theft and the session was revoked.
 *
 * What the window does and does NOT do. On its own it decides exactly one
 * thing: whether a superseded-token replay ALSO revokes the session family. It
 * does not, by itself, make anything recoverable — a rejection at t+90 s
 * instead of a revocation at t+30 s is still a rejection, and for a client
 * whose cookie jar never received the rotated token every later attempt fails
 * identically. That gap is what `recoverRotatedRefreshToken` closes: inside
 * this window the rotation is replayable, so the honest holder of a superseded
 * token gets back the token the lost response was carrying. The window is
 * therefore sized to cover a client's worst-case retry latency (slowest client
 * timeout + its backoff ladder ≈ 35 s, plus slack), and should not be widened
 * beyond that — every extra second is a second in which a superseded token is
 * both un-revoked AND redeemable.
 *
 * Two claims this comment used to make, corrected:
 *
 *  - It is NOT true that "clients no longer wipe their credentials on that
 *    rejection, so the honest holder keeps presenting its token and still trips
 *    the detector". That is web-only. iOS (APIClient.swift / Session.swift) and
 *    Android (ApiClient.kt) collapse every non-2xx refresh — 409 included — to
 *    a hard logout that wipes the token store, so on those platforms nothing is
 *    ever presented again and the detector is never reached. Native clients
 *    need their own tri-state refresh handling (transient / fatal / replay)
 *    before any of this reasoning applies to them; that work is planned
 *    separately and is NOT delivered by the server-side widening, which on its
 *    own buys iOS and Android nothing. (The replay RECOVERY does reach them,
 *    for free, because a recovered replay answers 200 with a token — which is
 *    a shape they already handle. What still logs them out is the residual
 *    409: a replay outside the window, from a different client, or when the
 *    recovery store is unavailable.)
 *
 *  - It is NOT true that a stolen-and-superseded token "still trips the
 *    detector" in general. Exactly ONE previous hash is stored, so an attacker
 *    who rotates twice (T→T_a→T_b) leaves the victim's T matching nothing at
 *    all: `detectRefreshTokenReuse` returns null, the victim gets a plain 401,
 *    and the session is never revoked. That hole pre-dates this window and is
 *    not closed by anything here — it is a known limitation of storing a single
 *    previous hash, and it means this control is best-effort against a passive
 *    or lazy attacker only. Closing it properly needs a per-session token
 *    family/chain, which is a schema change and is not in this pass.
 *
 * Still true: a replay can't push the window out — `lastUsedAt` only moves on a
 * SUCCESSFUL rotation, and neither a rejected replay nor a recovery touches it.
 */
const REFRESH_REUSE_GRACE_MS = 120_000;

/**
 * What a presented refresh token that didn't match any active session's CURRENT
 * hash turned out to be.
 *
 * - `concurrent` — it matches a session's PREVIOUS (rotated-away) hash and that
 *   rotation happened within REFRESH_REUSE_GRACE_MS. Benign: a second tab that
 *   lost the rotation race, or a retry of a refresh whose response was lost.
 *   Reject the call, but leave the session and its cookie alone.
 * - `theft` — same match, but outside the grace window. Treat the token as
 *   leaked and revoke the session family.
 */
export type RefreshReuseVerdict =
  | { kind: 'concurrent'; sessionId: bigint }
  | { kind: 'theft'; sessionId: bigint };

/**
 * Refresh-token reuse detection. Given a presented token that did NOT match any
 * active session's CURRENT hash, decide whether it matches a session's
 * PREVIOUS (rotated-away) hash — i.e. a superseded token is being replayed —
 * and if so, whether that replay is benign concurrency or a theft signal.
 *
 * `null` means the token is simply unknown: expired, revoked, or superseded
 * more than one rotation ago. Ordinary 401, nothing to revoke.
 */
export async function detectRefreshTokenReuse(
  token: string,
): Promise<RefreshReuseVerdict | null> {
  const hash = hashRefreshToken(token);
  const rows = await db
    .select({ id: schema.sessions.id, lastUsedAt: schema.sessions.lastUsedAt })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.previousRefreshTokenHash, hash),
        isNull(schema.sessions.revokedAt),
      ),
    )
    .limit(1);
  const s = rows[0];
  if (!s) return null;
  const supersededMsAgo = Date.now() - s.lastUsedAt.getTime();
  if (supersededMsAgo < REFRESH_REUSE_GRACE_MS) return { kind: 'concurrent', sessionId: s.id };
  return { kind: 'theft', sessionId: s.id };
}

export async function revokeSession(sessionId: bigint): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)));
  // Cut off the session's still-valid access tokens on REST immediately, not
  // just at gateway re-check / token expiry. Idempotent if already revoked.
  await blacklistSession(sessionId);
}

/**
 * Revoke every active session belonging to a user. If `exceptSessionId` is
 * given, that one is left intact — used for "log out other devices".
 */
export async function revokeAllUserSessions(
  userId: bigint,
  exceptSessionId?: bigint,
): Promise<void> {
  const conditions = [eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)];
  if (exceptSessionId !== undefined) {
    conditions.push(ne(schema.sessions.id, exceptSessionId));
  }
  const revoked = await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: schema.sessions.id });
  // Blacklist exactly the sessions we just revoked so their live access tokens
  // stop working on REST right away (mirrors revokeSession).
  await Promise.all(revoked.map((r) => blacklistSession(r.id)));
}

/** List the user's currently-active sessions, newest activity first. */
export async function listUserSessions(userId: bigint): Promise<Session[]> {
  return db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, userId),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(schema.sessions.lastUsedAt));
}

/** Find one session by id (used to validate "current" flag and ownership). */
export async function getSession(sessionId: bigint): Promise<Session | null> {
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/** Hard-delete sessions whose `expiresAt` is well in the past. Best run on a cron. */
export async function purgeExpiredSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await db
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, cutoff))
    .returning({ id: schema.sessions.id });
  return result.length;
}
