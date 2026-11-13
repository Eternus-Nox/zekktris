import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
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
  acceptPet,
  invitePet,
  petNoticeText,
  recordActivity,
  setPetClockForTests,
  sweepPets,
  type PetDTO,
} from '../src/services/pets';
import { recordDmMessage } from '../src/services/streaks';
import { purgeAccount } from '../src/services/purge';
import { rollbackChannelWatermarks, searchDirectMessages, searchMessages } from '../src/services/messages';
import { disableE2eeAndPurge, enableE2ee } from '../src/services/dms';
import { unreadBadgeCounts } from '../src/services/readStates';
import {
  PET_TASKS,
  petLevelFloor,
  petLevelForPoints,
} from '@zekktris/shared/pets';
import { createUser, createDmChannel, addRelationship, cleanupAll, createMessage } from './seed';
import { probeDb, closeDb } from './db-available';

// A test can stall the next recipient lookup (the one a pet write's events
// are addressed with) until it lets go: `stallNext` runs first, once.
const recipients = vi.hoisted(() => ({ stallNext: null as null | (() => Promise<void>) }));
vi.mock('../src/services/dms', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/dms')>();
  return {
    ...real,
    listAllRecipients: async (...args: Parameters<typeof real.listAllRecipients>) => {
      const stall = recipients.stallNext;
      recipients.stallNext = null;
      if (stall) await stall();
      return real.listAllRecipients(...args);
    },
  };
});

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
function shiftDay(from: string, offset: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const day = (offset: number) => shiftDay(D0, offset);
/** The send and poke routes stamp each activity with its real time (the
 *  message's createdAt, the poke's arrival), so a test that feeds the pet
 *  through them runs it on the real clock (afterEach pins it again). Returns
 *  the real UTC day. */
function useRealClock(): string {
  setPetClockForTests(null);
  return new Date().toISOString().slice(0, 10);
}

/** Is a backend of this database waiting on a lock, running a statement
 *  matching `pattern` (ILIKE)? */
async function backendWaitingOn(pattern: string): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE ${pattern}`,
  )) as unknown as unknown[];
  return rows.length > 0;
}

/** Open a transaction on its own connection that runs `hold` and then stays
 *  open (keeping its locks) until `release()`. */
async function holdOpen(hold: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const done = db.transaction(async (tx) => {
    await hold(tx);
    ready();
    await released;
  });
  await Promise.race([isReady, done]);
  return { release, done };
}

// ── Seeding ────────────────────────────────────────────────────────────────

const tracked: bigint[] = [];

function dobForAge(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

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
    prevDayA: null,
    prevDayB: null,
  };
  await db
    .insert(schema.dmStreaks)
    .values({ channelId: p.dm, userAId: p.lo, userBId: p.hi, ...values })
    .onConflictDoUpdate({ target: schema.dmStreaks.channelId, set: values });
}

/** A pair with an adopted egg: a 4-day streak credited the day before
 *  `today` (the pinned D0 unless given), A invited, B accepted. */
async function adopted(today = D0) {
  const p = await pair();
  await setStreak(p, { streak: 4, lastCountedDay: shiftDay(today, -1) });
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
  // One supervised child (15, watch word 'snapchat') for the whole file: the
  // watch-word scan caches the supervised-child set for 15 s, so the link
  // must exist before the first scan.
  let supervisedChild: bigint;
  beforeAll(async () => {
    registry.init();
    const parent = await createUser({ dateOfBirth: dobForAge(40) });
    supervisedChild = await createUser({ dateOfBirth: dobForAge(15) });
    await setName(supervisedChild, 'Kit');
    await db.insert(schema.parentChildLinks).values({
      parentId: parent,
      childId: supervisedChild,
      status: 'active',
      initiatedBy: 'parent',
    });
    await db.insert(schema.childWatchWords).values({ childId: supervisedChild, word: 'snapchat' });
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

  it("migration 0135 follows 0134 and gives dm_streaks each side's previous day", async () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../../packages/db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
    const at0135 = journal.entries.findIndex((e) => e.tag === '0135_dm_streak_prev_days');
    expect(at0135).toBeGreaterThan(0);
    const prev = journal.entries[at0135 - 1]!;
    expect(prev.tag).toBe('0134_zekk_pets');
    expect(journal.entries[at0135]).toEqual({
      idx: 134,
      version: '7',
      when: prev.when + 86_400_000,
      tag: '0135_dm_streak_prev_days',
      breakpoints: true,
    });
    const cols = (await db.execute(
      sql.raw(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'dm_streaks' AND column_name LIKE 'prev_day_%'
          ORDER BY column_name`,
      ),
    )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['prev_day_a', 'text', 'YES'],
      ['prev_day_b', 'text', 'YES'],
    ]);
  });

  it('only a live streak of 3+ days is eligible; inviting otherwise is a 409 that writes nothing', async () => {
    const p = await pair();
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: false, streak: 0, minStreak: 3, canAct: true });
    expect((await invite(p.a, p.dm)).status).toBe(409);

    await setStreak(p, { streak: 2, lastCountedDay: day(0) });
    expect((await getPet(p.b, p.dm)).json).toEqual({ pet: null, eligible: false, streak: 2, minStreak: 3, canAct: true });
    const two = await invite(p.a, p.dm);
    expect(two.status).toBe(409);
    expect((two.json!.error as { details?: unknown }).details).toEqual({ streak: 2, minStreak: 3 });

    // Broken: credited 2 days ago reads as 0, whatever the stored count.
    await setStreak(p, { streak: 9, lastCountedDay: day(-2) });
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: false, streak: 0, minStreak: 3, canAct: true });
    expect((await invite(p.b, p.dm)).status).toBe(409);
    expect(await petRow(p.dm)).toBeNull();
    expect((await notices(p.dm)).length).toBe(0);

    // Alive (credited yesterday) and 3 days: either person may invite.
    await setStreak(p, { streak: 3, lastCountedDay: day(-1) });
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: true, streak: 3, minStreak: 3, canAct: true });
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
    expect((await getPet(p.b, p.dm)).json).toEqual({ pet: invited, eligible: false, streak: 4, minStreak: 3, canAct: true });
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
    expect((await getPet(p.a, p.dm)).json).toEqual({ pet: null, eligible: true, streak: 10, minStreak: 3, canAct: true });
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

  it('DM_PET_UPDATEs leave in commit order: a slow recipient lookup never leaves an older pet last', async () => {
    const p = await adopted();
    // Fed today, and both on 9 of the 10 chatty messages.
    await setRow(p.dm, { taskDay: D0, countA: 9, countB: 9, tasksDone: 1, lastFedDay: D0, points: 10, level: 0 });
    const aSent = connect(p.a, [p.dm]);
    // A's 10th message stalls in the lookup its event is addressed with, as
    // it would waiting for a connection from a busy pool…
    let stalled!: () => void;
    const isStalled = new Promise<void>((r) => (stalled = r));
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    recipients.stallNext = async () => {
      stalled();
      await gate;
    };
    const first = msg(p.dm, p.lo);
    await isStalled;
    // …while B's 10th, which completes chatty, runs: it must not get its
    // event out first (it waits for the pet's lock instead).
    let secondDone = false;
    const second = msg(p.dm, p.hi).finally(() => {
      secondDone = true;
    });
    await waitFor(async () => secondDone || (await backendWaitingOn('%pg_advisory_xact_lock%')));
    letGo();
    await Promise.all([first, second]);

    const cur = await petOf(p.a, p.dm);
    expect(cur.points).toBe(20);
    expect(taskDone(cur).chatty).toBe(true);
    const chatty = (pet: PetDTO) => pet.tasks.find((t) => t.key === 'chatty')!.progress!;
    expect(petFrames(aSent).map((f) => [f.pet!.points, chatty(f.pet!).a!.count, chatty(f.pet!).b!.count])).toEqual([
      [10, 10, 9],
      [20, 10, 10],
    ]);
    expect(petFrames(aSent).at(-1)!.pet).toEqual(cur);
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
    // So neither side is offered an Adopt that can only fail, while the live
    // 3-day streak still reads as it is (and nothing says who blocked whom).
    for (const u of [p.a, p.b]) {
      expect((await getPet(u, p.dm)).json).toEqual({
        pet: null,
        eligible: false,
        streak: 3,
        minStreak: 3,
        canAct: false,
      });
    }

    const q = await pair();
    await setStreak(q, { streak: 3, lastCountedDay: day(0) });
    expect((await invite(q.a, q.dm)).status).toBe(200);
    await db.update(schema.users).set({ mutedAt: new Date(), mutedUntil: null }).where(eq(schema.users.id, q.b));
    const muted = await accept(q.b, q.dm);
    expect(muted.status).toBe(403);
    expect((muted.json?.error as { code?: string } | undefined)?.code).toBe('INSTANCE_MUTED');
    // The muted invitee isn't offered Accept; the inviter still can act.
    expect((await getPet(q.b, q.dm)).json).toMatchObject({ eligible: false, canAct: false });
    expect((await getPet(q.a, q.dm)).json).toMatchObject({ eligible: false, canAct: true });
    // Declining posts nothing, so it is always allowed.
    expect((await decline(q.b, q.dm)).status).toBe(200);
    expect(await petRow(q.dm)).toBeNull();
  });

  it('the send and poke routes feed it — voice, photos (encrypted too) and pokes — and never fail a send', async () => {
    const today = useRealClock();
    const p = await adopted(today);
    const aSent = connect(p.a, [p.dm]);
    const row = () => petRow(p.dm);

    const text = await call('POST', `/channels/${p.dm}/messages`, p.a, { content: 'hi' });
    expect(text.status).toBe(201);
    await waitFor(async () => ((await row())!.taskDay === today && (await row())!.countA + (await row())!.countB === 1));

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
    const q = await adopted(today);
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
    const today = useRealClock();
    const p = await adopted(today);
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
    await setRow(p.dm, { lastFedDay: shiftDay(today, -2) });
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

  it('each activity counts on its own UTC day, and a late one never rewinds a newer day', async () => {
    const p = await adopted();
    // A said hi on D0; B's last-second hi of D0 is handled just after
    // midnight. It still feeds D0, the day the streak credits it to.
    await msg(p.dm, p.lo);
    at(`${day(1)}T00:00:00.020Z`);
    await recordActivity({ channelId: p.dm, authorId: p.hi, kind: 'message', at: new Date(`${D0}T23:59:59.990Z`) });
    expect(await petRow(p.dm)).toMatchObject({ taskDay: D0, countA: 1, countB: 1, tasksDone: 1, points: 10, lastFedDay: D0 });

    // Day 1: both say hi first…
    await msg(p.dm, p.lo);
    await msg(p.dm, p.hi);
    const fed = (await petRow(p.dm))!;
    expect(fed).toMatchObject({ taskDay: day(1), countA: 1, countB: 1, tasksDone: 1, points: 20, lastFedDay: day(1) });
    // …then a send created at D0 23:59:59.999 gets the lock: it is dropped,
    // not counted over day 1's counters.
    await recordActivity({
      channelId: p.dm,
      authorId: p.hi,
      kind: ['message', 'photo'],
      at: new Date(`${D0}T23:59:59.999Z`),
    });
    expect(await petRow(p.dm)).toEqual(fed);
    // So the next hi of day 1 doesn't earn both_hi a second time.
    await msg(p.dm, p.lo);
    expect(await petRow(p.dm)).toMatchObject({ countA: 2, countB: 1, tasksDone: 1, points: 20 });

    // The streak takes the same instant, and never rewinds a side's stamp.
    await recordDmMessage({ channelId: p.dm, authorId: p.lo, recipientId: p.hi, at: new Date(`${day(1)}T00:00:01Z`) });
    await recordDmMessage({ channelId: p.dm, authorId: p.lo, recipientId: p.hi, at: new Date(`${D0}T23:59:59.999Z`) });
    const [streak] = await db.select().from(schema.dmStreaks).where(eq(schema.dmStreaks.channelId, p.dm));
    expect(streak!.lastDayA).toBe(day(1));
  });

  it("a late hi still feeds the day its streak credited when a next-day poke got the pet's lock first", async () => {
    const poke = PET_TASKS.find((t) => t.key === 'poke')!.bit;
    // p: A said hi on D0, and B's hi at D0 23:59:59.950 commits the streak's
    // credit for D0. q: the same, but the sweep puts q to sleep first. r: only
    // A's late hi, which the streak never credited (B was silent on D0).
    const [p, q, r] = [await adopted(), await adopted(), await adopted()];
    const late = new Date(`${D0}T23:59:59.950Z`);
    for (const s of [p, q]) {
      await recordDmMessage({ channelId: s.dm, authorId: s.lo, recipientId: s.hi, at: now });
      await msg(s.dm, s.lo);
      await recordDmMessage({ channelId: s.dm, authorId: s.hi, recipientId: s.lo, at: late });
    }
    await recordDmMessage({ channelId: r.dm, authorId: r.lo, recipientId: r.hi, at: late });
    at(`${day(1)}T00:00:00.020Z`);
    // A's poke (no streak lock) reaches the pet before B's send: day 1 starts.
    await recordActivity({ channelId: p.dm, authorId: p.lo, kind: 'poke', at: now });
    expect(await petRow(p.dm)).toMatchObject({ taskDay: day(1), tasksDone: poke, points: 5, lastFedDay: day(-1) });
    await recordActivity({ channelId: p.dm, authorId: p.hi, kind: 'message', at: late });
    // D0 is fed and paid; day 1's counters and tasks stay as they were.
    const fed = (await petRow(p.dm))!;
    expect(fed).toMatchObject({
      status: 'active',
      lastFedDay: D0,
      points: 15,
      taskDay: day(1),
      countA: 0,
      countB: 0,
      tasksDone: poke,
    });
    expect((await petOf(p.a, p.dm)).mood).toBe('hungry');
    // Paid once.
    await recordActivity({ channelId: p.dm, authorId: p.hi, kind: ['message', 'photo'], at: late });
    expect(await petRow(p.dm)).toEqual(fed);

    await sweepPets();
    expect(await petRow(p.dm)).toMatchObject({ status: 'active', lastFedDay: D0 });
    expect(await events(p.dm)).toEqual(['invited', 'adopted']);
    // q fell asleep before its late hi got there: the hi wakes it.
    expect(await petRow(q.dm)).toMatchObject({ status: 'asleep' });
    await recordActivity({ channelId: q.dm, authorId: q.lo, kind: 'poke', at: now });
    await recordActivity({ channelId: q.dm, authorId: q.hi, kind: 'message', at: late });
    expect(await petRow(q.dm)).toMatchObject({ status: 'active', lastFedDay: D0, points: 15, tasksDone: poke });
    expect(await events(q.dm)).toEqual(['invited', 'adopted', 'asleep', 'awake']);
    // r's late hi fed nothing on D0: it stays dropped.
    await recordActivity({ channelId: r.dm, authorId: r.lo, kind: 'poke', at: now });
    await recordActivity({ channelId: r.dm, authorId: r.lo, kind: 'message', at: late });
    expect(await petRow(r.dm)).toMatchObject({ status: 'asleep', lastFedDay: day(-1), points: 5, countA: 0 });
  });

  it('a hi from just before midnight still credits its day when a next-day send reaches the streak first', async () => {
    // A 4-day streak credited through day -1 and an egg fed on day -1. A says
    // hi at noon on D0; B's hi at D0 23:59:59.900 is overtaken by a send at
    // day 1 00:00:00.100 — in p A's, in q B's own — whose streak update and
    // pet activity both run first.
    const [p, q] = [await adopted(), await adopted()];
    const late = new Date(`${D0}T23:59:59.900Z`);
    for (const s of [p, q]) {
      await recordDmMessage({ channelId: s.dm, authorId: s.lo, recipientId: s.hi, at: now });
      await recordActivity({ channelId: s.dm, authorId: s.lo, kind: 'message', at: now });
    }
    at(`${day(1)}T00:00:00.100Z`);
    const nextDay = [
      { s: p, first: p.lo, second: p.hi },
      { s: q, first: q.hi, second: q.lo },
    ];
    for (const { s, first } of nextDay) {
      const other = first === s.lo ? s.hi : s.lo;
      expect(await recordDmMessage({ channelId: s.dm, authorId: first, recipientId: other, at: now })).toEqual({
        streak: 4,
        changed: false,
      });
      await recordActivity({ channelId: s.dm, authorId: first, kind: 'message', at: now });
      // B's late hi: D0 is credited (A said hi on D0 too) and feeds the pet.
      expect(await recordDmMessage({ channelId: s.dm, authorId: s.hi, recipientId: s.lo, at: late })).toEqual({
        streak: 5,
        changed: true,
      });
      await recordActivity({ channelId: s.dm, authorId: s.hi, kind: 'message', at: late });
      const [streak] = await db.select().from(schema.dmStreaks).where(eq(schema.dmStreaks.channelId, s.dm));
      expect(streak).toMatchObject({ lastCountedDay: D0, streak: 5, bestStreak: 5 });
      expect(await petRow(s.dm)).toMatchObject({ status: 'active', lastFedDay: D0, points: 10, taskDay: day(1) });
    }

    // The day-1 sweep finds both fed yesterday: nobody falls asleep.
    await sweepPets();
    for (const { s } of nextDay) {
      expect(await petRow(s.dm)).toMatchObject({ status: 'active', lastFedDay: D0 });
      expect(await events(s.dm)).toEqual(['invited', 'adopted']);
    }

    // Both say hi on day 1: the streak goes on from D0 and the pet is fed.
    at(`${day(1)}T09:00:00Z`);
    for (const { s, second } of nextDay) {
      const other = second === s.lo ? s.hi : s.lo;
      expect(await recordDmMessage({ channelId: s.dm, authorId: second, recipientId: other, at: now })).toEqual({
        streak: 6,
        changed: true,
      });
      await recordActivity({ channelId: s.dm, authorId: second, kind: 'message', at: now });
      const [streak] = await db.select().from(schema.dmStreaks).where(eq(schema.dmStreaks.channelId, s.dm));
      expect(streak).toMatchObject({ lastCountedDay: day(1), streak: 6 });
      expect(await petRow(s.dm)).toMatchObject({ status: 'active', lastFedDay: day(1), points: 20 });
    }
  });

  it("a send racing the accept is counted, even when the accept's seed missed it", async () => {
    const p = await pair();
    // B said hi today; A last messaged yesterday. A invited, B accepts while
    // A sends A's first message of the day.
    await setStreak(p, { streak: 4, lastCountedDay: day(-1), lastDayA: day(-1), lastDayB: D0 });
    expect((await invite(p.lo, p.dm)).status).toBe(200);
    // Stall the accept between its seed (read from dm_streaks) and its write.
    const stall = await holdOpen(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM dm_pets WHERE channel_id = ${p.dm} FOR UPDATE`);
    });
    const accepting = acceptPet({ channelId: p.dm, userId: p.hi });
    await waitFor(() => backendWaitingOn('update "dm_pets"%'));
    // A's send: the streak commits, then the pet hook runs while the row
    // still reads 'invited'.
    await recordDmMessage({ channelId: p.dm, authorId: p.lo, recipientId: p.hi, at: now });
    const feeding = recordActivity({ channelId: p.dm, authorId: p.lo, kind: 'message' });
    stall.release();
    await stall.done;
    await accepting;
    await feeding;
    expect(await petRow(p.dm)).toMatchObject({
      status: 'active',
      countA: 1,
      countB: 1,
      tasksDone: 1,
      points: 10,
      lastFedDay: D0,
    });
    expect(await petOf(p.a, p.dm)).toMatchObject({ fedToday: true, mood: 'happy' });
  });

  it("the sweep's clock-driven refresh is built from the row as it is under the lock", async () => {
    const p = await adopted();
    const bSent = connect(p.b, [p.dm]);
    at(`${D0}T17:55:00Z`);
    await sweepPets();
    // A rename that commits after the 18:05 tick picked its candidates: it
    // holds the pet's lock (as renamePet does) while the tick starts.
    const renaming = await holdOpen(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'pet:' + p.dm.toString()}, 0))`);
      await tx.update(schema.dmPets).set({ name: 'Mochi' }).where(eq(schema.dmPets.channelId, p.dm));
    });
    at(`${D0}T18:05:00Z`);
    let swept = false;
    const sweeping = sweepPets().finally(() => {
      swept = true;
    });
    await waitFor(async () => swept || (await backendWaitingOn('%pg_advisory_xact_lock%')));
    renaming.release();
    await renaming.done;
    expect((await sweeping).refreshed).toBeGreaterThanOrEqual(1);
    // Not the snapshot from before the rename.
    expect(petFrames(bSent).map((f) => [f.pet!.name, f.pet!.mood])).toEqual([['Mochi', 'grumpy']]);
  });

  it('rename drops invisible and bidi-formatting characters', async () => {
    const p = await adopted();
    for (const bad of ['\u200B', '\u2060\uFEFF', '\u202E', '\u200D \u200C', '\u2066\u2069']) {
      expect((await rename(p.a, p.dm, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await petRow(p.dm))!.name).toBe('Zekk');
    expect(((await rename(p.a, p.dm, '\u202Eabc')).json!.pet as PetDTO).name).toBe('abc');
    expect(((await rename(p.b, p.dm, 'Mo\u200Bchi')).json!.pet as PetDTO).name).toBe('Mochi');
    expect(((await rename(p.a, p.dm, '\u2066Pip\u2069 \u200E')).json!.pet as PetDTO).name).toBe('Pip');
    // An emoji ZWJ sequence stays whole.
    expect(((await rename(p.b, p.dm, '🐣\u200D🔥')).json!.pet as PetDTO).name).toBe('🐣\u200D🔥');
    expect((await notices(p.dm)).at(-1)!.content).toBe('Bo renamed the pet to 🐣\u200D🔥.');
  });

  it("a notice's fallback content can't carry a masked link or a mention token from a name; its metadata keeps the name", async () => {
    // Old apps render `content` as an ordinary message from its author.
    const unsafe = (s: string) => /\]\(|<[@#]|@(everyone|here)/.test(s);
    // B's link in a name the sweep posts as A, and A's display name in B's accept.
    const p = await adopted();
    const q = await pair();
    await setName(q.a, '[Ari](https://e.io) @here');
    await setStreak(q, { streak: 4, lastCountedDay: day(-1) });
    expect((await invite(q.a, q.dm)).status).toBe(200);
    expect((await accept(q.b, q.dm)).status).toBe(200);
    const adoptedNotice = (await notices(q.dm)).at(-1)!;
    expect(adoptedNotice.content).toBe('Bo and [Ari]⁠(https://e.io) @⁠here adopted a Zekk Pet! 🥚');

    expect((await rename(p.b, p.dm, '[x](https://e.io)')).status).toBe(200);
    expect((await rename(q.b, q.dm, '<@1> <#2> \\<@&3>')).status).toBe(200);
    expect((await notices(p.dm)).at(-1)!.content).toBe('Bo renamed the pet to [x]⁠(https://e.io).');
    for (const dm of [p.dm, q.dm]) await setRow(dm, { lastFedDay: D0, taskDay: D0 });
    at(`${day(2)}T00:05:00Z`);
    await sweepPets();
    const [pa, qa] = [(await notices(p.dm)).at(-1)!, (await notices(q.dm)).at(-1)!];
    expect(pa.content).toBe('[x]⁠(https://e.io) fell asleep. 😴 Say hi to each other within 2 days to wake it up.');
    expect(qa.content).toBe(
      '<⁠@1> <⁠#2> \\⁠<⁠@&3> fell asleep. 😴 Say hi to each other within 2 days to wake it up.',
    );
    for (const n of [adoptedNotice, pa, qa]) expect(unsafe(n.content), n.content).toBe(false);
    expect(pa.metadata).toMatchObject({ event: 'asleep', petName: '[x](https://e.io)' });
    expect(qa.metadata).toMatchObject({ event: 'asleep', petName: '<@1> <#2> \\<@&3>' });
  });

  it("a name shaped like E2EE ciphertext can't make a notice read as encrypted, and turning E2EE off purges no notice", async () => {
    const p = await adopted();
    await setName(p.a, 'zkE2EE/3:Ari');
    expect((await rename(p.a, p.dm, 'zkE2EE/3:Mochi')).status).toBe(200);
    await setRow(p.dm, { points: 20 });
    await msg(p.dm, p.lo);
    await msg(p.dm, p.hi);
    const all = await notices(p.dm);
    expect(all.map((n) => (n.metadata as { event: string }).event)).toEqual(['invited', 'adopted', 'renamed', 'hatched']);
    for (const n of all) expect(n.content, n.content).not.toMatch(/^zkE2EE\//);
    const hatched = all.at(-1)!;
    expect(hatched.content).toBe('zkE2EE⁠/3:Mochi hatched! 🐣');
    expect(hatched.metadata).toMatchObject({ petName: 'zkE2EE/3:Mochi' });
    // A notice posted before names were defused is still never ciphertext.
    await db.update(schema.messages).set({ content: 'zkE2EE/3:Mochi hatched! 🐣' }).where(eq(schema.messages.id, hatched.id));
    const cipher = await createMessage(p.dm, { authorId: p.a, content: 'zkE2EE/3:Y2lwaGVy' });
    const verifier = 'Q29ycmVjdFZlcmlmaWVyMDAwMDAwMDAwMDAwMDAwMD0=';
    await enableE2ee(p.dm, 'c2FsdHNhbHRzYWx0c2FsdA==', verifier);
    const off = await disableE2eeAndPurge(p.dm, verifier);
    expect(off).toEqual({ status: 'disabled', purgedMessageIds: [cipher] });
    expect((await notices(p.dm)).map((n) => n.id)).toEqual(all.map((n) => n.id));
  });

  it('search leaves pet notices out, whoever is their nominal author', async () => {
    const p = await adopted();
    const said = await createMessage(p.dm, { authorId: p.lo, content: 'our pet fell asleep on the sofa' });
    // The sweep's notice is authored by A (p.lo), whose own words match too.
    at(`${day(1)}T12:00:00Z`);
    await sweepPets();
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'asleep']);
    for (const u of [p.a, p.b]) {
      expect((await searchDirectMessages(u, 'asleep')).map((m) => m.id)).toEqual([said]);
      expect((await searchDirectMessages(u, '', 50, { authorId: p.lo })).map((m) => m.id)).toEqual([said]);
    }
    expect((await searchMessages(p.dm, 'Zekk')).length).toBe(0);
    expect((await searchMessages(p.dm, '', 50, { authorId: p.lo })).map((m) => m.id)).toEqual([said]);
    expect((await searchMessages(p.dm, '', 50, { authorId: p.hi })).length).toBe(0);
  });

  it('a rename runs the parental watch-word scan, flagged against its notice', async () => {
    const friend = await createUser();
    await setName(friend, 'Bo');
    const dm = await createDmChannel([supervisedChild, friend]);
    tracked.push(dm);
    // A supervised child's DMs are friends-only by default.
    await addRelationship(supervisedChild, friend, 'friend');
    await addRelationship(friend, supervisedChild, 'friend');
    const [lo, hi] = supervisedChild < friend ? [supervisedChild, friend] : [friend, supervisedChild];
    await setStreak({ dm, lo, hi }, { streak: 4, lastCountedDay: day(-1) });
    expect((await invite(friend, dm)).status).toBe(200);
    expect((await accept(supervisedChild, dm)).status).toBe(200);
    const flags = () =>
      db
        .select()
        .from(schema.flaggedMessages)
        .where(eq(schema.flaggedMessages.channelId, dm))
        .orderBy(schema.flaggedMessages.id);
    const lastNotice = async () => (await notices(dm)).at(-1)!;

    // The friend's rename reaches the child: 'received'.
    expect((await rename(friend, dm, 'add snapchat: bob')).status).toBe(200);
    const received = await lastNotice();
    expect((received.metadata as { event: string }).event).toBe('renamed');
    await waitFor(async () => (await flags()).length === 1);
    // The child's own: 'sent'.
    expect((await rename(supervisedChild, dm, 'Pip')).status).toBe(200);
    expect((await rename(supervisedChild, dm, 'Snapchat Pip')).status).toBe(200);
    const sent = await lastNotice();
    await waitFor(async () => (await flags()).length === 2);
    expect((await flags()).map((f) => [f.childId, f.messageId, f.direction, f.matchedWord])).toEqual([
      [supervisedChild, received.id, 'received', 'snapchat'],
      [supervisedChild, sent.id, 'sent', 'snapchat'],
    ]);
    // Each rename is a new notice, scanned as a fresh send: a name that keeps a
    // word the old one had is flagged again, against its own notice (the
    // earlier flag's notice doesn't show what this rename added).
    expect((await rename(friend, dm, 'Snapchat Pip II')).status).toBe(200);
    const again = await lastNotice();
    await waitFor(async () => (await flags()).length === 3);
    expect((await flags()).map((f) => [f.childId, f.messageId, f.direction, f.matchedWord])).toEqual([
      [supervisedChild, received.id, 'received', 'snapchat'],
      [supervisedChild, sent.id, 'sent', 'snapchat'],
      [supervisedChild, again.id, 'received', 'snapchat'],
    ]);
  });

  it('a poke across a block feeds nothing and posts nothing', async () => {
    const today = useRealClock();
    const p = await adopted(today);
    // At 20 points a poke would hatch it (+5) and post 'hatched'.
    await setRow(p.dm, { points: 20 });
    await addRelationship(p.a, p.b, 'blocked');
    const before = await petRow(p.dm);
    expect((await call('POST', `/channels/${p.dm}/poke`, p.b, { pokeType: 'wave' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await petRow(p.dm)).toEqual(before);
    expect(await events(p.dm)).toEqual(['invited', 'adopted']);
    // Unblocked, a poke feeds it again (from A: B's next one is throttled).
    await db
      .delete(schema.relationships)
      .where(and(eq(schema.relationships.userId, p.a), eq(schema.relationships.targetId, p.b)));
    expect((await call('POST', `/channels/${p.dm}/poke`, p.a, { pokeType: 'wave' })).status).toBe(200);
    await waitFor(async () => (await petRow(p.dm))!.points === 25);
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'hatched']);
  });

  it("a sweep notice puts its nominal author's marker back whenever the other person's message waits unread", async () => {
    const p = await adopted();
    // A (user A, the sweep notices' author) read up to A's own message.
    const mine = await createMessage(p.dm, { authorId: p.lo, content: 'hey' });
    await db.insert(schema.readStates).values({ userId: p.lo, channelId: p.dm, lastMessageId: mine, mentionCount: 0 });
    const loSent = connect(p.lo, [p.dm]);
    const hiSent = connect(p.hi, [p.dm]);

    // Nothing from B waits: no ack.
    await setRow(p.dm, { lastFedDay: day(-2) });
    await sweepPets();
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'asleep']);
    expect(framesOf(loSent, 'CHANNEL_ACK')).toEqual([]);

    // B's "you there?" (no timer) waits unread above A's marker.
    await createMessage(p.dm, { authorId: p.hi, content: 'you there?' });
    at(`${day(2)}T00:05:00Z`);
    await sweepPets();
    expect(await events(p.dm)).toEqual(['invited', 'adopted', 'asleep', 'ran_away']);
    const ran = (await notices(p.dm)).at(-1)!;
    expect(framesOf(loSent, 'CHANNEL_ACK')).toEqual([
      { channelId: p.dm.toString(), lastMessageId: mine.toString(), mentionCount: 0 },
    ]);
    const echoAt = loSent.findIndex((f) => f.t === 'MESSAGE_CREATE' && f.d?.id === ran.id.toString());
    expect(echoAt).toBeGreaterThanOrEqual(0);
    expect(loSent.findIndex((f) => f.t === 'CHANNEL_ACK')).toBeGreaterThan(echoAt);
    expect(framesOf(hiSent, 'CHANNEL_ACK')).toEqual([]);
  });

  it('deleting an account drops its pets: an event to the other person, and the sweep posts nothing', async () => {
    const p = await adopted();
    const bSent = connect(p.b, [p.dm]);
    await purgeAccount(p.a);
    expect(await petRow(p.dm)).toBeNull();
    expect(petFrames(bSent)).toEqual([{ channelId: p.dm.toString(), pet: null }]);
    // Days later there is nothing to put to sleep or run away.
    at(`${day(2)}T00:05:00Z`);
    await sweepPets();
    at(`${day(4)}T00:05:00Z`);
    await sweepPets();
    expect(await events(p.dm)).toEqual(['invited', 'adopted']);
    // Nor can the other person invite the deleted account while the streak
    // still reads alive.
    at(`${D0}T12:00:00Z`);
    expect((await invite(p.b, p.dm)).status).toBe(409);
    expect(await petRow(p.dm)).toBeNull();
  });

  it("a send from before the adoption counts once, whether or not the accept's seed saw it", async () => {
    // A said hi just before B accepted: the streak saw the send before the
    // accept read dm_streaks, the pet hook only runs after the accept.
    const p = await pair();
    await setStreak(p, { streak: 4, lastCountedDay: day(-1), lastDayA: day(-1), lastDayB: D0 });
    expect((await invite(p.lo, p.dm)).status).toBe(200);
    const sentAt = new Date(`${D0}T11:59:59.900Z`);
    await recordDmMessage({ channelId: p.dm, authorId: p.lo, recipientId: p.hi, at: sentAt });
    expect((await accept(p.hi, p.dm)).status).toBe(200);
    expect(await petRow(p.dm)).toMatchObject({ countA: 1, countB: 1, tasksDone: 1, points: 10 });
    await recordActivity({ channelId: p.dm, authorId: p.lo, kind: 'message', at: sentAt });
    expect(await petRow(p.dm)).toMatchObject({ countA: 1, countB: 1, tasksDone: 1, points: 10, lastFedDay: D0 });
    // A's sends after the adoption count as usual: 8 more make 9, not 10.
    for (let i = 0; i < 8; i++) await recordActivity({ channelId: p.dm, authorId: p.lo, kind: 'message', at: now });
    expect((await petOf(p.a, p.dm)).tasks[1]!.progress!.a).toEqual({ userId: p.lo.toString(), count: 9 });

    // The seed missed it (its streak commit came after the accept's read):
    // the late hook counts it, once.
    const q = await pair();
    await setStreak(q, { streak: 4, lastCountedDay: day(-1), lastDayA: day(-1), lastDayB: D0 });
    expect((await invite(q.lo, q.dm)).status).toBe(200);
    expect((await accept(q.hi, q.dm)).status).toBe(200);
    expect(await petRow(q.dm)).toMatchObject({ countA: 0, countB: 1, tasksDone: 0, points: 0 });
    await recordActivity({ channelId: q.dm, authorId: q.lo, kind: 'message', at: sentAt });
    expect(await petRow(q.dm)).toMatchObject({ countA: 1, countB: 1, tasksDone: 1, points: 10, lastFedDay: D0 });
  });

  it("a notice an action causes puts its author's marker back whenever the other person's message waits unread", async () => {
    const p = await adopted();
    // At 20 points B's poke hatches the egg: a 'hatched' notice authored by B.
    await setRow(p.dm, { points: 20 });
    // B read up to B's own message; then A's ordinary (untimed) one arrived.
    const mine = await createMessage(p.dm, { authorId: p.b, content: 'hey' });
    await db.insert(schema.readStates).values({ userId: p.b, channelId: p.dm, lastMessageId: mine, mentionCount: 0 });
    const fromA = await createMessage(p.dm, { authorId: p.a, content: 'unread for B' });
    const aSent = connect(p.a, [p.dm]);
    const bSent = connect(p.b, [p.dm]);

    // B pokes from a notification: that reads nothing.
    await recordActivity({ channelId: p.dm, authorId: p.b, kind: 'poke' });
    const hatched = (await notices(p.dm)).at(-1)!;
    expect((hatched.metadata as { event: string }).event).toBe('hatched');
    expect(hatched.authorId).toBe(p.b);
    expect(framesOf(bSent, 'CHANNEL_ACK')).toEqual([
      { channelId: p.dm.toString(), lastMessageId: mine.toString(), mentionCount: 0 },
    ]);
    const echoAt = bSent.findIndex((f) => f.t === 'MESSAGE_CREATE' && f.d?.id === hatched.id.toString());
    expect(echoAt).toBeGreaterThanOrEqual(0);
    expect(bSent.findIndex((f) => f.t === 'CHANNEL_ACK')).toBeGreaterThan(echoAt);
    expect(framesOf(aSent, 'CHANNEL_ACK')).toEqual([]);

    // Once B has read A's message, B's next notice sends nothing back (B's
    // own 'hatched' notice in between doesn't count).
    await db
      .update(schema.readStates)
      .set({ lastMessageId: fromA })
      .where(and(eq(schema.readStates.userId, p.b), eq(schema.readStates.channelId, p.dm)));
    await setRow(p.dm, { points: 170, level: petLevelForPoints(170) });
    await recordActivity({ channelId: p.dm, authorId: p.b, kind: 'voice' });
    expect((await events(p.dm)).at(-1)).toBe('evolved');
    expect(framesOf(bSent, 'CHANNEL_ACK').length).toBe(1);
  });

  it("deleting or expiring the DM's newest message never moves its watermark onto a pet notice", async () => {
    const watermark = async (dm: bigint) =>
      (await db.select({ id: schema.channels.lastMessageId }).from(schema.channels).where(eq(schema.channels.id, dm)))[0]!
        .id;
    /** Both people read up to `id`, which is the DM's newest message. */
    const allRead = async (q: { dm: bigint; a: bigint; b: bigint }, id: bigint) => {
      await db.update(schema.channels).set({ lastMessageId: id }).where(eq(schema.channels.id, q.dm));
      for (const userId of [q.a, q.b]) {
        await db.insert(schema.readStates).values({ userId, channelId: q.dm, lastMessageId: id, mentionCount: 0 });
      }
    };
    const badges = async (q: { a: bigint; b: bigint }) => {
      const counts = await unreadBadgeCounts([q.a, q.b]);
      return [counts.get(q.a.toString()) ?? 0, counts.get(q.b.toString()) ?? 0];
    };
    /** The sweep posts 'asleep', newer than every real message. */
    const fallAsleep = async (dm: bigint) => {
      await setRow(dm, { lastFedDay: day(-2) });
      await sweepPets();
      expect((await events(dm)).at(-1)).toBe('asleep');
    };

    // Deleted through the route.
    const p = await adopted();
    const older = await createMessage(p.dm, { authorId: p.b, content: 'first' });
    const newest = await createMessage(p.dm, { authorId: p.a, content: 'hi' });
    await allRead(p, newest);
    await fallAsleep(p.dm);
    expect(await watermark(p.dm)).toBe(newest);
    expect((await call('DELETE', `/channels/${p.dm}/messages/${newest}`, p.a)).status).toBe(200);
    expect(await watermark(p.dm)).toBe(older);
    expect(await badges(p)).toEqual([0, 0]);
    // Only notices left: no watermark, as in a DM where only notices were posted.
    expect((await call('DELETE', `/channels/${p.dm}/messages/${older}`, p.b)).status).toBe(200);
    expect(await watermark(p.dm)).toBeNull();
    expect(await badges(p)).toEqual([0, 0]);

    // Expired: what sweepExpiredDmMessages (and the E2EE-off purge) does to
    // the timed newest message, run on this DM alone.
    const q = await adopted();
    const kept = await createMessage(q.dm, { authorId: q.a, content: 'no timer' });
    const timed = await createMessage(q.dm, { authorId: q.b, content: 'bye', expireAfterSeconds: 60 });
    await allRead(q, timed);
    await fallAsleep(q.dm);
    await db
      .update(schema.messages)
      .set({ expiresAt: new Date(Date.now() - 1000), deletedAt: new Date() })
      .where(eq(schema.messages.id, timed));
    await rollbackChannelWatermarks([q.dm], [timed]);
    expect(await watermark(q.dm)).toBe(kept);
    expect(await badges(q)).toEqual([0, 0]);
  });

  it('closing the DM drops its pet or invite: nobody adopts or raises one in a one-sided DM', async () => {
    const p = await pair();
    await setStreak(p, { streak: 4, lastCountedDay: day(-1) });
    expect((await invite(p.a, p.dm)).status).toBe(200);
    const bSent = connect(p.b, [p.dm]);
    expect((await call('DELETE', `/users/@me/channels/${p.dm}`, p.a)).status).toBe(200);
    expect(await petRow(p.dm)).toBeNull();
    expect(petFrames(bSent)).toEqual([{ channelId: p.dm.toString(), pet: null }]);
    expect((await getPet(p.b, p.dm)).json).toEqual({
      pet: null,
      eligible: false,
      streak: 4,
      minStreak: 3,
      canAct: false,
    });
    expect((await accept(p.b, p.dm)).status).toBe(409);
    expect((await invite(p.b, p.dm)).status).toBe(409);
    // An invite an in-flight request wrote after the close can't be accepted.
    await db
      .insert(schema.dmPets)
      .values({ channelId: p.dm, userAId: p.lo, userBId: p.hi, status: 'invited', invitedBy: p.a });
    expect((await accept(p.b, p.dm)).status).toBe(409);
    expect((await petRow(p.dm))!.status).toBe('invited');
    expect(await events(p.dm)).toEqual(['invited']);

    // An adopted pet goes too: no 'asleep' / 'ran_away' later in the name of
    // someone who left.
    const q = await adopted();
    expect((await call('DELETE', `/users/@me/channels/${q.dm}`, q.b)).status).toBe(200);
    expect(await petRow(q.dm)).toBeNull();
    at(`${day(2)}T00:05:00Z`);
    await sweepPets();
    at(`${day(4)}T00:05:00Z`);
    await sweepPets();
    expect(await events(q.dm)).toEqual(['invited', 'adopted']);
  });

  it('an invite that passed the route before a close or an account deletion writes nothing', async () => {
    // The route read both people as here; the close (and its drop, which
    // found nothing) landed before the invite took the pet lock.
    const p = await pair();
    await setStreak(p, { streak: 4, lastCountedDay: day(-1) });
    expect((await call('DELETE', `/users/@me/channels/${p.dm}`, p.a)).status).toBe(200);
    await expect(invitePet({ channelId: p.dm, inviterId: p.b, otherId: p.a })).rejects.toMatchObject({
      status: 409,
    });
    expect(await petRow(p.dm)).toBeNull();
    expect(await events(p.dm)).toEqual([]);

    // Account deletion, of the other person or of the inviter themselves.
    const q = await pair();
    await setStreak(q, { streak: 4, lastCountedDay: day(-1) });
    await purgeAccount(q.a);
    for (const [inviterId, otherId] of [
      [q.b, q.a],
      [q.a, q.b],
    ]) {
      await expect(invitePet({ channelId: q.dm, inviterId, otherId })).rejects.toMatchObject({ status: 409 });
    }
    expect(await petRow(q.dm)).toBeNull();
    expect(await events(q.dm)).toEqual([]);

    // A deletion that lands after the invite read the person as live, but
    // before it wrote anything, waits for it: its pet cleanup then finds the
    // invite and removes it. (The in-lock recipient check comes after that
    // read; stall it there.)
    const r = await pair();
    await setStreak(r, { streak: 4, lastCountedDay: day(-1) });
    const bSent = connect(r.b, [r.dm]);
    let stalled!: () => void;
    const isStalled = new Promise<void>((res) => (stalled = res));
    let letGo!: () => void;
    const gate = new Promise<void>((res) => (letGo = res));
    recipients.stallNext = async () => {
      stalled();
      await gate;
    };
    const inviting = invitePet({ channelId: r.dm, inviterId: r.b, otherId: r.a });
    await isStalled;
    let purged = false;
    const purging = purgeAccount(r.a).finally(() => {
      purged = true;
    });
    await waitFor(async () => purged || (await backendWaitingOn('update "users" set %"deleted_at" = %')));
    letGo();
    await inviting;
    await purging;
    expect(await petRow(r.dm)).toBeNull();
    expect(petFrames(bSent).at(-1)).toEqual({ channelId: r.dm.toString(), pet: null });
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
    // Names are defused for old apps' markdown and mention scan; emphasis stays.
    const odd = { petName: '[a](b) <@1>', stage: 'kid' as const, actorName: 'x\\]', otherName: '@everyone_*' };
    expect(petNoticeText('hatched', odd)).toBe('[a]⁠(b) <⁠@1> hatched! 🐣');
    expect(petNoticeText('adopted', odd)).toBe('x\\⁠]⁠ and @⁠everyone_* adopted a Zekk Pet! 🥚');
    // With no backslash-escapes, a name reads unchanged where `content` is shown
    // as is (installed Android, the web, iOS search): the joiners are invisible.
    // Nor can a name make it start like E2EE ciphertext (`zkE2EE/<v>:`).
    const wire = { ...p, petName: 'zkE2EE/3:Mochi', actorName: 'zkE2EE/1:Ari', otherName: 'zkE2EE/2:Bo' };
    for (const e of ['invited', 'adopted', 'hatched', 'evolved', 'asleep', 'awake', 'ran_away', 'renamed'] as const) {
      expect(petNoticeText(e, wire)).not.toMatch(/zkE2EE\//);
    }
    for (const name of ['[AFK] Ari', 'Mochi [v2]', '¯\\_(ツ)_/¯', '\\(^o^)/', 'a\\\\b', 'zkE2EE/3:Mochi']) {
      const shown = (e: 'hatched' | 'renamed') =>
        petNoticeText(e, { ...p, petName: name, actorName: name }).replace(/\u2060/g, '');
      expect(shown('hatched')).toBe(`${name} hatched! 🐣`);
      expect(shown('renamed')).toBe(`${name} renamed the pet to ${name}.`);
    }
  });
});
