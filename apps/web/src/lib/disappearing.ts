/**
 * Disappearing messages
 * ---------------------
 * Pure helpers for Signal-style disappearing messages: the timer presets and
 * their labels, the Custom Time picker's number + unit math, the in-chat
 * notice text, and the local-deadline bookkeeping the AppState scheduler runs
 * on. No React, no DOM — the vitest suite (test/disappearing.test.ts) drives
 * every function here directly.
 *
 * The model (mirrors the server):
 *   - A DM has one timer (seconds, or null = off). Each message keeps the
 *     timer it was SENT with (`Message.expireAfterSeconds`), so a change only
 *     affects later messages.
 *   - The countdown starts when a recipient reads the message (the read ack).
 *     The server then knows `expires_at` and tells the reader (and, with read
 *     receipts on, the author) through MESSAGE_EXPIRY; REST pages carry it as
 *     `Message.expiresAt`.
 *   - At `expires_at` the row disappears for everyone: the server sweep sends
 *     MESSAGE_DELETE, and clients hide it locally at the deadline.
 *
 * Deadlines are kept in SERVER time (epoch ms of `expires_at`) and compared
 * against the device clock shifted by the server offset learned from
 * MESSAGE_EXPIRY's `server_now`, so a device whose clock is off doesn't hide
 * messages early or keep them late. Until an offset is known the device
 * clock is taken as-is.
 */

/** The description on the Disappearing Messages screen (Signal's copy). */
export const DISAPPEARING_DESCRIPTION =
  'When enabled, new messages sent and received in this chat will disappear after they have been seen.';

/** Longest timer a current server accepts: 4 weeks. */
export const MAX_TIMER_SECONDS = 2_419_200;

/** Inclusive range of timer values (seconds) the server accepts. */
export interface TimerBounds {
  min: number;
  max: number;
}

/** A current server: 1 s .. 4 weeks. */
export const TIMER_BOUNDS: TimerBounds = { min: 1, max: MAX_TIMER_SECONDS };

/** A server from before Signal-style timers (getDmSettings without
    maxTtlSeconds) validates 10..86400 s. Offering only values inside that
    range keeps a mid-deploy or separately deployed API from 400ing. */
export const LEGACY_TIMER_BOUNDS: TimerBounds = { min: 10, max: 86_400 };

/** Bounds from getDmSettings' `maxTtlSeconds` (absent on older servers). */
export function timerBoundsFor(maxTtlSeconds: number | null | undefined): TimerBounds {
  if (typeof maxTtlSeconds === 'number' && Number.isFinite(maxTtlSeconds) && maxTtlSeconds >= 1) {
    return { min: 1, max: Math.floor(maxTtlSeconds) };
  }
  return LEGACY_TIMER_BOUNDS;
}

export function withinBounds(seconds: number, bounds: TimerBounds): boolean {
  return Number.isInteger(seconds) && seconds >= bounds.min && seconds <= bounds.max;
}

/** The fixed choices, in Signal's order (longest first). */
export const PRESET_SECONDS: readonly number[] = [2_419_200, 604_800, 86_400, 28_800, 3_600, 300, 30];

/** A value is a preset only if it equals one of the seven; anything else
    (60, 120, 90, 259200 …) is Custom. */
export function isPreset(seconds: number | null | undefined): boolean {
  return typeof seconds === 'number' && PRESET_SECONDS.includes(seconds);
}

/** The presets a server with these bounds accepts. */
export function presetsWithin(bounds: TimerBounds): number[] {
  return PRESET_SECONDS.filter((s) => withinBounds(s, bounds));
}

// ── Formatting ────────────────────────────────────────────────────────────

const PARTS: ReadonlyArray<{ seconds: number; singular: string; short: string }> = [
  { seconds: 604_800, singular: 'week', short: 'w' },
  { seconds: 86_400, singular: 'day', short: 'd' },
  { seconds: 3_600, singular: 'hour', short: 'h' },
  { seconds: 60, singular: 'minute', short: 'm' },
  { seconds: 1, singular: 'second', short: 's' },
];

