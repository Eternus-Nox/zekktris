import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { createUser, createGuild, createChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';
import { claimDue, completeScheduled, failScheduled } from '../src/services/scheduledMessages';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping scheduled-claim tests — no database reachable');
}

let ownerId: bigint;
let channelId: bigint;

async function seedDueRow(): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.scheduledMessages).values({
    id,
    authorId: ownerId,
    channelId,
    content: 'hi',
    scheduledFor: new Date(Date.now() - 60 * 60 * 1000), // an hour ago → due
  });
  return id;
}

async function rowById(id: bigint) {
  const [r] = await db
    .select()
    .from(schema.scheduledMessages)
    .where(eq(schema.scheduledMessages.id, id));
  return r;
}

describe.runIf(dbReady)('scheduled-message claim (no double-send)', () => {
  beforeAll(async () => {
    ownerId = await createUser();
    const g = await createGuild(ownerId, 0n);
    channelId = await createChannel(g);
  });
  beforeEach(async () => {
    await db.delete(schema.scheduledMessages); // isolate each test
  });
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('two concurrent claims never grab the same row — exactly one wins', async () => {
    const id = await seedDueRow();
    const [a, b] = await Promise.all([claimDue(), claimDue()]);
    const aHas = a.some((r) => r.id === id);
    const bHas = b.some((r) => r.id === id);
    expect(aHas !== bHas).toBe(true); // XOR: claimed by exactly one
  });

  it('a subsequent tick skips an already-claimed (not-yet-completed) row', async () => {
    const id = await seedDueRow();
    const first = await claimDue();
    expect(first.some((r) => r.id === id)).toBe(true);
    // The row still exists (not completed yet) but is claimed → next poll skips it.
    const second = await claimDue();
    expect(second.some((r) => r.id === id)).toBe(false);
  });

  it('failure releases the claim + bumps attempts → reclaimable until MAX', async () => {
    const id = await seedDueRow();
    await claimDue();
    await failScheduled(id, 'boom');
    const row = await rowById(id);
    expect(row?.attempts).toBe(1);
    expect(row?.claimedAt).toBeNull();
    expect(row?.lastError).toBe('boom');
    // Released → a later poll re-claims it (attempts 1 < 3).
    const again = await claimDue();
    expect(again.some((r) => r.id === id)).toBe(true);
  });

  it('a row at MAX attempts is no longer claimed (frozen for the user to inspect)', async () => {
    const id = await seedDueRow();
    await db
      .update(schema.scheduledMessages)
      .set({ attempts: 3, claimedAt: null })
      .where(eq(schema.scheduledMessages.id, id));
    const claimed = await claimDue();
    expect(claimed.some((r) => r.id === id)).toBe(false);
    expect(await rowById(id)).toBeDefined(); // still present, just frozen
  });

  it('completion deletes the row so it is never sent again', async () => {
    const id = await seedDueRow();
    await claimDue();
    await completeScheduled(id);
    expect(await rowById(id)).toBeUndefined();
    const after = await claimDue();
    expect(after.some((r) => r.id === id)).toBe(false);
  });
});
