/**
 * Toasts
 * ------
 * App-wide ephemeral notifications. Consumers call `useToasts().push(msg)`
 * from anywhere; the message renders as a card at the bottom-right and
 * auto-expires after `ttlMs` (default 4s, errors get 6s so they're easier
 * to read before they vanish).
 *
 * Why provider+renderer in one file: the renderer needs the same state the
 * provider holds, and exposing it would just mean consumers wrap two
 * components instead of one. Co-locating keeps the public surface as a
 * single `<ToastProvider>` element.
 *
 * Click-to-dismiss is the standard escape hatch for "I read it, hide it
 * now." Persistent toasts (no auto-expire) pass `ttlMs: 0`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type ToastKind = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  push: (message: string, kind?: ToastKind, ttlMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);
  // Per-toast expiry timer handles, so a manual click-dismiss cancels the
  // pending auto-expire and provider unmount clears everything (untracked
  // timers fired into unmounted state).
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((arr) => arr.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const push = useCallback(
    (message: string, kind: ToastKind = 'info', ttlMs?: number) => {
      // Errors are surfaced as a subtle, short-lived inline cue rather
      // than a prominent popup (see the renderer for styling). Still
      // logged to the console so failures remain debuggable.
      if (kind === 'error' && typeof console !== 'undefined') {
        console.error('[zekktris]', message);
      }
      const effectiveTtl = ttlMs ?? (kind === 'error' ? 3000 : 4000);
      const id = nextIdRef.current++;
      setToasts((arr) => [...arr, { id, message, kind }]);
      if (effectiveTtl > 0) {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), effectiveTtl),
        );
      }
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        // pointer-events-none on the wrapper means clicks go through to the
        // app underneath — only the toast cards themselves are clickable.
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) =>
          t.kind === 'error' ? (
            // Subtle inline cue — a quiet muted pill with a small dot,
            // not a prominent colored popup. Easy to ignore, brief, but
            // present enough to hint that something didn't work.
            <button
              key={t.id}
              onClick={() => dismiss(t.id)}
              className="pointer-events-auto text-left flex items-center gap-2 px-3 py-1.5 rounded-md border border-line bg-bg-2/90 text-ink-2 text-xs shadow-md transition-all hover:opacity-90"
            >
              <span
                className="w-1.5 h-1.5 rounded-full bg-red-400/90 shrink-0"
                aria-hidden
              />
              <span className="min-w-0">{t.message}</span>
            </button>
          ) : (
            <button
              key={t.id}
              onClick={() => dismiss(t.id)}
              className={
                'pointer-events-auto text-left px-4 py-2 rounded-md shadow-lg border text-sm transition-all hover:opacity-90 ' +
                toneClass(t.kind)
              }
            >
              {t.message}
            </button>
          ),
        )}
      </div>
    </ToastContext.Provider>
  );
}

function toneClass(kind: ToastKind): string {
  switch (kind) {
    case 'error':
      return 'bg-red-950/95 border-red-800/60 text-red-100';
    case 'success':
      return 'bg-emerald-950/95 border-emerald-800/60 text-emerald-100';
    default:
      return 'bg-bg-2/95 border-line text-ink-1';
  }
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts() must be used inside <ToastProvider>');
  return ctx;
}
