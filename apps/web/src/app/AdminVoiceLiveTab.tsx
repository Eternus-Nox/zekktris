/**
 * AdminVoiceLiveTab — the instance operator's live voice monitor.
 * ---------------------------------------------------------------
 * "Who is in voice right now, on what, and is anything obviously broken."
 *
 * Reads GET /admin/voice-live, which fans out to LiveKit (rooms, then
 * participants per room) under a wall-clock budget and diffs that ground
 * truth against this instance's own voice state. The diff is the reason the
 * tab is worth having — raw LiveKit can't tell you either of these:
 *
 *   ghost  — this instance believes someone is in a call LiveKit has never
 *            heard of. A stale voice-state row; the phantom-participant
 *            class of bug, previously invisible without a psql session.
 *   orphan — someone is on the media server with no voice-state row here,
 *            so no app-side eviction path (kick / ban / AFK sweep) reaches
 *            them. They can't be removed by normal moderation.
 *
 * Read-only by design. Kicking someone from the SFU here without also
 * clearing the voice-state row and fanning the leave out over the gateway
 * would manufacture the exact ghost this tab exists to detect, so call
 * actions stay on the voice service where the whole sequence lives.
 *
 * Refresh model matches every sibling admin tab: fetch on mount plus a
 * manual Refresh button. Auto-refresh is opt-in, starts off on every mount
 * and is never persisted — each tick costs a fan-out against a paid SFU
 * API, so the interval is torn down on unmount and cleared outright (not
 * merely skipped) whenever the browser tab is hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type LiveVoiceGhost,
  type LiveVoiceParticipant,
  type LiveVoiceRoom,
  type LiveVoiceSnapshot,
  type LiveVoiceTrack,
  type LiveVoiceUser,
} from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { AvatarImage } from '../lib/AvatarImage';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AdminTabHeader, StatCard, fmtUptime } from './AdminUI';
import { AlertTriangle, ChevronDown, ChevronRight, Volume2 } from '../lib/icons';

/** Opt-in poll cadence. Below the ~30s at which a monitor stops feeling live,
 *  comfortably above the server's own 2s coalescing window so the cache is a
 *  floor for bursts rather than the normal path. */
const AUTO_REFRESH_MS = 10_000;

/** Rooms auto-expand only when there are few enough that everything fits. */
const AUTO_EXPAND_MAX_ROOMS = 3;

