import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GatewayClient, RestClient } from '@zekktris/client';
import {
  DISAPPEARING_DESCRIPTION,
  LEGACY_TIMER_BOUNDS,
  MAX_TIMEOUT_MS,
  PRESET_SECONDS,
  TIMER_BOUNDS,
  availableUnits,
  changeCustomUnit,
  clampCustomNumber,
  customInitial,
  customSeconds,
  dropExpired,
  formatLong,
  formatShort,
  formatTimer,
  harvestDeadlines,
  isDisappearingNotice,
  isPreset,
  mergeDeadlines,
  nextDeadline,
  noticeText,
  presetsWithin,
  pruneDeadlines,
  scheduleExpiry,
  serverNow,
  serverOffsetFrom,
  timeoutUntil,
  timerBoundsFor,
  unitRange,
  withinBounds,
} from '../src/lib/disappearing';

// Signal-style disappearing messages: the pure pieces the web client runs on
// (src/lib/disappearing.ts) — labels, the Custom Time picker math, the notice
// text, and the local-deadline scheduler — plus the REST / gateway wire shapes
// installed apps depend on.

const WEEK = 604_800;
const DAY = 86_400;
const HOUR = 3_600;
const MIN = 60;

describe('presets and labels', () => {
  it('lists Signal’s seven presets, longest first', () => {
    expect(PRESET_SECONDS).toEqual([2_419_200, 604_800, 86_400, 28_800, 3_600, 300, 30]);
    expect(PRESET_SECONDS.map(formatLong)).toEqual([
      '4 weeks',
      '1 week',
      '1 day',
      '8 hours',
      '1 hour',
      '5 minutes',
      '30 seconds',
    ]);
    expect(PRESET_SECONDS.map(formatShort)).toEqual(['4w', '1w', '1d', '8h', '1h', '5m', '30s']);
  });

  it('formats any value as every non-zero part, largest first, singular for 1', () => {
    expect(formatLong(259_200)).toBe('3 days');
    expect(formatLong(60)).toBe('1 minute');
    expect(formatLong(120)).toBe('2 minutes');
    expect(formatLong(90)).toBe('1 minute 30 seconds');
    expect(formatLong(1)).toBe('1 second');
    expect(formatLong(25 * HOUR)).toBe('1 day 1 hour');
    expect(formatLong(10 * DAY)).toBe('1 week 3 days');
    expect(formatLong(WEEK + DAY + HOUR + MIN + 1)).toBe('1 week 1 day 1 hour 1 minute 1 second');
    expect(formatShort(90)).toBe('1m 30s');
    expect(formatShort(25 * HOUR)).toBe('1d 1h');
  });

  it('labels the setting itself: Off for null, else the long label', () => {
    expect(formatTimer(null)).toBe('Off');
    expect(formatTimer(undefined)).toBe('Off');
    expect(formatTimer(0)).toBe('Off');
    expect(formatTimer(86_400)).toBe('1 day');
  });

  it('only the seven exact values are presets; everything else is Custom', () => {
    for (const s of PRESET_SECONDS) expect(isPreset(s)).toBe(true);
    for (const s of [60, 120, 90, 259_200, 1, 10, 3_599]) expect(isPreset(s)).toBe(false);
    expect(isPreset(null)).toBe(false);
    // The old web choices (30 s / 1 min / 2 min) still read sensibly.
    expect([30, 60, 120].map(formatLong)).toEqual(['30 seconds', '1 minute', '2 minutes']);
  });

  it('keeps the screen’s description verbatim', () => {
    expect(DISAPPEARING_DESCRIPTION).toBe(
      'When enabled, new messages sent and received in this chat will disappear after they have been seen.',
    );
  });
});

