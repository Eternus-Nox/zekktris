import { describe, it, expect, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { env } from '../src/env';
import { sweepInactiveAccounts } from '../src/services/inactivitySweep';
import { createMapping } from '../src/services/reactionRoles';
import { createBot, deleteBot } from '../src/services/bots';
import { createUser, createGuild, createRole, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping inactivity-sweep tests — no database reachable');
}

// The sweep is instance-wide. Run it with a TTL far beyond anything another
// test file backdates (achievements uses ~400 days), and backdate only this
// file's users past it, so parallel test files never lose a user to it.
const TTL_DAYS = 20 * 365;
const ANCIENT = new Date(Date.now() - (TTL_DAYS + 30) * 24 * 3600 * 1000);
const BLOCKER_TABLE = `zk_test_sweep_blocker_${process.pid}`;

async function backdate(userId: bigint): Promise<void> {
  await db.update(schema.users).set({ createdAt: ANCIENT }).where(eq(schema.users.id, userId));
}
async function exists(userId: bigint): Promise<boolean> {
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
  return rows.length === 1;
}

describe.runIf(dbReady)('inactivity sweep', () => {
  afterAll(async () => {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${BLOCKER_TABLE}`));
    await cleanupAll();
    await closeDb();
  });

  async function reactionRoleBy(createdBy: bigint) {
    const owner = await createUser();
    const guildId = await createGuild(owner, 0n);
    const channelId = await createChannel(guildId);
    const messageId = await createMessage(channelId);
    const roleId = await createRole(guildId, 0n, 1);
    await createMapping({ messageId, emoji: '✅', guildId, channelId, roleId, createdBy });
    return messageId;
  }

  it('deletes a reaction-role creator (mapping kept, creator nulled), skips one undeletable user, keeps bots', async () => {
    const creator = await createUser();
    const plain = await createUser();
    const stuck = await createUser();
    const botOwner = await createUser();
    const { bot } = await createBot({ ownerId: botOwner, username: `sw_${botOwner}`, displayName: 'SweepBot' });
    const messageId = await reactionRoleBy(creator);
    for (const u of [creator, plain, stuck, bot.id]) await backdate(u);

    // A row the sweep can't delete: referenced by a NO ACTION foreign key.
    // It lands in the same chunk as the others and must not take them down.
    await db.execute(
      sql.raw(`CREATE TABLE ${BLOCKER_TABLE} (user_id bigint REFERENCES users(id))`),
    );
    await db.execute(sql.raw(`INSERT INTO ${BLOCKER_TABLE} VALUES (${stuck})`));

    const prevTtl = env.INACTIVITY_TTL_DAYS;
    env.INACTIVITY_TTL_DAYS = TTL_DAYS;
    try {
      const result = await sweepInactiveAccounts();
      expect(result.deleted).toBeGreaterThanOrEqual(2);
    } finally {
      env.INACTIVITY_TTL_DAYS = prevTtl;
    }

    expect(await exists(creator)).toBe(false);
    expect(await exists(plain)).toBe(false);
    expect(await exists(stuck)).toBe(true);
    // Bots never have sessions; they must not age out on createdAt.
    expect(await exists(bot.id)).toBe(true);

    const [mapping] = await db
      .select()
      .from(schema.reactionRoles)
      .where(eq(schema.reactionRoles.messageId, messageId));
    expect(mapping).toBeDefined();
    expect(mapping!.createdBy).toBeNull();
  });

  it('deleteBot succeeds for a bot that created a reaction role', async () => {
    const owner = await createUser();
    const { bot } = await createBot({ ownerId: owner, username: `rb_${owner}`, displayName: 'RoleBot' });
    const messageId = await reactionRoleBy(bot.id);
    await deleteBot(bot.id, owner);
    expect(await exists(bot.id)).toBe(false);
    const [mapping] = await db
      .select()
      .from(schema.reactionRoles)
      .where(eq(schema.reactionRoles.messageId, messageId));
    expect(mapping!.createdBy).toBeNull();
  });
});
