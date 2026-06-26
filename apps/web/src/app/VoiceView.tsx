/**
 * VoiceView
 * ---------
 * Renders in the main panel (where MessageView normally goes) when the
 * active channel is a voice channel. Three regions stacked vertically:
 *
 *   Header      — channel name + topic, same shape as MessageView's header
 *   Tile grid   — square avatar tiles, replaced by video/screen tiles
 *                 when participants publish them. The screen-share tile
 *                 spans the full row when present (Discord behavior).
 *   Controls    — bottom strip: Mic / Deafen / Camera / Screen / Disconnect
 *
 * Participants come from AppState (server presence). Speaking + tracks
 * come from the voice manager's pub/sub. The two are joined by user id.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import {
  useAppStateSelector,
  voiceStatesForChannel,
  selfVoiceState,
} from '../state/AppState';
import { useToasts } from '../state/Toasts';
import {
  Volume2,
  Mic,
  MicOff,
  PhoneOff,
  Headphones,
  HeadphonesOff,
  Video,
  VideoOff,
  ScreenShare,
  X,
} from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { SpeakingRing } from '../lib/SpeakingRing';
import { Portal } from '../lib/Portal';
import { UserVolumePopover } from '../lib/UserVolumePopover';
import {
  getVoicePrefs,
  getUserPrefs,
  setMasterVolume,
  subscribeVoicePrefs,
} from '../lib/voicePrefs';
import {
  connectToVoice,
  disconnectVoice,
  setMicMuted,
  setDeafened,
  setCameraEnabled,
  setScreenShareEnabled,
  isDeafened,
  subscribeSpeakers,
  getCurrentSpeakers,
  subscribeTracks,
  getCurrentTracks,
  subscribeConnectionState,
  getConnectionState,
  prepareVoiceAudio,
  VoiceError,
  type VoiceTrackInfo,
  type VoiceConnectionState,
} from '../lib/voice';

/**
 * Compute a seat's percentage position on the spatial-arena background.
 * Deterministic given (index, total) so seats keep their spots across
 * re-renders even when participant order shifts (React's keyed array
 * handles diffing; this function just describes the LAYOUT they sit
 * within).
 *
 *   1 participant         → dead center
 *   2-7 participants      → single ring around the center, radius
 *                           scales with count so two people aren't
 *                           uncomfortably tight
 *   8+ participants       → inner ring (~⅓ of seats at 18% radius) +
 *                           outer ring (rest at 36% radius) with a
 *                           half-step angular offset so inner/outer
 *                           seats don't align radially
 *
 * Angles start at -π/2 (12 o'clock) and proceed clockwise — same
 * convention most chat apps use for participant ordering.
 */
/**
 * Position a participant in the orbital arena using a galaxy/spiral
 * layout. Each user gets their own concentric tier:
 *
 *   Tier 1 (first user) — closest to the beacon at center, at 12%
 *     radius. Not at the center itself; the beacon owns that point
 *     and seats orbit around it.
 *
 *   Each subsequent user — one tier further out (8% step).
 *
 *   Angular spread uses the golden angle (137.5°) so adjacent users
 *     fall on a natural sunflower-spiral curve, avoiding aligned
 *     spokes and creating an irregular galaxy-arm feel.
 *
 * Returns RAW positions — no cap. When more than ~5 users push the
 * outermost tier past the arena bounds, the orbit container's CSS
 * transform scales the whole thing (positions AND seat sizes
 * uniformly) — see `arenaScale()` below and the orbit wrapper JSX.
 * Doing the shrink in CSS rather than here keeps seats from
 * overlapping in dense rooms: pure radial scaling would compress
 * the inter-tier gaps below the seat width, but a transform-scale
 * pulls the seats themselves smaller in lockstep.
 */
function arenaPosition(index: number, total: number): { x: number; y: number } {
  if (total === 0) return { x: 50, y: 50 };

  const INNER_RADIUS = 12; // % of arena — where tier 1 sits
  const TIER_STEP = 8; // % of arena — radial distance between tiers
  // Golden angle — 360 × (1 - 1/φ). Produces the spiral packing seen
  // in sunflower seeds. Small N: pleasant irregular spreads. Large N:
  // approximates uniform plane tiling. Either way: no aligned spokes,
  // no symmetric clumping, no two adjacent tiers on the same radial.
  const GOLDEN_ANGLE_DEG = 137.5;

  const radius = INNER_RADIUS + index * TIER_STEP;
  const angleRad = ((index * GOLDEN_ANGLE_DEG) * Math.PI) / 180;
  return {
    x: 50 + Math.cos(angleRad) * radius,
    y: 50 + Math.sin(angleRad) * radius,
  };
}

/**
 * Uniform scale factor to apply to the orbit container when the
 * outermost tier would clip the arena edge. Returns 1 (no scaling)
 * for up to ~5 users; smaller-than-1 for denser rooms. Applied as a
 * CSS `transform: scale(...)` so seat positions AND sizes shrink
 * together — the whole constellation visually "zooms out" as more
 * users join, like a galaxy compressing to fit more stars without
 * any individual orbit going off-frame.
 */
function arenaScale(total: number): number {
  if (total <= 1) return 1;
  const INNER_RADIUS = 12;
  const TIER_STEP = 8;
  const MAX_RADIUS = 46; // % of arena — 4% margin to the edge
  const outerRadius = INNER_RADIUS + (total - 1) * TIER_STEP;
  if (outerRadius <= MAX_RADIUS) return 1;
  return MAX_RADIUS / outerRadius;
}

// Deterministic faint starfield for the voice arena — mirrors the native
// StarfieldView (70 stars, generated ONCE so they never shimmer/reflow
// between renders). Positions are percentages so they fill the responsive
// arena; radius/opacity match the native ranges (0.4–1.7px, 0.15–0.65).
const ARENA_STARS = (() => {
  let s = 0x5deece66 >>> 0; // seed (mirrors the native StarfieldView seed)
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: 70 }, () => ({
    x: rnd() * 100,
    y: rnd() * 100,
    r: rnd() * 1.3 + 0.4,
    o: rnd() * 0.5 + 0.15,
  }));
})();

function ArenaStarfield() {
  return (
    <svg
      className="absolute inset-0 h-full w-full pointer-events-none"
      preserveAspectRatio="none"
      aria-hidden
    >
      {ARENA_STARS.map((st, i) => (
        <circle key={i} cx={`${st.x}%`} cy={`${st.y}%`} r={st.r} fill="white" opacity={st.o} />
      ))}
    </svg>
  );
}

