import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { requireAuth, requireUserId } from '../src/auth/middleware';
import { errorHandler } from '../src/middleware';
import { authRouter } from '../src/routes/auth';
import { isSessionBlacklisted, __resetBlacklistStoreToMemory } from '../src/auth/session-blacklist';
import { nextSnowflake } from '../src/snowflake';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping password-reset revocation tests — no database reachable');
}

// A guarded REST endpoint behind requireAuth (no DB on the human JWT path),
// to prove a token authenticates before reset and is rejected after.
const meApp = new Hono();
meApp.onError(errorHandler);
meApp.use('*', requireAuth);
meApp.get('/me', (c) => c.json({ userId: requireUserId(c).toString() }));

// The real auth router (mounted) so we exercise POST /auth/reset-password end to end.
const authApp = new Hono();
authApp.onError(errorHandler);
authApp.route('/auth', authRouter);

function authed(token: string) {
  return meApp.request('/me', { headers: { authorization: `Bearer ${token}` } });
}

async function seedResetToken(userId: bigint): Promise<string> {
  const plain = `reset-${userId}-${nextSnowflake()}`;
  await db.insert(schema.passwordResets).values({
    id: nextSnowflake(),
    userId,
    tokenHash: createHash('sha256').update(plain).digest('hex'),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return plain;
}

describe.runIf(dbReady)('password reset revokes sessions immediately (REST blacklist)', () => {
  beforeAll(() => __resetBlacklistStoreToMemory());
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('a valid access token is rejected on REST right after a password reset', async () => {
    const uid = await createUser();
    const { session } = await createSession({ userId: uid, userAgent: null, ipAddress: null });
    const token = await signAccessToken({ userId: uid, sessionId: session.id });

    // Works before the reset.
    expect((await authed(token)).status).toBe(200);

    // Perform the reset via the real route.
    const resetToken = await seedResetToken(uid);
    const res = await authApp.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: 'NewSup3rSecret!42' }),
    });
    expect(res.status).toBe(200);

    // The session is blacklisted and the still-unexpired access token is now 401.
    expect(await isSessionBlacklisted(session.id)).toBe(true);
    const after = await authed(token);
    expect(after.status).toBe(401);
    expect((await after.json()).error.code).toBe('TOKEN_INVALID');

    // The DB session row is revoked too.
    const [row] = await db
      .select({ revokedAt: schema.sessions.revokedAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, session.id));
    expect(row?.revokedAt).not.toBeNull();
  });

  it('only the reset user is affected — another user keeps working', async () => {
    const a = await createUser();
    const b = await createUser();
    const { session: sa } = await createSession({ userId: a, userAgent: null, ipAddress: null });
    const { session: sb } = await createSession({ userId: b, userAgent: null, ipAddress: null });
    const tokenA = await signAccessToken({ userId: a, sessionId: sa.id });
    const tokenB = await signAccessToken({ userId: b, sessionId: sb.id });

    const resetToken = await seedResetToken(a);
    const res = await authApp.request('/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: resetToken, newPassword: 'AnotherSecret!99' }),
    });
    expect(res.status).toBe(200);

    expect((await authed(tokenA)).status).toBe(401); // reset user cut off
    expect((await authed(tokenB)).status).toBe(200); // unrelated user unaffected
  });
});
