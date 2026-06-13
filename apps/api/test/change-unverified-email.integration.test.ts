import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { errorHandler } from '../src/middleware';
import { authRouter } from '../src/routes/auth';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping change-unverified-email tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/auth', authRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: null, ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

function changeEmail(token: string, email: string) {
  return app.request('/auth/change-unverified-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ email }),
  });
}

describe.runIf(dbReady)('POST /auth/change-unverified-email', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('lets an UNVERIFIED account correct its email', async () => {
    const uid = await createUser(); // emailVerified defaults to false
    const token = await tokenFor(uid);
    const res = await changeEmail(token, `fixed-${uid}@test.local`);
    expect(res.status).toBe(200);
    expect((await res.json()).email).toBe(`fixed-${uid}@test.local`);

    const [row] = await db
      .select({ email: schema.users.email, verified: schema.users.emailVerified })
      .from(schema.users)
      .where(eq(schema.users.id, uid));
    expect(row?.email).toBe(`fixed-${uid}@test.local`);
    // Correcting the address must NOT verify it — it stays unverified until
    // the new address is confirmed.
    expect(row?.verified).toBe(false);
  });

  it('refuses to change a VERIFIED account (must use the password-gated flow)', async () => {
    const uid = await createUser();
    await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, uid));
    const token = await tokenFor(uid);
    const res = await changeEmail(token, `nope-${uid}@test.local`);
    expect(res.status).toBe(400);

    // Email is unchanged.
    const [row] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, uid));
    expect(row?.email).not.toBe(`nope-${uid}@test.local`);
  });

  it('409s when the target email already belongs to another account (no takeover)', async () => {
    const victim = await createUser();
    const [v] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, victim));
    const attacker = await createUser();
    const token = await tokenFor(attacker);
    const res = await changeEmail(token, v!.email);
    expect(res.status).toBe(409);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.request('/auth/change-unverified-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@test.local' }),
    });
    expect(res.status).toBe(401);
  });
});
