/**
 * Parental-controls visibility preference.
 *
 * The Family entry point in the server rail is opt-in: it only appears
 * once the user turns on "Parental controls" in Settings. Default off.
 * Stored in localStorage (per-device, like the voice prefs) and exposed
 * as a reactive store so the Settings toggle and the rail icon stay in
 * sync without prop-drilling.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'zk:parental-controls-enabled';

let enabled = load();
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function emit() {
  for (const l of listeners) l();
}

export function getParentalControlsEnabled(): boolean {
  return enabled;
}

export function setParentalControlsEnabled(on: boolean): void {
  enabled = on;
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — keep in-memory value */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive hook: re-renders when the toggle changes. */
export function useParentalControlsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getParentalControlsEnabled, () => false);
}
