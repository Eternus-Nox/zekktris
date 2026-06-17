/**
 * EmojiPicker
 * -----------
 * Popover that lets the user pick a guild custom emoji or a standard
 * unicode emoji. Used by:
 *   - the message composer (insert `:name:` or unicode glyph at cursor)
 *   - the reactions row (add a reaction to a message)
 *
 * On selection, calls `onSelect(code)` where `code` is either a unicode
 * glyph or a `:name:` token. Callers decide what to do with it
 * (insert into textarea, send as reaction, etc).
 *
 * Sections:
 *   - Server emoji (only when guildId is provided AND the guild has any)
 *   - Standard emoji (curated set, grouped by category)
 *
 * Search filters across BOTH sections by name. We don't ship a full
 * Unicode emoji index here — the curated set covers the most-used
 * 100ish emoji which is plenty for v1; users can still type any
 * Unicode char directly via their OS keyboard.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStateSelector } from '../state/AppState';
import { Search, X, Smile } from '../lib/icons';
import type { GuildEmoji } from '@zekktris/client';

// Stable empty reference so the per-guild emoji selector doesn't churn for
// guilds with no custom emoji (a fresh [] each render would defeat the memo).
const EMPTY_EMOJIS: GuildEmoji[] = [];

/**
 * Curated standard emoji with searchable names. Names are intentionally
 * lowercase + underscore-only so the same query can match both standard
 * and custom emoji uniformly. The categories are consistent with what
 * most users expect from an emoji picker (Discord, Slack, iOS).
 */
