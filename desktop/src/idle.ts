/**
 * Whether the machine counts as idle (away) for the web app's presence: idle
 * once there has been no input for the threshold, and idle the whole time the
 * screen is locked or the machine is asleep — until it is unlocked / resumed.
 *
 * The HID idle time alone can't say that: it does not jump when the screen
 * locks, so right after a lock it reads a few seconds and a poll would call a
 * locked machine active again for ~10 more minutes. So the lock and sleep
 * events set flags that only unlock / resume clear, and the OS's own "locked"
 * reading (powerMonitor.getSystemIdleState, on macOS and Windows) counts too —
 * it also covers a machine that was locked before the app started.
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
  // A plain field, not a parameter property: `npm test` runs this file
  // through Node's type stripping, which can't rewrite those.
  private readonly thresholdSec: number;

  constructor(thresholdSec: number) {
    this.thresholdSec = thresholdSec;
  }

  /** Periodic poll. Returns the idle state, or null for "no change" (the
      sample could not be read and nothing else decides). */
  poll(sample: IdleSample | null): boolean | null {
    if (this.locked || this.suspended) return true;
    if (!sample) return null;
    return sample.systemLocked || sample.idleSec >= this.thresholdSec;
  }

  lockScreen(): boolean {
    this.locked = true;
    return true;
  }

  suspend(): boolean {
    this.suspended = true;
    return true;
  }

  /** Unlock / resume: back to the input-based reading — still idle while the
      other flag holds (a resume onto the lock screen, before its unlock) or
      the OS reports the screen locked. */
  unlockScreen(sample: IdleSample | null): boolean {
    this.locked = false;
    return this.wake(sample);
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
