/**
 * Live voice monitor
 * ------------------
 * "Who is in voice right now, on what, and is anything obviously broken."
 *
 * livekitDiagnostic.ts answers "is voice CONFIGURED correctly" — a static
 * config check you run once when calls don't connect. This answers the other
 * half, the one that was missing every time a call misbehaved in production:
 * what is actually happening on the SFU this second, and does it agree with
 * what this instance believes.
 *
 * Two sources, deliberately:
 *   1. LiveKit  (listRooms + listParticipants) — ground truth for media.
 *   2. voice_states — OUR belief about who is in a call. Everything the app
 *      does to a voice user (kick, ban, AFK sweep, DM call bookkeeping) drives
 *      off these rows.
 *
 * Diffing the two is the point of this service. The two states drifting apart
 * IS the bug class we've already had to fix twice in voice.ts (phantom
 * participants, zombie calls), and until now it was invisible without a psql
 * session:
 *   - GHOST  — a voice_states row with no LiveKit participant. The app thinks
 *              someone is in a call they've actually left.
 *   - ORPHAN — a LiveKit participant with no voice_states row. Connected to
 *              the SFU but outside every app-side eviction path, so normal
 *              moderation cannot remove them.
 *
 * Cost discipline: this is fan-out over the network from a request handler, so
 * every dimension is bounded by a server constant (no query knobs — a
 * `?rooms=100000` would be a free DoS surface) and the whole thing runs under
 * a hard wall-clock budget. Partial results are the default; only a failing
 * listRooms() blanks the snapshot.
 *
 * Secret discipline: the api key/secret exist only as locals handed to the
 * RoomServiceClient constructor and never land on anything returned from here;
 * every URL that crosses the boundary goes through redactUrl(); Room.turnPassword
 * (a live TURN credential) is never read; ParticipantInfo.region is deliberately
 * not collected — coarse geolocation of a real user, no diagnostic value.
 *
 * Read-only by design. No kick/mute/delete-room here even though
 * svc.removeParticipant is already wired in voice.ts: removing a participant
 * without also deleting the voice_states row and fanning out leftVoiceStateDTO
 * would MANUFACTURE the exact ghost this monitor exists to detect. Actions
 * belong on evictFromVoiceInGuild/leaveVoice, with their own audit events.
 */

