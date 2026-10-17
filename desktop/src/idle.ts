/**
 * Whether the machine counts as idle (away) for the web app's presence: idle
 * once there has been no input for the threshold, and idle the whole time the
 * screen is locked or the machine is asleep — until it is unlocked / resumed.
 *
 * The HID idle time alone can't say that: it does not jump when the screen
 * locks, so right after a lock it reads a few seconds and a poll would call a
 * locked machine active again for ~10 more minutes. So the lock and sleep
 * events set flags that unlock / resume clear, and the OS's own "locked"
 * reading (powerMonitor.getSystemIdleState, on macOS and Windows) counts too —
 * it also covers a machine that was locked before the app started. In case an
 * unlock / resume event is ever missed, a poll also clears the flags when the
 * evidence says the user is back: input more recent than the lock / sleep,
 * with the OS not reporting the screen locked (typing a password on the lock
 * screen doesn't count — the OS still reads 'locked' then; 'lock-screen' is
 * macOS / Windows only, where that reading exists).
 *
 * Pure (no Electron imports) so it can be tested with plain Node — see
 * test/idle.test.ts. main.ts feeds it powerMonitor events and samples.
 */

/** One reading of the OS idle state; null when it could not be read
    (getSystemIdleTime can throw on some Linux setups). */
export interface IdleSample {
  /** Seconds since the last keyboard / mouse input. */
  idleSec: number;
  /** The OS reports the screen as locked (getSystemIdleState === 'locked'). */
  systemLocked: boolean;
}

export class IdleTracker {
  private locked = false;
  private suspended = false;
  /** When the earlier of the two flags was set (ms, per `now`). */
  private flaggedAt = 0;
  // Plain fields, not parameter properties: `npm test` runs this file
  // through Node's type stripping, which can't rewrite those.
  private readonly thresholdSec: number;
  private readonly now: () => number;

  constructor(thresholdSec: number, now: () => number = Date.now) {
    this.thresholdSec = thresholdSec;
    this.now = now;
  }

  /** Periodic poll. Returns the idle state, or null for "no change" (the
      sample could not be read and nothing else decides). */
  poll(sample: IdleSample | null): boolean | null {
    if (this.locked || this.suspended) {
      // Back without the unlock / resume event: there has been input since
      // the lock / sleep (whole seconds, so a lock this instant never
      // qualifies), and the OS doesn't report the screen locked.
      const sinceFlagSec = Math.floor((this.now() - this.flaggedAt) / 1000);
      if (!sample || sample.systemLocked || sample.idleSec >= sinceFlagSec) return true;
      this.locked = false;
      this.suspended = false;
    }
    if (!sample) return null;
    return sample.systemLocked || sample.idleSec >= this.thresholdSec;
  }

  lockScreen(): boolean {
    this.flag();
    this.locked = true;
    return true;
  }

  suspend(): boolean {
    this.flag();
    this.suspended = true;
    return true;
  }

  private flag(): void {
    if (!this.locked && !this.suspended) this.flaggedAt = this.now();
  }

  /** Unlock / resume: back to the input-based reading — still idle while the
      other flag holds (a resume onto the lock screen, before its unlock) or
      the OS reports the screen locked. */
  unlockScreen(sample: IdleSample | null): boolean {
    this.locked = false;
    // The unlock itself is the evidence: a sample taken inside the event can
    // still read 'locked' for a moment, which would hold Away until the next
    // poll (30 s) for no reason.
    return this.wake(sample && { ...sample, systemLocked: false });
  }

  resume(sample: IdleSample | null): boolean {
    this.suspended = false;
    return this.wake(sample);
  }

  private wake(sample: IdleSample | null): boolean {
    // Unreadable sample: unlock / resume means someone is back (the shell's
    // behaviour before lock tracking).
    return this.poll(sample) ?? false;
  }
}
