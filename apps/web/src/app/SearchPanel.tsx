/**
 * SearchPanel
 * -----------
 * Right-side overlay with a search input + result list. Backend uses
 * Postgres FTS (`websearch_to_tsquery`) for the keyword stream; this
 * panel additionally parses inline filter syntax — `from:NAME`,
 * `before:YYYY-MM-DD`, `after:YYYY-MM-DD` — and renders the active
 * filters as removable chips above the input.
 *
 * Filter resolution flow:
 *   1. parseSearchQuery splits the input into keywords + raw filter
 *      strings ("from:alice" → from:'alice')
 *   2. SearchPanel resolves `from:` against cached members (display
 *      name OR username, case-insensitive) to a user id
 *   3. Date strings convert to snowflake cutoffs via dateBoundToSnowflake
 *   4. The REST call fires with both the keyword string and the
 *      resolved filter ids
 *
 * Debouncing: 300ms. Empty input + no filters → no request.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Channel, type Message, type PublicUser } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Search, X } from '../lib/icons';
import { ModalHeader } from '../lib/ModalHeader';
import { MessageItem } from './MessageItem';
import { parseSearchQuery, dateBoundToSnowflake } from '../lib/searchQuery';

const DEBOUNCE_MS = 300;

interface ResolvedFilters {
  /** Raw `from:` value as the user typed it. */
  fromText?: string;
  /** Resolved user id, or null if the from: name didn't match anyone we know. */
  authorId: string | null;
  /** The candidate user when authorId is set, for chip display. */
  authorUser?: PublicUser;
  /** Snowflake cutoff or null when invalid. */
  before?: string;
  beforeText?: string;
  after?: string;
  afterText?: string;
}

