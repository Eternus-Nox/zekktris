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
  return { refreshToken: token };
}

export async function revokeSession(sessionId: bigint): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)));
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
  await db.update(schema.sessions).set({ revokedAt: new Date() }).where(and(...conditions));
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
