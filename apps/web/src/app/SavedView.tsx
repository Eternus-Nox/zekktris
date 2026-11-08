/**
 * SavedView
 * ---------
 * Paginated list of the user's saved messages (bookmarks),
 * newest-saved first. Reachable from the DM list sidebar nav.
 *
 * Each saved entry renders:
 *   - A context line: "Saved from #general · 2 days ago" for
 *     guild channels, "Saved from your conversation with Alice
 *     · 2 days ago" for DMs.
 *   - The full message body (author avatar, name, timestamp,
 *     text, attachments).
 *   - A bookmark-filled toggle that removes the save.
 *
 * Pagination is cursor-based on `savedAt` descending. We append
 * a new page when the user scrolls within 200px of the bottom
 * AND there's a nextCursor available.
 *
 * The local list state is canonical for this page — we don't
 * sync from global state.savedMessageIds because that set is a
 * decorative flag, not the full hydrated entry. Unsaving from
 * here triggers a local splice AND a SAVED_TOGGLE dispatch so
 * the MessageItem bookmark icon elsewhere flips correctly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Bookmark, ChevronLeft } from '../lib/icons';
import { renderMessageContent } from '../lib/markdown';
import { useGoneMessages, withoutGone } from '../lib/useGoneMessages';

interface SavedItem {
  savedAt: string;
  message: Message;
  channel: {
    id: string;
    type: string;
    name: string | null;
    guildId: string | null;
  } | null;
}

export function SavedView() {
  const { rest, user } = useAuth();
  const toasts = useToasts();
  const nav = useNavigate();
  const guildsById = useAppStateSelector((v) => v.state.guildsById);
  const usersById = useAppStateSelector((v) => v.state.usersById);
  const channelsByGuild = useAppStateSelector((v) => v.state.channelsByGuild);
  const emojisByGuild = useAppStateSelector((v) => v.state.emojisByGuild);
  const toggleSavedMessage = useAppStateSelector(
    (v) => v.toggleSavedMessage,
  );

  // Render context — looked up by id, falls back to undefined when
  // the source guild/channel isn't loaded locally (e.g. we have a
  // bookmark from a server the user left). renderMessageContent
  // gracefully renders these as raw `<@id>` tokens.
  const renderCtx = {
    lookupUser: (id: string) => usersById[id],
    lookupChannel: (id: string) => {
      for (const guildId of Object.keys(channelsByGuild)) {
        const found = channelsByGuild[guildId]?.find((c) => c.id === id);
        if (found) return found;
      }
      return undefined;
    },
    selfUserId: user?.id,
    lookupEmoji: (name: string) => {
      for (const guildId of Object.keys(emojisByGuild)) {
        const found = emojisByGuild[guildId]?.find((e) => e.name === name);
        if (found) return found;
      }
      return undefined;
    },
  };

  const [items, setItems] = useState<SavedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Guard against re-entrancy on the bottom-of-list paginator.
  const fetchingMoreRef = useRef(false);
  // A saved message deleted, or a disappearing one reaching its deadline,
  // leaves the list when it leaves the chat (lib/useGoneMessages); the
  // server no longer lists it either.
  const gone = useGoneMessages(null, (g) =>
    setItems((prev) => withoutGone(prev, g, (it) => it.message.id)),
  );

  const loadPage = useCallback(
    async (cursor: string | null) => {
      try {
        setLoading(true);
        setError(null);
        const r = await rest.listSavedMessages({
          cursor: cursor ?? undefined,
        });
        const fresh = r.items.filter((it) => !gone.has(it.message.id));
        setItems((prev) => (cursor ? [...prev, ...fresh] : fresh));
        setNextCursor(r.nextCursor);
        setLoadedOnce(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load saved messages');
      } finally {
        setLoading(false);
        fetchingMoreRef.current = false;
      }
    },
    [rest, gone],
  );

  // Initial load on mount.
  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  // Scroll-to-bottom paginator.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (fetchingMoreRef.current) return;
    if (!nextCursor) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 200) {
      fetchingMoreRef.current = true;
      void loadPage(nextCursor);
    }
  }

  function jumpToMessage(channelId: string, guildId: string | null, messageId: string) {
    if (guildId) {
      nav(`/channels/${guildId}/${channelId}/${messageId}`);
    } else {
      nav(`/channels/@me/${channelId}/${messageId}`);
    }
  }

  async function unsave(messageId: string) {
    // Optimistic: drop from local list immediately. Toggle action
    // also handles REST + global-state dispatch + revert-on-error.
    setItems((prev) => prev.filter((it) => it.message.id !== messageId));
    try {
      await toggleSavedMessage(messageId);
    } catch {
      // toggleSavedMessage already toasted; re-fetch to recover any
      // entry that was wrongly removed. Cheap because the list is
      // small.
      toasts.push('Could not remove bookmark — refreshing…', 'error');
      void loadPage(null);
    }
  }

  function channelLabel(it: SavedItem): string {
    const ch = it.channel;
    if (!ch) return 'Saved message';
    if (ch.type === 'dm' || ch.type === 'group_dm') {
      return 'Saved from direct message';
    }
    if (ch.name) return `Saved from #${ch.name}`;
    if (ch.guildId && guildsById[ch.guildId]) {
      return `Saved from ${guildsById[ch.guildId]!.name}`;
    }
    return 'Saved message';
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-line flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => nav('/channels/@me')}
          className="xl:hidden -ml-1 mr-0.5 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={20} />
        </button>
        <Bookmark size={16} className="text-accent" filled />
        <h1 className="text-base font-semibold text-ink-1">Saved messages</h1>
      </header>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scrollbar-thin"
      >
        {!loadedOnce && loading && (
          <div className="px-4 py-8 text-center text-ink-3 text-sm">
            Loading your bookmarks…
          </div>
        )}
        {loadedOnce && items.length === 0 && (
          <div className="px-4 py-12 text-center text-ink-3 text-sm space-y-2">
            <div className="flex justify-center">
              <Bookmark size={32} className="text-ink-3" />
            </div>
            <p className="text-ink-2">No saved messages yet.</p>
            <p className="text-xs text-ink-3 max-w-md mx-auto leading-relaxed">
              Hover over any message and tap the bookmark icon to save it
              here. Bookmarks are private — only you can see them.
            </p>
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-red-300 text-sm bg-red-950/30 border-b border-red-900/40">
            {error}
          </div>
        )}
        {items.map((it) => {
          const m = it.message;
          const author = m.author?.id ? (usersById[m.author.id] ?? m.author) : m.author;
          const displayName = author?.displayName || author?.username || 'Unknown';
          const initials = displayName.slice(0, 1).toUpperCase();
          return (
            <article
              key={`${m.id}-${it.savedAt}`}
              className="border-b border-line/60 hover:bg-bg-2/40 transition-colors group"
            >
              <header className="flex items-center gap-2 px-4 pt-3 pb-1 text-xs">
                <Bookmark size={11} className="text-accent shrink-0" filled />
                <span className="text-ink-3">{channelLabel(it)}</span>
                <span className="text-ink-3">·</span>
                <span className="text-ink-3">
                  {new Date(it.savedAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {it.channel && (
                    <button
                      type="button"
                      onClick={() =>
                        jumpToMessage(it.channel!.id, it.channel!.guildId, m.id)
                      }
                      className="px-2 py-0.5 rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 text-xs"
                    >
                      Jump
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void unsave(m.id)}
                    className="px-2 py-0.5 rounded text-ink-2 hover:text-red-300 hover:bg-red-950/30 text-xs"
                    title="Remove bookmark"
                  >
                    Remove
                  </button>
                </div>
              </header>
              <div className="px-4 pb-3 pt-1 flex gap-3">
                <div
                  className="w-9 h-9 rounded-full bg-bg-3 flex items-center justify-center text-sm font-semibold text-ink-1 overflow-hidden shrink-0"
                  aria-hidden
                >
                  {author?.avatarUrl ? (
                    <img
                      src={author.avatarUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    initials
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="font-semibold text-ink-1 text-sm">
                      {displayName}
                    </span>
                    <span className="text-[0.65rem] text-ink-3">
                      {new Date(m.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <div className="text-ink-1 text-sm whitespace-pre-wrap break-words">
                    {renderMessageContent(m.content, renderCtx)}
                  </div>
                </div>
              </div>
            </article>
          );
        })}
        {loading && loadedOnce && (
          <div className="px-4 py-4 text-center text-ink-3 text-xs">
            Loading more…
          </div>
        )}
      </div>
    </div>
  );
}
