import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { adminRouter } from '../src/routes/admin';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, createGuild, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping admin moderator tests — no database reachable');
}

// Mount at the PRODUCTION prefix — the moderator allowlist middleware
// normalizes c.req.path by stripping /api/v1/admin, so the test must
// present the same paths the real server does.
const app = new Hono();
app.onError(errorHandler);
app.route('/api/v1/admin', adminRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

function req(method: string, path: string, token: string, body?: unknown) {
  return app.request(`/api/v1/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function makeAdmin(userId: bigint) {
  await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId));
}
async function makeModerator(userId: bigint) {
  await db.update(schema.users).set({ isModerator: true }).where(eq(schema.users.id, userId));
}

describe.runIf(dbReady)('admin router: moderator authz + staff audit log', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  // The first test in this file pays the one-time dynamic-import transform cost
  // for the admin route graph — slow on the SMB-mounted repo.
  it('non-staff is rejected everywhere; moderator passes the allowlist', async () => {
    const nobody = await createUser();
    const mod = await createUser();
    await makeModerator(mod);

    const denied = await req('GET', '/users', await tokenFor(nobody));
    expect(denied.status).toBe(403);

    const ok = await req('GET', '/users', await tokenFor(mod));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { users: Array<Record<string, unknown>> };
    // New fields the panel needs are present on every row.
    expect(body.users[0]).toHaveProperty('isModerator');
    expect(body.users[0]).toHaveProperty('dateOfBirth');
  });

  it('moderator is blocked from admin-only endpoints (fail-safe allowlist)', async () => {
    const mod = await createUser();
    await makeModerator(mod);
    const target = await createUser();
    const guild = await createGuild(await createUser());
    const token = await tokenFor(mod);

    const blocked: Array<[string, string, unknown?]> = [
      ['GET', '/stats'],
      ['DELETE', `/users/${target}`],
      ['POST', `/users/${target}/role`, { role: 'moderator' }],
      ['DELETE', `/users/${target}/subscription`],
      ['DELETE', `/guilds/${guild}`],
      ['GET', '/security/words'],
      ['GET', '/security/config'],
    ];
    for (const [method, path, body] of blocked) {
      const res = await req(method, path, token, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('moderator can ban a regular user; the action lands in the staff log with the actor', async () => {
    const mod = await createUser();
    await makeModerator(mod);
    const target = await createUser();
    const token = await tokenFor(mod);

    const res = await req('POST', `/users/${target}/ban`, token);
    expect(res.status).toBe(200);

    const events = await req('GET', '/security/events?kind=staff', token);
    expect(events.status).toBe(200);
    const body = (await events.json()) as {
      events: Array<{ kind: string; userId: string | null; actorId: string | null }>;
    };
    const banEvent = body.events.find(
      (ev) => ev.kind === 'staff_ban' && ev.userId === target.toString(),
    );
    expect(banEvent).toBeDefined();
    expect(banEvent!.actorId).toBe(mod.toString());
  });

  it('moderator cannot ban/unban/sign-out staff accounts', async () => {
    const mod = await createUser();
    await makeModerator(mod);
    const admin = await createUser();
    await makeAdmin(admin);
    const otherMod = await createUser();
    await makeModerator(otherMod);
    const token = await tokenFor(mod);

    expect((await req('POST', `/users/${admin}/ban`, token)).status).toBe(403);
    expect((await req('POST', `/users/${otherMod}/ban`, token)).status).toBe(403);
    expect((await req('POST', `/users/${admin}/unban`, token)).status).toBe(403);
    expect((await req('POST', `/users/${admin}/logout`, token)).status).toBe(403);
    // DOB-lock reset and membership gifts are staff-guarded too.
    expect((await req('POST', `/users/${admin}/reset-dob-lock`, token)).status).toBe(403);
    expect(
      (await req('POST', `/users/${admin}/subscription`, token, { tier: 'scout', duration: '1m' })).status,
    ).toBe(403);
  });

  it('moderator cannot gift a membership to themselves (no self-grant of paid cosmetics)', async () => {
    const mod = await createUser();
    await makeModerator(mod);
    const token = await tokenFor(mod);
    // Self is a staff account → assertModCanTouch blocks it before the gift.
    expect(
      (await req('POST', `/users/${mod}/subscription`, token, { tier: 'legend', duration: '3m' })).status,
    ).toBe(403);
    expect(
      (await req('POST', `/users/${mod}/reset-dob-lock`, token)).status,
    ).toBe(403);
  });

  // Gifting is monetization, so it's admin-only: the route is absent from
  // MODERATOR_ALLOWED, which makes the router guard reject a moderator before
  // the handler runs — at EVERY duration, not just long ones. (An earlier spec
  // let moderators gift up to 3 months; that cap no longer exists because the
  // capability itself was withdrawn.)
  it('membership gifting is admin-only — a moderator is refused at every duration', async () => {
    const mod = await createUser();
    await makeModerator(mod);
    const admin = await createUser();
    await makeAdmin(admin);
    const target = await createUser();
    const modToken = await tokenFor(mod);

    for (const duration of ['1m', '3m', '6m', 'forever'] as const) {
      expect(
        (await req('POST', `/users/${target}/subscription`, modToken, { tier: 'scout', duration }))
          .status,
      ).toBe(403);
    }
    // ...and the gift really didn't land.
    const [none] = await db
      .select({ tier: schema.subscriptions.tier })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, target));
    expect(none).toBeUndefined();

    // An admin is unrestricted.
    expect(
      (
        await req('POST', `/users/${target}/subscription`, await tokenFor(admin), {
          tier: 'legend',
          duration: 'forever',
        })
      ).status,
    ).toBe(200);
  });

  it('role endpoint: flags are mutually exclusive; self-demote is blocked', async () => {
    const admin = await createUser();
    await makeAdmin(admin);
    const target = await createUser();
    const token = await tokenFor(admin);

    expect((await req('POST', `/users/${target}/role`, token, { role: 'administrator' })).status).toBe(200);
    let [row] = await db
      .select({ isAdmin: schema.users.isAdmin, isModerator: schema.users.isModerator })
      .from(schema.users)
      .where(eq(schema.users.id, target));
    expect(row).toEqual({ isAdmin: true, isModerator: false });

    expect((await req('POST', `/users/${target}/role`, token, { role: 'moderator' })).status).toBe(200);
    [row] = await db
      .select({ isAdmin: schema.users.isAdmin, isModerator: schema.users.isModerator })
      .from(schema.users)
      .where(eq(schema.users.id, target));
    expect(row).toEqual({ isAdmin: false, isModerator: true });

    expect((await req('POST', `/users/${target}/role`, token, { role: 'none' })).status).toBe(200);
    [row] = await db
      .select({ isAdmin: schema.users.isAdmin, isModerator: schema.users.isModerator })
      .from(schema.users)
      .where(eq(schema.users.id, target));
    expect(row).toEqual({ isAdmin: false, isModerator: false });

    // Self-demote guard: keeps the instance from locking itself out.
    expect((await req('POST', `/users/${admin}/role`, token, { role: 'none' })).status).toBe(400);
  });

  it('moderator DOB reset works and is audited', async () => {
    const mod = await createUser();
    await makeModerator(mod);
    const target = await createUser();
    const token = await tokenFor(mod);

    expect((await req('POST', `/users/${target}/reset-dob-lock`, token)).status).toBe(200);
    const [row] = await db
      .select({ dobLocked: schema.users.dobLocked })
      .from(schema.users)
      .where(eq(schema.users.id, target));
    expect(row!.dobLocked).toBe(false);

    const events = await req('GET', '/security/events?kind=staff', token);
    const body = (await events.json()) as {
      events: Array<{ kind: string; userId: string | null; actorId: string | null; actorUsername: string | null }>;
    };
    const ev = body.events.find(
      (e) => e.kind === 'staff_dob_reset' && e.userId === target.toString(),
    );
    expect(ev).toBeDefined();
    expect(ev!.actorId).toBe(mod.toString());
    expect(ev!.actorUsername).toBe(`u_${mod}`);
  });
});
