import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { WebSocket } from 'ws';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import {
  achievementsForUser,
  syncAndNotifyAchievements,
  syncAndNotifyAchievementsThrottled,
} from '../src/services/achievements';
import { acceptPet, dropPet, invitePet, recordActivity, setPetClockForTests } from '../src/services/pets';
import { purgeAccount } from '../src/services/purge';
import { PET_ALL_TASKS_MASK, PET_TASKS } from '@zekktris/shared/pets';
import { createUser, createDmChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping Zekk Pet achievement tests — no database reachable');
}

// Zekk Keeper (the highest level of a current pet, one rung per stage) and
// Perfect Day (every task done in one UTC day). Both read dm_pets, which loses
// its row when a pet runs away, when either person closes the DM and when the
// partner deletes their account — so both are floored by the ledger, and
// pets.recordActivity syncs both people the moment one may be earned. The pet
// rules read an injectable clock; the achievements' "today" is the same one.
//
// The clock is pinned AFTER every day zekk-pet.integration.test.ts uses: its
// sweeps scan every pet in the shared test database under its own clock, and
// a pet last fed later than that clock is never put to sleep or run off by
// them. For the same reason nothing here calls sweepPets.

const D0 = '2027-05-12';
let now = new Date(`${D0}T12:00:00Z`);
const at = (iso: string) => {
  now = new Date(iso);
};
function day(offset: number): string {
  const d = new Date(`${D0}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const POKE = PET_TASKS.find((t) => t.key === 'poke')!.bit;
const tracked: bigint[] = [];

type Frame = { t?: string; d?: Record<string, unknown> };
const liveConns: Connection[] = [];
function connect(userId: bigint): Frame[] {
  const sent: Frame[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    close: () => undefined,
  } as unknown as WebSocket;
  const conn = new Connection(ws);
  conn.markAuthenticated(userId, [], [], []);
  registry.add(conn);
  registry.index(conn);
  liveConns.push(conn);
  return sent;
}
const unlocks = (sent: Frame[]) =>
  sent.filter((f) => f.t === 'ACHIEVEMENT_UNLOCK').map((f) => f.d!.id as string);

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function makeBot(userId: bigint) {
  await db.update(schema.users).set({ isBot: true }).where(eq(schema.users.id, userId));
}
const seeded = async (userId: bigint) =>
  (await db.select({ s: schema.users.achievementsSeeded }).from(schema.users).where(eq(schema.users.id, userId)))[0]!
    .s;
async function ledger(userId: bigint): Promise<string[]> {
  const rows = await db
    .select({ id: schema.userAchievements.achievementId })
    .from(schema.userAchievements)
    .where(eq(schema.userAchievements.userId, userId));
  return rows.map((r) => r.id).sort();
}
async function shelfOf(userId: bigint) {
  const shelf = await achievementsForUser(userId);
  const by = (id: string) => {
    const a = shelf.find((x) => x.id === id);
    expect(a, `achievement ${id} missing from the shelf`).toBeDefined();
    return a!;
  };
  return { shelf, by };
}

/** Two people (B a bot when asked) in a 1:1 DM with a live 4-day streak. */
async function pair(opts: { botB?: boolean; a?: bigint } = {}) {
  const a = opts.a ?? (await createUser());
  const b = await createUser();
  if (opts.botB) await makeBot(b);
  const dm = await createDmChannel([a, b]);
  tracked.push(dm);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await db.insert(schema.dmStreaks).values({
    channelId: dm,
    userAId: lo,
    userBId: hi,
    streak: 4,
    bestStreak: 4,
    lastCountedDay: day(-1),
    lastDayA: day(-1),
    lastDayB: day(-1),
  });
  return { a, b, dm, lo, hi };
}
/** …with an adopted egg (A invited, B accepted). */
async function adopted(opts: { botB?: boolean; a?: bigint } = {}) {
  const p = await pair(opts);
  await invitePet({ channelId: p.dm, inviterId: p.a, otherId: p.b });
  await acceptPet({ channelId: p.dm, userId: p.b });
  return p;
}
async function setRow(dm: bigint, set: Partial<typeof schema.dmPets.$inferInsert>) {
  await db.update(schema.dmPets).set(set).where(eq(schema.dmPets.channelId, dm));
}
const msg = (dm: bigint, authorId: bigint) => recordActivity({ channelId: dm, authorId, kind: 'message' });

describe.runIf(dbReady)('Zekk Pet achievements (integration)', () => {
  beforeAll(() => {
    registry.init();
  });
  afterEach(() => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
    now = new Date(`${D0}T12:00:00Z`);
    setPetClockForTests(() => now);
  });
  afterAll(async () => {
    setPetClockForTests(null);
    if (tracked.length > 0) {
      await db.delete(schema.dmPets).where(inArray(schema.dmPets.channelId, tracked));
      // dm_streaks has no channel FK: the seed's cleanup doesn't reach it.
      await db.delete(schema.dmStreaks).where(inArray(schema.dmStreaks.channelId, tracked));
    }
    await cleanupAll();
    await closeDb();
  });
  setPetClockForTests(() => now);

  it('Zekk Keeper: the highest level of any current pet, one rung per stage; invites and bot partners count for nothing', async () => {
    const p = await adopted();
    let { by } = await shelfOf(p.a);
    expect([1, 5, 10, 15, 25].map((g) => [by(`pet_keeper_${g}`).value, by(`pet_keeper_${g}`).earned])).toEqual(
      [1, 5, 10, 15, 25].map(() => [0, false]),
    );

    await setRow(p.dm, { level: 10, points: 475 });
    // A second pet of A's, further along, with someone else: MAX, not a sum.
    const q = await adopted({ a: p.a });
    await setRow(q.dm, { level: 12, points: 600 });
    ({ by } = await shelfOf(p.a));
    expect(by('pet_keeper_10')).toMatchObject({ value: 12, earned: true });
    expect(by('pet_keeper_15')).toMatchObject({ value: 12, earned: false, goal: 15 });
    // Each partner sees their own pet's level.
    expect((await shelfOf(p.b)).by('pet_keeper_10')).toMatchObject({ value: 10, earned: true });
    expect((await shelfOf(q.b)).by('pet_keeper_10')).toMatchObject({ value: 12, earned: true });

    // An invite is no pet yet, whatever its row says.
    const r = await pair();
    await invitePet({ channelId: r.dm, inviterId: r.a, otherId: r.b });
    await setRow(r.dm, { level: 25 });
    expect((await shelfOf(r.a)).by('pet_keeper_1')).toMatchObject({ value: 0, earned: false });

    // A pet raised with a bot (a free alt) earns its human nothing.
    const s = await adopted({ botB: true });
    await setRow(s.dm, { level: 25, points: 2125 });
    expect((await shelfOf(s.a)).by('pet_keeper_1')).toMatchObject({ value: 0, earned: false });
  });

  it('Zekk Keeper stays earned when the pet runs away, the partner closes the DM, or the partner deletes their account', async () => {
    // Run away: the sweep DELETEs the row. (Not sweepPets itself: it sweeps
    // every pet in the database, and on the shared test database this file's
    // clock would make other files' pets run away.)
    const p = await adopted();
    await setRow(p.dm, { level: 10, points: 475 });
    for (const u of [p.a, p.b]) await syncAndNotifyAchievements(u);
    await db.delete(schema.dmPets).where(eq(schema.dmPets.channelId, p.dm));
    for (const u of [p.a, p.b]) {
      const { by } = await shelfOf(u);
      expect(by('pet_keeper_10')).toMatchObject({ value: 10, earned: true });
      expect(by('pet_keeper_15').earned).toBe(false);
    }

    // The partner closes the DM (the route drops the pet).
    const q = await adopted();
    await setRow(q.dm, { level: 5, points: 175 });
    await syncAndNotifyAchievements(q.a);
    expect(await dropPet(q.dm)).toBe(true);
    expect((await shelfOf(q.a)).by('pet_keeper_5')).toMatchObject({ value: 5, earned: true });

    // The partner deletes their account.
    const r = await adopted();
    await setRow(r.dm, { level: 1, points: 25 });
    await syncAndNotifyAchievements(r.a);
    await purgeAccount(r.b);
    expect((await db.select().from(schema.dmPets).where(eq(schema.dmPets.channelId, r.dm))).length).toBe(0);
    expect((await shelfOf(r.a)).by('pet_keeper_1')).toMatchObject({ value: 1, earned: true });
  });

  it('a hatch announces pet_keeper_1 to BOTH people at once, while their send throttle is armed', async () => {
    const p = await adopted();
    // Each person's throttled sync has just run (as a send's would): it seeds
    // them and arms the 60 s throttle, so the connections' own catch-all sync
    // is skipped and only the pet's hook can announce the hatch.
    for (const u of [p.a, p.b]) syncAndNotifyAchievementsThrottled(u);
    await waitFor(async () => (await seeded(p.a)) && (await seeded(p.b)));
    const aSent = connect(p.a);
    const bSent = connect(p.b);

    await setRow(p.dm, { points: 20 });
    await msg(p.dm, p.lo);
    expect(await ledger(p.a)).toEqual([]);
    await msg(p.dm, p.hi);
    await waitFor(() => unlocks(aSent).includes('pet_keeper_1') && unlocks(bSent).includes('pet_keeper_1'));
    for (const sent of [aSent, bSent]) {
      expect(unlocks(sent)).toEqual(['pet_keeper_1']);
      expect(sent.find((f) => f.t === 'ACHIEVEMENT_UNLOCK')!.d).toEqual({
        id: 'pet_keeper_1',
        name: 'Zekk Keeper',
        description: 'Helped hatch a Zekk Pet.',
        marker: '🐣',
      });
    }
    expect(await ledger(p.a)).toEqual(['pet_keeper_1']);
    expect(await ledger(p.b)).toEqual(['pet_keeper_1']);
  });

  it('an activity that neither changes the stage nor finishes the day syncs nobody', async () => {
    const p = await adopted();
    await msg(p.dm, p.lo);
    await msg(p.dm, p.hi);
    // Fed (both_hi, +10 points), still an egg, one task of five.
    await new Promise((r) => setTimeout(r, 300));
    expect([await seeded(p.a), await seeded(p.b)]).toEqual([false, false]);
    expect(await ledger(p.a)).toEqual([]);
  });

  it("Perfect Day: the day's last task records it for both people, and it stays after midnight and after the pet is gone", async () => {
    const p = await adopted();
    let { by } = await shelfOf(p.a);
    expect(by('pet_perfect_day')).toMatchObject({ value: 0, earned: false, goal: 1 });
    // Every task but the poke done today.
    await setRow(p.dm, { taskDay: D0, lastFedDay: D0, countA: 10, countB: 10, tasksDone: PET_ALL_TASKS_MASK & ~POKE });
    ({ by } = await shelfOf(p.a));
    expect(by('pet_perfect_day').earned).toBe(false);

    await recordActivity({ channelId: p.dm, authorId: p.hi, kind: 'poke' });
    // Live, for both, and recorded by the pet's own hook (nobody else synced).
    for (const u of [p.a, p.b]) expect((await shelfOf(u)).by('pet_perfect_day')).toMatchObject({ value: 1, earned: true });
    await waitFor(async () => (await ledger(p.a)).includes('pet_perfect_day') && (await ledger(p.b)).includes('pet_perfect_day'));

    // Yesterday's tasks aren't today's: the snapshot is gone, the badge isn't.
    at(`${day(1)}T09:00:00Z`);
    await msg(p.dm, p.lo);
    expect((await db.select().from(schema.dmPets).where(eq(schema.dmPets.channelId, p.dm)))[0]!.tasksDone).toBe(0);
    for (const u of [p.a, p.b]) expect((await shelfOf(u)).by('pet_perfect_day')).toMatchObject({ value: 1, earned: true });
    await dropPet(p.dm);
    expect((await shelfOf(p.b)).by('pet_perfect_day').earned).toBe(true);

    // A day finished on an earlier day is still a perfect day — tasks_done is
    // only ever written with its own task_day — until the next activity
    // resets it; with a bot, never.
    at(`${D0}T12:00:00Z`);
    const q = await adopted();
    await setRow(q.dm, { taskDay: day(-1), lastFedDay: day(-1), tasksDone: PET_ALL_TASKS_MASK });
    expect((await shelfOf(q.a)).by('pet_perfect_day')).toMatchObject({ value: 1, earned: true });
    await setRow(q.dm, { tasksDone: PET_ALL_TASKS_MASK & ~POKE });
    expect((await shelfOf(q.a)).by('pet_perfect_day').earned).toBe(false);
    const r = await adopted({ botB: true });
    await setRow(r.dm, { taskDay: D0, lastFedDay: D0, tasksDone: PET_ALL_TASKS_MASK });
    expect((await shelfOf(r.a)).by('pet_perfect_day')).toMatchObject({ value: 0, earned: false });
  });

  it("Perfect Day: a day's last task sent just before midnight is recorded by the sync that runs just after it", async () => {
    // The 10th message each lands at 23:59:59.9 and counts for that day (the
    // send passes its createdAt), but the pet's hook — and its sync — only run
    // once the clock reads the next day.
    const p = await adopted();
    const CHATTY = PET_TASKS.find((t) => t.key === 'chatty')!.bit;
    const [loCount, hiCount] = [10, 9];
    await setRow(p.dm, {
      taskDay: D0,
      lastFedDay: D0,
      countA: loCount,
      countB: hiCount,
      tasksDone: PET_ALL_TASKS_MASK & ~CHATTY,
    });
    at(`${day(1)}T00:00:00.200Z`);
    await recordActivity({
      channelId: p.dm,
      authorId: p.hi,
      kind: 'message',
      at: new Date(`${D0}T23:59:59.900Z`),
    });
    const [row] = await db.select().from(schema.dmPets).where(eq(schema.dmPets.channelId, p.dm));
    expect(row).toMatchObject({ taskDay: D0, tasksDone: PET_ALL_TASKS_MASK });
    await waitFor(
      async () => (await ledger(p.a)).includes('pet_perfect_day') && (await ledger(p.b)).includes('pet_perfect_day'),
    );
  });

  it("a hatch with a bot partner still syncs both people, and records nothing for the human", async () => {
    // The hook doesn't ask who is a bot; the shelf does.
    const p = await adopted({ botB: true });
    await setRow(p.dm, { points: 20 });
    await msg(p.dm, p.lo);
    await msg(p.dm, p.hi);
    await waitFor(async () => (await seeded(p.a)) && (await seeded(p.b)));
    expect(await ledger(p.a)).toEqual([]);
    expect((await shelfOf(p.a)).by('pet_keeper_1')).toMatchObject({ value: 0, earned: false });
  });
});
