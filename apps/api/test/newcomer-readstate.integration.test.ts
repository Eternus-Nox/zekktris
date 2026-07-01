import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { seedGuildReadOnJoin } from '../src/services/readStates';
import { createUser, createGuild, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping newcomer-readstate tests — no database reachable');
}

async function readState(userId: bigint, channelId: bigint) {
  const [row] = await db
    .select()
    .from(schema.readStates)
    .where(and(eq(schema.readStates.userId, userId), eq(schema.readStates.channelId, channelId)))
    .limit(1);
  return row ?? null;
}

/** Mirror what the real message-create flow does (the test createMessage helper
 *  inserts a bare row without bumping the denormalized channel watermark). */
async function setChannelWatermark(channelId: bigint, messageId: bigint) {
  await db
    .update(schema.channels)
    .set({ lastMessageId: messageId })
    .where(eq(schema.channels.id, channelId));
}

describe.runIf(dbReady)('seedGuildReadOnJoin (newcomer clean slate)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('marks channels with history read up to their latest; skips empty channels', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner);
    const busy = await createChannel(guildId);
    const empty = await createChannel(guildId);
    const msgId = await createMessage(busy, { authorId: owner });
    await setChannelWatermark(busy, msgId);

    const newcomer = await createUser();
    await seedGuildReadOnJoin(db, guildId, newcomer);

    // Busy channel → read up to its latest, no unread.
    const busyRs = await readState(newcomer, busy);
    expect(busyRs).not.toBeNull();
    expect(busyRs!.lastMessageId).toBe(msgId);
    expect(busyRs!.mentionCount).toBe(0);

    // Empty channel (no last_message_id) → no read-state seeded.
    expect(await readState(newcomer, empty)).toBeNull();
  });

  it('is idempotent — a re-join keeps the existing marker (no clobber)', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner);
    const ch = await createChannel(guildId);
    const older = await createMessage(ch, { authorId: owner });
    const newer = await createMessage(ch, { authorId: owner });
    await setChannelWatermark(ch, newer);

    const user = await createUser();
    // Pre-existing read-state at the OLDER message (as if they'd read up to there
    // before leaving), plus an unread mention.
    await db.insert(schema.readStates).values({
      userId: user,
      channelId: ch,
      lastMessageId: older,
      mentionCount: 3,
    });

    await seedGuildReadOnJoin(db, guildId, user);

    // ON CONFLICT DO NOTHING → their watermark + mention count are preserved,
    // so messages since they left stay unread (they catch up, not wiped).
    const rs = await readState(user, ch);
    expect(rs!.lastMessageId).toBe(older);
    expect(rs!.mentionCount).toBe(3);
  });
});
