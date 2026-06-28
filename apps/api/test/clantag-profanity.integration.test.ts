import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { usersRouter } from '../src/routes/users';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping clan-tag profanity tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/users', usersRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
function patchMe(token: string, body: unknown) {
  return app.request('/users/@me', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The name tag renders right next to the username everywhere, so it must clear
// the same profanity bar as messages. PATCH /users/@me rejects a tag that
// matches the shared banned-words preset.
describe.runIf(dbReady)('PATCH /users/@me — clan tag profanity', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('rejects a vulgar tag with 400 and does not persist it', async () => {
    const uid = await createUser();
    const res = await patchMe(await tokenFor(uid), { tagLabel: 'fuck' });
    expect(res.status).toBe(400);
    const [row] = await db
      .select({ tagLabel: schema.users.tagLabel })
      .from(schema.users)
      .where(eq(schema.users.id, uid));
    expect(row?.tagLabel ?? null).toBeNull();
  });

  it('rejects regardless of case', async () => {
    const uid = await createUser();
    const res = await patchMe(await tokenFor(uid), { tagLabel: 'ShiT' });
    expect(res.status).toBe(400);
  });

  it('accepts a clean tag and stores it', async () => {
    const uid = await createUser();
    const res = await patchMe(await tokenFor(uid), { tagLabel: 'GG' });
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ tagLabel: schema.users.tagLabel })
      .from(schema.users)
      .where(eq(schema.users.id, uid));
    expect(row?.tagLabel).toBe('GG');
  });
});