/** Non-zero weeks / days / hours / minutes / seconds, largest first. */
function decompose(seconds: number): Array<{ n: number; singular: string; short: string }> {
  let rest = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const out: Array<{ n: number; singular: string; short: string }> = [];
  for (const p of PARTS) {
    const n = Math.floor(rest / p.seconds);
    if (n > 0) {
      out.push({ n, singular: p.singular, short: p.short });
      rest -= n * p.seconds;
    }
  }
  return out;
}

/** "4 weeks", "1 day", "1 minute 30 seconds". Identical on every platform
    and in the server's fallback notice text. */
export function formatLong(seconds: number): string {
  const parts = decompose(seconds);
  if (parts.length === 0) return '0 seconds';
  return parts.map(({ n, singular }) => `${n} ${singular}${n === 1 ? '' : 's'}`).join(' ');
}

/** "4w", "1d", "8h", "1m 30s" — the header indicator. */
export function formatShort(seconds: number): string {
  const parts = decompose(seconds);
  if (parts.length === 0) return '0s';
  return parts.map(({ n, short }) => `${n}${short}`).join(' ');
}

/** A DM setting as a label: "Off" for null / non-positive, else formatLong. */
export function formatTimer(value: number | null | undefined): string {
  return typeof value === 'number' && value > 0 ? formatLong(value) : 'Off';
}

/** Tooltip for the per-message timer icon. */
export function disappearingHint(expireAfterSeconds: number): string {
  return `Disappears ${formatLong(expireAfterSeconds)} after it's seen`;
}

// ── Custom Time picker ────────────────────────────────────────────────────

export type TimerUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks';

export interface UnitSpec {
  unit: TimerUnit;
  seconds: number;
  /** Largest number the picker offers for this unit. */
  max: number;
  singular: string;
  plural: string;
}

/** Smallest unit first — the order the unit column lists them. */
export const UNITS: readonly UnitSpec[] = [
  { unit: 'seconds', seconds: 1, max: 59, singular: 'second', plural: 'seconds' },
  { unit: 'minutes', seconds: 60, max: 59, singular: 'minute', plural: 'minutes' },
  { unit: 'hours', seconds: 3_600, max: 23, singular: 'hour', plural: 'hours' },
  { unit: 'days', seconds: 86_400, max: 6, singular: 'day', plural: 'days' },
  { unit: 'weeks', seconds: 604_800, max: 4, singular: 'week', plural: 'weeks' },
];

const UNITS_LARGEST_FIRST = [...UNITS].reverse();

export function unitSpec(unit: TimerUnit): UnitSpec {
  return UNITS.find((u) => u.unit === unit) ?? UNITS[0]!;
}

export interface CustomTime {
  n: number;
  unit: TimerUnit;
}

export function customSeconds(c: CustomTime): number {
  return c.n * unitSpec(c.unit).seconds;
}

/** The numbers the picker offers for `unit` (inclusive), narrowed to what
    the server accepts; null when no number of that unit fits. */
export function unitRange(unit: TimerUnit, bounds: TimerBounds = TIMER_BOUNDS): { min: number; max: number } | null {
  const spec = unitSpec(unit);
  const min = Math.max(1, Math.ceil(bounds.min / spec.seconds));
  const max = Math.min(spec.max, Math.floor(bounds.max / spec.seconds));
  return min <= max ? { min, max } : null;
}

