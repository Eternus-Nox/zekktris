/**
 * useMentionAutocomplete
 * ----------------------
 * Wires `@mention` autocomplete onto a textarea. The Composer wraps
 * its <textarea> with this hook to get:
 *
 *   - `onChange(value, selStart)` — call from the textarea's onChange
 *      to keep the autocomplete state in sync with cursor position
 *   - `onKeyDown(e) → boolean` — call from onKeyDown; returns `true`
 *      if the keypress was consumed by the autocomplete (caller should
 *      not run its own logic for that key)
 *   - `popover` — rendered popover element (Portal-anchored). Null
 *      when not active.
 *
 * Trigger rules:
 *   - The user types `@` either at the very start of the text or
 *     after a whitespace character.
 *   - Following characters (until the next whitespace) form the query.
 *   - Empty query is allowed — pops the full member list.
 *   - Esc dismisses.
 *
 * On selection:
 *   - The `@partial` substring is replaced with `<@ID> ` (trailing
 *     space). The markdown renderer already understands `<@ID>`.
 *
 * Member source:
 *   - In a guild: `state.membersByGuild[guildId]`
 *   - In a DM: the message authors we've seen on this channel (best
 *     we can do without a separate REST endpoint).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Channel, GuildMember, PublicUser } from '@zekktris/client';
import { useAppState } from '../state/AppState';
import { Portal } from './Portal';
import { avatarColor, avatarInitials } from './avatar';
import { AvatarImage } from './AvatarImage';

interface MentionState {
  /** Position of the `@` in the textarea value. */
  start: number;
  /** Text after the `@` and before the cursor. */
  query: string;
  /** Highlighted index in the candidate list. */
  index: number;
}

interface Anchor {
  left: number;
  bottom: number;
}

const MAX_RESULTS = 8;