import { eq, inArray } from 'drizzle-orm';
import {
  ParticipantInfo_State,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';
import type { ParticipantInfo, Room, TrackInfo } from 'livekit-server-sdk';
import { db, schema } from '../db';
import { env } from '../env';
import { classifyError, redactUrl, resolveHttpUrl, withTimeout } from './livekitDiagnostic';
import { roomNameForRow } from './voice';

// ── Budget constants ────────────────────────────────────────────────────────
//
// Sized so the worst case is a bounded wall clock regardless of how busy the
// instance is: 3.5s listRooms + a 3.5s fan-out window + one in-flight 3s call
// ≈ 10s ceiling for the LiveKit half, independent of room count. BUILD_HARD_MS
// then bounds the WHOLE build, database reads included, so no single await can
// stall the endpoint indefinitely.

/** Rooms we fetch participant detail for, highest occupancy first. Rooms past
 *  the cap can still appear as rows (listRooms already gave us their counts
 *  for free) — only their participant list is skipped. */
const ROOM_CAP = 40;
/** Hard bound on how many LiveKit rooms get a ROW in the response, counting
 *  the fan-out targets. This is what makes ROOM_CAP real end to end: rooms[],
 *  the JSON body and the channel-name IN list are all derived from the rows,
 *  so without this they'd scale with however many rooms exist on the SFU
 *  rather than with a server constant — a multi-MB admin response and a
 *  multi-thousand-element IN, on a 10s poll. Rooms past it are reported as a
 *  count in `roomsTruncated`; headline totals still come from the full
 *  listRooms array, so truncation costs detail, never accuracy. */
const ROW_CAP = 120;
/** Same bound for app-only rooms (voice_states rows for a room LiveKit has
 *  never heard of). Their occupants are counted as ghosts either way — only
 *  the per-room row is capped. */
const APP_ONLY_ROW_CAP = 40;
/** Simultaneous listParticipants calls. Enough to keep the fan-out short
 *  without turning an admin page-load into a burst against LiveKit Cloud. */
const FANOUT_CONCURRENCY = 6;
/** RoomServiceClient ClientOptions.requestTimeout — SECONDS, per the SDK's
 *  own type. See the constructor below; this is the easiest value in the file
 *  to get wrong. */
const PER_CALL_TIMEOUT_S = 3;
/** Outer guard on the single listRooms call, in MILLISECONDS. */
const LIST_ROOMS_MS = 3500;
/** Hard deadline for the LiveKit fan-out, in MILLISECONDS. Workers refuse to
 *  start a call that couldn't finish inside it. */
const OVERALL_BUDGET_MS = 7000;
/** Room left for the two Postgres reads that follow the fan-out (voice_states,
 *  then the users/channels pair). They have NO bound of their own: db.ts sets
 *  neither a statement_timeout nor a pool query timeout, so nothing below this
 *  file will ever give up on them. */
const DB_SLACK_MS = 5000;
/** Hard ceiling on ONE WHOLE build, in MILLISECONDS — every await in
 *  buildSnapshot, not just the LiveKit half.
 *
 *  OVERALL_BUDGET_MS covers only the SFU calls, and generously: a worker may
 *  start a call at deadline − PER_CALL_TIMEOUT_S and that call still gets its
 *  full timeout, so the LiveKit phase can run to OVERALL_BUDGET_MS +
 *  PER_CALL_TIMEOUT_S. Add the database slack and the total wall clock is a
 *  constant.
 *
 *  This exists because getLiveVoice shares one in-flight build with every
 *  caller: without a bound on the build, a connection that WEDGES rather than
 *  errors leaves `inFlight` set forever and every later request in the process
 *  is handed the same promise that will never settle. Bounding the build is
 *  what lets the sharing be unconditional. */
const BUILD_HARD_MS = OVERALL_BUDGET_MS + PER_CALL_TIMEOUT_S * 1000 + DB_SLACK_MS;
/** Cool-down after a build COMPLETES, during which the finished snapshot is
 *  reused. This is only the second half of the coalescing story — an
 *  in-flight build is shared for as long as it runs, however long that is
 *  (see getLiveVoice). It has to be, because this window is far shorter than
 *  OVERALL_BUDGET_MS: a TTL measured from the start would expire mid-build and
 *  let the next caller launch a second fan-out, in exactly the degraded case
 *  where several admins are watching and the SFU is slow. */
const CACHE_TTL_MS = 2000;
/** Belt-and-braces bound on the user-resolution IN list. ROOM_CAP × room size
 *  already bounds it; this stops a pathological room from building a
 *  thousand-element query. Ids past the cap simply render as `Unknown` plus
 *  the raw identity — degraded, never wrong. */
const USER_LOOKUP_CAP = 500;

// ── LiveKit protocol enums ──────────────────────────────────────────────────
//
// livekit-server-sdk re-exports ParticipantInfo_State, TrackType and
// TrackSource from @livekit/protocol as real runtime values, so those are
// imported above — the same way voice.ts already imports TrackSource.
// ParticipantInfo_Kind and Encryption_Type are NOT re-exported, and
// @livekit/protocol is not a direct dependency of apps/api (it arrives only
// under livekit-server-sdk), so those two stay pinned here as local numbers.
//
// Every read below is an explicit `===`: ParticipantInfo_State.JOINING,
// TrackType.AUDIO, TrackSource.UNKNOWN and Encryption_Type.NONE are all 0, so
// a truthiness check on any of them is a bug.
const P_KIND_STANDARD = 0;
const P_KIND_INGRESS = 1;
const P_KIND_EGRESS = 2;
const P_KIND_SIP = 3;
const P_KIND_AGENT = 4;

/** Encryption.Type.NONE. Anything else means the client negotiated E2EE. */
const ENCRYPTION_NONE = 0;

// ── Room-name grammar, parse side ───────────────────────────────────────────
// The generate side lives in voice.ts (roomNameForRow / mintLivekitToken) and
// is imported, not copied. These two regexes are the inverse, which voice.ts
// has no need for — a room name coming BACK off the SFU has to be turned into
// ids again, and may not be one of ours at all.
const GUILD_ROOM_RE = /^g([0-9]{1,20})-c([0-9]{1,20})$/;
const DM_ROOM_RE = /^dm-c([0-9]{1,20})$/;
/** int8 upper bound — a room name or identity numeric enough to pass the regex
 *  but too large for a bigint column would make the lookup query throw. */
const MAX_SNOWFLAKE = 9223372036854775807n;

// ── DTO ─────────────────────────────────────────────────────────────────────
// Mirrored verbatim in packages/client/src/rest.ts. Keep the two in step.

export interface LiveVoiceUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  deleted: boolean;
}

export interface LiveVoiceTrack {
  source: 'microphone' | 'camera' | 'screen' | 'screen_audio' | 'unknown';
  kind: 'audio' | 'video' | 'data';
  muted: boolean;
  /** encryption !== NONE — the client negotiated end-to-end encrypted media. */
  encrypted: boolean;
  /** Video only, and only when the publisher declared it. */
  width: number | null;
  height: number | null;
}

