/**
 * Device activity — is the person using THIS device right now?
 * -------------------------------------------------------------
 * On a server with multi-device presence (READY `features.presence_activity`)
 * the user's status follows the device actually in use: each connection
 * reports active / idle and the server shows chosen 'online' as Online while
 * ANY device is active, and as Away ('idle') while Zekktris is open somewhere
 * but nobody is using it. This module decides the "active" half for the web
 * app; usePresenceActivity wires it to the DOM, the desktop shell and the
 * gateway (which sends only the transitions).
 *
 *   - browser: active = tab visible AND input (pointer / key / wheel / touch,
 *     or showing the tab) within IDLE_AFTER_MS. Hidden → idle at once.
 *   - desktop shell: active = the shell's system-wide signal (not idle past
 *     its threshold, not locked / suspended) — using another app on the
 *     computer still counts as being at it, like Discord.
 *   - either: talking in a voice call counts as input for as long as it lasts
 *     (in the browser only while the tab is visible — hidden is idle).
 *
 * Pure apart from the injected clock, so the transitions are unit-tested.
 */

/** No input for this long → idle (browser). Same threshold as iOS/Android. */
export const IDLE_AFTER_MS = 5 * 60_000;

/** Input closer than this to the last one isn't re-recorded while active:
 *  pointermove and friends fire at frame rate, and second precision is
 *  plenty against a five-minute window. */
export const INPUT_THROTTLE_MS = 1_000;

export type ActivityMode = 'browser' | 'desktop';

export interface ActivityClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ActivityClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface DeviceActivityOptions {
  mode: ActivityMode;
  /** Whether the page is visible right now (browser mode). */
  visible: boolean;
  /** Called on every active↔idle transition, never with a repeat. */
  onChange: (active: boolean) => void;
  clock?: ActivityClock;
  idleAfterMs?: number;
}

export class DeviceActivity {
  private readonly mode: ActivityMode;
  private readonly clock: ActivityClock;
  private readonly idleAfterMs: number;
  private readonly onChange: (active: boolean) => void;
  private visible: boolean;
  private systemIdle = false;
  private speaking = false;
  /** Opening the app is an interaction: the window starts fresh. */
  private lastInput: number;
  private active: boolean;
  /** One pending expiry check at most; input never re-arms it (cheap). */
  private timer: unknown = null;
  private disposed = false;

  constructor(opts: DeviceActivityOptions) {
    this.mode = opts.mode;
    this.clock = opts.clock ?? realClock;
    this.idleAfterMs = opts.idleAfterMs ?? IDLE_AFTER_MS;
    this.onChange = opts.onChange;
    this.visible = opts.visible;
    this.lastInput = this.clock.now();
    this.active = this.compute();
    this.arm();
  }

  isActive(): boolean {
    return this.active;
  }

  /** A user input event on this page. */
  input(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    if (this.active && now - this.lastInput < INPUT_THROTTLE_MS) return;
    this.lastInput = now;
    this.update();
  }

  /** Page visibility changed. Showing the tab is itself an interaction. */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (visible) this.lastInput = this.clock.now();
    this.update();
  }

  /** The desktop shell's system idle / locked signal (desktop mode). */
  setSystemIdle(idle: boolean): void {
    if (this.disposed || idle === this.systemIdle) return;
    this.systemIdle = idle;
    this.update();
  }

  /** Whether this user is talking in a voice call on this device. The end of
   *  a stretch of talking counts as an input at that moment. */
  setSpeaking(speaking: boolean): void {
    if (this.disposed || speaking === this.speaking) return;
    this.speaking = speaking;
    if (!speaking) this.lastInput = this.clock.now();
    this.update();
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  private compute(): boolean {
    if (this.mode === 'desktop') return this.speaking || !this.systemIdle;
    if (!this.visible) return false;
    return this.speaking || this.clock.now() - this.lastInput < this.idleAfterMs;
  }

  private update(): void {
    const next = this.compute();
    this.arm();
    if (next === this.active) return;
    this.active = next;
    this.onChange(next);
  }

  /** Browser mode: while activity rests on the input window alone, keep one
   *  timer pending for when it would lapse. When it fires it re-checks — an
   *  input since then simply pushes the next check out. */
  private arm(): void {
    const needed =
      this.mode === 'browser' && this.visible && !this.speaking && this.compute();
    if (!needed) {
      this.disarm();
      return;
    }
    if (this.timer !== null) return;
    const remaining = this.lastInput + this.idleAfterMs - this.clock.now();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.disposed) this.update();
    }, Math.max(0, remaining));
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

