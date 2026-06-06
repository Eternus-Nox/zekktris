import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import {
  createSession,
  findActiveSessionByRefreshToken,
  rotateSession,
  revokeSession,
} from '../src/auth/sessions';
import { generateRefreshToken, hashRefreshToken } from '../src/auth/tokens';
import { nextSnowflake } from '../src/snowflake';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping sessions tests — no database reachable');
}

describe.runIf(dbReady)('sessions rotation/refresh (integration)', () => {
  let userId: bigint;

  beforeAll(async () => {
    userId = nextSnowflake();
    await db.insert(schema.users).values({
      id: userId,
      email: `sess-${userId}@test.local`,
      username: `sess_${userId}`,
      displayName: 'Session Test',
      passwordHash: 'scrypt-v1$00$00', // never verified here
    });
  });

  afterAll(async () => {
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await closeDb();
  });

  it('create → find returns the active session, storing only the token hash', async () => {
    const { session, refreshToken } = await createSession({
      userId,
      userAgent: 'vitest',
      ipAddress: '127.0.0.1',
    });
    const found = await findActiveSessionByRefreshToken(refreshToken);
    expect(found?.id).toBe(session.id);
    expect(session.refreshTokenHash).toBe(hashRefreshToken(refreshToken));
    expect(session.refreshTokenHash).not.toBe(refreshToken);
  });

  it('rotate issues a new token and invalidates the old one', async () => {
    const { session, refreshToken: t0 } = await createSession({
      userId,
      userAgent: null,
      ipAddress: null,
    });
    const rotated = await rotateSession(session.id, hashRefreshToken(t0));
    expect(rotated).not.toBeNull();
    const t1 = rotated!.refreshToken;
    expect(t1).not.toBe(t0);
    expect(await findActiveSessionByRefreshToken(t0)).toBeNull(); // old token dead
    expect((await findActiveSessionByRefreshToken(t1))?.id).toBe(session.id); // new token live
  });

  it('rotate with a stale current-hash returns null (reuse + concurrency guard)', async () => {
    const { session, refreshToken: t0 } = await createSession({
      userId,
      userAgent: null,
      ipAddress: null,
    });
    const first = await rotateSession(session.id, hashRefreshToken(t0));
    expect(first).not.toBeNull();
    // Replaying hash(t0) — or a concurrent /refresh racing on the same source
    // token — must match 0 rows now that the row holds hash(t1).
    const replay = await rotateSession(session.id, hashRefreshToken(t0));
    expect(replay).toBeNull();
    // The token issued by the first (winning) rotation is still valid.
    expect((await findActiveSessionByRefreshToken(first!.refreshToken))?.id).toBe(session.id);
  });

  it('revoke makes the session unfindable and unrotatable', async () => {
    const { session, refreshToken } = await createSession({
      userId,
      userAgent: null,
      ipAddress: null,
    });
    expect(await findActiveSessionByRefreshToken(refreshToken)).not.toBeNull();
    await revokeSession(session.id);
    expect(await findActiveSessionByRefreshToken(refreshToken)).toBeNull();
    expect(await rotateSession(session.id, hashRefreshToken(refreshToken))).toBeNull();
  });

  it('an expired session is not returned by find', async () => {
    const { token, hash } = generateRefreshToken();
    const id = nextSnowflake();
    await db.insert(schema.sessions).values({
      id,
      userId,
      refreshTokenHash: hash,
      userAgent: null,
      ipAddress: null,
      expiresAt: new Date(Date.now() - 1000), // already expired
    });
    expect(await findActiveSessionByRefreshToken(token)).toBeNull();
  });
});
