/**
 * Per-device display preferences.
 *
 * "Hide clan tags" suppresses every clan/name-tag pill in *this* user's own
 * UI (their own included) — a declutter choice, not a privacy one. Stored in
 * localStorage per-device (like familyPrefs / voice prefs) and exposed as a
 * reactive store so the Settings toggle and every UserTag stay in sync
 * without prop-drilling.
 */
import { useSyncExternalStore } from 'react';

const HIDE_CLAN_TAGS_KEY = 'zk:hide-clan-tags';

let hideClanTags = load();
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    return localStorage.getItem(HIDE_CLAN_TAGS_KEY) === '1';
  } catch {
    return false;
  }
}

function emit() {
  for (const l of listeners) l();
}

export function getHideClanTags(): boolean {
  return hideClanTags;
}

export function setHideClanTags(on: boolean): void {
  hideClanTags = on;
  try {
    if (on) localStorage.setItem(HIDE_CLAN_TAGS_KEY, '1');
    else localStorage.removeItem(HIDE_CLAN_TAGS_KEY);
  } catch {
    /* storage unavailable — keep in-memory value */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive hook: re-renders subscribers when the toggle changes. */
export function useHideClanTags(): boolean {
  return useSyncExternalStore(subscribe, getHideClanTags, () => false);
}
