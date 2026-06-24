import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { markGuildRead } from '../src/services/readStates';
import { nextSnowflake } from '../src/snowflake';
import { probeDb, closeDb } from './db-available';

/**
 * markGuildRead service (integration — no gateway).
 * --------------------------------------------------
 * Backs the rail's per-server "Mark as Read". For the viewable channels the
 * route passes in, it should advance the read marker to each channel's latest
 * message and zero its mention count — without rolling a marker backward and
 * without touching channels that have no messages.
 */

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping guild-mark-read tests — no database reachable');
}

describe.runIf(dbReady)('markGuildRead (integration)', () => {
  const userId = nextSnowflake();
  // chWithMsgs: has a latest message. chHigher: latest message, but the user
  // already read PAST it. chEmpty: no messages (last_message_id NULL).
  const chWithMsgs = nextSnowflake();
  const chHigher = nextSnowflake();
  const chEmpty = nextSnowflake();
  const latestWith = nextSnowflake();
  const latestHigher = nextSnowflake();
  // A read marker already ahead of chHigher's latest (user read newer-then-
  // deleted, or acked live) — markGuildRead must NOT roll it back.
  const alreadyRead = nextSnowflake();
  const allIds = [chWithMsgs, chHigher, chEmpty];

  beforeAll(async () => {
    await db.insert(schema.users).values({
      id: userId,
      email: `markread-${userId}@test.local`,
      username: `markread_${userId}`,
      displayName: 'markread',
      passwordHash: 'scrypt-v1$00$00',
    });
    await db.insert(schema.channels).values([
      { id: chWithMsgs, type: 'guild_text', lastMessageId: latestWith },
      { id: chHigher, type: 'guild_text', lastMessageId: latestHigher },
      { id: chEmpty, type: 'guild_text', lastMessageId: null },
    ]);
    // Pre-seed chHigher's read marker ABOVE its latest message.
    await db.insert(schema.readStates).values({
      userId,
      channelId: chHigher,
      lastMessageId: alreadyRead,
      mentionCount: 3,
    });
  });

  afterAll(async () => {
    await db.delete(schema.readStates).where(eq(schema.readStates.userId, userId));
    await db.delete(schema.channels).where(inArray(schema.channels.id, allIds));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await closeDb();
  });

  it('advances unread channels to their latest message and clears mentions', async () => {
    const updated = await markGuildRead(userId, allIds);
    // Only the two channels WITH messages are touched (the empty one is skipped).
    const byId = new Map(updated.map((r) => [r.channelId.toString(), r]));
    expect(updated).toHaveLength(2);
    expect(byId.get(chWithMsgs.toString())?.lastMessageId).toBe(latestWith);
    expect(byId.get(chWithMsgs.toString())?.mentionCount).toBe(0);

    const row = await db
      .select()
      .from(schema.readStates)
      .where(and(eq(schema.readStates.userId, userId), eq(schema.readStates.channelId, chWithMsgs)));
    expect(row[0]?.lastMessageId).toBe(latestWith);
    expect(row[0]?.mentionCount).toBe(0);

    // No read row was seeded for the message-less channel.
    const emptyRow = await db
      .select()
      .from(schema.readStates)
      .where(and(eq(schema.readStates.userId, userId), eq(schema.readStates.channelId, chEmpty)));
    expect(emptyRow).toHaveLength(0);
  });

  it('never rolls a marker backward (GREATEST guard) but still clears mentions', async () => {
    const updated = await markGuildRead(userId, allIds);
    const higher = updated.find((r) => r.channelId === chHigher);
    // Marker stays at the already-read (higher) id, not chHigher's older latest.
    expect(higher?.lastMessageId).toBe(alreadyRead);
    // The mention badge is cleared regardless.
    expect(higher?.mentionCount).toBe(0);
  });

  it('returns nothing for an empty viewable set (e.g. a non-member)', async () => {
    expect(await markGuildRead(userId, [])).toEqual([]);
  });
});
