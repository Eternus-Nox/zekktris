import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import {
  listDiscoverable,
  refreshDiscoverableMemberCounts,
  refreshGuildMemberCount,
} from '../src/services/discovery';
import { createUser, createGuild, addMember, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping discovery member-count tests — no database reachable');
}

describe.runIf(dbReady)('discovery member_count denormalization (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  async function makeDiscoverable(guildId: bigint, name: string): Promise<void> {
    await db
      .update(schema.guilds)
      .set({ discoverable: true, name })
      .where(eq(schema.guilds.id, guildId));
  }
  async function storedCount(guildId: bigint): Promise<number> {
    const [g] = await db
      .select({ n: schema.guilds.memberCount })
      .from(schema.guilds)
      .where(eq(schema.guilds.id, guildId))
      .limit(1);
    return g?.n ?? -1;
  }

  it('the refresh sweep counts only non-banned, non-deleted members', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    await makeDiscoverable(g, `zzdisco-${owner}-X`);
    const active1 = await createUser();
    const active2 = await createUser();
    const banned = await createUser();
    const deleted = await createUser();
    for (const u of [owner, active1, active2, banned, deleted]) await addMember(g, u);
    await db.update(schema.users).set({ bannedAt: new Date() }).where(eq(schema.users.id, banned));
    await db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, deleted));

    await refreshDiscoverableMemberCounts();
    expect(await storedCount(g)).toBe(3); // owner + active1 + active2
  });

  it('refreshGuildMemberCount updates a single guild immediately', async () => {
    const owner = await createUser();
    const g = await createGuild(owner);
    await makeDiscoverable(g, `zzdisco-${owner}-S`);
    await addMember(g, owner);
    await addMember(g, await createUser());
    await refreshGuildMemberCount(g);
    expect(await storedCount(g)).toBe(2);
  });

  it('listDiscoverable returns the stored count and orders by it descending', async () => {
    const tag = `zzrank${(await createUser()).toString()}`;

    const ownerA = await createUser();
    const gA = await createGuild(ownerA);
    await makeDiscoverable(gA, `${tag}-A`);
    await addMember(gA, ownerA); // 1 member

    const ownerB = await createUser();
    const gB = await createGuild(ownerB);
    await makeDiscoverable(gB, `${tag}-B`);
    await addMember(gB, ownerB);
    for (let i = 0; i < 4; i++) await addMember(gB, await createUser()); // 5 members

    await refreshDiscoverableMemberCounts();

    // Filter to just these two via the unique tag so other tests' discoverable
    // guilds can't perturb the assertion.
    const { guilds } = await listDiscoverable({ query: tag });
    const ids = guilds.map((x) => x.id);
    const ia = ids.indexOf(gA);
    const ib = ids.indexOf(gB);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThanOrEqual(0);
    expect(ib).toBeLessThan(ia); // gB (5) ranks before gA (1)
    expect(guilds.find((x) => x.id === gA)?.memberCount).toBe(1);
    expect(guilds.find((x) => x.id === gB)?.memberCount).toBe(5);
  });
});
