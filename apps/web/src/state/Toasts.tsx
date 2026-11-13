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
 *
 * Colour follows the theme (Settings → Appearance), except where colour
 * carries meaning:
 *   - info: a neutral bg-2 card with an accent edge (a leading
 *     accent→accent-2 rail and an accent border) and an accent icon.
 *   - success: green, in every theme — it means something worked (under
 *     Crimson an accent card would read as an error).
 *   - error: red, in every theme — it means something failed.
 *   - poke / achievement: the in-app notification banners, the web twins of
 *     iOS PokeBannerView / AchievementBannerView — the same card with a 1px
 *     accent→accent-2 stroke and an accent glow instead of a black shadow.
 * Everything reads the theme's CSS channels, so a toast already on screen
 * restyles the moment the theme changes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle, Info } from '../lib/icons';

export type ToastKind = 'info' | 'success' | 'error' | 'poke' | 'achievement';

/** A glyph drawn in a toast (an achievement's badge icon). */
export type ToastGlyph = ComponentType<{ size?: number; className?: string }>;

/** An optional trailing button on a toast (e.g. the poke-back emoji). */
interface ToastAction {
  label: string;
  /** Accessible name when `label` is only a glyph (the poke-back emoji is
      "Poke back"). Defaults to `label`. */
  ariaLabel?: string;
  onClick: () => void;
}

interface ToastOptions {
  /** Tapping the toast body runs this (then dismisses) instead of just dismissing. */
  onClick?: () => void;
  /** A trailing action button shown beside the message. */
  action?: ToastAction;
  /** A second, smaller line: the hint under a poke, the "Achievement
      unlocked" eyebrow above an achievement. Banner kinds only. */
  caption?: string;
  /** Poke: the emoji, drawn large at the leading edge. */
  emoji?: string;
  /** Achievement: the badge's own glyph (lib/achievementGlyphs), drawn in
      the themed badge circle the shelf uses. */
  icon?: ToastGlyph;
}

/** One toast as the renderer sees it. */
export interface ToastView extends ToastOptions {
  message: string;
  kind: ToastKind;
}

interface Toast extends ToastView {
  id: number;
}

