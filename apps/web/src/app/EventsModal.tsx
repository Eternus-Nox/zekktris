/**
 * EventsModal
 * -----------
 * Full-screen list of upcoming events for a guild. Members RSVP from
 * here; users with MANAGE_EVENTS can create new events via the inline
 * create button.
 *
 * Data flow: reads `state.eventsByGuild[guildId]` (live state) and
 * triggers `loadGuildEvents` on mount to populate it. Gateway
 * broadcasts (scheduledEventCreate / update / delete) keep the
 * state fresh while the modal is open — no manual refetch needed
 * when another admin edits an event or the sweep flips a status.
 *
 * RSVP UX: each event card has three buttons (Going / Maybe /
 * Decline). The user's current RSVP is highlighted. Clicking a
 * different button switches; clicking the current one clears
 * (DELETE rsvp). Optimistic via EVENT_RSVP_PATCH action; reverts
 * to server state on failure via a fresh loadGuildEvents.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { ApiError, type Guild, type ScheduledEvent } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Portal } from '../lib/Portal';
import { X, Calendar, MapPin, Mic, Trash } from '../lib/icons';
import { computeMemberGuildPerms, hasBit } from '../lib/permissions';
import { CreateEventModal } from './CreateEventModal';
import { EventAttendeesModal } from './EventAttendeesModal';

/** Bit index for MANAGE_EVENTS. Matches the shared Permissions module. */
const PERM_MANAGE_EVENTS = 32;

/** localStorage key for the per-user events view-mode preference.
 *  Sticks across sessions so users don't have to re-pick each open. */
const VIEW_MODE_STORAGE_KEY = 'zekktris.eventsViewMode';

type ViewMode = 'list' | 'agenda';

function loadViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'list';
  try {
    const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return v === 'agenda' ? 'agenda' : 'list';
  } catch {
    return 'list';
  }
}

function saveViewMode(mode: ViewMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage can throw (e.g. Safari private mode). Silent fail
    // is fine — the preference just won't persist this session.
  }
}

/** Group events by local date (YYYY-MM-DD). Returns the entries in
 *  the same order as the input (which is start_at ASC from the
 *  server), so days appear chronologically and events within a day
 *  preserve their time order. */
function groupEventsByDay(
  events: ScheduledEvent[],
): Array<{ dateKey: string; label: string; items: ScheduledEvent[] }> {
  const groups = new Map<string, ScheduledEvent[]>();
  for (const ev of events) {
    const d = new Date(ev.startAt);
    // Local-date key. UTC-key would group differently for events that
    // straddle midnight in different timezones; local matches how
    // users read the agenda.
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const list = groups.get(key);
    if (list) list.push(ev);
    else groups.set(key, [ev]);
  }
  // Build the labeled output. We use the first event's Date as the
  // anchor for formatting the header — same day so any choice works.
  return Array.from(groups.entries()).map(([dateKey, items]) => ({
    dateKey,
    label: formatAgendaDayHeader(new Date(items[0].startAt)),
    items,
  }));
}

