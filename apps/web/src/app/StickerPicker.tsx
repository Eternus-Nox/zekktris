/**
 * StickerPicker
 * -------------
 * Popover that lists the current channel's guild stickers in a grid.
 * Clicking a sticker fires `onPick` with the sticker id; the parent
 * (Composer) sends a sticker-only message immediately and closes the
 * popover. There's no preview/confirm step — Discord doesn't have one,
 * and stickers are cheap to retract via message delete.
 *
 * Keyboard: Escape closes; Tab moves through tiles. The first tile is
 * focused on open if there are any. Arrow-key grid navigation is left
 * for a future polish pass — Tab is good enough for v1.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Sticker } from '@zekktris/client';
import { useAppState } from '../state/AppState';
import { Search, X } from '../lib/icons';
import { AvatarImage } from '../lib/AvatarImage';
import { Portal } from '../lib/Portal';

interface Props {
  /** Guild id whose stickers to show. Stickers are guild-scoped; for
      DMs (no guild) the picker should not be shown. */
  guildId: string;
  /** Anchor element the popover positions itself relative to. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Called with the chosen sticker id when the user clicks a tile. */
  onPick: (stickerId: string) => void;
  onClose: () => void;
}

export function StickerPicker({ guildId, anchorRef, onPick, onClose }: Props) {
  const { state } = useAppState();
  const stickers = state.stickersByGuild[guildId] ?? [];
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Position the popover above the anchor button, right-aligned. Recompute
  // on mount, scroll, and resize. We use fixed positioning so the popover
  // floats free of any ancestor's overflow:hidden — the channel sidebar
  // and chat header both clip their children, which would otherwise
  // crop the popover when it opens upward from the composer.
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const PICKER_W = 320; // matches w-80
      const right = r.right;
      const left = Math.max(8, right - PICKER_W);
      const bottom = window.innerHeight - r.top + 8; // 8px gap above button
      setPos({ left, bottom, width: PICKER_W });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  // Close on Escape and on outside-click. Outside-click is computed by
  // looking at the ancestor chain of the click target — if our root
  // isn't in it AND the anchor button isn't in it, treat as outside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onMouse = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouse, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouse, true);
    };
  }, [onClose, anchorRef]);

  // Apply search filter. Match against name + description (the
  // description is the searchable description the uploader provided).
  const filtered = stickers.filter((s) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.description ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <Portal>
      <div
        ref={rootRef}
        className="fixed max-h-96 bg-bg-1 border border-line shadow-xl rounded-lg overflow-hidden flex flex-col z-50"
        style={
          pos
            ? { left: pos.left, bottom: pos.bottom, width: pos.width }
            : { visibility: 'hidden' }
        }
        role="dialog"
        aria-label="Sticker picker"
      >
      <div className="px-3 py-2 border-b border-line flex items-center justify-between shrink-0">
        <h3 className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
          Stickers
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-3 pt-2 shrink-0">
        <label className="flex items-center gap-2 px-2 py-1.5 bg-bg-2 border border-line rounded">
          <Search size={12} className="text-ink-3 shrink-0" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stickers"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-sm text-ink-3 text-center">
            {stickers.length === 0
              ? 'No stickers yet. Admins can upload some in server settings.'
              : 'No matches.'}
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2">
            {filtered.map((s) => (
              <StickerTile key={s.id} sticker={s} onPick={() => onPick(s.id)} />
            ))}
          </ul>
        )}
      </div>
      </div>
    </Portal>
  );
}

function StickerTile({ sticker, onPick }: { sticker: Sticker; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        // Hover-zoom to give a small visual cue that the tile is
        // clickable — stickers are big enough that text-cursor change
        // alone doesn't read well.
        className="relative aspect-square w-full bg-bg-3 rounded-md overflow-hidden hover:ring-2 hover:ring-accent transition-shadow group"
        title={sticker.description ? `${sticker.name} — ${sticker.description}` : sticker.name}
        aria-label={sticker.description ?? sticker.name}
      >
        <AvatarImage src={sticker.url} />
        {/* Hover-overlay name. Hidden until hover so the grid stays
            visually clean; the title attribute covers no-hover devices. */}
        <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-[0.6rem] bg-black/60 text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
          {sticker.name}
        </span>
      </button>
    </li>
  );
}
