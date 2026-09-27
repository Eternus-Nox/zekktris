import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { adminRouter } from '../src/routes/admin';
import { messagesRouter } from '../src/routes/messages';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { getInstanceMute } from '../src/services/instanceMutes';
import { createUser, createDmChannel, addRelationship, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping admin account-info tests — no database reachable');
}

// Production prefixes: the moderator allowlist strips /api/v1/admin.
const app = new Hono();
app.onError(errorHandler);
app.route('/api/v1/admin', adminRouter);
app.route('/api/v1/channels', messagesRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

function req(method: string, path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const admin = (m: string, p: string, t: string, b?: unknown) => req(m, `/api/v1/admin${p}`, t, b);

async function setFlags(userId: bigint, flags: Partial<typeof schema.users.$inferInsert>) {
  await db.update(schema.users).set(flags).where(eq(schema.users.id, userId));
}
async function userRow(userId: bigint) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return u!;
}

describe.runIf(dbReady)('admin account info', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('account info + contacts are admin-only; moderators get 403', async () => {
    const adminId = await createUser();
    await setFlags(adminId, { isAdmin: true });
    const mod = await createUser();
    await setFlags(mod, { isModerator: true });
    const target = await createUser({ dateOfBirth: '1990-05-01' });

    const info = await admin('GET', `/users/${target}`, await tokenFor(adminId));
    expect(info.status).toBe(200);
    const { account } = (await info.json()) as { account: Record<string, unknown> };
    expect(account.email).toBe(`u-${target}@test.local`);
    expect(account.dateOfBirth).toBe('1990-05-01');
    expect(account.muted).toBe(false);

    const modToken = await tokenFor(mod);
    expect((await admin('GET', `/users/${target}`, modToken)).status).toBe(403);
    expect((await admin('GET', `/users/${target}/contacts`, modToken)).status).toBe(403);
    expect((await admin('PATCH', `/users/${target}/username`, modToken, { username: 'x_mod' })).status).toBe(403);
    expect((await admin('PATCH', `/users/${target}/email`, modToken, { email: 'm@x.test' })).status).toBe(403);
    expect((await admin('PATCH', `/users/${target}/date-of-birth`, modToken, { dateOfBirth: '1991-01-01' })).status).toBe(403);
    expect((await admin('POST', `/users/${target}/password-reset`, modToken)).status).toBe(403);
  });

  it('moderators see no email or DOB in the user list, and cannot search by email', async () => {
    const mod = await createUser();
    await setFlags(mod, { isModerator: true });
    const target = await createUser({ dateOfBirth: '1990-05-01' });
    const modToken = await tokenFor(mod);

    const byName = await admin('GET', `/users?q=u_${target}`, modToken);
    const { users } = (await byName.json()) as { users: Array<Record<string, unknown>> };
    const row = users.find((u) => u.id === target.toString())!;
    expect(row).toBeDefined();
    expect(row.email).toBeNull();
    expect(row.dateOfBirth).toBeNull();

    const byEmail = await admin('GET', `/users?q=u-${target}@test.local`, modToken);
    const found = ((await byEmail.json()) as { users: Array<{ id: string }> }).users;
    expect(found.some((u) => u.id === target.toString())).toBe(false);
  });

  it('a muted account cannot send; unmute restores it; moderators can mute non-staff only', async () => {
    const mod = await createUser();
    await setFlags(mod, { isModerator: true });
    const alice = await createUser();
    const bob = await createUser();
    await addRelationship(alice, bob, 'friend');
    await addRelationship(bob, alice, 'friend');
    const dm = await createDmChannel([alice, bob]);
    const modToken = await tokenFor(mod);
    const aliceToken = await tokenFor(alice);

    const muted = await admin('POST', `/users/${alice}/mute`, modToken, { duration: '1d' });
    expect(muted.status).toBe(200);
    expect(await getInstanceMute(alice)).not.toBeNull();

    const blocked = await req('POST', `/api/v1/channels/${dm}/messages`, aliceToken, { content: 'hi' });
    expect(blocked.status).toBe(403);
    const err = (await blocked.json()) as { error: { code: string } };
    expect(err.error.code).toBe('INSTANCE_MUTED');

    expect((await admin('POST', `/users/${alice}/unmute`, modToken)).status).toBe(200);
    const sent = await req('POST', `/api/v1/channels/${dm}/messages`, aliceToken, { content: 'hi again' });
    expect(sent.status).toBeLessThan(300);

    // Moderators may not mute staff (same guard as ban).
    const otherMod = await createUser();
    await setFlags(otherMod, { isModerator: true });
    expect((await admin('POST', `/users/${otherMod}/mute`, modToken, { duration: '1h' })).status).toBe(403);
  });

  it('an expired timed mute is not a mute', async () => {
    const u = await createUser();
    await setFlags(u, { mutedAt: new Date(Date.now() - 2 * 3600_000), mutedUntil: new Date(Date.now() - 3600_000) });
    expect(await getInstanceMute(u)).toBeNull();
    await setFlags(u, { mutedAt: new Date(), mutedUntil: null });
    expect(await getInstanceMute(u)).toEqual({ until: null }); // permanent
  });

  it('notes: moderators add and list, delete only their own; admins delete any', async () => {
    const adminId = await createUser();
    await setFlags(adminId, { isAdmin: true });
    const modA = await createUser();
    const modB = await createUser();
    await setFlags(modA, { isModerator: true });
    await setFlags(modB, { isModerator: true });
    const target = await createUser();
    const tA = await tokenFor(modA);
    const tB = await tokenFor(modB);

    const created = await admin('POST', `/users/${target}/notes`, tA, { body: 'Warned about spam' });
    expect(created.status).toBe(200);
    const { note } = (await created.json()) as { note: { id: string } };

    const list = await admin('GET', `/users/${target}/notes`, tB);
    const { notes } = (await list.json()) as {
      notes: Array<{ id: string; body: string; author: { id: string } | null }>;
    };
    expect(notes[0]!.body).toBe('Warned about spam');
    expect(notes[0]!.author!.id).toBe(modA.toString());

    expect((await admin('DELETE', `/users/${target}/notes/${note.id}`, tB)).status).toBe(403);
    expect((await admin('DELETE', `/users/${target}/notes/${note.id}`, await tokenFor(adminId))).status).toBe(200);
    expect((await admin('POST', `/users/${target}/notes`, tA, { body: '   ' })).status).toBe(400);
  });

  it('contacts lists friends, requests, blocks and DM partners', async () => {
    const adminId = await createUser();
    await setFlags(adminId, { isAdmin: true });
    const target = await createUser();
    const friend = await createUser();
    const blocked = await createUser();
    const requester = await createUser();
    const dmPeer = await createUser();
    await addRelationship(target, friend, 'friend');
    await addRelationship(target, blocked, 'blocked');
    await addRelationship(target, requester, 'incoming_request');
    await createDmChannel([target, dmPeer]);

    const res = await admin('GET', `/users/${target}/contacts`, await tokenFor(adminId));
    expect(res.status).toBe(200);
    const c = (await res.json()) as Record<string, Array<{ id: string }>>;
    expect(c.friends!.map((p) => p.id)).toEqual([friend.toString()]);
    expect(c.blocked!.map((p) => p.id)).toEqual([blocked.toString()]);
    expect(c.incomingRequests!.map((p) => p.id)).toEqual([requester.toString()]);
    expect(c.outgoingRequests).toEqual([]);
    expect(c.dmPartners!.map((p) => p.id)).toEqual([dmPeer.toString()]);
  });

  it('admin edits: username (taken → 400), email (verified), DOB (13+ only, re-locks)', async () => {
    const adminId = await createUser();
    await setFlags(adminId, { isAdmin: true });
    const t = await tokenFor(adminId);
    const target = await createUser();
    const other = await createUser();

    const renamed = `renamed_${target}`.slice(0, 32);
    expect((await admin('PATCH', `/users/${target}/username`, t, { username: renamed })).status).toBe(200);
    const after = await userRow(target);
    expect(after.username).toBe(renamed);
    expect(after.usernameChangedAt).toBeNull(); // staff fix doesn't use the owner's allowance
    expect((await admin('PATCH', `/users/${target}/username`, t, { username: `u_${other}` })).status).toBe(400);

    await setFlags(target, { emailVerified: false });
    expect((await admin('PATCH', `/users/${target}/email`, t, { email: `new-${target}@test.local` })).status).toBe(200);
    const mailed = await userRow(target);
    expect(mailed.email).toBe(`new-${target}@test.local`);
    expect(mailed.emailVerified).toBe(true);

    const tooYoung = new Date();
    tooYoung.setUTCFullYear(tooYoung.getUTCFullYear() - 10);
    const young = tooYoung.toISOString().slice(0, 10);
    expect((await admin('PATCH', `/users/${target}/date-of-birth`, t, { dateOfBirth: young })).status).toBe(400);
    await setFlags(target, { dobLocked: false });
    expect((await admin('PATCH', `/users/${target}/date-of-birth`, t, { dateOfBirth: '1985-02-03' })).status).toBe(200);
    const dob = await userRow(target);
    expect(dob.dateOfBirth).toBe('1985-02-03');
    expect(dob.dobLocked).toBe(true);
  });

  it('audit rows for email and DOB changes never contain the values', async () => {
    const adminId = await createUser();
    await setFlags(adminId, { isAdmin: true });
    const t = await tokenFor(adminId);
    const target = await createUser();
    await admin('PATCH', `/users/${target}/email`, t, { email: `secret-${target}@test.local` });
    await admin('PATCH', `/users/${target}/date-of-birth`, t, { dateOfBirth: '1977-07-07' });
    const events = await db
      .select({ kind: schema.securityEvents.kind, detail: schema.securityEvents.detail })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.userId, target));
    const text = JSON.stringify(events);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['staff_email_change', 'staff_dob_set']));
    expect(text).not.toContain('secret-');
    expect(text).not.toContain('1977');
  });
});
