import { describe, it, expect, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { joinVoice, leaveVoice } from '../src/services/voice';
import * as messages from '../src/services/messages';
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

  it('a failed call-record write still returns priorState, so the route echoes the leave', async () => {
    const a = await createUser();
    const b = await createUser();
    await addRelationship(a, b, 'friend');
    await addRelationship(b, a, 'friend');
    const dm = await createDmChannel([a, b]);

    await joinVoice(a, dm); // A rings B: the call columns are stamped
    expect((await callCols(dm)).started).not.toBeNull();

    // The last leaver's system_call write fails AFTER the voice row delete has
    // committed. That throw used to escape leaveVoice and 500 the DELETE before
    // the route sent the VOICE_STATE_UPDATE echo, so the hang-up never landed
    // in the UI and every retry was a no-op.
    const write = vi
      .spyOn(messages, 'createSystemMessage')
      .mockRejectedValueOnce(new Error('simulated call-record write failure'));
    try {
      // The DELETE /channels/:id/voice route's own options.
      const result = await leaveVoice(a, { expectedChannelId: dm, matchMovedFrom: true });
      expect(write).toHaveBeenCalledTimes(1);
      // The route dispatches the echo off priorState.
      expect(result.priorState?.userId).toBe(a);
      expect(result.priorState?.channelId).toBe(dm);
      expect(result.systemCallMessage).toBeNull();
      expect(result.systemCallChannelId).toBeNull();
    } finally {
      write.mockRestore();
    }

    // The leave itself stands: A's voice row is gone.
    const [row] = await db
      .select({ userId: schema.voiceStates.userId })
      .from(schema.voiceStates)
      .where(eq(schema.voiceStates.userId, a))
      .limit(1);
    expect(row).toBeUndefined();
    // The call columns were cleared before the write, so the next ring in this
    // DM starts clean: the record is lost, never stranded or duplicated.
    const cols = await callCols(dm);
    expect(cols.started).toBeNull();
    expect(cols.answered).toBeNull();
    expect(cols.initiator).toBeNull();
  });
});
