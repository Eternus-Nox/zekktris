/**
 * MyEventsModal
 * -------------
 * Cross-guild personal dashboard. Lists every event the caller has
 * RSVP'd to with status going-or-maybe, across all guilds they're
 * currently a member of. Each card shows guild affiliation,
 * event details, and RSVP-change controls.
 *
 * Data flow: one-shot REST fetch on mount. Doesn't subscribe to
 * gateway broadcasts because the cross-guild filter would require
 * either:
 *
 *   (a) listening to scheduledEvent events from all guilds AND
 *       maintaining a separate "is this event in my RSVP set?"
 *       projection, or
 *
 *   (b) a dedicated server-side cross-guild broadcast event.
 *
 * Both add complexity that doesn't pay off for v1. Refetching on
 * each open is cheap given the 50-item server cap and the small
 * blast radius (only the user themselves cares about this view).
 *
 * RSVP changes use the existing per-guild rsvpEvent / clearEventRsvp
 * endpoints. After mutation, we refetch to reconcile against the
 * server (the list shape may have changed — declining removes the
 * event from this view).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ApiError, GatewayEvent, type ScheduledEvent } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Portal } from '../lib/Portal';
import { X, Calendar, MapPin, Mic, ChevronLeft } from '../lib/icons';
import { useNavigate } from 'react-router-dom';
import { avatarColor, avatarInitials } from '../lib/avatar';

interface MyEventItem {
  event: ScheduledEvent;
  guildName: string;
  guildIconUrl: string | null;
}

export function MyEventsModal({
  onClose,
  onOpenGuild,
  inline = false,
}: {
  onClose: () => void;
  /** Switch to the given guild — implementations typically set
   *  the active guild in app state and route to the guild's
   *  default channel. */
  onOpenGuild: (guildId: string) => void;
  /** When true, render in the main content frame (no modal overlay
   *  / backdrop / close button) so it feels baked into the app. */
  inline?: boolean;
}) {
  const { rest, gateway } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();
  const nav = useNavigate();
  const [items, setItems] = useState<MyEventItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await rest.listMyUpcomingEvents();
      setItems(r.events);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load events');
      setItems([]);
    }
  }, [rest]);

  useEffect(() => {
    void load();
  }, [load]);

  // Subscribe to scheduled-event broadcasts while the modal is open
  // so changes elsewhere (event canceled, time changed, deleted) show
  // up here without a manual refresh. Full-refetch on any broadcast
  // is the simplest correct approach: the list is small (≤50 items
  // server-side cap) and the server's filter for "going/maybe +
  // non-terminal + still-a-member" is hard to replicate client-side.
  //
  // 300ms debounce collapses burst broadcasts (e.g., the expiry sweep
  // transitioning multiple events in one tick, or several admins
  // making changes around the same time) into a single refetch.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const triggerRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void load();
      }, 300);
    };
    const unsubs: Array<() => void> = [];
    unsubs.push(gateway.on(GatewayEvent.SCHEDULED_EVENT_CREATE, triggerRefresh));
    unsubs.push(gateway.on(GatewayEvent.SCHEDULED_EVENT_UPDATE, triggerRefresh));
    unsubs.push(gateway.on(GatewayEvent.SCHEDULED_EVENT_DELETE, triggerRefresh));
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      for (const u of unsubs) u();
    };
  }, [gateway, load]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Body scroll lock while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function handleRsvp(item: MyEventItem, next: 'going' | 'maybe' | 'declined') {
    const eventId = item.event.id;
    if (busy.has(eventId)) return;
    setBusy((prev) => new Set(prev).add(eventId));
    try {
      await rest.rsvpEvent(item.event.guildId, eventId, next);
      // 'declined' removes the item from this view server-side, so
      // refetch to get the correct shape rather than locally
      // filter (avoids a flash if the server result differs from
      // expectation, e.g. an event canceled mid-flight).
      await load();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'RSVP update failed', 'error');
    } finally {
      setBusy((prev) => {
        const n = new Set(prev);
        n.delete(eventId);
        return n;
      });
    }
  }

  function handleOpenGuild(guildId: string) {
    onClose();
    onOpenGuild(guildId);
  }

  // Shared inner content (header + list), reused by both the modal
  // and the inline (main-frame) presentations.
  const body = (
    <>
      {inline ? (
        // Inline header — matches the Friends / Saved / Scheduled
        // header strip exactly (back button + small accent icon +
        // plain title + bottom border).
        <header className="px-4 py-3 border-b border-line flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => nav('/channels/@me')}
            className="xl:hidden -ml-1 mr-0.5 w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
            aria-label="Back to direct messages"
          >
            <ChevronLeft size={18} />
          </button>
          <Calendar size={16} className="text-accent" />
          <h1 className="text-base font-semibold text-ink-1">
            Your upcoming events
          </h1>
        </header>
      ) : (
        <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
          <span className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
            <Calendar size={16} className="text-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="my-events-title" className="text-base font-semibold text-ink-1">
              Your upcoming events
            </h2>
            <p className="text-xs text-ink-3 mt-0.5">
              Events you've said you're going to or might join, across all your servers
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-7 h-7 rounded-md hover:bg-bg-3 text-ink-2 flex items-center justify-center transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {items === null ? (
          <p className="text-sm text-ink-3">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : items.length === 0 ? (
          inline ? (
            // Plain centered empty state, matching Saved / Scheduled.
            <div className="flex flex-col items-center justify-center text-center px-4 py-16">
              <Calendar size={32} className="text-ink-3 mb-2" />
              <p className="text-ink-2 mb-1">No upcoming events</p>
              <p className="text-xs text-ink-3">
                Events you RSVP to in any server appear here.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-line bg-bg-2/50 px-4 py-10 text-center">
              <Calendar size={36} className="mx-auto text-ink-3 mb-2" />
              <p className="text-sm text-ink-2 mb-1">No upcoming events</p>
              <p className="text-xs text-ink-3">
                Events you RSVP to in any server appear here.
              </p>
            </div>
          )
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <MyEventCard
                key={item.event.id}
                item={item}
                busy={busy.has(item.event.id)}
                knownGuild={Boolean(state.guildsById[item.event.guildId])}
                onRsvp={(s) => void handleRsvp(item, s)}
                onOpenGuild={() => handleOpenGuild(item.event.guildId)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );

  if (inline) {
    return <div className="flex flex-col h-full">{body}</div>;
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 bg-bg-1/85 backdrop-blur-sm flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="my-events-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="zk-modal bg-bg-2 border border-line w-full max-w-2xl max-h-[88vh] flex flex-col shadow-2xl">
          {body}
        </div>
      </div>
    </Portal>
  );
}

function MyEventCard({
  item,
  busy,
  knownGuild,
  onRsvp,
  onOpenGuild,
}: {
  item: MyEventItem;
  busy: boolean;
  /** Whether the user's local guild list has this guild — if not
   *  (very rare edge case: just joined and AppState hasn't caught
   *  up), the "Open in server" button is disabled with a tooltip. */
  knownGuild: boolean;
  onRsvp: (status: 'going' | 'maybe' | 'declined') => void;
  onOpenGuild: () => void;
}) {
  const { event, guildName, guildIconUrl } = item;
  const startDate = new Date(event.startAt);
  const endDate = event.endAt ? new Date(event.endAt) : null;
  const now = Date.now();
  const diffMs = startDate.getTime() - now;

  const absoluteTime = startDate.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const relativeTime = useMemo(() => {
    if (event.status === 'active') return 'happening now';
    if (diffMs < 0) return 'starting now';
    const minutes = Math.round(diffMs / 60000);
    if (minutes < 60) return `in ${minutes} min${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(diffMs / 3600000);
    if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(diffMs / 86400000);
    if (days < 14) return `in ${days} day${days === 1 ? '' : 's'}`;
    return null;
  }, [event.status, diffMs]);

  const isActive = event.status === 'active';

  return (
    <li
      className={`rounded-lg border bg-bg-2/60 overflow-hidden ${
        isActive ? 'border-emerald-700/40' : 'border-line'
      }`}
    >
      {/* Banner */}
      {event.imageUrl && (
        <div className="w-full h-24 bg-bg-3 overflow-hidden">
          <img
            src={event.imageUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Guild affiliation row */}
        <div className="flex items-center gap-2">
          {guildIconUrl ? (
            <img
              src={guildIconUrl}
              alt=""
              className="w-5 h-5 rounded-sm object-cover shrink-0"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <span
              className="w-5 h-5 rounded-sm shrink-0 flex items-center justify-center text-[0.55rem] font-semibold text-bg-1"
              style={{ backgroundColor: avatarColor(item.event.guildId) }}
              aria-hidden
            >
              {avatarInitials(guildName)}
            </span>
          )}
          <button
            onClick={onOpenGuild}
            disabled={!knownGuild}
            className="text-xs text-ink-3 hover:text-accent transition-colors truncate disabled:opacity-60 disabled:hover:text-ink-3"
            title={knownGuild ? `Open ${guildName}` : 'You need to be in this server'}
          >
            {guildName}
          </button>
          {isActive && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-emerald-900/40 text-emerald-300 text-[0.6rem] uppercase tracking-wider font-semibold ml-auto">
              <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
              Live
            </span>
          )}
        </div>

        {/* Title */}
        <h3 className="text-base font-semibold text-ink-1 leading-tight">{event.name}</h3>

        {/* Date / location */}
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2 text-ink-2">
            <Calendar size={14} className="shrink-0 text-ink-3" />
            <span className="truncate">
              {absoluteTime}
              {endDate && (
                <span className="text-ink-3">
                  {' '}— {endDate.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </span>
              )}
            </span>
            {relativeTime && (
              <span className="text-xs text-ink-3 shrink-0">· {relativeTime}</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-ink-2">
            {event.locationKind === 'voice_channel' ? (
              <>
                <Mic size={14} className="shrink-0 text-ink-3" />
                <span className="truncate">Voice channel</span>
              </>
            ) : (
              <>
                <MapPin size={14} className="shrink-0 text-ink-3" />
                <span className="truncate">{event.locationText || 'Location TBD'}</span>
              </>
            )}
          </div>
        </div>

        {/* Description preview — first line or 200 chars */}
        {event.description && (
          <p className="text-xs text-ink-3 leading-relaxed line-clamp-2">{event.description}</p>
        )}

        {/* Current RSVP + change controls */}
        <div className="flex items-center gap-1.5 pt-1">
          <RsvpPill
            label="Going"
            active={event.myRsvp === 'going'}
            disabled={busy}
            onClick={() => onRsvp('going')}
            tone="emerald"
          />
          <RsvpPill
            label="Maybe"
            active={event.myRsvp === 'maybe'}
            disabled={busy}
            onClick={() => onRsvp('maybe')}
            tone="amber"
          />
          <RsvpPill
            label="Decline"
            active={false}
            disabled={busy}
            onClick={() => onRsvp('declined')}
            tone="neutral"
          />
        </div>
      </div>
    </li>
  );
}

function RsvpPill({
  label,
  active,
  disabled,
  onClick,
  tone,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  tone: 'emerald' | 'amber' | 'neutral';
}) {
  const activeClass =
    tone === 'emerald'
      ? 'bg-emerald-800/50 text-emerald-200 border-emerald-700/60'
      : tone === 'amber'
        ? 'bg-amber-800/50 text-amber-200 border-amber-700/60'
        : 'bg-bg-3 text-ink-1 border-line';
  const inactiveClass =
    tone === 'emerald'
      ? 'bg-bg-3 text-ink-2 border-line hover:bg-emerald-950/30 hover:text-emerald-300'
      : tone === 'amber'
        ? 'bg-bg-3 text-ink-2 border-line hover:bg-amber-950/30 hover:text-amber-300'
        : 'bg-bg-3 text-ink-2 border-line hover:bg-bg-3/80';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 px-3 py-1.5 rounded-md border text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-wait ${
        active ? activeClass : inactiveClass
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
