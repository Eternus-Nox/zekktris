/**
 * ScheduledMessagesView
 * ---------------------
 * List of the user's pending scheduled messages, soonest-first.
 * Reachable from the DM list sidebar nav at /scheduled.
 *
 * Each entry shows:
 *   - Channel context: "Will send to #general" for guild channels,
 *     "Will send to direct message" for DMs. (The channel name
 *     resolves from the client's channelsByGuild cache; if the
 *     channel isn't loaded we fall back to a generic label.)
 *   - When it fires: relative format ("in 2 hours", "tomorrow at
 *     9am", "next Tuesday at noon") so the user can quickly orient
 *     without doing date math.
 *   - Content snippet (first 200 chars + ellipsis).
 *   - Failure tag with lastError text when the worker maxed out
 *     its retries — surfaces broken rows so the user knows to
 *     investigate (e.g. lost permission to the destination channel).
 *   - Cancel button — optimistic local removal + REST DELETE.
 *
 * No pagination in v1: scheduled-message lists are practically tiny
 * (most users will have <10 pending). The endpoint caps at 200 which
 * is more than anyone will hit in practice.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Calendar, X, ChevronLeft } from '../lib/icons';
import { useNavigate } from 'react-router-dom';

interface ScheduledItem {
  id: string;
  channelId: string;
  content: string;
  attachments: unknown[];
  replyToMessageId: string | null;
  scheduledFor: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

/** Format an ISO scheduled-for as a relative + absolute pair.
    Returns { relative, absolute } where relative is "in 2 hours"
    / "tomorrow at 9:00 AM" / "next Tue 12:00 PM" and absolute is
    the full localized date+time string for the title tooltip. */
function formatScheduledFor(iso: string): { relative: string; absolute: string } {
  const d = new Date(iso);
  const now = new Date();
  const ms = d.getTime() - now.getTime();
  const seconds = Math.round(ms / 1000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);

  const absolute = d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  let relative: string;
  if (ms < 0) {
    // Server should be processing this any second now — usually a
    // worker hasn't ticked yet for a freshly-due row.
    relative = 'Sending now…';
  } else if (minutes < 60) {
    relative = minutes < 2 ? 'in less than a minute' : `in ${minutes} minutes`;
  } else if (hours < 24) {
    // Within today: relative hour count is friendlier than absolute time.
    relative = hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
  } else {
    // Day-rollover: absolute time + relative day. "tomorrow at 9:00 AM",
    // "in 3 days at 2:30 PM".
    const time = d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    if (days === 1) relative = `tomorrow at ${time}`;
    else if (days < 7) relative = `in ${days} days at ${time}`;
    else if (days < 14) relative = `next week at ${time}`;
    else relative = absolute;
  }

  return { relative, absolute };
}

/** Renders a scheduled message's body, transparently decrypting it when
    it's E2EE ciphertext (scheduled E2EE messages are stored encrypted and
    fired verbatim). Falls back to a lock note if this device can't decrypt
    (DM locked / no key). */
function ScheduledContent({ content, channelId }: { content: string; channelId: string }) {
  const [text, setText] = useState(content);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { isEncryptedWireFormat, decryptForDm } = await import('../lib/e2ee');
      if (!isEncryptedWireFormat(content)) {
        if (!cancelled) setText(content);
        return;
      }
      const plain = await decryptForDm(content, channelId);
      if (!cancelled) setText(plain ?? '🔒 Encrypted — unlock this conversation to preview');
    })();
    return () => {
      cancelled = true;
    };
  }, [content, channelId]);
  return <>{text}</>;
}

