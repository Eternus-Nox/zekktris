import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { createGuildApproval, approveRequest } from '../src/services/supervision';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping family-approval tests — no database reachable');
}

describe.runIf(dbReady)('guild-join approval keyed on stable guild id', () => {
  let parentId: bigint;
  let childId: bigint;
  let ownerId: bigint;
  let guildId: bigint;
  let channelId: bigint;

  async function mkUser(tag: string): Promise<bigint> {
    const id = nextSnowflake();
    await db.insert(schema.users).values({
      id,
      email: `${tag}-${id}@test.local`,
      username: `${tag}_${id}`,
      displayName: tag,
      passwordHash: 'scrypt-v1$00$00',
    });
    return id;
  }

  beforeAll(async () => {
    parentId = await mkUser('parent');
    childId = await mkUser('child');
    ownerId = await mkUser('owner');
    guildId = nextSnowflake();
    channelId = nextSnowflake();
    await db.insert(schema.guilds).values({ id: guildId, name: 'Approval Guild', ownerId });
    await db.insert(schema.channels).values({ id: channelId, type: 'guild_text', guildId });
    // Active supervision link so assertParentOf passes.
    await db.insert(schema.parentChildLinks).values({
      parentId,
      childId,
      status: 'active',
      acceptedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(schema.guilds).where(eq(schema.guilds.id, guildId));
    for (const id of [parentId, childId, ownerId]) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await closeDb();
  });

  async function seedInvite(): Promise<string> {
    const code = `appr-${nextSnowflake()}`;
    await db.insert(schema.invites).values({ code, guildId, channelId, inviterId: ownerId });
    return code;
  }

  async function isMember(): Promise<boolean> {
    const [m] = await db
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, childId)))
      .limit(1);
    return !!m;
  }

  it('approves a join even after the invite code is REVOKED (keyed on guild id, not code)', async () => {
    const code = await seedInvite();
    const reqId = await createGuildApproval(childId, code, guildId);

    // The invite is revoked/regenerated between request and approval.
    await db.delete(schema.invites).where(eq(schema.invites.code, code));

    expect(await isMember()).toBe(false);
    await approveRequest(parentId, BigInt(reqId)); // must NOT throw on the gone code
    expect(await isMember()).toBe(true);

    const [reqRow] = await db
      .select({ status: schema.childRequests.status })
      .from(schema.childRequests)
      .where(eq(schema.childRequests.id, BigInt(reqId)))
      .limit(1);
    expect(reqRow?.status).toBe('approved');

    // Idempotent: a second approve of an already-member doesn't blow up.
    // (Re-mark pending to exercise the join path again.)
    await db
      .update(schema.childRequests)
      .set({ status: 'pending', resolvedAt: null })
      .where(eq(schema.childRequests.id, BigInt(reqId)));
    await expect(approveRequest(parentId, BigInt(reqId))).resolves.not.toThrow();

    // Clean up the membership so the next test starts fresh.
    await db
      .delete(schema.guildMembers)
      .where(and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, childId)));
  });

  it('legacy fallback: a request with no resolved guild id still joins via the invite code', async () => {
    const code = await seedInvite();
    // guildId null simulates a row created before the code resolved (or a bad
    // code at request time that later became valid).
    const reqId = await createGuildApproval(childId, code, null);

    expect(await isMember()).toBe(false);
    await approveRequest(parentId, BigInt(reqId));
    expect(await isMember()).toBe(true);

    await db
      .delete(schema.guildMembers)
      .where(and(eq(schema.guildMembers.guildId, guildId), eq(schema.guildMembers.userId, childId)));
  });
});
