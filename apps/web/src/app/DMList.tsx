/**
 * DMList
 * ------
 * Second column when the user is in DMs view (route /channels/@me/...).
 * Lists each DM channel with the recipient's avatar + display name.
 *
 * Recipient resolution: a DM channel's recipients aren't currently included
 * in the Channel DTO returned by the api. We derive them by scanning the
 * usersById cache for users who AREN'T the current user and have appeared
 * in the channel's recent messages — falling back to the channel's `name`
 * if it has one (some DM types may carry one server-side). For 1:1 DMs in
 * v1 this is good enough; group DMs would need a dedicated recipients
 * field on the DTO, which is a server-side change deferred to v1.x.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Channel, Message, PublicUser } from '@zekktris/client';
import { useAppStateSelector, isChannelUnread, channelMentionCount, isChannelMuted } from '../state/AppState';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { Search, X, Calendar, Users, Bookmark, ShieldE2ee } from '../lib/icons';
import { ChannelMenu } from './ChannelMenu';

export function DMList({ activeChannelId }: { activeChannelId: string | undefined }) {
  // Granular subscriptions (was `useAppState()`). Only the DM list + loaded
  // flag drive this component; the local `state` keeps existing reads.
  const dmChannels = useAppStateSelector((v) => v.state.dmChannels);
  const loadedDMs = useAppStateSelector((v) => v.state.loadedDMs);
  const state = { dmChannels, loadedDMs };
  // Most-recent conversation first. Recency = the channel's last message
  // (a time-ordered snowflake, kept current by the reducer), falling back
  // to the channel id (its creation snowflake) for brand-new empty DMs.
  // Compared as BigInt since snowflakes can differ in length.
  const dms = useMemo(() => {
    const recency = (c: (typeof state.dmChannels)[number]) => {
      const key = c.lastMessageId && /^\d+$/.test(c.lastMessageId) ? c.lastMessageId : c.id;
      return /^\d+$/.test(key) ? BigInt(key) : 0n;
    };
    return [...state.dmChannels].sort((a, b) => {
      const ra = recency(a);
      const rb = recency(b);
      return ra > rb ? -1 : ra < rb ? 1 : 0;
    });
  }, [state.dmChannels]);
  const navigate = useNavigate();
  const [searching, setSearching] = useState(false);

  return (
    <>
      {/* Quick switcher — sits at the top of the DM rail (where the
          'Direct Messages' title used to be). Order per product
          direction: Friends, Your Events, Saved Messages, Scheduled
          Messages. Each loads its view in the main frame. */}
      <div
        className="px-2 pt-3 pb-2 border-b"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <button
          type="button"
          onClick={() => navigate('/friends')}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-ink-2 hover:bg-bg-3 hover:text-ink-1 transition-colors"
        >
          <Users size={16} className="text-ink-3" />
          <span className="flex-1 text-left">Friends</span>
        </button>
        <button
          type="button"
          onClick={() => navigate('/events')}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-ink-2 hover:bg-bg-3 hover:text-ink-1 transition-colors mt-0.5"
        >
          <Calendar size={16} className="text-ink-3" />
          <span className="flex-1 text-left">Your events</span>
        </button>
        <button
          type="button"
          onClick={() => navigate('/saved')}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-ink-2 hover:bg-bg-3 hover:text-ink-1 transition-colors mt-0.5"
        >
          <Bookmark size={16} className="text-ink-3" />
          <span className="flex-1 text-left">Saved messages</span>
        </button>
        <button
          type="button"
          onClick={() => navigate('/scheduled')}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-ink-2 hover:bg-bg-3 hover:text-ink-1 transition-colors mt-0.5"
        >
          <Calendar size={16} className="text-ink-3" />
          <span className="flex-1 text-left">Scheduled messages</span>
        </button>
      </div>

      {searching ? (
        // Cross-DM search view replaces the conversation list while
        // active. Closing returns to the list.
        <DMSearch onClose={() => setSearching(false)} />
      ) : (
        <nav className="flex-1 overflow-y-auto scrollbar-thin pb-2">
          {/* 'Direct Messages' title now lives directly above the
              conversation list, with the search toggle beside it. */}
          <div className="px-4 pt-3 pb-1 flex items-center justify-between gap-2">
            <div className="font-semibold text-xs uppercase tracking-wide text-ink-3">
              Direct Messages
            </div>
            <button
              type="button"
              onClick={() => setSearching(true)}
              className="w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-colors"
              aria-label="Search direct messages"
              title="Search direct messages"
            >
              <Search size={15} />
            </button>
          </div>
          {!state.loadedDMs ? (
            <div className="px-4 text-ink-3 text-sm">Loading…</div>
          ) : dms.length === 0 ? (
            <div className="px-4 text-ink-3 text-sm">
              No conversations yet. Open one from a server's member list.
            </div>
          ) : (
            <ul className="px-2">
              {dms.map((ch) => (
                <DMRow key={ch.id} channel={ch} active={ch.id === activeChannelId} />
              ))}
            </ul>
          )}
        </nav>
      )}
    </>
  );
}

