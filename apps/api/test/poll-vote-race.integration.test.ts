import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { vote } from '../src/services/polls';
import { createUser, createGuild, addMember, createChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping poll-vote-race tests — no database reachable');
}

async function makeSingleChoicePoll(channelId: bigint, authorId: bigint) {
  const messageId = await createMessage(channelId, { authorId, content: 'poll' });
  const pollId = nextSnowflake();
  await db.insert(schema.polls).values({
    id: pollId,
    messageId,
    question: 'pick one',
    multipleChoice: false,
  });
  const optA = nextSnowflake();
  const optB = nextSnowflake();
  await db.insert(schema.pollOptions).values([
    { id: optA, pollId, text: 'A', position: 0 },
    { id: optB, pollId, text: 'B', position: 1 },
  ]);
  return { pollId, optA, optB };
}

describe.runIf(dbReady)('single-choice poll vote race', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('two concurrent votes for different options resolve to exactly ONE vote', async () => {
    const owner = await createUser();
    const voter = await createUser();
    // @everyone gets VIEW + SEND so the voter passes the permission gate.
    const guild = await createGuild(owner, P.VIEW_CHANNEL | P.SEND_MESSAGES);
    await addMember(guild, owner);
    await addMember(guild, voter);
    const channel = await createChannel(guild);
    const { pollId, optA, optB } = await makeSingleChoicePoll(channel, owner);

    // Fire both near-simultaneously. Without the (poll,user) advisory lock the
    // clear-then-insert races and BOTH persist; with it, the second waits and
    // its DELETE sees the first's committed row.
    const results = await Promise.allSettled([
      vote({ pollId, optionId: optA, userId: voter }),
      vote({ pollId, optionId: optB, userId: voter }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const votes = await db
      .select({ optionId: schema.pollVotes.optionId })
      .from(schema.pollVotes)
      .where(and(eq(schema.pollVotes.pollId, pollId), eq(schema.pollVotes.userId, voter)));
    expect(votes).toHaveLength(1);
    expect([optA, optB]).toContain(votes[0]!.optionId);
  });
});