export function AdminVoiceLiveTab({ onOpenDiagnostic }: { onOpenDiagnostic: () => void }) {
  const { rest } = useAuth();
  /** The most recent payload, whatever its status. */
  const [live, setLive] = useState<LiveVoiceSnapshot | null>(null);
  /** The most recent payload that actually saw the SFU. Kept so a blip
   *  doesn't blank the screen an operator is mid-way through reading. */
  const [lastGood, setLastGood] = useState<LiveVoiceSnapshot | null>(null);
  /** The request itself failed (network, 403, gateway) — distinct from the
   *  endpoint answering 200 with `status: 'error'`. */
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false); // never seeded from storage
  /** Explicit per-room overrides, keyed by room name. A room with no entry
   *  follows `defaultOpen`, so the default can change as rooms come and go
   *  without stomping a choice the operator actually made. */
  const [openRooms, setOpenRooms] = useState<Record<string, boolean | undefined>>({});

  const mounted = useRef(true);
  /** Guards the poll loop: a slow backend must never stack requests. */
  const inFlight = useRef(false);

  // Declared before the fetch effects so it is already false-on-unmount by
  // the time any in-flight response lands.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await rest.adminVoiceLive();
      if (!mounted.current) return;
      setLive(r.live);
      if (r.live.status === 'ok') setLastGood(r.live);
      setFetchError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!mounted.current) return;
      setFetchError(e instanceof ApiError ? e.message : 'Could not reach the voice monitor.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [rest]);

  useEffect(() => {
    void load();
  }, [load]);

  // Opt-in polling. Four things have to hold, and each has its own line here:
  //  1. unmount tears the interval down (cleanup) — and switching admin tabs
  //     genuinely unmounts this component, it isn't just hidden;
  //  2. a hidden browser tab clears the interval entirely, so a monitor left
  //     open on a second screen issues zero requests while it's in the
  //     background, and gets one immediate refresh when it comes back;
  //  3. `inFlight` stops a slow response from stacking a queue behind it;
  //  4. toggling auto off changes the dependency and tears the effect down.
  useEffect(() => {
    if (!auto) return;
    let timer: number | undefined;
    const tick = () => {
      if (!document.hidden && !inFlight.current) void load();
    };
    const start = () => {
      if (timer === undefined) timer = window.setInterval(tick, AUTO_REFRESH_MS);
    };
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void load();
        start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [auto, load]);

  // Which snapshot the body renders. 'ok' renders itself; 'error' falls back
  // to the last good reading (dimmed, under a stale banner); 'unconfigured'
  // renders no rooms at all, because stale occupancy for a media server that
  // is no longer configured would be a lie.
  const shown: LiveVoiceSnapshot | null =
    live === null
      ? null
      : live.status === 'ok'
        ? live
        : live.status === 'error'
          ? lastGood
          : null;
  // Stale has TWO causes and both have to show, because the consequence is
  // identical: rows on screen that are older than they look.
  //   1. the endpoint answered 200 with status 'error', so `shown` fell back
  //      to `lastGood` and no longer equals `live`;
  //   2. the request itself never landed (403 after a role change, 502,
  //      network drop). `live` is then untouched, so `shown === live` and the
  //      first test alone reports "fresh" — the exact failure this fixes.
  // The deliberate choice is to KEEP the rows rather than blank them: an
  // operator mid-incident shouldn't lose the reading they were part-way
  // through. That is only defensible while the screen says so, which is what
  // the banner below plus the 50% dimming are for. Blanking instead would
  // mean changing both.
  const stale = shown !== null && (shown !== live || fetchError !== null);

  const rooms = shown?.rooms ?? [];
  const defaultOpen = rooms.length > 0 && rooms.length <= AUTO_EXPAND_MAX_ROOMS;
  const toggleRoom = (name: string) =>
    setOpenRooms((prev) => ({ ...prev, [name]: !(prev[name] ?? defaultOpen) }));

  // `totals.rooms` counts LiveKit rooms only; the list can be longer because
  // the server appends rooms this instance believes in that LiveKit has never
  // heard of — that's the most common ghost, and it needs somewhere to live.
  // Subtracting totals.rooms directly would go wrong once LiveKit rooms are
  // themselves truncated, so back out the rows that actually made it:
  // totals.rooms minus the ones the server says it couldn't list.
  const liveRoomRows = shown ? Math.max(0, shown.totals.rooms - shown.roomsTruncated) : 0;
  const appOnlyRooms = shown ? Math.max(0, shown.rooms.length - liveRoomRows) : 0;

  return (
    <div className="space-y-5 max-w-4xl">
      <AdminTabHeader
        icon={Volume2}
        title="Live Voice"
        subtitle="Who is connected to the media server right now. Ground truth from LiveKit, cross-checked against this instance's own voice state."
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-bg-2 text-ink-1 border border-line hover:border-accent transition-colors disabled:opacity-50"
        >
          {busy ? 'Reading…' : 'Refresh'}
        </button>
        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
            className="accent-accent"
          />
          <span>Auto-refresh (10s)</span>
        </label>
        {updatedAt !== null && (
          <span className="text-xs text-ink-3 tabular-nums">
            Updated {new Date(updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* The request never made it — separate from the endpoint reporting a
          media-server problem in a perfectly good 200. */}
      {fetchError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-red-400 shrink-0" />
            <span className="text-sm font-semibold text-red-300">Couldn't load the monitor</span>
          </div>
          <p className="text-xs text-red-300/90 leading-relaxed">{fetchError}</p>
        </div>
      )}

      {!live && !fetchError && <p className="text-sm text-ink-3">Reading live voice state…</p>}

      {/* Amber, not red: presence-only is a valid way to run an instance. */}
      {live?.status === 'unconfigured' && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-400 shrink-0" />
            <span className="text-sm font-semibold text-amber-200">Presence-only mode</span>
          </div>
          <p className="text-xs text-amber-200/80 leading-relaxed">
            Voice is running in presence-only mode — no media server is configured. Users can see who
            is in a channel, but there is no audio or video.
          </p>
          <button
            type="button"
            onClick={onOpenDiagnostic}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 transition-colors"
          >
            Open Overview → Test voice
          </button>
        </div>
      )}

      {live?.status === 'error' && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-red-400 shrink-0" />
            <span className="text-sm font-semibold text-red-300">Can't read the media server</span>
          </div>
          {live.error && (
            <p className="text-xs text-red-300/90 leading-relaxed whitespace-pre-line">{live.error}</p>
          )}
          {live.httpUrl && <p className="text-[11px] text-ink-3 font-mono truncate">{live.httpUrl}</p>}
          <button
            type="button"
            onClick={onOpenDiagnostic}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-bg-2 text-ink-1 border border-line hover:border-accent transition-colors"
          >
            Run full voice diagnostic
          </button>
        </div>
      )}

      {shown && (
        <>
          {stale && (
            <p className="text-xs text-amber-300 leading-relaxed">
              Stale — everything below is the last good reading, taken{' '}
              {new Date(shown.generatedAt).toLocaleTimeString()}. It is being kept on screen, not
              refreshed, so treat it as history rather than as who is in voice now.
            </p>
          )}
          <div className={stale ? 'space-y-5 opacity-50' : 'space-y-5'}>
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="Rooms"
                value={shown.totals.rooms.toLocaleString()}
                subtle={
                  appOnlyRooms > 0
                    ? `+${appOnlyRooms} app-only`
                    : 'live on the media server'
                }
              />
              <StatCard
                label="Participants"
                value={shown.totals.participants.toLocaleString()}
                subtle={`${shown.totals.publishers.toLocaleString()} publishing`}
              />
              <StatCard
                label="Mismatches"
                value={(shown.totals.ghosts + shown.totals.orphans).toLocaleString()}
                subtle={`${shown.totals.ghosts.toLocaleString()} ghost · ${shown.totals.orphans.toLocaleString()} orphan`}
              />
              <StatCard
                label="Snapshot"
                value={new Date(shown.generatedAt).toLocaleTimeString()}
                subtle="from LiveKit"
              />
            </section>

            {/* Two truncations, two sentences, never one number. A LiveKit
                room past the cap is live on the SFU and its people are in the
                counts above; an app-only room past the cap is not on the SFU
                at all and its people are ghosts. Summing them would produce a
                figure neither sentence can honestly describe. Rooms that ARE
                listed but whose roster wasn't read need no line here — they
                carry a "Skipped" chip on their own row. */}
            {shown.roomsTruncated > 0 && (
              <p className="text-xs text-ink-3 leading-relaxed">
                Not listed: {shown.roomsTruncated.toLocaleString()} more{' '}
                {shown.roomsTruncated === 1 ? 'room' : 'rooms'} live on the media server, past the
                server's row cap. The occupants are already in the counts above.
              </p>
            )}

            {shown.appOnlyRoomsTruncated > 0 && (
              <p className="text-xs text-ink-3 leading-relaxed">
                Not listed: {shown.appOnlyRoomsTruncated.toLocaleString()} more app-only{' '}
                {shown.appOnlyRoomsTruncated === 1 ? 'room' : 'rooms'} — this instance holds voice
                state for {shown.appOnlyRoomsTruncated === 1 ? 'it' : 'them'}, LiveKit has no such
                room. The occupants are already counted as ghosts above.
              </p>
            )}

            {shown.rooms.length > 0 ? (
              <ul className="space-y-2">
                {shown.rooms.map((room) => (
                  <RoomRow
                    key={room.name}
                    room={room}
                    open={openRooms[room.name] ?? defaultOpen}
                    onToggle={() => toggleRoom(room.name)}
                  />
                ))}
              </ul>
            ) : stale ? null : (
              /* The normal case, and it must not read as failure. Neutral
                 card, no warning colour — "nobody is talking" and "we can't
                 see the SFU" are different branches keyed off `status`, so
                 they can never be confused for one another. */
              <div className="rounded-md border border-line bg-bg-2/40 p-4 space-y-1">
                <p className="text-sm font-medium text-ink-1">No active voice sessions</p>
                <p className="text-xs text-ink-3 leading-relaxed">
                  Nobody is in a voice channel or on a call right now. This is the normal state, not
                  an error.
                </p>
                <p className="text-[11px] text-ink-3 tabular-nums">
                  Checked {new Date(shown.generatedAt).toLocaleTimeString()} · LiveKit reachable
                </p>
              </div>
            )}

            <p className="text-xs text-ink-3 leading-relaxed">
              Read from LiveKit in {shown.tookMs.toLocaleString()} ms
              {shown.httpUrl ? <> · <span className="font-mono">{shown.httpUrl}</span></> : null}.
              This view is read-only — removing someone from a call has to go through the voice
              service so this instance's own state stays in step.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Rooms ─────────────────────────────────────────────────────────────────

const SCOPE_PILL: Record<LiveVoiceRoom['scope'], { label: string; cls: string }> = {
  guild: { label: 'Server', cls: 'bg-accent/15 text-accent' },
  dm: { label: 'DM', cls: 'bg-bg-3 text-ink-2' },
  unknown: { label: 'Unknown', cls: 'bg-amber-500/20 text-amber-300' },
};

function RoomRow({
  room,
  open,
  onToggle,
}: {
  room: LiveVoiceRoom;
  open: boolean;
  onToggle: () => void;
}) {
  // Fallback on the lookups below: the DTO unions make an unknown value
  // impossible in TypeScript, but this panel is what an operator stares at
  // mid-incident and a `.cls` on undefined would white-screen the whole tab.
  const scope = SCOPE_PILL[room.scope] ?? { label: room.scope, cls: 'bg-bg-3 text-ink-2' };
  // Anything but 'ok' means participants are UNKNOWN for this room, not
  // empty — so no in-sync claim and no ghost/orphan reading can be made.
  const detailKnown = room.participantsState === 'ok';
  // What appCount is actually comparable to. LiveKit's participantCount is
  // every non-hidden connection on the SFU — agents, ingress and SIP legs
  // included — and none of those ever have a voice-state row, so the raw
  // number is not the thing to hold appCount against: a room with an agent in
  // it would read as permanently out of step. When we actually read the
  // roster, count only the connections that COULD have a row.
  const comparableCount = detailKnown
    ? room.participants.filter((p) => p.kind === 'standard').length
    : room.participantCount;
  const infraCount = detailKnown
    ? room.participants.filter((p) => p.kind !== 'standard').length
    : 0;
  // Worth PRINTING whenever the two numbers differ — but deliberately not
  // what turns the row amber. See below.
  const countsDiffer = room.appCount !== comparableCount;

  // What goes amber.
  //
  // Not the arithmetic, under either narrowing — the earlier "kind only, not
  // state" note was wrong to treat that as a one-sided choice. participantCount
  // comes from listRooms and participants[] from a listParticipants issued up
  // to the whole fan-out budget later, and a leave reaches the app and the SFU
  // a moment apart, so the skew is symmetric:
  //   • filter on kind alone → a participant still in the roster (state
  //     'disconnected') whose row is already deleted makes the numbers differ;
  //   • filter on kind AND state → a row that outlives its disconnected
  //     participant makes them differ.
  // Both are the ordinary leave sequence, both are transient, and — the actual
  // defect — neither leaves anything in the expanded roster to point at. The
  // header went amber and the rows all said OK.
  //
  // So flag exactly what the rows flag. The server already reconciled this per
  // person, with the transients excused on both sides (ghost = row with no
  // participant; orphan = live participant with no row), so reuse its verdict:
  // the header is amber if and only if opening the row shows something amber.
  const flagged = detailKnown
    ? room.ghosts.length > 0 || room.participants.some((p) => p.sync !== 'ok')
    : // The roster was never read, so there is nothing to reconcile and the
      // raw counts are all we have (comparableCount is participantCount on
      // this branch). The Skipped / read-failed chip sitting beside this
      // number is what explains it.
      countsDiffer;

  // Unchanged claim: "in sync" still means everything agrees, arithmetic
  // included. A transient skew is neither amber nor in sync — it just shows
  // both numbers, with the tooltip saying why they differ.
  const inSync = detailKnown && !flagged && !countsDiffer;

  // Tooltip on the count. The middle branch is the one that used to overclaim:
  // a gap between "LiveKit says N" and "the roster we read had M people" is
  // only infrastructure when the roster actually contains infrastructure.
  const countTitle =
    detailKnown && comparableCount < room.participantCount
      ? infraCount > 0
        ? `LiveKit reports ${room.participantCount} connected. The roster we read had ${comparableCount} ${comparableCount === 1 ? 'person' : 'people'} and ${infraCount} infrastructure connection${infraCount === 1 ? '' : 's'} (agent, ingress or SIP leg), which never have voice state. This instance's voice state has ${room.appCount}.`
        : `LiveKit reports ${room.participantCount} connected, but the roster read moments later had ${comparableCount} — the two reads are seconds apart, so someone most likely left in between. This instance's voice state has ${room.appCount}.`
      : `LiveKit reports ${room.participantCount}; this instance's voice state has ${room.appCount}.`;
  // A live room on a channel row that no longer exists is itself a finding.
  const missingChannel = room.scope === 'guild' && room.channelName === null;

  return (
    <li className="rounded-md border border-line bg-bg-2 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 text-left hover:bg-bg-3 transition-colors"
      >
        {open ? (
          <ChevronDown size={14} className="text-ink-3 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-ink-3 shrink-0" />
        )}
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[0.6rem] uppercase font-bold tracking-wider ${scope.cls}`}
        >
          {scope.label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink-1 truncate">{roomWhere(room)}</span>
          <span className="block text-[11px] text-ink-3 font-mono truncate">{room.name}</span>
        </span>
        <span className="flex flex-wrap items-center gap-2 shrink-0 text-xs tabular-nums">
          <span
            className={flagged ? 'text-amber-300 font-medium' : 'text-ink-2'}
            title={countTitle}
          >
            {room.participantCount.toLocaleString()}
            {countsDiffer && <span> · app says {room.appCount.toLocaleString()}</span>}
          </span>
          <span className="text-ink-3" title="Participants publishing at least one track">
            {room.publisherCount.toLocaleString()} publishing
          </span>
          <span
            className="text-ink-3"
            title={
              room.createdAt
                ? `Room created ${new Date(room.createdAt).toLocaleString()}`
                : 'The media server did not report a creation time'
            }
          >
            {elapsedSince(room.createdAt)}
          </span>
          {room.recording && (
            <span
              className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 text-[10px] font-semibold"
              title="LiveKit reports an active recording on this room"
            >
              ● REC
            </span>
          )}
          {missingChannel && (
            <span
              className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold"
              title="A live room on a channel this instance can no longer resolve"
            >
              channel missing
            </span>
          )}
          {room.participantsState === 'error' && (
            <span
              className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold"
              title={room.participantsError ?? "Couldn't read the participants for this room."}
            >
              ⚠ read failed
            </span>
          )}
          {(room.participantsState === 'deadline' || room.participantsState === 'skipped') && (
            <span
              className="px-1.5 py-0.5 rounded bg-bg-3 text-ink-3 text-[10px] font-semibold"
              title={skippedReason(room.participantsState)}
            >
              Skipped
            </span>
          )}
          {inSync && (
            <span
              className="px-1.5 py-0.5 rounded bg-bg-3 text-ink-3 text-[10px] font-semibold"
              title="LiveKit and this instance agree on who is in this room"
            >
              in sync
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-line px-3 py-3">
          {!detailKnown ? (
            <p className="text-xs text-ink-3 leading-relaxed">
              {room.participantsState === 'error'
                ? (room.participantsError ?? "Couldn't read the participants for this room.")
                : skippedReason(room.participantsState)}
            </p>
          ) : room.participants.length === 0 && room.ghosts.length === 0 ? (
            <p className="text-xs text-ink-3">No participants reported.</p>
          ) : (
            <ul className="rounded-md border border-line divide-y divide-line overflow-hidden">
              {room.participants.map((p) => (
                <ParticipantRow key={`p:${p.identity}`} participant={p} />
              ))}
              {room.ghosts.map((g) => (
                <GhostRow key={`g:${g.identity}`} ghost={g} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** Human "where is this room" line. Guild rooms resolve to
 *  `Server › # channel`; DM rooms deliberately show nothing beyond the fact
 *  that a direct call exists (the raw room name carries the channel id). */
function roomWhere(room: LiveVoiceRoom): string {
  if (room.scope === 'dm') return 'Direct call';
  if (room.scope !== 'guild') return 'Unrecognised room';
  const guild =
    room.guildName ?? (room.guildId !== null ? `Server ${room.guildId}` : 'Unknown server');
  const channel =
    room.channelName !== null
      ? `# ${room.channelName}`
      : room.channelId !== null
        ? `channel ${room.channelId}`
        : 'unknown channel';
  return `${guild} › ${channel}`;
}

/** 'deadline' and 'skipped' are budget outcomes, not faults — the copy has to
 *  read as "we didn't look", never as "something is broken". */
function skippedReason(state: LiveVoiceRoom['participantsState']): string {
  return state === 'deadline'
    ? 'Skipped — the snapshot ran out of time before reading this room. Refresh to try again.'
    : "Skipped — this room is past the server's fan-out cap, so its participant detail wasn't read.";
}

// ── Participants ──────────────────────────────────────────────────────────

const STATE_PILL: Record<LiveVoiceParticipant['state'], { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-green-500/20 text-green-300' },
  joined: { label: 'Joined', cls: 'bg-bg-3 text-ink-2' },
  joining: { label: 'Joining', cls: 'bg-amber-500/20 text-amber-300' },
  disconnected: { label: 'Disconnected', cls: 'bg-red-500/20 text-red-300' },
};

/** Only rendered when it isn't 'standard' — a row with no kind chip is a
 *  person, anything chipped is infrastructure. */
const KIND_LABEL: Record<LiveVoiceParticipant['kind'], string> = {
  standard: 'Standard',
  ingress: 'Ingress',
  egress: 'Egress',
  sip: 'SIP',
  agent: 'Agent',
  other: 'Other',
};

function ParticipantRow({ participant }: { participant: LiveVoiceParticipant }) {
  const state = STATE_PILL[participant.state] ?? {
    label: participant.state,
    cls: 'bg-bg-3 text-ink-2',
  };
  const chips = mediaChips(participant.tracks);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2 bg-bg-2">
      <Identity user={participant.user} identity={participant.identity} />
      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${state.cls}`}>
        {state.label}
      </span>
      {participant.kind !== 'standard' && (
        <span
          className="shrink-0 px-1.5 py-0.5 rounded bg-accent/15 text-accent text-[10px] font-semibold"
          title="Not a person — infrastructure connected to this room"
        >
          {KIND_LABEL[participant.kind]}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1 min-w-0">
        {chips.length === 0 ? (
          <span className="text-[11px] text-ink-3">no tracks</span>
        ) : (
          chips.map((chip) => (
            <span
              key={chip.label}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                chip.dim ? 'bg-bg-3 text-ink-3' : 'bg-accent/15 text-accent'
              }`}
              title={chip.title}
            >
              {chip.label}
            </span>
          ))
        )}
      </span>
      <span
        className="ml-auto shrink-0 text-[11px] text-ink-3 tabular-nums"
        title={
          participant.connectedAt
            ? `Connected ${new Date(participant.connectedAt).toLocaleString()}`
            : 'The media server did not report a join time'
        }
      >
        {elapsedSince(participant.connectedAt)}
      </span>
      <SyncChip sync={participant.sync} />
    </li>
  );
}

/** A voice-state row with no matching LiveKit participant. Rendered in the
 *  participant list so the operator sees one roster, with no media chips —
 *  there is no media, that's the point. */
function GhostRow({ ghost }: { ghost: LiveVoiceGhost }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2 bg-bg-2">
      <Identity user={ghost.user} identity={ghost.identity} />
      <span className="shrink-0 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold">
        Not on LiveKit
      </span>
      <span className="flex flex-wrap items-center gap-1 min-w-0">
        {ghost.selfMute && (
          <span className="px-1.5 py-0.5 rounded bg-bg-3 text-ink-3 text-[10px] font-medium">
            self-muted
          </span>
        )}
        {ghost.selfDeaf && (
          <span className="px-1.5 py-0.5 rounded bg-bg-3 text-ink-3 text-[10px] font-medium">
            self-deafened
          </span>
        )}
      </span>
      <span
        className="ml-auto shrink-0 text-[11px] text-ink-3 tabular-nums"
        title={`This instance recorded them joining ${new Date(ghost.appJoinedAt).toLocaleString()}`}
      >
        {elapsedSince(ghost.appJoinedAt)}
      </span>
      <SyncChip sync="ghost" />
    </li>
  );
}

