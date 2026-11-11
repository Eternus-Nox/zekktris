import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import type { WebSocket } from 'ws';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { dmsRouter } from '../src/routes/dms';
import { messagesRouter } from '../src/routes/messages';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { achievementsForUser } from '../src/services/achievements';
import {
  petNoticeText,
  recordActivity,
  setPetClockForTests,
  sweepPets,
  type PetDTO,
} from '../src/services/pets';
import {
  PET_TASKS,
  petLevelFloor,
  petLevelForPoints,
} from '@zekktris/shared/pets';
import { createUser, createDmChannel, addRelationship, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping Zekk Pet tests — no database reachable');
}

// Zekk Pets: the shared pet of a 1:1 DM, raised by keeping its streak going.
// The pet rules read an injectable clock (setPetClockForTests), so every test
// pins the time and moves it to reach the 18:00 UTC grumpy rule, day
// rollovers, sleep and running away. Streaks are seeded straight into
// dm_streaks relative to that clock.

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
async function sendForm(userId: bigint, dm: bigint, form: FormData) {
  const res = await app.request(`/channels/${dm}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenFor(userId)}` },
    body: form,
  });
  return res.status;
}
const petPath = (dm: bigint, rest = '') => `/users/@me/channels/${dm}/pet${rest}`;
const getPet = (u: bigint, dm: bigint) => call('GET', petPath(dm), u);
const invite = (u: bigint, dm: bigint) => call('POST', petPath(dm, '/invite'), u);
const accept = (u: bigint, dm: bigint) => call('POST', petPath(dm, '/accept'), u);
const decline = (u: bigint, dm: bigint) => call('POST', petPath(dm, '/decline'), u);
const rename = (u: bigint, dm: bigint, name: unknown) => call('PATCH', petPath(dm), u, { name });

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
const petFrames = (sent: Frame[]) =>
  framesOf(sent, 'DM_PET_UPDATE') as unknown as Array<{ channelId: string; pet: PetDTO | null }>;

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── Clock ──────────────────────────────────────────────────────────────────

