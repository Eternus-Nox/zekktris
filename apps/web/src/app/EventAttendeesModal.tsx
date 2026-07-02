/**
 * EventAttendeesModal
 * -------------------
 * Secondary modal showing who's RSVP'd to an event. Triggered by
 * clicking the RSVP count row on an EventCard.
 *
 * Tab structure: Going / Maybe / Declined. The cached `rsvpCounts`
 * on the parent event drive the tab labels; the per-tab attendee
 * list is fetched lazily on tab activation. Cached per status so
 * tab-switching doesn't refetch.
 *
 * Avatar + display name per row. Clicking a row is reserved for
 * future "open profile" wiring — for v1 the rows are inert.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { ApiError, type EventRsvp, type ScheduledEvent } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { Portal } from '../lib/Portal';
import { X, Users } from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';

type Tab = 'going' | 'maybe' | 'declined';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'going', label: 'Going' },
  { key: 'maybe', label: 'Maybe' },
  { key: 'declined', label: 'Declined' },
];

export function EventAttendeesModal({
  guildId,
  event,
  onClose,
}: {
  guildId: string;
  event: ScheduledEvent;
  onClose: () => void;
}) {
  const { rest } = useAuth();
  const [tab, setTab] = useState<Tab>('going');
  // Per-tab cache. Keys map directly to status. null = not loaded
  // yet for that tab.
  const [cache, setCache] = useState<Record<Tab, EventRsvp[] | null>>({
    going: null,
    maybe: null,
    declined: null,
  });
  const [error, setError] = useState<string | null>(null);

  const loadTab = useCallback(
    async (which: Tab) => {
      setError(null);
      try {
        const r = await rest.listEventAttendees(guildId, event.id, { status: which });
        setCache((prev) => ({ ...prev, [which]: r.attendees }));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not load attendees');
        setCache((prev) => ({ ...prev, [which]: [] }));
      }
    },
    [rest, guildId, event.id],
  );

  // Load the current tab if its cache slot is null. Re-runs on
  // tab change.
  useEffect(() => {
    if (cache[tab] === null) {
      void loadTab(tab);
    }
  }, [tab, cache, loadTab]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Body scroll lock.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const currentList = cache[tab];
  const counts = event.rsvpCounts ?? { going: 0, maybe: 0, declined: 0 };

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[60] bg-bg-1/85 backdrop-blur-sm flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="attendees-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="zk-modal bg-bg-2 border border-line w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl">
          {/* Header */}
          <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
            <span className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
              <Users size={16} className="text-accent" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="attendees-title" className="text-base font-semibold text-ink-1 truncate">
                Attendees
              </h2>
              <p className="text-xs text-ink-3 mt-0.5 truncate">{event.name}</p>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 w-7 h-7 rounded-md hover:bg-bg-3 text-ink-2 flex items-center justify-center transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Tabs */}
          <div className="px-5 pt-3 border-b border-line shrink-0 flex gap-1">
            {TABS.map((t) => {
              const count = counts[t.key];
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                    active
                      ? 'border-accent text-ink-1'
                      : 'border-transparent text-ink-3 hover:text-ink-2'
                  }`}
                >
                  {t.label} <span className="text-ink-3">({count})</span>
                </button>
              );
            })}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {currentList === null ? (
              <p className="text-sm text-ink-3 px-3 py-2">Loading…</p>
            ) : error ? (
              <p className="text-sm text-red-300 px-3 py-2">{error}</p>
            ) : currentList.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <p className="text-sm text-ink-3">
                  {tab === 'going'
                    ? 'No one has RSVP\u2019d "Going" yet.'
                    : tab === 'maybe'
                      ? 'No one has RSVP\u2019d "Maybe" yet.'
                      : 'No one has declined yet.'}
                </p>
              </div>
            ) : (
              <ul>
                {currentList.map((a) => (
                  <AttendeeRow key={a.user.id} rsvp={a} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

function AttendeeRow({ rsvp }: { rsvp: EventRsvp }) {
  const u = rsvp.user;
  const displayName = u.displayName ?? u.username;
  // Memoize the swatch color so we're not recomputing on every
  // re-render of the parent. Stable across renders for the same user.
  const swatch = useMemo(() => avatarColor(u.id), [u.id]);
  return (
    <li className="flex items-center gap-3 px-3 py-1.5 rounded-md hover:bg-bg-3/50 transition-colors">
      {u.avatarUrl ? (
        <img
          src={u.avatarUrl}
          alt=""
          className="w-7 h-7 rounded-full shrink-0 object-cover"
          loading="lazy"
        />
      ) : (
        <span
          className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-semibold text-bg-1"
          style={{ backgroundColor: swatch }}
        >
          <span className="zk-avatar-initials">{avatarInitials(displayName)}</span>
        </span>
      )}
      <span className="text-sm text-ink-1 truncate flex-1">{displayName}</span>
    </li>
  );
}
