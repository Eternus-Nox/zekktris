import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import { eventBus, type PublishedEvent } from '../src/gateway/bus';
import * as dispatch from '../src/gateway/dispatch';

/**
 * Presence fan-out (unit — no DB).
 * --------------------------------
 * dispatch.presenceUpdate now emits a SINGLE bus publish (audience
 * `presence`) instead of one publish per guild + one per DM channel. The
 * registry expands it at delivery into the SAME frames the old per-guild /
 * per-DM publishes produced. These tests pin that behavior preservation:
 *
 *   - exactly one bus publish regardless of guild count;
 *   - one PRESENCE_UPDATE frame per guild a recipient shares with the
 *     subject, each stamped with that guild's guild_id;
 *   - one guild_id=null frame for DM peers;
 *   - non-members / non-peers receive nothing.
 */

const liveConns: Connection[] = [];

/** A registered, authenticated connection with a captured send buffer. */
function connect(
  userId: bigint,
  guildIds: bigint[],
  dmChannelIds: bigint[],
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

/** Presence frames (t === PRESENCE_UPDATE) seen on a connection, as payloads. */
function presenceFrames(
  sent: Array<Record<string, unknown>>,
): Array<{ user_id: string; guild_id: string | null; status: string }> {
  return sent
    .filter((f) => (f as { t?: string }).t === 'PRESENCE_UPDATE')
    .map((f) => (f as { d: { user_id: string; guild_id: string | null; status: string } }).d);
}

describe('presence fan-out', () => {
  // The registry only delivers bus events after init() wires its
  // subscription (boot does this in production). Idempotent.
  beforeAll(() => {
    registry.init();
  });

  afterEach(() => {
    for (const c of liveConns) registry.remove(c);
    liveConns.length = 0;
  });

  it('emits exactly ONE bus publish for a multi-guild presence flip', () => {
    const subject = 1000n;
    const G1 = 10n;
    const G2 = 20n;
    const G3 = 30n;

    const published: PublishedEvent[] = [];
    const unsub = eventBus().subscribe((e) => published.push(e));
    try {
      dispatch.presenceUpdate({
        userId: subject,
        status: 'online',
        guildIds: [G1, G2, G3],
        dmChannelIds: [],
      });
    } finally {
      unsub();
    }

    expect(published).toHaveLength(1);
    expect(published[0]!.t).toBe('PRESENCE_UPDATE');
    expect(published[0]!.audience).toMatchObject({ kind: 'presence' });
  });

  it('delivers one frame per shared guild, each with its own guild_id', () => {
    const subject = 1000n;
    const G1 = 10n;
    const G2 = 20n;

    // A: member of G1 only. B: member of G1 AND G2. X: member of an
    // unrelated guild → not in the subject's footprint.
    const a = connect(2000n, [G1], []);
    const b = connect(3000n, [G1, G2], []);
    const x = connect(4000n, [99n], []);

    dispatch.presenceUpdate({
      userId: subject,
      status: 'idle',
      guildIds: [G1, G2],
      dmChannelIds: [],
    });

    // A: exactly one frame for G1.
    const aF = presenceFrames(a.sent);
    expect(aF).toHaveLength(1);
    expect(aF[0]).toMatchObject({ user_id: '1000', guild_id: '10', status: 'idle' });

    // B: two frames — G1 and G2, each stamped with its own guild_id.
    const bF = presenceFrames(b.sent);
    expect(bF).toHaveLength(2);
    expect(new Set(bF.map((f) => f.guild_id))).toEqual(new Set(['10', '20']));
    expect(bF.every((f) => f.user_id === '1000' && f.status === 'idle')).toBe(true);

    // X: nothing — shares no guild/DM with the subject.
    expect(presenceFrames(x.sent)).toHaveLength(0);
  });

  it('delivers a single guild_id=null frame to DM peers', () => {
    const subject = 1000n;
    const D1 = 500n;

    const peer = connect(2000n, [], [D1]);

    dispatch.presenceUpdate({
      userId: subject,
      status: 'dnd',
      guildIds: [],
      dmChannelIds: [D1],
    });

    const f = presenceFrames(peer.sent);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ user_id: '1000', guild_id: null, status: 'dnd' });
  });

  it('a recipient who is both a guild co-member and a DM peer gets both', () => {
    const subject = 1000n;
    const G2 = 20n;
    const D1 = 500n;

    // Shares G2 (a guild) and D1 (a DM channel) with the subject.
    const both = connect(2000n, [G2], [D1]);

    dispatch.presenceUpdate({
      userId: subject,
      status: 'online',
      guildIds: [G2],
      dmChannelIds: [D1],
    });

    const f = presenceFrames(both.sent);
    // One guild frame (G2) + one null frame (DM).
    expect(f).toHaveLength(2);
    const guildFrame = f.find((x) => x.guild_id === '20');
    const dmFrame = f.find((x) => x.guild_id === null);
    expect(guildFrame).toMatchObject({ user_id: '1000', status: 'online' });
    expect(dmFrame).toMatchObject({ user_id: '1000', status: 'online' });
  });

  it('does not publish at all when the user has no guilds and no DMs', () => {
    const published: PublishedEvent[] = [];
    const unsub = eventBus().subscribe((e) => published.push(e));
    try {
      dispatch.presenceUpdate({
        userId: 1000n,
        status: 'offline',
        guildIds: [],
        dmChannelIds: [],
      });
    } finally {
      unsub();
    }
    expect(published).toHaveLength(0);
  });
});
