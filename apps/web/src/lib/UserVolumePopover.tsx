/**
 * UserVolumePopover
 * -----------------
 * Shared per-user "adjust volume / mute for me" panel. Originally
 * lived inline in VoiceView; lifted into lib so other voice surfaces
 * (channel list voice-participant rows, user popovers in DMs, etc.)
 * can open the same panel for the same user without duplicating the
 * markup and voicePrefs subscription.
 *
 * Positioning: the caller passes a screen-space `anchor` {x, y}
 * (usually computed from `e.currentTarget.getBoundingClientRect()`
 * in the open handler). The popover renders at that anchor with a
 * standard upward bottom-aligned offset, clamped horizontally so a
 * near-edge tile doesn't push the panel off-screen.
 *
 * Portal-mounted so the panel escapes any overflow-hidden / clip
 * boundary of its trigger (channel-list sidebar uses overflow-auto
 * on the scroll container; without the portal, the popover would
 * clip at the sidebar's right edge).
 *
 * Closing: outside click OR Escape. Listeners attach on `mousedown`
 * + `keydown` and detach on unmount.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Portal } from './Portal';
import { Volume2 } from './icons';
import {
  getUserPrefs,
  subscribeVoicePrefs,
  setUserMuted,
  setUserVolume,
  resetUserPrefs,
} from './voicePrefs';

type Props = {
  userId: string;
  label: string;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** Voice channels the user can be moved to. When provided + non-empty,
      the popover shows a "Move to" section. This is the touch-friendly
      alternative to drag-and-drop (HTML5 DnD doesn't work on mobile).
      Omit for contexts where moving doesn't apply (DM calls, no perms). */
  moveTargets?: Array<{ id: string; name: string }>;
  /** Called when the user picks a move target. Receives the target
      channel id. The caller performs the REST move + closes. */
  onMove?: (channelId: string) => void;
};

export function UserVolumePopover({ userId, label, anchor, onClose, moveTargets, onMove }: Props) {
  const prefs = useSyncExternalStore(
    subscribeVoicePrefs,
    () => getUserPrefs(userId),
    () => getUserPrefs(userId),
  );

  // Close on outside click / Escape. Listeners attached on the
  // capture phase so a click on a popover button doesn't propagate
  // into a close (the button handlers run first; close is only for
  // clicks OUTSIDE the popover).
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp the horizontal position so the 240px popover doesn't escape
  // the viewport on a near-edge tile. We translate -50% on x to center
  // the popover above the tile, then nudge it back from edges.
  const PANEL_W = 240;
  const VIEWPORT_PAD = 8;
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  let x = anchor.x - PANEL_W / 2;
  if (x < VIEWPORT_PAD) x = VIEWPORT_PAD;
  if (x + PANEL_W > winW - VIEWPORT_PAD) x = winW - PANEL_W - VIEWPORT_PAD;
  // Position popover above the tile with an 8px gap.
  const y = anchor.y - 8;

  return (
    <Portal>
      <div
        ref={ref}
        className="fixed z-50 bg-bg-1 border border-line rounded-lg shadow-xl p-3 elevation-pop"
        style={{
          width: PANEL_W,
          left: x,
          top: y,
          transform: 'translateY(-100%)',
        }}
        role="dialog"
        aria-label={`Voice controls for ${label}`}
      >
        <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2 truncate">
          {label}
        </div>
        <label className="flex items-center justify-between gap-2 mb-2 cursor-pointer">
          <span className="text-sm text-ink-2">Mute for me</span>
          <input
            type="checkbox"
            checked={prefs.muted}
            onChange={(e) => setUserMuted(userId, e.target.checked)}
            className="w-4 h-4 accent-accent"
          />
        </label>
        <div className="flex items-center gap-2 mb-1">
          <VolumeXIcon size={12} className="text-ink-3 shrink-0" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(Math.min(1, prefs.volume) * 100)}
            onChange={(e) => setUserVolume(userId, Number(e.target.value) / 100)}
            disabled={prefs.muted}
            className="flex-1 accent-accent disabled:opacity-50"
            aria-label="Volume"
          />
          <Volume2 size={12} className="text-ink-3 shrink-0" />
        </div>
        <div className="flex items-center justify-between text-[0.65rem] text-ink-3 tabular-nums">
          <span>{Math.round(Math.min(1, prefs.volume) * 100)}%</span>
          <button
            type="button"
            onClick={() => resetUserPrefs(userId)}
            className="text-ink-3 hover:text-ink-1"
          >
            Reset
          </button>
        </div>

        {/* Move-to section. Touch-friendly alternative to drag-and-drop
            for relocating a user between voice channels. Only rendered
            when the caller supplies move targets (i.e. the viewer has
            MOVE_MEMBERS and there's somewhere to move to). */}
        {moveTargets && moveTargets.length > 0 && onMove && (
          <div className="mt-3 pt-2 border-t border-line">
            <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">
              Move to
            </div>
            <div className="max-h-40 overflow-y-auto scrollbar-thin -mx-1 px-1 space-y-0.5">
              {moveTargets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onMove(t.id);
                    onClose();
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-ink-2 hover:bg-bg-3 hover:text-ink-1 transition-colors text-left"
                >
                  <Volume2 size={13} className="text-accent shrink-0" />
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Portal>
  );
}

/**
 * Muted-speaker icon. Local to this module because it's only used
 * here and pairs naturally next to Volume2 from the central icons.
 */
function VolumeXIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}
