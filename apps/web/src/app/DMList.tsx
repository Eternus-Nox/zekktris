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
import { useAppStateSelector, useDmNickname, isChannelUnread, channelMentionCount, isChannelMuted } from '../state/AppState';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { StaffName, UserTag } from '../lib/UserTag';
import { Search, X, Calendar, Clock, Users, Bookmark, Lock, Plus } from '../lib/icons';
import { ChannelMenu } from './ChannelMenu';
import { useGoneMessages, withoutGone } from '../lib/useGoneMessages';
import { isPetNotice, petNoticeLine, petNoticePeer } from '../lib/zekkPet';
import { ZekkPetArt } from '../lib/ZekkPetArt';

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
          <Clock size={16} className="text-ink-3" />
          <span className="flex-1 text-left">Scheduled messages</span>
        </button>
        {/* Search-messages quick row — matches the dedicated iOS row (its
            own magnifier entry). Toggles the cross-DM search view below. */}
        <button
          type="button"
          onClick={() => setSearching(true)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-ink-2 hover:bg-bg-3 hover:text-ink-1 transition-colors mt-0.5"
        >
          <Search size={16} className="text-ink-3" />
          <span className="flex-1 text-left">Search messages</span>
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
              onClick={() => navigate('/friends')}
              className="w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-colors"
              aria-label="New direct message"
              title="New direct message"
            >
              <Plus size={15} />
            </button>
          </div>
          {!state.loadedDMs ? (
            <div className="px-4 text-ink-3 text-sm">Loading…</div>
          ) : dms.length === 0 ? (
            <div className="px-4 text-ink-3 text-sm">No direct messages yet</div>
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
  // A result deleted, or a disappearing message reaching its deadline,
  // leaves the list when it leaves its DM (lib/useGoneMessages).
  const gone = useGoneMessages(null, (g) =>
    setResults((prev) => prev && withoutGone(prev, g, (m) => m.id)),
  );

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
          if (!cancelled) setResults(r.messages.filter((m) => !gone.has(m.id)));
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
  }, [query, rest, toasts, gone]);

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
            {results.map((m) => {
              // Navigate to the DM at this message. We append the
              // message id as a hash so the MessageView can scroll
              // to it once loaded (existing convention for jump-
              // to-message links).
              const open = () => {
                navigate(`/channels/@me/${m.channelId}#m-${m.id}`);
                onClose();
              };
              // A Zekk Pet notice is nobody's message (the daily check
              // files 'asleep' / 'ran_away' under user A), so it reads as
              // the pet's, worded for the viewer like the chat row.
              return isPetNotice(m) ? (
                <DMSearchPetResult key={m.id} message={m} onClick={open} />
              ) : (
                <DMSearchResult key={m.id} message={m} onClick={open} />
              );
            })}
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
          <span className="zk-avatar-initials">{avatarInitials(label)}</span>
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

/** A Zekk Pet notice in DM search: the small pet in place of an avatar,
    "Zekk Pet" in place of a name, and the line the chat shows (MessageItem's
    PetNotice) — "You" for the viewer, never the person the server filed the
    notice under. */
function DMSearchPetResult({ message, onClick }: { message: Message; onClick: () => void }) {
  const usersById = useAppStateSelector((v) => v.state.usersById);
  const channel = useAppStateSelector((v) => v.state.dmChannels.find((c) => c.id === message.channelId));
  const filterProfanity = useAppStateSelector(
    (v) => v.state.supervision?.restrictions?.filterProfanity ?? false,
  );
  const { user } = useAuth();
  const selfId = user?.id;
  const peer = petNoticePeer(channel, message, selfId);
  const peerNick = useDmNickname(peer?.id);
  const peerName = peerNick ?? peer?.displayName ?? peer?.username ?? 'them';
  const author = (message.authorId ? usersById[message.authorId] : undefined) ?? message.author;
  const { text, art } = petNoticeLine({
    message,
    selfId,
    peerId: peer?.id ?? null,
    peerName,
    authorName: author?.displayName ?? author?.username ?? 'Someone',
    nameOf: (id) => usersById[id]?.displayName ?? usersById[id]?.username,
    filterProfanity,
  });
  const preview = text.replace(/\s+/g, ' ').slice(0, 120);
  const ts = new Date(message.createdAt).toLocaleDateString();
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left px-3 py-2 hover:bg-bg-3 transition-colors flex items-start gap-2"
      >
        <div className="w-7 h-7 flex items-center justify-center shrink-0">
          {/* The notice's own colour: the hit may come from a closed DM,
              with no pet loaded to ask. */}
          <ZekkPetArt stage={art.stage} mood={art.mood} size={16} animated={false} color={art.color} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-ink-1 truncate">Zekk Pet</span>
            <span className="text-[0.65rem] text-ink-3 shrink-0">{ts}</span>
          </div>
          <div className="text-xs text-ink-2 truncate">{preview}</div>
        </div>
      </button>
    </li>
  );
}

/**
 * Messaging-streak flame pill (iOS StreakChip parity) — consecutive UTC
 * days both parties messaged. Rendered in DM list rows AND the DM
 * conversation header (MessageView), mirroring iOS which shows the chip
 * in both places.
 *
 * Shares the SAME box metrics as the clan tag (UserTag) — same
 * rounded-md / px-1.5 / asymmetric pt-[2.5px] pb-[1.5px] (nudges the
 * flame+count down a tiny bit so they sit centered in the pill) /
 * text-[10px] / font / leading / border — so the two pills look like
 * a matched set, differing only in color and the flame icon.
 */
