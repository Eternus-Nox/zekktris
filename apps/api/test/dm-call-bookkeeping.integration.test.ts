import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { joinVoice, leaveVoice } from '../src/services/voice';
import { createUser, createDmChannel, addRelationship, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping dm-call-bookkeeping tests — no database reachable');
}

async function callCols(channelId: bigint) {
  const [c] = await db
    .select({
      started: schema.channels.dmActiveCallStartedAt,
      answered: schema.channels.dmActiveCallAnsweredAt,
      initiator: schema.channels.dmActiveCallInitiatorId,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  return c!;
}

describe.runIf(dbReady)('1:1 DM call bookkeeping', () => {
  afterAll(async () => {
    // Remove voice_states we created (not tracked by seed's cleanupAll).
    await cleanupAll();
    await closeDb();
  });

  it('ringing then MOVING to another DM finalizes the prior call (no stranded columns)', async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    // canReachByDmOrCall needs reachability — make them mutual friends.
    await addRelationship(a, b, 'friend');
    await addRelationship(b, a, 'friend');
    await addRelationship(a, c, 'friend');
    await addRelationship(c, a, 'friend');
    const dmAB = await createDmChannel([a, b]);
    const dmAC = await createDmChannel([a, c]);

    // A rings B in DM-AB.
    await joinVoice(a, dmAB);
    let ab = await callCols(dmAB);
    expect(ab.started).not.toBeNull();
    expect(ab.initiator).toBe(a);
    expect(ab.answered).toBeNull(); // B hasn't joined

    // A navigates into a call in DM-AC WITHOUT hanging up DM-AB first.
    const moveResult = await joinVoice(a, dmAC);
    // The prior DM's call is finalized (missed — B never joined) and returned
    // so the route can broadcast the system_call record.
    expect(moveResult.priorCallSystemMessage).not.toBeNull();
    expect(moveResult.priorCallSystemChannelId).toBe(dmAB);

    // DM-AB's columns are cleared — the bug stranded them, which then
    // auto-classified the NEXT call there as 'answered'.
    ab = await callCols(dmAB);
    expect(ab.started).toBeNull();
    expect(ab.answered).toBeNull();
    expect(ab.initiator).toBeNull();

    // DM-AC now has the fresh ring.
    const ac = await callCols(dmAC);
    expect(ac.started).not.toBeNull();
    expect(ac.initiator).toBe(a);

    // A subsequent ring in DM-AB starts clean (not auto-answered).
    await leaveVoice(a); // leave DM-AC
    await joinVoice(a, dmAB);
    ab = await callCols(dmAB);
    expect(ab.started).not.toBeNull();
    expect(ab.answered).toBeNull(); // clean start, NOT stranded-answered
    await leaveVoice(a);
  });

  it('caller then callee join → answered; last leaver logs the duration record', async () => {
    const a = await createUser();
    const b = await createUser();
    await addRelationship(a, b, 'friend');
    await addRelationship(b, a, 'friend');
    const dm = await createDmChannel([a, b]);

    await joinVoice(a, dm); // caller rings
    await joinVoice(b, dm); // callee answers
    const answeredCols = await callCols(dm);
    expect(answeredCols.answered).not.toBeNull();
    expect(answeredCols.initiator).toBe(a);

    await leaveVoice(b); // one leaves — call continues for A, no record yet
    expect((await leaveVoice(a)).systemCallMessage).not.toBeNull(); // last leaver logs it
    const cleared = await callCols(dm);
    expect(cleared.started).toBeNull();
    expect(cleared.answered).toBeNull();
  });
});
