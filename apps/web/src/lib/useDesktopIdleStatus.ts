import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';

/**
 * Desktop idle → away auto-status.
 *
 * Only the native shell can observe system-wide idle (a browser tab
 * can't), so this is desktop-only. When the machine has been idle or
 * locked past the shell's threshold, we set the user's status to
 * 'idle' (the app's "away"), and restore 'online' when they return —
 * but only if WE were the one who set it, and only from/to 'online' so
 * we never stomp a manually-chosen 'dnd' or 'invisible'.
 */

interface ZekktrisIdleBridge {
  onIdleStateChange?: (cb: (idle: boolean) => void) => () => void;
  getIdleState?: () => Promise<boolean>;
}

function idleBridge(): ZekktrisIdleBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { zekktris?: ZekktrisIdleBridge }).zekktris;
}

export function useDesktopIdleStatus(): void {
  const { rest, user, updateUser } = useAuth();

  // Keep the latest status in a ref so the effect closure always reads
  // the current value without re-subscribing on every status change.
  const statusRef = useRef(user?.status);
  statusRef.current = user?.status;
  // Did we auto-set 'idle'? Only then do we restore on return.
  const autoSetRef = useRef(false);

  useEffect(() => {
    const zk = idleBridge();
    if (!zk?.onIdleStateChange) return; // not the desktop app

    const apply = async (idle: boolean) => {
      try {
        if (idle) {
          if (statusRef.current === 'online') {
            autoSetRef.current = true;
            const r = await rest.patchMe({ status: 'idle' });
            updateUser(r.user);
          }
        } else if (autoSetRef.current && statusRef.current === 'idle') {
          autoSetRef.current = false;
          const r = await rest.patchMe({ status: 'online' });
          updateUser(r.user);
        } else {
          // User changed status manually while away, or we never set
          // it — don't touch anything.
          autoSetRef.current = false;
        }
      } catch {
        // Presence is best-effort; ignore failures.
      }
    };

    const unsub = zk.onIdleStateChange((idle) => void apply(idle));
    // Sync the current state on mount (e.g. after a reload while away).
    zk.getIdleState?.()
      .then((idle) => {
        if (idle) void apply(true);
      })
      .catch(() => undefined);

    return unsub;
  }, [rest, updateUser]);
}
