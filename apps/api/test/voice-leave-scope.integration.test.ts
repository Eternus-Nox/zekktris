/**
 * DELETE /channels/:id/voice only ends the caller's call in THAT channel.
 *
 * A user's voice row is per user, not per device. An unscoped leave from a
 * device whose call had already ended or moved deleted the row the user's
 * other device had just joined, ending that call.
 *
 * A moderator move or the AFK sweep repoints the row server-side, though, and
 * a client that doesn't follow the move still hangs up naming the channel it
 * was taken out of. That hang-up must still end the call — scoped strictly,
 * it matched nothing and stranded the user as a ghost in the new channel.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { createApp } from '../src/server';
import {
  joinVoice,
  leaveVoice,
  moveVoiceMember,
  setMuteFlags,
  sweepAfkMutedMembers,
} from '../src/services/voice';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { nextSnowflake } from '../src/snowflake';
import {
  createUser,
  createGuild,
  addMember,
  createDmChannel,
  addRelationship,
  cleanupAll,
} from './seed';
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

async function voiceChannel(guildId: bigint): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.channels).values({ id, type: 'guild_voice', guildId, name: 'voice' });
  return id;
}

async function hangUp(userId: bigint, channelId: bigint): Promise<void> {
  const res = await app.request(`/api/v1/channels/${channelId}/voice`, {
    method: 'DELETE',
    headers: { authorization: await tokenFor(userId) },
  });
  expect(res.status).toBe(200);
}

/** A guild with three voice channels; `user` is in `a`, `mod` can move them. */
async function guildWithCall() {
  const owner = await createUser();
  const mod = await createUser();
  const user = await createUser();
  const guildId = await createGuild(owner, P.VIEW_CHANNEL | P.CONNECT | P.SPEAK | P.MOVE_MEMBERS);
  await addMember(guildId, mod);
  await addMember(guildId, user);
  const a = await voiceChannel(guildId);
  const b = await voiceChannel(guildId);
  const c = await voiceChannel(guildId);
  await joinVoice(user, a);
  return { guildId, mod, user, a, b, c };
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

  it('a hang-up naming the channel a moderator moved the user out of ends the call', async () => {
    const { mod, user, a, b } = await guildWithCall();
    await moveVoiceMember({ callerId: mod, targetUserId: user, targetChannelId: b });
    expect(await voiceChannelOf(user)).toBe(b);

    // The client didn't follow the move and hangs up the call it was in.
    await hangUp(user, a);
    expect(await voiceChannelOf(user)).toBeNull();
  });

  it('a hang-up naming the channel the AFK sweep took the user out of ends the call', async () => {
    const { guildId, user, a, b } = await guildWithCall();
    await db
      .update(schema.guilds)
      .set({ afkChannelId: b, afkTimeoutSeconds: 60 })
      .where(eq(schema.guilds.id, guildId));
    await setMuteFlags(user, { selfMute: true });
    await db
      .update(schema.voiceStates)
      .set({ selfMuteAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.voiceStates.userId, user));
    await sweepAfkMutedMembers();
    expect(await voiceChannelOf(user)).toBe(b);

    await hangUp(user, a);
    expect(await voiceChannelOf(user)).toBeNull();
  });

  it('after repeated moves, the first channel still names the call', async () => {
    const { mod, user, a, b, c } = await guildWithCall();
    await moveVoiceMember({ callerId: mod, targetUserId: user, targetChannelId: b });
    await moveVoiceMember({ callerId: mod, targetUserId: user, targetChannelId: c });
    expect(await voiceChannelOf(user)).toBe(c);

    await hangUp(user, a);
    expect(await voiceChannelOf(user)).toBeNull();
  });

  it('once the user joins a channel themselves, the pre-move channel no longer names the call', async () => {
    const { mod, user, a, b, c } = await guildWithCall();
    await moveVoiceMember({ callerId: mod, targetUserId: user, targetChannelId: b });
    // Another of the user's devices joins C on their own.
    await joinVoice(user, c);

    // A late hang-up from the device that was in A leaves the call in C alone.
    await hangUp(user, a);
    expect(await voiceChannelOf(user)).toBe(c);
    // So does one for B: the user's own join replaced the move.
    await hangUp(user, b);
    expect(await voiceChannelOf(user)).toBe(c);

    await hangUp(user, c);
    expect(await voiceChannelOf(user)).toBeNull();
  });

  it('a client that followed the move hangs up the new channel as usual', async () => {
    const { mod, user, a, b } = await guildWithCall();
    await moveVoiceMember({ callerId: mod, targetUserId: user, targetChannelId: b });
    // Following the move is a join of B.
    await joinVoice(user, b);
    // A late hang-up for A from before the move no longer matches.
    await hangUp(user, a);
    expect(await voiceChannelOf(user)).toBe(b);
    await hangUp(user, b);
    expect(await voiceChannelOf(user)).toBeNull();
  });
});