describe('server bounds', () => {
  it('uses maxTtlSeconds when the server reports it, else the old 10 s .. 1 day', () => {
    expect(timerBoundsFor(2_419_200)).toEqual({ min: 1, max: 2_419_200 });
    expect(timerBoundsFor(undefined)).toEqual(LEGACY_TIMER_BOUNDS);
    expect(timerBoundsFor(null)).toEqual({ min: 10, max: 86_400 });
  });

  it('an old server is offered only presets inside its range', () => {
    expect(presetsWithin(TIMER_BOUNDS)).toEqual([...PRESET_SECONDS]);
    expect(presetsWithin(LEGACY_TIMER_BOUNDS)).toEqual([86_400, 28_800, 3_600, 300, 30]);
  });

  it('checks values against the bounds', () => {
    expect(withinBounds(1, TIMER_BOUNDS)).toBe(true);
    expect(withinBounds(2_419_200, TIMER_BOUNDS)).toBe(true);
    expect(withinBounds(0, TIMER_BOUNDS)).toBe(false);
    expect(withinBounds(2_419_201, TIMER_BOUNDS)).toBe(false);
    expect(withinBounds(1.5, TIMER_BOUNDS)).toBe(false);
    expect(withinBounds(5, LEGACY_TIMER_BOUNDS)).toBe(false);
  });
});

describe('Custom Time picker', () => {
  it('offers seconds 1–59, minutes 1–59, hours 1–23, days 1–6, weeks 1–4', () => {
    expect(unitRange('seconds')).toEqual({ min: 1, max: 59 });
    expect(unitRange('minutes')).toEqual({ min: 1, max: 59 });
    expect(unitRange('hours')).toEqual({ min: 1, max: 23 });
    expect(unitRange('days')).toEqual({ min: 1, max: 6 });
    expect(unitRange('weeks')).toEqual({ min: 1, max: 4 });
    expect(availableUnits()).toEqual(['seconds', 'minutes', 'hours', 'days', 'weeks']);
  });

  it('narrows the columns to an old server’s range', () => {
    expect(unitRange('seconds', LEGACY_TIMER_BOUNDS)).toEqual({ min: 10, max: 59 });
    expect(unitRange('days', LEGACY_TIMER_BOUNDS)).toEqual({ min: 1, max: 1 });
    expect(unitRange('weeks', LEGACY_TIMER_BOUNDS)).toBeNull();
    expect(availableUnits(LEGACY_TIMER_BOUNDS)).toEqual(['seconds', 'minutes', 'hours', 'days']);
  });

  it('round-trips every unit bound exactly', () => {
    const cases: Array<[number, number, string]> = [
      [1, 1, 'seconds'],
      [59, 59, 'seconds'],
      [MIN, 1, 'minutes'],
      [59 * MIN, 59, 'minutes'],
      [HOUR, 1, 'hours'],
      [23 * HOUR, 23, 'hours'],
      [DAY, 1, 'days'],
      [6 * DAY, 6, 'days'],
      [WEEK, 1, 'weeks'],
      [4 * WEEK, 4, 'weeks'],
    ];
    for (const [value, n, unit] of cases) {
      const c = customInitial(value);
      expect(c).toEqual({ n, unit });
      expect(customSeconds(c)).toBe(value);
    }
  });

  it('starts a value the columns can’t express at the largest fitting unit', () => {
    expect(customInitial(90)).toEqual({ n: 1, unit: 'minutes' });
    expect(customInitial(25 * HOUR)).toEqual({ n: 1, unit: 'days' });
    expect(customInitial(10 * DAY)).toEqual({ n: 1, unit: 'weeks' });
    expect(customInitial(259_200)).toEqual({ n: 3, unit: 'days' });
    // Over the top of the weeks column → clamped to 4 weeks.
    expect(customInitial(5 * WEEK)).toEqual({ n: 4, unit: 'weeks' });
  });

  it('starts at 1 day when there is no current value', () => {
    expect(customInitial(null)).toEqual({ n: 1, unit: 'days' });
    expect(customInitial(undefined, LEGACY_TIMER_BOUNDS)).toEqual({ n: 1, unit: 'days' });
  });

  it('clamps the number to the new unit when the unit changes', () => {
    expect(changeCustomUnit({ n: 45, unit: 'minutes' }, 'hours')).toEqual({ n: 23, unit: 'hours' });
    expect(changeCustomUnit({ n: 30, unit: 'seconds' }, 'days')).toEqual({ n: 6, unit: 'days' });
    expect(changeCustomUnit({ n: 6, unit: 'days' }, 'weeks')).toEqual({ n: 4, unit: 'weeks' });
    expect(changeCustomUnit({ n: 3, unit: 'weeks' }, 'seconds')).toEqual({ n: 3, unit: 'seconds' });
    // An old server: no weeks, and seconds start at 10.
    expect(changeCustomUnit({ n: 2, unit: 'minutes' }, 'weeks', LEGACY_TIMER_BOUNDS)).toEqual({
      n: 1,
      unit: 'days',
    });
    expect(changeCustomUnit({ n: 2, unit: 'minutes' }, 'seconds', LEGACY_TIMER_BOUNDS)).toEqual({
      n: 10,
      unit: 'seconds',
    });
    expect(clampCustomNumber(0, 'hours')).toBe(1);
    expect(clampCustomNumber(Number.NaN, 'hours')).toBe(1);
    expect(clampCustomNumber(99, 'hours')).toBe(23);
  });
});