export interface LiveVoiceParticipant {
  /** Raw LiveKit identity, always present. */
  identity: string;
  /** Resolved Zekktris user, or null when the identity isn't one of ours
   *  (agent, egress worker, SIP leg, stale identity) — itself a finding. */
  user: LiveVoiceUser | null;
  state: 'joining' | 'joined' | 'active' | 'disconnected';
  kind: 'standard' | 'ingress' | 'egress' | 'sip' | 'agent' | 'other';
  publishing: boolean;
  connectedAt: string | null;
  tracks: LiveVoiceTrack[];
  /** 'orphan' = on the SFU with no voice_states row backing them. */
  sync: 'ok' | 'orphan';
}

/** A voice_states row with no matching LiveKit participant. */
export interface LiveVoiceGhost {
  user: LiveVoiceUser | null;
  identity: string;
  appJoinedAt: string;
  selfMute: boolean;
  selfDeaf: boolean;
}

export interface LiveVoiceRoom {
  /** g{guildId}-c{channelId} | dm-c{channelId} */
  name: string;
  scope: 'guild' | 'dm' | 'unknown';
  channelId: string | null;
  guildId: string | null;
  /** Null for DM channels (they have no name) and for a channel row that no
   *  longer exists — a live room on a deleted channel is itself a finding. */
  channelName: string | null;
  guildName: string | null;
  createdAt: string | null;
  /** LiveKit's own count — authoritative. 0 on an app-only room. */
  participantCount: number;
  publisherCount: number;
  /** voice_states rows keyed to this room. Diverging from participantCount is
   *  the headline signal. */
  appCount: number;
  recording: boolean;
  participantsState: 'ok' | 'error' | 'deadline' | 'skipped';
  participantsError: string | null;
  participants: LiveVoiceParticipant[];
  ghosts: LiveVoiceGhost[];
}

export interface LiveVoiceSnapshot {
  status: 'ok' | 'unconfigured' | 'error';
  /** Classified + redacted. Set only when status === 'error'. */
  error: string | null;
  /** Redacted SFU control URL — no userinfo, no query. */
  httpUrl: string | null;
  rooms: LiveVoiceRoom[];
  /** LiveKit rooms past ROW_CAP that got no row at all. Distinct from a room
   *  that IS listed with participantsState 'skipped' — that one is on screen,
   *  just without its roster. Occupancy is still in `totals`. */
  roomsTruncated: number;
  /** App-only rooms past APP_ONLY_ROW_CAP that got no row. Not active on the
   *  SFU by definition, so they are NOT in `totals.rooms` — but every occupant
   *  is a ghost with certainty and IS in `totals.ghosts`. Kept separate from
   *  roomsTruncated because summing the two produces a number no honest
   *  sentence can describe. */
  appOnlyRoomsTruncated: number;
  totals: {
    /** LiveKit rooms only. `rooms[]` can be longer: app-only rooms (every
     *  occupant a ghost) are appended so the most common ghost case — the
     *  last person's row outliving the room — is actually visible. */
    rooms: number;
    participants: number;
    publishers: number;
    ghosts: number;
    orphans: number;
  };
  tookMs: number;
  generatedAt: string;
}

// ── Timestamp handling ──────────────────────────────────────────────────────

/** The largest epoch-ms a JS Date can represent; past it toISOString throws
 *  RangeError rather than returning anything. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/**
 * LiveKit ships BOTH a seconds and a millis variant of each timestamp, and
 * proto3 hands back 0n (not undefined) when a field is unpopulated — and which
 * variant the Cloud SFU actually fills is not something we can verify from
 * here. Prefer millis, fall back to seconds × 1000, else null.
 *
 * Doing Number(seconds) without the ×1000 is the Jan-1970 / "connected for 57
 * years" bug — the same class as the 113h call-duration defect we already
 * fixed. Room.version / TrackInfo.version (microsecond TimedVersions) and
 * ParticipantInfo.version (a revision counter, not a time) are not serialized
 * at all, for the same reason: they look like timestamps and aren't.
 *
 * Out-of-range is null, not a throw. Date#toISOString raises RangeError past
 * ±8.64e15 ms, and Number() on a huge bigint gives Infinity — so a single
 * malformed creationTimeMs, or a future SFU that starts filling `creationTime`
 * in millis (making the ×1000 overflow), would otherwise 500 the whole
 * endpoint. The route's contract is always-200 with problems reported IN the
 * payload; one bad value must cost one timestamp, not the panel.
 */