export function DmStreakPill({ streak, className = '' }: { streak: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center self-center gap-0.5 whitespace-nowrap rounded-md px-1.5 pt-[2.5px] pb-[1.5px] text-[10px] font-semibold leading-none border bg-[#FFB000]/15 border-[#FFB000]/40 text-ink-1 shrink-0 ${className}`}
      title={`${streak}-day messaging streak`}
    >
      {/* Flame matches the digit's height (10px). It's nudged up a hair to
          align with the digit, whose figure glyphs sit slightly high in
          the line box — that way the count keeps the SAME natural position
          as the clan-tag text (so the two pills line up), while the flame
          still looks centered against it. */}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="text-[#FFB000] shrink-0 relative -top-[0.5px]"
        aria-hidden
      >
        <path d="M13.5 0.67s0.74 2.65 0.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l0.03-0.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5 0.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-0.36 3.6-1.21 4.62-2.58 0.39 1.29 0.59 2.65 0.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" />
      </svg>
      {streak}
    </span>
  );
}

function DMRow({ channel, active }: { channel: Channel; active: boolean }) {
  const notificationOverrides = useAppStateSelector((v) => v.state.notificationOverrides);
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
  const state = { notificationOverrides };
  const { user, rest } = useAuth();
  const selfId = user?.id;
  const toasts = useToasts();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // DMs don't have a guildId, so only per-channel mute applies. `muted`
  // drives ONLY the context-menu label — iOS parity: mute is a
  // notification setting with no row presentation (DMRow in
  // MainView.swift reads `store.isChannelUnread(dm)` unconditionally),
  // so muted DMs keep their unread dot / bold name.
  const muted = isChannelMuted(state.notificationOverrides, channel.id, null);
  // Per-channel selectors returning primitives (mirrors ChannelRow in
  // ChannelList.tsx): useContextSelector bails unless THIS DM's own unread
  // flag / mention count changes, instead of re-rendering every visible DM row
  // whenever the whole readStateByChannel map's reference flips (any message
  // anywhere).
  const poke = useAppStateSelector((v) => v.state.pokePills[channel.id]);
  const unread = useAppStateSelector(
    (v) => !active && isChannelUnread(channel, v.state.readStateByChannel),
  );
  const mentions = useAppStateSelector((v) =>
    channelMentionCount(channel.id, v.state.readStateByChannel),
  );
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
  // Personal DM nickname (viewer-private) takes precedence over the real name.
  const nickname = useDmNickname(recipient?.id);
  const displayName = nickname ?? recipient?.displayName ?? channel.name ?? 'Direct message';
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
              className="absolute -top-0.5 -right-0.5 w-[13px] h-[13px] rounded-full bg-bg-2 border border-accent/45"
              title="End-to-end encrypted"
              aria-label="End-to-end encrypted"
            >
              {/* Placed explicitly rather than flex-centered, ON PURPOSE.
                  The badge's padding box is 11px (13 − 2px border) around an
                  8px glyph, so centering wants 1.5px a side — and Chrome and
                  Safari round that half-pixel in OPPOSITE directions, which is
                  why the lock looked correctly centered in one and a pixel off
                  in the other. Whole-pixel offsets remove the rounding entirely
                  so both engines agree.
                  left 2 / right 1 nudges it right; top 1 / bottom 2 nudges it
                  up, which also compensates the glyph itself: Lock's bbox is
                  y 7→21 in a 24 viewBox (center 14, not 12), i.e. it's drawn
                  2 units low by design — shared with every other Lock call
                  site, so it's corrected here rather than in the icon. */}
              {/* The -0.5px is a TRANSFORM, not a layout offset, on purpose.
                  left/top stay whole-pixel so the two engines still agree on the
                  base position (fractional layout values are what made Chrome
                  and Safari disagree in the first place); a translate is applied
                  at composite time, sub-pixel accurate and identical in both. So
                  this trims the half-pixel of overshoot without reopening the
                  rounding split. */}
              <Lock size={8} className="absolute left-[2px] top-[1px] -translate-x-[0.5px] text-accent" />
            </span>
          )}
        </span>
        {recipient && <UserTag user={recipient} className="-mr-1.5" />}
        {/* Staff names shimmer here too, matching every other place a name is
            shown (message rows, member list, profile). StaffName no-ops for
            non-staff, so this renders identically for everyone else. Note the
            shimmer applies to `displayName`, which may be a private DM nickname
            — the mark follows the PERSON, not the string. Group/system rows have
            no single recipient, so they fall back to plain text. */}
        {recipient ? (
          <StaffName
            user={recipient}
            text={displayName}
            className="truncate min-w-0 text-[15px]"
          />
        ) : (
          <span className="truncate min-w-0 text-[15px]">{displayName}</span>
        )}
        {typeof channel.streak === 'number' && channel.streak > 0 && (
          // Messaging streak: consecutive UTC days both parties messaged.
          <DmStreakPill streak={channel.streak} className="-ml-1" />
        )}
        {/* Spacer pushes the mention/unread indicators to the right edge.
            No muted glyph and no mute-driven dimming — iOS parity: its
            DMRow renders muted conversations identically to unmuted ones
            (mute only changes what notifies, not how the row looks). */}
        <span className="flex-1" />
        {/* The poke someone left while you weren't looking. Sits before the
            unread indicators because it is the more specific signal: an unread
            dot says "something happened", this says what. Clears on open. */}
        {poke && (
          <span
            aria-label={`poked you ${poke}`}
            title="Poked you"
            className="text-[0.8rem] leading-none rounded-full bg-bg-3 border border-line px-1.5 py-1 shrink-0 animate-[zk-poke-pop_220ms_ease-out]"
          >
            {poke}
          </span>
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
              disabled: !lastMessageId || !unread,
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