const STANDARD_EMOJI: { name: string; emoji: string; category: string }[] = [
  // Smileys
  { name: 'grinning', emoji: '😀', category: 'Smileys' },
  { name: 'smile', emoji: '😄', category: 'Smileys' },
  { name: 'laugh', emoji: '😂', category: 'Smileys' },
  { name: 'rofl', emoji: '🤣', category: 'Smileys' },
  { name: 'wink', emoji: '😉', category: 'Smileys' },
  { name: 'blush', emoji: '😊', category: 'Smileys' },
  { name: 'cool', emoji: '😎', category: 'Smileys' },
  { name: 'love', emoji: '😍', category: 'Smileys' },
  { name: 'kiss', emoji: '😘', category: 'Smileys' },
  { name: 'thinking', emoji: '🤔', category: 'Smileys' },
  { name: 'neutral', emoji: '😐', category: 'Smileys' },
  { name: 'unamused', emoji: '😒', category: 'Smileys' },
  { name: 'sob', emoji: '😭', category: 'Smileys' },
  { name: 'angry', emoji: '😠', category: 'Smileys' },
  { name: 'rage', emoji: '😡', category: 'Smileys' },
  { name: 'sleepy', emoji: '😴', category: 'Smileys' },
  { name: 'sweat', emoji: '😅', category: 'Smileys' },
  { name: 'sunglasses', emoji: '🕶️', category: 'Smileys' },
  { name: 'thumbsup', emoji: '👍', category: 'Smileys' },
  { name: 'thumbsdown', emoji: '👎', category: 'Smileys' },
  { name: 'clap', emoji: '👏', category: 'Smileys' },
  { name: 'wave', emoji: '👋', category: 'Smileys' },
  { name: 'pray', emoji: '🙏', category: 'Smileys' },
  { name: 'muscle', emoji: '💪', category: 'Smileys' },
  { name: 'point_right', emoji: '👉', category: 'Smileys' },
  { name: 'eyes', emoji: '👀', category: 'Smileys' },
  // Hearts
  { name: 'heart', emoji: '❤️', category: 'Hearts' },
  { name: 'orange_heart', emoji: '🧡', category: 'Hearts' },
  { name: 'yellow_heart', emoji: '💛', category: 'Hearts' },
  { name: 'green_heart', emoji: '💚', category: 'Hearts' },
  { name: 'blue_heart', emoji: '💙', category: 'Hearts' },
  { name: 'purple_heart', emoji: '💜', category: 'Hearts' },
  { name: 'black_heart', emoji: '🖤', category: 'Hearts' },
  { name: 'white_heart', emoji: '🤍', category: 'Hearts' },
  { name: 'broken_heart', emoji: '💔', category: 'Hearts' },
  { name: 'sparkling_heart', emoji: '💖', category: 'Hearts' },
  // Symbols / Marks
  { name: 'check', emoji: '✅', category: 'Symbols' },
  { name: 'x', emoji: '❌', category: 'Symbols' },
  { name: 'warning', emoji: '⚠️', category: 'Symbols' },
  { name: 'question', emoji: '❓', category: 'Symbols' },
  { name: 'exclamation', emoji: '❗', category: 'Symbols' },
  { name: '100', emoji: '💯', category: 'Symbols' },
  { name: 'fire', emoji: '🔥', category: 'Symbols' },
  { name: 'star', emoji: '⭐', category: 'Symbols' },
  { name: 'sparkles', emoji: '✨', category: 'Symbols' },
  { name: 'zap', emoji: '⚡', category: 'Symbols' },
  { name: 'bomb', emoji: '💣', category: 'Symbols' },
  // Objects / Activities
  { name: 'tada', emoji: '🎉', category: 'Activities' },
  { name: 'rocket', emoji: '🚀', category: 'Activities' },
  { name: 'gift', emoji: '🎁', category: 'Activities' },
  { name: 'cake', emoji: '🎂', category: 'Activities' },
  { name: 'pizza', emoji: '🍕', category: 'Activities' },
  { name: 'coffee', emoji: '☕', category: 'Activities' },
  { name: 'beer', emoji: '🍺', category: 'Activities' },
  { name: 'soccer', emoji: '⚽', category: 'Activities' },
  { name: 'basketball', emoji: '🏀', category: 'Activities' },
  { name: 'gem', emoji: '💎', category: 'Activities' },
  { name: 'crown', emoji: '👑', category: 'Activities' },
  { name: 'trophy', emoji: '🏆', category: 'Activities' },
  // Animals / Nature
  { name: 'dog', emoji: '🐶', category: 'Animals' },
  { name: 'cat', emoji: '🐱', category: 'Animals' },
  { name: 'mouse', emoji: '🐭', category: 'Animals' },
  { name: 'rabbit', emoji: '🐰', category: 'Animals' },
  { name: 'fox', emoji: '🦊', category: 'Animals' },
  { name: 'bear', emoji: '🐻', category: 'Animals' },
  { name: 'panda', emoji: '🐼', category: 'Animals' },
  { name: 'tiger', emoji: '🐯', category: 'Animals' },
  { name: 'frog', emoji: '🐸', category: 'Animals' },
  { name: 'monkey', emoji: '🐵', category: 'Animals' },
  { name: 'sun', emoji: '☀️', category: 'Animals' },
  { name: 'moon', emoji: '🌙', category: 'Animals' },
  { name: 'rainbow', emoji: '🌈', category: 'Animals' },
  { name: 'flower', emoji: '🌸', category: 'Animals' },
];

const STANDARD_CATEGORIES = Array.from(new Set(STANDARD_EMOJI.map((e) => e.category)));

interface PickerProps {
  /** Guild scope for custom emoji. Omit (or null) for DMs / no-server contexts. */
  guildId?: string | null;
  /**
   * Called when the user picks an emoji. The string is either a unicode
   * glyph (e.g. '👍') or a `:name:` token for custom guild emoji
   * (e.g. ':pepe:'). Caller decides how to insert/use it.
   */
  onSelect: (code: string) => void;
  /** Closes the picker without selecting. Mounted by the host. */
  onClose: () => void;
  /** Optional anchor classes to position the picker (e.g. 'absolute right-0 bottom-full mb-2'). */
  className?: string;
}