describe('the timer-change notice', () => {
  it('reads You… for the changer and the name for everyone else', () => {
    expect(noticeText({ timerSeconds: 86_400, isSelf: true, name: 'Alex' })).toBe(
      'You set disappearing messages to 1 day.',
    );
    expect(noticeText({ timerSeconds: 86_400, isSelf: false, name: 'Ally (nickname)' })).toBe(
      'Ally (nickname) set disappearing messages to 1 day.',
    );
    expect(noticeText({ timerSeconds: 0, isSelf: true, name: 'Alex' })).toBe(
      'You turned off disappearing messages.',
    );
    expect(noticeText({ timerSeconds: 0, isSelf: false, name: 'Alex' })).toBe(
      'Alex turned off disappearing messages.',
    );
    expect(noticeText({ timerSeconds: 90, isSelf: false, name: 'Alex' })).toBe(
      'Alex set disappearing messages to 1 minute 30 seconds.',
    );
  });

  it('recognises the row by type or by its metadata', () => {
    expect(isDisappearingNotice({ type: 'system_disappearing' })).toBe(true);
    expect(
      isDisappearingNotice({ type: 'default', metadata: { kind: 'disappearing_timer' } }),
    ).toBe(true);
    expect(isDisappearingNotice({ type: 'default', metadata: { kind: 'poke' } })).toBe(false);
    expect(isDisappearingNotice({ type: 'system_call', metadata: null })).toBe(false);
  });
});