export function ScheduledMessagesView() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const nav = useNavigate();
  const channelsByGuild = useAppStateSelector((v) => v.state.channelsByGuild);
  const dmChannels = useAppStateSelector((v) => v.state.dmChannels);

  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await rest.listScheduledMessages();
      setItems(r.items);
      setLoadedOnce(true);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Could not load scheduled messages',
      );
    } finally {
      setLoading(false);
    }
  }, [rest]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Light auto-refresh: a scheduled message firing while the user
  // has this view open should disappear from the list within a
  // reasonable time. We refresh every 30s — short enough that
  // newly-fired messages drop off promptly, long enough that the
  // server isn't getting hammered by idle clients.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Resolve a channel id → display label. Tries guild channels first
  // (walks all loaded guilds), then DM channels. Falls back to a
  // generic "direct message" if the channel isn't in cache (e.g.
  // user logged out + back in and the DM list hasn't reloaded yet
  // when the scheduled-messages list paints).
  const channelLabel = useCallback(
    (channelId: string): string => {
      for (const guildId of Object.keys(channelsByGuild)) {
        const found = channelsByGuild[guildId]?.find((c) => c.id === channelId);
        if (found) return `#${found.name ?? channelId}`;
      }
      if (dmChannels.some((c) => c.id === channelId)) {
        // For DM channels we don't have a clean "channel name" — we
        // could fetch recipients, but the generic label reads fine.
        return 'direct message';
      }
      return 'channel';
    },
    [channelsByGuild, dmChannels],
  );

  async function cancel(id: string) {
    // Optimistic — drop from local list immediately so the user
    // gets instant feedback. Revert on failure.
    const prev = items;
    setItems((arr) => arr.filter((it) => it.id !== id));
    try {
      await rest.cancelScheduledMessage(id);
      toasts.push('Scheduled message canceled.', 'success');
    } catch (e) {
      setItems(prev);
      toasts.push(
        e instanceof ApiError ? e.message : 'Could not cancel',
        'error',
      );
    }
  }

  const sorted = useMemo(
    () => [...items].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)),
    [items],
  );

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-line flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => nav('/channels/@me')}
          className="xl:hidden -ml-1 mr-0.5 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={18} />
        </button>
        <Calendar size={16} className="text-accent" />
        <h1 className="text-base font-semibold text-ink-1">
          Scheduled messages
        </h1>
      </header>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!loadedOnce && loading && (
          <div className="px-4 py-8 text-center text-ink-3 text-sm">
            Loading your scheduled messages…
          </div>
        )}
        {loadedOnce && items.length === 0 && (
          <div className="px-4 py-12 text-center text-ink-3 text-sm space-y-2">
            <div className="flex justify-center">
              <Calendar size={32} className="text-ink-3" />
            </div>
            <p className="text-ink-2">No scheduled messages.</p>
            <p className="text-xs text-ink-3 max-w-md mx-auto leading-relaxed">
              Tap the calendar icon in the message composer to schedule a
              message for later. Scheduled messages send automatically at
              the time you pick.
            </p>
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-red-300 text-sm bg-red-950/30 border-b border-red-900/40">
            {error}
          </div>
        )}
        {sorted.map((it) => {
          const fmt = formatScheduledFor(it.scheduledFor);
          const failed = it.attempts >= 3;
          return (
            <article
              key={it.id}
              className="border-b border-line/60 hover:bg-bg-2/40 transition-colors group px-4 py-3"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <Calendar
                      size={11}
                      className={failed ? 'text-red-300' : 'text-accent'}
                    />
                    <span className="text-ink-3">
                      Will send to{' '}
                      <span className="text-ink-2 font-medium">
                        {channelLabel(it.channelId)}
                      </span>
                    </span>
                    <span className="text-ink-3">·</span>
                    <span
                      className={failed ? 'text-red-300' : 'text-ink-1'}
                      title={fmt.absolute}
                    >
                      {failed ? `Failed — ${fmt.relative}` : fmt.relative}
                    </span>
                    {failed && (
                      <span className="px-1.5 py-0.5 rounded bg-red-950/50 text-red-200 text-[0.65rem] uppercase tracking-wide">
                        max retries
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 text-sm text-ink-1 whitespace-pre-wrap break-words line-clamp-3">
                    <ScheduledContent content={it.content} channelId={it.channelId} />
                  </div>
                  {failed && it.lastError && (
                    <div className="mt-1.5 text-[0.7rem] text-red-300/80 italic">
                      Last error: {it.lastError}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void cancel(it.id)}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-red-300 hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Cancel scheduled send"
                  aria-label="Cancel scheduled send"
                >
                  <X size={14} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
