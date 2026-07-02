/*
 * QuickSwitcher
 *
 * Cmd/Ctrl+K opens a search-anywhere modal that lists every
 * navigable destination — channels (across every guild), DMs, and
 * guilds themselves — fuzzy-filtered by what the user types. Arrow
 * keys move the highlight, Enter jumps, Escape closes.
 *
 * All data comes from AppState that's already hydrated; this
 * component owns no remote calls. That keeps it instant — Discord's
 * quick switcher feels fast because it's local, and we follow the
 * same pattern.
 *
 * Indexing strategy:
 *   - Flatten guildsById → guild entries
 *   - Flatten channelsByGuild → channel entries (one per channel,
 *     carrying its guild for the route + context label)
 *   - dmChannels → DM entries (carrying the other party's display
 *     name for matching/labeling)
 *
 * Filtering is a simple case-insensitive substring on the entry's
 * primary label, plus a secondary score boost when the match
 * starts at index 0 (so "gen" matches "general" before
 * "regenerate"). For the small N a personal server has, that's
 * faster and more predictable than a fuzzy library.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Portal } from '../lib/Portal';
import { useAppState } from '../state/AppState';
import { useAuth } from '../auth/AuthContext';
import { Hash, Volume2, Radio, Search } from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';

type Entry =
  | { kind: 'channel'; id: string; label: string; sublabel: string; guildId: string; channelType: string; sortKey: string }
  | { kind: 'dm'; id: string; label: string; sublabel: string; sortKey: string }
  | { kind: 'guild'; id: string; label: string; sublabel: string; iconUrl: string | null; sortKey: string };

export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useAppState();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state whenever the modal toggles open. Without this the
  // user would re-open the switcher and find the previous query
  // still there — annoying when navigating between unrelated
  // destinations in quick succession.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // Focus after the portal mounts. requestAnimationFrame
      // ensures the input is in the DOM before .focus() runs.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Build the searchable index. Memoized on the state slices that
  // affect it so typing in the input doesn't reindex.
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];

    // Guilds — useful when you want to jump to a server's default
    // channel without specifying which channel.
    for (const gid of state.guildIds) {
      const g = state.guildsById[gid];
      if (!g) continue;
      out.push({
        kind: 'guild',
        id: g.id,
        label: g.name,
        sublabel: 'Server',
        iconUrl: g.iconUrl ?? null,
        sortKey: g.name.toLowerCase(),
      });
    }

    // Channels. We pull from every guild's channel list — the user
    // doesn't have to be currently viewing a server to jump into
    // one of its channels.
    for (const gid of state.guildIds) {
      const channels = state.channelsByGuild[gid] ?? [];
      const guild = state.guildsById[gid];
      for (const ch of channels) {
        if (ch.type === 'guild_category') continue; // categories aren't navigable
        out.push({
          kind: 'channel',
          id: ch.id,
          label: ch.name ?? '(unnamed)',
          sublabel: guild?.name ?? '',
          guildId: gid,
          channelType: ch.type,
          sortKey: (ch.name ?? '').toLowerCase(),
        });
      }
    }

    // DMs. Label is the other party's display name (or 'Unknown' if
    // we haven't hydrated their user record yet).
    for (const dm of state.dmChannels) {
      const others = (dm.recipients ?? []).filter((u) => u.id !== user?.id);
      const labels = others.map((u) => u.displayName ?? u.username ?? 'Unknown');
      const label = labels.join(', ') || dm.name || 'DM';
      out.push({
        kind: 'dm',
        id: dm.id,
        label,
        sublabel: others.length > 1 ? 'Group DM' : 'Direct Message',
        sortKey: label.toLowerCase(),
      });
    }

    return out;
  }, [state.guildIds, state.guildsById, state.channelsByGuild, state.dmChannels, user?.id]);

  // Filter + rank.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // No query: show everything sorted alphabetically. Cap to a
      // reasonable list height so we don't render thousands of rows.
      return entries.slice().sort((a, b) => a.sortKey.localeCompare(b.sortKey)).slice(0, 100);
    }
    type Scored = { e: Entry; score: number };
    const scored: Scored[] = [];
    for (const e of entries) {
      const idx = e.sortKey.indexOf(q);
      if (idx === -1) continue;
      // Lower score = better. Prefix match (idx===0) scores best.
      // Channel matches outrank guild matches at equal position so
      // typing 'gen' surfaces #general first, not a server starting
      // with G.
      let score = idx;
      if (e.kind === 'guild') score += 10;
      if (e.kind === 'dm') score += 5;
      scored.push({ e, score });
    }
    scored.sort((a, b) => a.score - b.score || a.e.sortKey.localeCompare(b.e.sortKey));
    return scored.slice(0, 30).map((s) => s.e);
  }, [entries, query]);

  // Clamp selectedIndex when filtered list size changes.
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Keep the selected row in view as the user arrow-keys through.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row-index='${selectedIndex}']`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  function commit(entry: Entry) {
    onClose();
    if (entry.kind === 'channel') {
      navigate(`/channels/${entry.guildId}/${entry.id}`);
    } else if (entry.kind === 'dm') {
      navigate(`/channels/@me/${entry.id}`);
    } else {
      // Guild — let Shell pick the first channel.
      navigate(`/channels/${entry.id}`);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = filtered[selectedIndex];
      if (entry) commit(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[15vh] sm:pt-[20vh] px-4"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
      >
        <div
          className="w-full max-w-xl bg-bg-1 border border-line rounded-lg shadow-2xl overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
            <Search size={16} className="text-ink-3 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Find a channel, DM, or server…"
              className="flex-1 bg-transparent text-ink-1 placeholder:text-ink-3 outline-none text-sm"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <kbd className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.65rem] font-mono text-ink-3 bg-bg-2 border border-line rounded">
              esc
            </kbd>
          </div>
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ink-3">No matches</div>
            ) : (
              filtered.map((entry, i) => (
                <button
                  key={`${entry.kind}:${entry.id}`}
                  data-row-index={i}
                  type="button"
                  onClick={() => commit(entry)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm ${
                    i === selectedIndex ? 'bg-bg-3 text-ink-1' : 'text-ink-2 hover:bg-bg-2'
                  }`}
                >
                  <RowIcon entry={entry} />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{entry.label}</span>
                    <span className="block text-xs text-ink-3 truncate">{entry.sublabel}</span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="px-4 py-2 border-t border-line text-[0.65rem] text-ink-3 flex items-center gap-3 shrink-0">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 font-mono bg-bg-2 border border-line rounded">↑</kbd>
              <kbd className="px-1 py-0.5 font-mono bg-bg-2 border border-line rounded">↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 font-mono bg-bg-2 border border-line rounded">↵</kbd>
              jump
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function RowIcon({ entry }: { entry: Entry }) {
  if (entry.kind === 'guild') {
    return (
      <span className="relative w-7 h-7 shrink-0">
        <span
          className={`absolute inset-0 rounded-md flex items-center justify-center text-xs font-semibold ${avatarColor(
            entry.id,
          )}`}
        >
          <span className="zk-avatar-initials">{avatarInitials(entry.label)}</span>
        </span>
        {entry.iconUrl && (
          <img src={entry.iconUrl} alt="" className="absolute inset-0 w-full h-full rounded-md object-cover" />
        )}
      </span>
    );
  }
  if (entry.kind === 'channel') {
    if (entry.channelType === 'guild_voice') return <Volume2 size={14} className="text-ink-3 shrink-0" />;
    if (entry.channelType === 'guild_stage') return <Radio size={14} className="text-ink-3 shrink-0" />;
    return <Hash size={14} className="text-ink-3 shrink-0" />;
  }
  // DM
  return (
    <span
      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${avatarColor(
        entry.id,
      )}`}
    >
      <span className="zk-avatar-initials">{avatarInitials(entry.label)}</span>
    </span>
  );
}
