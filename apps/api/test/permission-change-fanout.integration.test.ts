import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { eq } from 'drizzle-orm';
import { createUser, createGuild, addMember, createChannel, addOverride, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import * as dispatch from '../src/gateway/dispatch';
import * as voice from '../src/services/voice';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping permission-change fanout tests — no database reachable');
}

// Track registered connections so we can detach them from the singleton
// registry between tests (it persists for the whole worker).
const liveConns: Connection[] = [];

/** A registered, authenticated connection with a captured send buffer. */
function connect(
  userId: bigint,
  guildId: bigint,
  viewable: Array<{ channelId: bigint; guildId: bigint }>,
): { conn: Connection; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
  } as unknown as WebSocket;
  const conn = new Connection(ws);
  conn.markAuthenticated(userId, [guildId], [], viewable);
  registry.add(conn);
  registry.index(conn);
  liveConns.push(conn);
  return { conn, sent };
}

async function addVoiceState(userId: bigint, guildId: bigint, channelId: bigint) {
  await db
    .insert(schema.voiceStates)
    .values({ userId, channelId, guildId, sessionId: `sess-${userId}` });
}

/** Dispatch events of a given type captured on a connection's send buffer. */
function frames(sent: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> {
  return sent.filter((f) => (f as { t?: string }).t === type).map((f) => (f as { d: Record<string, unknown> }).d);
}

describe.runIf(dbReady)('applyGuildPermissionChange fan-out (integration)', () => {
  afterEach(() => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('preserves behaviour: hides the channel for all, evicts only the user in voice in it', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner, P.VIEW_CHANNEL);
    const m1 = await createUser();
    const m2 = await createUser();
    await addMember(guildId, m1);
    await addMember(guildId, m2);

    const chVisible = await createChannel(guildId);
    const chHidden = await createChannel(guildId);
    // Hide chHidden from @everyone (override targetId === guildId per seed).
    await addOverride(chHidden, 'role', guildId, 0n, P.VIEW_CHANNEL);

    // Both connections have a STALE snapshot that still includes chHidden.
    const snap = [
      { channelId: chVisible, guildId },
      { channelId: chHidden, guildId },
    ];
    const u1 = connect(m1, guildId, snap);
    const u2 = connect(m2, guildId, snap);

    // m1 is in voice in the now-hidden channel; m2 is in voice in a still-visible one.
    await addVoiceState(m1, guildId, chHidden);
    await addVoiceState(m2, guildId, chVisible);

    await dispatch.applyGuildPermissionChange({ guildId });

    // Both lose visibility of chHidden → CHANNEL_DELETE for it on both conns.
    const del1 = frames(u1.sent, 'CHANNEL_DELETE').map((d) => d.id);
    const del2 = frames(u2.sent, 'CHANNEL_DELETE').map((d) => d.id);
    expect(del1).toContain(chHidden.toString());
    expect(del2).toContain(chHidden.toString());

    // m1 (in voice in the hidden channel) is evicted; m2 (in a visible one) is not.
    const [vs1] = await db
      .select({ id: schema.voiceStates.userId })
      .from(schema.voiceStates)
      .where(eq(schema.voiceStates.userId, m1));
    const [vs2] = await db
      .select({ id: schema.voiceStates.userId })
      .from(schema.voiceStates)
      .where(eq(schema.voiceStates.userId, m2));
    expect(vs1).toBeUndefined(); // evicted
    expect(vs2).toBeDefined(); // untouched
  });

  it('scale: one batched voice_states read regardless of member count (no per-user query)', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner, P.VIEW_CHANNEL);
    const chHidden = await createChannel(guildId);
    await addOverride(chHidden, 'role', guildId, 0n, P.VIEW_CHANNEL);

    const N = 30;
    for (let i = 0; i < N; i++) {
      const u = await createUser();
      await addMember(guildId, u);
      // Stale snapshot includes chHidden so every user has removed.length > 0,
      // which is exactly the path that used to run a per-user voice query.
      connect(u, guildId, [{ channelId: chHidden, guildId }]);
    }

    const batchSpy = vi.spyOn(voice, 'listGuildVoiceChannels');
    const perUserSpy = vi.spyOn(voice, 'voiceChannelInGuild');

    await dispatch.applyGuildPermissionChange({ guildId });

    // Exactly one batched read, and the per-user query is never used in the
    // bulk path — so voice_states reads are O(1), not O(N).
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(perUserSpy).toHaveBeenCalledTimes(0);
  });

  it('the batched map is equivalent to the per-user lookup it replaces', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner, P.VIEW_CHANNEL);
    const otherGuild = await createGuild(owner, P.VIEW_CHANNEL);
    const chA = await createChannel(guildId);
    const chOther = await createChannel(otherGuild);

    const inVoice = await createUser();
    const inOtherGuild = await createUser();
    const notInVoice = await createUser();
    await addVoiceState(inVoice, guildId, chA);
    await addVoiceState(inOtherGuild, otherGuild, chOther);

    const map = await voice.listGuildVoiceChannels(guildId);
    for (const u of [inVoice, inOtherGuild, notInVoice]) {
      const fromMap = map.get(u) ?? null;
      const fromQuery = await voice.voiceChannelInGuild(u, guildId);
      expect(fromMap).toBe(fromQuery);
    }
    // Concretely: the in-guild voice user resolves to chA; the others to null.
    expect(map.get(inVoice)).toBe(chA);
    expect(map.get(inOtherGuild)).toBeUndefined();
    expect(map.get(notInVoice)).toBeUndefined();
  });
});
