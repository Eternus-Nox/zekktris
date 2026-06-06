/**
 * CustomStatusModal
 * -----------------
 * Lets the user set or clear their custom status. The status has
 * three optional pieces:
 *   - text: short freeform line, ~100 chars
 *   - emoji: a single unicode emoji or short code
 *   - expiresAt: optional auto-clear time
 *
 * The expiry dropdown offers Discord-style presets computed
 * relative to the user's local time:
 *   - Don't clear         (no expiry)
 *   - 30 minutes          (now + 30min)
 *   - 1 hour              (now + 1h)
 *   - 4 hours             (now + 4h)
 *   - Today               (midnight tonight local)
 *   - This week           (midnight Sunday→Monday local)
 *
 * Pre-fills from the current SelfUser if a status is already set
 * (treats a past expiresAt as cleared). Includes a destructive
 * "Clear status" button when something's currently set.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { X } from '../lib/icons';

export function CustomStatusModal({ onClose }: { onClose: () => void }) {
  const { rest, user, updateUser } = useAuth();
  const toasts = useToasts();
  const [pending, setPending] = useState(false);
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState('');
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>('never');

  // Pre-fill from current state. Treats past expiry as cleared
  // (matches the client-side "treat past timestamps as cleared"
  // rule from the spec).
  useEffect(() => {
    if (!user) return;
    setText(user.customStatus ?? '');
    setEmoji(user.customStatusEmoji ?? '');
    const exp = user.customStatusExpiresAt;
    if (exp && new Date(exp).getTime() > Date.now()) {
      setExpiryChoice('keep');
    }
  }, [user]);

  const currentlySet =
    !!user?.customStatus || !!user?.customStatusEmoji;

  async function submit() {
    if (pending) return;
    setPending(true);
    try {
      const expiresAt = computeExpiresAt(expiryChoice);
      const r = await rest.setCustomStatus({
        text: text.trim() === '' ? null : text.trim(),
        emoji: emoji.trim() === '' ? null : emoji.trim(),
        // 'keep' means "leave the current expiresAt unchanged" —
        // omit the field entirely so the server doesn't touch it.
        // Other choices set an explicit value (or null for 'never').
        ...(expiryChoice === 'keep' ? {} : { expiresAt }),
      });
      updateUser(r.user);
      onClose();
    } catch (e) {
      toasts.push(
        e instanceof Error ? e.message : 'Could not update status',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  async function clearStatus() {
    if (pending) return;
    setPending(true);
    try {
      const r = await rest.setCustomStatus({
        text: null,
        emoji: null,
        expiresAt: null,
      });
      updateUser(r.user);
      onClose();
    } catch (e) {
      toasts.push(
        e instanceof Error ? e.message : 'Could not clear status',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-2 border border-line rounded-lg max-w-md w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-1">Set a custom status</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink-1 p-1 rounded"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <p className="text-sm text-ink-3 leading-snug">
          Add a short message that appears on your profile. Optional emoji
          and auto-clear. Status hides from others when you're invisible.
        </p>
        <div className="flex gap-2">
          {/* Emoji slot. Single character input is the simplest UI
              that works on mobile (native emoji keyboard). Power
              users can paste; system emoji pickers cover the rest. */}
          <input
            type="text"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value.slice(0, 8))}
            placeholder="🙂"
            className="w-14 text-center text-xl bg-bg-1 border border-line rounded-md px-2 py-2 outline-none focus:border-accent transition-colors"
            aria-label="Status emoji"
          />
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="What's happening?"
            maxLength={100}
            className="flex-1 bg-bg-1 border border-line rounded-md px-3 py-2 text-sm text-ink-1 outline-none focus:border-accent transition-colors"
            aria-label="Status text"
          />
        </div>
        <div>
          <label
            htmlFor="status-expiry"
            className="block text-xs text-ink-3 mb-1"
          >
            Clear after
          </label>
          <select
            id="status-expiry"
            value={expiryChoice}
            onChange={(e) => setExpiryChoice(e.target.value as ExpiryChoice)}
            className="w-full bg-bg-1 border border-line rounded-md px-3 py-2 text-sm text-ink-1 outline-none focus:border-accent transition-colors"
          >
            <option value="never">Don't clear</option>
            {currentlySet && <option value="keep">Keep current expiry</option>}
            <option value="30m">30 minutes</option>
            <option value="1h">1 hour</option>
            <option value="4h">4 hours</option>
            <option value="today">Today (until midnight)</option>
            <option value="week">This week (until Sunday)</option>
          </select>
        </div>
        <div className="flex justify-between items-center pt-2">
          {currentlySet ? (
            <button
              type="button"
              onClick={() => void clearStatus()}
              disabled={pending}
              className="text-sm text-red-300 hover:text-red-200 disabled:opacity-60"
            >
              Clear status
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="px-3 py-1.5 rounded-md hover:bg-bg-3 text-sm text-ink-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending}
              className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-60 text-white text-sm font-medium"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type ExpiryChoice =
  | 'never'
  | 'keep'
  | '30m'
  | '1h'
  | '4h'
  | 'today'
  | 'week';

function computeExpiresAt(choice: ExpiryChoice): string | null {
  if (choice === 'never') return null;
  if (choice === 'keep') return null; // caller omits the field instead
  const now = new Date();
  switch (choice) {
    case '30m':
      return new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    case '1h':
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    case '4h':
      return new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();
    case 'today': {
      // Local midnight tonight.
      const t = new Date(now);
      t.setHours(24, 0, 0, 0);
      return t.toISOString();
    }
    case 'week': {
      // Local midnight Sunday → Monday. JS's getDay returns 0=Sun,
      // so days until next Sunday end-of-day = (7 - dayOfWeek).
      const t = new Date(now);
      const dayOfWeek = t.getDay();
      const daysUntilSundayMidnight = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
      t.setHours(24, 0, 0, 0);
      t.setDate(t.getDate() + daysUntilSundayMidnight);
      return t.toISOString();
    }
  }
}

/**
 * Formats a custom status for inline display. Returns an empty
 * string when there's nothing to show (no text + no emoji, or
 * expired). Callers use it on PublicUser / SelfUser surfaces.
 */
export function formatCustomStatus(u: {
  customStatus?: string | null;
  customStatusEmoji?: string | null;
  customStatusExpiresAt?: string | null;
}): { emoji: string | null; text: string | null } {
  // Respect client-side expiry — treats past timestamps as cleared
  // so we don't have to wait on a server cleanup job.
  if (u.customStatusExpiresAt) {
    const t = new Date(u.customStatusExpiresAt).getTime();
    if (Number.isFinite(t) && t < Date.now()) {
      return { emoji: null, text: null };
    }
  }
  return {
    emoji: u.customStatusEmoji?.trim() || null,
    text: u.customStatus?.trim() || null,
  };
}
