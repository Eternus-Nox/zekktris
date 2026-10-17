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

// A fake clock: tests move time explicitly (whole seconds matter here).
function clock(startSec = 1000) {
  let ms = startSec * 1000;
  return { now: () => ms, advance: (sec: number) => (ms += sec * 1000) };
}

test('a missed unlock: input after the lock, with the OS not reporting locked, clears it', () => {
  const c = clock();
  const t = new IdleTracker(THRESHOLD, c.now);
  t.lockScreen();
  c.advance(60);
  // No input since the lock (idle 70 s >= 60 s since the lock): still away.
  assert.equal(t.poll(input(70)), true);
  // Typing the password on the lock screen: input, but the OS reads locked.
  assert.equal(t.poll(input(2, true)), true);
  // Unlocked, the unlock event never arrived, typing again: back.
  assert.equal(t.poll(input(5)), false);
  assert.equal(t.poll(input(20)), false);
});

test('a missed resume: input after the sleep clears it', () => {
  const c = clock();
  const t = new IdleTracker(THRESHOLD, c.now);
  t.suspend();
  c.advance(3600);
  assert.equal(t.poll(input(3600)), true);
  assert.equal(t.poll(input(4)), false);
});

test('the earlier of lock and sleep is what input has to be newer than', () => {
  const c = clock();
  const t = new IdleTracker(THRESHOLD, c.now);
  t.lockScreen();
  c.advance(30);
  t.suspend();
  c.advance(10);
  // 35 s without input: before the sleep but after the lock — no input
  // since the lock (40 s ago), so still away.
  assert.equal(t.poll(input(45)), true);
  assert.equal(t.poll(input(35)), false);
});

test('unlock trusts the event even if the OS still reads locked for a moment', () => {
  const c = clock();
  const t = new IdleTracker(THRESHOLD, c.now);
  t.lockScreen();
  c.advance(120);
  assert.equal(t.unlockScreen(input(0, true)), false);
});