describe('local deadlines', () => {
  const T0 = Date.parse('2026-11-08T12:00:00.000Z');

  it('picks the earliest deadline still ahead; passed and exactly-now ones are not ahead', () => {
    expect(nextDeadline({}, T0)).toBeNull();
    expect(nextDeadline({ a: T0 + 5_000, b: T0 + 1_000, c: T0 - 1 }, T0)).toBe(T0 + 1_000);
    expect(nextDeadline({ a: T0 }, T0)).toBeNull();
    expect(nextDeadline({ a: T0 - 10 }, T0)).toBeNull();
  });

  it('drops rows at or past their deadline, and returns the same array when none are', () => {
    const list = [{ id: '1' }, { id: '2' }, { id: '3' }];
    expect(dropExpired(list, {}, T0)).toBe(list);
    expect(dropExpired(list, { '2': T0 + 1 }, T0)).toBe(list);
    expect(dropExpired(list, { '2': T0 }, T0).map((m) => m.id)).toEqual(['1', '3']);
    expect(dropExpired(list, { '1': T0 - 1, '3': T0 - 1 }, T0).map((m) => m.id)).toEqual(['2']);
  });

  it('records REST expiresAt without churn', () => {
    const empty: Record<string, number> = {};
    expect(harvestDeadlines(empty, [{ id: '1' }, { id: '2', expiresAt: null }])).toBe(empty);
    const d = harvestDeadlines(empty, [{ id: '1', expiresAt: '2026-11-08T12:00:30.000Z' }]);
    expect(d).toEqual({ '1': T0 + 30_000 });
    // The same value again is a no-op (same object); garbage is ignored.
    expect(harvestDeadlines(d, [{ id: '1', expiresAt: '2026-11-08T12:00:30.000Z' }])).toBe(d);
    expect(harvestDeadlines(d, [{ id: '9', expiresAt: 'not a date' }])).toBe(d);
    expect(mergeDeadlines(d, [['1', T0 + 30_000]])).toBe(d);
    expect(mergeDeadlines(d, [['2', T0 + 1]])).toEqual({ '1': T0 + 30_000, '2': T0 + 1 });
  });

  it('forgets deadlines long past, keeping recent ones (a refetch can’t resurrect the row)', () => {
    const d = { old: T0 - 11 * 60_000, recent: T0 - 60_000, ahead: T0 + 1 };
    expect(pruneDeadlines(d, T0)).toEqual({ recent: T0 - 60_000, ahead: T0 + 1 });
    const kept = { recent: T0 - 60_000 };
    expect(pruneDeadlines(kept, T0)).toBe(kept);
  });

  it('corrects for a skewed device clock with server_now', () => {
    // The device clock is 60 s FAST: the event says the server is at T0
    // while the device reads T0 + 60 s.
    const offset = serverOffsetFrom('2026-11-08T12:00:00.000Z', T0 + 60_000);
    expect(offset).toBe(-60_000);
    expect(serverNow(offset, T0 + 60_000)).toBe(T0);
    // A 30 s timer read at server T0 is still 30 s away, not already gone.
    const deadline = T0 + 30_000;
    expect(dropExpired([{ id: 'm' }], { m: deadline }, serverNow(offset, T0 + 60_000))).toHaveLength(1);
    expect(timeoutUntil(deadline, offset, T0 + 60_000)).toBeGreaterThanOrEqual(30_000);
    expect(timeoutUntil(deadline, offset, T0 + 60_000)).toBeLessThan(31_000);
    // Without a known offset the device clock is taken as-is.
    expect(serverNow(null, T0)).toBe(T0);
    expect(serverOffsetFrom(undefined, T0)).toBeNull();
    expect(serverOffsetFrom('garbage', T0)).toBeNull();
  });

  it('never asks setTimeout for more than 2^31 − 1 ms (4 weeks would fire at once)', () => {
    const fourWeeksMs = 2_419_200 * 1000;
    expect(fourWeeksMs).toBeGreaterThan(MAX_TIMEOUT_MS);
    expect(timeoutUntil(T0 + fourWeeksMs, null, T0)).toBe(MAX_TIMEOUT_MS);
    expect(timeoutUntil(T0 - 5_000, null, T0)).toBe(0);
  });
});