function SyncChip({ sync }: { sync: 'ok' | 'ghost' | 'orphan' }) {
  if (sync === 'ghost') {
    return (
      <span
        className="shrink-0 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold"
        title="This instance thinks they're in the call, but LiveKit has never heard of them — a stale voice state."
      >
        Ghost
      </span>
    );
  }
  if (sync === 'orphan') {
    return (
      <span
        className="shrink-0 px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 text-[10px] font-semibold"
        title="Connected to the media server with no voice state here, so kick, ban and the AFK sweep can't reach them."
      >
        Orphan
      </span>
    );
  }
  return (
    <span
      className="shrink-0 px-1.5 py-0.5 rounded bg-bg-3 text-ink-3 text-[10px] font-semibold"
      title="LiveKit and this instance agree about this participant"
    >
      OK
    </span>
  );
}

/** Avatar + name, or `Unknown` + the raw identity in monospace. An
 *  unresolved identity is a signal (agent, egress worker, SIP leg, stale id),
 *  not an error — dropping the row would hide the most suspicious thing this
 *  endpoint can surface. React escapes the identity on render. */
function Identity({ user, identity }: { user: LiveVoiceUser | null; identity: string }) {
  if (!user) {
    return (
      <span className="flex items-center gap-2 min-w-0 flex-1">
        <span className="w-7 h-7 rounded-full bg-bg-3 text-ink-3 grid place-items-center text-[10px] font-bold shrink-0">
          ?
        </span>
        <span className="min-w-0">
          <span className="block text-sm text-ink-2">Unknown</span>
          <span
            className="block text-[11px] text-ink-3 font-mono truncate"
            title="LiveKit identity — not a user on this instance"
          >
            {identity}
          </span>
        </span>
      </span>
    );
  }
  const tone = avatarColor(user.id);
  return (
    <span className="flex items-center gap-2 min-w-0 flex-1">
      <span
        className={`relative w-7 h-7 rounded-full overflow-hidden shrink-0 ${tone} text-[10px] font-bold flex items-center justify-center`}
      >
        <span className="zk-avatar-initials">
          {avatarInitials(user.displayName ?? user.username)}
        </span>
        <AvatarImage src={user.avatarUrl} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-ink-1 truncate">
          {user.displayName ?? user.username}
          {user.deleted && (
            <span className="ml-1.5 align-middle px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 text-[10px] font-semibold">
              deleted account
            </span>
          )}
        </span>
        <span className="block text-[11px] text-ink-3 truncate">@{user.username}</span>
      </span>
    </span>
  );
}

