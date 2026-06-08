/**
 * Notification preferences (per-device)
 * -------------------------------------
 * Two on/off toggles mirroring the native app's Settings → Notifications
 * switches (`zk.notifyMessages` / `zk.notifyCalls` in the iOS app):
 *
 *   - notifyMessages — surface message banners / pings for DMs and
 *                      @mentions on THIS device.
 *   - notifyCalls    — ring + alert for incoming 1-on-1 calls on THIS device.
 *
 * Like the native app's `@AppStorage` toggles, these are device-local
 * (localStorage), NOT server-synced — a notification preference is a
 * property of this browser, not the account. Both default ON, matching
 * native.
 *
 * Tiny subscribe/getSnapshot singleton (same shape as voicePrefs) so it
 * can drive a useSyncExternalStore toggle in Settings and be read
 * directly from the message-notify and call-ring code paths without
 * prop-drilling.
 */

const STORAGE_KEY = 'zekktris.notify.prefs.v1';

export interface NotifyPrefs {
  /** Surface message banners / pings for DMs and @mentions on this device. */
  notifyMessages: boolean;
  /** Ring + alert for incoming 1-on-1 calls on this device. */
  notifyCalls: boolean;
}

const DEFAULTS: NotifyPrefs = { notifyMessages: true, notifyCalls: true };

let state: NotifyPrefs = load();
const listeners = new Set<() => void>();

function load(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs>;
    return {
      // Default ON for any missing/invalid field — matches native, and
      // makes a brand-new or partially-written record safe.
      notifyMessages: typeof parsed.notifyMessages === 'boolean' ? parsed.notifyMessages : true,
      notifyCalls: typeof parsed.notifyCalls === 'boolean' ? parsed.notifyCalls : true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / private-mode failures are non-fatal — the in-memory copy is
    // still authoritative for this session.
  }
  for (const l of listeners) l();
}

/** Current prefs. Stable reference until a setter runs — safe as a
    useSyncExternalStore snapshot. */
export function getNotifyPrefs(): NotifyPrefs {
  return state;
}

export function setNotifyMessages(on: boolean): void {
  if (state.notifyMessages === !!on) return;
  state = { ...state, notifyMessages: !!on };
  persist();
}

export function setNotifyCalls(on: boolean): void {
  if (state.notifyCalls === !!on) return;
  state = { ...state, notifyCalls: !!on };
  persist();
}

/** Subscribe to changes. Returns an unsubscribe fn. */
export function subscribeNotifyPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