// A Wednesday, well away from the real date (sends through the route stamp
// dm_streaks with the real day, which then reads as long broken here).
const D0 = '2027-03-10';
let now = new Date(`${D0}T12:00:00Z`);
const at = (iso: string) => {
  now = new Date(iso);
};
function day(offset: number): string {
  const d = new Date(`${D0}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// ── Seeding ────────────────────────────────────────────────────────────────

const tracked: bigint[] = [];

async function setName(userId: bigint, displayName: string) {
  await db.update(schema.users).set({ displayName }).where(eq(schema.users.id, userId));
}

/** Two named users and their 1:1 DM; `lo` is dm_pets' user A. */
async function pair() {
  const a = await createUser();
  const b = await createUser();
  await setName(a, 'Ari');
  await setName(b, 'Bo');
  const dm = await createDmChannel([a, b]);
  tracked.push(dm);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return { a, b, dm, lo, hi };
}

async function setStreak(
  p: { dm: bigint; lo: bigint; hi: bigint },
  s: { streak: number; lastCountedDay: string | null; lastDayA?: string | null; lastDayB?: string | null },
) {
  const values = {
    streak: s.streak,
    bestStreak: s.streak,
    lastCountedDay: s.lastCountedDay,
    lastDayA: s.lastDayA ?? s.lastCountedDay,
    lastDayB: s.lastDayB ?? s.lastCountedDay,
  };
  await db
    .insert(schema.dmStreaks)
    .values({ channelId: p.dm, userAId: p.lo, userBId: p.hi, ...values })
    .onConflictDoUpdate({ target: schema.dmStreaks.channelId, set: values });
}

/** A pair with an adopted egg: a 4-day streak credited yesterday, A invited,
 *  B accepted. */
async function adopted() {
  const p = await pair();
  await setStreak(p, { streak: 4, lastCountedDay: day(-1) });
  expect((await invite(p.a, p.dm)).status).toBe(200);
  expect((await accept(p.b, p.dm)).status).toBe(200);
  return p;
}

async function petRow(dm: bigint) {
  const [row] = await db.select().from(schema.dmPets).where(eq(schema.dmPets.channelId, dm));
  return row ?? null;
}
async function setRow(dm: bigint, set: Partial<typeof schema.dmPets.$inferInsert>) {
  await db.update(schema.dmPets).set(set).where(eq(schema.dmPets.channelId, dm));
}
async function notices(dm: bigint) {
  return db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, dm), eq(schema.messages.type, 'system_pet')))
    .orderBy(schema.messages.id);
}
const events = async (dm: bigint) => (await notices(dm)).map((n) => (n.metadata as { event: string }).event);
async function petOf(u: bigint, dm: bigint): Promise<PetDTO> {
  const r = await getPet(u, dm);
  expect(r.status).toBe(200);
  return r.json!.pet as PetDTO;
}
const taskDone = (pet: PetDTO) => Object.fromEntries(pet.tasks.map((t) => [t.key, t.done]));
const msg = (dm: bigint, authorId: bigint, ...extra: Array<'voice' | 'photo'>) =>
  recordActivity({ channelId: dm, authorId, kind: ['message', ...extra] });

describe.runIf(dbReady)('Zekk Pet (integration)', () => {
  beforeAll(() => {
    registry.init();
  });
  afterEach(async () => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
    now = new Date(`${D0}T12:00:00Z`);
    setPetClockForTests(() => now);
    if (tracked.length > 0) {
      await db.delete(schema.dmPets).where(inArray(schema.dmPets.channelId, tracked));
    }
  });
  afterAll(async () => {
    setPetClockForTests(null);
    // dm_streaks has no channel FK: the seed's cleanup doesn't reach it.
    if (tracked.length > 0) {
      await db.delete(schema.dmStreaks).where(inArray(schema.dmStreaks.channelId, tracked));
    }
    await cleanupAll();
    await closeDb();
  });
  setPetClockForTests(() => now);

  it('migration 0134 is journaled after 0133 and left the enum value, the table and its index', async () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../../packages/db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
    const at0134 = journal.entries.findIndex((e) => e.tag === '0134_zekk_pets');
    expect(at0134).toBeGreaterThan(0);
    const prev = journal.entries[at0134 - 1]!;
    expect(prev.tag).toBe('0133_disappearing_messages');
    expect(journal.entries[at0134]).toEqual({
      idx: 133,
      version: '7',
      when: prev.when + 86_400_000,
      tag: '0134_zekk_pets',
      breakpoints: true,
    });
    // Nothing in the migration may USE the new enum value (it is added in the
    // same transaction as every other pending migration).
    const statements = readFileSync(
      new URL('../../../packages/db/migrations/0134_zekk_pets.sql', import.meta.url),
      'utf8',
    ).split('--> statement-breakpoint');
    for (const stmt of statements.slice(1)) expect(stmt).not.toMatch(/'system_pet'/);

    const enumRows = (await db.execute(
      sql.raw(
        `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'message_type' AND e.enumlabel = 'system_pet'`,
      ),
    )) as unknown as unknown[];
    expect(enumRows.length).toBe(1);
    const cols = (await db.execute(
      sql.raw(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'dm_pets' ORDER BY ordinal_position`,
      ),
    )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['channel_id', 'bigint', 'NO'],
      ['user_a_id', 'bigint', 'NO'],
      ['user_b_id', 'bigint', 'NO'],
      ['status', 'text', 'NO'],
      ['invited_by', 'bigint', 'YES'],
      ['name', 'text', 'NO'],
      ['points', 'integer', 'NO'],
      ['level', 'integer', 'NO'],
      ['adopted_at', 'timestamp with time zone', 'YES'],
      ['last_fed_day', 'text', 'YES'],
      ['task_day', 'text', 'YES'],
      ['count_a', 'integer', 'NO'],
      ['count_b', 'integer', 'NO'],
      ['tasks_done', 'integer', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
    const idx = (await db.execute(
      sql.raw(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'dm_pets_sweep_idx'`),
    )) as unknown as Array<{ indexdef: string }>;
    expect(idx[0]?.indexdef).toMatch(/\(status, last_fed_day\)/);
    // The status CHECK and the cascades.
    const p = await pair();
    await expect(
      db.insert(schema.dmPets).values({
        channelId: p.dm,
        userAId: p.lo,
        userBId: p.hi,
        status: 'hatching' as never,
      }),
    ).rejects.toThrow();
    await db.insert(schema.dmPets).values({ channelId: p.dm, userAId: p.lo, userBId: p.hi, status: 'invited' });
    expect((await petRow(p.dm))!.name).toBe('Zekk');
  });

  it('only a live streak of 3+ days is eligible; inviting otherwise is a 409 that writes nothing', async () => {
    const p = await pair();
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: false, streak: 0, minStreak: 3 });
    expect((await invite(p.a, p.dm)).status).toBe(409);

    await setStreak(p, { streak: 2, lastCountedDay: day(0) });
    expect((await getPet(p.b, p.dm)).json).toEqual({ pet: null, eligible: false, streak: 2, minStreak: 3 });
    const two = await invite(p.a, p.dm);
    expect(two.status).toBe(409);
    expect((two.json!.error as { details?: unknown }).details).toEqual({ streak: 2, minStreak: 3 });

    // Broken: credited 2 days ago reads as 0, whatever the stored count.
    await setStreak(p, { streak: 9, lastCountedDay: day(-2) });
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: false, streak: 0, minStreak: 3 });
    expect((await invite(p.b, p.dm)).status).toBe(409);
    expect(await petRow(p.dm)).toBeNull();
    expect((await notices(p.dm)).length).toBe(0);

    // Alive (credited yesterday) and 3 days: either person may invite.
    await setStreak(p, { streak: 3, lastCountedDay: day(-1) });
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: true, streak: 3, minStreak: 3 });
    expect((await invite(p.b, p.dm)).status).toBe(200);
    // Once there's an invite, nobody is "eligible" to invite again.
    const after = (await getPet(p.a, p.dm)).json!;
    expect(after.eligible).toBe(false);
    expect((after.pet as PetDTO).status).toBe('invited');
  });

  it('refuses non-recipients (404) and group DMs (400) on every pet route', async () => {
    const p = await adopted();
    const stranger = await createUser();
    for (const r of [
      getPet(stranger, p.dm),
      invite(stranger, p.dm),
      accept(stranger, p.dm),
      decline(stranger, p.dm),
      rename(stranger, p.dm, 'Nope'),
    ]) {
      expect((await r).status).toBe(404);
    }
    const c = await createUser();
    const gdm = await createDmChannel([p.a, p.b, c], 'group_dm');
    tracked.push(gdm);
    for (const r of [
      getPet(p.a, gdm),
      invite(p.a, gdm),
      accept(p.b, gdm),
      decline(p.b, gdm),
      rename(p.a, gdm, 'Nope'),
    ]) {
      expect((await r).status).toBe(400);
    }
    expect(await petRow(gdm)).toBeNull();
    // A send in a group DM never touches a pet (there is none to touch).
    const res = await call('POST', `/channels/${gdm}/messages`, p.a, { content: 'hi all' });
    expect(res.status).toBe(201);
  });

  it('invite → accept: an egg with notices and an event to both sides', async () => {
    const p = await pair();
    await setStreak(p, { streak: 4, lastCountedDay: day(-1) });
    const [ch0] = await db.select().from(schema.channels).where(eq(schema.channels.id, p.dm));
    const aSent = connect(p.a, [p.dm]);
    const bSent = connect(p.b, [p.dm]);

    const inv = await invite(p.a, p.dm);
    expect(inv.status).toBe(200);
    const invited: PetDTO = {
      channelId: p.dm.toString(),
      status: 'invited',
      invitedBy: p.a.toString(),
      name: 'Zekk',
      level: 0,
      stage: 'egg',
      points: 0,
      levelFloor: 0,
      nextLevelAt: 25,
      mood: 'happy',
      tasks: [],
      fedToday: false,
      lastFedDay: null,
      wakeBy: null,
      adoptedAt: null,
      today: D0,
      dayEndsAt: `${day(1)}T00:00:00.000Z`,
    };
    expect(inv.json).toEqual({ pet: invited });
    expect((await getPet(p.b, p.dm)).json).toEqual({ pet: invited, eligible: false, streak: 4, minStreak: 3 });
    const [n1] = await notices(p.dm);
    expect(n1!.authorId).toBe(p.a);
    expect(n1!.content).toBe('Ari wants to raise a Zekk Pet together. 🥚');
    expect(n1!.metadata).toEqual({ kind: 'pet', event: 'invited', petName: 'Zekk', stage: 'egg', actorId: p.a.toString() });
    expect(n1!.expireAfterSeconds).toBeNull();
    for (const sent of [aSent, bSent]) {
      expect(petFrames(sent)).toEqual([{ channelId: p.dm.toString(), pet: invited }]);
      expect(framesOf(sent, 'MESSAGE_CREATE').map((d) => [d.id, d.type])).toEqual([[n1!.id.toString(), 'system_pet']]);
    }

    // One invite per DM; the inviter can't accept their own.
    expect((await invite(p.b, p.dm)).status).toBe(409);
    expect((await accept(p.a, p.dm)).status).toBe(403);

    const acc = await accept(p.b, p.dm);
    expect(acc.status).toBe(200);
    const pet = acc.json!.pet as PetDTO;
    expect(pet).toMatchObject({
      status: 'active',
      invitedBy: p.a.toString(),
      level: 0,
      stage: 'egg',
      points: 0,
      mood: 'hungry',
      fedToday: false,
      // Adoption takes the streak's last credited day.
      lastFedDay: day(-1),
      wakeBy: null,
      adoptedAt: now.toISOString(),
    });
    expect(pet.tasks).toEqual([
      { key: 'both_hi', done: false, points: 10 },
      {
        key: 'chatty',
        done: false,
        points: 10,
        progress: {
          a: { userId: p.lo.toString(), count: 0 },
          b: { userId: p.hi.toString(), count: 0 },
          goal: 10,
        },
      },
      { key: 'voice', done: false, points: 5 },
      { key: 'photo', done: false, points: 5 },
      { key: 'poke', done: false, points: 5 },
    ]);
    const [, n2] = await notices(p.dm);
    expect(n2!.authorId).toBe(p.b);
    expect(n2!.content).toBe('Bo and Ari adopted a Zekk Pet! 🥚');
    expect(n2!.metadata).toEqual({ kind: 'pet', event: 'adopted', petName: 'Zekk', stage: 'egg', actorId: p.b.toString() });
    for (const sent of [aSent, bSent]) expect(petFrames(sent).at(-1)).toEqual({ channelId: p.dm.toString(), pet });
    expect((await accept(p.b, p.dm)).status).toBe(409);
    expect((await invite(p.a, p.dm)).status).toBe(409);
    // Decline is only for an open invite.
    expect((await decline(p.a, p.dm)).status).toBe(409);

    // Notices never make the DM unread or move a read marker.
    const [ch1] = await db.select().from(schema.channels).where(eq(schema.channels.id, p.dm));
    expect(ch1!.lastMessageId).toBe(ch0!.lastMessageId);
    const markers = await db.select().from(schema.readStates).where(eq(schema.readStates.channelId, p.dm));
    expect(markers).toEqual([]);
  });

  it('accepting on a day both already said hi feeds the egg at once', async () => {
    const p = await pair();
    await setStreak(p, { streak: 5, lastCountedDay: day(0) });
    expect((await invite(p.b, p.dm)).status).toBe(200);
    const pet = (await accept(p.a, p.dm)).json!.pet as PetDTO;
    expect(pet).toMatchObject({ points: 10, fedToday: true, lastFedDay: D0, mood: 'happy' });
    expect(taskDone(pet)).toMatchObject({ both_hi: true, chatty: false });
    expect(pet.tasks[1]!.progress).toEqual({
      a: { userId: p.lo.toString(), count: 1 },
      b: { userId: p.hi.toString(), count: 1 },
      goal: 10,
    });
    // Only A had messaged today: A's side counts one, so it's lonely.
    const q = await pair();
    await setStreak(q, { streak: 5, lastCountedDay: day(-1), lastDayA: day(0), lastDayB: day(-1) });
    expect((await invite(q.a, q.dm)).status).toBe(200);
    expect(((await accept(q.b, q.dm)).json!.pet as PetDTO).mood).toBe('lonely');
  });

  it('decline and cancel remove the invite with no notice; the sweep expires it after 7 days', async () => {
    const p = await pair();
    await setStreak(p, { streak: 3, lastCountedDay: day(0) });
    const aSent = connect(p.a, [p.dm]);
    const bSent = connect(p.b, [p.dm]);
    expect((await invite(p.a, p.dm)).status).toBe(200);
    const declined = await decline(p.b, p.dm);
    expect(declined.status).toBe(200);
    expect(declined.json).toEqual({ pet: null });
    expect(await petRow(p.dm)).toBeNull();
    for (const sent of [aSent, bSent]) expect(petFrames(sent).at(-1)).toEqual({ channelId: p.dm.toString(), pet: null });
    // Nothing to decline any more: a quiet no-op, no event.
    expect((await decline(p.b, p.dm)).status).toBe(200);
    expect(petFrames(aSent).length).toBe(2);

    // The inviter cancels.
    expect((await invite(p.a, p.dm)).status).toBe(200);
    expect((await decline(p.a, p.dm)).status).toBe(200);
    expect(await petRow(p.dm)).toBeNull();
    expect(await events(p.dm)).toEqual(['invited', 'invited']);

    // Expiry: 7 days after the invite it is gone, at once for reads and at the
    // next sweep for the row (event, no notice).
    expect((await invite(p.b, p.dm)).status).toBe(200);
    at(`${day(7)}T11:59:00Z`);
    await sweepPets();
    expect((await petRow(p.dm))?.status).toBe('invited');
    at(`${day(7)}T12:00:00Z`);
    await setStreak(p, { streak: 10, lastCountedDay: day(7) });
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: true, streak: 10, minStreak: 3 });
    expect((await accept(p.a, p.dm)).status).toBe(409);
    const before = petFrames(bSent).length;
    expect((await sweepPets()).expired).toBeGreaterThanOrEqual(1);
    expect(await petRow(p.dm)).toBeNull();
    expect(petFrames(bSent).slice(before)).toEqual([{ channelId: p.dm.toString(), pet: null }]);
    expect(await events(p.dm)).toEqual(['invited', 'invited', 'invited']);
  });

  it('daily tasks award their points once per UTC day, with one event per visible change', async () => {
    const p = await adopted();
    const aSent = connect(p.a, [p.dm]);
    const frames = () => petFrames(aSent).length;
    const pet = () => petOf(p.a, p.dm);

    await msg(p.dm, p.lo);
    expect(await pet()).toMatchObject({ points: 0, mood: 'lonely' });
    expect(frames()).toBe(1);
    await msg(p.dm, p.hi);
    let cur = await pet();
    expect(cur).toMatchObject({ points: 10, fedToday: true, lastFedDay: D0, mood: 'happy' });
    expect(taskDone(cur).both_hi).toBe(true);
    expect(frames()).toBe(2);
    // Saying hi again earns nothing more, but the chatty count still moves.
    await msg(p.dm, p.lo);
    expect((await pet()).points).toBe(10);
    expect(frames()).toBe(3);

    await msg(p.dm, p.lo, 'voice');
    await msg(p.dm, p.hi, 'voice');
    await msg(p.dm, p.hi, 'photo');
    await recordActivity({ channelId: p.dm, authorId: p.lo, kind: 'poke' });
    await recordActivity({ channelId: p.dm, authorId: p.hi, kind: 'poke' });
    cur = await pet();
    expect(cur.points).toBe(25);
    expect(taskDone(cur)).toEqual({ both_hi: true, chatty: false, voice: true, photo: true, poke: true });
    // 25 points: the egg hatched (level 1, a baby) — one notice.
    expect(cur).toMatchObject({ level: 1, stage: 'baby', levelFloor: 25, nextLevelAt: 55 });
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'hatched']);
    const hatched = (await notices(p.dm)).at(-1)!;
    expect(hatched.content).toBe('Zekk hatched! 🐣');
    // A's poke was the one that got it to 25.
    expect(hatched.metadata).toEqual({ kind: 'pet', event: 'hatched', petName: 'Zekk', stage: 'baby', actorId: p.lo.toString() });
    expect(hatched.authorId).toBe(p.lo);

    // Chatty: 10 each. The counts show, capped at the goal.
    for (let i = 0; i < 8; i++) await msg(p.dm, p.lo);
    for (let i = 0; i < 9; i++) await msg(p.dm, p.hi);
    cur = await pet();
    expect(cur.tasks[1]).toEqual({
      key: 'chatty',
      done: true,
      points: 10,
      progress: { a: { userId: p.lo.toString(), count: 10 }, b: { userId: p.hi.toString(), count: 10 }, goal: 10 },
    });
    expect(cur).toMatchObject({ points: 35, mood: 'thriving' });
    // Past the goal nothing visible changes: no write, no event.
    const n = frames();
    const updatedAt = (await petRow(p.dm))!.updatedAt;
    await msg(p.dm, p.lo);
    await msg(p.dm, p.hi, 'voice');
    expect(frames()).toBe(n);
    expect((await petRow(p.dm))!.updatedAt).toEqual(updatedAt);
    // Max 35 a day.
    expect((await pet()).points).toBe(35);

    // A new UTC day: tasks and counts start over, points stay.
    at(`${day(1)}T08:00:00Z`);
    cur = await pet();
    expect(cur).toMatchObject({ points: 35, level: 1, fedToday: false, lastFedDay: D0, mood: 'hungry', today: day(1) });
    expect(Object.values(taskDone(cur))).toEqual([false, false, false, false, false]);
    expect(cur.tasks[1]!.progress).toMatchObject({ a: { count: 0 }, b: { count: 0 } });
    await msg(p.dm, p.hi);
    await msg(p.dm, p.lo, 'photo');
    cur = await pet();
    expect(cur).toMatchObject({ points: 50, fedToday: true, lastFedDay: day(1), mood: 'happy' });
    expect(taskDone(cur)).toMatchObject({ both_hi: true, photo: true });
    // Each DTO the event carried matches what GET reads.
    expect(petFrames(aSent).at(-1)!.pet).toEqual(cur);
  });

  it("the two people's first messages of the day, at once, feed it exactly once", async () => {
    const p = await adopted();
    await Promise.all([msg(p.dm, p.lo), msg(p.dm, p.hi), msg(p.dm, p.lo), msg(p.dm, p.hi)]);
    const row = (await petRow(p.dm))!;
    expect({ points: row.points, countA: row.countA, countB: row.countB, tasks: row.tasksDone }).toEqual({
      points: 10,
      countA: 2,
      countB: 2,
      tasks: 1,
    });
  });

  it('levels and stages follow the shared curve; only stage changes post a notice', async () => {
    expect([0, 24, 25, 54, 55, 174, 175, 474, 475, 899, 900, 2124, 2125].map(petLevelForPoints)).toEqual([
      0, 0, 1, 1, 2, 4, 5, 9, 10, 14, 15, 24, 25,
    ]);
    expect([1, 5, 10, 15, 25].map(petLevelFloor)).toEqual([25, 175, 475, 900, 2125]);

    const p = await adopted();
    let k = 0;
    const step = async (points: number, expected: Partial<PetDTO>, notice: string | null) => {
      const before = (await notices(p.dm)).length;
      // A fresh day each time, fed the day before, so both_hi earns its 10.
      k++;
      at(`${day(k)}T09:00:00Z`);
      await setRow(p.dm, {
        points,
        level: petLevelForPoints(points),
        lastFedDay: day(k - 1),
        taskDay: day(k - 1),
        countA: 0,
        countB: 0,
        tasksDone: 0,
      });
      await msg(p.dm, p.lo);
      await msg(p.dm, p.hi);
      expect(await petOf(p.a, p.dm)).toMatchObject(expected);
      const added = (await notices(p.dm)).slice(before);
      expect(added.map((n) => n.content)).toEqual(notice ? [notice] : []);
    };
    await step(40, { points: 50, level: 1, stage: 'baby', levelFloor: 25, nextLevelAt: 55 }, null);
    await step(45, { points: 55, level: 2, stage: 'baby', levelFloor: 55, nextLevelAt: 90 }, null);
    await step(170, { points: 180, level: 5, stage: 'kid', levelFloor: 175, nextLevelAt: 225 }, 'Zekk grew into a Kid!');
    await step(470, { points: 480, level: 10, stage: 'teen', levelFloor: 475, nextLevelAt: 550 }, 'Zekk grew into a Teen!');
    await step(890, { points: 900, level: 15, stage: 'adult', levelFloor: 900, nextLevelAt: 1000 }, 'Zekk grew into an Adult!');
    await step(2120, { points: 2130, level: 25, stage: 'legendary', levelFloor: 2125, nextLevelAt: 2275 }, 'Zekk grew into a Legendary!');
    const last = (await notices(p.dm)).at(-1)!;
    expect(last.metadata).toEqual({ kind: 'pet', event: 'evolved', petName: 'Zekk', stage: 'legendary', actorId: p.hi.toString() });
  });

  it('mood: asleep, thriving / happy when fed, lonely, grumpy from 18:00 UTC after a fed yesterday, else hungry', async () => {
    const p = await adopted();
    const mood = async () => (await petOf(p.b, p.dm)).mood;
    const all = PET_TASKS.reduce((m, t) => m | t.bit, 0);

    await setRow(p.dm, { lastFedDay: D0, taskDay: D0, countA: 3, countB: 2, tasksDone: all });
    expect(await mood()).toBe('thriving');
    await setRow(p.dm, { tasksDone: all & ~16 });
    expect(await mood()).toBe('happy');
    // Fed today beats lonely (impossible in practice, but the order holds).
    await setRow(p.dm, { countB: 0 });
    expect(await mood()).toBe('happy');

    // Fed yesterday, nobody has messaged today.
    await setRow(p.dm, { lastFedDay: day(-1), taskDay: D0, countA: 0, countB: 0, tasksDone: 0 });
    at(`${D0}T17:59:59Z`);
    expect(await mood()).toBe('hungry');
    at(`${D0}T18:00:00Z`);
    expect(await mood()).toBe('grumpy');
    at(`${D0}T23:59:59Z`);
    expect(await mood()).toBe('grumpy');
    // Exactly one of them has messaged today: lonely comes first.
    await setRow(p.dm, { countA: 1 });
    expect(await mood()).toBe('lonely');
    await setRow(p.dm, { countA: 0, countB: 4 });
    expect(await mood()).toBe('lonely');
    // Yesterday's counters are not today's.
    await setRow(p.dm, { taskDay: day(-1), countA: 5, countB: 0 });
    expect(await mood()).toBe('grumpy');
    // Last fed two days ago (the sweep hasn't put it to sleep yet): hungry.
    await setRow(p.dm, { lastFedDay: day(-2) });
    expect(await mood()).toBe('hungry');
    // Asleep wins over everything.
    await setRow(p.dm, { status: 'asleep', taskDay: D0, countA: 1, countB: 1, lastFedDay: D0 });
    expect(await mood()).toBe('asleep');
  });

  it('sleep → wake (level kept) → run away', async () => {
    const p = await adopted();
    const aSent = connect(p.a, [p.dm]);
    const bSent = connect(p.b, [p.dm]);
    // A kid, last fed today.
    await setRow(p.dm, { points: 200, level: petLevelForPoints(200), lastFedDay: D0, taskDay: D0, tasksDone: 1 });

    at(`${day(1)}T23:59:00Z`);
    await sweepPets();
    expect((await petRow(p.dm))!.status).toBe('active');
    expect(await petOf(p.a, p.dm)).toMatchObject({ mood: 'grumpy' });

    // Day 2: a whole day (day 1) went unfed.
    at(`${day(2)}T00:05:00Z`);
    const swept = await sweepPets();
    expect(swept.asleep).toBeGreaterThanOrEqual(1);
    let pet = await petOf(p.a, p.dm);
    expect(pet).toMatchObject({ status: 'asleep', mood: 'asleep', level: 5, stage: 'kid', wakeBy: day(3), lastFedDay: D0 });
    const asleep = (await notices(p.dm)).at(-1)!;
    expect(asleep.content).toBe('Zekk fell asleep. 😴 Say hi to each other within 2 days to wake it up.');
    expect(asleep.metadata).toEqual({ kind: 'pet', event: 'asleep', petName: 'Zekk', stage: 'kid', actorId: null });
    expect(asleep.authorId).toBe(p.lo);
    for (const sent of [aSent, bSent]) expect(petFrames(sent).at(-1)!.pet).toEqual(pet);
    // An overlapping tick posts nothing more.
    await sweepPets();
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'asleep']);

    // Day 3 (the last chance): both say hi — it wakes, level and points kept.
    at(`${day(3)}T21:00:00Z`);
    await msg(p.dm, p.lo, 'photo');
    expect((await petOf(p.a, p.dm)).status).toBe('asleep');
    await msg(p.dm, p.hi);
    pet = await petOf(p.a, p.dm);
    expect(pet).toMatchObject({ status: 'active', mood: 'happy', points: 215, level: 5, stage: 'kid', wakeBy: null, lastFedDay: day(3) });
    const awake = (await notices(p.dm)).at(-1)!;
    expect(awake.content).toBe('Zekk woke up! 🎉');
    expect(awake.metadata).toEqual({ kind: 'pet', event: 'awake', petName: 'Zekk', stage: 'kid', actorId: p.hi.toString() });

    // Neglected again: asleep on day 5, still asleep on day 7 → runs away.
    at(`${day(5)}T00:05:00Z`);
    await sweepPets();
    expect((await petOf(p.a, p.dm)).wakeBy).toBe(day(6));
    // Day 7 before the sweep: past wakeBy, a feed no longer wakes it.
    at(`${day(7)}T00:01:00Z`);
    await msg(p.dm, p.lo);
    await msg(p.dm, p.hi);
    expect((await petRow(p.dm))!.status).toBe('asleep');
    await sweepPets();
    expect(await petRow(p.dm)).toBeNull();
    const ran = (await notices(p.dm)).at(-1)!;
    expect(ran.content).toBe('Zekk ran away. Keep a 3-day streak to adopt a new one.');
    expect(ran.metadata).toEqual({ kind: 'pet', event: 'ran_away', petName: 'Zekk', stage: 'kid', actorId: null });
    expect(ran.authorId).toBe(p.lo);
    for (const sent of [aSent, bSent]) expect(petFrames(sent).at(-1)).toEqual({ channelId: p.dm.toString(), pet: null });
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'asleep', 'awake', 'asleep', 'ran_away']);
    // The DM can adopt a new one once eligible again.
    await setStreak(p, { streak: 3, lastCountedDay: day(7) });
    expect((await getPet(p.b, p.dm)).json).toMatchObject({ pet: null, eligible: true });
    expect((await invite(p.b, p.dm)).status).toBe(200);
  });

  it('after downtime an active pet unfed for 4+ days runs away directly', async () => {
    const p = await adopted();
    at(`${day(4)}T03:00:00Z`);
    await setRow(p.dm, { lastFedDay: D0 });
    await sweepPets();
    expect(await petRow(p.dm)).toBeNull();
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'ran_away']);
  });

  it('pushes clock-only changes after 18:00 and midnight UTC', async () => {
    const p = await adopted();
    const bSent = connect(p.b, [p.dm]);
    at(`${D0}T17:55:00Z`);
    await sweepPets();
    expect(petFrames(bSent)).toEqual([]);
    at(`${D0}T18:05:00Z`);
    expect((await sweepPets()).refreshed).toBeGreaterThanOrEqual(1);
    expect(petFrames(bSent).map((f) => f.pet!.mood)).toEqual(['grumpy']);
    at(`${D0}T18:15:00Z`);
    await sweepPets();
    expect(petFrames(bSent).length).toBe(1);
    // Fed tonight; after midnight the tasks reset and it's hungry again.
    await msg(p.dm, p.lo);
    await msg(p.dm, p.hi);
    const fedFrames = petFrames(bSent).length;
    at(`${day(1)}T00:05:00Z`);
    await sweepPets();
    const last = petFrames(bSent).at(-1)!.pet!;
    expect(petFrames(bSent).length).toBe(fedFrames + 1);
    expect(last).toMatchObject({ mood: 'hungry', fedToday: false, today: day(1) });
  });

  it('rename: validated, normalised, one notice, no-op when unchanged, 10 an hour', async () => {
    const p = await pair();
    await setStreak(p, { streak: 3, lastCountedDay: day(0) });
    expect((await invite(p.a, p.dm)).status).toBe(200);
    // Not while it's only an invite.
    expect((await rename(p.a, p.dm, 'Mochi')).status).toBe(409);
    expect((await accept(p.b, p.dm)).status).toBe(200);
    const aSent = connect(p.a, [p.dm]);

    for (const bad of ['', '   ', 'x'.repeat(25), 'bad\u0007name', '🐣'.repeat(25), 42, null]) {
      expect((await rename(p.a, p.dm, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await petRow(p.dm))!.name).toBe('Zekk');

    const ok = await rename(p.a, p.dm, '  Mochi \n  Bean ');
    expect(ok.status).toBe(200);
    expect((ok.json!.pet as PetDTO).name).toBe('Mochi Bean');
    const n = (await notices(p.dm)).at(-1)!;
    expect(n.content).toBe('Ari renamed the pet to Mochi Bean.');
    expect(n.metadata).toEqual({ kind: 'pet', event: 'renamed', petName: 'Mochi Bean', stage: 'egg', actorId: p.a.toString() });
    expect(petFrames(aSent).at(-1)!.pet!.name).toBe('Mochi Bean');

    // The same name again: nothing at all (and not counted).
    const frames = petFrames(aSent).length;
    expect((await rename(p.b, p.dm, 'Mochi Bean')).status).toBe(200);
    expect(petFrames(aSent).length).toBe(frames);
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'renamed']);
    // 24 code points is fine, emoji included.
    expect((await rename(p.b, p.dm, '🐣'.repeat(24))).status).toBe(200);

    // Ten renames an hour per user.
    for (let i = 0; i < 9; i++) expect((await rename(p.a, p.dm, `Name ${i}`)).status).toBe(200);
    expect((await rename(p.a, p.dm, 'One too many')).status).toBe(429);
    expect((await rename(p.b, p.dm, 'Still fine')).status).toBe(200);
  });

  it('writes that post a notice face the send gates: blocks either way (404) and instance mute (403)', async () => {
    const p = await pair();
    await setStreak(p, { streak: 3, lastCountedDay: day(0) });
    await addRelationship(p.b, p.a, 'blocked');
    expect((await invite(p.a, p.dm)).status).toBe(404);
    expect((await invite(p.b, p.dm)).status).toBe(404);
    expect(await petRow(p.dm)).toBeNull();

    const q = await pair();
    await setStreak(q, { streak: 3, lastCountedDay: day(0) });
    expect((await invite(q.a, q.dm)).status).toBe(200);
    await db.update(schema.users).set({ mutedAt: new Date(), mutedUntil: null }).where(eq(schema.users.id, q.b));
    const muted = await accept(q.b, q.dm);
    expect(muted.status).toBe(403);
    expect((muted.json?.error as { code?: string } | undefined)?.code).toBe('INSTANCE_MUTED');
    // Declining posts nothing, so it is always allowed.
    expect((await decline(q.b, q.dm)).status).toBe(200);
    expect(await petRow(q.dm)).toBeNull();
  });

  it('the send and poke routes feed it — voice, photos (encrypted too) and pokes — and never fail a send', async () => {
    const p = await adopted();
    const aSent = connect(p.a, [p.dm]);
    const row = () => petRow(p.dm);

    const text = await call('POST', `/channels/${p.dm}/messages`, p.a, { content: 'hi' });
    expect(text.status).toBe(201);
    await waitFor(async () => ((await row())!.taskDay === D0 && (await row())!.countA + (await row())!.countB === 1));

    const voice = new FormData();
    voice.append(
      'payload_json',
      JSON.stringify({ content: '', voiceMessage: { durationSeconds: 2, waveform: 'AAEC' } }),
    );
    voice.append('files[0]', new File([new Uint8Array([1, 2, 3, 4])], 'voice.ogg', { type: 'audio/ogg' }));
    expect(await sendForm(p.b, p.dm, voice)).toBe(201);
    await waitFor(async () => ((await row())!.tasksDone & 4) !== 0);
    // B's voice message is also B's hi: fed.
    expect((await row())!.tasksDone & 1).toBe(1);
    expect((await row())!.tasksDone & 8).toBe(0);

    // A 1×1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const photo = new FormData();
    photo.append('payload_json', JSON.stringify({ content: 'look' }));
    photo.append('files[0]', new File([png], 'dot.png', { type: 'image/png' }));
    expect(await sendForm(p.a, p.dm, photo)).toBe(201);
    await waitFor(async () => ((await row())!.tasksDone & 8) !== 0);

    const poke = await call('POST', `/channels/${p.dm}/poke`, p.b, { pokeType: 'wave' });
    expect(poke.status).toBe(200);
    await waitFor(async () => ((await row())!.tasksDone & 16) !== 0);
    expect((await row())!.points).toBe(25);
    // One event per send / poke, every one of them a visible change.
    expect(petFrames(aSent).length).toBe(4);

    // An encrypted image is octet-stream to us, but its encrypted thumbnail
    // marks it as a photo; a plain file attachment is not one.
    const q = await adopted();
    const file = new FormData();
    file.append('payload_json', JSON.stringify({ content: 'doc' }));
    file.append('files[0]', new File([new Uint8Array([1, 2, 3])], 'notes.bin'));
    expect(await sendForm(q.a, q.dm, file)).toBe(201);
    await waitFor(async () => ((await petRow(q.dm))!.countA + (await petRow(q.dm))!.countB) === 1);
    expect((await petRow(q.dm))!.tasksDone & 8).toBe(0);
    const enc = new FormData();
    enc.append('payload_json', JSON.stringify({ content: '', attachments: [{ width: 4, height: 4, hasThumbnail: true }] }));
    enc.append('files[0]', new File([new Uint8Array([7, 7, 7, 7])], 'photo.zke', { type: 'application/octet-stream' }));
    enc.append('thumbs[0]', new File([new Uint8Array([8, 8])], 'thumb.zke', { type: 'application/octet-stream' }));
    expect(await sendForm(q.b, q.dm, enc)).toBe(201);
    await waitFor(async () => ((await petRow(q.dm))!.tasksDone & 8) !== 0);

    // A DM without a pet sends as always.
    const r = await pair();
    expect((await call('POST', `/channels/${r.dm}/messages`, r.a, { content: 'no pet here' })).status).toBe(201);
    expect(await petRow(r.dm)).toBeNull();
  });

  it("a sweep notice (user A's row) sends A's held read marker back while a timed message waits for A", async () => {
    const p = await adopted();
    // A sets a timer (A's marker moves to that notice), then B's timed
    // message waits above it for A to read.
    const timer = await call('PATCH', `/users/@me/channels/${p.dm}/settings`, p.lo, { ttlSecondsAfterRead: 300 });
    expect(timer.status).toBe(200);
    const [timerNotice] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, p.dm), eq(schema.messages.type, 'system_disappearing')));
    const fromB = await call('POST', `/channels/${p.dm}/messages`, p.hi, { content: 'read me' });
    expect(fromB.status).toBe(201);
    await waitFor(async () => (await petRow(p.dm))!.countB + (await petRow(p.dm))!.countA === 1);
    await setRow(p.dm, { lastFedDay: day(-2) });
    const loSent = connect(p.lo, [p.dm]);
    const hiSent = connect(p.hi, [p.dm]);

    await sweepPets();
    const asleep = (await notices(p.dm)).at(-1)!;
    expect((asleep.metadata as { event: string }).event).toBe('asleep');
    expect(asleep.authorId).toBe(p.lo);
    expect(framesOf(loSent, 'CHANNEL_ACK')).toEqual([
      { channelId: p.dm.toString(), lastMessageId: timerNotice!.id.toString(), mentionCount: 0 },
    ]);
    const echoAt = loSent.findIndex((f) => f.t === 'MESSAGE_CREATE' && f.d?.id === asleep.id.toString());
    expect(echoAt).toBeGreaterThanOrEqual(0);
    expect(loSent.findIndex((f) => f.t === 'CHANNEL_ACK')).toBeGreaterThan(echoAt);
    expect(framesOf(hiSent, 'CHANNEL_ACK')).toEqual([]);
    // Nobody's stored marker moved, and B's message still waits.
    const [rs] = await db
      .select()
      .from(schema.readStates)
      .where(and(eq(schema.readStates.userId, p.lo), eq(schema.readStates.channelId, p.dm)));
    expect(rs!.lastMessageId).toBe(timerNotice!.id);
    const [waiting] = await db
      .select({ expiresAt: schema.messages.expiresAt })
      .from(schema.messages)
      .where(eq(schema.messages.id, BigInt((fromB.json!.message as { id: string }).id)));
    expect(waiting!.expiresAt).toBeNull();
  });

  it("pet notices can't be edited or deleted and don't count toward message achievements", async () => {
    const p = await adopted();
    const sent = await call('POST', `/channels/${p.dm}/messages`, p.a, { content: 'one real message' });
    expect(sent.status).toBe(201);
    expect((await rename(p.a, p.dm, 'Pip')).status).toBe(200);
    const mine = (await notices(p.dm)).filter((n) => n.authorId === p.a);
    expect(mine.map((n) => (n.metadata as { event: string }).event)).toEqual(['invited', 'renamed']);
    for (const n of mine) {
      expect((await call('PATCH', `/channels/${p.dm}/messages/${n.id}`, p.a, { content: 'edited' })).status).toBe(403);
      expect((await call('DELETE', `/channels/${p.dm}/messages/${n.id}`, p.a)).status).toBe(403);
    }
    const still = await notices(p.dm);
    expect(still.every((n) => n.deletedAt === null && n.editedAt === null)).toBe(true);
    const chatterbox = (await achievementsForUser(p.a)).find((x) => x.id === 'chatterbox_100');
    expect(chatterbox?.value).toBe(1);
  });

  it('builds every notice fallback from the shared names', () => {
    const p = { petName: 'Zekk', stage: 'kid' as const, actorName: 'Sam', otherName: 'Alex' };
    expect(petNoticeText('invited', p)).toBe('Sam wants to raise a Zekk Pet together. 🥚');
    expect(petNoticeText('adopted', p)).toBe('Sam and Alex adopted a Zekk Pet! 🥚');
    expect(petNoticeText('hatched', p)).toBe('Zekk hatched! 🐣');
    expect(petNoticeText('evolved', p)).toBe('Zekk grew into a Kid!');
    expect(petNoticeText('evolved', { ...p, stage: 'adult' })).toBe('Zekk grew into an Adult!');
    expect(petNoticeText('asleep', p)).toBe('Zekk fell asleep. 😴 Say hi to each other within 2 days to wake it up.');
    expect(petNoticeText('awake', p)).toBe('Zekk woke up! 🎉');
    expect(petNoticeText('ran_away', p)).toBe('Zekk ran away. Keep a 3-day streak to adopt a new one.');
    expect(petNoticeText('renamed', p)).toBe('Sam renamed the pet to Zekk.');
  });
});
