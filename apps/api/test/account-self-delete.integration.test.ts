/**
 * DELETE /users/@me — self-serve account deletion.
 *
 * The published Terms and Privacy Policy state that a user can delete their
 * account from Settings. Before this route existed the only deletion path was
 * the admin one, which explicitly refuses to act on the caller's own account —
 * so the promise was unimplementable. These tests pin the behaviour that makes
 * it true, and the step-up gate that keeps a stolen access token from using it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { usersRouter } from '../src/routes/users';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { hashPassword } from '../src/auth/passwords';
import { nextSnowflake } from '../src/snowflake';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping self-delete tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/users', usersRouter);

const PASSWORD = 'correct-horse-battery-staple';

/** A user with a real (verifiable) password hash — seed.createUser writes a
 *  dummy hash that verifyPassword can never match. */
async function userWithPassword(): Promise<bigint> {
  const id = await createUser();
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(PASSWORD) })
    .where(eq(schema.users.id, id));
  return id;
}

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

function del(token: string, body: unknown) {
  return app.request('/users/@me', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function exists(userId: bigint): Promise<boolean> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return rows.length > 0;
}

describe.runIf(dbReady)('DELETE /users/@me', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('deletes the account when the password is correct', async () => {
    const uid = await userWithPassword();
    const res = await del(await tokenFor(uid), { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await exists(uid)).toBe(false);
  });

  it('revokes every session, so a stolen access token dies with the account', async () => {
    const uid = await userWithPassword();
    const victimToken = await tokenFor(uid);
    const attackerToken = await tokenFor(uid); // a second live session
    expect((await del(victimToken, { password: PASSWORD })).status).toBe(200);
    const live = await db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, uid), isNull(schema.sessions.revokedAt)));
    expect(live).toHaveLength(0);
    expect(attackerToken).toBeTruthy();
  });

  it('refuses a wrong password and leaves the account intact', async () => {
    const uid = await userWithPassword();
    const res = await del(await tokenFor(uid), { password: 'not-the-password' });
    expect(res.status).toBe(401);
    expect(await exists(uid)).toBe(true);
  });

  it('requires a password at all (an access token alone is not enough)', async () => {
    const uid = await userWithPassword();
    const res = await app.request('/users/@me', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await tokenFor(uid)}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await exists(uid)).toBe(true);
  });

  it('refuses while the user still owns an active server, and says why', async () => {
    const uid = await userWithPassword();
    const guildId = nextSnowflake();
    await db.insert(schema.guilds).values({ id: guildId, name: 'Owned', ownerId: uid });
    await db.insert(schema.roles).values({
      id: guildId,
      guildId,
      name: '@everyone',
      permissions: 0n,
      position: 0,
    });

    const res = await del(await tokenFor(uid), { password: PASSWORD });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/own one or more servers/i);
    expect(await exists(uid)).toBe(true);

    // Once the server is gone the account can be closed.
    await db.delete(schema.guilds).where(eq(schema.guilds.id, guildId));
    expect((await del(await tokenFor(uid), { password: PASSWORD })).status).toBe(200);
    expect(await exists(uid)).toBe(false);
  });

  it('a soft-deleted owned server does not trap the account', async () => {
    const uid = await userWithPassword();
    const guildId = nextSnowflake();
    await db
      .insert(schema.guilds)
      .values({ id: guildId, name: 'Gone', ownerId: uid, deletedAt: new Date() });
    await db.insert(schema.roles).values({
      id: guildId,
      guildId,
      name: '@everyone',
      permissions: 0n,
      position: 0,
    });

    expect((await del(await tokenFor(uid), { password: PASSWORD })).status).toBe(200);
    expect(await exists(uid)).toBe(false);
    // The orphaned guild row was purged too (owner_id is ON DELETE RESTRICT).
    const left = await db
      .select({ id: schema.guilds.id })
      .from(schema.guilds)
      .where(eq(schema.guilds.id, guildId));
    expect(left).toHaveLength(0);
  });

  it('demands a second factor when 2FA is armed', async () => {
    const uid = await userWithPassword();
    const { generateSecret } = await import('../src/services/twoFactor');
    const { encryptField } = await import('../src/lib/fieldCrypto');
    await db
      .update(schema.users)
      .set({ totpEnabled: true, totpSecret: encryptField(generateSecret()) })
      .where(eq(schema.users.id, uid));

    // Right password, no code → refused.
    const noCode = await del(await tokenFor(uid), { password: PASSWORD });
    expect(noCode.status).toBe(400);
    expect(await exists(uid)).toBe(true);

    // Right password, wrong code → refused.
    const badCode = await del(await tokenFor(uid), { password: PASSWORD, totpCode: '000000' });
    expect(badCode.status).toBe(401);
    expect(await exists(uid)).toBe(true);
  });
});