describe('scheduleExpiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A stand-in for MESSAGES_EXPIRE: records which ids are due right now. */
  function harness(deadlines: Record<string, number>, offsetMs: number | null = null) {
    const expired: string[] = [];
    const runs: number[] = [];
    const expire = () => {
      runs.push(Date.now());
      const now = serverNow(offsetMs);
      for (const id in deadlines) {
        if (deadlines[id]! <= now && !expired.includes(id)) expired.push(id);
      }
    };
    const s = scheduleExpiry({ deadlines, offsetMs, expire });
    return { expired, runs, s };
  }

  it('runs at once, then fires on time for the earliest deadline, then the next', () => {
    const now = Date.now();
    const { expired, runs, s } = harness({ a: now + 5_000, b: now + 1_000, c: now - 1 });
    expect(runs).toHaveLength(1);
    expect(expired).toEqual(['c']); // already due on the first run
    vi.advanceTimersByTime(999);
    expect(expired).toEqual(['c']);
    vi.advanceTimersByTime(100);
    expect(expired).toEqual(['c', 'b']);
    vi.advanceTimersByTime(4_000);
    expect(expired).toEqual(['c', 'b', 'a']);
    // Nothing left ahead → no timer armed.
    expect(vi.getTimerCount()).toBe(0);
    s.cancel();
  });

  it('re-arms after a clamped 4-week wait without expiring anything early', () => {
    const now = Date.now();
    const fourWeeksMs = 2_419_200 * 1000;
    const { expired, runs, s } = harness({ long: now + fourWeeksMs });
    vi.advanceTimersByTime(MAX_TIMEOUT_MS + 100);
    // The clamped timer fired, re-checked the time, found nothing due…
    expect(runs.length).toBe(2);
    expect(expired).toEqual([]);
    // …and re-armed for the remainder.
    vi.advanceTimersByTime(fourWeeksMs - MAX_TIMEOUT_MS - 200);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(expired).toEqual(['long']);
    s.cancel();
  });

  it('uses the server offset: a fast device clock does not fire early', () => {
    const serverT = Date.now() - 60_000; // device is 60 s fast
    const offset = -60_000;
    const { expired, s } = harness({ m: serverT + 30_000 }, offset);
    vi.advanceTimersByTime(29_000);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1_100);
    expect(expired).toEqual(['m']);
    s.cancel();
  });

  it('recheck runs immediately (focus / visibility), cancel stops it', () => {
    const now = Date.now();
    const { runs, s } = harness({ a: now + 10_000 });
    s.recheck();
    expect(runs).toHaveLength(2);
    s.cancel();
    vi.advanceTimersByTime(20_000);
    expect(runs).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RestClient DM settings (the key installed apps depend on)', () => {
  function capture(response: unknown) {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const client = new RestClient({
      baseUrl: 'https://example.test/api',
      getToken: () => 't',
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method,
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    } as ConstructorParameters<typeof RestClient>[0]);
    return { client, calls };
  }

  it('PATCHes ttlSecondsAfterRead for a timer and for off', async () => {
    const { client, calls } = capture({ ttlSecondsAfterRead: 604_800 });
    await client.updateDmSettings('42', 604_800);
    await client.updateDmSettings('42', null);
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['PATCH', 'https://example.test/api/users/@me/channels/42/settings', { ttlSecondsAfterRead: 604_800 }],
      ['PATCH', 'https://example.test/api/users/@me/channels/42/settings', { ttlSecondsAfterRead: null }],
    ]);
  });

  it('passes maxTtlSeconds through from GET (absent on older servers)', async () => {
    const { client } = capture({ ttlSecondsAfterRead: 30, notificationShowContent: null, maxTtlSeconds: 2_419_200 });
    const r = await client.getDmSettings('42');
    expect(r.maxTtlSeconds).toBe(2_419_200);
    expect(timerBoundsFor(r.maxTtlSeconds)).toEqual(TIMER_BOUNDS);
    const old = capture({ ttlSecondsAfterRead: 30, notificationShowContent: null });
    expect(timerBoundsFor((await old.client.getDmSettings('42')).maxTtlSeconds)).toEqual(LEGACY_TIMER_BOUNDS);
  });
});

describe('GatewayClient delivers the disappearing-messages events', () => {
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
    close(): void {
      this.readyState = 3;
    }
    serverSend(frame: unknown): void {
      for (const cb of this.listeners.message ?? []) cb({ data: JSON.stringify(frame) });
    }
  }

  beforeEach(() => {
    instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes MESSAGE_EXPIRY and DM_SETTINGS_UPDATE payloads through as sent; ignores unknown events', () => {
    const client = new GatewayClient({
      url: 'ws://test/gateway',
      getToken: () => 'tok',
      WebSocket: MockWS as unknown as typeof WebSocket,
    });
    const expiry: unknown[] = [];
    const settings: unknown[] = [];
    client.on('MESSAGE_EXPIRY', (d) => expiry.push(d));
    client.on('DM_SETTINGS_UPDATE', (d) => settings.push(d));
    client.start();
    const ws = instances[0]!;
    ws.serverSend({ op: 7, d: { heartbeat_interval: 30_000 } });
    ws.serverSend({ op: 0, t: 'READY', d: { session_id: 's' }, s: 1 });
    const expiryPayload = {
      channel_id: '7',
      expiries: [{ id: '100', expires_at: '2026-11-08T12:00:30.000Z' }],
      server_now: '2026-11-08T12:00:00.000Z',
    };
    ws.serverSend({ op: 0, t: 'MESSAGE_EXPIRY', d: expiryPayload, s: 2 });
    ws.serverSend({ op: 0, t: 'DM_SETTINGS_UPDATE', d: { channelId: '7', ttlSecondsAfterRead: 86_400 }, s: 3 });
    expect(() =>
      ws.serverSend({ op: 0, t: 'SOME_FUTURE_EVENT', d: { x: 1 }, s: 4 }),
    ).not.toThrow();
    expect(expiry).toEqual([expiryPayload]);
    expect(settings).toEqual([{ channelId: '7', ttlSecondsAfterRead: 86_400 }]);
  });
});
