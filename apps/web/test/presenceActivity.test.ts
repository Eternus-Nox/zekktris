import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeviceActivity,
  IDLE_AFTER_MS,
  INPUT_THROTTLE_MS,
  chosenStatusOf,
  selfPresencePatch,
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

describe('selfPresencePatch', () => {
  const me = { id: '1', status: 'online' as const, chosenStatus: 'online' as const };

  it('takes the effective status from our own guild_id=null frame', () => {
    expect(selfPresencePatch(me, { user_id: '1', status: 'idle', guild_id: null })).toEqual({
      status: 'idle',
    });
  });

  it('ignores per-guild copies and other users', () => {
    expect(selfPresencePatch(me, { user_id: '1', status: 'idle', guild_id: '9' })).toBeNull();
    expect(selfPresencePatch(me, { user_id: '2', status: 'idle', guild_id: null })).toBeNull();
  });

  it('returns null when nothing changes', () => {
    expect(
      selfPresencePatch(me, { user_id: '1', status: 'online', guild_id: null, chosen_status: 'online' }),
    ).toBeNull();
  });

  it('syncs a status picked on another device', () => {
    expect(
      selfPresencePatch(me, { user_id: '1', status: 'dnd', guild_id: null, chosen_status: 'dnd' }),
    ).toEqual({ status: 'dnd', chosenStatus: 'dnd' });
  });

  it('unmasks invisible for our own dot', () => {
    expect(
      selfPresencePatch(me, {
        user_id: '1',
        status: 'offline',
        guild_id: null,
        chosen_status: 'invisible',
      }),
    ).toEqual({ status: 'invisible', chosenStatus: 'invisible' });
    const invisible = { id: '1', status: 'invisible' as const, chosenStatus: 'invisible' as const };
    expect(selfPresencePatch(invisible, { user_id: '1', status: 'offline', guild_id: null })).toBeNull();
  });
});