interface ToastContextValue {
  push: (message: string, kind?: ToastKind, ttlMs?: number, opts?: ToastOptions) => void;
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
    (message: string, kind: ToastKind = 'info', ttlMs?: number, opts?: ToastOptions) => {
      // Errors are surfaced as a subtle, short-lived inline cue rather
      // than a prominent popup (see the renderer for styling). Still
      // logged to the console so failures remain debuggable.
      if (kind === 'error' && typeof console !== 'undefined') {
        console.error('[zekktris]', message);
      }
      // Errors get AT LEAST 6s and scale with length, so the app's
      // multi-sentence remediation copy (mic-denied walkthroughs, the
      // no-voice-configured explanation) can actually be read before it
      // vanishes. The old 3s default — shorter than info's 4s — meant the
      // most important guidance flickered away unread.
      const effectiveTtl =
        ttlMs ?? (kind === 'error' ? Math.max(6000, message.length * 55) : 4000);
      const id = nextIdRef.current++;
      setToasts((arr) => [
        ...arr,
        {
          id,
          message,
          kind,
          onClick: opts?.onClick,
          action: opts?.action,
          caption: opts?.caption,
          emoji: opts?.emoji,
          icon: opts?.icon,
        },
      ]);
      if (effectiveTtl > 0) {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), effectiveTtl),
        );
      }
    },
    [dismiss],
  );

  // Stable context value — `push` is a stable useCallback, so this object is
  // permanently identity-stable. Without the memo the `{ push }` literal was
  // fresh every render, making `useToasts()` an unstable dependency that
  // re-ran every `[..., toasts]` effect/memo across the app on any re-render.
  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        // pointer-events-none on the wrapper means clicks go through to the
        // app underneath — only the toast cards themselves are clickable.
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * One toast card. All kinds render as a readable card (errors in the red
 * tone). Errors previously rendered as a tiny, easy-to-miss grey pill —
 * which hid exactly the multi-sentence fix-it instructions a first-time
 * user needs when a call or upload fails.
 * A toast may carry a body tap-action (e.g. open the poke sender's DM) and
 * a trailing action button (e.g. poke back) — kept as SIBLING buttons
 * (never nested) so the markup stays valid.
 */
export function ToastCard({ toast: t, onDismiss }: { toast: ToastView; onDismiss: () => void }) {
  const onBody = () => {
    t.onClick?.();
    onDismiss();
  };
  const onAction = () => {
    t.action?.onClick();
    onDismiss();
  };
  if (t.kind === 'poke' || t.kind === 'achievement') {
    return <BannerCard toast={t} onBody={onBody} onAction={onAction} />;
  }

  // Only info takes the theme; success and error keep the colour that
  // carries their meaning.
  const themed = t.kind === 'info';
  const Glyph = t.kind === 'error' ? AlertTriangle : t.kind === 'success' ? CheckCircle : Info;
  const glyphTone = themed ? 'text-accent' : t.kind === 'success' ? 'text-emerald-300' : 'text-red-300';
  return (
    <div
      className={
        'pointer-events-auto flex items-stretch rounded-md shadow-lg border text-sm leading-snug overflow-hidden ' +
        toneClass(t.kind)
      }
    >
      {/* The accent edge: the accent→accent-2 rail the active rail tiles
          wear, down the card's leading side. */}
      {themed && <span aria-hidden className="w-[3px] shrink-0 bg-gradient-to-b from-accent to-accent-2" />}
      <button
        type="button"
        onClick={onBody}
        className={`flex-1 flex items-start gap-2.5 text-left ${themed ? 'pl-3' : 'pl-3.5'} pr-4 py-2.5 transition-all hover:opacity-90`}
      >
        <Glyph size={16} className={`shrink-0 mt-px ${glyphTone}`} />
        <span className="min-w-0 whitespace-pre-line">{t.message}</span>
      </button>
      {t.action && (
        <button
          type="button"
          onClick={onAction}
          className={`px-3 flex items-center justify-center text-xl border-l transition-colors shrink-0 ${
            themed ? 'border-accent/20 hover:bg-accent/15' : 'border-white/10 hover:bg-white/10'
          }`}
          aria-label={t.action.ariaLabel ?? t.action.label}
          title={t.action.ariaLabel ?? t.action.label}
        >
          {t.action.label}
        </button>
      )}
    </div>
  );
}

/**
 * The poke / achievement banner: the toast card's surface with the themed
 * stroke (.zk-accent-edge) and an accent glow. A poke leads with its emoji
 * and offers the poke-back chip (accent at 18% fill, 45% stroke); an
 * achievement leads with its badge glyph in the shelf's themed circle
 * (accent 35% → accent-2 25%) — never the old fixed gold or emerald.
 */
function BannerCard({
  toast: t,
  onBody,
  onAction,
}: {
  toast: ToastView;
  onBody: () => void;
  onAction: () => void;
}) {
  const Icon = t.icon;
  return (
    <div className="pointer-events-auto zk-accent-edge flex items-center rounded-md bg-bg-2/95 text-ink-1 text-sm leading-snug shadow-[0_4px_24px_var(--accent-glow)]">
      <button
        type="button"
        onClick={onBody}
        className="flex-1 min-w-0 flex items-center gap-3 text-left pl-3 pr-4 py-2 transition-all hover:opacity-90"
      >
        {t.kind === 'achievement' ? (
          <span
            aria-hidden
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center bg-gradient-to-br from-accent/35 to-accent-2/25"
          >
            {Icon && <Icon size={16} className="text-accent" />}
          </span>
        ) : t.emoji ? (
          <span className="text-[30px] leading-none shrink-0">{t.emoji}</span>
        ) : null}
        <span className="min-w-0 flex flex-col">
          {t.kind === 'achievement' && t.caption && (
            <span className="text-[11px] font-semibold text-ink-2">{t.caption}</span>
          )}
          <span className="font-semibold truncate">{t.message}</span>
          {t.kind === 'poke' && t.caption && (
            <span className="text-[11px] text-ink-2 truncate">{t.caption}</span>
          )}
        </span>
      </button>
      {t.action && (
        <button
          type="button"
          onClick={onAction}
          className="mr-2 w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-xl leading-none bg-accent/[0.18] border border-accent/45 hover:bg-accent/30 transition-colors"
          aria-label={t.action.ariaLabel ?? t.action.label}
          title={t.action.ariaLabel ?? t.action.label}
        >
          {t.action.label}
        </button>
      )}
    </div>
  );
}

function toneClass(kind: ToastKind): string {
  switch (kind) {
    case 'error':
      return 'bg-red-950/95 border-red-800/60 text-red-100';
    case 'success':
      return 'bg-emerald-950/95 border-emerald-800/60 text-emerald-100';
    default:
      // info: the theme's surface with an accent border.
      return 'bg-bg-2/95 border-accent/30 text-ink-1';
  }
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts() must be used inside <ToastProvider>');
  return ctx;
}