export function useMentionAutocomplete({
  channel,
  textareaRef,
  setValue,
}: {
  channel: Channel;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  /** Caller's setter for the textarea's controlled value. We use it to
      apply the substitution after a selection. */
  setValue: (next: string) => void;
}) {
  const { state } = useAppState();
  const [mention, setMention] = useState<MentionState | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // Source list — guild members for guild channels, DM authors for
  // DMs. The DM heuristic is best-effort: we look at the messages
  // already loaded for this channel and pull distinct author profiles.
  const candidates = useMemo<PublicUser[]>(() => {
    if (channel.guildId) {
      const members: GuildMember[] = state.membersByGuild[channel.guildId] ?? [];
      return members.map((m) => m.user);
    }
    // DM: collect distinct authors from loaded messages
    const messages = state.messagesByChannel[channel.id] ?? [];
    const seen = new Set<string>();
    const out: PublicUser[] = [];
    for (const m of messages) {
      if (m.author && !seen.has(m.author.id)) {
        seen.add(m.author.id);
        out.push(m.author);
      }
    }
    return out;
  }, [channel.guildId, channel.id, state.membersByGuild, state.messagesByChannel]);

  // Filter + cap the candidate list against the active query. Kept
  // separate so it only recomputes when query or candidates change,
  // not when the textarea itself updates.
  const filtered = useMemo<PublicUser[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const matches = candidates.filter((u) => {
      if (!q) return true;
      return (
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q)
      );
    });
    // Sort: exact prefix matches bubble to the top, alphabetical fallback.
    matches.sort((a, b) => {
      const ap = a.displayName.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.displayName.toLowerCase().startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.displayName.localeCompare(b.displayName);
    });
    return matches.slice(0, MAX_RESULTS);
  }, [mention, candidates]);

  // Re-clamp the highlighted index whenever the filtered list shrinks
  // beneath the current selection (e.g. the user typed another letter
  // that filters out the previously-selected row).
  useEffect(() => {
    if (!mention) return;
    if (mention.index >= filtered.length && filtered.length > 0) {
      setMention((prev) => (prev ? { ...prev, index: 0 } : prev));
    }
  }, [filtered.length, mention]);

  /**
   * Inspect the current textarea state and decide whether the cursor
   * is inside an `@mention` zone. Walks backwards from the caret; if
   * we hit `@` before any whitespace, that's a trigger. The position
   * before the `@` must also be either start-of-text or whitespace,
   * otherwise emails and other `@`-bearing tokens would falsely fire.
   */
  const detect = useCallback(
    (value: string, caret: number): MentionState | null => {
      // Walk backwards from caret until whitespace or `@`.
      let i = caret - 1;
      while (i >= 0) {
        const ch = value[i]!;
        if (ch === '@') {
          // Validate the character before `@` (must be start-of-text
          // or whitespace; otherwise this is something like
          // "name@host" — not a mention trigger).
          const prev = i > 0 ? value[i - 1]! : '';
          if (i === 0 || /\s/.test(prev)) {
            return {
              start: i,
              query: value.slice(i + 1, caret),
              index: 0,
            };
          }
          return null;
        }
        if (/\s/.test(ch)) return null;
        i--;
      }
      return null;
    },
    [],
  );

  /** Compute the popover anchor from the textarea's bounding rect.
      The popover sits above the textarea (matching Discord's layout)
      and is roughly aligned to the start of the `@`. We don't try to
      hit pixel-perfect column alignment because that would require
      measuring the rendered character offset; the popover floats
      above the whole textarea which is good enough. */
  const computeAnchor = useCallback((): Anchor | null => {
    const ta = textareaRef.current;
    if (!ta) return null;
    const rect = ta.getBoundingClientRect();
    return { left: rect.left, bottom: window.innerHeight - rect.top };
  }, [textareaRef]);

  /**
   * Caller invokes this from the textarea's onChange. We update the
   * mention state based on the new value + cursor position.
   */
  const onChange = useCallback(
    (value: string, caret: number) => {
      const next = detect(value, caret);
      if (next) {
        // Preserve the highlighted index across keystrokes if the
        // user is still in the same `@` zone — otherwise reset to 0.
        if (mention && mention.start === next.start) {
          setMention({ ...next, index: mention.index });
        } else {
          setMention(next);
          setAnchor(computeAnchor());
        }
      } else if (mention) {
        setMention(null);
        setAnchor(null);
      }
    },
    [detect, mention, computeAnchor],
  );

  /**
   * Apply a selection. Replaces the `@partial` substring with
   * `<@USER_ID> ` (including the trailing space so the user can keep
   * typing after a mention without a manual space).
   */
  const select = useCallback(
    (user: PublicUser) => {
      const ta = textareaRef.current;
      if (!ta || !mention) return;
      const before = ta.value.slice(0, mention.start);
      const after = ta.value.slice(mention.start + 1 + mention.query.length);
      const insert = `<@${user.id}> `;
      const next = before + insert + after;
      setValue(next);
      // Move the cursor to just after the inserted mention. We do this
      // in a microtask so React has a chance to apply `next` to the
      // textarea before we move the caret.
      const caret = (before + insert).length;
      queueMicrotask(() => {
        // On touch devices (mobile web + the iOS/Android native shell) we
        // do NOT programmatically re-focus the textarea after a selection.
        // Re-focusing force-reopens the on-screen keyboard, which fights
        // the user: they can't dismiss the keyboard to browse the option
        // list, and tapping a name yanks the keyboard back up. Skipping the
        // focus means the mention is inserted while the keyboard stays in
        // whatever state the user left it — the keyboard only opens when
        // they tap the message box itself. On desktop (fine pointer) we
        // keep the focus so typing continues uninterrupted.
        const coarsePointer =
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(pointer: coarse)').matches;
        if (!coarsePointer) ta.focus();
        try {
          ta.setSelectionRange(caret, caret);
        } catch {
          // setSelectionRange can throw if the element isn't focused on
          // some engines; harmless — the caret lands correctly once the
          // user taps back in.
        }
      });
      setMention(null);
      setAnchor(null);
    },
    [mention, setValue, textareaRef],
  );

  /**
   * Caller invokes this from the textarea's onKeyDown. Returns true
   * when the keypress was handled here (caller should NOT run their
   * own logic for that event — most importantly, suppress the Enter
   * "submit" behaviour while the autocomplete is open).
   */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!mention || filtered.length === 0) return false;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention((prev) =>
          prev ? { ...prev, index: (prev.index + 1) % filtered.length } : prev,
        );
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention((prev) =>
          prev ? { ...prev, index: (prev.index - 1 + filtered.length) % filtered.length } : prev,
        );
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = filtered[mention.index];
        if (pick) select(pick);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        setAnchor(null);
        return true;
      }
      return false;
    },
    [mention, filtered, select],
  );

  // Recompute anchor on window resize so the popover stays attached
  // when the user adjusts viewport size mid-edit.
  useEffect(() => {
    if (!mention) return;
    function onResize() {
      setAnchor(computeAnchor());
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mention, computeAnchor]);

  const popover =
    mention && anchor && filtered.length > 0 ? (
      <Portal>
        <div
          className="fixed z-[70] bg-bg-1 border border-line rounded-lg shadow-2xl overflow-hidden w-72 max-w-[calc(100vw-1rem)]"
          style={{ left: anchor.left, bottom: anchor.bottom + 4 }}
          // Keep the textarea focused while the user clicks: prevent
          // mousedown's default focus shift. onClick still fires.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-3 py-1.5 text-[0.65rem] uppercase tracking-wider text-ink-3 bg-bg-2 border-b border-line">
            Members matching @{mention.query}
          </div>
          <ul>
            {filtered.map((u, i) => {
              const tone = avatarColor(u.id);
              const initials = avatarInitials(u.displayName);
              const active = i === mention.index;
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => select(u)}
                    onMouseEnter={() =>
                      setMention((prev) => (prev ? { ...prev, index: i } : prev))
                    }
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      active ? 'bg-bg-3 text-ink-1' : 'text-ink-2 hover:bg-bg-3/50'
                    }`}
                  >
                    <span className="relative w-7 h-7 shrink-0 overflow-hidden rounded-full">
                      <span className={`absolute inset-0 rounded-full text-xs flex items-center justify-center font-semibold ${tone}`} aria-hidden="true">
                        {initials}
                      </span>
                      <AvatarImage src={u.avatarUrl} />
                    </span>
                    <span className="truncate flex-1">{u.displayName}</span>
                    <span className="text-xs text-ink-3 truncate">@{u.username}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </Portal>
    ) : null;

  // Sentinel value tracking whether autocomplete is currently consuming
  // input. Caller may want to hide other affordances when active.
  const active = mention !== null && filtered.length > 0;

  // Cleanup on unmount — clear any open state. (React normally handles
  // this via the unmount path on the popover element, but explicit
  // teardown here helps in StrictMode dev where effects run twice.)
  useEffect(() => {
    return () => {
      setMention(null);
      setAnchor(null);
    };
  }, []);

  // Suppress unused-warning on useRef (kept available for future
  // anchor-tracking that needs a stable ref to a measurement node).
  const _ref = useRef(null);
  void _ref;

  return { onChange, onKeyDown, popover, active };
}