/** Units that have at least one valid number under these bounds. */
export function availableUnits(bounds: TimerBounds = TIMER_BOUNDS): TimerUnit[] {
  return UNITS.filter((u) => unitRange(u.unit, bounds) !== null).map((u) => u.unit);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Clamp a number into `unit`'s range (a non-number becomes the minimum). */
export function clampCustomNumber(n: number, unit: TimerUnit, bounds: TimerBounds = TIMER_BOUNDS): number {
  const r = unitRange(unit, bounds);
  if (!r) return 1;
  const whole = Number.isFinite(n) ? Math.floor(n) : r.min;
  return clamp(whole, r.min, r.max);
}

/** Keep a picker value inside the bounds: an unavailable unit moves to the
    nearest available one, then the number is clamped. */
function fit(c: CustomTime, bounds: TimerBounds): CustomTime {
  const units = availableUnits(bounds);
  if (units.length === 0) return c;
  let unit = c.unit;
  if (!units.includes(unit)) {
    const tooBig = unitSpec(unit).seconds > bounds.max;
    unit = tooBig ? units[units.length - 1]! : units[0]!;
  }
  return { unit, n: clampCustomNumber(c.n, unit, bounds) };
}

/** Switching the unit keeps the number, clamped to the new unit's range. */
export function changeCustomUnit(c: CustomTime, unit: TimerUnit, bounds: TimerBounds = TIMER_BOUNDS): CustomTime {
  return fit({ n: c.n, unit }, bounds);
}

/**
 * The Custom Time picker's starting value for the current setting:
 *   - exactly n × one unit with n inside that unit's range → that;
 *   - otherwise the largest unit u with value ≥ u, n = clamp(⌊value / u⌋,
 *     1, max(u)) — 90 s → 1 minute, 25 h → 1 day, 10 days → 1 week;
 *   - no current value → 1 day.
 * The unit ranges don't overlap, so the exact match is unique.
 */
export function customInitial(value: number | null | undefined, bounds: TimerBounds = TIMER_BOUNDS): CustomTime {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fit({ n: 1, unit: 'days' }, bounds);
  }
  const v = Math.floor(value);
  for (const spec of UNITS_LARGEST_FIRST) {
    if (v % spec.seconds === 0) {
      const n = v / spec.seconds;
      if (n >= 1 && n <= spec.max) return fit({ n, unit: spec.unit }, bounds);
    }
  }
  for (const spec of UNITS_LARGEST_FIRST) {
    if (v >= spec.seconds) {
      return fit({ n: clamp(Math.floor(v / spec.seconds), 1, spec.max), unit: spec.unit }, bounds);
    }
  }
  return fit({ n: 1, unit: 'seconds' }, bounds);
}

// ── The in-chat notice ────────────────────────────────────────────────────

/** "You set disappearing messages to 1 day." / "Alex turned off
    disappearing messages." `timerSeconds` 0 (or less) means off. */
export function noticeText({
  timerSeconds,
  isSelf,
  name,
}: {
  timerSeconds: number;
  isSelf: boolean;
  name: string;
}): string {
  const who = isSelf ? 'You' : name;
  return timerSeconds > 0
    ? `${who} set disappearing messages to ${formatLong(timerSeconds)}.`
    : `${who} turned off disappearing messages.`;
}

/** The timer-change notice row: type 'system_disappearing', or (defensively)
    any row carrying the 'disappearing_timer' metadata. */
export function isDisappearingNotice(m: {
  type: string;
  metadata?: { kind: string } | null;
}): boolean {
  return m.type === 'system_disappearing' || m.metadata?.kind === 'disappearing_timer';
}

// ── Local deadlines ───────────────────────────────────────────────────────

/** setTimeout's largest delay. A longer one (4 weeks is 2,419,200,000 ms)
    fires IMMEDIATELY, so every delay is clamped and the time re-checked when
    the timer fires. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Fire a hair after the deadline so the re-check sees it as passed. */
const FIRE_SLACK_MS = 50;

/** How long a passed deadline is remembered after it fired — long enough
    that a refetch racing the sweep can't bring the row back (the server's
    read paths drop it from then on). */
export const DEADLINE_RETAIN_MS = 10 * 60_000;

