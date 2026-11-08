import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { WebSocket } from 'ws';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { dmsRouter } from '../src/routes/dms';
import { messagesRouter } from '../src/routes/messages';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { achievementsForUser } from '../src/services/achievements';
import { formatDisappearingDuration } from '../src/lib/disappearing';
import { createUser, createDmChannel, addRelationship, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping disappearing-settings tests — no database reachable');
}

// PATCH /users/@me/channels/:id/settings is the disappearing-messages timer.
// Installed apps keep the key `ttlSecondsAfterRead` and re-PATCH on every tap,
// so an unchanged value must do nothing; a change posts ONE
// 'system_disappearing' notice and faces the send route's gates.

const app = new Hono();
app.onError(errorHandler);
app.route('/users/@me/channels', dmsRouter);
app.route('/channels', messagesRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
async function call(method: string, path: string, userId: bigint, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${await tokenFor(userId)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}
const patchTimer = (userId: bigint, dm: bigint, ttl: unknown) =>
  call('PATCH', `/users/@me/channels/${dm}/settings`, userId, { ttlSecondsAfterRead: ttl });

type Frame = { t?: string; d?: Record<string, unknown> };
const liveConns: Connection[] = [];
function connect(userId: bigint, dmIds: bigint[]): Frame[] {
  const sent: Frame[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    close: () => undefined,
  } as unknown as WebSocket;
  const conn = new Connection(ws);
  conn.markAuthenticated(userId, [], dmIds, []);
  registry.add(conn);
  registry.index(conn);
  liveConns.push(conn);
  return sent;
}
const framesOf = (sent: Frame[], t: string) => sent.filter((f) => f.t === t).map((f) => f.d!);

async function notices(dm: bigint) {
  return db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, dm), eq(schema.messages.type, 'system_disappearing')))
    .orderBy(schema.messages.id);
}
async function storedTtl(dm: bigint): Promise<number | null | undefined> {
  const [row] = await db
    .select({ ttl: schema.dmSettings.ttlSecondsAfterRead })
    .from(schema.dmSettings)
    .where(eq(schema.dmSettings.channelId, dm));
  return row ? row.ttl : undefined;
}
async function setName(userId: bigint, displayName: string) {
  await db.update(schema.users).set({ displayName }).where(eq(schema.users.id, userId));
}

