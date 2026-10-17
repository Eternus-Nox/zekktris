import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { DeviceActivity } from './presenceActivity';
import { subscribeSpeakers } from './voice';

/**
 * Report whether this device is in use, so the user's presence follows the
 * device they're actually on (see lib/presenceActivity for the rule).
 *
 * Every active↔idle transition goes to gateway.setPresenceActive(), which
 * folds the current value into each IDENTIFY / RESUME and — only on a server
 * whose READY advertised `features.presence_activity` — sends the change as
 * PRESENCE_UPDATE (op 3), once. The server derives the effective status from
 * it; this device never PATCHes the user's status on its own.
 *
 * Older servers (no flag): the desktop app keeps its previous auto-away
 * exactly — when the machine has been idle or locked past the shell's
 * threshold it PATCHes the status to 'idle', and back to 'online' on return,
 * only from/to 'online' and only if it set it, so a chosen 'dnd' or
 * 'invisible' is never stomped. A browser tab had no idle detection there and
 * still has none.
 */

interface ZekktrisIdleBridge {
  onIdleStateChange?: (cb: (idle: boolean) => void) => () => void;
  getIdleState?: () => Promise<boolean>;
}

function idleBridge(): ZekktrisIdleBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { zekktris?: ZekktrisIdleBridge }).zekktris;
}

/** Input that means someone is at this page. Passive capture listeners see
 *  everything and never delay scrolling; DeviceActivity throttles them. */
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

export function usePresenceActivity(): void {
  const { rest, gateway, user, updateUser } = useAuth();
  const userId = user?.id ?? null;

  // Legacy auto-away reads the latest status without re-subscribing.
  const statusRef = useRef(user?.status);
  statusRef.current = user?.status;

  useEffect(() => {
    if (!userId) return;
    const zk = idleBridge();
    const onIdleStateChange = zk?.onIdleStateChange;
    const cleanups: Array<() => void> = [];

    const activity = new DeviceActivity({
      mode: onIdleStateChange ? 'desktop' : 'browser',
      visible: document.visibilityState === 'visible',
      onChange: (active) => gateway.setPresenceActive(active),
    });
    // The starting value rides on the next IDENTIFY / RESUME (or goes out as
    // op 3 if the socket is already live and the server held another value).
    gateway.setPresenceActive(activity.isActive());
    cleanups.push(() => activity.dispose());

    // Talking in a call counts as using the device. The speaker set changes
    // only when someone starts or stops, and its ids are user ids.
    cleanups.push(subscribeSpeakers((speakers) => activity.setSpeaking(speakers.has(userId))));

    if (onIdleStateChange) {
      // ── Desktop shell: the system-wide signal ──────────────────────────
      let shellIdle = false;
      // Legacy auto-away runs only once a READY has said the server lacks
      // the feature; a change before any READY waits for it (below).
      let serverKnown = false;
      let autoSet = false;
      const legacyApply = async (idle: boolean) => {
        if (!serverKnown || gateway.supportsPresenceActivity()) return;
        try {
          if (idle) {
            if (statusRef.current === 'online') {
              autoSet = true;
              const r = await rest.patchMe({ status: 'idle' });
              updateUser(r.user);
            }
          } else if (autoSet && statusRef.current === 'idle') {
            autoSet = false;
            const r = await rest.patchMe({ status: 'online' });
            updateUser(r.user);
          } else {
            // User changed status manually while away, or we never set
            // it — don't touch anything.
            autoSet = false;
          }
        } catch {
          // Presence is best-effort; ignore failures.
        }
      };
      const onShellIdle = (idle: boolean) => {
        if (idle === shellIdle) return;
        shellIdle = idle;
        activity.setSystemIdle(idle);
        void legacyApply(idle);
      };
      cleanups.push(onIdleStateChange(onShellIdle));
      // Sync the current state on mount (e.g. after a reload while away).
      zk.getIdleState?.()
        .then(onShellIdle)
        .catch(() => undefined);
      cleanups.push(
        gateway.onStatus((s) => {
          if (s !== 'ready' || serverKnown) return;
          serverKnown = true;
          if (shellIdle) void legacyApply(true);
        }),
      );
    } else {
      // ── Browser: visible + recent input ────────────────────────────────
      const onInput = () => activity.input();
      const onVisibility = () => activity.setVisible(document.visibilityState === 'visible');
      for (const ev of INPUT_EVENTS) {
        window.addEventListener(ev, onInput, { capture: true, passive: true });
      }
      document.addEventListener('visibilitychange', onVisibility);
      // Coming back to the window (alt-tab, click into it) is an interaction
      // even when the tab never stopped being visible.
      window.addEventListener('focus', onInput);
      cleanups.push(() => {
        for (const ev of INPUT_EVENTS) {
          window.removeEventListener(ev, onInput, { capture: true });
        }
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('focus', onInput);
      });
    }

    return () => {
      for (const c of cleanups) c();
    };
  }, [gateway, rest, updateUser, userId]);
}
