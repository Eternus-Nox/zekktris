import { describe, it, expect, beforeEach } from 'vitest';
import {
  getNotifyPrefs,
  setNotifyMessages,
  setNotifyCalls,
  subscribeNotifyPrefs,
} from '../src/lib/notifyPrefs';

// Device-local notification toggles mirroring the native app. Runs in the
// node vitest env where `localStorage` is absent — load() falls back to
// defaults and the in-memory state is authoritative, which is exactly the
// behavior we want to lock in.
describe('notifyPrefs', () => {
  beforeEach(() => {
    // Reset to the default (ON) state between tests.
    setNotifyMessages(true);
    setNotifyCalls(true);
  });

  it('defaults both toggles ON (matches native)', () => {
    expect(getNotifyPrefs().notifyMessages).toBe(true);
    expect(getNotifyPrefs().notifyCalls).toBe(true);
  });

  it('toggles messages independently of calls', () => {
    setNotifyMessages(false);
    expect(getNotifyPrefs().notifyMessages).toBe(false);
    expect(getNotifyPrefs().notifyCalls).toBe(true);
  });

  it('toggles calls independently of messages', () => {
    setNotifyCalls(false);
    expect(getNotifyPrefs().notifyCalls).toBe(false);
    expect(getNotifyPrefs().notifyMessages).toBe(true);
  });

  it('snapshot reference is stable until a real change (useSyncExternalStore-safe)', () => {
    const a = getNotifyPrefs();
    setNotifyMessages(true); // no-op: already true
    expect(getNotifyPrefs()).toBe(a); // unchanged reference
    setNotifyMessages(false); // real change
    expect(getNotifyPrefs()).not.toBe(a);
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    let count = 0;
    const unsub = subscribeNotifyPrefs(() => {
      count += 1;
    });
    setNotifyCalls(false);
    expect(count).toBe(1);
    unsub();
    setNotifyCalls(true);
    expect(count).toBe(1);
  });
});