function epochIso(ms: bigint, sec: bigint): string | null {
  const at = ms > 0n ? Number(ms) : sec > 0n ? Number(sec) * 1000 : null;
  if (at === null) return null;
  if (!Number.isFinite(at) || at > MAX_EPOCH_MS) return null;
  return new Date(at).toISOString();
}

/** Parse a decimal id that came off the wire. Returns null rather than
 *  throwing: BigInt() on a non-numeric string throws SyntaxError, and an
 *  out-of-range value would blow up the lookup query — either would 500 the
 *  whole endpoint over one weird participant identity. */
function parseSnowflake(s: string): bigint | null {
  if (!/^[0-9]{1,20}$/.test(s)) return null;
  const v = BigInt(s);
  return v > MAX_SNOWFLAKE ? null : v;
}

// ── Mapping helpers (explicit === against the enum values) ──────────────────
//
// The parameters stay `number` rather than the enum types on purpose: a newer
// SFU can send a value the installed protocol package has no member for, and
// each of these has a deliberate fallback for exactly that.

function mapState(state: number): LiveVoiceParticipant['state'] {
  if (state === ParticipantInfo_State.ACTIVE) return 'active';
  if (state === ParticipantInfo_State.JOINED) return 'joined';
  if (state === ParticipantInfo_State.JOINING) return 'joining';
  if (state === ParticipantInfo_State.DISCONNECTED) return 'disconnected';
  return 'joining';
}

function mapKind(kind: number): LiveVoiceParticipant['kind'] {
  if (kind === P_KIND_STANDARD) return 'standard';
  if (kind === P_KIND_INGRESS) return 'ingress';
  if (kind === P_KIND_EGRESS) return 'egress';
  if (kind === P_KIND_SIP) return 'sip';
  if (kind === P_KIND_AGENT) return 'agent';
  // CONNECTOR/BRIDGE and anything the protocol adds later.
  return 'other';
}

function mapTrack(t: TrackInfo): LiveVoiceTrack {
  let source: LiveVoiceTrack['source'] = 'unknown';
  if (t.source === TrackSource.MICROPHONE) source = 'microphone';
  else if (t.source === TrackSource.CAMERA) source = 'camera';
  else if (t.source === TrackSource.SCREEN_SHARE) source = 'screen';
  else if (t.source === TrackSource.SCREEN_SHARE_AUDIO) source = 'screen_audio';

  // TrackType.AUDIO is 0, so this must be an explicit ===, never a truthiness
  // test. DATA (2) and anything the protocol adds later fall through.
  let kind: LiveVoiceTrack['kind'] = 'data';
  if (t.type === TrackType.AUDIO) kind = 'audio';
  else if (t.type === TrackType.VIDEO) kind = 'video';

  const isVideo = t.type === TrackType.VIDEO;
  return {
    source,
    kind,
    muted: t.muted,
    encrypted: t.encryption !== ENCRYPTION_NONE,
    // Dimensions only for video, and only when actually declared (0 = unset).
    // TrackInfo.name is deliberately NOT surfaced: it is unverified
    // client-supplied text and is routinely a device model string
    // ("FaceTime HD Camera") — a hardware disclosure with no operator value.
    width: isVideo && t.width > 0 ? t.width : null,
    height: isVideo && t.height > 0 ? t.height : null,
  };
}

function parseRoomName(name: string): {
  scope: LiveVoiceRoom['scope'];
  guildId: bigint | null;
  channelId: bigint | null;
} {
  const g = GUILD_ROOM_RE.exec(name);
  const gGuild = g?.[1];
  const gChannel = g?.[2];
  if (gGuild !== undefined && gChannel !== undefined) {
    const guildId = parseSnowflake(gGuild);
    const channelId = parseSnowflake(gChannel);
    if (guildId !== null && channelId !== null) return { scope: 'guild', guildId, channelId };
  }
  const dChannel = DM_ROOM_RE.exec(name)?.[1];
  if (dChannel !== undefined) {
    const channelId = parseSnowflake(dChannel);
    if (channelId !== null) return { scope: 'dm', guildId: null, channelId };
  }
  // A room we didn't mint a token for — an agent room, a manual createRoom, or
  // a leftover from another deployment sharing the project. Worth seeing.
  return { scope: 'unknown', guildId: null, channelId: null };
}

