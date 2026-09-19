/**
 * GET /guilds/:guildId/voice/states — the whole-server voice roster.
 *
 * It exists so a sidebar can heal itself: voice presence was built from gateway
 * events alone for every channel except the one you were in, so one dropped
 * VOICE_STATE_UPDATE left people invisible to everyone outside the call until
 * somebody joined. These tests pin the two things that make it safe to expose:
 * it returns everyone the caller could legitimately see, and nobody they
 * couldn't.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { guildsRouter } from '../src/routes/guilds';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { nextSnowflake } from '../src/snowflake';
import { createUser, createGuild, addMember, addOverride, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping guild voice roster tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/guilds', guildsRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

async function voiceChannel(guildId: bigint): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.channels).values({ id, type: 'guild_voice', guildId, name: 'voice' });
  return id;
}

async function inVoice(userId: bigint, guildId: bigint, channelId: bigint): Promise<void> {
  await db.insert(schema.voiceStates).values({
    userId, guildId, channelId, sessionId: `s-${userId}`,
  });
}

describe.runIf(dbReady)('GET /guilds/:guildId/voice/states', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('returns everyone in every voice channel the caller can see', async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const alice = await createUser();
    const bob = await createUser();
    const guildId = await createGuild(owner, P.VIEW_CHANNEL | P.CONNECT);
    for (const u of [viewer, alice, bob]) await addMember(guildId, u);
    const lounge = await voiceChannel(guildId);
    const games = await voiceChannel(guildId);
    await inVoice(alice, guildId, lounge);
    await inVoice(bob, guildId, games);

    // The viewer is in NEITHER channel — which is exactly the case that used
    // to go stale.
    const res = await app.request(`/guilds/${guildId}/voice/states`, {
      headers: { authorization: `Bearer ${await tokenFor(viewer)}` },
    });
    expect(res.status).toBe(200);
    const { voiceStates } = (await res.json()) as {
      voiceStates: Array<{ userId: string; channelId: string }>;
    };
    const seen = new Map(voiceStates.map((v) => [v.userId, v.channelId]));
    expect(seen.get(alice.toString())).toBe(lounge.toString());
    expect(seen.get(bob.toString())).toBe(games.toString());
  });

  it("does not reveal who is in a channel the caller can't see", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const insider = await createUser();
    const guildId = await createGuild(owner, P.VIEW_CHANNEL | P.CONNECT);
    await addMember(guildId, viewer);
    await addMember(guildId, insider);
    const staff = await voiceChannel(guildId);
    // Private: @everyone (role id === guild id) denied VIEW_CHANNEL.
    await addOverride(staff, 'role', guildId, 0n, P.VIEW_CHANNEL);
    await inVoice(insider, guildId, staff);

    const res = await app.request(`/guilds/${guildId}/voice/states`, {
      headers: { authorization: `Bearer ${await tokenFor(viewer)}` },
    });
    expect(res.status).toBe(200);
    const { voiceStates } = (await res.json()) as { voiceStates: Array<{ userId: string }> };
    expect(voiceStates.map((v) => v.userId)).not.toContain(insider.toString());
  });

  it('refuses someone who is not in the server', async () => {
    const owner = await createUser();
    const outsider = await createUser();
    const guildId = await createGuild(owner, P.VIEW_CHANNEL);
    const res = await app.request(`/guilds/${guildId}/voice/states`, {
      headers: { authorization: `Bearer ${await tokenFor(outsider)}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
