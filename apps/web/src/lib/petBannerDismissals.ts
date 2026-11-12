import { useSyncExternalStore } from 'react';

/**
 * Zekk Pet bars (adopt / waiting / invited) the viewer dismissed, keyed
 * `${channelId}:${kind}` so hiding the adopt prompt doesn't also hide a later
 * invite. A dismissed bar stays hidden for the session: until the app reloads
 * or the signed-in account changes (AppState clears it next to its RESET, so
 * the next person on a shared tab sees their own bars — the iOS and Android
 * apps drop theirs on sign-out too).
 *
 * Its own module, not ZekkPet.tsx, because AppState imports it and ZekkPet
 * imports AppState.
 */

const dismissed = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

export function subscribePetBannerDismissals(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function isPetBannerDismissed(key: string): boolean {
  return dismissed.has(key);
}

export function dismissPetBanner(key: string): void {
  if (dismissed.has(key)) return;
  dismissed.add(key);
  notify();
}

/** Forget every dismissal (sign-out / account switch). */
export function clearPetBannerDismissals(): void {
  if (dismissed.size === 0) return;
  dismissed.clear();
  notify();
}

export function usePetBannerDismissed(key: string): boolean {
  return useSyncExternalStore(
    subscribePetBannerDismissals,
    () => dismissed.has(key),
    () => dismissed.has(key),
  );
}
