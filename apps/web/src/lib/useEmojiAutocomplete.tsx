/**
 * useEmojiAutocomplete
 * --------------------
 * Wires `:name:` autocomplete onto a textarea — same pattern as
 * useMentionAutocomplete but for custom guild emoji + a small set
 * of standard emoji.
 *
 * Trigger rules:
 *   - The user types `:` either at the very start of the text or
 *     after a whitespace character.
 *   - Following characters in [a-z0-9_] form the query.
 *   - Need at least 2 characters of query before the popover opens
 *     (one-letter queries match too much; the noise/signal isn't
 *     worth it). The hard floor mirrors the validation that an
 *     emoji name must be 2-32 chars.
 *   - The closing `:` (if typed) commits the inline `:name:` token
 *     directly without going through the autocomplete — Discord
 *     parity. The autocomplete is for discovery, not enforcement.
 *
 * On selection:
 *   - The `:partial` substring is replaced with `:full_name: `
 *     (trailing space). The markdown renderer's `:emoji:` rule
 *     resolves it on render.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Channel, GuildEmoji } from '@zekktris/client';
import { useAppStateSelector } from '../state/AppState';
import { Portal } from './Portal';

interface EmojiState {
  /** Position of the `:` in the textarea value. */
  start: number;
  /** Text after the `:` and before the cursor (lowercase letters / digits / underscore). */
  query: string;
  /** Highlighted index in the candidate list. */
  index: number;
}

interface Anchor {
  left: number;
  bottom: number;
}

const MAX_RESULTS = 8;
const MIN_QUERY_LEN = 2;
const QUERY_RE = /^[a-z0-9_]+$/;

/**
 * Standard emoji shortcodes that should appear in the autocomplete.
 * These mirror a subset of the names from EmojiPicker — keeping the
 * lists separate is intentional: the picker can show many at once;
 * autocomplete only shows the top N matching, so a tighter set keeps
 * suggestions relevant. Adding to this list is cheap.
 */
const STANDARD_EMOJI: { name: string; emoji: string }[] = [
  { name: 'thumbsup', emoji: '👍' },
  { name: 'thumbsdown', emoji: '👎' },
  { name: 'heart', emoji: '❤️' },
  { name: 'fire', emoji: '🔥' },
  { name: 'tada', emoji: '🎉' },
  { name: 'rocket', emoji: '🚀' },
  { name: 'eyes', emoji: '👀' },
  { name: 'check', emoji: '✅' },
  { name: 'x', emoji: '❌' },
  { name: 'thinking', emoji: '🤔' },
  { name: 'laugh', emoji: '😂' },
  { name: 'rofl', emoji: '🤣' },
  { name: 'sob', emoji: '😭' },
  { name: 'pray', emoji: '🙏' },
  { name: 'clap', emoji: '👏' },
  { name: 'wave', emoji: '👋' },
  { name: '100', emoji: '💯' },
  { name: 'sparkles', emoji: '✨' },
];

/** Suggestion shape the popover renders. Either a guild emoji (img) or
    a standard one (unicode glyph). The `code` field is what gets
    inserted into the textarea on selection. */
interface Suggestion {
  kind: 'guild' | 'standard';
  name: string;
  /** What to insert: `:name:` for guild, the unicode glyph for standard. */
  code: string;
  /** Image URL for guild emoji; undefined for standard. */
  url?: string;
  /** Unicode glyph for standard emoji; undefined for guild. */
  glyph?: string;
}