/**
 * Cross-DM search affordance. Queries the
 * GET /users/@me/dms/search endpoint with a 300ms debounce on
 * typing; results are message rows tagged with their channel id
 * so tapping one opens the right DM at the right point.
 *
 * No filter chips here — the per-channel SearchPanel has them
 * (from:, before:, after:) but those make less sense at the
 * cross-conversation level. Plain keyword search is the right
 * default for "find that thing in some DM."
 */
function DMSearch({ onClose }: { onClose: () => void }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus on mount so the user can start typing immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced fetch. 300ms is long enough to coalesce typing into
  // one request per pause; short enough that the user doesn't feel
  // the lag. Cancelling the previous timer means partial queries
  // ("a", "ab", "abc") don't all hit the server.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      rest
        .searchDirectMessages(trimmed)
        .then((r) => {
          if (!cancelled) setResults(r.messages);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : 'Search failed';
          toasts.push(msg, 'error');
          setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, rest, toasts]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        className="px-3 pt-2 pb-2 border-b shrink-0"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all DMs…"
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-bg-1/60 backdrop-blur-sm border rounded-md text-ink-1 placeholder:text-ink-3 focus:outline-none transition-all focus:shadow-[0_0_0_1px_var(--accent-glow),0_0_12px_var(--accent-glow)]"
            style={{ borderColor: 'var(--zk-line)' }}
          />
          <button
            type="button"
            onClick={onClose}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
            aria-label="Close search"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {query.trim().length === 0 ? (
          <p className="px-4 py-6 text-xs text-ink-3 text-center">
            Type to search across every direct message conversation you've had.
          </p>
        ) : searching && results === null ? (
          <p className="px-4 py-6 text-xs text-ink-3 text-center">Searching…</p>
        ) : results === null || results.length === 0 ? (
          <p className="px-4 py-6 text-xs text-ink-3 text-center">
            No matches in your DMs.
          </p>
        ) : (
          <ul className="py-1">
            {results.map((m) => (
              <DMSearchResult
                key={m.id}
                message={m}
                onClick={() => {
                  // Navigate to the DM at this message. We append the
                  // message id as a hash so the MessageView can scroll
                  // to it once loaded (existing convention for jump-
                  // to-message links).
                  navigate(`/channels/@me/${m.channelId}#m-${m.id}`);
                  onClose();
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DMSearchResult({ message, onClick }: { message: Message; onClick: () => void }) {
  const usersById = useAppStateSelector((v) => v.state.usersById);
  const state = { usersById };
  const authorId = message.authorId ?? '';
  const author = authorId ? state.usersById[authorId] : undefined;
  const label = author?.displayName ?? author?.username ?? (authorId ? 'Unknown' : 'System');
  const tone = avatarColor(authorId || message.id);
  // Truncate to a single-line preview. The full message renders
  // when the user clicks through.
  const preview = (message.content ?? '').replace(/\s+/g, ' ').slice(0, 120);
  const ts = new Date(message.createdAt).toLocaleDateString();
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left px-3 py-2 hover:bg-bg-3 transition-colors flex items-start gap-2"
      >
        <div
          className={`relative w-7 h-7 rounded-full text-xs flex items-center justify-center font-medium shrink-0 overflow-hidden ${tone}`}
        >
          <span>{avatarInitials(label)}</span>
          <AvatarImage src={author?.avatarUrl} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-ink-1 truncate">{label}</span>
            <span className="text-[0.65rem] text-ink-3 shrink-0">{ts}</span>
          </div>
          <div className="text-xs text-ink-2 truncate">
            {preview || <span className="italic text-ink-3">(no text — attachment)</span>}
          </div>
        </div>
      </button>
    </li>
  );
}

function DMRow({ channel, active }: { channel: Channel; active: boolean }) {
  const notificationOverrides = useAppStateSelector((v) => v.state.notificationOverrides);
  const readStateByChannel = useAppStateSelector((v) => v.state.readStateByChannel);
  // Only subscribe to THIS DM's messages, and only as a legacy fallback when
  // the server didn't provide recipients. Subscribing to the whole
  // messagesByChannel map re-rendered every visible DM row on every message
  // in ANY channel (its reference changes on each append/patch/receipt).
  const fallbackMessages = useAppStateSelector((v) =>
    channel.recipients && channel.recipients.length > 0
      ? undefined
      : v.state.messagesByChannel[channel.id],
  );
  const ackChannel = useAppStateSelector((v) => v.ackChannel);
  const setNotificationOverride = useAppStateSelector((v) => v.setNotificationOverride);
  const state = { notificationOverrides, readStateByChannel };
  const { user, rest } = useAuth();
  const selfId = user?.id;
  const toasts = useToasts();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // DMs don't have a guildId, so only per-channel mute applies. Same
  // rule as ChannelRow: muted suppresses the "unread" dimming but
  // mention badges still show.
  const muted = isChannelMuted(state.notificationOverrides, channel.id, null);
  const rawUnread = !active && isChannelUnread(channel, state.readStateByChannel);
  const mentions = channelMentionCount(channel.id, state.readStateByChannel);
  const unread = muted ? false : rawUnread;
  const lastMessageId = channel.lastMessageId ?? null;
  // Resolve the displayed recipient. Priority order:
  //   1. channel.recipients (server-provided, excludes self) — the
  //      authoritative source. For 1:1 DMs there's exactly one entry.
  //   2. Newest non-self message author from the loaded message stream
  //      (legacy fallback for sessions where the channel was hydrated
  //      before this field existed)
  //   3. channel.name (group DMs may have a custom name)
  //   4. "Direct message" — last-resort generic label
  const recipient: PublicUser | null = (() => {
    if (channel.recipients && channel.recipients.length > 0) {
      return channel.recipients[0]!;
    }
    const messages = fallbackMessages;
    if (messages) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        // Crucially: skip self-authored messages. Without this filter
        // a DM where you're the only one who's spoken would show
        // YOUR name as the recipient — confusing and wrong.
        if (m.author && m.author.id && m.author.id !== selfId) return m.author;
      }
    }
    return null;
  })();
  const displayName = recipient?.displayName ?? channel.name ?? 'Direct message';
  const initials = avatarInitials(displayName);
  const tone = avatarColor(recipient?.id ?? channel.id);
  const status = recipient?.status ?? 'offline';
  const dot =
    status === 'online'
      ? 'bg-emerald-500'
      : status === 'idle'
        ? 'bg-amber-500'
        : status === 'dnd'
          ? 'bg-red-500'
          : 'bg-ink-3';

  return (
    <li>
      <Link
        to={`/channels/@me/${channel.id}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAnchor({ x: e.clientX, y: e.clientY });
        }}
        className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
          active
            ? 'row-active'
            : unread
              ? 'text-ink-1 font-medium hover:bg-bg-3/50'
              : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3/50'
        }`}
      >
        <span className="relative w-9 h-9 shrink-0">
          <span className={`absolute inset-0 rounded-full text-sm flex items-center justify-center font-medium ${tone}`}>
            {initials || '?'}
          </span>
          <AvatarImage src={recipient?.avatarUrl} />
          <span
            aria-hidden
            className={`absolute bottom-0 right-0 w-[11px] h-[11px] rounded-full border-2 border-bg-2 ${dot}`}
          />
          {channel.e2eeEnabled && (
            // End-to-end encrypted indicator — moved here (upper-right of
            // the DM's profile picture) from the per-message + header
            // positions, so it's a single quiet badge per conversation.
            <span
              className="absolute -top-1 -right-1 rounded-full p-px flex items-center justify-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
              title="End-to-end encrypted"
              aria-label="End-to-end encrypted"
            >
              <ShieldE2ee size={11} />
            </span>
          )}
        </span>
        <span className="truncate flex-1 text-[15px]">{displayName}</span>
        {typeof channel.streak === 'number' && channel.streak > 0 && (
          // Messaging streak: consecutive UTC days both parties messaged.
          // Mirrors the iOS flame chip (amber tint, mono count).
          <span
            className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-ink-1 font-mono text-[10px] leading-none shrink-0"
            title={`${channel.streak}-day messaging streak`}
          >
            {/* iOS (StreakChip): amber flame + ink-white count, soft-cornered
                rectangle. The flame is an inline icon centered against the digit
                via vertical-align:middle — the standard icon/text alignment. (It
                used to live in an inline-flex, where vertical-align is a no-op, so
                the flame sat low and looked off-center next to the number.) */}
            <svg
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="text-amber-400 inline-block align-middle mr-0.5"
              aria-hidden
            >
              <path d="M13.5 0.67s0.74 2.65 0.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l0.03-0.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5 0.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-0.36 3.6-1.21 4.62-2.58 0.39 1.29 0.59 2.65 0.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" />
            </svg>
            {channel.streak}
          </span>
        )}
        {muted && (
          // Bell-with-strike glyph beside the name when this DM is muted
          // — same indicator used for muted channels, so the meaning is
          // consistent across the app.
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-ink-3 shrink-0"
            aria-label="Muted"
          >
            <title>Muted</title>
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
            <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
            <path d="M18 8a6 6 0 0 0-9.33-5" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
        {mentions > 0 ? (
          <span className="text-[0.65rem] font-bold bg-red-500 text-white rounded-full min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center">
            {mentions > 99 ? '99+' : mentions}
          </span>
        ) : unread ? (
          <span aria-label="unread" className="w-1.5 h-1.5 rounded-full bg-ink-1 shrink-0" />
        ) : null}
      </Link>
      {menuAnchor && (
        <ChannelMenu
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          items={[
            {
              label: 'Mark as read',
              disabled: !lastMessageId || !rawUnread,
              onClick: () => {
                if (!lastMessageId) return;
                void ackChannel(channel.id, lastMessageId).catch(() => {
                  toasts.push('Could not mark as read', 'error');
                });
              },
            },
            {
              label: muted ? 'Unmute conversation' : 'Mute conversation',
              onClick: () => {
                void setNotificationOverride(
                  'channel',
                  channel.id,
                  muted ? null : 'nothing',
                ).catch(() => {
                  toasts.push('Could not update mute', 'error');
                });
              },
            },
            {
              label: deleting ? 'Deleting…' : 'Delete conversation',
              destructive: true,
              disabled: deleting,
              onClick: () => {
                // One-tap browser confirm rather than a full modal —
                // the action is recoverable (re-DM the person to get
                // a fresh channel) but stickier than mute, so we want
                // a deliberate gate. The other person is unaffected.
                if (
                  !confirm(
                    `Delete this conversation with ${displayName}? It'll be removed from your DMs. They'll keep their copy.`,
                  )
                )
                  return;
                setDeleting(true);
                void rest
                  .closeDM(channel.id)
                  .then(() => {
                    // The gateway broadcast will remove the channel
                    // from AppState (via CHANNEL_DELETE handler),
                    // which automatically dismisses this row.
                    toasts.push('Conversation deleted', 'success');
                  })
                  .catch(() => {
                    toasts.push('Could not delete conversation', 'error');
                    setDeleting(false);
                  });
              },
            },
          ]}
        />
      )}
    </li>
  );
}
