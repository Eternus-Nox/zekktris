// Run with `npm test` (Node 22.18+ runs TypeScript directly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleTracker } from '../src/idle.ts';

const THRESHOLD = 600;
const input = (idleSec: number, systemLocked = false) => ({ idleSec, systemLocked });

test('idle once input has lapsed past the threshold, active again on input', () => {
  const t = new IdleTracker(THRESHOLD);
  assert.equal(t.poll(input(5)), false);
  assert.equal(t.poll(input(599)), false);
  assert.equal(t.poll(input(600)), true);
  assert.equal(t.poll(input(2)), false);
});

test('a locked screen stays idle until unlock, whatever the input idle time', () => {
  const t = new IdleTracker(THRESHOLD);
  assert.equal(t.lockScreen(), true);
  // Right after a lock the HID idle time is only seconds; on a platform that
  // doesn't report 'locked' this used to read active on the next poll.
  assert.equal(t.poll(input(3)), true);
  assert.equal(t.poll(input(45)), true);
  assert.equal(t.poll(null), true);
  assert.equal(t.unlockScreen(input(0)), false);
  assert.equal(t.poll(input(30)), false);
});

test('a sleeping machine stays idle until resume', () => {
  const t = new IdleTracker(THRESHOLD);
  assert.equal(t.suspend(), true);
  assert.equal(t.poll(input(1)), true);
  assert.equal(t.resume(input(1)), false);
});

test('resuming onto the lock screen stays idle until the unlock', () => {
  const t = new IdleTracker(THRESHOLD);
  t.lockScreen();
  t.suspend();
  assert.equal(t.resume(input(0)), true);
  assert.equal(t.poll(input(10)), true);
  assert.equal(t.unlockScreen(input(0)), false);
});

test("the OS's own locked reading counts, with or without a lock event", () => {
  const t = new IdleTracker(THRESHOLD);
  // Locked before the app started: no lock-screen event ever arrives.
  assert.equal(t.poll(input(1, true)), true);
  // Resumed onto the lock screen without a lock-screen event.
  t.suspend();
  assert.equal(t.resume(input(0, true)), true);
  assert.equal(t.poll(input(0, false)), false);
});

test('an unreadable sample changes nothing unless locked / asleep', () => {
  const t = new IdleTracker(THRESHOLD);
  assert.equal(t.poll(null), null);
  t.lockScreen();
  assert.equal(t.poll(null), true);
  // Unlock with no reading: back at the machine.
  assert.equal(t.unlockScreen(null), false);
});