// ── Formatting ────────────────────────────────────────────────────────────

type MediaChip = { label: string; dim: boolean; title: string };

/** Media chips are derived from track SOURCE, never from array position —
 *  a publisher can hold any subset in any order. A muted track is still
 *  published, so it renders dim rather than disappearing. */
function mediaChips(tracks: LiveVoiceTrack[]): MediaChip[] {
  const chips: MediaChip[] = [];
  const mic = tracks.find((t) => t.source === 'microphone');
  if (mic) {
    chips.push({
      label: mic.muted ? 'Mic muted' : 'Mic',
      dim: mic.muted,
      title: mic.muted ? 'Microphone published but muted' : 'Microphone live',
    });
  }
  const cam = tracks.find((t) => t.source === 'camera');
  if (cam) {
    chips.push({
      label: cam.muted ? 'Cam off' : 'Cam',
      dim: cam.muted,
      title: dimensions(cam) ?? 'Camera',
    });
  }
  const screen = tracks.find((t) => t.source === 'screen');
  if (screen) {
    chips.push({
      label: 'Screen',
      dim: screen.muted,
      title: dimensions(screen) ?? 'Screen share',
    });
  }
  if (tracks.some((t) => t.source === 'screen_audio')) {
    chips.push({ label: 'Screen audio', dim: false, title: 'Audio from a screen share' });
  }
  if (tracks.some((t) => t.encrypted)) {
    chips.push({
      label: 'E2EE',
      dim: false,
      title: 'At least one track is end-to-end encrypted',
    });
  }
  return chips;
}

function dimensions(track: LiveVoiceTrack): string | null {
  return track.width !== null && track.height !== null
    ? `${track.width}×${track.height} declared by the publisher`
    : null;
}

/** Elapsed time from an ISO timestamp, in the same shape the Overview tab
 *  uses for uptime. Null and unparseable both render as an em dash rather
 *  than as "56 years", which is what a bad epoch conversion looks like. */
function elapsedSince(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  return fmtUptime(Math.max(0, Math.floor((Date.now() - then) / 1000)));
}