// ── Server-side coalescing ──────────────────────────────────────────────────
//
// Two separate mechanisms, and the first is the one that matters:
//
//   inFlight — the build currently running, shared with every caller for as
//              long as it runs. No time bound HERE, because the build itself
//              carries one (boundedSnapshot / BUILD_HARD_MS).
//   cache    — the last SETTLED snapshot, reused for CACHE_TTL_MS after it
//              finished, so a burst of polls just behind a fast build doesn't
//              start another one.
//
// Splitting them is the whole point. A single { at, promise } stamped when the
// build STARTED gives a 2s window against a build allowed to run for 7s, so
// callers arriving 2-7s in miss the cache and launch a second full fan-out —
// and the only time a build takes that long is when the SFU is degraded, which
// is precisely when several admins are watching this tab and clicking Refresh.
// The guarantee has to hold in the bad case or it isn't one.
//
// The two properties are in tension and BOTH have to hold:
//   1. concurrent callers share one build, however long it takes;
//   2. a build that never finishes cannot kill the endpoint for the life of
//      the process.
// A start-stamped TTL buys (2) by giving up (1) — it expires mid-build and
// lets the next caller start a second fan-out. Bounding the BUILD instead buys
// (2) without touching (1), and does it where the problem actually is: the
// unbounded awaits. Anything the wall clock outruns settles as a degraded
// snapshot, so `inFlight` always clears through the ordinary fulfil path and
// there is no second clock to keep in step with the first.
let inFlight: Promise<LiveVoiceSnapshot> | null = null;
let cache: { at: number; promise: Promise<LiveVoiceSnapshot> } | null = null;

/**
 * Build (or reuse) a live voice snapshot. Never throws: an unreachable or
 * misconfigured SFU is reported in `status`/`error` so the panel can render
 * classified guidance instead of a generic request failure.
 */
export function getLiveVoice(): Promise<LiveVoiceSnapshot> {
  if (inFlight) return inFlight;
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.promise;

  const promise = boundedSnapshot();
  inFlight = promise;
  promise.then(
    () => {
      if (inFlight === promise) inFlight = null;
      // Stamped on COMPLETION, so the TTL is a gap between fan-outs rather
      // than a slice out of the middle of one.
      cache = { at: Date.now(), promise };
    },
    () => {
      // buildSnapshot is written not to reject, but if it ever does, don't
      // serve a poisoned promise (and don't leave an unhandled rejection
      // behind either — this handler is what consumes it).
      if (inFlight === promise) inFlight = null;
      if (cache?.promise === promise) cache = null;
    },
  );
  return promise;
}

/**
 * buildSnapshot() under a hard wall clock.
 *
 * The timer RESOLVES rather than rejects: `status: 'error'` is how this
 * service already reports "no reading available", the panel already renders it
 * (red banner over the last good snapshot), and getLiveVoice's fulfil path is
 * what clears `inFlight`. Genuine rejections are deliberately NOT caught here
 * — they still propagate to the caller exactly as before, so this changes the
 * behaviour of nothing except a build that hangs.
 *
 * The abandoned build keeps running: a JS promise cannot be cancelled and a
 * wedged pg query cannot be revoked client-side. It is detached, not leaked —
 * race() has handlers on it, so even a late rejection is consumed. What
 * matters is that the ENDPOINT is free again; the next poll builds afresh.
 */
function boundedSnapshot(): Promise<LiveVoiceSnapshot> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<LiveVoiceSnapshot>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        status: 'error',
        // Deliberately doesn't blame the SFU: every media-server call in the
        // build is individually time-boxed, so a stall this long is more
        // likely the unbounded database read that follows them.
        error:
          `Gave up on this reading after ${Math.round(BUILD_HARD_MS / 1000)}s. ` +
          'Every media-server call is individually time-boxed, so a stall this long points at ' +
          'the database read behind them rather than at the SFU. Refresh to try again.',
        // Cheap and already redacted — worth keeping so the panel can still
        // name which SFU it was talking to while it hung.
        httpUrl: redactUrl(resolveHttpUrl()),
        rooms: [],
        roomsTruncated: 0,
        appOnlyRoomsTruncated: 0,
        totals: { rooms: 0, participants: 0, publishers: 0, ghosts: 0, orphans: 0 },
        tookMs: Date.now() - startedAt,
        generatedAt: new Date().toISOString(),
      });
    }, BUILD_HARD_MS);
  });
  return Promise.race([buildSnapshot(), abandoned]).finally(() => clearTimeout(timer));
}

interface RoomFetch {
  room: Room;
  state: LiveVoiceRoom['participantsState'];
  participants: ParticipantInfo[];
  error: string | null;
}