function formatAgendaDayHeader(d: Date): string {
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return 'Today';
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  if (isTomorrow) return 'Tomorrow';
  // Otherwise: "Saturday, May 24" — weekday + month/day, no year
  // unless the event is in a different year from now (multi-year
  // out is unusual but worth handling).
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function EventsModal({
  guild,
  onClose,
}: {
  guild: Guild;
  onClose: () => void;
}) {
  const { rest, user } = useAuth();
  const { state, loadGuildEvents } = useAppState();
  const toasts = useToasts();
  // Read live events off AppState. null = not loaded yet (first
  // open); empty array = loaded, no events.
  const events = state.eventsByGuild[guild.id] ?? null;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ScheduledEvent | null>(null);
  const [viewingAttendees, setViewingAttendees] = useState<ScheduledEvent | null>(null);
  const [busyRsvp, setBusyRsvp] = useState<Set<string>>(() => new Set());
  // View mode: list (flat chronological) or agenda (grouped by day).
  // Initial value is the persisted preference; toggling updates both
  // state and localStorage.
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode());

  function changeViewMode(next: ViewMode) {
    setViewMode(next);
    saveViewMode(next);
  }

  // Permission check: viewer with MANAGE_EVENTS can create + manage
  // events. Owner always counts. Computed once per render off of
  // member roles and guild role list.
  const canManageEvents = useMemo(() => {
    if (!user) return false;
    if (user.id === guild.ownerId) return true;
    const myMember = state.membersByGuild[guild.id]?.find((m) => m.userId === user.id);
    const allRoles = state.rolesByGuild[guild.id];
    if (!myMember || !allRoles) return false;
    const perms = computeMemberGuildPerms(allRoles, guild.id, myMember.roleIds, false);
    return hasBit(perms, PERM_MANAGE_EVENTS);
  }, [user, guild.id, guild.ownerId, state.membersByGuild, state.rolesByGuild]);

  // Trigger initial load. The action populates state.eventsByGuild
  // which we read above. Re-fetched lazily if the modal is closed
  // and reopened — gateway deltas keep state fresh in between, so
  // this is more about catching reconnect-window gaps than poll.
  const refreshEvents = useCallback(async () => {
    setError(null);
    try {
      await loadGuildEvents(guild.id);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load events');
      setLoaded(true);
    }
  }, [loadGuildEvents, guild.id]);

  useEffect(() => {
    void refreshEvents();
  }, [refreshEvents]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showCreate && !editingEvent && !viewingAttendees) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, showCreate, editingEvent, viewingAttendees]);

  // Body scroll lock.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function handleRsvp(event: ScheduledEvent, next: 'going' | 'maybe' | 'declined' | null) {
    if (busyRsvp.has(event.id)) return;
    setBusyRsvp((prev) => new Set(prev).add(event.id));
    // Optimistic — dispatch a local RSVP patch through the reducer
    // so the cell re-renders with the new state immediately. On
    // failure we trigger a fresh load to reconcile against the
    // server.
    const counts = { ...(event.rsvpCounts ?? { going: 0, maybe: 0, declined: 0 }) };
    if (event.myRsvp) counts[event.myRsvp] = Math.max(0, counts[event.myRsvp] - 1);
    if (next) counts[next]++;
    // We dispatch via the existing useAppState reducer indirectly by
    // calling rest then loadGuildEvents on completion. To avoid two
    // re-renders on success we just rely on REST → broadcast → reducer
    // (the same broadcast we send to all guild members triggers
    // EVENT_UPSERT here too, with the updated event including the
    // server-computed counts/myRsvp for us). But the broadcast omits
    // myRsvp per the design rule, so we apply the local PATCH for
    // the caller's myRsvp regardless.
    try {
      if (next === null) {
        await rest.clearEventRsvp(guild.id, event.id);
      } else {
        await rest.rsvpEvent(guild.id, event.id, next);
      }
      // Refresh to pull in the server-computed counts. Broadcast
      // covers other clients; this caller also benefits from getting
      // the canonical numbers without a separate ack roundtrip.
      void refreshEvents();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'RSVP update failed', 'error');
      void refreshEvents();
    } finally {
      setBusyRsvp((prev) => {
        const n = new Set(prev);
        n.delete(event.id);
        return n;
      });
    }
  }

  async function handleDelete(event: ScheduledEvent) {
    if (!confirm(`Delete the event "${event.name}"? This cannot be undone.`)) return;
    try {
      await rest.deleteEvent(guild.id, event.id);
      toasts.push(`Deleted "${event.name}"`, 'success');
      // Broadcast handles the removal in state; explicit refresh is
      // a belt-and-suspenders move for own-client.
      void refreshEvents();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    }
  }

  async function handleCancel(event: ScheduledEvent) {
    if (!confirm(`Cancel the event "${event.name}"? RSVPs are preserved but no one will be able to RSVP further.`)) {
      return;
    }
    try {
      await rest.updateEvent(guild.id, event.id, { status: 'canceled' });
      toasts.push(`Canceled "${event.name}"`, 'success');
      void refreshEvents();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Cancel failed', 'error');
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 bg-bg-1/85 backdrop-blur-sm flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="events-title"
        onClick={(e) => {
          if (e.target === e.currentTarget && !showCreate && !editingEvent && !viewingAttendees) onClose();
        }}
      >
        <div className="zk-modal bg-bg-2 border border-line w-full max-w-2xl max-h-[88vh] flex flex-col shadow-2xl">
          {/* Header */}
          <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
            <span className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
              <Calendar size={16} className="text-accent" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="events-title" className="text-base font-semibold text-ink-1 truncate">
                Events in {guild.name}
              </h2>
              <p className="text-xs text-ink-3 mt-0.5">
                Upcoming events and what's happening now
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

          {/* Create button (admin-only) */}
          {canManageEvents && (
            <div className="px-5 py-3 border-b border-line shrink-0">
              <button
                onClick={() => setShowCreate(true)}
                className="w-full px-3 py-2 rounded-md bg-accent hover:bg-accent/85 text-bg-1 text-sm font-medium transition-colors"
              >
                + Create event
              </button>
            </div>
          )}

          {/* View mode toggle. Renders only when there are events
              to display — no point offering view choice on an empty
              list. Compact segmented control. */}
          {loaded && events && events.length > 0 && (
            <div className="px-5 py-2 border-b border-line shrink-0 flex items-center justify-end gap-1">
              <ViewModeButton
                label="List"
                active={viewMode === 'list'}
                onClick={() => changeViewMode('list')}
              />
              <ViewModeButton
                label="Agenda"
                active={viewMode === 'agenda'}
                onClick={() => changeViewMode('agenda')}
              />
            </div>
          )}

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {!loaded ? (
              <p className="text-sm text-ink-3">Loading events…</p>
            ) : error ? (
              <p className="text-sm text-red-300">{error}</p>
            ) : !events || events.length === 0 ? (
              <div className="rounded-md border border-line bg-bg-2/50 px-4 py-10 text-center">
                <Calendar size={36} className="mx-auto text-ink-3 mb-2" />
                <p className="text-sm text-ink-2 mb-1">No upcoming events</p>
                <p className="text-xs text-ink-3">
                  {canManageEvents
                    ? 'Click "Create event" above to schedule one.'
                    : 'Check back later — admins can schedule events.'}
                </p>
              </div>
            ) : viewMode === 'agenda' ? (
              // Grouped-by-day view. Each group has a day header and
              // a nested list of cards. Day headers stick visually
              // via a background tint; we don't use position: sticky
              // because the parent has overflow: auto and sticky
              // headers inside that pattern have inconsistent cross-
              // browser behavior — better to keep them inline and
              // distinctive.
              <div className="space-y-5">
                {groupEventsByDay(events).map((group) => (
                  <section key={group.dateKey}>
                    <h3 className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2 pb-1 border-b border-line">
                      {group.label}
                    </h3>
                    <ul className="space-y-3">
                      {group.items.map((event) => (
                        <EventCard
                          key={event.id}
                          event={event}
                          guildId={guild.id}
                          canManage={canManageEvents}
                          busy={busyRsvp.has(event.id)}
                          onRsvp={(s) => void handleRsvp(event, s)}
                          onEdit={() => setEditingEvent(event)}
                          onCancel={() => void handleCancel(event)}
                          onDelete={() => void handleDelete(event)}
                          onViewAttendees={() => setViewingAttendees(event)}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <ul className="space-y-3">
                {events.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    guildId={guild.id}
                    canManage={canManageEvents}
                    busy={busyRsvp.has(event.id)}
                    onRsvp={(s) => void handleRsvp(event, s)}
                    onEdit={() => setEditingEvent(event)}
                    onCancel={() => void handleCancel(event)}
                    onDelete={() => void handleDelete(event)}
                    onViewAttendees={() => setViewingAttendees(event)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Nested create modal */}
        {showCreate && (
          <CreateEventModal
            guild={guild}
            onClose={() => setShowCreate(false)}
            onCreated={() => {
              setShowCreate(false);
              void refreshEvents();
              toasts.push('Event created', 'success');
            }}
          />
        )}

        {/* Nested edit modal (admin-only) */}
        {editingEvent && (
          <CreateEventModal
            guild={guild}
            event={editingEvent}
            onClose={() => setEditingEvent(null)}
            onCreated={() => {
              setEditingEvent(null);
              void refreshEvents();
              toasts.push('Event updated', 'success');
            }}
          />
        )}

        {/* Nested attendees modal */}
        {viewingAttendees && (
          <EventAttendeesModal
            guildId={guild.id}
            event={viewingAttendees}
            onClose={() => setViewingAttendees(null)}
          />
        )}
      </div>
    </Portal>
  );
}

function EventCard({
  event,
  guildId,
  canManage,
  busy,
  onRsvp,
  onEdit,
  onCancel,
  onDelete,
  onViewAttendees,
}: {
  event: ScheduledEvent;
  guildId: string;
  canManage: boolean;
  busy: boolean;
  onRsvp: (status: 'going' | 'maybe' | 'declined' | null) => void;
  onEdit: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onViewAttendees: () => void;
}) {
  const { state } = useAppState();

  // Resolve voice-channel name for voice_channel events.
  const voiceChannelName = useMemo(() => {
    if (event.locationKind !== 'voice_channel' || !event.locationChannelId) return null;
    const channels = state.channelsByGuild[guildId];
    const ch = channels?.find((c) => c.id === event.locationChannelId);
    return ch?.name ?? null;
  }, [event.locationKind, event.locationChannelId, state.channelsByGuild, guildId]);

  const startDate = new Date(event.startAt);
  const endDate = event.endAt ? new Date(event.endAt) : null;
  const now = Date.now();
  const startMs = startDate.getTime();
  const diffMs = startMs - now;

  // Human-readable date/time. Browser locale-aware.
  const absoluteTime = startDate.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const relativeTime = formatRelativeStart(diffMs, event.status);

  const isTerminal = event.status === 'canceled' || event.status === 'completed';
  const isActive = event.status === 'active';

  return (
    <li
      className={`rounded-lg border bg-bg-2/60 overflow-hidden transition-colors ${
        event.status === 'canceled'
          ? 'border-line opacity-60'
          : event.status === 'active'
            ? 'border-emerald-700/40'
            : 'border-line hover:border-line/60'
      }`}
    >
      {/* Banner (when present) */}
      {event.imageUrl && (
        <div className="w-full h-32 bg-bg-3 overflow-hidden">
          <img
            src={event.imageUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              // Hide broken banner; nicer than a broken-image icon
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}

      <div className="p-4 space-y-3">
        {/* Status badge + title */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              {isActive && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-emerald-900/40 text-emerald-300 text-[0.65rem] uppercase tracking-wider font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live now
                </span>
              )}
              {event.status === 'canceled' && (
                <span className="px-2 py-0.5 rounded-sm bg-red-900/30 text-red-300 text-[0.65rem] uppercase tracking-wider font-semibold">
                  Canceled
                </span>
              )}
              {event.status === 'completed' && (
                <span className="px-2 py-0.5 rounded-sm bg-bg-3 text-ink-3 text-[0.65rem] uppercase tracking-wider font-semibold">
                  Completed
                </span>
              )}
            </div>
            <h3
              className={`text-lg font-semibold text-ink-1 ${event.status === 'canceled' ? 'line-through' : ''}`}
            >
              {event.name}
            </h3>
          </div>
          {canManage && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={onEdit}
                className="px-2 py-1 rounded text-xs text-ink-2 hover:bg-bg-3 transition-colors"
              >
                Edit
              </button>
              {event.status !== 'canceled' && event.status !== 'completed' && (
                <button
                  onClick={onCancel}
                  className="px-2 py-1 rounded text-xs text-amber-300 hover:bg-amber-950/40 transition-colors"
                >
                  Cancel
                </button>
              )}
              <button
                onClick={onDelete}
                className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-950/40 transition-colors"
                aria-label="Delete event"
                title="Delete event"
              >
                <Trash size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Date / location row */}
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2 text-ink-2">
            <Calendar size={14} className="shrink-0 text-ink-3" />
            <span className="truncate">
              {absoluteTime}
              {endDate && (
                <span className="text-ink-3"> — {endDate.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
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
                <span className="truncate">
                  {voiceChannelName ? `#${voiceChannelName}` : '#unknown-channel'}
                </span>
              </>
            ) : (
              <>
                <MapPin size={14} className="shrink-0 text-ink-3" />
                <span className="truncate">{event.locationText || 'Location TBD'}</span>
              </>
            )}
          </div>
        </div>

        {/* Description */}
        {event.description && (
          <p className="text-sm text-ink-2 leading-relaxed whitespace-pre-wrap">
            {event.description}
          </p>
        )}

        {/* RSVP buttons + counts. Hidden for terminal-state events
            (no point RSVPing to a canceled or completed event). */}
        {!isTerminal && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-1.5">
              <RsvpButton
                label="Going"
                count={event.rsvpCounts?.going ?? 0}
                active={event.myRsvp === 'going'}
                disabled={busy}
                onClick={() => onRsvp(event.myRsvp === 'going' ? null : 'going')}
                tone="emerald"
              />
              <RsvpButton
                label="Maybe"
                count={event.rsvpCounts?.maybe ?? 0}
                active={event.myRsvp === 'maybe'}
                disabled={busy}
                onClick={() => onRsvp(event.myRsvp === 'maybe' ? null : 'maybe')}
                tone="amber"
              />
              <RsvpButton
                label="Decline"
                count={event.rsvpCounts?.declined ?? 0}
                active={event.myRsvp === 'declined'}
                disabled={busy}
                onClick={() => onRsvp(event.myRsvp === 'declined' ? null : 'declined')}
                tone="neutral"
              />
            </div>
          </div>
        )}

        {/* Attendee link — shown whenever at least one person has
            RSVP'd. Visible on terminal-state events too (useful
            retrospective context: who was coming to the canceled
            party). */}
        {hasAnyRsvp(event) && (
          <button
            onClick={onViewAttendees}
            className="text-xs text-ink-3 hover:text-ink-1 underline-offset-2 hover:underline transition-colors text-left"
          >
            See attendees ({(event.rsvpCounts?.going ?? 0) + (event.rsvpCounts?.maybe ?? 0)})
          </button>
        )}

        {/* Creator credit */}
        {event.creator && (
          <p className="text-xs text-ink-3">
            Hosted by {event.creator.displayName ?? event.creator.username}
          </p>
        )}
      </div>
    </li>
  );
}

function RsvpButton({
  label,
  count,
  active,
  disabled,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  tone: 'emerald' | 'amber' | 'neutral';
}) {
  // Tone classes — active state uses a stronger color; inactive uses
  // neutral bg-3 with subtle hover tint matching the tone.
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
      <span>{label}</span>
      {count > 0 && <span className="ml-1.5 text-ink-3">({count})</span>}
    </button>
  );
}

/**
 * "Friday" / "in 2 hours" / "in 3 days" / null when irrelevant
 * (terminal-state events show their badge instead).
 */
function formatRelativeStart(diffMs: number, status: ScheduledEvent['status']): string | null {
  if (status === 'completed' || status === 'canceled') return null;
  if (status === 'active') return 'happening now';
  if (diffMs < 0) return 'starting now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `in ${minutes} min${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(diffMs / 86400000);
  if (days < 14) return `in ${days} day${days === 1 ? '' : 's'}`;
  // Beyond two weeks, the absolute date does the work.
  return null;
}

/** True if at least one attendee count is non-zero. Used to gate
 *  the "See attendees" link — no point opening an empty list. */
function hasAnyRsvp(event: ScheduledEvent): boolean {
  const c = event.rsvpCounts;
  if (!c) return false;
  return c.going > 0 || c.maybe > 0 || c.declined > 0;
}

/** Segmented-control button for the List/Agenda toggle. Active
 *  state uses accent-tinted background; inactive is plain hover. */
function ViewModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
        active
          ? 'bg-accent/15 text-accent'
          : 'text-ink-3 hover:text-ink-1 hover:bg-bg-3'
      }`}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
