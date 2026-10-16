/**
 * Link previews in end-to-end encrypted chats (per device, default OFF).
 *
 * The server can't unfurl ciphertext, so a preview for a link inside an
 * encrypted message has to be requested by the client after decryption —
 * which hands that link (not the message) to the server. That leaks which
 * links are shared in an "end-to-end encrypted" chat, so it's opt-in, per
 * device, and stored in localStorage like the other display preferences.
 * Wording mirrors the iOS toggle.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'zk:e2ee-link-previews';

let enabled = load();
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function getE2eeLinkPreviews(): boolean {
  return enabled;
}

export function setE2eeLinkPreviews(on: boolean): void {
  enabled = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — keep in-memory value */
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive hook: re-renders subscribers when the toggle changes. */
export function useE2eeLinkPreviews(): boolean {
  return useSyncExternalStore(subscribe, getE2eeLinkPreviews, () => false);
}
