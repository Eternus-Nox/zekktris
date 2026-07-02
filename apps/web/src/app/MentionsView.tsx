/**
 * MentionsView
 * ------------
 * Top-rail inbox: lists the user's recent @-mentions across every
 * channel they can currently see. Click an entry to navigate to
 * `/channels/G/C/M` — the message-link route handles loading the
 * around-window and scrolling to the message.
 *
 * Architecture:
 *   - Backed by GET /users/@me/mentions (server filters by current
 *     guild membership + DM participant).
 *   - Pagination via `before` (snowflake of the oldest shown entry).
 *     Auto-loads when the user scrolls near the bottom of the panel.
 *   - No "mark as read" affordance in v1 — the inbox is a discovery
 *     tool; once you click a mention you're at the message and the
 *     existing per-channel ack handles unread state.
 *
 * Renders as a Shell pane (rail + content layout), not a modal.
 * Navigation away happens via clicking another rail tile (Home,
 * Discover, a guild). Matches the Discover/Admin pattern.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Message } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { AtSign, Hash, X } from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';

/** Mention rows carry channel + guild context the augmented endpoint
    attaches, so the view doesn't need to resolve channelId → guildId
    via state (which might not have the channel loaded yet). */
type MentionEntry = Message & { guildId: string | null; channelName: string | null };

const PAGE_LIMIT = 25;