// ── Self status ───────────────────────────────────────────────────────────

export type ChosenStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type EffectiveStatus = ChosenStatus | 'offline';

interface SelfStatusFields {
  status: EffectiveStatus;
  chosenStatus?: ChosenStatus;
}

/**
 * What the status picker shows: the CHOSEN status. A server that predates
 * multi-device presence sends no chosenStatus — there `status` is the pick
 * (an 'offline' there can only be a stale snapshot; show Online).
 */
export function chosenStatusOf(user: SelfStatusFields): ChosenStatus {
  if (user.chosenStatus) return user.chosenStatus;
  return user.status === 'offline' ? 'online' : user.status;
}

/** PRESENCE_UPDATE dispatch payload, as it reaches the user's own devices. */
export interface PresenceUpdateFrame {
  user_id: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  guild_id: string | null;
  /** Only on the guild_id=null frame to the subject's own connections. */
  chosen_status?: ChosenStatus;
}

/** Our own status as the server last told this device. */
export interface SelfStatus {
  userId: string;
  /** Effective, UNMASKED: a chosen Invisible reads 'invisible', not 'offline'. */
  status: EffectiveStatus;
  chosenStatus: ChosenStatus;
}

/**
 * Our own status from a PRESENCE_UPDATE, or null when the frame isn't the one
 * that says it. The server sends one frame per shared guild plus a
 * guild_id=null one, and only that last one — to our own connections — carries
 * chosen_status; a server without multi-device presence never sends it, so
 * there the auth user's fields stay the source. `status` in it is masked
 * ('invisible' reads 'offline'); a user who chose Invisible keeps seeing their
 * own dot as invisible.
 */
export function selfStatusFromFrame(selfId: string, d: PresenceUpdateFrame): SelfStatus | null {
  if (!selfId || d.user_id !== selfId || d.guild_id != null || !d.chosen_status) return null;
  const status: EffectiveStatus =
    d.chosen_status === 'invisible' && d.status === 'offline' ? 'invisible' : d.status;
  return { userId: selfId, status, chosenStatus: d.chosen_status };
}

/**
 * Holds the latest SelfStatus — deliberately OUTSIDE the auth user. The
 * effective status now changes on every tab hide / show and input lapse, on
 * every device; the auth user object is a dependency of the app's bootstrap,
 * gateway-subscription and typing effects, so replacing it that often
 * refetched guilds, DMs, read states (… 8 REST calls) and wiped typing
 * indicators each time. Only the components that draw our status subscribe
 * here. A REST snapshot of the user (boot hydration, READY) can't overwrite
 * it either: those are taken before this device's own connect recomputes the
 * status, so they can land after — and be older than — the frame.
 */
export class SelfStatusStore {
  private value: SelfStatus | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): SelfStatus | null => this.value;

  set(next: SelfStatus): void {
    const v = this.value;
    if (
      v &&
      v.userId === next.userId &&
      v.status === next.status &&
      v.chosenStatus === next.chosenStatus
    ) {
      return;
    }
    this.value = next;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/**
 * The status our own dot shows and the one the picker shows: the server's
 * latest word for this user when we have it, else the auth user's snapshot
 * (an older server, or before the first frame after connecting).
 */
export function resolveSelfStatus(
  user: { id: string } & SelfStatusFields,
  live: SelfStatus | null,
): { status: EffectiveStatus; chosenStatus: ChosenStatus } {
  if (live && live.userId === user.id) {
    return { status: live.status, chosenStatus: live.chosenStatus };
  }
  return { status: user.status, chosenStatus: chosenStatusOf(user) };
}