export function VoiceView({
  channel,
  displayName,
}: {
  channel: Channel;
  /** Optional header title override. Used by DM calls where the
      channel itself has no name and we want to show the recipient's
      display name in the header instead. Guild voice channels leave
      this undefined and we fall back to channel.name. */
  displayName?: string;
}) {
  // Narrow selectors instead of useAppState(): the voice arena stays mounted
  // for the whole call, and a whole-state subscription re-rendered this large
  // component on every reducer dispatch (every message/typing/presence event
  // in any channel). Subscribe only to the three slices it reads. Mirrors
  // VoicePanel/MemberList.
  const supervision = useAppStateSelector((v) => v.state.supervision);
  const voiceStatesByUser = useAppStateSelector((v) => v.state.voiceStatesByUser);
  const usersById = useAppStateSelector((v) => v.state.usersById);
  const mergeChannelVoiceStates = useAppStateSelector((v) => v.mergeChannelVoiceStates);
  const restForChannel = useAppStateSelector((v) => v.restForChannel);
  const { user } = useAuth();
  // Parental controls: a supervised child may be barred from video and/or
  // screen sharing. The server already enforces this at the SFU token;
  // here we disable the controls so the restriction is visible too.
  const childRestr = supervision?.restrictions ?? null;
  const videoRestricted = childRestr ? !childRestr.allowVideo : false;
  const streamRestricted = childRestr ? !childRestr.allowStream : false;
  const toasts = useToasts();
  const navigate = useNavigate();

  // Memoized: voiceStatesForChannel and selfVoiceState both walk
  // the voiceStatesByUser map every call. Without memoization they
  // produce fresh arrays/objects every render, which makes every
  // downstream effect (leaving-tracker, watcher cleanups) re-run
  // even when voice state hasn't changed. Gating on voiceStatesByUser
  // identity (the reducer only swaps that ref when a state actually
  // changes) confines recomputation to actual voice transitions.
  const participants = useMemo(
    () => voiceStatesForChannel(voiceStatesByUser, channel.id),
    [voiceStatesByUser, channel.id],
  );
  const myVoice = useMemo(
    () => selfVoiceState(voiceStatesByUser, user?.id),
    [voiceStatesByUser, user?.id],
  );
  const inThis = !!myVoice && myVoice.channelId === channel.id;

  // Live state from the voice manager.
  const speakers = useSpeakers();
  const tracks = useTracks();
  const connState = useVoiceConnectionState();

  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  // Theater mode hides the participant tile row entirely so the
  // screen share fills the whole content area. Lives as page-local
  // state; we don't persist it because users typically want it
  // active only for as long as they're focused on the share.
  const [theater, setTheater] = useState(false);
  // Local-deafen state shadowed in React because `isDeafened()` is
  // read-when-asked; we want re-renders when it flips.
  const [deafened, setDeafenedState] = useState(isDeafened());

  // Leaving-participant tracking. When someone disappears from
  // `participants`, we capture their last orbital position and the
  // user record they had, then keep that data around for 1.2s
  // (matching the swallow keyframe duration) so we can render the
  // "being pulled into the black hole" animation. A ref holds the
  // previous participants array — the diff in the effect below uses
  // it to detect who just left without depending on render-time state
  // that may be stale.
  const prevParticipantsRef = useRef<typeof participants>(participants);
  const [leaving, setLeaving] = useState<
    Map<string, { x: number; y: number; userId: string }>
  >(new Map());

  // Ref holds all pending setTimeout handles so we can cancel them
  // on unmount. Without this, a user navigating away from the voice
  // arena while a swallow animation was in flight would leave the
  // timers scheduled, which would fire later and call setLeaving on
  // an unmounted component (no observable crash in modern React but
  // wasted work + a dev warning).
  const leavingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    const timers = leavingTimersRef.current;
    return () => {
      // Clear every still-scheduled timer.
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const prev = prevParticipantsRef.current;
    const currentIds = new Set(participants.map((p) => p.userId));
    // Walk the PRIOR list — anyone who was there but isn't now is
    // leaving. We look up their prior index in `prev` (not in the
    // current list, which doesn't include them anymore) to compute
    // the orbital position they were sitting at right before
    // disappearing.
    const departed: Array<{ userId: string; x: number; y: number }> = [];
    prev.forEach((p, i) => {
      if (!currentIds.has(p.userId)) {
        const pos = arenaPosition(i, prev.length);
        departed.push({ userId: p.userId, x: pos.x, y: pos.y });
      }
    });
    // Update the leaving map. Inside the updater we also drop any
    // user who's now back in participants (rejoined during the
    // swallow window) — otherwise they'd render as both a live tile
    // AND a swallow tile. Doing this inside the updater keeps the
    // effect's deps to just [participants] (depending on `leaving`
    // would create a feedback loop with setLeaving below).
    setLeaving((cur) => {
      const rejoined: string[] = [];
      for (const id of cur.keys()) {
        if (currentIds.has(id)) rejoined.push(id);
      }
      if (departed.length === 0 && rejoined.length === 0) return cur;
      const next = new Map(cur);
      for (const id of rejoined) next.delete(id);
      for (const d of departed) next.set(d.userId, d);
      return next;
    });
    // Schedule cleanup for each new leaver. Slightly longer than the
    // keyframe duration so the final frame (opacity 0, scaled to
    // nothing) holds for a moment before unmounting — prevents a
    // perceptible "pop" on the cleanup tick. Timers tracked in a
    // ref so they can be cancelled on component unmount.
    for (const d of departed) {
      const id = d.userId;
      const t = setTimeout(() => {
        leavingTimersRef.current.delete(t);
        setLeaving((cur) => {
          if (!cur.has(id)) return cur;
          const next = new Map(cur);
          next.delete(id);
          return next;
        });
      }, 1300);
      leavingTimersRef.current.add(t);
    }
    prevParticipantsRef.current = participants;
  }, [participants]);

  // Reconcile the React state with the actual published local tracks.
  // Necessary because the user can stop a screen share or camera from
  // OUTSIDE the app — Chrome's bottom-of-page "Stop sharing" overlay,
  // OS-level revocation, hardware unplug. Without this, the in-app
  // button stays "active" forever and clicking it tries to stop a
  // track that's already gone (no-op) instead of starting a new one.
  useEffect(() => {
    if (!user?.id) return;
    const myCameras = tracks.some((t) => t.userId === user.id && t.kind === 'camera');
    const myScreens = tracks.some((t) => t.userId === user.id && t.kind === 'screen');
    if (myCameras !== cameraOn) setCameraOn(myCameras);
    if (myScreens !== screenOn) setScreenOn(myScreens);
  }, [tracks, user?.id, cameraOn, screenOn]);

  // ── Actions ─────────────────────────────────────────────────────────────

  async function joinThis() {
    // Prime shared audio context inside the click — see voice.prepareVoiceAudio.
    prepareVoiceAudio();
    try {
      const r = await (await restForChannel(channel.id)).joinVoice(channel.id);
      mergeChannelVoiceStates(channel.id, r.channelVoiceStates);
      if (r.token && r.wsUrl) {
        try {
          await connectToVoice({
            token: r.token,
            wsUrl: r.wsUrl,
            sessionId: r.voiceState.sessionId,
            channelId: channel.id,
            isDmCall: channel.type === 'dm',
            // Only 1:1 DMs have a shared passphrase; encrypt the call
            // media with it when the DM has E2EE on. Guild/stage/group-DM
            // voice has no shared key and is never E2EE.
            ...(channel.type === 'dm' && channel.e2eeEnabled
              ? { e2ee: { channelId: channel.id, verifier: channel.e2eeVerifier } }
              : {}),
          });
        } catch (e) {
          // Roll back the server-side join so a failed media connect doesn't
          // leave us as a silent ghost in the channel (the gateway echoes the
          // leave). Best-effort.
          void (await restForChannel(channel.id)).leaveVoice(channel.id).catch(() => {});
          toasts.push(
            e instanceof VoiceError
              ? e.message
              : e instanceof Error
                ? `Voice connect failed: ${e.message}`
                : 'Voice connect failed',
            'error',
          );
        }
      } else {
        toasts.push('Voice isn’t set up on this server yet — you’ve joined the channel, but no audio will connect. Ask the server admin to enable voice.', 'info');
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to join voice', 'error');
    }
  }

  // Animated hangup for 1:1 DM calls. When the user clicks "leave"
  // while the partner is also in voice, we play the black-hole-swallow
  // animation on the user's OWN tile before actually disconnecting —
  // the same visual the OTHER party sees when someone leaves. Without
  // this, the leaver's screen just snaps from voice arena back to
  // MessageView with no transition, which feels abrupt for the
  // hard-edged "call ended" action.
  //
  // For guild voice, group DM voice, or un-answered ring-out, the
  // immediate-leave behavior is preserved — the animation is only
  // useful when there's a partner present to mark the moment.
  const [selfHangingUp, setSelfHangingUp] = useState(false);

  async function leave() {
    const isDm1to1 = channel.type === 'dm';
    const otherInThis = participants.some((p) => p.userId !== user?.id);
    if (isDm1to1 && otherInThis && user?.id) {
      // Mark self as hanging up so the JSX renders the swallow
      // overlay on the local participant's tile.
      setSelfHangingUp(true);
      // Wait one keyframe (1.2s, matching .zk-blackhole-swallow). Then
      // do the actual disconnect; the Shell's MessageView re-renders
      // moments after voice_state clears server-side.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          leavingTimersRef.current.delete(t);
          resolve();
        }, 1200);
        leavingTimersRef.current.add(t);
      });
    }
    await disconnectVoice();
    if (myVoice?.channelId) {
      try {
        await (await restForChannel(myVoice.channelId)).leaveVoice(myVoice.channelId);
      } catch (e) {
        toasts.push(e instanceof ApiError ? e.message : 'Failed to leave', 'error');
      }
    }
  }

  async function toggleMute() {
    if (!inThis || !myVoice?.channelId) return;
    const next = !myVoice.selfMute;
    // Unmuting while deafened should also drop deafen — you can't be
    // audible while you can't hear (matches Discord). Muting, or
    // unmuting when not deafened, only touches the mic.
    const dropDeafen = !next && (deafened || myVoice.selfDeaf);
    try {
      await setMicMuted(next);
      if (dropDeafen) await setDeafened(false);
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Mute toggle failed', 'error');
      return;
    }
    if (dropDeafen) setDeafenedState(false);
    try {
      await (await restForChannel(myVoice.channelId)).updateVoiceState(
        myVoice.channelId,
        dropDeafen ? { selfMute: next, selfDeaf: false } : { selfMute: next },
      );
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Mute sync failed', 'error');
    }
  }

  async function toggleDeafen() {
    if (!inThis || !myVoice?.channelId) return;
    const next = !deafened;
    try {
      await setDeafened(next);
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Deafen toggle failed', 'error');
      return;
    }
    setDeafenedState(next);
    // Deafen → mute coupling.
    //   ON  (next=true)  → also force mute. Matches Discord: there's
    //                      no scenario where you'd want others to
    //                      hear you while you can't hear them.
    //   OFF (next=false) → also un-mute. The user's intent on un-
    //                      deafen is "rejoin the conversation",
    //                      which means audible too. Without this
    //                      they'd un-deafen but stay silent because
    //                      mute was forced on when they deafened.
    try {
      await setMicMuted(next);
    } catch {
      // Soft fail — server state below is the audible source of
      // truth for other participants.
    }
    try {
      await (await restForChannel(myVoice.channelId)).updateVoiceState(myVoice.channelId, {
        selfDeaf: next,
        selfMute: next,
      });
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Deafen sync failed', 'error');
    }
  }

  // In-flight guard refs. setScreenShareEnabled / setCameraEnabled can
  // take 500ms-3s to resolve (OS picker, encoder negotiation). Without
  // a sync guard, a user clicking rapidly between off→on→off→on races
  // multiple LiveKit publish/unpublish calls and leaves the local state
  // out of sync with the SDK's view. Refs (not state) so the guard
  // evaluates against TRUE up-to-date in-flight status, not the closure
  // snapshot at the time the handler was bound.
  const cameraBusyRef = useRef(false);
  const screenBusyRef = useRef(false);

  async function toggleCamera() {
    if (!inThis) return;
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    const next = !cameraOn;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
      // eslint-disable-next-line no-console
      console.log('[voice] toggleCamera', { current: cameraOn, next });
    }
    try {
      await setCameraEnabled(next);
      setCameraOn(next);
    } catch (e) {
      // A permission denial reaches us as code 'mic_denied_browser'
      // (mediaErrorToVoiceError maps every NotAllowedError to that code).
      // For the CAMERA button there's no OS picker to cancel — this means
      // the user (or a Permissions-Policy) blocked camera access, so we
      // must TELL them, not silently no-op. (Screen-share suppresses this
      // code because there a denial is just "user cancelled the picker".)
      if (e instanceof VoiceError && e.code === 'mic_denied_browser') {
        setCameraOn(false);
        toasts.push(
          'Camera access is blocked. Click the camera/lock icon in your browser’s address bar and allow Camera, then try again.',
          'error',
        );
        return;
      }
      toasts.push(
        e instanceof VoiceError ? e.message : e instanceof Error ? e.message : 'Camera toggle failed',
        'error',
      );
    } finally {
      cameraBusyRef.current = false;
    }
  }

  async function toggleScreenShare() {
    if (!inThis) return;
    if (screenBusyRef.current) return;
    screenBusyRef.current = true;
    const next = !screenOn;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
      // eslint-disable-next-line no-console
      console.log('[voice] toggleScreenShare', { current: screenOn, next });
    }
    try {
      await setScreenShareEnabled(next);
      setScreenOn(next);
    } catch (e) {
      // User cancelling the OS picker shows up as a NotAllowedError —
      // not actually an error from the user's perspective. Keep the
      // state in sync with reality but don't toast a scary message.
      if (e instanceof VoiceError && e.code === 'mic_denied_browser') {
        // Not really mic — but mediaErrorToVoiceError doesn't have a
        // separate code for screenshare cancel. Suppress the toast.
        setScreenOn(false);
        return;
      }
      toasts.push(
        e instanceof VoiceError ? e.message : e instanceof Error ? e.message : 'Screen share toggle failed',
        'error',
      );
      setScreenOn(false);
    } finally {
      screenBusyRef.current = false;
    }
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  //
  // Every participant gets exactly ONE tile. If they have an active
  // screen share or camera track, their tile is "promoted" to a big
  // featured tile in the top area that renders the video. Otherwise
  // they sit in a compact avatar row at the bottom (above the
  // controls). This avoids the previous duplication where a screen
  // sharer appeared as both a screen-share row tile and a separate
  // avatar tile in the grid below.
  //
  // Priority when a participant has BOTH camera and screen: screen
  // wins (it carries more useful information). The camera track is
  // ignored for that user — Discord does the same.

  // Unified streams list: cameras AND screens are both "streams"
  // shown in the featured area. Per user direction:
  //   "The webcam stream should convert to a screen just like the
  //    screen sharing."
  // No more camera-in-tile rendering — participant tiles only show
  // avatars / initials now; all video lives in the featured area.
  const streams = useMemo(() => tracks, [tracks]);

  // Local state: which streams the user is currently viewing.
  // Per user direction:
  //   "you should be given the option to view it and it shouldn't
  //    be automatically."
  // Initialized with the local user's own streams (they always see
  // their own preview). When a new stream arrives from another
  // participant, it stays OUT of this set until the user clicks
  // "View" — at which point it joins the set and the video element
  // mounts (LiveKit's adaptiveStream-paused track then starts
  // flowing because the <video> becomes intersection-observable).
  const [viewingSids, setViewingSids] = useState<Set<string>>(new Set());

  // Effect: keep local-user streams always-viewed. Local previews
  // shouldn't require a "View" click since you ARE the source —
  // toggling them off is done via the camera/screen control buttons
  // in the bottom bar.
  useEffect(() => {
    if (!user?.id) return;
    const localSids = streams
      .filter((s) => s.userId === user.id)
      .map((s) => s.trackSid);
    if (localSids.length === 0) return;
    setViewingSids((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const sid of localSids) {
        if (!next.has(sid)) {
          next.add(sid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [streams, user?.id]);

  // Effect: when a stream disappears (publisher unpublished or left),
  // drop it from the viewing set so the Set doesn't grow forever
  // with dead sids.
  useEffect(() => {
    const liveSids = new Set(streams.map((s) => s.trackSid));
    setViewingSids((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const sid of prev) {
        if (liveSids.has(sid)) next.add(sid);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [streams]);

  // Available streams from OTHER participants — what the user might
  // want to opt into watching. Local streams are excluded since they
  // always appear as previews via the auto-view effect above.
  const offeredStreams = useMemo(
    () => streams.filter((s) => s.userId !== user?.id),
    [streams, user?.id],
  );

  // Streams the user is actively viewing right now. Includes their
  // own (auto-viewed) and any remote ones they've opted into.
  const featuredStreams = useMemo(
    () => streams.filter((s) => viewingSids.has(s.trackSid)),
    [streams, viewingSids],
  );

  // Available-but-not-viewed: each renders as a "stream available"
  // card with a View button.
  const unwatchedStreams = useMemo(
    () => offeredStreams.filter((s) => !viewingSids.has(s.trackSid)),
    [offeredStreams, viewingSids],
  );

  // Stable so the memoized ParticipantTile's onJoinStream prop doesn't change
  // every render (otherwise React.memo could never skip a tile).
  const startViewing = useCallback((sid: string) =>
    setViewingSids((prev) => {
      if (prev.has(sid)) return prev;
      const next = new Set(prev);
      next.add(sid);
      return next;
    }), []);

  const stopViewing = useCallback((sid: string) =>
    setViewingSids((prev) => {
      if (!prev.has(sid)) return prev;
      const next = new Set(prev);
      next.delete(sid);
      return next;
    }), []);

  // Build a per-user map of streams this user hasn't watched yet —
  // used by ParticipantTile to render an inline "Join stream" link
  // under the participant's name. Per user direction:
  //   "The want to view stream should show a small join stream under
  //    there name."
  const unwatchedByUser = useMemo(() => {
    const map = new Map<string, VoiceTrackInfo[]>();
    for (const s of unwatchedStreams) {
      const existing = map.get(s.userId);
      if (existing) existing.push(s);
      else map.set(s.userId, [s]);
    }
    return map;
  }, [unwatchedStreams]);

  const hasFeatured = featuredStreams.length > 0;

  // Featured grid columns: 1 video → full width; 2 → side-by-side;
  // 3+ → 2-up wraps. Anything bigger than 4 starts feeling cramped
  // at typical viewport sizes; we cap layout density there.
  const featuredCols =
    featuredStreams.length <= 1
      ? 'grid-cols-1'
      : featuredStreams.length === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  return (
    <>
      <header className="px-4 h-12 border-b border-line/40 flex items-center gap-2 shrink-0 pl-12 xl:pl-4 pr-12 xl:pr-4 bg-black text-white">
        <Volume2 size={18} className="text-accent shrink-0" />
        <span className="font-semibold truncate">
          {displayName ?? channel.name ?? '(unnamed)'}
        </span>
        {channel.topic && (
          <>
            <span className="text-ink-3 shrink-0 hidden sm:inline">·</span>
            <span className="text-ink-2 text-sm truncate hidden sm:inline">{channel.topic}</span>
          </>
        )}
      </header>

      {/* Reconnecting banner. LiveKit fires Reconnecting when the media
          transport drops (network change, brief outage) and is trying to
          recover. Surfacing it stops the "everyone went silent and I don't
          know why" confusion — and a terminal Disconnected now tears the
          call down via voice.ts so we never sit here forever. */}
      {inThis && connState === 'reconnecting' && (
        <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center gap-3">
          <span className="size-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
          <div className="flex-1 min-w-0 text-sm text-amber-200">
            Reconnecting to voice…
          </div>
        </div>
      )}

      {/* Active screen-share banner. Shown when WE are publishing a
          screen-share track. The point isn't decoration — the browser
          shows its own "Stop sharing" overlay at the bottom of the
          page during screen share, and users were learning to use
          THAT to stop. We can't suppress the browser overlay (it's a
          security UX feature browsers enforce for getDisplayMedia),
          but a prominent in-app stop button next to clear messaging
          gives users a first-class alternative that keeps the action
          inside the app. The banner also doubles as a reminder that
          screen capture is live, which matters for accidental
          oversharing. */}
      {screenOn && (
        <div className="shrink-0 bg-emerald-500/10 border-b border-emerald-500/30 px-4 py-2 flex items-center gap-3">
          <ScreenShare size={16} className="text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0 text-sm">
            <span className="text-emerald-300 font-medium">You're sharing your screen</span>
            <span className="text-ink-2 hidden sm:inline"> — others in this call can see it.</span>
          </div>
          <button
            type="button"
            onClick={() => void toggleScreenShare()}
            className="shrink-0 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs sm:text-sm font-medium transition-colors"
          >
            Stop sharing
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-4 pb-24 sm:pb-28 flex flex-col gap-4">
        {participants.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-ink-3 text-sm">
            No one's in this voice channel yet.
          </div>
        ) : hasFeatured ? (
          /* Stream present. Featured area fills available height;
             the participant tile row docks under it as a compact
             strip — unless theater mode is on, in which case the
             tiles are hidden entirely so the stream owns the
             viewport. */
          <>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setTheater((t) => !t)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  theater
                    ? 'bg-accent text-white hover:bg-accent/90'
                    : 'bg-bg-2 text-ink-2 hover:bg-bg-3 hover:text-ink-1'
                }`}
                title={theater ? 'Show participants' : 'Hide participants (theater mode)'}
              >
                {theater ? 'Exit theater' : 'Theater mode'}
              </button>
            </div>
            <div className={`grid ${featuredCols} auto-rows-fr gap-3 flex-1 min-h-0`}>
              {featuredStreams.map((f) => {
                const cached = usersById[f.userId];
                const recipient = !cached
                  ? channel.recipients?.find((r) => r.id === f.userId)
                  : null;
                const u = cached ?? recipient ?? null;
                const label = u?.displayName ?? u?.username ?? f.userId.slice(-5);
                const isSelf = f.userId === user?.id;
                const p = participants.find((pt) => pt.userId === f.userId);
                return (
                  <FeaturedTile
                    key={f.trackSid}
                    track={f}
                    kind={f.kind}
                    label={label}
                    speaking={speakers.has(f.userId)}
                    muted={p?.selfMute ?? false}
                    deaf={p?.selfDeaf ?? false}
                    isSelf={isSelf}
                    // Self can't close their own preview here — they
                    // toggle camera/screen from the controls bar. Other
                    // users' streams get an X to stop viewing without
                    // leaving voice.
                    onClose={isSelf ? undefined : () => stopViewing(f.trackSid)}
                  />
                );
              })}
            </div>
            {!theater && (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 shrink-0">
                {participants.map((p, i) => {
                  const cached = usersById[p.userId];
                  const recipient = !cached
                    ? channel.recipients?.find((r) => r.id === p.userId)
                    : null;
                  const u = cached ?? recipient ?? null;
                  const label = u?.displayName ?? u?.username ?? p.userId.slice(-5);
                  /* Apply the same drift animation as the arena
                     view's seats, but inside the grid cell — the
                     grid keeps the cells anchored at their layout
                     positions, and the drift just nudges each
                     avatar inside its cell. Subtle but it makes
                     the strip feel alive. */
                  const driftClass = i % 2 === 0 ? 'zk-drift-a' : 'zk-drift-b';
                  const driftDelay = `-${(i * 1.7) % 12}s`;
                  return (
                    <div
                      key={p.userId}
                      className={driftClass}
                      style={{ animationDelay: driftDelay }}
                    >
                      <ParticipantTile
                        userId={p.userId}
                        label={label}
                        avatarUrl={u?.avatarUrl}
                        speaking={speakers.has(p.userId)}
                        muted={p.selfMute}
                        deaf={p.selfDeaf}
                        compact
                        isSelf={p.userId === user?.id}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          /* No streams: spatial arena. Each participant gets a
             deterministic position on a ring around the center plus
             a per-tile drift animation with randomized phase offset
             so they orbit independently. The rings behind them
             rotate slowly in opposite directions. Matches the
             Zekktris voice-scene mockup's "seats around a center
             beacon" composition. */
          <div className="flex-1 min-h-0 relative overflow-hidden bg-black">
            {/* Deep-space starfield (native parity) — a faint, stable layer
                behind everything so the arena reads as space, not flat dark.
                Sits on a pitch-black base (bg-black) to match the native
                voice arena's `Color.black`, so the app-wide aurora/abyss
                doesn't tint the call screen. */}
            <ArenaStarfield />

            {/* Plasma core glow — soft radial bloom at center.
                Sized as a square aspect via aspect-ratio so it
                scales with viewport, not stretched. */}
            <div
              className="absolute pointer-events-none rounded-full opacity-60"
              style={{
                top: '50%',
                left: '50%',
                width: 'min(38vh, 38vw)',
                height: 'min(38vh, 38vw)',
                transform: 'translate(-50%, -50%)',
                background:
                  'radial-gradient(circle, var(--accent-glow) 0%, transparent 65%)',
                filter: 'blur(36px)',
              }}
              aria-hidden
            />

            {/* Concentric rings, slowly rotating. Two of the three
                rotate in opposite directions for a subtle parallax. */}
            {[
              { r: 0.78, cls: 'zk-arena-spin', op: 0.22 },
              { r: 0.55, cls: 'zk-arena-spin-reverse', op: 0.30 },
              { r: 0.32, cls: 'zk-arena-spin', op: 0.38 },
            ].map((ring, i) => (
              <div
                key={i}
                className={`absolute pointer-events-none rounded-full border ${ring.cls}`}
                style={{
                  top: '50%',
                  left: '50%',
                  width: `min(${ring.r * 90}vh, ${ring.r * 90}vw)`,
                  height: `min(${ring.r * 90}vh, ${ring.r * 90}vw)`,
                  borderColor: 'var(--zk-line-soft, var(--zk-line))',
                  opacity: ring.op,
                  /* Dashed inner ring + solid outer reads like
                     concentric orbits in the mockup. */
                  borderStyle: i === 1 ? 'dashed' : 'solid',
                }}
                aria-hidden
              />
            ))}

            {/* Central black hole. Same anchor point for the orbit; a small
                singularity participants visibly fall into when they leave.
                Layers (native parity, VoiceView↔BlackHoleView): outer glow
                halo, the accretion disk spinning on conic-gradient colors,
                and the pitch-black event horizon at the core. 22px + 6s spin
                to match the native BlackHoleView exactly. */}
            <div
              className="absolute pointer-events-none"
              style={{
                top: '50%',
                left: '50%',
                width: 22,
                height: 22,
                transform: 'translate(-50%, -50%)',
              }}
              aria-hidden
            >
              {/* Outer glow halo. Large soft shadow radiating violet
                  + cyan — Zekktris brand accents (matches the speaking
                  indicators elsewhere). */}
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  boxShadow:
                    '0 0 24px 6px rgba(157, 123, 255, 0.55), 0 0 12px 3px rgba(61, 215, 236, 0.4)',
                }}
              />
              {/* Accretion disk. Conic gradient swirls through cool
                  alien-tech tones (indigo → violet → blue → cyan →
                  light purple → indigo) and rotates fast via
                  zk-blackhole-disk. */}
              <div
                className="absolute inset-0 rounded-full zk-blackhole-disk"
                style={{
                  background:
                    'conic-gradient(from 0deg, var(--accent-2), var(--accent-2), var(--accent), var(--accent), var(--accent-3), var(--accent-2))',
                }}
              />
              {/* Event horizon: pitch-black core. Sized slightly
                  inside the disk so a thin ring of disk color is
                  always visible around the singularity. */}
              <div
                className="absolute rounded-full bg-black"
                style={{ inset: 4 }}
              />
            </div>

            {/* Seats. Each absolutely positioned on a ring; the
                orbit container slowly rotates them around the arena
                center while each seat counter-rotates internally so
                the avatar + label stay upright. Static relative
                positions mean seats never touch.

                The OUTER wrapper applies a uniform `transform:
                scale(...)` based on participant count — when the
                constellation would otherwise clip the arena bounds
                (typically 6+ users), the whole thing shrinks
                proportionally so positions AND seat sizes scale
                together. Scaling positions alone would compress the
                radial gaps below seat width and adjacent tiers
                would overlap; uniform CSS scale avoids that.

                The wrapper is OUTSIDE zk-orbit because zk-orbit's
                animation owns its own transform (rotate). Mixing an
                inline style transform on the same element would
                fight the animation; nesting them is the standard
                CSS-transform-composition pattern. */}
            <div
              className="absolute inset-0 transition-transform duration-[1200ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
              style={{ transform: `scale(${arenaScale(participants.length)})` }}
            >
              <div className="absolute inset-0 zk-orbit">
                {participants.map((p, i) => {
                  // Resolve user info from the global cache first; fall
                  // back to the channel's recipients list (always
                  // populated on DM channels). Without this fallback,
                  // joining a DM call from a profile card or friends
                  // page can surface participants as "few numbers" of
                  // their snowflake ID — the cache hadn't been
                  // populated yet because no message had been loaded.
                  const cached = usersById[p.userId];
                  const recipient = !cached
                    ? channel.recipients?.find((r) => r.id === p.userId)
                    : null;
                  const u = cached ?? recipient ?? null;
                  const label = u?.displayName ?? u?.username ?? p.userId.slice(-5);
                  const pos = arenaPosition(i, participants.length);
                  const isMe = p.userId === user?.id;
                  // While this user's "hangup" is in flight, render
                  // their tile inside the swallow keyframe wrapper so
                  // they see themselves drawn into the black hole
                  // before the call actually disconnects. Other tiles
                  // are untouched.
                  const swallowing = isMe && selfHangingUp;
                  return (
                    <div
                      key={p.userId}
                      className={`absolute zk-arena-slot transition-[left,top] duration-[1200ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
                        swallowing ? 'zk-blackhole-swallow' : ''
                      }`}
                      style={{
                        left: `${pos.x}%`,
                        top: `${pos.y}%`,
                        transform: 'translate(-50%, -50%)',
                      }}
                    >
                      <div className="zk-orbit-counter">
                        <ParticipantTile
                          userId={p.userId}
                          label={label}
                          avatarUrl={u?.avatarUrl}
                          speaking={speakers.has(p.userId)}
                          muted={p.selfMute}
                          deaf={p.selfDeaf}
                          isSelf={isMe}
                          unwatchedStreams={unwatchedByUser.get(p.userId)}
                          onJoinStream={startViewing}
                        />
                      </div>
                    </div>
                  );
                })}

                {/* Leaving participants — being swallowed into the
                    black hole. Rendered inside zk-orbit so they
                    continue to orbit while falling in (preserves
                    visual continuity with their position before
                    leaving). zk-orbit-counter keeps the avatar
                    upright during the descent. The CSS animation
                    interpolates left/top from their last orbital
                    position to dead-center, with scale collapsing
                    and rotation winding up to suggest tidal
                    stretching as they cross the event horizon. */}
                {Array.from(leaving.values()).map((leaver) => {
                  const u = usersById[leaver.userId];
                  const label =
                    u?.displayName ?? u?.username ?? leaver.userId.slice(-5);
                  return (
                    <div
                      key={`leaving-${leaver.userId}`}
                      className="absolute zk-arena-slot zk-blackhole-swallow"
                      style={
                        {
                          '--from-x': `${leaver.x}%`,
                          '--from-y': `${leaver.y}%`,
                        } as React.CSSProperties
                      }
                    >
                      <div className="zk-orbit-counter">
                        <ParticipantTile
                          userId={leaver.userId}
                          label={label}
                          avatarUrl={u?.avatarUrl}
                          speaking={false}
                          muted={false}
                          deaf={false}
                          isSelf={false}
                          hideName
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating controls — sit centered above the bottom of the
          viewport instead of a solid bar across the whole width.
          Rounded pill with a backdrop-blur background so content
          scrolling underneath stays partly visible (modern call-app
          aesthetic — Discord, FaceTime, Zoom all use floated
          controls). The participant grid above gets extra bottom
          padding (pb-24/pb-28) so tiles don't clip behind the pill.
          Mobile bottom padding honors the iOS home-indicator safe
          area in the same way the previous docked bar did. */}
      <div
        className="absolute left-1/2 -translate-x-1/2 z-20"
        style={{
          bottom: 'max(calc(env(safe-area-inset-bottom) + 0.75rem), 1rem)',
        }}
      >
        {inThis ? (
          <div className="flex items-center justify-center gap-2 px-3 py-2 rounded-full bg-bg-2/90 backdrop-blur-md border border-line shadow-xl">
            <ControlButton
              active={!myVoice?.selfMute}
              activeIcon={<Mic size={16} />}
              inactiveIcon={<MicOff size={16} />}
              activeLabel="Mute"
              inactiveLabel="Unmute"
              onClick={toggleMute}
            />
            <ControlButton
              active={!deafened}
              activeIcon={<Headphones size={16} />}
              inactiveIcon={<HeadphonesOff size={16} />}
              activeLabel="Deafen"
              inactiveLabel="Undeafen"
              onClick={toggleDeafen}
            />
            <ControlButton
              active={!cameraOn}
              activeIcon={<VideoOff size={16} />}
              inactiveIcon={<Video size={16} />}
              activeLabel="Turn on camera"
              inactiveLabel="Turn off camera"
              onClick={toggleCamera}
              disabled={videoRestricted}
              disabledTitle="Video is restricted by your parent"
            />
            <ControlButton
              active={!screenOn}
              activeIcon={<ScreenShare size={16} />}
              inactiveIcon={<ScreenShare size={16} />}
              activeLabel="Share screen"
              inactiveLabel="Stop sharing"
              onClick={toggleScreenShare}
              danger={screenOn}
              disabled={streamRestricted}
              disabledTitle="Screen sharing is restricted by your parent"
            />
            <MasterVolumeControl />
            <button
              onClick={() => void leave()}
              className="ml-2 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#ED4245] hover:bg-[#C53639] text-white text-sm font-semibold shadow-md hover:shadow-lg active:translate-y-px transition-all"
              aria-label="Leave call"
              title="Leave call"
            >
              <PhoneOff size={16} />
              <span>Leave</span>
            </button>
          </div>
        ) : (
          <button
            onClick={() => void joinThis()}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium shadow-xl"
          >
            <Volume2 size={14} />
            <span>Join Voice</span>
          </button>
        )}
      </div>
    </>
  );

  // Suppress unused-warning on navigate (kept as future leave-redirect target).
  void navigate;
}

// ── Tile components ─────────────────────────────────────────────────────────

/**
 * Audio-only participant tile. Renders an avatar + name + mute/deaf
 * badges. Two display modes:
 *
 *   - default: full square/16:9 tile in the no-video grid layout
 *   - compact: small horizontal tile at the bottom of the layout when
 *     there's a featured video area above. The avatar shrinks and the
 *     name moves below so participants fit a one-row strip.
 *
 * No video here — when a participant turns on camera or screen, they
 * graduate to FeaturedTile and disappear from the audio grid.
 */
/**
 * Visual speaking indicator: scrolling sine wave. Imported from
 * the shared lib so the channel list, the arena, and any other
 * surface render the identical wave visual. See `lib/AlienWave.tsx`
 * for the markup + the CSS class hookup in index.css.
 */

// Memoized so a single speaker transition (the speakers Set is replaced on
// every probe tick) re-renders ONLY the tile whose `speaking` actually changed,
// not all N tiles. Relies on its props being stable when unchanged (primitives;
// onJoinStream is useCallback'd; unwatchedStreams is a memoized per-user array).
const ParticipantTile = memo(function ParticipantTile({
  userId,
  label,
  speaking,
  muted,
  deaf,
  isSelf,
  compact,
  avatarUrl,
  hideName,
  unwatchedStreams,
  onJoinStream,
}: {
  userId: string;
  label: string;
  speaking: boolean;
  muted: boolean;
  deaf: boolean;
  isSelf?: boolean;
  /** When true, render as a small dock-style tile at the bottom rather
      than a full grid cell. Used when a featured video area is present. */
  compact?: boolean;
  /** Profile avatar URL. Renders on top of the initials circle when
      present (AvatarImage hides itself on load failure so initials
      remain the fallback). */
  avatarUrl?: string | null;
  /** Suppress the name label below the avatar. Used by the
      black-hole-swallow render so the avatar falls in without a
      trailing label — the name shouldn't visibly get consumed
      alongside the user; the avatar alone tells the story. */
  hideName?: boolean;
  /** Streams this participant is publishing that the local viewer
   *  hasn't started watching yet. Renders as small "Join stream"
   *  link(s) under the name, one per stream. Per user direction:
   *  inline opt-in under the name rather than a separate card. */
  unwatchedStreams?: VoiceTrackInfo[];
  /** Callback invoked with a trackSid when the user taps the
   *  inline "Join stream" link. VoiceView's startViewing handler
   *  adds the sid to its viewing set, which mounts the FeaturedTile. */
  onJoinStream?: (trackSid: string) => void;
}) {
  const tone = avatarColor(userId);
  const initials = avatarInitials(label);
  // Per-user volume popover anchored to the tile. We don't render
  // it for self — you can't locally mute yourself, that's what the
  // mic button is for. The popover position is computed once on
  // open (top-of-tile, viewport-clamped) and held until close.
  const [popoverAnchor, setPopoverAnchor] = useState<{ x: number; y: number } | null>(null);
  // Subscribe to the local mute state for THIS user so the badge
  // updates immediately when the listener toggles it via the
  // popover. useSyncExternalStore avoids the resubscribe-storm of
  // useEffect + useState for shared module state.
  const localPrefs = useSyncExternalStore(
    subscribeVoicePrefs,
    () => getUserPrefs(userId),
    () => getUserPrefs(userId),
  );
  const locallyMuted = !isSelf && localPrefs.muted;

  function openPopover(e: React.MouseEvent<HTMLElement>) {
    if (isSelf) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    // Anchor the popover above the tile — bottom-aligned to the
    // tile's top edge — so it doesn't get cut off by the controls
    // bar at the bottom of the viewport. The popover itself
    // applies the bottom-up translate.
    setPopoverAnchor({ x: rect.left + rect.width / 2, y: rect.top });
  }

  // Speaking visual: a ring overlays the avatar via the SpeakingRing
  // component (absolute-positioned in the JSX below). The avatar div
  // itself stays visually plain (no static ring color, no shadow) so the
  // ring does all the work and clicking still works through it (pointer-
  // events: none on the SVG overlay).

  const tileContent = compact ? (
    /* Compact: pure-circle avatar with name underneath. No
       surrounding card — the circle itself IS the tile. Used in the
       bottom strip when a stream/camera is featured, where the
       circles read as the Zekktris voice scene's seat array (just
       linearly arranged rather than spatially positioned, since
       we don't have positional metadata from LiveKit). Mobile sizes
       at 40×40 so the strip stays out of the way of the featured
       stream; tablet+ goes 56×56 for the more spacious treatment. */
    <div className="relative flex flex-col items-center gap-1 sm:gap-1.5 w-full">
      <div className="relative w-7 h-7 sm:w-10 sm:h-10">
        {/* Speaking indicator: brand-gradient ring BEHIND the avatar,
            peeking out past the edges via negative inset. Rendered
            first in DOM + avatar marked `relative` so the avatar
            stacks above the ring (same pattern as the channel rail).
            pointer-events:none so it never intercepts the avatar's
            click (mute-locally popover). */}
        {speaking && <SpeakingRing inset={3} />}
        <div
          className={`relative w-full h-full rounded-full text-sm sm:text-base font-bold flex items-center justify-center overflow-hidden ${tone}`}
        >
          <span>{initials}</span>
          <AvatarImage src={avatarUrl} />
        </div>
        {/* Voice status badge. Deafen implies mute (deafening couples
            mute on), so show a single badge with deafen taking
            precedence — never both. */}
        {(muted || deaf) && (
          <span
            className="absolute -bottom-1 -right-1 bg-red-500 text-white p-0.5 rounded-full ring-2 ring-bg-1"
            aria-label={deaf ? 'Deafened' : 'Muted'}
            title={deaf ? 'Deafened' : 'Muted'}
          >
            {deaf ? <HeadphonesOff size={10} /> : <MicOff size={10} />}
          </span>
        )}
        {locallyMuted && (
          <span
            className="absolute -top-1 -left-1 bg-amber-500/90 text-white p-0.5 rounded-full ring-2 ring-bg-1"
            title="Muted for you only"
            aria-label="Muted for you only"
          >
            <VolumeXIcon size={10} />
          </span>
        )}
      </div>
      {!hideName && (
        <span className="text-[0.65rem] sm:text-[0.7rem] text-ink-2 truncate max-w-full leading-tight px-1">
          {label}
        </span>
      )}
    </div>
  ) : (
    /* Full grid: same circular treatment scaled up. The wrapping
       div centers the circle and reserves space for the name label
       underneath, no surrounding card. Larger halo (ring-4 +
       brighter shadow) since the circle has more space to breathe
       at full size. Three breakpoints so the mobile experience is
       roughly half-size (~56px circles) while tablets get 96px and
       laptops/desktops get 112px. The label gap tightens at small
       sizes too so the tile doesn't look bottom-heavy. */
    <div className="relative flex flex-col items-center justify-center gap-1.5 sm:gap-2.5 w-full">
      <div
        className="relative"
        style={{
          // Auto-resize with the application window size rather than
          // fixed viewport breakpoints, so a single participant in a
          // small window doesn't get an oversized circle. vmin tracks
          // the smaller window dimension; clamped to a sane range.
          // ~30% smaller than before so the black-hole disk dominates.
          width: 'clamp(2.5rem, 7.7vmin, 4.9rem)',
          height: 'clamp(2.5rem, 7.7vmin, 4.9rem)',
        }}
      >
        {/* Speaking indicator: brand-gradient ring BEHIND the avatar.
            Rendered first + avatar marked `relative` so the avatar
            stacks on top (matches the channel rail). The ring's
            negative inset makes it peek out around the edge.
            pointer-events:none so it doesn't block the avatar click. */}
        {speaking && <SpeakingRing inset={4} />}
        <div
          className={`relative w-full h-full rounded-full text-lg sm:text-2xl md:text-3xl font-bold flex items-center justify-center overflow-hidden ${tone}`}
        >
          <span>{initials}</span>
          <AvatarImage src={avatarUrl} />
        </div>
        {(muted || deaf) && (
          <span
            className="absolute bottom-0 right-0 bg-red-500 text-white p-0.5 sm:p-1 rounded-full ring-2 ring-bg-1"
            aria-label={deaf ? 'Deafened' : 'Muted'}
            title={deaf ? 'Deafened' : 'Muted'}
          >
            {deaf ? <HeadphonesOff size={10} /> : <MicOff size={10} />}
          </span>
        )}
        {locallyMuted && (
          <span
            className="absolute top-0 left-0 bg-amber-500/90 text-white p-0.5 sm:p-1 rounded-full ring-2 ring-bg-1"
            title="Muted for you only"
            aria-label="Muted for you only"
          >
            <VolumeXIcon size={10} />
          </span>
        )}
      </div>
      {!hideName && (
        <span className="text-[0.7rem] sm:text-sm text-ink-1 truncate max-w-full leading-tight text-center">
          {label}
        </span>
      )}
      {/* Inline "View Webcam" / "Join Stream" affordances. One
          button per unwatched stream from this participant —
          labeled with the kind so the viewer knows what they're
          opting into. Clicking does NOT open the volume popover
          (stopPropagation in the handler) so the two interactions
          remain distinct.

          Defensive isSelf guard: offeredStreams already filters out
          the local user's streams, but if any edge case (auth state
          transition, userId format mismatch) leaked one through, we
          shouldn't render a "view yourself" affordance anyway. */}
      {!isSelf && unwatchedStreams && unwatchedStreams.length > 0 && onJoinStream && (
        <div className="flex flex-col gap-0 -mt-1">
          {unwatchedStreams.map((s) => (
            <button
              key={s.trackSid}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onJoinStream(s.trackSid);
              }}
              className="text-[0.6rem] sm:text-[0.65rem] text-accent hover:text-accent/80 hover:underline leading-none px-1 py-0.5 rounded transition-colors flex items-center gap-1 justify-center"
              title={`View ${label}'s ${s.kind === 'screen' ? 'stream' : 'webcam'}`}
            >
              {s.kind === 'screen' ? <ScreenShare size={10} /> : <Video size={10} />}
              <span>{s.kind === 'screen' ? 'Join Stream' : 'View Webcam'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // Self tiles can't open the popover — render them as a plain div
  // so they're not focusable / clickable.
  if (isSelf) return tileContent;

  return (
    <>
      <button
        type="button"
        onClick={openPopover}
        onContextMenu={openPopover}
        title="Adjust volume"
        aria-label={`Adjust volume for ${label}`}
        className={
          compact
            ? 'block w-full h-full text-left'
            : 'block w-full h-full text-left'
        }
      >
        {tileContent}
      </button>
      {popoverAnchor && (
        <UserVolumePopover
          userId={userId}
          label={label}
          anchor={popoverAnchor}
          onClose={() => setPopoverAnchor(null)}
        />
      )}
    </>
  );
});

/** Muted-speaker icon. File-scoped helper used by participant-tile
    locally-muted badges and the master volume control. Same shape
    as the one in lib/UserVolumePopover (kept duplicated since each
    module wants it for unrelated reasons; the icon is tiny). */
function VolumeXIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

/** Master output volume button + popover. Lives in the controls bar
    so it's reachable while in a call. The slider multiplies onto
    every remote participant's gain after their per-user setting
    (so a user at 80% with master at 150% comes through at 120%). */
function MasterVolumeControl() {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const masterVolume = useSyncExternalStore(
    subscribeVoicePrefs,
    () => getVoicePrefs().masterVolume,
    () => getVoicePrefs().masterVolume,
  );
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left + rect.width / 2, y: rect.top });
        }}
        title={`Output volume — ${Math.round(masterVolume * 100)}%`}
        className="w-10 h-10 flex items-center justify-center rounded-full transition-colors bg-bg-3 text-ink-2 hover:text-ink-1 hover:bg-bg-3/70"
      >
        <Volume2 size={16} />
      </button>
      {anchor && (
        <MasterVolumePopover anchor={anchor} onClose={() => setAnchor(null)} />
      )}
    </>
  );
}

function MasterVolumePopover({
  anchor,
  onClose,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const masterVolume = useSyncExternalStore(
    subscribeVoicePrefs,
    () => getVoicePrefs().masterVolume,
    () => getVoicePrefs().masterVolume,
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const PANEL_W = 240;
  const VIEWPORT_PAD = 8;
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1024;
  let x = anchor.x - PANEL_W / 2;
  if (x < VIEWPORT_PAD) x = VIEWPORT_PAD;
  if (x + PANEL_W > winW - VIEWPORT_PAD) x = winW - PANEL_W - VIEWPORT_PAD;
  const y = anchor.y - 8;

  return (
    <Portal>
      <div
        ref={ref}
        className="fixed z-50 bg-bg-1 border border-line rounded-lg shadow-xl p-3 elevation-pop"
        style={{
          width: PANEL_W,
          left: x,
          top: y,
          transform: 'translateY(-100%)',
        }}
      >
        <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
          Output volume
        </div>
        <div className="flex items-center gap-2 mb-1">
          <VolumeXIcon size={12} className="text-ink-3 shrink-0" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(Math.min(1, masterVolume) * 100)}
            onChange={(e) => setMasterVolume(Number(e.target.value) / 100)}
            className="flex-1 accent-accent"
          />
          <Volume2 size={12} className="text-ink-3 shrink-0" />
        </div>
        <div className="flex items-center justify-between text-[0.65rem] text-ink-3 tabular-nums">
          <span>{Math.round(Math.min(1, masterVolume) * 100)}%</span>
          <button
            type="button"
            onClick={() => setMasterVolume(1)}
            className="text-ink-3 hover:text-ink-1"
          >
            Reset
          </button>
        </div>
        <p className="text-[0.65rem] text-ink-3 mt-2 leading-snug">
          Applies on top of each user's individual volume. Click a participant
          tile to adjust one user at a time.
        </p>
      </div>
    </Portal>
  );
}

/**
 * FeaturedTile — a single user's expanded tile when they have video on.
 * Replaces the previous separate ScreenTile + duplicated avatar tile.
 *
 * Renders the video with `object-contain` (NOT cover) so the full
 * desktop/window/camera frame is visible without cropping. The
 * background is black so any letterboxing reads as intentional rather
 * than as broken layout. Click → native fullscreen on the <video>.
 *
 * Mute / deaf / speaking indicators sit on top of the video so they
 * remain visible without occluding much. Same overlay treatment as
 * ParticipantTile, just laid out for a larger frame.
 */
function FeaturedTile({
  track,
  kind,
  label,
  speaking,
  muted,
  deaf,
  onClose,
}: {
  track: VoiceTrackInfo;
  kind: 'screen' | 'camera';
  label: string;
  speaking: boolean;
  muted: boolean;
  deaf: boolean;
  isSelf?: boolean;
  /** When set, renders a small X button on the tile that calls this
   *  on click. Used by viewers to stop watching a remote stream
   *  without leaving the call. Local previews (your own camera/screen)
   *  don't pass this — the camera/screen toggles in the controls bar
   *  are the canonical way to end your own stream. */
  onClose?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Track whether the underlying MediaStreamTrack is actually
  // producing frames. When the local user disables their camera
  // mid-call, LiveKit may surface that as a `mute` event on the
  // track (rather than unpublishing), and the <video> element
  // retains the last frame OR shows black until something else
  // changes. We listen for mute/unmute/ended and swap to an avatar
  // fallback when the track isn't live so the tile reverts to the
  // user's identity card instead of staring back as a black box.
  const [trackLive, setTrackLive] = useState(
    () => track.track.readyState === 'live' && !track.track.muted,
  );
  useEffect(() => {
    const t = track.track;
    function update() {
      setTrackLive(t.readyState === 'live' && !t.muted);
    }
    update();
    t.addEventListener('mute', update);
    t.addEventListener('unmute', update);
    t.addEventListener('ended', update);
    return () => {
      t.removeEventListener('mute', update);
      t.removeEventListener('unmute', update);
      t.removeEventListener('ended', update);
    };
  }, [track.track]);

  // First-frame loading state. Tile renders with a loading overlay
  // immediately on mount; the overlay fades when the video element
  // signals 'loadeddata' (first frame decoded) — typically within
  // 200-500ms with adaptiveStream disabled. The fallback timer
  // hides the overlay after 5s regardless, so we never spin forever
  // if the stream is stalled.
  const [loadingFirstFrame, setLoadingFirstFrame] = useState(true);
  useEffect(() => {
    setLoadingFirstFrame(true);
    const fallback = window.setTimeout(() => setLoadingFirstFrame(false), 5000);
    return () => clearTimeout(fallback);
  }, [track.track]);

  function goFullscreen() {
    const v = videoRef.current;
    if (!v) return;
    const reqFs =
      v.requestFullscreen ||
      (v as unknown as { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen ||
      (v as unknown as { mozRequestFullScreen?: () => Promise<void> }).mozRequestFullScreen;
    if (reqFs) void reqFs.call(v).catch(() => {});
  }

  return (
    <div
      className="relative bg-black rounded-lg overflow-hidden border-2 border-line cursor-zoom-in group/feat min-h-0"
      onClick={goFullscreen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goFullscreen();
        }
      }}
    >
      {/* Speaking indicator: brand-gradient glow border on the tile
          when this participant is talking. A ring doesn't suit the
          rectangular video tile, so we pulse a cyan/violet box-shadow
          + inset border in the same palette as the avatar
          SpeakingRing — keeping the speaking signal visually
          consistent across the whole voice scene. */}
      {speaking && (
        <div
          className="absolute inset-0 pointer-events-none z-10 rounded-lg zk-speaking-glow"
          aria-hidden
        />
      )}
      {trackLive ? (
        <VideoElement
          track={track.track}
          videoRef={videoRef}
          fit="contain"
          onFirstFrame={() => setLoadingFirstFrame(false)}
        />
      ) : (
        // Track not live (camera disabled, screen share ended,
        // remote participant muted their video). Render a centered
        // avatar so the tile feels like the user, not a void. Same
        // tone palette as the audio-only ParticipantTile so the
        // visual identity stays consistent across the two states.
        <div className="absolute inset-0 flex items-center justify-center bg-bg-2">
          <div
            className={`w-24 h-24 rounded-full flex items-center justify-center text-2xl font-semibold ${avatarColor(
              track.userId,
            )}`}
          >
            {avatarInitials(label)}
          </div>
        </div>
      )}
      {/* Loading overlay — shown until the first frame decodes. The
          tile mounts instantly when the user clicks "View Webcam" /
          "Join Stream"; this prevents the perception of "I clicked
          and nothing happened" during the brief gap between mount
          and first-frame decode (typically 200-500ms). Auto-hides
          after 5s regardless via the fallback timer in state. */}
      {trackLive && loadingFirstFrame && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 pointer-events-none z-[5]">
          <div className="flex items-center gap-2 text-white text-sm">
            <div className="w-3 h-3 rounded-full bg-white/80 animate-pulse" />
            <span>Loading…</span>
          </div>
        </div>
      )}

      {/* Top-left badge identifying who's sharing and the kind. */}
      <div className="absolute top-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded flex items-center gap-1.5 pointer-events-none">
        {kind === 'screen' ? <ScreenShare size={12} /> : <Video size={12} />}
        <span className="truncate max-w-[12rem]">
          {label}
          {kind === 'screen' ? "'s screen" : ''}
        </span>
      </div>

      {/* Bottom-right status badge — deafen implies mute, so show one
          badge with deafen taking precedence (never both). */}
      {(muted || deaf) && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1 pointer-events-none">
          <span
            className="bg-red-500/80 text-white p-1 rounded-full"
            aria-label={deaf ? 'Deafened' : 'Muted'}
            title={deaf ? 'Deafened' : 'Muted'}
          >
            {deaf ? <HeadphonesOff size={10} /> : <MicOff size={10} />}
          </span>
        </div>
      )}

      {/* Click-for-fullscreen hint, fades in on hover only. */}
      <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded opacity-0 group-hover/feat:opacity-100 transition-opacity pointer-events-none">
        Click for fullscreen
      </div>

      {/* Stop-viewing button. Renders only for remote streams (onClose
          supplied) — local previews don't get one since the
          camera/screen toggle in the bottom controls bar is the
          canonical way to end your own stream. The button's click
          stops propagation so it doesn't trigger the tile's
          fullscreen handler. */}
      {onClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="absolute top-2 right-2 bg-black/60 text-white hover:bg-black/80 rounded-full w-7 h-7 flex items-center justify-center z-10 transition-colors"
          aria-label="Stop viewing"
          title="Stop viewing"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * Attach a MediaStreamTrack to a <video> element. We use a ref +
 * useEffect rather than `srcObject={...}` because React doesn't have
 * a built-in serializer for MediaStream and would warn about the
 * non-attribute prop. The effect re-runs if the track changes.
 *
 * `playsInline` is needed for iOS Safari (otherwise tapping the video
 * triggers fullscreen). `muted` on the video element doesn't mute
 * the audio in the room — it just prevents echo from the local self
 * preview, which is the standard pattern.
 */
function VideoElement({
  track,
  videoRef,
  fit = 'cover',
  onFirstFrame,
}: {
  track: MediaStreamTrack;
  videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
  /** `cover` (default) crops to fill — fine for cameras that we want
      to fit a tile snugly. `contain` letterboxes — required for
      screenshares so the user sees the entire shared frame without
      cropping the edges off. */
  fit?: 'cover' | 'contain';
  /** Fired once the video element has decoded its first frame.
   *  Used by FeaturedTile to hide its loading overlay. */
  onFirstFrame?: () => void;
}) {
  const ref = (el: HTMLVideoElement | null) => {
    if (videoRef) videoRef.current = el;
    if (!el) return;
    const tagged = el as HTMLVideoElement & { __t?: MediaStreamTrack };
    if (tagged.__t === track) return;
    const stream = new MediaStream([track]);
    el.srcObject = stream;
    tagged.__t = track;
    // Attach a one-shot 'loadeddata' listener — fires after the
    // first frame decodes, signaling that the video is actually
    // showing content. FeaturedTile uses this to hide its loading
    // overlay. Once-only so we don't fire on every metadata
    // refresh (e.g. resolution change on adaptive bitrate).
    if (onFirstFrame) {
      el.addEventListener('loadeddata', onFirstFrame, { once: true });
    }
    void el.play().catch(() => {
      // Autoplay can fail; UI shows the still frame anyway.
    });
  };
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`w-full h-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
    />
  );
}

// ── External-store hooks ────────────────────────────────────────────────────

function useSpeakers(): Set<string> {
  return useSyncExternalStore(
    subscribeSpeakers,
    () => getCurrentSpeakers(),
    () => new Set<string>(),
  );
}

function useTracks(): VoiceTrackInfo[] {
  return useSyncExternalStore(
    subscribeTracks,
    () => getCurrentTracks(),
    () => [],
  );
}

function useVoiceConnectionState(): VoiceConnectionState {
  return useSyncExternalStore(
    subscribeConnectionState,
    () => getConnectionState(),
    () => 'disconnected' as VoiceConnectionState,
  );
}

// ── Control button helper ───────────────────────────────────────────────────

function ControlButton({
  active,
  activeIcon,
  inactiveIcon,
  activeLabel,
  inactiveLabel,
  onClick,
  danger,
  disabled,
  disabledTitle,
}: {
  /** True when the feature is in its "default" / "available" state.
      e.g. for mic: active=true means unmuted (mic on, ready to speak). */
  active: boolean;
  activeIcon: React.ReactNode;
  inactiveIcon: React.ReactNode;
  activeLabel: string;
  inactiveLabel: string;
  onClick: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) void onClick();
      }}
      className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors ${
        disabled
          ? 'bg-bg-3/40 text-ink-3 opacity-50 cursor-not-allowed'
          : danger
            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            : active
              ? 'bg-bg-3 text-ink-2 hover:text-ink-1 hover:bg-bg-3/70'
              : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
      }`}
      aria-label={disabled ? disabledTitle : active ? activeLabel : inactiveLabel}
      title={disabled ? disabledTitle : active ? activeLabel : inactiveLabel}
    >
      {active ? activeIcon : inactiveIcon}
    </button>
  );
}

// Suppress "useEffect imported but unused" if we end up not using it
// in a future refactor; harmless and keeps the import block stable.
void useEffect;
