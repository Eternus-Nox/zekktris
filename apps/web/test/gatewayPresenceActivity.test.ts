import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayClient } from '@zekktris/client';

// packages/client's device-activity reporting (multi-device presence): the
// activity rides on IDENTIFY/RESUME, and op 3 PRESENCE_UPDATE goes out once
// per change — only to a server whose READY advertised
// features.presence_activity.

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
  outbound(): Array<{ op: number; d?: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const HELLO = { op: 7, d: { heartbeat_interval: 30_000 } };
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, PRESENCE_UPDATE: 3, RESUME: 4 };
const READY_WITH_FLAG = {
  op: 0,
  t: 'READY',
  d: { session_id: 's1', features: { presence_activity: true } },
  s: 1,
};

function newClient() {
  return new GatewayClient({
    url: 'ws://test/gateway',
    getToken: () => 'tok',
    WebSocket: MockWS as unknown as typeof WebSocket,
  });
}

/** Non-heartbeat frames the client sent on a socket. */
function frames(ws: MockWS) {
  return ws.outbound().filter((f) => f.op !== OP.HEARTBEAT);
}

describe('GatewayClient presence activity', () => {
  beforeEach(() => {
    instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('IDENTIFY omits presence until the host reports, then carries it', () => {
    const a = newClient();
    a.start();
    instances[0]!.serverSend(HELLO);
    expect(frames(instances[0]!)[0]!.d).not.toHaveProperty('presence');

    const b = newClient();
    b.setPresenceActive(false);
    b.start();
    instances[1]!.serverSend(HELLO);
    expect(frames(instances[1]!)[0]).toMatchObject({ op: OP.IDENTIFY, d: { presence: { active: false } } });
  });

  it('sends op 3 once per change, only after a READY with features.presence_activity', () => {
    const client = newClient();
    client.setPresenceActive(true);
    client.start();
    const ws = instances[0]!;
    ws.serverSend(HELLO);
    // Changed while identifying: nothing yet (no READY, flag unknown).
    client.setPresenceActive(false);
    expect(frames(ws).map((f) => f.op)).toEqual([OP.IDENTIFY]);

    ws.serverSend(READY_WITH_FLAG);
    expect(client.supportsPresenceActivity()).toBe(true);
    expect(client.getFeatures()).toEqual({ presence_activity: true });
    // The pending change goes out on READY.
    expect(frames(ws).slice(1)).toEqual([{ op: OP.PRESENCE_UPDATE, d: { active: false } }]);

    // Repeats are dropped; a real transition is sent.
    client.setPresenceActive(false);
    client.setPresenceActive(true);
    client.setPresenceActive(true);
    expect(frames(ws).slice(1)).toEqual([
      { op: OP.PRESENCE_UPDATE, d: { active: false } },
      { op: OP.PRESENCE_UPDATE, d: { active: true } },
    ]);
  });

  it('never sends op 3 to a server without the flag (legacy path)', () => {
    const client = newClient();
    client.start();
    const ws = instances[0]!;
    ws.serverSend(HELLO);
    ws.serverSend({ op: 0, t: 'READY', d: { session_id: 's1' }, s: 1 });
    expect(client.supportsPresenceActivity()).toBe(false);
    client.setPresenceActive(false);
    client.setPresenceActive(true);
    expect(frames(ws).map((f) => f.op)).toEqual([OP.IDENTIFY]);
  });

  it('RESUME carries the current activity and keeps the READY features', () => {
    const client = newClient();
    client.start();
    const ws0 = instances[0]!;
    ws0.serverSend(HELLO);
    ws0.serverSend(READY_WITH_FLAG);
    client.setPresenceActive(true);

    ws0.close(4000, 'blip');
    // Went idle while disconnected: nothing can be sent now…
    client.setPresenceActive(false);
    vi.advanceTimersByTime(2000);
    const ws1 = instances[1]!;
    ws1.serverSend(HELLO);
    // …so the RESUME carries it, and RESUMED sends nothing more.
    expect(frames(ws1)[0]).toMatchObject({
      op: OP.RESUME,
      d: { session_id: 's1', presence: { active: false } },
    });
    ws1.serverSend({ op: 0, t: 'RESUMED', d: { session_id: 's1' }, s: 2 });
    expect(client.supportsPresenceActivity()).toBe(true);
    expect(frames(ws1).map((f) => f.op)).toEqual([OP.RESUME]);
    client.setPresenceActive(true);
    expect(frames(ws1).slice(1)).toEqual([{ op: OP.PRESENCE_UPDATE, d: { active: true } }]);
  });
});