/** Epoch ms of a server ISO time; null when absent or unparseable. */
export function parseServerTime(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** serverTime − deviceTime from an event's `server_now` and the device time
    it arrived. Delivery latency makes this a slight underestimate, which
    only ever makes a local deadline fire a little late, never early. */
export function serverOffsetFrom(serverNowIso: string | null | undefined, receivedAtMs: number): number | null {
  const t = parseServerTime(serverNowIso);
  return t === null || !Number.isFinite(receivedAtMs) ? null : t - receivedAtMs;
}

/** The device clock in server time. */
export function serverNow(offsetMs: number | null, deviceNowMs: number = Date.now()): number {
  return deviceNowMs + (offsetMs ?? 0);
}

/** setTimeout delay until a server-time deadline, clamped to [0, MAX]. */
export function timeoutUntil(deadlineMs: number, offsetMs: number | null, deviceNowMs: number = Date.now()): number {
  const ms = deadlineMs - serverNow(offsetMs, deviceNowMs) + FIRE_SLACK_MS;
  return clamp(Math.ceil(ms), 0, MAX_TIMEOUT_MS);
}

/** The earliest deadline still in the future, or null. */
export function nextDeadline(deadlines: Readonly<Record<string, number>>, nowMs: number): number | null {
  let best: number | null = null;
  for (const id in deadlines) {
    const d = deadlines[id]!;
    if (d > nowMs && (best === null || d < best)) best = d;
  }
  return best;
}

/** Record deadlines; the SAME object back when nothing changed (no
    re-render churn). The server never moves an expires_at, so a repeat is a
    no-op; a different value is taken as the newer truth. */
export function mergeDeadlines(
  deadlines: Record<string, number>,
  entries: Iterable<readonly [string, number]>,
): Record<string, number> {
  let next: Record<string, number> | null = null;
  for (const [id, at] of entries) {
    if (!Number.isFinite(at)) continue;
    if ((next ?? deadlines)[id] === at) continue;
    next ??= { ...deadlines };
    next[id] = at;
  }
  return next ?? deadlines;
}

/** Deadlines carried by REST rows (`expiresAt`), merged in. */
export function harvestDeadlines(
  deadlines: Record<string, number>,
  messages: ReadonlyArray<{ id: string; expiresAt?: string | null }>,
): Record<string, number> {
  const found: Array<[string, number]> = [];
  for (const m of messages) {
    const at = parseServerTime(m.expiresAt);
    if (at !== null) found.push([m.id, at]);
  }
  return found.length === 0 ? deadlines : mergeDeadlines(deadlines, found);
}

/** `list` without the rows whose deadline has passed; the SAME array when
    none has. */
export function dropExpired<T extends { id: string }>(
  list: T[],
  deadlines: Readonly<Record<string, number>>,
  nowMs: number,
): T[] {
  let any = false;
  for (const m of list) {
    const d = deadlines[m.id];
    if (d !== undefined && d <= nowMs) {
      any = true;
      break;
    }
  }
  if (!any) return list;
  return list.filter((m) => {
    const d = deadlines[m.id];
    return d === undefined || d > nowMs;
  });
}

/**
 * The local expiry scheduler: ONE timer for every countdown, armed for the
 * earliest future deadline. Each run calls `expire` (which removes whatever
 * is due — it re-checks the time itself, so a timer that fires early because
 * of the clamp, or late in a throttled background tab, never hides a message
 * before its time) and then re-arms for the next deadline. A delay past
 * setTimeout's limit is clamped and the run simply re-arms. It runs once
 * immediately; `recheck` runs it again (the caller wires focus /
 * visibilitychange), `cancel` stops it.
 */
export function scheduleExpiry({
  deadlines,
  offsetMs,
  expire,
  now = Date.now,
}: {
  deadlines: Readonly<Record<string, number>>;
  offsetMs: number | null;
  expire: () => void;
  now?: () => number;
}): { recheck: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    expire();
    const deviceNow = now();
    const next = nextDeadline(deadlines, serverNow(offsetMs, deviceNow));
    if (next === null) return;
    timer = setTimeout(run, timeoutUntil(next, offsetMs, deviceNow));
  };
  run();
  return {
    recheck: run,
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Forget deadlines that passed more than `retainMs` ago; the SAME object
    when there are none. */
export function pruneDeadlines(
  deadlines: Record<string, number>,
  nowMs: number,
  retainMs: number = DEADLINE_RETAIN_MS,
): Record<string, number> {
  let next: Record<string, number> | null = null;
  for (const id in deadlines) {
    if (deadlines[id]! < nowMs - retainMs) {
      next ??= { ...deadlines };
      delete next[id];
    }
  }
  return next ?? deadlines;
}
