import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { eq } from 'drizzle-orm';
import { createUser, createGuild, addMember, createChannel, addOverride, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { eventBus } from '../src/gateway/bus';
import type { PublishedEvent } from '../src/gateway/bus';
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

  it('evicting a stage-roster member fans out STAGE_PARTICIPANTS_UPDATE without the evicted user', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner, P.VIEW_CHANNEL);
    const evictee = await createUser();
    const stayer = await createUser();
    await addMember(guildId, evictee);
    await addMember(guildId, stayer);

    // A stage channel that's about to be hidden from @everyone.
    const stageId = nextSnowflake();
    await db.insert(schema.channels).values({
      id: stageId,
      type: 'guild_stage',
      guildId,
      position: 0,
    });
    await addOverride(stageId, 'role', guildId, 0n, P.VIEW_CHANNEL);

    // evictee is in voice in the stage AND on the stage roster; stayer is
    // only on the roster (not the one losing voice). Both rows must exist
    // so we can prove the post-eviction roster keeps stayer and drops evictee.
    await addVoiceState(evictee, guildId, stageId);
    await db.insert(schema.stageParticipants).values([
      { channelId: stageId, userId: evictee, isSpeaker: true },
      { channelId: stageId, userId: stayer, isSpeaker: true },
    ]);

    // The evictee needs a connection with a stale snapshot that still lists
    // the stage channel — that's what makes removed.length > 0 and triggers
    // the per-connection eviction.
    connect(evictee, guildId, [{ channelId: stageId, guildId }]);

    // Capture the guild-wide broadcast at the bus (the registry→bus delivery
    // is only wired in index.ts, which tests don't load — subscribing here
    // verifies dispatch publishes the right event with the right payload).
    const published: PublishedEvent[] = [];
    const unsubscribe = eventBus().subscribe((e) => published.push(e));

    await dispatch.applyGuildPermissionChange({ guildId });
    unsubscribe();

    // The evicted user's roster row is gone from the DB...
    const rosterRows = await db
      .select({ userId: schema.stageParticipants.userId })
      .from(schema.stageParticipants)
      .where(eq(schema.stageParticipants.channelId, stageId));
    const rosterIds = rosterRows.map((r) => r.userId);
    expect(rosterIds).not.toContain(evictee);
    expect(rosterIds).toContain(stayer);

    // ...and a STAGE_PARTICIPANTS_UPDATE was published for this channel,
    // guild-scoped, whose participant list excludes the evictee but still
    // includes stayer.
    const updates = published.filter(
      (e) =>
        e.t === 'STAGE_PARTICIPANTS_UPDATE' &&
        (e.d as { channel_id?: string }).channel_id === stageId.toString(),
    );
    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1];
    expect((last.audience as { kind: string }).kind).toBe('guild');
    const participantIds = (
      (last.d as { participants: Array<{ userId: string }> }).participants
    ).map((p) => p.userId);
    expect(participantIds).not.toContain(evictee.toString());
    expect(participantIds).toContain(stayer.toString());
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
