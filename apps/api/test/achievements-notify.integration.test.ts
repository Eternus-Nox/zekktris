import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { ACHIEVEMENT_CATALOG, syncAndNotifyAchievements } from '../src/services/achievements';
import { nextSnowflake } from '../src/snowflake';
import { createUser, createDmChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

// What an unlock announces, captured instead of sent: the in-app toast (one
// ACHIEVEMENT_UNLOCK per call) and the push.
const unlocks: string[] = [];
const pushes: Array<{ title: string; body: string; tag?: string; data?: Record<string, unknown> }> = [];
vi.mock('../src/gateway/dispatch', async (orig) => ({
  ...(await orig<typeof import('../src/gateway/dispatch')>()),
  achievementUnlock: vi.fn((args: { id: string }) => {
    unlocks.push(args.id);
  }),
}));
vi.mock('../src/services/push', async (orig) => ({
  ...(await orig<typeof import('../src/services/push')>()),
  sendToUser: vi.fn(async (_userId: bigint, payload: never) => {
    pushes.push(payload);
    return 1;
  }),
}));

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping achievement announcement tests — no database reachable');
}

// When a sync announces, and how loudly: the silent backfill that a release
// adding families over PAST data re-arms (ACHIEVEMENT_CATALOG, migration
// 0137), and one toast per family / one push per sync when several unlock at
// once.

async function ledger(userId: bigint): Promise<string[]> {
  const rows = await db
    .select({ id: schema.userAchievements.achievementId })
    .from(schema.userAchievements)
    .where(eq(schema.userAchievements.userId, userId));
  return rows.map((r) => r.id).sort();
}
async function account(userId: bigint, set: { achievementsSeeded: boolean; achievementsCatalog: number }) {
  await db.update(schema.users).set(set).where(eq(schema.users.id, userId));
}
const catalogOf = async (userId: bigint) =>
  (
    await db
      .select({ c: schema.users.achievementsCatalog })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
  )[0]!.c;

/** Posts on `n` different UTC days, every one since expired by a disappearing
 *  timer: Regular counts them, Chatterbox (live rows only) doesn't, so no
 *  other family moves with them. */
async function daysOfPosts(channelId: bigint, authorId: bigint, n: number) {
  for (let i = 0; i < n; i++) {
    await createMessage(channelId, {
      authorId,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i, 12)),
      deletedAt: new Date(),
    });
  }
}
async function timerTurnedOn(channelId: bigint, userId: bigint) {
  await createMessage(channelId, {
    authorId: userId,
    type: 'system_disappearing',
    metadata: { kind: 'disappearing_timer', timerSeconds: 3600, initiatorId: userId.toString() },
  });
}

describe.runIf(dbReady)('achievement unlock announcements (integration)', () => {
  beforeEach(() => {
    unlocks.length = 0;
    pushes.length = 0;
  });
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it("an account from before this catalog gets ONE silent backfill of the new families' backlog; the unlock after it is announced", async () => {
    const u = await createUser();
    const dm = await createDmChannel([u, await createUser()]);
    // Seeded long ago, at catalog 0 — where migration 0137 leaves every
    // existing account — with months of history the new families count.
    await account(u, { achievementsSeeded: true, achievementsCatalog: 0 });
    await daysOfPosts(dm, u, 30);
    await timerTurnedOn(dm, u);

    await syncAndNotifyAchievements(u);
    expect(await ledger(u)).toEqual(expect.arrayContaining(['regular_30', 'vanishing_act']));
    expect(unlocks).toEqual([]);
    expect(pushes).toEqual([]);
    expect(await catalogOf(u)).toBe(ACHIEVEMENT_CATALOG);

    // Once only: the next unlock is news again.
    await db.insert(schema.webauthnCredentials).values({
      id: nextSnowflake(),
      userId: u,
      credentialId: `cred-${u}`,
      publicKey: 'pk',
    });
    await syncAndNotifyAchievements(u);
    expect(unlocks).toEqual(['locked_in']);
    expect(pushes).toEqual([
      expect.objectContaining({
        title: 'Achievement unlocked 🏆',
        body: 'Locked In — Added a passkey to your account.',
        tag: 'achv-locked_in',
        data: { kind: 'achievement', achievementId: 'locked_in' },
      }),
    ]);
  });

  it('an account never synced gets its first-sync backfill, at the current catalog, as before', async () => {
    const u = await createUser();
    const dm = await createDmChannel([u, await createUser()]);
    await timerTurnedOn(dm, u);
    await syncAndNotifyAchievements(u);
    expect(await ledger(u)).toContain('vanishing_act');
    expect([unlocks, pushes]).toEqual([[], []]);
    expect(await catalogOf(u)).toBe(ACHIEVEMENT_CATALOG);
  });

  it('a sync that crosses several rungs announces each family once, at its highest new rung, in one push', async () => {
    const u = await createUser();
    const dm = await createDmChannel([u, await createUser()]);
    // As signup leaves an account (seeded, at this catalog); then a hundred
    // days of posts and a timer turned on reach its next sync together.
    await account(u, { achievementsSeeded: true, achievementsCatalog: ACHIEVEMENT_CATALOG });
    await daysOfPosts(dm, u, 100);
    await timerTurnedOn(dm, u);

    await syncAndNotifyAchievements(u);
    // Every rung is recorded...
    expect(await ledger(u)).toEqual(expect.arrayContaining(['regular_30', 'regular_100', 'vanishing_act']));
    // ...one toast per family, its highest rung, in shelf order...
    expect(unlocks).toEqual(['regular_100', 'vanishing_act']);
    // ...and one push naming them all.
    expect(pushes).toEqual([
      expect.objectContaining({
        title: '2 achievements unlocked 🏆',
        body: 'Regular, Now You See Me',
        tag: 'achv-unlocks',
        data: { kind: 'achievement', achievementId: 'regular_100' },
      }),
    ]);

    // Nothing new, nothing said.
    await syncAndNotifyAchievements(u);
    expect(unlocks).toHaveLength(2);
    expect(pushes).toHaveLength(1);
  });
});