export function MentionsView() {
  const { rest } = useAuth();
  const { state } = useAppState();
  const nav = useNavigate();

  const [items, setItems] = useState<MentionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [clearing, setClearing] = useState(false);
  const inFlightRef = useRef(false);
  const toasts = useToasts();

  // Clear handler. Server zeros mention_count across every channel
  // for this user; gateway dispatches CHANNEL_ACK per affected
  // channel so other tabs / devices drop their badges in sync. We
  // also empty the local items list so this view's inbox shows the
  // empty-state immediately (no need to refetch).
  async function onClear() {
    if (clearing || items.length === 0) return;
    setClearing(true);
    try {
      // Optimistic clear — feels instant. The refetch below gives
      // authoritative state within ~200ms; if it returns rows
      // (watermark didn't stick, race with new mentions, anything)
      // those repopulate the list so the user isn't confused by an
      // inbox that looked cleared but wasn't.
      const res = await rest.clearMentions();
      setItems([]);
      setHasMore(false);
      if (res.cleared > 0) {
        toasts.push(
          res.cleared === 1 ? 'Cleared 1 mention' : `Cleared ${res.cleared} mentions`,
          'success',
        );
      }
      // Verification refetch. We re-issue the same listMentions
      // query the inbox uses on mount; if the watermark write took
      // effect, this returns []. Anything that comes back means the
      // server didn't honor the clear (which is a bug to surface,
      // not hide), so we repopulate the list with what's left.
      try {
        const r = await rest.listMentions({ limit: PAGE_LIMIT });
        if (r.mentions.length > 0) {
          setItems(r.mentions);
          setHasMore(r.mentions.length === PAGE_LIMIT);
          // Quiet warning — the toast above already claimed success;
          // a second toast contradicting that would be jarring.
          // Console is enough for an engineer to track down.
          // eslint-disable-next-line no-console
          console.warn(
            'Mentions refetch after clear returned %d rows — watermark may not have applied.',
            r.mentions.length,
          );
        }
      } catch {
        // Refetch failure isn't worth surfacing — the clear itself
        // succeeded per the prior response. The next normal page
        // load will reconcile.
      }
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Could not clear mentions',
        'error',
      );
    } finally {
      setClearing(false);
    }
  }

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void rest
      .listMentions({ limit: PAGE_LIMIT })
      .then((r) => {
        if (cancelled) return;
        setItems(r.mentions);
        setHasMore(r.mentions.length === PAGE_LIMIT);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Could not load mentions');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rest]);

  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasMore || items.length === 0) return;
    inFlightRef.current = true;
    try {
      const oldest = items[items.length - 1]!;
      const r = await rest.listMentions({ before: oldest.id, limit: PAGE_LIMIT });
      setItems((prev) => [...prev, ...r.mentions]);
      setHasMore(r.mentions.length === PAGE_LIMIT);
    } catch {
      // Quiet — surfacing a paginator error toast is noisy and the
      // user can retry by scrolling away and back.
    } finally {
      inFlightRef.current = false;
    }
  }, [hasMore, items, rest]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    // Trigger paginator when within 200px of the bottom — gives the
    // next page time to fetch before the user reaches an empty state.
    if (el.scrollHeight - (el.scrollTop + el.clientHeight) < 200) {
      void loadMore();
    }
  }

  function goTo(m: MentionEntry) {
    // Augmented endpoint already resolved guildId for us (null for
    // DM channels). DMs route under `@me`.
    const guildSeg = m.guildId ?? '@me';
    // Local-dismiss on click — the user has now seen the mention.
    // The server doesn't have a per-mention read flag yet, so this
    // is a client-side filter; if the user reloads the inbox the
    // mention reappears until the underlying read-state machinery
    // gets a "mention.acked" axis. For the current session it
    // gives the user the "viewed mentions disappear" behavior they
    // expect from an inbox.
    setItems((prev) => prev.filter((x) => x.id !== m.id));
    nav(`/channels/${guildSeg}/${m.channelId}/${m.id}`);
  }

  // Permanently dismiss ONE mention (server deletes the row, so unlike the
  // click-dismiss above it stays gone across reloads). Optimistic with
  // rollback on failure.
  async function onDelete(id: string) {
    const prev = items;
    setItems((arr) => arr.filter((x) => x.id !== id));
    try {
      await rest.deleteMention(id);
    } catch (e) {
      setItems(prev);
      toasts.push(
        e instanceof ApiError ? e.message : 'Could not remove mention',
        'error',
      );
    }
  }

  return (
    <div className="h-full flex flex-col bg-bg-1">
      <header
        className="h-12 border-b bg-bg-2/85 backdrop-blur-sm px-3 sm:px-4 flex items-center gap-2 sm:gap-3 shrink-0"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <AtSign size={16} className="text-accent shrink-0" />
        <h1 className="text-base sm:text-lg font-semibold truncate">Mentions</h1>
        {/* Clear button — bulk-zeros every channel's mention_count for
            the caller. Useful for "I just want the @-pile in the
            sidebar to go away without visiting each channel." Disabled
            while in flight; hidden when the inbox is empty so the
            header stays clean. */}
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => void onClear()}
            disabled={clearing}
            className="ml-auto text-xs font-medium text-ink-2 hover:text-ink-1 disabled:opacity-50 transition-colors px-2 py-1 rounded hover:bg-bg-3"
            title="Mark all mentions as read"
          >
            {clearing ? 'Clearing…' : 'Clear all'}
          </button>
        )}
      </header>

      <div
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin"
        onScroll={onScroll}
      >
        {loading && items.length === 0 && (
          <p className="text-sm text-ink-3 text-center py-8">Loading mentions…</p>
        )}
        {error && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 m-3 rounded px-3 py-2">
            {error}
          </p>
        )}
        {!loading && !error && items.length === 0 && (
          <div className="text-center py-12 px-4">
            <AtSign size={32} className="mx-auto text-ink-3 mb-2" />
            <p className="text-sm text-ink-2">No mentions yet.</p>
            <p className="text-xs text-ink-3 mt-1">
              When someone @-mentions you, it'll show up here.
            </p>
          </div>
        )}

        <ul className="divide-y divide-line">
          {items.map((m) => (
            <MentionRow
              key={m.id}
              message={m}
              channelName={m.channelName}
              guildId={m.guildId ?? null}
              guildName={m.guildId ? state.guildsById[m.guildId]?.name ?? null : null}
              guildIcon={m.guildId ? state.guildsById[m.guildId]?.iconUrl ?? null : null}
              onClick={() => goTo(m)}
              onDelete={() => void onDelete(m.id)}
            />
          ))}
        </ul>

        {hasMore && items.length > 0 && (
          <p className="text-xs text-ink-3 text-center py-3">
            Scroll for older mentions…
          </p>
        )}
        {!hasMore && items.length > 0 && (
          <p className="text-xs text-ink-3 text-center py-3">
            That's all your mentions.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────

function MentionRow({
  message,
  channelName,
  guildId,
  guildName,
  guildIcon,
  onClick,
  onDelete,
}: {
  message: Message;
  channelName: string | null;
  guildId: string | null;
  guildName: string | null;
  guildIcon: string | null;
  onClick: () => void;
  onDelete: () => void;
}) {
  // Author resolution with two layers of fallback:
  //   1. message.author (embedded by hydrateMessages server-side)
  //   2. state.usersById (populated by gateway events)
  //   3. A truncated authorId so the row stays uniquely identifiable
  //      even when both lookups miss.
  //
  // We deliberately never display generic strings like "User" or
  // "Unknown user" — both read as broken placeholders to the
  // viewer even when the underlying state is fine. Showing a
  // hashed snippet of the actual author id makes the row visibly
  // distinct from others and doesn't imply something's wrong.
  const { state } = useAppState();
  const author =
    message.author ??
    (message.authorId ? state.usersById[message.authorId] ?? null : null);
  // A system_join welcome @-mentions the newcomer but is authored, in the
  // data, by the newcomer themself — so their own mentions inbox showed THEIR
  // OWN name. Attribute it to the SERVER (guild name + icon) instead,
  // matching the chat render of the same message.
  const isServerAuthor = message.type === 'system_join';
  const label = isServerAuthor
    ? (guildName ?? 'Server')
    : author?.displayName ??
      author?.username ??
      (message.authorId ? `@${message.authorId.slice(-6)}` : '@system');
  const tone = avatarColor(
    isServerAuthor ? (guildId ?? message.channelId) : (message.authorId ?? message.id),
  );
  const initials = avatarInitials(label);
  const avatarUrl = isServerAuthor ? guildIcon : (author?.avatarUrl ?? null);

  // Content preview — collapse newlines, trim, cap at ~140 chars so
  // the row stays one or two lines tall.
  const preview = (message.content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  // Timestamp display: hours/minutes if today, MMM d otherwise.
  const ts = (() => {
    if (!message.createdAt) return '';
    const d = new Date(message.createdAt);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  })();

  return (
    <li className="group relative">
      {/* Remove-one button — sibling (not nested) so it's valid HTML; shows
          on hover. Stops propagation so it doesn't also navigate. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-red-300 hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Remove this mention"
        aria-label="Remove this mention"
      >
        <X size={14} />
      </button>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left px-3 py-2.5 pr-10 hover:bg-bg-3/50 transition-colors flex gap-3"
      >
        <span className="relative w-9 h-9 shrink-0">
          <span
            className={`w-full h-full rounded-full flex items-center justify-center text-xs font-bold overflow-hidden ${tone}`}
          >
            <span className="zk-avatar-initials">{initials}</span>
            <AvatarImage src={avatarUrl} />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-ink-1 truncate">{label}</span>
            <span className="text-[0.65rem] text-ink-3 tabular-nums shrink-0">{ts}</span>
          </span>
          <span className="block text-xs text-ink-3 flex items-center gap-1 mt-0.5">
            <Hash size={10} />
            <span className="truncate">
              {channelName ?? 'channel'}
              {guildName ? ` · ${guildName}` : ''}
            </span>
          </span>
          {preview && (
            <span className="block text-xs text-ink-2 mt-1 line-clamp-2 leading-snug">
              {preview}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
