/**
 * DELETE /channels/:id/voice only ends the caller's call in THAT channel.
 *
 * A user's voice row is per user, not per device. An unscoped leave from a
 * device whose call had already ended or moved deleted the row the user's
 * other device had just joined, ending that call.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createApp } from '../src/server';
import { joinVoice, leaveVoice } from '../src/services/voice';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, createDmChannel, addRelationship, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping voice-leave-scope tests — no database reachable');
}

const app = createApp();

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return `Bearer ${await signAccessToken({ userId, sessionId: session.id })}`;
}

async function voiceChannelOf(userId: bigint): Promise<bigint | null> {
  const [row] = await db
    .select({ channelId: schema.voiceStates.channelId })
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.userId, userId))
    .limit(1);
  return row?.channelId ?? null;
}

describe.runIf(dbReady)('voice leave is scoped to its channel', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it("a leave for a channel the user isn't in leaves their call elsewhere alone", async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    for (const [x, y] of [
      [a, b],
      [b, a],
      [a, c],
      [c, a],
    ] as const) {
      await addRelationship(x, y, 'friend');
    }
    const dmAB = await createDmChannel([a, b]);
    const dmAC = await createDmChannel([a, c]);
    const auth = await tokenFor(a);

    // A's other device is now in the call with C; this device still thinks
    // it's in the call with B and hangs up.
    await joinVoice(a, dmAC);
    const stale = await app.request(`/api/v1/channels/${dmAB}/voice`, {
      method: 'DELETE',
      headers: { authorization: auth },
    });
    expect(stale.status).toBe(200);
    expect(await voiceChannelOf(a)).toBe(dmAC);

    // Hanging up the call it IS in still works.
    const real = await app.request(`/api/v1/channels/${dmAC}/voice`, {
      method: 'DELETE',
      headers: { authorization: auth },
    });
    expect(real.status).toBe(200);
    expect(await voiceChannelOf(a)).toBeNull();
    await leaveVoice(a);
  });
});
