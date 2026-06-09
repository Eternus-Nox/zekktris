import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { Connection } from '../src/gateway/connection';
import { registry } from '../src/gateway/registry';
import * as dispatch from '../src/gateway/dispatch';
import { RESUME_WINDOW_MS } from '../src/gateway/resume';

// A fake authenticated connection with a captured outbound buffer. We model
// the gateway's real wiring (registry indexes + bus fan-out) but with stub
// sockets, so we can drive the resume mechanism without a DB or a real WS.
function makeConn(): { conn: Connection; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: (s: string) => sent.push(s),
    close: () => undefined,
  } as unknown as WebSocket;
  return { conn: new Connection(ws), sent };
}

function frames(sent: string[]): Array<{ t?: string; s?: number; d?: { id?: string } }> {
  return sent.map((s) => JSON.parse(s));
}

const U = 9001n;
const G = 7001n;
const CH_VISIBLE = 5001n;
const CH_HIDDEN = 5002n;

describe('gateway RESUME mechanism', () => {
  let live: Connection[] = [];

  beforeEach(() => {
    registry.init();
    live = [];
  });

  afterEach(() => {
    for (const c of live) registry.remove(c);
    live = [];
    registry.onUserFullyDisconnected = null;
    registry.onUserConnected = null;
    vi.useRealTimers();
  });

  function connect(): { conn: Connection; sent: string[] } {
    const r = makeConn();
    r.conn.markAuthenticated(U, [G], [], [{ channelId: CH_VISIBLE, guildId: G }]);
    registry.add(r.conn);
    registry.index(r.conn);
    live.push(r.conn);
    return r;
  }

  it('buffers gap events (permission-filtered) and replays exactly the missed suffix, in order', () => {
    const fullyGone = vi.fn();
    const reconnected = vi.fn();
    registry.onUserFullyDisconnected = fullyGone;
    registry.onUserConnected = reconnected;

    const a = connect();

    // Live event 1 → delivered + buffered (seq 1).
    dispatch.messageCreate({ messageDTO: { id: 'e1' }, channelId: CH_VISIBLE, guildId: G });
    expect(frames(a.sent).map((f) => f.d?.id)).toEqual(['e1']);
    const clientLastSeq = a.conn.currentSeq; // = 1

    // Socket drops → detached (still in indexes, buffering). Last live socket
    // gone → full-disconnect hook fires exactly once.
    a.conn.handlePeerClosed();
    expect(fullyGone).toHaveBeenCalledTimes(1);
    expect(registry.findResumable(a.conn.sessionId)).toBe(a.conn);

    // DURING THE GAP: an event to a visible channel is buffered; an event to a
    // channel this session can't see is NOT (permission filter preserved).
    dispatch.messageCreate({ messageDTO: { id: 'e2' }, channelId: CH_VISIBLE, guildId: G });
    dispatch.messageCreate({ messageDTO: { id: 'hidden' }, channelId: CH_HIDDEN, guildId: G });
    // No socket write happened while detached.
    expect(frames(a.sent).map((f) => f.d?.id)).toEqual(['e1']);

    // RESUME: the missed suffix is exactly [e2] (e1 already seen, hidden filtered out).
    const prev = registry.findResumable(a.conn.sessionId)!;
    expect(prev.resumeBuffer!.canResume(clientLastSeq, prev.currentSeq)).toBe(true);
    const missed = prev.resumeBuffer!.framesAfter(clientLastSeq);
    expect(missed.map((j) => JSON.parse(j).d.id)).toEqual(['e2']);
    expect(missed.map((j) => JSON.parse(j).s)).toEqual([2]); // original seq preserved

    // Adopt onto a fresh socket, replay verbatim, go live.
    const b = makeConn();
    b.conn.adoptResumedSession(prev);
    for (const j of missed) b.conn.sendRaw(j);
    registry.completeResume(prev, b.conn);
    live.push(b.conn);

    expect(frames(b.sent).map((f) => f.d?.id)).toEqual(['e2']); // replayed
    expect(reconnected).toHaveBeenCalled(); // onUserConnected fired on resume
    expect(registry.findResumable(a.conn.sessionId)).toBeNull(); // no longer detached

    // Live event AFTER resume goes to the new socket only, continuing the seq.
    dispatch.messageCreate({ messageDTO: { id: 'e3' }, channelId: CH_VISIBLE, guildId: G });
    expect(frames(b.sent).map((f) => f.d?.id)).toEqual(['e2', 'e3']);
    expect(frames(b.sent).find((f) => f.d?.id === 'e3')!.s).toBe(3); // contiguous seq
    expect(frames(a.sent).map((f) => f.d?.id)).toEqual(['e1']); // old socket untouched
  });

  it('unknown / wrong session is not resumable (client must IDENTIFY)', () => {
    const a = connect();
    dispatch.messageCreate({ messageDTO: { id: 'x' }, channelId: CH_VISIBLE, guildId: G });
    a.conn.handlePeerClosed();
    expect(registry.findResumable('does-not-exist')).toBeNull();
    // The real session is resumable; a bogus seq beyond ours is rejected.
    const prev = registry.findResumable(a.conn.sessionId)!;
    expect(prev.resumeBuffer!.canResume(999, prev.currentSeq)).toBe(false);
  });

  it('full-disconnect hook fires once across multi-device: only when the LAST live socket detaches', () => {
    const fullyGone = vi.fn();
    registry.onUserFullyDisconnected = fullyGone;
    const a = connect();
    const b = connect(); // second device

    a.conn.handlePeerClosed(); // one device gone, user still live on b
    expect(fullyGone).not.toHaveBeenCalled();

    b.conn.handlePeerClosed(); // last live socket gone
    expect(fullyGone).toHaveBeenCalledTimes(1);
  });

  it('evicts a detached session after the resume window (full cleanup, no double hook)', () => {
    vi.useFakeTimers();
    const fullyGone = vi.fn();
    registry.onUserFullyDisconnected = fullyGone;
    const a = connect();
    a.conn.handlePeerClosed();
    expect(registry.findResumable(a.conn.sessionId)).toBe(a.conn);
    expect(fullyGone).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RESUME_WINDOW_MS + 1);
    expect(registry.findResumable(a.conn.sessionId)).toBeNull(); // evicted
    expect(fullyGone).toHaveBeenCalledTimes(1); // NOT fired again on eviction
  });
});