export function EmojiPicker({ guildId, onSelect, onClose, className }: PickerProps) {
  // Subscribe ONLY to this guild's emoji slice — not the whole app state, which
  // re-rendered the picker on every unrelated dispatch (typing, presence, …).
  const guildEmojis =
    useAppStateSelector((v) => (guildId ? v.state.emojisByGuild[guildId] : undefined)) ??
    EMPTY_EMOJIS;
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus search on open so the user can immediately type to filter.
  // We do it on mount via a ref rather than `autoFocus` so the focus
  // arrives after layout — autoFocus on a portal child with transitions
  // can fight with surrounding focus management.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on outside click. Use mousedown so the close fires before
  // the click handler on whatever the user actually wanted to interact
  // with (e.g. clicking a different button shouldn't trigger it AND
  // close us — close first, click second).
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  // Close on Escape — standard popover affordance.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return {
        guild: guildEmojis,
        standard: STANDARD_EMOJI,
      };
    }
    return {
      guild: guildEmojis.filter((e) => e.name.toLowerCase().includes(q)),
      standard: STANDARD_EMOJI.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q),
      ),
    };
  }, [query, guildEmojis]);

  const totalResults = filtered.guild.length + filtered.standard.length;

  return (
    <div
      ref={containerRef}
      className={`bg-bg-2 border border-line rounded-lg shadow-2xl flex flex-col w-72 max-h-80 overflow-hidden ${className ?? ''}`}
      // Stop pointer events from bubbling to a parent that might also
      // handle them (e.g. a message row's tap-to-toggle action bar).
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header — search + close */}
      <div className="flex items-center gap-2 p-2 border-b border-line shrink-0">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji…"
            className="w-full pl-7 pr-2 py-1 bg-bg-1 border border-line rounded text-sm outline-none focus:border-accent"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
          aria-label="Close emoji picker"
        >
          <X size={14} />
        </button>
      </div>

      {/* Body — scrollable grid sections */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-3">
        {totalResults === 0 ? (
          <div className="text-center py-6 text-ink-3 text-xs">
            <Smile size={24} className="mx-auto mb-2 opacity-50" />
            No emoji match "{query}".
          </div>
        ) : (
          <>
            {filtered.guild.length > 0 && (
              <Section title="Server">
                <div className="grid grid-cols-8 gap-0.5">
                  {filtered.guild.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onSelect(`:${e.name}:`)}
                      className="w-8 h-8 rounded hover:bg-bg-3 flex items-center justify-center"
                      title={`:${e.name}:`}
                    >
                      <img
                        src={e.url}
                        alt={e.name}
                        className="w-6 h-6 object-contain"
                        loading="lazy"
                        draggable={false}
                      />
                    </button>
                  ))}
                </div>
              </Section>
            )}
            {filtered.standard.length > 0 && (
              <>
                {/* When there's no query, group standard emoji by category for
                    easier scanning. With a query, flatten — the user is
                    actively searching and category headers waste space. */}
                {query.trim() ? (
                  <Section title="Standard">
                    <div className="grid grid-cols-8 gap-0.5">
                      {filtered.standard.map((e) => (
                        <button
                          key={e.name}
                          type="button"
                          onClick={() => onSelect(e.emoji)}
                          className="w-8 h-8 rounded hover:bg-bg-3 text-lg leading-none flex items-center justify-center"
                          title={`:${e.name}:`}
                        >
                          {e.emoji}
                        </button>
                      ))}
                    </div>
                  </Section>
                ) : (
                  STANDARD_CATEGORIES.map((cat) => {
                    const inCat = filtered.standard.filter((e) => e.category === cat);
                    if (inCat.length === 0) return null;
                    return (
                      <Section key={cat} title={cat}>
                        <div className="grid grid-cols-8 gap-0.5">
                          {inCat.map((e) => (
                            <button
                              key={e.name}
                              type="button"
                              onClick={() => onSelect(e.emoji)}
                              className="w-8 h-8 rounded hover:bg-bg-3 text-lg leading-none flex items-center justify-center"
                              title={`:${e.name}:`}
                            >
                              {e.emoji}
                            </button>
                          ))}
                        </div>
                      </Section>
                    );
                  })
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[0.65rem] font-semibold uppercase text-ink-3 mb-1 px-1">
        {title}
      </div>
      {children}
    </div>
  );
}