export function useEmojiAutocomplete({
  channel,
  textareaRef,
  setValue,
}: {
  channel: Channel;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  setValue: (next: string) => void;
}) {
  // Narrow selector: this hook lives inside the Composer (renders per
  // keystroke); a full useAppState() subscription re-rendered it on every
  // reducer dispatch app-wide.
  const guildEmojiList = useAppStateSelector((v) =>
    channel.guildId ? v.state.emojisByGuild[channel.guildId] : undefined,
  );
  const [emoji, setEmoji] = useState<EmojiState | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const guildEmojis = useMemo<GuildEmoji[]>(() => guildEmojiList ?? [], [guildEmojiList]);

  const filtered = useMemo<Suggestion[]>(() => {
    if (!emoji) return [];
    const q = emoji.query.toLowerCase();
    // Score: prefix matches > substring. Within ties, alphabetical.
    const score = (name: string) =>
      name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;

    const guildHits: Suggestion[] = guildEmojis
      .filter((e) => e.name.includes(q))
      .map((e) => ({ kind: 'guild' as const, name: e.name, code: `:${e.name}:`, url: e.url }));
    const stdHits: Suggestion[] = STANDARD_EMOJI
      .filter((e) => e.name.includes(q))
      .map((e) => ({ kind: 'standard' as const, name: e.name, code: e.emoji, glyph: e.emoji }));

    const all = [...guildHits, ...stdHits];
    all.sort((a, b) => {
      const sa = score(a.name);
      const sb = score(b.name);
      if (sa !== sb) return sa - sb;
      // Guild emoji bubble above standard at the same score level so
      // server-specific matches feel preferred.
      if (a.kind !== b.kind) return a.kind === 'guild' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return all.slice(0, MAX_RESULTS);
  }, [emoji, guildEmojis]);

  // Re-clamp index when the filtered list shrinks below the selection.
  useEffect(() => {
    if (!emoji) return;
    if (emoji.index >= filtered.length && filtered.length > 0) {
      setEmoji((prev) => (prev ? { ...prev, index: 0 } : prev));
    }
  }, [filtered.length, emoji]);

  /**
   * Detect whether the cursor is inside a `:partial` zone. Walk
   * backwards from the caret; if we hit `:` before any whitespace OR
   * any character outside [a-z0-9_], that's a trigger. The position
   * before the `:` must be start-of-text or whitespace, otherwise
   * tokens like "10:30" or "https://" would falsely fire.
   */
  const detect = useCallback(
    (value: string, caret: number): EmojiState | null => {
      let i = caret - 1;
      while (i >= 0) {
        const ch = value[i]!;
        if (ch === ':') {
          const prev = i > 0 ? value[i - 1]! : '';
          if (i === 0 || /\s/.test(prev)) {
            const query = value.slice(i + 1, caret);
            // Empty or non-conforming queries — don't fire. We only
            // open once the user has typed enough to filter sensibly.
            if (query.length < MIN_QUERY_LEN) return null;
            if (!QUERY_RE.test(query)) return null;
            return { start: i, query, index: 0 };
          }
          return null;
        }
        // Stop on whitespace OR any char that can't be in an emoji name.
        if (/\s/.test(ch)) return null;
        if (!/[a-z0-9_]/.test(ch)) return null;
        i--;
      }
      return null;
    },
    [],
  );

  const computeAnchor = useCallback((): Anchor | null => {
    const ta = textareaRef.current;
    if (!ta) return null;
    const rect = ta.getBoundingClientRect();
    return { left: rect.left, bottom: window.innerHeight - rect.top };
  }, [textareaRef]);

  const onChange = useCallback(
    (value: string, caret: number) => {
      const next = detect(value, caret);
      if (next) {
        if (emoji && emoji.start === next.start) {
          setEmoji({ ...next, index: emoji.index });
        } else {
          setEmoji(next);
          setAnchor(computeAnchor());
        }
      } else if (emoji) {
        setEmoji(null);
        setAnchor(null);
      }
    },
    [detect, emoji, computeAnchor],
  );

  /** Replace `:partial` with the suggestion's code + trailing space. */
  const select = useCallback(
    (s: Suggestion) => {
      const ta = textareaRef.current;
      if (!ta || !emoji) return;
      const before = ta.value.slice(0, emoji.start);
      const after = ta.value.slice(emoji.start + 1 + emoji.query.length);
      const insert = `${s.code} `;
      const next = before + insert + after;
      setValue(next);
      const caret = (before + insert).length;
      queueMicrotask(() => {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
      setEmoji(null);
      setAnchor(null);
    },
    [emoji, setValue, textareaRef],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!emoji || filtered.length === 0) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setEmoji((prev) =>
          prev ? { ...prev, index: (prev.index + 1) % filtered.length } : prev,
        );
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setEmoji((prev) =>
          prev ? { ...prev, index: (prev.index - 1 + filtered.length) % filtered.length } : prev,
        );
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = filtered[emoji.index];
        if (pick) select(pick);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setEmoji(null);
        setAnchor(null);
        return true;
      }
      return false;
    },
    [emoji, filtered, select],
  );

  useEffect(() => {
    if (!emoji) return;
    function onResize() {
      setAnchor(computeAnchor());
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [emoji, computeAnchor]);

  const popover =
    emoji && anchor && filtered.length > 0 ? (
      <Portal>
        <div
          className="fixed z-[70] bg-bg-1 border border-line rounded-lg shadow-2xl overflow-hidden w-64 max-w-[calc(100vw-1rem)]"
          style={{ left: anchor.left, bottom: anchor.bottom + 4 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-3 py-1.5 text-[0.65rem] uppercase tracking-wider text-ink-3 bg-bg-2 border-b border-line">
            Emoji matching :{emoji.query}
          </div>
          <ul>
            {filtered.map((s, i) => {
              const active = i === emoji.index;
              return (
                <li key={`${s.kind}:${s.name}`}>
                  <button
                    type="button"
                    onClick={() => select(s)}
                    onMouseEnter={() =>
                      setEmoji((prev) => (prev ? { ...prev, index: i } : prev))
                    }
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      active ? 'bg-bg-3 text-ink-1' : 'text-ink-2 hover:bg-bg-3/50'
                    }`}
                  >
                    <span className="w-6 h-6 shrink-0 flex items-center justify-center">
                      {s.kind === 'guild' ? (
                        <img
                          src={s.url}
                          alt={s.name}
                          className="w-5 h-5 object-contain"
                          loading="lazy"
                          draggable={false}
                        />
                      ) : (
                        <span className="text-lg">{s.glyph}</span>
                      )}
                    </span>
                    <span className="truncate flex-1">:{s.name}:</span>
                    {s.kind === 'guild' && (
                      <span className="text-[0.6rem] uppercase text-ink-3 tracking-wider">
                        Server
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </Portal>
    ) : null;

  const active = emoji !== null && filtered.length > 0;

  useEffect(() => {
    return () => {
      setEmoji(null);
      setAnchor(null);
    };
  }, []);

  const _ref = useRef(null);
  void _ref;

  return { onChange, onKeyDown, popover, active };
}