describe.runIf(dbReady)('disappearing-messages settings (integration)', () => {
  beforeAll(() => {
    registry.init();
  });
  afterEach(() => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
  });
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('formats durations the way every client does', () => {
    expect(formatDisappearingDuration(2419200)).toBe('4 weeks');
    expect(formatDisappearingDuration(604800)).toBe('1 week');
    expect(formatDisappearingDuration(259200)).toBe('3 days');
    expect(formatDisappearingDuration(86400)).toBe('1 day');
    expect(formatDisappearingDuration(28800)).toBe('8 hours');
    expect(formatDisappearingDuration(300)).toBe('5 minutes');
    expect(formatDisappearingDuration(60)).toBe('1 minute');
    expect(formatDisappearingDuration(120)).toBe('2 minutes');
    expect(formatDisappearingDuration(90)).toBe('1 minute 30 seconds');
    expect(formatDisappearingDuration(30)).toBe('30 seconds');
    expect(formatDisappearingDuration(1)).toBe('1 second');
    expect(formatDisappearingDuration(694861)).toBe('1 week 1 day 1 hour 1 minute 1 second');
  });

  it('GET keeps its keys and advertises maxTtlSeconds', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const res = await call('GET', `/users/@me/channels/${dm}/settings`, a);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ttlSecondsAfterRead: null, notificationShowContent: null, maxTtlSeconds: 2419200 });
  });

  it('accepts 1 s .. 4 weeks, legacy values and null; rejects 0, 2419201 and fractions', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    for (const bad of [0, -5, 2419201, 1.5, '60']) {
      const r = await patchTimer(a, dm, bad);
      expect(r.status, String(bad)).toBe(400);
    }
    expect(await storedTtl(dm)).toBeUndefined();
    for (const ok of [1, 2419200, 30, null]) {
      const r = await patchTimer(a, dm, ok);
      expect(r.status, String(ok)).toBe(200);
      expect(r.json).toEqual({ ttlSecondsAfterRead: ok });
      expect(await storedTtl(dm)).toBe(ok);
    }
    const got = await call('GET', `/users/@me/channels/${dm}/settings`, b);
    expect(got.json?.ttlSecondsAfterRead).toBeNull();
    // A non-recipient can neither read nor change it.
    const stranger = await createUser();
    expect((await call('GET', `/users/@me/channels/${dm}/settings`, stranger)).status).toBe(404);
    expect((await patchTimer(stranger, dm, 60)).status).toBe(404);
  });

  it('a change posts exactly one notice and fans out; repeating the value does nothing', async () => {
    const a = await createUser();
    const b = await createUser();
    await setName(a, 'Alex');
    const dm = await createDmChannel([a, b]);
    const aSent = connect(a, [dm]);
    const bSent = connect(b, [dm]);

    const r = await patchTimer(a, dm, 86400);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ttlSecondsAfterRead: 86400 });

    const [notice, ...rest] = await notices(dm);
    expect(rest).toEqual([]);
    expect(notice!.authorId).toBe(a);
    expect(notice!.content).toBe('Alex set disappearing messages to 1 day.');
    expect(notice!.metadata).toEqual({ kind: 'disappearing_timer', timerSeconds: 86400, initiatorId: a.toString() });
    // The notice itself never disappears.
    expect(notice!.expireAfterSeconds).toBeNull();
    // Newest message of the DM, and already read for the changer.
    const [ch] = await db.select().from(schema.channels).where(eq(schema.channels.id, dm));
    expect(ch!.lastMessageId).toBe(notice!.id);
    const [rs] = await db
      .select()
      .from(schema.readStates)
      .where(and(eq(schema.readStates.userId, a), eq(schema.readStates.channelId, dm)));
    expect(rs!.lastMessageId).toBe(notice!.id);

    for (const sent of [aSent, bSent]) {
      const created = framesOf(sent, 'MESSAGE_CREATE');
      expect(created.map((d) => [d.id, d.type])).toEqual([[notice!.id.toString(), 'system_disappearing']]);
      expect(created[0]!.expireAfterSeconds).toBeNull();
      expect(created[0]!).not.toHaveProperty('expiresAt');
      expect(framesOf(sent, 'DM_SETTINGS_UPDATE')).toEqual([
        { channelId: dm.toString(), ttlSecondsAfterRead: 86400 },
      ]);
    }

    // Every installed client re-PATCHes the current value on tap.
    const again = await patchTimer(b, dm, 86400);
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ ttlSecondsAfterRead: 86400 });
    expect((await notices(dm)).length).toBe(1);
    expect(framesOf(aSent, 'MESSAGE_CREATE').length).toBe(1);
    expect(framesOf(bSent, 'DM_SETTINGS_UPDATE').length).toBe(1);

    // Off: "turned off", timerSeconds 0; a blank display name falls back to
    // the username.
    await setName(b, '');
    const off = await patchTimer(b, dm, null);
    expect(off.status).toBe(200);
    const all = await notices(dm);
    expect(all.length).toBe(2);
    const [bUser] = await db.select().from(schema.users).where(eq(schema.users.id, b));
    expect(all[1]!.content).toBe(`${bUser!.username} turned off disappearing messages.`);
    expect(all[1]!.metadata).toEqual({ kind: 'disappearing_timer', timerSeconds: 0, initiatorId: b.toString() });
    expect(framesOf(aSent, 'DM_SETTINGS_UPDATE').at(-1)).toEqual({
      channelId: dm.toString(),
      ttlSecondsAfterRead: null,
    });
    // Off again: nothing.
    expect((await patchTimer(a, dm, null)).status).toBe(200);
    expect((await notices(dm)).length).toBe(2);
  });

  it('turning off a DM that never had a timer writes nothing and posts nothing', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const aSent = connect(a, [dm]);
    expect((await patchTimer(a, dm, null)).status).toBe(200);
    expect(await storedTtl(dm)).toBeUndefined();
    expect((await notices(dm)).length).toBe(0);
    expect(aSent).toEqual([]);
  });

  it('two identical concurrent changes post one notice', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const [r1, r2] = await Promise.all([patchTimer(a, dm, 3600), patchTimer(b, dm, 3600)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect((await notices(dm)).length).toBe(1);
  });

  it('refuses a change between blocked users, either direction, and posts nothing', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await addRelationship(a, b, 'blocked');
    expect((await patchTimer(a, dm, 60)).status).toBe(404);
    expect((await patchTimer(b, dm, 60)).status).toBe(404);
    expect(await storedTtl(dm)).toBeUndefined();
    expect((await notices(dm)).length).toBe(0);
  });

  it('refuses a change from an instance-muted user, but an unchanged value still answers', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    expect((await patchTimer(b, dm, 300)).status).toBe(200);
    await db.update(schema.users).set({ mutedAt: new Date(), mutedUntil: null }).where(eq(schema.users.id, a));
    const r = await patchTimer(a, dm, 60);
    expect(r.status).toBe(403);
    expect((r.json?.error as { code?: string } | undefined)?.code).toBe('INSTANCE_MUTED');
    expect(await storedTtl(dm)).toBe(300);
    expect((await patchTimer(a, dm, 300)).status).toBe(200);
    expect((await notices(dm)).length).toBe(1);
  });

  it('rate-limits changes per user (10 a minute); repeats are not counted', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    for (let i = 0; i < 10; i++) {
      expect((await patchTimer(a, dm, 100 + i)).status).toBe(200);
      expect((await patchTimer(a, dm, 100 + i)).status).toBe(200); // unchanged, free
    }
    expect((await patchTimer(a, dm, 999)).status).toBe(429);
    expect(await storedTtl(dm)).toBe(109);
    expect((await notices(dm)).length).toBe(10);
    // The other recipient has their own budget.
    expect((await patchTimer(b, dm, 999)).status).toBe(200);
  });

  it('works in a group DM (no block gate) and every member gets the notice', async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    const gdm = await createDmChannel([a, b, c], 'group_dm');
    const cSent = connect(c, [gdm]);
    expect((await patchTimer(b, gdm, 604800)).status).toBe(200);
    const [notice] = await notices(gdm);
    expect(notice!.content).toBe('Seed User set disappearing messages to 1 week.');
    expect(framesOf(cSent, 'MESSAGE_CREATE').map((d) => d.type)).toEqual(['system_disappearing']);
    expect(framesOf(cSent, 'DM_SETTINGS_UPDATE')).toEqual([
      { channelId: gdm.toString(), ttlSecondsAfterRead: 604800 },
    ]);
  });

  it('the notice cannot be deleted, not even by its author within the minute', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    expect((await patchTimer(a, dm, 30)).status).toBe(200);
    const [notice] = await notices(dm);
    const bSent = connect(b, [dm]);
    const del = await call('DELETE', `/channels/${dm}/messages/${notice!.id}`, a);
    expect(del.status).toBe(403);
    expect((await call('DELETE', `/channels/${dm}/messages/${notice!.id}`, b)).status).toBe(403);
    const [still] = await db.select().from(schema.messages).where(eq(schema.messages.id, notice!.id));
    expect(still!.deletedAt).toBeNull();
    expect(framesOf(bSent, 'MESSAGE_DELETE')).toEqual([]);
    // An ordinary message of A's is still A's to delete.
    const sent = await call('POST', `/channels/${dm}/messages`, a, { content: 'oops' });
    const own = (sent.json!.message as { id: string }).id;
    expect((await call('DELETE', `/channels/${dm}/messages/${own}`, a)).status).toBe(200);
  });

  it("a change is a read for the changer: the notice starts the clocks their marker passes", async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    expect((await patchTimer(a, dm, 3600)).status).toBe(200);
    const sent = await call('POST', `/channels/${dm}/messages`, b, { content: 'timed, unread by A' });
    const m = BigInt((sent.json!.message as { id: string }).id);
    const aSent = connect(a, [dm]);
    const bSent = connect(b, [dm]);
    const t0 = Date.now();
    // A changes the timer without having acked B's message.
    expect((await patchTimer(a, dm, 60)).status).toBe(200);
    const latest = (await notices(dm)).at(-1)!;
    const [rs] = await db
      .select({ last: schema.readStates.lastMessageId })
      .from(schema.readStates)
      .where(and(eq(schema.readStates.userId, a), eq(schema.readStates.channelId, dm)));
    expect(rs!.last).toBe(latest.id);
    const [stored] = await db.select().from(schema.messages).where(eq(schema.messages.id, m));
    // Its own timer (1 hour), not the new one.
    expect(Math.abs(stored!.expiresAt!.getTime() - (t0 + 3_600_000))).toBeLessThan(5_000);
    expect(latest.expiresAt).toBeNull();
    const aExp = framesOf(aSent, 'MESSAGE_EXPIRY');
    expect(aExp.length).toBe(1);
    expect((aExp[0]!.expiries as Array<{ id: string }>).map((e) => e.id)).toEqual([m.toString()]);
    // A has receipts on, so B (the author) is told as well.
    expect(framesOf(bSent, 'MESSAGE_EXPIRY').length).toBe(1);
  });

  it('the notice cannot be edited and does not count toward message achievements', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    expect((await patchTimer(a, dm, 30)).status).toBe(200);
    expect((await patchTimer(a, dm, 60)).status).toBe(200);
    const [notice] = await notices(dm);
    const edit = await call('PATCH', `/channels/${dm}/messages/${notice!.id}`, a, { content: 'hijacked' });
    expect(edit.status).toBe(403);
    const [still] = await db.select().from(schema.messages).where(eq(schema.messages.id, notice!.id));
    expect(still!.content).toBe('Seed User set disappearing messages to 30 seconds.');
    const chatterbox = (await achievementsForUser(a)).find((x) => x.id.startsWith('chatterbox_'));
    expect(chatterbox!.value).toBe(0);
  });
});