async function buildSnapshot(): Promise<LiveVoiceSnapshot> {
  const startedAt = Date.now();
  const deadline = startedAt + OVERALL_BUDGET_MS;

  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const rawUrl = resolveHttpUrl();
  const safeUrl = redactUrl(rawUrl);
  const errUrl = safeUrl ?? 'the configured LiveKit URL';

  const empty = {
    httpUrl: safeUrl,
    rooms: [] as LiveVoiceRoom[],
    roomsTruncated: 0,
    appOnlyRoomsTruncated: 0,
    totals: { rooms: 0, participants: 0, publishers: 0, ghosts: 0, orphans: 0 },
  };

  // Presence-only mode is a supported configuration, not a fault — the panel
  // renders this amber, matching the 'warn' the diagnostic's credentials check
  // already uses for the same condition.
  if (!apiKey || !apiSecret || !rawUrl) {
    return {
      status: 'unconfigured',
      error: null,
      ...empty,
      tookMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
    };
  }

  // requestTimeout is SECONDS (ClientOptions), unlike withTimeout's
  // milliseconds. Passing 5000 here would be an 83-minute timeout, i.e. none
  // at all. This gives us real cancellation (the SDK aborts the fetch);
  // withTimeout is only the outer guard that stops us WAITING.
  const svc = new RoomServiceClient(rawUrl, apiKey, apiSecret, {
    requestTimeout: PER_CALL_TIMEOUT_S,
  });

  let allRooms: Room[];
  try {
    allRooms = await withTimeout(svc.listRooms(), LIST_ROOMS_MS, 'LiveKit listRooms');
  } catch (e) {
    // The only failure that blanks the whole snapshot — without the room list
    // there is nothing to reconcile against.
    return {
      status: 'error',
      error: classifyError(e, errUrl),
      ...empty,
      tookMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
    };
  }

  // Busiest rooms first: if we have to truncate, truncate the empty ones.
  //
  // Three bands, and only the first two produce anything downstream:
  //   [0, ROOM_CAP)      fan out for participant detail
  //   [ROOM_CAP, ROW_CAP) a row with listRooms' counts, detail 'skipped'
  //   [ROW_CAP, …)        a number in roomsTruncated, nothing more
  // The third band is what keeps rooms[], the response body and the channel
  // IN list below bounded by constants instead of by SFU room count.
  const sorted = [...allRooms].sort((a, b) => b.numParticipants - a.numParticipants);
  const targets = sorted.slice(0, ROOM_CAP);
  const listedSkipped = sorted.slice(ROOM_CAP, ROW_CAP);
  const unlistedRooms = Math.max(0, sorted.length - ROW_CAP);

  // Fixed-size worker pool over an index cursor. The worker never rejects —
  // a wedged room becomes a row with participantsState:'error', it does not
  // blank the page.
  const results: RoomFetch[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const room = targets[i];
      if (!room) return;
      if (Date.now() + PER_CALL_TIMEOUT_S * 1000 > deadline) {
        // Not a fault — we ran out of budget. Rendered neutrally.
        results[i] = { room, state: 'deadline', participants: [], error: null };
        continue;
      }
      try {
        const ps = await withTimeout(
          svc.listParticipants(room.name),
          // Slightly wider than the SDK's own abort so its (cleaner, typed)
          // timeout is what normally fires.
          PER_CALL_TIMEOUT_S * 1000 + 250,
          `LiveKit listParticipants(${room.name})`,
        );
        results[i] = { room, state: 'ok', participants: ps, error: null };
      } catch (e) {
        results[i] = { room, state: 'error', participants: [], error: classifyError(e, errUrl) };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FANOUT_CONCURRENCY, targets.length) }, () => worker()),
  );

  const fetched: RoomFetch[] = [];
  for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (r) fetched.push(r);
  }
  for (const room of listedSkipped) {
    fetched.push({ room, state: 'skipped', participants: [], error: null });
  }

  // ── Our own belief about who is in voice ─────────────────────────────────
  //
  // Unbounded but tiny: one row per person currently in voice, instance-wide
  // (PK is user_id). metrics.ts already aggregates this same table per poll.
  const voiceRows = await db
    .select({
      userId: schema.voiceStates.userId,
      channelId: schema.voiceStates.channelId,
      guildId: schema.voiceStates.guildId,
      selfMute: schema.voiceStates.selfMute,
      selfDeaf: schema.voiceStates.selfDeaf,
      joinedAt: schema.voiceStates.joinedAt,
    })
    .from(schema.voiceStates);

  type VoiceRow = (typeof voiceRows)[number];
  const appByRoom = new Map<string, VoiceRow[]>();
  for (const row of voiceRows) {
    // The room name imported from voice.ts, not re-derived here: the whole
    // reconciliation keys on both sides agreeing about this exact string, and
    // a second copy is a drift waiting to happen.
    const key = roomNameForRow(row);
    const list = appByRoom.get(key);
    if (list) list.push(row);
    else appByRoom.set(key, [row]);
  }

  // App-only rooms: voice_states rows for a room LiveKit has never heard of.
  // This is the COMMON ghost — the last occupant leaves, LiveKit reaps the
  // empty room, and a stale row survives. Diffing only inside LiveKit-known
  // rooms would make exactly that case invisible, which would gut the point of
  // the monitor, so they're synthesized as rows with participantCount 0.
  // totals.rooms stays the LiveKit count (see the DTO comment).
  const liveNames = new Set(allRooms.map((r) => r.name));
  const appOnlyNames = [...appByRoom.keys()]
    .filter((n) => !liveNames.has(n))
    .sort((a, b) => (appByRoom.get(b)?.length ?? 0) - (appByRoom.get(a)?.length ?? 0));
  const appOnlyShown = appOnlyNames.slice(0, APP_ONLY_ROW_CAP);

  // ── Identity + channel resolution: 2 batched queries ─────────────────────
  //
  // Raw snowflakes fail the operator test — "847293…" tells you nothing at 2am
  // and this tab exists to be read under pressure. The client can't resolve
  // them either (the admin panel has no general user cache), so shipping raw
  // ids would just buy a second round trip. Two indexed queries are free next
  // to N HTTPS calls to LiveKit.
  const userIds = new Set<bigint>();
  for (const f of fetched) {
    for (const p of f.participants) {
      // The identity is only ever our user id because WE mint it
      // (voice.ts mintLivekitToken). An agent, egress worker or SIP leg can
      // carry any string at all — parseSnowflake refuses those rather than
      // throwing.
      const id = parseSnowflake(p.identity);
      if (id !== null) userIds.add(id);
    }
  }
  for (const row of voiceRows) userIds.add(row.userId);

  // Both inputs are already row-capped (ROW_CAP + APP_ONLY_ROW_CAP), so the
  // inArray() this feeds is bounded by constants, not by SFU room count.
  const channelIds = new Set<bigint>();
  const roomMeta = new Map<string, ReturnType<typeof parseRoomName>>();
  for (const name of [...fetched.map((f) => f.room.name), ...appOnlyShown]) {
    const meta = parseRoomName(name);
    roomMeta.set(name, meta);
    if (meta.channelId !== null) channelIds.add(meta.channelId);
  }

  const userIdList = [...userIds].slice(0, USER_LOOKUP_CAP);
  const channelIdList = [...channelIds];
  const [userRows, channelRows] = await Promise.all([
    userIdList.length
      ? db
          .select({
            id: schema.users.id,
            username: schema.users.username,
            displayName: schema.users.displayName,
            avatarUrl: schema.users.avatarUrl,
            deletedAt: schema.users.deletedAt,
          })
          .from(schema.users)
          .where(inArray(schema.users.id, userIdList))
      : Promise.resolve([]),
    channelIdList.length
      ? db
          .select({
            id: schema.channels.id,
            name: schema.channels.name,
            guildName: schema.guilds.name,
          })
          .from(schema.channels)
          .leftJoin(schema.guilds, eq(schema.guilds.id, schema.channels.guildId))
          .where(inArray(schema.channels.id, channelIdList))
      : Promise.resolve([]),
  ]);

  // Keyed by decimal string so participant lookup needs no re-parse.
  // No deletedAt filter: a deleted account still connected to the SFU is
  // precisely the anomaly worth seeing, so it's rendered with a chip rather
  // than hidden.
  const usersById = new Map<string, LiveVoiceUser>();
  for (const u of userRows) {
    usersById.set(u.id.toString(), {
      id: u.id.toString(),
      username: u.username,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      deleted: u.deletedAt !== null,
    });
  }
  const channelsById = new Map<string, { name: string | null; guildName: string | null }>();
  for (const ch of channelRows) {
    channelsById.set(ch.id.toString(), { name: ch.name, guildName: ch.guildName });
  }

  // ── Assemble + reconcile ─────────────────────────────────────────────────
  let totalGhosts = 0;
  let totalOrphans = 0;
  const rooms: LiveVoiceRoom[] = [];

  const buildRoom = (
    name: string,
    live: { participantCount: number; publisherCount: number; recording: boolean; createdAt: string | null },
    read: { state: LiveVoiceRoom['participantsState']; participants: ParticipantInfo[]; error: string | null },
  ): LiveVoiceRoom => {
    const meta = roomMeta.get(name) ?? parseRoomName(name);
    const ch = meta.channelId !== null ? channelsById.get(meta.channelId.toString()) : undefined;
    const appRows = appByRoom.get(name) ?? [];

    const participants: LiveVoiceParticipant[] = [];
    const seenIdentities = new Set<string>();
    for (const p of read.participants) {
      seenIdentities.add(p.identity);
      const kind = mapKind(p.kind);
      const state = mapState(p.state);
      const hasAppRow = appRows.some((r) => r.userId.toString() === p.identity);
      // Orphan classification is narrow on purpose:
      //   - non-standard kinds (agent/egress/sip/ingress) are infrastructure
      //     and NEVER have voice_states rows; flagging them would be noise
      //     that trains the operator to ignore the column.
      //   - a DISCONNECTED participant is on its way out; the app deleting the
      //     row first is the correct order, not a defect.
      const orphan = kind === 'standard' && state !== 'disconnected' && !hasAppRow;
      if (orphan) totalOrphans++;
      participants.push({
        identity: p.identity,
        user: usersById.get(p.identity) ?? null,
        state,
        kind,
        publishing: p.isPublisher,
        connectedAt: epochIso(p.joinedAtMs, p.joinedAt),
        tracks: p.tracks.map(mapTrack),
        sync: orphan ? 'orphan' : 'ok',
      });
    }

    // Ghosts are only DETERMINABLE when we actually read the participant list.
    // For an 'error'/'deadline'/'skipped' room we don't know who is connected,
    // so calling its app rows ghosts would be a fabricated alarm.
    const ghosts: LiveVoiceGhost[] = [];
    if (read.state === 'ok') {
      for (const row of appRows) {
        const identity = row.userId.toString();
        if (seenIdentities.has(identity)) continue;
        totalGhosts++;
        ghosts.push({
          user: usersById.get(identity) ?? null,
          identity,
          appJoinedAt: row.joinedAt.toISOString(),
          selfMute: row.selfMute,
          selfDeaf: row.selfDeaf,
        });
      }
    }

    return {
      name,
      scope: meta.scope,
      channelId: meta.channelId?.toString() ?? null,
      guildId: meta.guildId?.toString() ?? null,
      // Null when the channel row is gone entirely (a live room on a deleted
      // channel — a finding) and, harmlessly, for DM channels, which have no
      // name by design.
      channelName: ch?.name ?? null,
      guildName: ch?.guildName ?? null,
      createdAt: live.createdAt,
      participantCount: live.participantCount,
      publisherCount: live.publisherCount,
      appCount: appRows.length,
      recording: live.recording,
      participantsState: read.state,
      participantsError: read.error,
      participants,
      ghosts,
    };
  };

  for (const f of fetched) {
    rooms.push(
      buildRoom(
        f.room.name,
        {
          participantCount: f.room.numParticipants,
          publisherCount: f.room.numPublishers,
          recording: f.room.activeRecording,
          createdAt: epochIso(f.room.creationTimeMs, f.room.creationTime),
        },
        { state: f.state, participants: f.participants, error: f.error },
      ),
    );
  }
  for (const name of appOnlyShown) {
    // LiveKit has no room by this name at all, so every app row here is a
    // ghost with certainty — state 'ok' with an empty participant list is
    // exactly right, not a placeholder.
    rooms.push(
      buildRoom(
        name,
        { participantCount: 0, publisherCount: 0, recording: false, createdAt: null },
        { state: 'ok', participants: [], error: null },
      ),
    );
  }

  // App-only rooms past the cap didn't get a row, but their occupants are
  // ghosts with certainty (LiveKit has no such room at all), so they still
  // count. Truncation must cost detail, never accuracy of the number the
  // operator triages on.
  for (const name of appOnlyNames.slice(APP_ONLY_ROW_CAP)) {
    totalGhosts += appByRoom.get(name)?.length ?? 0;
  }

  // Headline totals come from the FULL listRooms array, never from the capped
  // subset, so truncation only ever costs detail — the counts stay correct.
  let participants = 0;
  let publishers = 0;
  for (const r of allRooms) {
    participants += r.numParticipants;
    publishers += r.numPublishers;
  }

  return {
    status: 'ok',
    error: null,
    httpUrl: safeUrl,
    rooms,
    // Reported separately, never summed. A LiveKit room past the cap is live
    // on the SFU and its occupancy is in `totals`; an app-only room past the
    // cap is not on the SFU at all and its occupants are ghosts. One number
    // for both would be a sentence the UI cannot write truthfully.
    roomsTruncated: unlistedRooms,
    appOnlyRoomsTruncated: appOnlyNames.length - appOnlyShown.length,
    totals: {
      rooms: allRooms.length,
      participants,
      publishers,
      ghosts: totalGhosts,
      orphans: totalOrphans,
    },
    tookMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };
}
