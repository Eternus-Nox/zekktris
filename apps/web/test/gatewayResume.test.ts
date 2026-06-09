import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayClient } from '@zekktris/client';

// A controllable mock WebSocket: the test plays the server by calling
// serverSend()/close() on the instance the client opened.
let instances: MockWS[] = [];
class MockWS {
  static OPEN = 1;
  readyState = 1;
  OPEN = 1;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev?: unknown) => void>> = {};
  constructor(public url: string) {
    instances.push(this);
  }
  addEventListener(type: string, cb: (ev?: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(): void {}
  send(s: string): void {
    this.sent.push(s);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
  emit(type: string, ev?: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  serverSend(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }
  /** Frames the client sent us, parsed. */
  outbound(): Array<{ op: number; d?: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const HELLO = { op: 7, d: { heartbeat_interval: 30_000 } };
const OP = { DISPATCH: 0, IDENTIFY: 2, RESUME: 4, INVALID_SESSION: 6 };

function newClient() {
  return new GatewayClient({
    url: 'ws://test/gateway',
    getToken: () => 'tok',
    WebSocket: MockWS as unknown as typeof WebSocket,
  });
}

describe('GatewayClient RESUME', () => {
  beforeEach(() => {
    instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('IDENTIFYs first, then RESUMEs on reconnect and applies replayed events without a full READY', () => {
    const client = newClient();
    const received: string[] = [];
    client.on('MESSAGE_CREATE', (d) => received.push((d as { id: string }).id));
    let resumedFired = 0;
    client.on('RESUMED', () => resumedFired++);

    client.start();
    const ws0 = instances[0]!;
    ws0.serverSend(HELLO);
    // First connection → IDENTIFY (no prior session).
    expect(ws0.outbound().map((f) => f.op)).toEqual([OP.IDENTIFY]);

    ws0.serverSend({ op: OP.DISPATCH, t: 'READY', d: { session_id: 'sess-1' }, s: 1 });
    ws0.serverSend({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', d: { id: 'm1' }, s: 2 });
    expect(received).toEqual(['m1']);
    expect(client.getStatus()).toBe('ready');

    // Socket drops → client schedules a reconnect.
    ws0.close(4000, 'blip');
    vi.advanceTimersByTime(2000); // fire the reconnect timer
    const ws1 = instances[1]!;
    expect(ws1).toBeDefined();

    // Reconnect HELLO → client RESUMEs (has session_id + last seq), NOT IDENTIFY.
    ws1.serverSend(HELLO);
    const out1 = ws1.outbound();
    expect(out1.map((f) => f.op)).toEqual([OP.RESUME]);
    expect(out1[0]!.d).toMatchObject({ session_id: 'sess-1', seq: 2 });

    // Server replays the missed event, then RESUMED — no READY, no resync.
    ws1.serverSend({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', d: { id: 'm2' }, s: 3 });
    ws1.serverSend({ op: OP.DISPATCH, t: 'RESUMED', d: { session_id: 'sess-1' }, s: 4 });
    expect(received).toEqual(['m1', 'm2']);
    expect(resumedFired).toBe(1);
    expect(client.getStatus()).toBe('ready');
    // The client never re-IDENTIFYd on the resumed socket.
    expect(ws1.outbound().some((f) => f.op === OP.IDENTIFY)).toBe(false);
  });

  it('falls back to IDENTIFY on the same socket when the server rejects the resume', () => {
    const client = newClient();
    client.start();
    const ws0 = instances[0]!;
    ws0.serverSend(HELLO);
    ws0.serverSend({ op: OP.DISPATCH, t: 'READY', d: { session_id: 'sess-1' }, s: 1 });
    ws0.serverSend({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', d: { id: 'm1' }, s: 2 });

    ws0.close(4000, 'blip');
    vi.advanceTimersByTime(2000);
    const ws1 = instances[1]!;
    ws1.serverSend(HELLO);
    expect(ws1.outbound().map((f) => f.op)).toEqual([OP.RESUME]);

    // Server can't resume → INVALID_SESSION{resumable:false}. Client must NOT
    // treat it as fatal: it falls back to IDENTIFY on the SAME socket.
    ws1.serverSend({ op: OP.INVALID_SESSION, d: { resumable: false } });
    expect(ws1.outbound().map((f) => f.op)).toEqual([OP.RESUME, OP.IDENTIFY]);
    expect(client.getStatus()).not.toBe('closed');

    // A fresh READY completes the fallback (host's reconnect resync runs).
    ws1.serverSend({ op: OP.DISPATCH, t: 'READY', d: { session_id: 'sess-2' }, s: 1 });
    expect(client.getStatus()).toBe('ready');
  });

  it('a fatal INVALID_SESSION during IDENTIFY (bad token) stays fatal', () => {
    const client = newClient();
    let invalid = 0;
    client.on('INVALID_SESSION', () => invalid++);
    client.start();
    const ws0 = instances[0]!;
    ws0.serverSend(HELLO);
    expect(ws0.outbound().map((f) => f.op)).toEqual([OP.IDENTIFY]);
    // INVALID_SESSION while identifying (not resuming) → fatal.
    ws0.serverSend({ op: OP.INVALID_SESSION, d: { resumable: false } });
    expect(invalid).toBe(1);
    expect(client.getStatus()).toBe('closed');
  });
});