export function SearchPanel({
  channel,
  query,
  onQueryChange,
  onClose,
}: {
  channel: Channel;
  /** Lifted to the parent (MessageView) so query persists across panel
      open/close cycles within the same channel session. */
  query: string;
  onQueryChange: (next: string) => void;
  onClose: () => void;
}) {
  const { rest, user } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();
  const navigate = useNavigate();
  const [results, setResults] = useState<Message[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Search scope: just this channel, or every channel in the server the
  // user can see. Guild scope is only meaningful inside a guild (DMs have
  // no server), so the toggle is hidden for DMs and the value is forced to
  // 'channel' there.
  const [scope, setScope] = useState<'channel' | 'guild'>('channel');
  const effectiveScope = channel.guildId ? scope : 'channel';

  // Resolve filters off the parsed query. Memoised so re-renders
  // triggered by surrounding state updates don't reparse on every
  // tick — only on actual query change.
  const { keywords, filters } = useMemo(() => {
    const parsed = parseSearchQuery(query);
    const result: ResolvedFilters = { authorId: null };

    // Resolve `from:` against the cached members for this guild,
    // falling back to message-author scan in DMs. Match on display
    // name OR username, case-insensitive, prefix-or-substring.
    if (parsed.from) {
      result.fromText = parsed.from;
      const needle = parsed.from.toLowerCase();
      let found: PublicUser | undefined;
      if (channel.guildId) {
        const members = state.membersByGuild[channel.guildId] ?? [];
        const match = members.find(
          (m) =>
            m.user.username.toLowerCase() === needle ||
            m.user.displayName.toLowerCase() === needle ||
            m.user.username.toLowerCase().startsWith(needle) ||
            m.user.displayName.toLowerCase().startsWith(needle),
        );
        found = match?.user;
      } else {
        // DM: search distinct authors from the loaded message stream.
        const seen = new Set<string>();
        const candidates: PublicUser[] = [];
        const ms = state.messagesByChannel[channel.id] ?? [];
        for (const m of ms) {
          if (m.author && !seen.has(m.author.id)) {
            seen.add(m.author.id);
            candidates.push(m.author);
          }
        }
        found = candidates.find(
          (u) =>
            u.username.toLowerCase() === needle ||
            u.displayName.toLowerCase() === needle ||
            u.username.toLowerCase().startsWith(needle) ||
            u.displayName.toLowerCase().startsWith(needle),
        );
      }
      result.authorUser = found;
      result.authorId = found?.id ?? null;
    }

    // Date filters convert to snowflake cutoffs. Invalid dates have
    // already been kept in the keyword stream by the parser, so by
    // construction these strings are well-formed YYYY-MM-DD.
    if (parsed.before) {
      const sf = dateBoundToSnowflake(parsed.before, 'before');
      if (sf) {
        result.before = sf;
        result.beforeText = parsed.before;
      }
    }
    if (parsed.after) {
      const sf = dateBoundToSnowflake(parsed.after, 'after');
      if (sf) {
        result.after = sf;
        result.afterText = parsed.after;
      }
    }
    return { keywords: parsed.keywords, filters: result };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, channel.id, channel.guildId, state.membersByGuild, state.messagesByChannel]);

  // Search effect. Re-runs on keyword or filter change. We branch on
  // "is anything actionable" — empty keywords AND no resolved filters
  // means no useful query; clear results and skip the round trip.
  useEffect(() => {
    const hasFilters = filters.authorId || filters.before || filters.after;
    const trimmed = keywords.trim();
    if (trimmed.length === 0 && !hasFilters) {
      setResults(null);
      return;
    }
    // If the user typed `from:NAME` but NAME doesn't resolve to a
    // known member, surface "no matches" without firing — the chip
    // already shows "?" to indicate the unresolved state, and a
    // round-trip would be wasteful (server can't match by name).
    if (filters.fromText && filters.authorId === null) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      const req =
        effectiveScope === 'guild' && channel.guildId
          ? rest.searchGuildMessages(channel.guildId, {
              q: trimmed,
              authorId: filters.authorId ?? undefined,
              before: filters.before,
              after: filters.after,
            })
          : rest.searchMessages(channel.id, trimmed, {
              authorId: filters.authorId ?? undefined,
              before: filters.before,
              after: filters.after,
            });
      req
        .then((r) => {
          if (!cancelled) setResults(r.messages);
        })
        .catch((e) => {
          if (cancelled) return;
          toasts.push(
            e instanceof ApiError ? e.message : 'Search failed',
            'error',
          );
          setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    keywords,
    filters.authorId,
    filters.before,
    filters.after,
    channel.id,
    effectiveScope,
  ]);

  function jumpTo(m: Message) {
    // Server-wide results can live in another channel — navigate there
    // rather than trying to scroll the current channel's DOM (where the
    // message isn't loaded).
    if (m.channelId !== channel.id) {
      if (channel.guildId) {
        navigate(`/channels/${channel.guildId}/${m.channelId}`);
        onClose();
      }
      return;
    }
    const el = document.querySelector(`[data-message-id="${m.id}"]`);
    if (!el) {
      toasts.push(
        'Result is older than the loaded scroll-back; can’t jump directly',
        'info',
      );
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('jump-highlight');
    setTimeout(() => el.classList.remove('jump-highlight'), 1500);
    onClose();
  }

  /**
   * Remove a filter from the input. We do this by stripping the matching
   * `key:value` token, which preserves any keywords the user typed
   * around it. Whitespace collapse keeps the string tidy.
   */
  function removeFilter(key: 'from' | 'before' | 'after') {
    const re = new RegExp(`(?:^|\\s)${key}:\\S+`, 'gi');
    onQueryChange(query.replace(re, ' ').replace(/\s+/g, ' ').trim());
  }

  // Active-filter chips. We render one chip per resolved filter, plus
  // a special unresolved-from chip when the user typed `from:NAME` but
  // NAME doesn't match anyone. The chip click removes the filter.
  const chips: Array<{
    key: 'from' | 'before' | 'after';
    label: string;
    unresolved?: boolean;
  }> = [];
  if (filters.fromText) {
    chips.push({
      key: 'from',
      label: filters.authorUser
        ? `from: ${filters.authorUser.displayName}`
        : `from: ${filters.fromText} (?)`,
      unresolved: !filters.authorUser,
    });
  }
  if (filters.beforeText) {
    chips.push({ key: 'before', label: `before ${filters.beforeText}` });
  }
  if (filters.afterText) {
    chips.push({ key: 'after', label: `after ${filters.afterText}` });
  }

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-full sm:w-96 max-w-full bg-bg-1 border-l border-line elevation-pop z-10 flex flex-col">
      <ModalHeader title="Search" icon={<Search size={16} />} onClose={onClose} />

      <div className="px-3 py-2 border-b border-line shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search messages…"
            className="w-full pl-9 pr-8 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1 outline-none focus:border-accent"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* Scope toggle — only meaningful inside a server. */}
        {channel.guildId && (
          <div className="flex items-center gap-1 mt-2">
            {(['channel', 'guild'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  effectiveScope === s
                    ? 'bg-accent text-bg-1'
                    : 'bg-bg-2 text-ink-2 hover:bg-bg-3'
                }`}
              >
                {s === 'channel' ? 'This channel' : 'Whole server'}
              </button>
            ))}
          </div>
        )}

        {/* Active filter chips. Click × to drop a filter, which mutates
            the input string — keywords around the filter are preserved. */}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => removeFilter(chip.key)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-xs transition-colors ${
                  chip.unresolved
                    ? 'bg-amber-500/10 text-amber-300 border border-amber-500/40'
                    : 'bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25'
                }`}
                title={chip.unresolved ? 'No member matches that name' : 'Remove filter'}
              >
                <span>{chip.label}</span>
                <X size={10} />
              </button>
            ))}
          </div>
        )}

        <p className="text-[0.65rem] text-ink-3 mt-1.5 px-1">
          Filters: <code className="font-mono text-ink-2">from:name</code>{' '}
          <code className="font-mono text-ink-2">before:YYYY-MM-DD</code>{' '}
          <code className="font-mono text-ink-2">after:YYYY-MM-DD</code>
        </p>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin py-2">
        {keywords.trim().length === 0 && chips.length === 0 ? (
          <div className="text-center py-12 px-6">
            <p className="text-sm text-ink-3">Type to search messages in this channel.</p>
          </div>
        ) : searching && results === null ? (
          <p className="text-sm text-ink-3 text-center py-8">Searching…</p>
        ) : results === null ? (
          <p className="text-sm text-ink-3 text-center py-8">No results yet.</p>
        ) : results.length === 0 ? (
          <div className="text-center py-12 px-6">
            <p className="text-sm text-ink-2">No matches.</p>
            <p className="text-xs text-ink-3 mt-1">
              {filters.fromText && !filters.authorUser
                ? `No member named "${filters.fromText}" was found.`
                : 'Try different keywords or remove a filter.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-[0.65rem] uppercase tracking-wider text-ink-3 px-3 py-1">
              {results.length} result{results.length === 1 ? '' : 's'}
            </p>
            <ul className="divide-y divide-line/50">
              {results.map((m) => {
                // For server-wide results, label which channel each match
                // is in (looked up from the guild's channel list).
                const inOtherChannel = m.channelId !== channel.id;
                const chanName =
                  inOtherChannel && channel.guildId
                    ? (state.channelsByGuild[channel.guildId] ?? []).find(
                        (ch) => ch.id === m.channelId,
                      )?.name ?? 'unknown-channel'
                    : null;
                return (
                  <li
                    key={m.id}
                    className="px-2 py-2 hover:bg-bg-2/40 cursor-pointer"
                    onClick={() => jumpTo(m)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        jumpTo(m);
                      }
                    }}
                  >
                    {chanName && (
                      <p className="text-[0.65rem] text-ink-3 px-1 mb-0.5">#{chanName}</p>
                    )}
                    <MessageItem
                      message={m}
                      continuation={false}
                      selfId={user?.id}
                      channel={channel}
                    />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
