import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeviceActivity,
  IDLE_AFTER_MS,
  INPUT_THROTTLE_MS,
  chosenStatusOf,
  effectiveStatusOf,
  SelfStatusStore,
  resolveSelfStatus,
  selfStatusFromFrame,
  type ActivityClock,
  type ActivityMode,
} from '../src/lib/presenceActivity';

// Device activity decides the `active` this device reports to the gateway
// (multi-device presence: the user's status follows the device in use). A
// fake clock drives the five-minute window deterministically.
class FakeClock implements ActivityClock {
  t = 1_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  pending(): number {
    return this.timers.size;
  }
  /** Advance time, firing due timers in order (including ones they arm). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) {
        if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = end;
  }
}

let clock: FakeClock;
let changes: boolean[];
function make(mode: ActivityMode, visible = true): DeviceActivity {
  return new DeviceActivity({ mode, visible, clock, onChange: (a) => changes.push(a) });
}

beforeEach(() => {
  clock = new FakeClock();
  changes = [];
});

describe('DeviceActivity — browser', () => {
  it('starts active when the page opens visible, idle when it opens hidden', () => {
    expect(make('browser', true).isActive()).toBe(true);
    expect(make('browser', false).isActive()).toBe(false);
    expect(changes).toEqual([]); // the starting value is not a transition
  });

  it('goes idle after five minutes without input, and active again on input', () => {
    const a = make('browser');
    clock.advance(IDLE_AFTER_MS - 1);
    expect(a.isActive()).toBe(true);
    clock.advance(1);
    expect(a.isActive()).toBe(false);
    expect(changes).toEqual([false]);
    a.input();
    expect(a.isActive()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('input inside the window pushes the deadline out without re-arming per event', () => {
    const a = make('browser');
    clock.advance(4 * 60_000);
    for (let i = 0; i < 50; i++) {
      a.input();
      clock.advance(10);
    }
    expect(clock.pending()).toBe(1); // still the single original timer
    // The original deadline passes: it re-checks and stays active.
    clock.advance(IDLE_AFTER_MS - 4 * 60_000);
    expect(a.isActive()).toBe(true);
    expect(changes).toEqual([]);
    // Five minutes after the last input it lapses.
    clock.advance(4 * 60_000);
    expect(a.isActive()).toBe(false);
    expect(changes).toEqual([false]);
  });

  it('throttles input while active (no work per pointermove)', () => {
    const a = make('browser');
    clock.advance(IDLE_AFTER_MS - INPUT_THROTTLE_MS);
    a.input(); // recorded: a second or more since the last one
    clock.advance(INPUT_THROTTLE_MS / 2);
    a.input(); // dropped by the throttle — harmless, the previous one counts
    clock.advance(IDLE_AFTER_MS - INPUT_THROTTLE_MS / 2 - 1);
    expect(a.isActive()).toBe(true);
    clock.advance(1);
    expect(a.isActive()).toBe(false);
  });

  it('hidden is idle at once; showing the tab is active again', () => {
    const a = make('browser');
    a.setVisible(false);
    expect(a.isActive()).toBe(false);
    expect(clock.pending()).toBe(0); // nothing left running while hidden
    a.input(); // e.g. a stray event — still hidden, still idle
    expect(a.isActive()).toBe(false);
    a.setVisible(true);
    expect(a.isActive()).toBe(true);
    expect(changes).toEqual([false, true]);
    // The window restarts from the moment it was shown.
    clock.advance(IDLE_AFTER_MS);
    expect(changes).toEqual([false, true, false]);
  });

  it('reports each transition once, never a repeat', () => {
    const a = make('browser');
    a.setVisible(false);
    a.setVisible(false);
    clock.advance(IDLE_AFTER_MS * 3);
    a.setVisible(true);
    a.input();
    clock.advance(INPUT_THROTTLE_MS);
    a.input();
    expect(changes).toEqual([false, true]);
  });

  it('talking in a call keeps it active past the window, and counts as input when it stops', () => {
    const a = make('browser');
    a.setSpeaking(true);
    clock.advance(IDLE_AFTER_MS * 2);
    expect(a.isActive()).toBe(true);
    a.setSpeaking(false);
    clock.advance(IDLE_AFTER_MS - 1);
    expect(a.isActive()).toBe(true);
    clock.advance(1);
    expect(a.isActive()).toBe(false);
    a.setSpeaking(true);
    expect(a.isActive()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('talking does not override a hidden tab', () => {
    const a = make('browser');
    a.setSpeaking(true);
    a.setVisible(false);
    expect(a.isActive()).toBe(false);
  });

  it('dispose stops the timer and further reports', () => {
    const a = make('browser');
    a.dispose();
    expect(clock.pending()).toBe(0);
    a.setVisible(false);
    clock.advance(IDLE_AFTER_MS);
    expect(changes).toEqual([]);
  });
});

describe('DeviceActivity — desktop shell', () => {
  it('follows the system idle signal, not page input or visibility', () => {
    const a = make('desktop');
    expect(a.isActive()).toBe(true);
    a.setVisible(false); // minimized / behind other apps: still at the computer
    clock.advance(IDLE_AFTER_MS * 2);
    expect(a.isActive()).toBe(true);
    expect(clock.pending()).toBe(0);
    a.setSystemIdle(true);
    expect(a.isActive()).toBe(false);
    a.input();
    expect(a.isActive()).toBe(false);
    a.setSystemIdle(false);
    expect(a.isActive()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('talking in a call counts while the system reads idle', () => {
    const a = make('desktop');
    a.setSystemIdle(true);
    a.setSpeaking(true);
    expect(a.isActive()).toBe(true);
    a.setSpeaking(false);
    expect(a.isActive()).toBe(false);
    expect(changes).toEqual([false, true, false]);
  });
});

describe('chosenStatusOf', () => {
  it('is the chosen status when the server sends one', () => {
    expect(chosenStatusOf({ status: 'idle', chosenStatus: 'online' })).toBe('online');
    expect(chosenStatusOf({ status: 'offline', chosenStatus: 'dnd' })).toBe('dnd');
    expect(chosenStatusOf({ status: 'invisible', chosenStatus: 'invisible' })).toBe('invisible');
  });

  it('falls back to status on an older server (offline shows as Online)', () => {
    expect(chosenStatusOf({ status: 'idle' })).toBe('idle');
    expect(chosenStatusOf({ status: 'offline' })).toBe('online');
  });
});

describe('effectiveStatusOf', () => {
  it('reads effectiveStatus when the server sends it', () => {
    expect(effectiveStatusOf({ status: 'online', chosenStatus: 'online', effectiveStatus: 'idle' })).toBe('idle');
    expect(effectiveStatusOf({ status: 'idle', chosenStatus: 'idle', effectiveStatus: 'offline' })).toBe('offline');
  });

  it('falls back to status on servers without it', () => {
    // Multi-device server before effectiveStatus: status was the effective one.
    expect(effectiveStatusOf({ status: 'idle', chosenStatus: 'online' })).toBe('idle');
    // Pre-multi-device server: one value.
    expect(effectiveStatusOf({ status: 'dnd' })).toBe('dnd');
  });
});

describe('selfStatusFromFrame', () => {
  it('takes our status and chosen status from our own guild_id=null frame', () => {
    expect(
      selfStatusFromFrame('1', { user_id: '1', status: 'idle', guild_id: null, chosen_status: 'online' }),
    ).toEqual({ userId: '1', status: 'idle', chosenStatus: 'online' });
  });

  it('ignores per-guild copies, other users, and frames from a server without chosen_status', () => {
    const d = { status: 'idle', chosen_status: 'online' } as const;
    expect(selfStatusFromFrame('1', { ...d, user_id: '1', guild_id: '9' })).toBeNull();
    expect(selfStatusFromFrame('1', { ...d, user_id: '2', guild_id: null })).toBeNull();
    expect(selfStatusFromFrame('', { ...d, user_id: '', guild_id: null })).toBeNull();
    expect(selfStatusFromFrame('1', { user_id: '1', status: 'idle', guild_id: null })).toBeNull();
  });

  it('unmasks invisible for our own dot', () => {
    expect(
      selfStatusFromFrame('1', { user_id: '1', status: 'offline', guild_id: null, chosen_status: 'invisible' }),
    ).toEqual({ userId: '1', status: 'invisible', chosenStatus: 'invisible' });
  });
});

describe('SelfStatusStore', () => {
  const frame = (status: 'online' | 'idle' | 'dnd', chosen: 'online' | 'dnd' = 'online') =>
    selfStatusFromFrame('1', { user_id: '1', status, guild_id: null, chosen_status: chosen })!;

  it('notifies only on a change', () => {
    const store = new SelfStatusStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.set(frame('online'));
    store.set(frame('online'));
    expect(calls).toBe(1);
    store.set(frame('dnd', 'dnd'));
    expect(calls).toBe(2);
    off();
    store.set(frame('idle'));
    expect(calls).toBe(2);
  });

  it('follows back-to-back frames in order, including a flip back (A → B → A)', () => {
    // Each frame is applied as-is, never diffed against a render-time copy of
    // the user — two frames before a re-render must still end on the second.
    const store = new SelfStatusStore();
    store.set(frame('idle'));
    store.set(frame('online'));
    store.set(frame('idle'));
    expect(store.get()?.status).toBe('idle');
  });
});

describe('resolveSelfStatus', () => {
  const user = { id: '1', status: 'idle' as const, chosenStatus: 'online' as const };

  it('uses the auth user until the server has sent us our status', () => {
    expect(resolveSelfStatus(user, null)).toEqual({ status: 'idle', chosenStatus: 'online' });
    // Older server: no chosenStatus — status is the pick.
    expect(resolveSelfStatus({ id: '1', status: 'dnd' }, null)).toEqual({
      status: 'dnd',
      chosenStatus: 'dnd',
    });
  });

  it("reads a current server's snapshot: status is the pick, effectiveStatus the dot", () => {
    // Chose Online, every device idle. SelfUser.status carries the pick again
    // (older iOS / Android builds read it as such); the dot must not go green.
    expect(
      resolveSelfStatus({ id: '1', status: 'online', chosenStatus: 'online', effectiveStatus: 'idle' }, null),
    ).toEqual({ status: 'idle', chosenStatus: 'online' });
    // Invisible stays unmasked for ourselves.
    expect(
      resolveSelfStatus(
        { id: '1', status: 'invisible', chosenStatus: 'invisible', effectiveStatus: 'invisible' },
        null,
      ),
    ).toEqual({ status: 'invisible', chosenStatus: 'invisible' });
    // No device connected yet: the snapshot says offline; the picker still
    // shows the pick.
    expect(
      resolveSelfStatus({ id: '1', status: 'dnd', chosenStatus: 'dnd', effectiveStatus: 'offline' }, null),
    ).toEqual({ status: 'offline', chosenStatus: 'dnd' });
  });

  it('prefers the latest frame over a user snapshot that arrives after it', () => {
    // Boot hydration / READY are snapshotted before this device's own connect
    // recomputes the status; they can land after the frame and still say
    // 'idle'. The frame wins.
    const live = selfStatusFromFrame('1', {
      user_id: '1',
      status: 'online',
      guild_id: null,
      chosen_status: 'online',
    });
    expect(resolveSelfStatus(user, live)).toEqual({ status: 'online', chosenStatus: 'online' });
  });

  it('ignores a frame for another account (signed out and back in as someone else)', () => {
    const live = selfStatusFromFrame('2', {
      user_id: '2',
      status: 'dnd',
      guild_id: null,
      chosen_status: 'dnd',
    });
    expect(resolveSelfStatus(user, live)).toEqual({ status: 'idle', chosenStatus: 'online' });
  });
});
