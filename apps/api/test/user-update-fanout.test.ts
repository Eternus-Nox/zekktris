import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { eventBus, type PublishedEvent } from '../src/gateway/bus';
import { encodeAudience, decodeAudience } from '../src/gateway/redis-bus';
import * as dispatch from '../src/gateway/dispatch';

/**
 * USER_UPDATE fan-out (unit — no DB).
 * -----------------------------------
 * dispatch.userUpdate now emits a SINGLE bus publish (audience `multiUser`)
 * instead of one publish per guild + one for self + one per DM peer. Unlike
 * presence, the USER_UPDATE wire carries NO per-recipient guild_id (clients
 * key the upsert on user.id), so it rides the generic pre-serialize-once
 * delivery path: each recipient gets exactly ONE identical frame, even when
 * they sit in several of the subject's guilds. These tests pin that:
 *
 *   - exactly one bus publish regardless of guild count;
 *   - exactly one USER_UPDATE frame per recipient (deduped across guilds and
 *     the explicit user list), with no guild_id in the payload;
 *   - explicit user targets (DM peers) and self (multi-tab) receive it;
 *   - non-members / non-targets receive nothing;
 *   - the multiUser audience round-trips through the redis-bus codec.
 */

const liveConns: Connection[] = [];

function connect(
  userId: bigint,
  guildIds: bigint[],
  dmChannelIds: bigint[] = [],
): { conn: Connection; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
  } as unknown as WebSocket;
  const conn = new Connection(ws);
  conn.markAuthenticated(userId, guildIds, dmChannelIds, []);
  registry.add(conn);
  registry.index(conn);
  liveConns.push(conn);
  return { conn, sent };
}

function userFrames(
  sent: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return sent
    .filter((f) => (f as { t?: string }).t === 'USER_UPDATE')
    .map((f) => (f as { d: Record<string, unknown> }).d);
}

const sampleUser = {
  id: '1000',
  username: 'neo',
  displayName: 'Neo',
  avatarUrl: null,
  bio: null,
  customStatus: null,
  status: 'online' as const,
};

describe('USER_UPDATE fan-out', () => {
  beforeAll(() => {
    registry.init();
  });

  afterEach(() => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
  });

  it('emits exactly ONE bus publish for a multi-guild profile change', () => {
    const published: PublishedEvent[] = [];
    const unsub = eventBus().subscribe((e) => published.push(e));
    try {
      dispatch.userUpdate({
        userId: 1000n,
        user: sampleUser,
        guildIds: [10n, 20n, 30n],
      });
    } finally {
      unsub();
    }

    expect(published).toHaveLength(1);
    expect(published[0]!.t).toBe('USER_UPDATE');
    expect(published[0]!.audience).toMatchObject({ kind: 'multiUser' });
  });

  it('delivers exactly one frame per recipient, deduped across shared guilds', () => {
    const G1 = 10n;
    const G2 = 20n;

    // A: member of G1 only. B: member of G1 AND G2 (old path would have sent
    // B two frames). X: unrelated guild → outside the subject's footprint.
    const a = connect(2000n, [G1]);
    const b = connect(3000n, [G1, G2]);
    const x = connect(4000n, [99n]);

    dispatch.userUpdate({ userId: 1000n, user: sampleUser, guildIds: [G1, G2] });

    expect(userFrames(a.sent)).toHaveLength(1);
    // B is in both shared guilds but receives a SINGLE deduped frame.
    const bF = userFrames(b.sent);
    expect(bF).toHaveLength(1);
    // The USER_UPDATE wire carries the nested user object and NO guild_id.
    expect(bF[0]).not.toHaveProperty('guild_id');
    expect(bF[0]).toMatchObject({ user: { id: '1000', display_name: 'Neo', status: 'online' } });
    // X shares no guild → nothing.
    expect(userFrames(x.sent)).toHaveLength(0);
  });

  it('delivers to an explicit DM-peer target that shares no guild', () => {
    const peer = connect(5000n, []);

    dispatch.userUpdate({
      userId: 1000n,
      user: sampleUser,
      guildIds: [],
      userIds: [5000n],
    });

    expect(userFrames(peer.sent)).toHaveLength(1);
  });

  it('delivers to every self tab even when the user has no guilds', () => {
    const tab1 = connect(1000n, []);
    const tab2 = connect(1000n, []);

    dispatch.userUpdate({ userId: 1000n, user: sampleUser, guildIds: [] });

    expect(userFrames(tab1.sent)).toHaveLength(1);
    expect(userFrames(tab2.sent)).toHaveLength(1);
  });

  it('dedupes a recipient who is BOTH a guild co-member and an explicit target', () => {
    const G1 = 10n;
    // 5000n is in G1 AND passed as an explicit userId — must get one frame.
    const both = connect(5000n, [G1]);

    dispatch.userUpdate({
      userId: 1000n,
      user: sampleUser,
      guildIds: [G1],
      userIds: [5000n],
    });

    expect(userFrames(both.sent)).toHaveLength(1);
  });

  it('round-trips the multiUser audience through the redis-bus codec', () => {
    const audience = {
      kind: 'multiUser' as const,
      guildIds: [10n, 20n],
      userIds: [1000n, 5000n],
    };
    expect(decodeAudience(encodeAudience(audience))).toEqual(audience);
  });
});
