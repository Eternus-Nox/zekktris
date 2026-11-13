/**
 * Voice manager
 * -------------
 * Wraps a single LiveKit Room. Voice can only have one active Room at
 * a time per user, so a module-level singleton is the right shape — no
 * React context needed.
 *
 * Responsibilities split into three concerns:
 *
 *   1. Connection lifecycle (connectToVoice / disconnectVoice / setMicMuted)
 *      — owns the Room handle and dynamically loads livekit-client to
 *      keep the chunk out of the main bundle (LiveKit is ~130 KB gz).
 *
 *   2. Device selection (listAudioDevices / get/setSaved*DeviceId) —
 *      reads the user's preferred mic/speaker from localStorage and
 *      applies them on connect. Live-switching during a call (calling
 *      these while connected) immediately re-publishes on the new mic
 *      and routes audio through the new speaker.
 *
 *   3. Diagnostics — pre-flight getUserMedia BEFORE handing off to
 *      LiveKit so error messages are specific (browser permission vs
 *      OS-level block vs no device vs device in use), not the generic
 *      "could not establish session" that LiveKit wraps everything in.
 */

type RoomLike = {
  connect(url: string, token: string): Promise<unknown>;
  disconnect(): Promise<void>;
  state: string;
  localParticipant: {
    setMicrophoneEnabled(on: boolean, opts?: { deviceId?: string }): Promise<unknown>;
    // Both setters accept an opts bag whose `videoCaptureOptions`
    // (camera) or `resolution` field (screen share) tunes capture
    // quality. The Room's videoCaptureDefaults is the static default;
    // these per-call options let us switch quality between publishes
    // without reconnecting the Room.
    setCameraEnabled(on: boolean, opts?: VideoOpts, publishOpts?: VideoPublishOpts): Promise<unknown>;
    setScreenShareEnabled(on: boolean, opts?: ScreenOpts, publishOpts?: ScreenPublishOpts): Promise<unknown>;
    identity: string;
  };
  remoteParticipants: Map<string, unknown>;
  switchActiveDevice(kind: 'audioinput' | 'audiooutput' | 'videoinput', deviceId: string): Promise<unknown>;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  off(event: string, cb: (...args: unknown[]) => void): unknown;
};

/** Per-session bookkeeping stashed on the Room instance itself rather than
    at module scope. Each Room therefore owns — and can release — exactly
    its own timers and DOM sinks, which is what lets an orphan Room (one
    that lost an identity race and is no longer `room`) clean itself up
    without touching the live session's state. */
type RoomInternals = {
  _audioCleanup?: () => void;
  _reapplyGains?: () => void;
  _stalePoll?: number;
  _rttPoll?: number;
  _speakingPoll?: number;
};

/** Release everything a Room owns, without touching module state. Safe on a
    Room that never finished setup — every field is optional. */
function releaseRoomResources(r: RoomInternals): void {
  r._audioCleanup?.();
  if (typeof r._stalePoll === 'number') clearInterval(r._stalePoll);
  if (typeof r._rttPoll === 'number') clearInterval(r._rttPoll);
  if (typeof r._speakingPoll === 'number') clearInterval(r._speakingPoll);
}

interface VideoOpts {
  resolution?: { width: number; height: number; frameRate: number };
}
// Per-publish overrides (merged over the Room's publishDefaults). Used to give
// the CAMERA an H.264 codec without changing screen share (which stays VP8),
// and — for the non-'auto' camera tiers — a per-tier encoder budget so the
// camera isn't capped by publishDefaults.videoEncoding (which comes from the
// AUDIO quality preset and tops out at 1.5 Mbps — fine for 'auto', fatal
// for 1080p+).
interface VideoPublishOpts {
  videoCodec?: 'vp8' | 'h264' | 'vp9' | 'av1';
  videoEncoding?: { maxBitrate: number; maxFramerate?: number };
  // What the encoder sacrifices when it can't fund the target. Left unset,
  // livekit-client fills a HEIGHT-DEPENDENT default (getDefaultDegradationPreference):
  // >=1080 -> 'maintain-resolution', else 'balanced'. That threshold means our
  // tiers silently disagreed with each other — 720p adapted, 1080p+ refused to,
  // holding full resolution and cranking the quantizer until the picture went
  // to mush. Set it explicitly so it's a decision, not a side effect of a number.
  degradationPreference?: RTCDegradationPreference;
  // Type-only reference — erased at compile time, so the livekit-client
  // chunk stays dynamically imported. Values come from the loaded module.
  videoSimulcastLayers?: Array<import('livekit-client').VideoPreset>;
}
interface ScreenOpts {
  resolution?: { width: number; height: number; frameRate: number };
  audio?: boolean;
}
// Per-publish encoder budget for the screen track — merged over
// publishDefaults.screenShareEncoding (which is frozen at Room
// construction) so restarting the share re-applies the CURRENT tier +
// smooth-motion setting without leaving the call.
interface ScreenPublishOpts {
  screenShareEncoding?: { maxBitrate: number; maxFramerate?: number };
}

interface ConnectArgs {
  token: string;
  wsUrl: string;
  /** Optional — called when the connection state changes. */
  onStateChange?: (state: string) => void;
  /** Optional — the voice_states.session_id this device established
      via REST joinVoice. When provided, voice.ts records it as the
      "active" session for the takeover watcher. Pass it whenever
      you have the value from the join response; the consequence
      of omitting it is that takeover detection won't fire on this
      device (audio still works, you just don't auto-disconnect
      when another device joins from the same account). */
  sessionId?: string | null;
  /** Active-speakers callback — fires on every change with the current
      set of speaking user identities. Includes the local user when
      the local mic detects voice activity. */
  onSpeakersChange?: (speakers: Set<string>) => void;
  /** Called whenever a remote participant publishes/unpublishes a
      video or screen-share track. The callback receives the current
      list of media tiles to display. */
  onTracksChange?: (tracks: VoiceTrackInfo[]) => void;
  /** Whether this device should publish its microphone. Defaults to
      true. Pass false for listen-only joins (stage AUDIENCE, AFK /
      voice-disabled channels) whose server token has canPublish=false —
      LiveKit throws a 403 if we try to publish under such a token, so we
      skip the mic entirely and just subscribe. */
  publish?: boolean;
  /** Display title for the OS lock-screen / media controls "Now
      Playing" entry. Typically the other DM party's display name
      or the channel name. Omit to fall back to "Voice call". */
  backgroundTitle?: string;
  /** Channel id of the voice room. Threaded through for the self-move
      detector (so a moderator-initiated move reconnects this device)
      AND, for DM calls, used as the native CallKit call identifier.
      Pass it for EVERY join. */
  channelId?: string;
  /** True only for 1:1 DM calls. Gates the native CallKit registration
      — CallKit should model DM calls, not guild-voice/stage joins. */
  isDmCall?: boolean;
  /** End-to-end media encryption for a 1:1 DM call. Pass this ONLY
      for 1:1 DM calls whose DM has E2EE enabled (channel.e2eeEnabled
      === true). voice.ts looks up the locally-cached shared key for
      `channelId` — the same key the DM uses to encrypt messages — and
      keys the LiveKit media encryption with it, so both parties (who
      derived the identical key from the same password) can decrypt
      each other's audio/video.

      If no usable key is cached (the conversation isn't unlocked on
      this device, or the cached key is stale relative to `verifier`),
      connectToVoice rejects with VoiceError('e2ee_locked', …) instead
      of placing an unencrypted call the encrypted peer couldn't decode.
      Omit entirely for guild voice, stage, and group-DM calls — those
      have no shared passphrase and are never E2EE. */
  e2ee?: {
    /** The 1:1 DM channel whose cached shared key keys the call. */
    channelId: string;
    /** Current server-side key verifier for the DM (channel.e2eeVerifier).
        When provided, a cached key whose verifier no longer matches is
        treated as stale and the call is refused — guards against keying
        a call with a dead key after the DM was re-keyed. */
    verifier?: string | null;
  };
}

export interface VoiceTrackInfo {
  /** User id (LiveKit identity) of the publisher. */
  userId: string;
  /** Distinguishes camera from screenshare so the UI can label them. */
  kind: 'camera' | 'screen';
  /** The MediaStreamTrack to attach to a <video> element. */
  track: MediaStreamTrack;
  /** Stable LiveKit track sid for this publication. Used as a React
   *  key and as the identifier for per-stream view state (a user
   *  may have both camera and screen at once; sid disambiguates). */
  trackSid: string;
}

let room: RoomLike | null = null;
let livekitModule: Promise<typeof import('livekit-client')> | null = null;

/**
 * LiveKit's E2EE web worker for the currently-active encrypted call.
 * Created in connectToVoice when args.e2ee is set; null whenever the
 * active call is unencrypted (guild voice, group DM, or a DM with E2EE
 * off). Terminated on disconnect, on any connect failure, and before a
 * fresh call is set up — so we never leak a worker across calls. The
 * worker owns the media-frame crypto transforms; tearing it down with
 * the Room is required to free the OffscreenCanvas/Insertable-stream
 * machinery it holds.
 */
let e2eeWorker: Worker | null = null;

/** Terminate and forget the active E2EE worker, if any. Best-effort —
    a terminate() failure (already-dead worker) is harmless. */
function terminateE2eeWorker(): void {
  if (e2eeWorker) {
    try {
      e2eeWorker.terminate();
    } catch {
      // Worker already gone; nothing to release.
    }
    e2eeWorker = null;
  }
}

/**
 * The session id this device established when its current voice
 * connection started. Set by connectToVoice() if the caller passes
 * one; cleared by disconnectVoice(). Reads return null when this
 * device has no active voice connection — important so the
 * session-takeover watcher in Shell knows "I'm not the joiner; a
 * voice state I'm seeing in AppState is just informational, not a
 * sign that I've been kicked."
 *
 * Without this, the watcher would compare against the first session
 * id that appeared in AppState — which is often a stale value left
 * over from before a page refresh — and disconnect the user when
 * they legitimately rejoin and get a fresh session id from the
 * server. False positive == kicked off your own call.
 */
let activeSessionId: string | null = null;
/** Channel id of the currently-connected voice call. Set on
    connect, cleared on disconnect. Needed at disconnect time to
    tell CallKit which call to terminate — without it the system
    call UI would linger after our internal teardown. Set ONLY for
    DM calls (the only thing CallKit should model), independently of
    `connectedChannelId` below. */
let activeChannelId: string | null = null;

/** Channel id of the currently-connected voice room — set for EVERY
    join (guild voice, stage, DM), unlike `activeChannelId` which is
    DM-only. Drives the self-move detector. */
let connectedChannelId: string | null = null;

/**
 * Hang-up generation. Bumped by every user hang-up ([hangUpVoice]: a Leave /
 * Hang up / Cancel button, the 1:1 auto-end, the eviction teardown, the OS
 * media controls) and by nothing else — an internal teardown (a channel
 * switch, a moderator-move rejoin, a session takeover, a stage role change)
 * goes through [disconnectVoice] and leaves it alone, or a move would cancel
 * its own rejoin.
 *
 * Every join belongs to the generation current when it started (its claim,
 * or its connectToVoice call). A join whose generation is no longer current
 * was hung up: it unwinds with VoiceError('cancelled') at its next
 * checkpoint instead of finishing.
 */
let hangupGen = 0;

/**
 * Settles on the next user hang-up. A join races its open-ended waits
 * against it (the livekit-client chunk, and the getUserMedia probe, which
 * sits behind the browser's mic-permission prompt for as long as the user
 * leaves it open), so a Leave never queues behind a prompt the user no
 * longer cares about. Replaced by every hang-up, so it always stands for the
 * one still to come.
 */
let nextHangup = createHangupSignal();

function createHangupSignal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

/**
 * The Room performConnect is building: set the moment it is constructed,
 * cleared when that connect settles either way. Module `room` is assigned
 * only after `r.connect` resolves, so until then this is the ONLY handle on
 * it — and LiveKit's own cancel for a connecting Room is `Room.disconnect()`
 * on exactly this instance: it aborts the attempt and rejects the pending
 * connect, and during the mic publish it closes the engine under the
 * pending publish (which the join then stops waiting for: see
 * stopOrphanedMicCapture). [hangUpVoice] is its one caller.
 */
let connectingRoom: RoomLike | null = null;

/** Channels we are ABOUT to join, each claimed before its REST joinVoice
    call and released when that join settles either way — mapped to the
    hang-up generation current at the claim, so a hang-up pressed while that
    REST call is still out (before connectToVoice is even called) cancels
    the join too.
 *
 *  Keyed by channel, not a single slot: two joins can legitimately overlap
 *  (a mis-click then a correction, or a caller racing the self-move
 *  detector's own rejoin). With one slot, whichever join finished first
 *  cleared the other's claim, and the survivor's own echo then looked
 *  like a moderator drag — the exact failure the claim exists to
 *  prevent. Keying by channel makes releases idempotent and
 *  order-independent, so no caller can revoke another's intent. */
const pendingChannels = new Map<string, number>();

export function getActiveVoiceSessionId(): string | null {
  return activeSessionId;
}

/**
 * Declare the channel this device is joining, BEFORE the REST join.
 *
 * The server dispatches the gateway VOICE_STATE_UPDATE from inside the
 * join handler, before that HTTP response has even been written — so our
 * own echo routinely arrives before connectToVoice() runs, let alone
 * succeeds. Without a claim the self-move detector reads
 * getConnectedChannelId() as the OLD channel (or null), decides a
 * moderator dragged us, and force-moves the user out of the join they
 * just started.
 *
 * Callers must invoke this SYNCHRONOUSLY immediately before
 * `rest.joinVoice(...)` — any await in between reopens the race.
 *
 * The claim also stamps the join with the current hang-up generation: a
 * hang-up from here on cancels it, even one pressed before the REST join
 * returns (see [isVoiceJoinCancelled]).
 */
export function claimVoiceChannel(channelId: string): void {
  pendingChannels.set(channelId, hangupGen);
}

/**
 * True when the user hung up after [channelId] was claimed, i.e. that join is
 * void. Join sites check it before merging the snapshot from their REST join:
 * the snapshot still lists us in the channel and would undo the hang-up's
 * optimistic leave, with no echo left to correct it. connectToVoice rejects
 * the join itself with VoiceError('cancelled').
 */
export function isVoiceJoinCancelled(channelId: string): boolean {
  const gen = pendingChannels.get(channelId);
  return gen !== undefined && gen !== hangupGen;
}

/**
 * The current hang-up generation. A join flow that first tears a call down
 * itself (the moderator-move rejoin, a stage role change) reads it before
 * that teardown and gives up instead of re-claiming if it changed meanwhile:
 * the user hung up, and the rejoin must not pull them back in.
 */
export function getHangupGeneration(): number {
  return hangupGen;
}

/** Drop the claim made by [claimVoiceChannel]. Scoped to one channel so a
    join that fails (or finishes first) can never revoke a DIFFERENT join's
    still-live intent. Safe to call more than once for the same id. */
export function releaseVoiceChannel(channelId: string): void {
  pendingChannels.delete(channelId);
}

/** Channel id of the voice room this device considers its own. Used by
    the self-move detector in AppState to decide whether a
    VOICE_STATE_UPDATE for our own user represents an admin-initiated
    move (channelId differs from ours) vs. a benign state delta
    (mute/deaf toggle on the same channel).
 *
 *  Reports the SETTLED connection only. To ask "is this state update my
 *  own doing?", use [isSelfVoiceTarget] — collapsing intent into this
 *  getter made an in-flight join look like the current channel to every
 *  other caller too.
 *
 *  A user hang-up ([hangUpVoice]) clears it at once, before the Room has
 *  finished closing: from that instant the call is over for everyone who
 *  asks (the self-move detector, the in-call roster reconcile, the
 *  eviction watcher), not ~250 ms later when the teardown lands. */
export function getConnectedChannelId(): string | null {
  return connectedChannelId;
}

/**
 * True when [channelId] is one this device is already in or actively
 * joining — i.e. a VOICE_STATE_UPDATE naming it is the echo of our own
 * action, not somebody moving us.
 *
 * The server dispatches that echo from inside the join handler, before
 * the HTTP response is written, so it routinely arrives before
 * connectToVoice has even started. Matching against outstanding claims
 * as well as the settled channel is what stops the self-move detector
 * from force-moving the user out of a join they just made.
 */
export function isSelfVoiceTarget(channelId: string): boolean {
  return pendingChannels.has(channelId) || connectedChannelId === channelId;
}

/**
 * True while a join is still in flight on this device: claimed with its REST
 * join out, waiting its turn on the chain, or connecting / publishing /
 * setting up. A hang-up now CANCELS that join rather than ending a settled
 * call — and the cancelled join's site sends its rollback leave at once, so
 * our row can be gone within a round trip of the click whatever the hang-up
 * itself does (VoiceView's 1:1 Leave can't hold its leave back behind the
 * swallow animation then).
 */
export function isVoiceJoinInFlight(): boolean {
  return connectingRoom !== null || pendingChannels.size > 0;
}

import { getCurrentPreset } from './voiceQuality';
import * as voicePrefs from './voicePrefs';
import { enterCallBackgroundMode, exitCallBackgroundMode } from './callBackground';
import { getCallKeyString } from './e2ee';
import { isMediaCaptureAvailable, mediaUnavailableMessage } from './mediaSupport';
import { playCallConnect, playCallEnd } from './sounds';

function loadLivekit(): Promise<typeof import('livekit-client')> {
  if (!livekitModule) {
    livekitModule = import('livekit-client');
  }
  return livekitModule;
}

// ── Device persistence ─────────────────────────────────────────────────────
//
// localStorage keys are namespaced under `zekktris.` so they don't collide
// with anything else the page might set. Browser device IDs are stable
// per-user-per-origin — a phantom "Microphone (USB)" the user picked once
// will keep that ID across reloads. They DO change if the user clears
// browser data or unplugs+replugs USB devices, so we always validate the
// saved ID against current `enumerateDevices()` before using it.

const STORAGE_INPUT = 'zekktris.audio.input';
const STORAGE_OUTPUT = 'zekktris.audio.output';
const STORAGE_CAMERA_QUALITY = 'zekktris.video.camera_quality';
const STORAGE_SCREEN_QUALITY = 'zekktris.video.screen_quality';
const STORAGE_SCREEN_FPS60 = 'zekktris.video.screen_fps60';

// ── Video quality presets ──────────────────────────────────────────────────
//
// LiveKit ships its own VideoPresets enum but we hide it behind our own
// labels so the UI doesn't leak SDK-specific names. The numbers track
// LiveKit's published presets where they exist; "auto" is our shorthand
// for letting the SDK pick adaptively (the default).
//
// Camera defaults to 720p at 30fps which strikes the right balance for
// most webcams over residential uplinks. Screen defaults to 1080p at
// 30fps — desktop content benefits more from resolution than motion
// fluidity for typical use (chat, code, presentations); the separate
// "smooth motion" toggle bumps the share to 60fps for gaming / video
// playback. Both are perk-gated (see the entitlement section below): an
// account with no tier streams at 720p30.

export type CameraQuality = 'auto' | 'low' | 'p720' | 'p1080' | 'k2' | 'k4';
export type ScreenQuality = 'p720' | 'p1080' | 'k2' | 'k4';

export const CAMERA_QUALITY_PRESETS: Record<
  CameraQuality,
  {
    width: number;
    height: number;
    frameRate: number;
    /** Per-tier encoder maxBitrate in bits/sec. Applied as a per-publish
        override in setCameraEnabled. Without it, every tier inherits
        publishDefaults.videoEncoding from the AUDIO quality preset
        (≤1.5 Mbps), which silently strangles 1080p and above — the
        capture is sharp but the encoder smears it back to mush. */
    maxBitrate: number;
    label: string;
    description: string;
  } | null
> = {
  // 'auto' captures at 720p and lets SIMULCAST + the SFU do the adapting —
  // that is what "let the network decide" actually means here.
  //
  // It used to be `null`, i.e. "omit the resolution and inherit
  // publishDefaults". That inheritance chain ran straight into the AUDIO
  // quality preset: voiceQuality.ts's default 'normal' tier is
  // videoWidth 854 / videoHeight 480 / videoBitrate 800k. So the tier
  // labelled "Recommended for most users" published 854x480 @ 800kbps —
  // the single blurriest camera setting in the app, below even the explicit
  // "Low (480p)" option, and it could never improve because nothing about it
  // was adaptive. Worse, picking the "Low" VOICE preset silently dropped the
  // camera to 640x480, a coupling no part of the UI mentioned.
  //
  // Now it starts at a sharp 720p and degrades via the mechanism built for
  // it: simulcast rungs the SFU hands out per-viewer, plus a 'balanced'
  // degradationPreference so the encoder can shed pixels under pressure AND
  // climb back when it clears.
  auto: {
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    label: 'Auto',
    description: 'Starts at 720p and adapts to your connection.',
  },
  low: {
    width: 640,
    height: 480,
    frameRate: 15,
    maxBitrate: 600_000,
    label: 'Low (480p)',
    description: 'Saves bandwidth. Good for slow networks.',
  },
  p720: {
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    label: '720p',
    description: 'Balanced quality for most calls.',
  },
  p1080: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 4_000_000,
    label: '1080p',
    description: 'Sharp. Needs a solid uplink.',
  },
  k2: {
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 8_000_000,
    label: '2K (1440p)',
    description: 'Very sharp — needs a camera that captures 1440p and a fast uplink.',
  },
  k4: {
    width: 3840,
    height: 2160,
    frameRate: 30,
    maxBitrate: 14_000_000,
    label: '4K (2160p)',
    description: 'Very sharp. Heavy on bandwidth and CPU — needs a fast uplink.',
  },
};

export const SCREEN_QUALITY_PRESETS: Record<
  ScreenQuality,
  {
    width: number;
    height: number;
    /** Base frame rate. The independent "smooth motion" toggle
        (getSavedScreenFps60) bumps it to 60fps when the perk tier allows —
        see getEffectiveScreenShareParams for the fold-in. */
    frameRate: number;
    /** Encoder maxBitrate in bits/sec. Screen content needs MORE
        bitrate than camera at the same resolution because of sharp
        edges (text/UI) where compression artifacts are immediately
        visible. Under-budget streams thrash keyframes under any
        packet loss and the viewer sees visible freezes until the
        next IDR. These numbers err on the generous side; the
        encoder uses less when the screen is static. */
    maxBitrate: number;
    label: string;
    description: string;
  }
> = {
  p720: {
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    label: '720p',
    description: 'Saves bandwidth. Fine for documents and slides.',
  },
  p1080: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 5_000_000,
    label: '1080p',
    description: 'Balanced. Recommended for most sharing.',
  },
  k2: {
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 8_000_000,
    label: '2K (1440p)',
    description: 'Sharp text on large monitors. Needs a solid uplink.',
  },
  k4: {
    width: 3840,
    height: 2160,
    frameRate: 30,
    maxBitrate: 14_000_000,
    label: '4K (2160p)',
    description: 'Maximum sharpness. Heavy on bandwidth and CPU — needs a fast uplink.',
  },
};

export function getSavedCameraQuality(): CameraQuality {
  try {
    const v = localStorage.getItem(STORAGE_CAMERA_QUALITY);
    // Nothing stored → 720p, same behavior the pre-4K default
    // ('medium') gave users who never touched the setting.
    if (v === null) return 'p720';
    if (v in CAMERA_QUALITY_PRESETS) return v as CameraQuality;
    // Legacy tier names from before the 4K-capable scheme. Map to the
    // equivalent new tier and write the result back so the migration
    // runs once per browser, not on every read. Anything else
    // unrecognized normalizes to 'auto' (safest — SDK adapts).
    const legacy: Record<string, CameraQuality> = { medium: 'p720', high: 'p1080' };
    const mapped = legacy[v] ?? 'auto';
    localStorage.setItem(STORAGE_CAMERA_QUALITY, mapped);
    return mapped;
  } catch {
    return 'p720';
  }
}

export function setSavedCameraQuality(q: CameraQuality): void {
  try {
    localStorage.setItem(STORAGE_CAMERA_QUALITY, q);
  } catch {
    // localStorage might be disabled in some embedded contexts; fail soft.
  }
}

export function getSavedScreenQuality(): ScreenQuality {
  try {
    const v = localStorage.getItem(STORAGE_SCREEN_QUALITY);
    // Nothing stored → 1080p when the perk tier allows it, else 720p, so an
    // account with no tier doesn't see a locked default it never chose.
    if (v === null) return isScreenQualityAllowed('p1080') ? 'p1080' : 'p720';
    if (v in SCREEN_QUALITY_PRESETS) return v as ScreenQuality;
    // Legacy tier names from before the 4K-capable scheme ('k2' maps
    // to itself via the `in` check above). 'high_motion' baked 60fps
    // into the tier; that's a separate toggle now, so migrating it
    // also flips the toggle on to preserve what the user asked for.
    // Write the result back so the migration runs once per browser.
    const legacy: Record<string, ScreenQuality> = {
      low: 'p720',
      standard: 'p1080',
      high_motion: 'p1080',
    };
    const mapped = legacy[v];
    if (!mapped) return 'p1080';
    if (v === 'high_motion') localStorage.setItem(STORAGE_SCREEN_FPS60, '1');
    localStorage.setItem(STORAGE_SCREEN_QUALITY, mapped);
    return mapped;
  } catch {
    return 'p1080';
  }
}

export function setSavedScreenQuality(q: ScreenQuality): void {
  try {
    localStorage.setItem(STORAGE_SCREEN_QUALITY, q);
  } catch {
    // ignore
  }
}

/** The "smooth motion" toggle: capture + encode screen share at 60fps
    instead of the presets' base 30fps. Independent of the resolution
    tier so users don't have to trade sharpness for fluidity. Default
    off — 60fps roughly doubles bandwidth for content that's mostly
    static in typical shares (code, docs, slides). */
export function getSavedScreenFps60(): boolean {
  try {
    return localStorage.getItem(STORAGE_SCREEN_FPS60) === '1';
  } catch {
    return false;
  }
}

export function setSavedScreenFps60(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_SCREEN_FPS60, '1');
    else localStorage.removeItem(STORAGE_SCREEN_FPS60);
  } catch {
    // ignore
  }
}

// ── Perk-tier streaming entitlement (screen share AND camera) ──────────────
//
// WHICH qualities need WHICH perk tier is admin-configurable (instance_settings,
// read via GET /instance/monetization). There are no payments — Scout /
// Guardian / Legend are labels an admin gives out. The defaults below mirror
// the server's, so until a config fetch succeeds (offline, older server) the
// gate acts the same: everyone streams 720p30; Scout adds 1080p and 60fps,
// Guardian 2K, Legend 4K. 720p30 is NEVER gated.
//
// AuthContext PUSHES both halves of the decision here: setUserTier() on
// every user change (login, getMe refresh, admin give/remove, sign-out) and
// setMonetization() once the instance config loads. The effective-params
// getters CLAMP a disallowed saved choice down to the highest quality the
// tier covers on that surface — so a saved 'k4' from a tier that ended (or a
// hand-edited localStorage) publishes at the ceiling instead. The saved
// preference itself is left untouched: when the tier comes back, the old
// choice simply works again.
//
// Enforcement is client-side (like the rest of the quality pipeline — the
// SFU has no per-publisher resolution caps to lean on).

/** MINIMUM perk tier a gated quality requires; 'none' = free. */
export type MonetizeTier = 'none' | 'scout' | 'guardian' | 'legend';

export const MONETIZE_TIER_RANK: Record<MonetizeTier, number> = {
  none: 0,
  scout: 1,
  guardian: 2,
  legend: 3,
};

/** Rank of a SelfUser.subscriptionTier (null / unknown → 0 = free).
    Family-inherited tiers count (the child holds the tier value);
    founder grants are 'scout'. */
export function monetizeTierRank(tier: string | null | undefined): number {
  if (tier === 'scout' || tier === 'guardian' || tier === 'legend') {
    return MONETIZE_TIER_RANK[tier];
  }
  return 0;
}

/** The stream/camera halves of the instance perk config. Only the
    gateable rungs appear — 720p30 (and camera auto/low) never do. */
interface StreamingGates {
  stream: { p1080: MonetizeTier; k2: MonetizeTier; k4: MonetizeTier; fps60: MonetizeTier };
  camera: { p1080: MonetizeTier; k2: MonetizeTier; k4: MonetizeTier };
}

/** Duplicates the server's defaults so behavior without a successful
    config fetch matches the server. */
const DEFAULT_STREAMING_GATES: StreamingGates = {
  stream: { p1080: 'scout', k2: 'guardian', k4: 'legend', fps60: 'scout' },
  camera: { p1080: 'none', k2: 'guardian', k4: 'legend' },
};

let streamingGates: StreamingGates = DEFAULT_STREAMING_GATES;

/** Locked-down until the session pushes the real tier — a signed-out or
    not-yet-loaded state must not grant premium tiers. */
let userTierRank = 0;

// External-store subscription so React UIs (the Settings lock pills) re-render
// when the instance config lands AFTER they mounted — module state alone is
// invisible to React. Mirrors the voicePrefs subscribe pattern; consume with
// useSyncExternalStore(subscribeMonetization, getMonetizationVersion, ...).
let monetizationVersion = 0;
const monetizationListeners = new Set<() => void>();
export function subscribeMonetization(cb: () => void): () => void {
  monetizationListeners.add(cb);
  return () => monetizationListeners.delete(cb);
}
export function getMonetizationVersion(): number {
  return monetizationVersion;
}

function normalizeMonetizeTier(v: unknown, dflt: MonetizeTier): MonetizeTier {
  return v === 'none' || v === 'scout' || v === 'guardian' || v === 'legend' ? v : dflt;
}

/** Push the instance perk config (AuthContext owns calling this after
    GET /instance/monetization succeeds). Accepts the full config object —
    only the stream/camera matrices matter here. Unknown values fall back to
    the defaults rather than throwing. */
export function setMonetization(config: {
  stream: { p1080: string; k2: string; k4: string; fps60?: string };
  camera: { p1080: string; k2: string; k4: string };
}): void {
  const d = DEFAULT_STREAMING_GATES;
  streamingGates = {
    stream: {
      p1080: normalizeMonetizeTier(config.stream?.p1080, d.stream.p1080),
      k2: normalizeMonetizeTier(config.stream?.k2, d.stream.k2),
      k4: normalizeMonetizeTier(config.stream?.k4, d.stream.k4),
      fps60: normalizeMonetizeTier(config.stream?.fps60, d.stream.fps60),
    },
    camera: {
      p1080: normalizeMonetizeTier(config.camera?.p1080, d.camera.p1080),
      k2: normalizeMonetizeTier(config.camera?.k2, d.camera.k2),
      k4: normalizeMonetizeTier(config.camera?.k4, d.camera.k4),
    },
  };
  monetizationVersion++;
  for (const cb of monetizationListeners) cb();
}

/** Push the signed-in user's perk tier (AuthContext effect owns calling
    this). Signed-out / unknown → rank 0 (base perks) — fail closed. */
export function setUserTier(tier: string | null | undefined): void {
  userTierRank = monetizeTierRank(tier);
}

/** The perk tier required to use screen quality `q`, or null if it's free
    (720p always is). For the Settings UI's lock pills. */
export function requiredTierForScreenQuality(
  q: ScreenQuality,
): Exclude<MonetizeTier, 'none'> | null {
  if (q === 'p720') return null;
  const t = streamingGates.stream[q];
  return t === 'none' ? null : t;
}

/** Camera counterpart — 'auto'/'low'/'p720' are always free; 1080p and up
    read the admin-configured camera matrix. */
export function requiredTierForCameraQuality(
  q: CameraQuality,
): Exclude<MonetizeTier, 'none'> | null {
  if (q === 'auto' || q === 'low' || q === 'p720') return null;
  const t = streamingGates.camera[q];
  return t === 'none' ? null : t;
}

/** Whether a session at `tierRank` (default: the CURRENT session) may
    publish screen share at `q`. Drives both the Settings lock pills and
    the publish-time clamp. */
export function isScreenQualityAllowed(
  q: ScreenQuality,
  tierRank: number = userTierRank,
): boolean {
  const req = requiredTierForScreenQuality(q);
  return req === null || tierRank >= MONETIZE_TIER_RANK[req];
}

/** The perk tier required for 60fps screen share, or null if it's free. */
export function requiredTierForScreenFps60(): Exclude<MonetizeTier, 'none'> | null {
  const t = streamingGates.stream.fps60;
  return t === 'none' ? null : t;
}

/** Whether a session at `tierRank` (default: the CURRENT session) may share
    its screen at 60fps. */
export function isScreenFps60Allowed(tierRank: number = userTierRank): boolean {
  const req = requiredTierForScreenFps60();
  return req === null || tierRank >= MONETIZE_TIER_RANK[req];
}

/** Camera counterpart of the screen check. */
export function isCameraQualityAllowed(
  q: CameraQuality,
  tierRank: number = userTierRank,
): boolean {
  const req = requiredTierForCameraQuality(q);
  return req === null || tierRank >= MONETIZE_TIER_RANK[req];
}

/** The best screen tier the session may publish — the clamp target when a
    saved choice isn't covered. 720p is the floor (never gated). */
export function highestAllowedScreenQuality(
  tierRank: number = userTierRank,
): ScreenQuality {
  for (const q of ['k4', 'k2', 'p1080'] as const) {
    if (isScreenQualityAllowed(q, tierRank)) return q;
  }
  return 'p720';
}

/** Camera counterpart of the screen clamp target. */
export function highestAllowedCameraQuality(
  tierRank: number = userTierRank,
): CameraQuality {
  for (const q of ['k4', 'k2', 'p1080'] as const) {
    if (isCameraQualityAllowed(q, tierRank)) return q;
  }
  return 'p720';
}

/** Effective screen-share capture/encoder parameters: the saved quality
    tier with the "smooth motion" toggle folded in. 60fps costs bitrate
    headroom — inter frames arrive twice as fast — so it gets a 1.5× budget
    bump. 4K60 is allowed (a Legend perk) but heavy: a machine without a
    hardware encoder drops frames, so the Settings copy says so. */
function getEffectiveScreenShareParams(): {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
} {
  // Entitlement clamp: a saved quality without the perk tier to back it
  // (tier ended, signed-out relogin as another account, hand-edited
  // storage) publishes at the highest quality the tier covers. The saved
  // PREFERENCE is intentionally not rewritten — restore the tier and the
  // old choice works again.
  const saved = getSavedScreenQuality();
  const q = isScreenQualityAllowed(saved) ? saved : highestAllowedScreenQuality();
  const preset = SCREEN_QUALITY_PRESETS[q];
  const smooth = getSavedScreenFps60() && isScreenFps60Allowed();
  return {
    width: preset.width,
    height: preset.height,
    frameRate: smooth ? 60 : preset.frameRate,
    maxBitrate: smooth ? Math.round(preset.maxBitrate * 1.5) : preset.maxBitrate,
  };
}

/** Encoder maxBitrate for screen share — the user's saved quality tier
    plus the smooth-motion bump. Read at Room construction time as the
    publishDefaults BASELINE; the authoritative per-share values are
    re-read and passed as per-publish options in setScreenShareEnabled,
    so a tier / smooth-motion change applies the next time the share is
    turned on — no need to leave and rejoin the call. */
function getScreenShareEncoderBitrate(): number {
  return getEffectiveScreenShareParams().maxBitrate;
}

function getScreenShareEncoderFramerate(): number {
  return getEffectiveScreenShareParams().frameRate;
}

export function getSavedInputDeviceId(): string {
  try {
    return localStorage.getItem(STORAGE_INPUT) ?? '';
  } catch {
    return '';
  }
}

export function getSavedOutputDeviceId(): string {
  try {
    return localStorage.getItem(STORAGE_OUTPUT) ?? '';
  } catch {
    return '';
  }
}

/**
 * Save the user's preferred microphone. Pass empty string to clear
 * (= use system default). If a Room is currently connected, also
 * switches the live audio source so the change is audible immediately.
 */
export async function setSavedInputDeviceId(deviceId: string): Promise<void> {
  try {
    if (deviceId) localStorage.setItem(STORAGE_INPUT, deviceId);
    else localStorage.removeItem(STORAGE_INPUT);
  } catch {
    // localStorage can throw in private mode / quota-exceeded; the
    // setting just won't persist. Continue with live switching.
  }
  if (room && deviceId) {
    try {
      await room.switchActiveDevice('audioinput', deviceId);
    } catch {
      // Switch can fail if the device disappeared between enumerate
      // and switch. Caller should re-enumerate; live state is
      // self-correcting on next connect.
    }
    // If manual gain is active, switchActiveDevice just replaced the
    // published track with LiveKit's own capture of the new device —
    // which silently drops the gain chain (slider goes dead) and leaves
    // the OLD device's raw capture hot. Re-activate manual gain against
    // the new device so the slider keeps working and the prior chain is
    // torn down. (activateManualGain is idempotent — it deactivates the
    // previous chain first.)
    if (voicePrefs.getVoicePrefs().gainMode === 'manual') {
      try {
        const localPubs = (room as unknown as {
          localParticipant: { trackPublications: Map<string, TrackPublicationLike> };
        }).localParticipant;
        for (const [, pub] of localPubs.trackPublications) {
          if (pub.kind === 'audio' && pub.track && 'replaceTrack' in pub.track) {
            const { activateManualGain } = await import('./manualGain');
            await activateManualGain({
              liveKitTrack: pub.track as unknown as Parameters<typeof activateManualGain>[0]['liveKitTrack'],
              inputDeviceId: deviceId,
            });
            break;
          }
        }
      } catch {
        // Best-effort — voice continues with LiveKit's captured track.
      }
    }
  }
}

/**
 * Save the user's preferred speaker. As with input, switches live
 * if a call is active. Note: switching the output device only works
 * in browsers with full HTMLMediaElement.setSinkId support — Firefox
 * has it behind a flag, Safari doesn't have it at all. Setting the
 * preference still persists; it just won't apply on those browsers.
 */
export async function setSavedOutputDeviceId(deviceId: string): Promise<void> {
  try {
    if (deviceId) localStorage.setItem(STORAGE_OUTPUT, deviceId);
    else localStorage.removeItem(STORAGE_OUTPUT);
  } catch {}
  if (room && deviceId) {
    try {
      await room.switchActiveDevice('audiooutput', deviceId);
    } catch {}
  }
}

export interface AudioDeviceList {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  /**
   * True if device LABELS are populated. Browsers hide labels until
   * the user has granted microphone permission at least once — calling
   * `requestMicPermission` once and re-enumerating reveals them.
   */
  labelsAvailable: boolean;
}

/**
 * List available audio input/output devices. Doesn't request permission
 * — call `requestMicPermission` first if you want labels populated.
 */
export async function listAudioDevices(): Promise<AudioDeviceList> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [], labelsAvailable: false };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  // Even with permission granted, Safari sometimes returns empty labels
  // for output devices. Inputs are the canonical signal — if THEIR
  // labels are filled in, the user has granted mic access at least once.
  const labelsAvailable = inputs.some((d) => d.label.length > 0);
  return { inputs, outputs, labelsAvailable };
}

/**
 * Request microphone access ONLY for the side effect of getting device
 * labels populated. The track is stopped immediately. If the user
 * denies, throws a typed error so callers can surface the right message.
 */
export async function requestMicPermission(): Promise<void> {
  if (!isMediaCaptureAvailable()) {
    throw new VoiceError('browser_unsupported', mediaUnavailableMessage());
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw mediaErrorToVoiceError(err);
  }
  stream.getTracks().forEach((t) => t.stop());
}

// ── Error mapping ──────────────────────────────────────────────────────────

export type VoiceErrorCode =
  | 'browser_unsupported'
  | 'mic_denied_browser'
  | 'mic_denied_system'
  | 'mic_not_found'
  | 'mic_in_use'
  | 'mic_constraint_failed'
  | 'connect_failed'
  // The DM has E2EE enabled but this device has no usable key for it
  // (never unlocked, or a stale key after a re-key). The call is
  // refused so we never place an unencrypted call the peer can't decode.
  | 'e2ee_locked'
  // The DM wants an E2EE call but this browser lacks the insertable-
  // streams support LiveKit needs to encrypt media.
  | 'e2ee_unsupported'
  // Our own screen capture died on its own (window closed, display
  // unplugged, browser revoked it) — NOT a failed request. Reported
  // asynchronously via subscribeVoiceError, never thrown, and kept
  // distinct from `mic_denied_browser` so the screen-share UI (which
  // suppresses that code to swallow picker-cancel) still surfaces it.
  | 'screenshare_ended'
  // The user hung up ([hangUpVoice]) while this join was still in flight.
  // Not a failure: join sites still roll their server-side join back, but
  // show no error for it.
  | 'cancelled'
  | 'unknown';

export class VoiceError extends Error {
  code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'VoiceError';
  }
}

/** True for the rejection of a join the user hung up ([hangUpVoice]). Join
    sites check it to skip their error toast; the hang-up was the point. */
export function isVoiceCancelled(err: unknown): boolean {
  return err instanceof VoiceError && err.code === 'cancelled';
}

// ── Asynchronous voice errors ──────────────────────────────────────────────
//
// Every other VoiceError reaches the UI by rejecting the call the user just
// made (connect, camera toggle, screen-share toggle), so a toast falls out
// of the caller's catch. Failures that arrive on their OWN schedule — a
// capture source dying under a live publication — have no such call to
// reject, so they ride the same tiny pub/sub shape this module already uses
// for async state (speakers, tracks, connection).
type VoiceErrorListener = (err: VoiceError) => void;
const voiceErrorListeners = new Set<VoiceErrorListener>();

/** Subscribe to voice failures that happen outside any user-initiated
    call. Toast `err.message`; branch on `err.code` if you want to. */
export function subscribeVoiceError(listener: VoiceErrorListener): () => void {
  voiceErrorListeners.add(listener);
  return () => {
    voiceErrorListeners.delete(listener);
  };
}

function publishVoiceError(err: VoiceError): void {
  for (const l of voiceErrorListeners) l(err);
}

function mediaErrorToVoiceError(err: unknown): VoiceError {
  const e = err as { name?: string; message?: string };
  const msg = (e?.message ?? '').toLowerCase();
  // A TypeError here almost always means `navigator.mediaDevices` (or
  // `.getUserMedia`) was undefined — the WebView/insecure-context case —
  // and we reached a getUserMedia call without (or despite) the
  // capability guard. Map it to the clear, self-diagnosing message rather
  // than leaking the raw "undefined is not an object …" string.
  if (e?.name === 'TypeError' || msg.includes('mediadevices') || msg.includes('getusermedia')) {
    if (!isMediaCaptureAvailable()) {
      return new VoiceError('browser_unsupported', mediaUnavailableMessage());
    }
  }
  switch (e?.name) {
    case 'NotAllowedError':
      // Three sub-cases of NotAllowedError, distinguished by message:
      //
      //   1. "Permission dismissed/denied by user" — browser-level
      //      block. User has to use the lock icon to re-enable.
      //
      //   2. "Permission denied by system" — OS-level block (Windows
      //      Privacy Settings, macOS System Settings).
      //
      //   3. "Permission denied by feature policy" / "disallowed by
      //      permissions policy" — the page sent a Permissions-Policy
      //      response header that disables microphone for this origin.
      //      This is a SERVER configuration problem, not a user one.
      //      Common culprits: Caddy/nginx security-header presets that
      //      include `microphone=()`, Cloudflare's edge defaults, or a
      //      sandboxed iframe.
      if (msg.includes('feature policy') || msg.includes('permissions policy')) {
        return new VoiceError(
          'mic_denied_browser',
          "Microphone is blocked by a Permissions-Policy header from the server. This isn't fixable in your browser — the site administrator needs to allow microphone for this origin. (Caddy: change `microphone=()` to `microphone=(self)` in Caddyfile headers.)",
        );
      }
      if (msg.includes('system')) {
        return new VoiceError(
          'mic_denied_system',
          "Microphone is blocked at the operating system level. On Windows: Settings → Privacy & security → Microphone → enable it for your browser. On macOS: System Settings → Privacy & Security → Microphone → check your browser.",
        );
      }
      return new VoiceError(
        'mic_denied_browser',
        "Microphone permission denied. Click the lock icon (🔒) in your address bar, set Microphone to 'Allow', and reload the page.",
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new VoiceError(
        'mic_not_found',
        'No microphone detected. Plug in a microphone or check that your audio device is enabled in your OS sound settings.',
      );
    case 'NotReadableError':
    case 'TrackStartError':
      return new VoiceError(
        'mic_in_use',
        'Microphone is busy. Close any other apps using the mic (Zoom, Teams, OBS) and try again.',
      );
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new VoiceError(
        'mic_constraint_failed',
        'The selected microphone is no longer available. Open Voice & Video settings and pick a different one (or "System default").',
      );
    default:
      return new VoiceError('unknown', e?.message ?? 'Unknown audio error');
  }
}

// ── Connection lifecycle ───────────────────────────────────────────────────

/** True between a successful connect and the end-of-call chime, so the
 *  hangup sound fires exactly once per session no matter how many teardown
 *  paths race to disconnectVoice(). See the chime block in disconnectVoice. */
let hangupChimeArmed = false;

/**
 * Serial queue for session-lifecycle operations (connect / disconnect).
 *
 * Nothing else guards them: the module `room` handle is only assigned
 * AFTER `await r.connect(...)` resolves, so two overlapping joins — a
 * double-click on a channel, or a join racing an auto-reconnect — both
 * saw a stale `room` at the top of connectToVoice, both skipped the
 * tear-down of the other, and both connected with the SAME participant
 * identity. LiveKit resolves that by evicting one of them
 * (DUPLICATE_IDENTITY), which kills a call the user is already in and
 * leaves an orphan Room behind.
 *
 * Mirrors the iOS client's `sessionChain` (Voice.swift): every enqueued
 * op runs to completion before the next begins, so connect and
 * disconnect can never overlap on one Room.
 */
let sessionChain: Promise<void> = Promise.resolve();

/** Run `op` after any in-flight connect/disconnect finishes. The chain
    itself never rejects — a failed op still hands the queue on — but the
    caller gets the original rejection. */
function serialized<T>(op: () => Promise<T>): Promise<T> {
  const run = sessionChain.then(op);
  sessionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Hang-up checkpoints ───────────────────────────────────────────────────
//
// A join (performConnect) runs inside the chain above, so a teardown queued
// behind it waits for it — up to LiveKit's 15 s signal + 15 s peer-connection
// timeouts, or for as long as a mic-permission prompt stays open. A USER
// hang-up must not wait: [hangUpVoice] bumps the generation, and the join
// checks it after every await below and unwinds with
// VoiceError('cancelled') the moment it finds it moved on.

function cancelledError(): VoiceError {
  return new VoiceError('cancelled', 'The call was hung up before it connected.');
}

/** Throw 'cancelled' if the user hung up since generation [gen] began. */
function throwIfHungUp(gen: number): void {
  if (gen !== hangupGen) throw cancelledError();
}

const HUNG_UP: unique symbol = Symbol('hung up');

/** [work], or HUNG_UP if the user hangs up first. A rejection of [work]
    that comes first still rejects. The caller owns whatever [work] yields
    after losing the race (e.g. a late mic stream, which it must stop). */
function orHangUp<T>(work: Promise<T>, gen: number): Promise<Awaited<T> | typeof HUNG_UP> {
  const hungUp = gen === hangupGen ? nextHangup.promise : Promise.resolve();
  return Promise.race([work, hungUp.then((): typeof HUNG_UP => HUNG_UP)]);
}

function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

/** The pre-flight getUserMedia probe, raced against a hang-up: an open
    permission prompt must not hold the chain once the user has hung up. A
    stream granted after that is stopped the moment it arrives. */
async function probeMic(audio: MediaTrackConstraints | boolean, gen: number): Promise<void> {
  const request = navigator.mediaDevices.getUserMedia({ audio });
  const stream = await orHangUp(request, gen);
  if (stream === HUNG_UP) {
    void request.then(stopStream, () => {});
    throw cancelledError();
  }
  stopStream(stream);
}

/**
 * Stop the mic capture a hang-up stranded inside LiveKit's publish.
 *
 * setMicrophoneEnabled opens LiveKit's OWN capture (createTracks, a
 * getUserMedia of its own) before it publishes. If the hang-up closes the
 * engine while that capture is still opening, the publish that follows finds
 * the signal no longer connected and parks the new track until it is, which
 * a closed engine never is: LiveKit holds it LIVE (the browser's mic
 * indicator on) until its 15 s publish timeout, and Room.disconnect() stops
 * only tracks already published. No public API reaches a parked track, so
 * this reaches LiveKit's pending-publish map defensively (as pollRtt reaches
 * the PeerConnection) and stops what is parked there: now, and again once
 * the capture lands (LiveKit announces it, AudioStreamAcquired, a few
 * microtasks before parking it). Without that shape (a later LiveKit), its
 * own timeout still stops the track. A publish that still succeeds is
 * stopped too.
 */
function stopOrphanedMicCapture(
  participant: unknown,
  publishing: Promise<unknown>,
  acquiredEvent: string,
): void {
  type Stoppable = { stop?: () => void };
  const lp = participant as {
    pendingPublishPromises?: Map<Stoppable, unknown>;
    on?: (event: string, fn: () => void) => unknown;
    off?: (event: string, fn: () => void) => unknown;
  };
  const stopParked = () => {
    try {
      lp.pendingPublishPromises?.forEach((_publish, track) => track.stop?.());
    } catch {
      // Best effort: LiveKit's own timeout is the backstop.
    }
  };
  const onAcquired = () => {
    window.setTimeout(stopParked, 0);
  };
  const settled = (publication?: unknown) => {
    try {
      lp.off?.(acquiredEvent, onAcquired);
      // A publish that still went through (it beat the engine's close).
      (publication as { track?: Stoppable } | undefined)?.track?.stop?.();
    } catch {
      // Best effort.
    }
  };
  stopParked();
  lp.on?.(acquiredEvent, onAcquired);
  void publishing.then(settled, () => settled());
}

/**
 * Establish a LiveKit connection and publish the local microphone
 * track. If a connection is already open, it's torn down first — voice
 * is single-channel by design.
 *
 * Serialized against every other session op (see `serialized`), so an
 * overlapping join waits rather than racing this one onto a second Room.
 *
 * A user hang-up ([hangUpVoice]) cancels it wherever it is — waiting its
 * turn, probing the mic, connecting, publishing — and it rejects with
 * VoiceError('cancelled'), having played neither chime. A join belongs to
 * the hang-up generation of its claim ([claimVoiceChannel]) when the caller
 * staked one, so a Leave pressed while the REST join was still out cancels
 * it too.
 *
 * Throws a `VoiceError` with a code/message pair suitable for direct
 * display in a toast ('cancelled' excepted: see [isVoiceCancelled]).
 */
export function connectToVoice(args: ConnectArgs): Promise<void> {
  // Read NOW, before this join queues: the claim may be released (or a
  // hang-up land) while it waits its turn.
  const claimGen = args.channelId ? pendingChannels.get(args.channelId) : undefined;
  const gen = claimGen ?? hangupGen;
  return serialized(async () => {
    try {
      await performConnect(args, gen);
    } finally {
      // This connect no longer has a Room under construction, whatever
      // happened. (Connects never overlap, so it can't be anyone else's.)
      connectingRoom = null;
      // Release only OUR claim, success or not. Another join's claim is
      // keyed by its own channel and is untouched.
      if (args.channelId) releaseVoiceChannel(args.channelId);
    }
  });
}

async function performConnect(args: ConnectArgs, gen: number): Promise<void> {
  // Hung up while this join waited its turn on the chain (or before it was
  // even queued: see connectToVoice).
  throwIfHungUp(gen);
  // The chunk can take a while on a slow first load; a hang-up doesn't wait.
  const livekit = await orHangUp(loadLivekit(), gen);
  if (livekit === HUNG_UP) throw cancelledError();
  const { Room, RoomEvent, ParticipantEvent, ExternalE2EEKeyProvider, isE2EESupported, ScreenSharePresets } =
    livekit;

  // Pre-flight: do a getUserMedia ourselves with the user's saved
  // device id (if any). This catches permission/device errors with
  // crisp messages BEFORE LiveKit's connect path wraps them in
  // generic "could not establish session" errors. Track is stopped
  // immediately — LiveKit will re-acquire on its own when we publish.
  let inputDeviceId = getSavedInputDeviceId();
  // First make sure the capture API even exists. In the iOS WebView
  // (and any insecure-context load) `navigator.mediaDevices` can be
  // undefined; calling getUserMedia on it throws a bare TypeError
  // ("undefined is not an object …"). Surface a clear, self-diagnosing
  // message instead, and bail before LiveKit hits the same wall.
  if (!isMediaCaptureAvailable()) {
    throw new VoiceError('browser_unsupported', mediaUnavailableMessage());
  }
  const wantPublish = args.publish !== false;
  if (wantPublish) {
    try {
      await probeMic(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true, gen);
    } catch (err) {
      // Hung up (mid-prompt, or a denial racing the hang-up): the join is
      // void, not failed — no mic error for a call the user already left.
      if (isVoiceCancelled(err) || gen !== hangupGen) throw cancelledError();
      // If the user's SAVED mic is gone (unplugged USB headset), don't
      // block the join — the Room's own audioCaptureDefaults use a
      // non-exact deviceId and would fall back to the default mic
      // anyway. Retry the probe against the default device and clear
      // the stale preference; only a default-device failure (real
      // permission/hardware problem) aborts the join.
      const name = (err as { name?: string })?.name ?? '';
      const deviceGone =
        inputDeviceId &&
        (name === 'OverconstrainedError' ||
          name === 'ConstraintNotSatisfiedError' ||
          name === 'NotFoundError' ||
          name === 'DevicesNotFoundError');
      if (!deviceGone) throw mediaErrorToVoiceError(err);
      try {
        await probeMic(true, gen);
        // Drop the stale preference (storage + this join's capture
        // config) so the rest of the connect uses the default mic.
        inputDeviceId = '';
        try {
          localStorage.removeItem(STORAGE_INPUT);
        } catch {}
      } catch (fallbackErr) {
        if (isVoiceCancelled(fallbackErr) || gen !== hangupGen) throw cancelledError();
        throw mediaErrorToVoiceError(fallbackErr);
      }
    }
  }
  // Before the channel-switch teardown below: if the user hung up, the call
  // they are in ends through hangUpVoice's own (chiming) teardown, not this
  // silent switch one.
  throwIfHungUp(gen);

  // Tear down any prior session before opening a new one — and do it
  // through the FULL disconnect path, not a bare room.disconnect().
  // The bare disconnect left the old session's stale-tracks poll and
  // speaking poll running (the old poll then fought the new call's
  // track list, blanking video tiles every second), leaked the prefs
  // subscription, and kept the manual-gain mic capture alive. This is
  // the channel-switch path (clicking another voice channel while
  // connected), so it has to clean up exactly like an explicit leave —
  // EXCEPT we keep the shared AudioContext alive (it was just primed inside
  // this click gesture and the new connect follows immediately; closing it
  // would force a suspended re-create on Safari and kill the speaking rings).
  if (room) {
    // silent: this is a channel SWITCH, not a call end — the connect chime
    // fired by the join immediately below is the whole story. Chiming
    // hangup-then-connect here would narrate a call ending that didn't.
    //
    // Raw teardown, not disconnectVoice(): we are already inside the
    // serial chain, so re-entering it would deadlock waiting on ourselves.
    await performDisconnect({ keepAudioContext: true, silent: true });
    throwIfHungUp(gen);
  }

  // Read the user's current quality preference. The preset caps audio
  // bitrate, video resolution, and video bitrate. Changes take effect
  // on next room join — LiveKit doesn't surface a runtime
  // publishDefaults setter, and renegotiating mid-call is more
  // disruption than the feature is worth.
  const preset = getCurrentPreset();
  // Pull the user's audio-processing toggles. Defaults are all-on
  // (matching the previous hardcoded behavior), but exposing these
  // as settings lets users disable individual filters when
  // troubleshooting (e.g. some mics sound terrible with AGC on)
  // or experiment with which combination handles their environment
  // best. Browser-native noise suppression is conservative and
  // sometimes leaves transient noises like keyboard clicks through
  // — knowing the toggle is on lets the user rule that out before
  // resorting to push-to-talk.
  const audioPrefs = voicePrefs.getVoicePrefs();

  // ── End-to-end media encryption (1:1 DM calls only) ────────────────────
  //
  // When the caller asks for an encrypted call (args.e2ee, passed only by
  // 1:1 DM call sites whose DM has E2EE enabled), key LiveKit's media
  // encryption with the SAME shared key the DM uses for messages. Both
  // parties derived that key from the same password + salt — the unlock
  // verifier guarantees they match — so each can decrypt the other's
  // audio/video. We resolve and validate the key BEFORE creating the Room
  // so a locked/stale key fails the call cleanly here, rather than
  // connecting in cleartext and leaving the encrypted peer with media it
  // can't decode (which is just a silently dead call).
  let e2eeRoomOpt:
    | { keyProvider: InstanceType<typeof ExternalE2EEKeyProvider>; worker: Worker }
    | undefined;
  // The LiveKit shared-key passphrase (base64 of the DM key). A STRING on
  // purpose — it selects setKey's PBKDF2 path, which is what the native
  // client uses, so native↔web calls share a media key. See getCallKeyString.
  let e2eeKeyString: string | null = null;
  // Any worker from a previous call is dead the moment we start a new
  // connect — the old Room is already torn down above. Clear it now so an
  // unencrypted call doesn't leave a stale encrypted-call worker running,
  // and so the encrypted branch below starts from a clean slate.
  terminateE2eeWorker();
  if (args.e2ee) {
    e2eeKeyString = await getCallKeyString(args.e2ee.channelId, args.e2ee.verifier);
    throwIfHungUp(gen);
    if (!e2eeKeyString) {
      throw new VoiceError(
        'e2ee_locked',
        'This conversation is end-to-end encrypted. Unlock it (re-enter the password) on this device before starting a call.',
      );
    }
    if (!isE2EESupported()) {
      throw new VoiceError(
        'e2ee_unsupported',
        "This browser can't make end-to-end encrypted calls. Try the desktop app or a Chromium-based browser.",
      );
    }
    const keyProvider = new ExternalE2EEKeyProvider();
    // Vite resolves this URL at build time and bundles the worker as a
    // separate module chunk. type:'module' matches the .mjs worker entry
    // the package exposes under the `livekit-client/e2ee-worker` export.
    e2eeWorker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {
      type: 'module',
    });
    e2eeRoomOpt = { keyProvider, worker: e2eeWorker };
  }

  const r = new Room({
    // adaptiveStream is DISABLED on purpose. When true, LiveKit
    // gates video frame flow on element visibility (IntersectionObserver
    // + ResizeObserver). Element unmount/remount cycles during normal
    // React reconciliation can leave the observer in a state where a
    // subscribed track stays paused even after its <video> element is
    // back in the DOM — manifesting as "I subscribed to their stream
    // but I never see frames." Disabling here ensures every subscribed
    // video track is fully streamed regardless of element observability.
    // Bandwidth cost is bounded — at most O(participants) streams per
    // call, and 1:1 DM calls dominate our usage. Worth the reliability
    // win.
    adaptiveStream: false,
    // Dynacast stays on. Different mechanism: dynacast drops unused
    // simulcast LAYERS at the SFU when no subscriber wants them, but
    // doesn't affect frame flow to subscribers who do want the layer.
    // No reliability impact, real bandwidth saving.
    dynacast: true,
    audioCaptureDefaults: {
      echoCancellation: audioPrefs.echoCancellation,
      noiseSuppression: audioPrefs.noiseSuppression,
      // Browser AGC is on only in 'agc' gain mode. 'manual' and
      // 'off' both disable browser AGC — manual gain is applied
      // via a Web Audio GainNode in the manual-mode capture path
      // (see createManualGainedTrack below); 'off' leaves the
      // mic signal untouched.
      autoGainControl: audioPrefs.gainMode === 'agc',
      // Honor the quality preset's channel count. Previously `audioChannels`
      // was dead config — the "High" preset advertised "Stereo" in its help
      // text but capture stayed mono, so the stereo path never engaged.
      // Requesting 2 channels here lets the High preset actually carry
      // stereo (meaningful for the music/hi-fi use case it targets).
      channelCount: preset.audioChannels,
      ...(inputDeviceId ? { deviceId: inputDeviceId } : {}),
    },
    // Video capture defaults — width/height map directly to getUserMedia
    // constraints. The browser may downscale further if the camera
    // can't meet the request; LiveKit handles that gracefully.
    videoCaptureDefaults: {
      resolution: {
        width: preset.videoWidth,
        height: preset.videoHeight,
        // 30fps is a safe default. Going to 60 doubles bandwidth for
        // negligible perceptual gain in a chat app.
        frameRate: 30,
      },
    },
    // Publish defaults — these set bitrate caps on the SFU side and
    // govern what other participants will receive.
    publishDefaults: {
      audioPreset: {
        maxBitrate: preset.audioBitrate,
        // Opus stereo. Only meaningful on the High preset (audioChannels:2)
        // — it's the music/hi-fi tier. Pairs with channelCount:2 in
        // audioCaptureDefaults above; together they make the "Stereo"
        // the High preset's help text promises actually happen.
        ...(preset.audioChannels === 2 ? { dtx: false } : {}),
      },
      // Governs the 'auto' camera tier only — every named camera tier
      // (720p…4K) supplies its own per-publish videoEncoding override
      // in setCameraEnabled, because this audio-preset cap (≤1.5 Mbps)
      // would silently strangle 1080p and above.
      videoEncoding: {
        maxBitrate: preset.videoBitrate,
        maxFramerate: 30,
      },
      // Screen share gets its OWN encoder budget — separate from
      // camera (which is what `videoEncoding` above governs). Without
      // this, screen content was getting camera-grade bitrates
      // applied to high-res/60fps frames, which left no headroom for
      // keyframes under packet loss. Viewers saw freezes that
      // recovered only on the next IDR. Bitrate + framerate come from
      // the user's saved screen quality tier with the smooth-motion
      // 60fps toggle folded in (the actual stream rate is set by
      // setScreenShareEnabled's resolution arg, but encoders also
      // need to know the cap to plan rate control).
      screenShareEncoding: {
        maxBitrate: getScreenShareEncoderBitrate(),
        maxFramerate: getScreenShareEncoderFramerate(),
      },
      // One low simulcast rung under the (possibly 2K/4K) full-res
      // share. A viewer whose downlink can't carry the full layer gets
      // a decodable 720p15 picture instead of stalls; dynacast (on,
      // above) stops encoding the rung whenever nobody subscribes to
      // it, so the steady-state cost on strong-viewer calls is zero.
      screenShareSimulcastLayers: [ScreenSharePresets.h720fps15],
      // VP8 is the most compatible codec across browsers (Safari
      // included) and handles screen content's sharp edges well
      // without the keyframe-latency penalties some VP9 hardware
      // encoders have. AV1 would be even better quality-per-bit
      // but isn't reliably supported by viewer browsers yet.
      videoCodec: 'vp8',
      red: true, // forward-error-correction-ish; helps lossy networks
      // DTX (discontinuous transmission) saves bandwidth during silence
      // for speech, but harms continuous audio (music) — so it's disabled
      // on the High/music preset via the audioPreset above and left on
      // here for the speech-oriented Normal/Low presets.
      dtx: preset.audioChannels !== 2,
    },
    // End-to-end media encryption, present only for unlocked 1:1 DM
    // calls (see the e2ee resolution block above). Spread so the key
    // stays absent — not `undefined` — for every other call type, which
    // is what LiveKit treats as "no E2EE."
    ...(e2eeRoomOpt ? { e2ee: e2eeRoomOpt } : {}),
  });
  // From here until this connect settles, a hang-up can reach this Room
  // (see connectingRoom); module `room` won't point at it before r.connect.
  connectingRoom = r as unknown as RoomLike;

  // With the E2EE manager configured via Room options, hand it the
  // shared key and turn encryption on for all local tracks BEFORE
  // connecting (LiveKit's documented order: setKey → setE2EEEnabled →
  // connect). We pass the base64 key STRING (not raw bytes): setKey then
  // derives the media key with PBKDF2 — the cross-SDK-compatible path the
  // native Swift client also uses (see getCallKeyString). Both participants
  // feed the identical string, so they land on the same media key. The
  // mic/camera/screen tracks we publish after connect inherit this
  // encryption automatically.
  if (e2eeRoomOpt && e2eeKeyString) {
    try {
      await e2eeRoomOpt.keyProvider.setKey(e2eeKeyString);
      await r.setE2EEEnabled(true);
    } catch (err) {
      // Couldn't arm encryption — tear the worker down and refuse the
      // call rather than fall through to an unencrypted connect that the
      // peer can't decode.
      terminateE2eeWorker();
      if (gen !== hangupGen) throw cancelledError();
      throw new VoiceError(
        'e2ee_unsupported',
        `Couldn't enable end-to-end encryption for this call: ${
          (err as Error)?.message ?? 'unknown error'
        }`,
      );
    }
    // Hung up while encryption was being armed: nothing is wired to this
    // Room yet but the worker.
    if (gen !== hangupGen) {
      terminateE2eeWorker();
      throw cancelledError();
    }
  }

  if (args.onStateChange) {
    r.on(RoomEvent.ConnectionStateChanged, args.onStateChange as never);
  }

  // Terminal-disconnect safety net. Without this, when LiveKit gives up
  // reconnecting (network change, laptop sleep, SFU restart) or the
  // server removes the participant, the Room goes to `disconnected`
  // silently: module `room` stays set, pollers keep running, the wake
  // lock stays held, and the UI keeps rendering live in-call controls
  // on a dead room. Route a terminal disconnect through the existing
  // full-cleanup path (it's idempotent against an already-disconnected
  // room). Guarded on identity so a stale event from a previous Room
  // can't tear down a newer session.
  r.on(RoomEvent.Disconnected, (() => {
    if (room === (r as unknown as RoomLike)) {
      publishConnectionState('disconnected');
      // Queue the teardown and RE-CHECK ownership when it runs. A channel
      // switch disconnects the old Room from inside a connect, so this
      // event fires while that connect still holds the chain — by the time
      // we reach the front of the queue the module may already own a
      // healthy new Room, which this teardown must not touch.
      void serialized(async () => {
        if (room !== (r as unknown as RoomLike)) return;
        await performDisconnect();
      });
      return;
    }
    // This Room is an ORPHAN: a newer session owns the module, and the
    // SFU has just evicted us (DUPLICATE_IDENTITY) or we were replaced.
    // The identity guard above correctly keeps us away from module state,
    // but that used to mean the orphan ran NO cleanup at all — its audio
    // sinks stayed in the DOM, its prefs subscription stayed live, and its
    // pollers kept ticking for the lifetime of the tab. Release what this
    // Room owns, and only that.
    releaseRoomResources(r as unknown as RoomInternals);
  }) as never);
  // Surface SDK-internal reconnect attempts so the UI can show a
  // "reconnecting…" banner instead of appearing healthy-but-silent.
  r.on(RoomEvent.Reconnecting, (() => {
    if (room === (r as unknown as RoomLike)) publishConnectionState('reconnecting');
  }) as never);
  // A SIGNAL-only resume (the RR_SIGNAL_DISCONNECTED we see in production)
  // emits SignalReconnecting, NOT Reconnecting — media keeps flowing over
  // the existing PeerConnection while the WebSocket is re-established. On
  // Reconnecting alone the UI reported a perfectly healthy call during
  // every one of those outages.
  r.on(RoomEvent.SignalReconnecting, (() => {
    if (room === (r as unknown as RoomLike)) publishConnectionState('reconnecting');
  }) as never);
  // Recovery from BOTH paths lands here: the SDK emits Reconnected on
  // EngineEvent.Resumed, which is the tail of a signal-only resume too.
  r.on(RoomEvent.Reconnected, (() => {
    if (room === (r as unknown as RoomLike)) publishConnectionState('connected');
  }) as never);

  // Speaking indicator: LiveKit emits ActiveSpeakersChanged with the
  // full current speaker set on every transition. Build a Set<userId>
  // for cheap membership lookups, push it through the global pub/sub
  // (so any subscriber re-renders) and through the optional caller
  // callback. Identity matches the JWT we minted (= snowflake string).
  r.on(RoomEvent.ActiveSpeakersChanged, ((speakers: unknown) => {
    const set = new Set<string>();
    for (const p of speakers as Array<{ identity: string }>) set.add(p.identity);
    // The LOCAL speaking flag is owned exclusively by the local VAD
    // monitor (startLocalLevelMonitor), which is the only signal that
    // honors mutedFlag. LiveKit's active-speaker set can still contain
    // the local participant (its own audio analysis doesn't know about
    // our client-side mute), so if we let it through here it lights up
    // our own tile while muted. Strip the local identity from the SDK
    // set and re-add it ONLY when the VAD currently has us speaking AND
    // we're not muted — keeping the local tile flicker-free when we are
    // genuinely talking, and dark the instant we mute.
    if (localIdentity) {
      set.delete(localIdentity);
      if (!mutedFlag && currentSpeakers.has(localIdentity)) {
        set.add(localIdentity);
      }
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
      // eslint-disable-next-line no-console
      console.log('[voice] ActiveSpeakersChanged', { speakers: Array.from(set) });
    }
    publishSpeakers(set);
    args.onSpeakersChange?.(set);
  }) as never);

  // Per-participant speaking detection. ActiveSpeakersChanged alone
  // is not always reliable for remote tiles — some LiveKit / SFU
  // configurations debounce or threshold the active-speakers set,
  // so short utterances or rapid speaker changes can be missed. The
  // per-participant IsSpeakingChanged event fires on every flip and
  // is the most reliable signal for "this remote just started/stopped
  // talking." We listen for it on every remote participant (existing
  // ones when we connect, plus future ones via ParticipantConnected),
  // and toggle them in currentSpeakers.
  type SpeakingParticipant = { identity: string; isSpeaking: boolean; on(ev: unknown, fn: () => void): void };
  const attachSpeakingListener = (p: SpeakingParticipant) => {
    p.on(ParticipantEvent.IsSpeakingChanged, () => {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
        // eslint-disable-next-line no-console
        console.log('[voice] IsSpeakingChanged', { identity: p.identity, isSpeaking: p.isSpeaking });
      }
      const next = new Set(currentSpeakers);
      if (p.isSpeaking) next.add(p.identity);
      else next.delete(p.identity);
      publishSpeakers(next);
    });
  };
  // Per-participant connection quality (F5). LiveKit continuously
  // re-estimates each link's health and fires ConnectionQualityChanged
  // on every transition; we read `p.connectionQuality` and surface it
  // per tile as signal bars. We track remotes AND the local participant
  // (the SDK reports the local uplink quality too), seeding each with
  // its current value on attach so a tile whose quality never changes
  // still gets an initial reading.
  type QualityParticipant = {
    identity: string;
    connectionQuality?: unknown;
    on(ev: unknown, fn: () => void): void;
  };
  const attachQualityListener = (p: QualityParticipant) => {
    const update = () => {
      const next = new Map(currentQuality);
      next.set(p.identity, normalizeVoiceQuality(p.connectionQuality));
      publishQuality(next);
    };
    p.on(ParticipantEvent.ConnectionQualityChanged, update);
    update();
  };

  // Wire up any remotes that were already present when we connected
  // (the ParticipantConnected event won't fire retroactively for them).
  for (const [, p] of r.remoteParticipants as Map<string, SpeakingParticipant & QualityParticipant>) {
    attachSpeakingListener(p);
    attachQualityListener(p);
  }
  attachQualityListener(r.localParticipant as unknown as QualityParticipant);
  r.on(RoomEvent.ParticipantConnected, ((p: unknown) => {
    attachSpeakingListener(p as SpeakingParticipant);
    attachQualityListener(p as QualityParticipant);
  }) as never);
  r.on(RoomEvent.ParticipantDisconnected, ((p: unknown) => {
    const identity = (p as { identity: string }).identity;
    if (currentQuality.has(identity)) {
      const nextQ = new Map(currentQuality);
      nextQ.delete(identity);
      publishQuality(nextQ);
    }
    if (!currentSpeakers.has(identity)) return;
    const next = new Set(currentSpeakers);
    next.delete(identity);
    publishSpeakers(next);
  }) as never);

  // Local connection round-trip time (ms) for the header connection pill.
  // The subscriber PeerConnection's nominated candidate-pair carries the live
  // RTT; we sample it ~1Hz. The SDK's RTCEngine is @internal, so we reach the
  // PC defensively (optional chaining + try/catch) and just skip a tick if the
  // shape isn't there. `currentRoundTripTime` is in seconds → ×1000 for ms.
  const pollRtt = () => {
    const pc = (r as unknown as {
      engine?: { pcManager?: { subscriber?: { getStats?: () => Promise<RTCStatsReport> } } };
    }).engine?.pcManager?.subscriber;
    if (!pc?.getStats) return;
    pc.getStats()
      .then((report) => {
        if (room !== (r as unknown as RoomLike)) return; // a newer session owns the module now
        let rttMs: number | null = null;
        report.forEach((s) => {
          const st = s as { type?: string; state?: string; currentRoundTripTime?: number };
          if (
            st.type === 'candidate-pair' &&
            st.state === 'succeeded' &&
            typeof st.currentRoundTripTime === 'number'
          ) {
            rttMs = Math.round(st.currentRoundTripTime * 1000);
          }
        });
        publishRtt(rttMs);
      })
      .catch(() => {});
  };
  // Per-Room, not module-level: a second connect used to overwrite the
  // module handle, so the first Room's poller ran until the tab closed.
  (r as unknown as RoomInternals)._rttPoll = window.setInterval(pollRtt, 1000);
  pollRtt();

  // ── Audio-level polling fallback ──────────────────────────────────────
  //
  // Belt-and-suspenders for remote speaking detection. The event-based
  // approach above CAN fail silently in some LiveKit / SFU configs —
  // ActiveSpeakersChanged debounces, IsSpeakingChanged may not fire
  // for remote tracks, and there's no client-side way to know whether
  // the SDK's higher-level isSpeaking machinery is even computing for
  // a given remote. We sidestep all of that by polling each remote's
  // `.audioLevel` property directly — the SDK updates this on every
  // audio frame from the actual decoded stream, so the value is always
  // current regardless of what events do or don't fire.
  //
  // 100ms interval is 10Hz, plenty for visual smoothness. Each tick is
  // O(remotes) and the loop body is just numeric comparison + Set ops,
  // negligible CPU.
  //
  // Threshold 0.025 (~2.5% of full scale) matches typical VAD floors
  // — high enough to reject noise/static, low enough to catch every
  // audible utterance.
  type WithAudioLevel = { identity: string; audioLevel?: number };
  const REMOTE_SPEAKING_THRESHOLD = 0.025;
  const remoteSpeakingSet = new Set<string>(); // tracks our poll's view
  // Stashed on the Room for the same reason as the RTT poller above.
  (r as unknown as RoomInternals)._speakingPoll = window.setInterval(() => {
    if (room !== (r as unknown as RoomLike)) return; // a newer session owns the module now
    let changed = false;
    // Walk every remote; flip them in/out of remoteSpeakingSet based
    // on their current audioLevel.
    for (const [, p] of r.remoteParticipants as Map<string, WithAudioLevel>) {
      const level = p.audioLevel ?? 0;
      const isLoud = level > REMOTE_SPEAKING_THRESHOLD;
      const was = remoteSpeakingSet.has(p.identity);
      if (isLoud && !was) {
        remoteSpeakingSet.add(p.identity);
        changed = true;
      } else if (!isLoud && was) {
        remoteSpeakingSet.delete(p.identity);
        changed = true;
      }
    }
    // Also prune any IDs in our poll set that no longer correspond to
    // a connected remote (defensive — disconnect events should handle
    // this, but if one was missed we don't want stale speaking state).
    for (const id of remoteSpeakingSet) {
      if (!(r.remoteParticipants as Map<string, unknown>).has(id)) {
        remoteSpeakingSet.delete(id);
        changed = true;
      }
    }
    if (!changed) return;
    // Reconcile currentSpeakers: take its current value, drop any
    // remote we now know isn't speaking, add any remote we now know
    // IS speaking. We don't touch the local identity here — local
    // VAD owns that flag and merges itself in via startLocalLevelMonitor.
    const next = new Set(currentSpeakers);
    // First: remove every remote from `next` that isn't in our
    // poll set anymore.
    for (const id of next) {
      if (id === localIdentity) continue; // leave local alone
      if (!remoteSpeakingSet.has(id)) next.delete(id);
    }
    // Then: add every remote currently in our poll set.
    for (const id of remoteSpeakingSet) next.add(id);
    publishSpeakers(next);
  }, 100);

  // Set of tracks we've attached an 'ended' listener to, so we don't
  // double-add. Tracks are GC'd along with their publications, so
  // we don't need to clean up explicitly — the WeakSet handles it.
  const endedTrackListeners = new WeakSet<MediaStreamTrack>();
  const attachEndedListener = (mst: MediaStreamTrack, isLocalScreen: boolean) => {
    if (endedTrackListeners.has(mst)) return;
    endedTrackListeners.add(mst);
    // Once-only listener that triggers a rebuild when this track
    // transitions to readyState === 'ended'. LiveKit's RoomEvent
    // teardown can lag the actual track end on some flows (e.g.
    // Chrome's native "Stop sharing" button), and the track itself
    // is the most reliable signal that the source is dead.
    mst.addEventListener(
      'ended',
      () => {
        rebuildTracks();
        if (!isLocalScreen) return;
        // OUR screen capture ended at the SOURCE — the browser's own "Stop
        // sharing" bar, the shared window closing, or the display going
        // away. (A stop we initiate goes through track.stop(), which by
        // spec does NOT fire 'ended', so this is never our own button.)
        // livekit-client unpublishes ScreenShare tracks on end, so the tile
        // vanishes for everyone while this client says nothing — leaving
        // the user broadcasting nothing and believing they still are, with
        // a genuine capture death indistinguishable from a bug.
        // eslint-disable-next-line no-console
        console.warn('[voice] screen share ended at the capture source');
        publishVoiceError(
          new VoiceError(
            'screenshare_ended',
            'Your screen share ended. If you didn’t stop it, the shared window or display went away — start it again to keep sharing.',
          ),
        );
      },
      { once: true },
    );
  };

  // Remote-track publish/unpublish: rebuild the track list from
  // scratch on each event — simpler than diffing, and the list is
  // always small (≤ N participants × 2 tracks each).
  const rebuildTracks = () => {
    const tiles: VoiceTrackInfo[] = [];
    for (const [, p] of r.remoteParticipants as Map<string, RemoteParticipantLike>) {
      for (const [, pub] of p.trackPublications as Map<string, TrackPublicationLike>) {
        if (pub.kind !== 'video' || !pub.track || !pub.track.mediaStreamTrack) continue;
        // isSubscribed=false means the publisher unpublished —
        // even before TrackUnpublished/TrackUnsubscribed fire on
        // some SDK/server pairings, this flag flips. Stricter
        // inclusion gate than event-only listening, which can lag
        // or miss the unpublish entirely.
        if (pub.isSubscribed === false) continue;
        const mst = pub.track.mediaStreamTrack;
        // Skip ended tracks — the publisher has stopped this stream.
        // The publication may linger in the Map briefly between when
        // the track ends and when LiveKit fires the unpublish event.
        // Without this check, we'd render a FeaturedTile with a
        // frozen final frame for that interval.
        if (mst.readyState === 'ended') continue;
        const isScreen = pub.source === 'screen_share';
        // Remote shares ending is just someone else stopping — no notice.
        attachEndedListener(mst, false);
        tiles.push({
          userId: p.identity,
          kind: isScreen ? 'screen' : 'camera',
          track: mst,
          trackSid: pub.trackSid,
        });
      }
    }
    const localPubs = r.localParticipant as unknown as { trackPublications: Map<string, TrackPublicationLike> };
    for (const [, pub] of localPubs.trackPublications) {
      if (pub.kind !== 'video' || !pub.track || !pub.track.mediaStreamTrack) continue;
      const mst = pub.track.mediaStreamTrack;
      if (mst.readyState === 'ended') continue;
      const isScreen = pub.source === 'screen_share';
      attachEndedListener(mst, isScreen);
      tiles.push({
        userId: r.localParticipant.identity,
        kind: isScreen ? 'screen' : 'camera',
        track: mst,
        trackSid: pub.trackSid,
      });
    }
    publishTracks(tiles);
    args.onTracksChange?.(tiles);
  };

  // Polling safety net. Events sometimes don't propagate cleanly
  // across LiveKit SDK/server version pairings (server 1.5 vs 1.6,
  // client 2.6 vs 2.7), particularly on the autosubscribe +
  // adaptive-stream + screen-share teardown path. Every second,
  // check the live state of every track we're currently tracking
  // against its publication; if any has gone stale, rebuild. The
  // check is cheap — handful of property reads.
  const stalePoll = window.setInterval(() => {
    // An orphan Room (evicted by a newer session) has no participants
    // left, so every tracked track reads as stale and the rebuild below
    // publishes an EMPTY list — blanking the live call's screen shares
    // and cameras once a second. Same guard the RTT poller uses.
    if (room !== (r as unknown as RoomLike)) return;
    let anyStale = false;
    for (const t of currentTracks) {
      // Find this track's publication. Walk remote first then local.
      let found = false;
      let pub: TrackPublicationLike | null = null;
      for (const [, p] of r.remoteParticipants as Map<string, RemoteParticipantLike>) {
        const map = p.trackPublications as Map<string, TrackPublicationLike>;
        for (const [, pp] of map) {
          if (pp.trackSid === t.trackSid) {
            pub = pp;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        const localPubs = r.localParticipant as unknown as { trackPublications: Map<string, TrackPublicationLike> };
        for (const [, pp] of localPubs.trackPublications) {
          if (pp.trackSid === t.trackSid) {
            pub = pp;
            found = true;
            break;
          }
        }
      }
      if (!found || !pub) {
        // Publication gone entirely (publisher unpublished, SDK
        // cleared the map).
        anyStale = true;
        break;
      }
      if (pub.isSubscribed === false) {
        anyStale = true;
        break;
      }
      if (!pub.track || !pub.track.mediaStreamTrack) {
        anyStale = true;
        break;
      }
      if (pub.track.mediaStreamTrack.readyState === 'ended') {
        anyStale = true;
        break;
      }
    }
    if (anyStale) rebuildTracks();
  }, 1000);
  // Stash the interval so disconnectVoice can clear it. We attach
  // it to the room as a non-enumerable property to avoid leaking
  // a module-level handle.
  (r as unknown as RoomInternals)._stalePoll = stalePoll;
  r.on(RoomEvent.TrackSubscribed, rebuildTracks as never);
  r.on(RoomEvent.TrackUnsubscribed, rebuildTracks as never);
  // TrackUnpublished fires immediately when a REMOTE publisher kills
  // their track (e.g. they stopped their camera). Without listening
  // here, the only signal we'd get is TrackUnsubscribed — which may
  // lag the actual publisher-side stop, leaving the viewer staring
  // at the last frame for a few seconds before the tile finally
  // disappears. Listening to both events makes the takedown crisp:
  // whichever fires first triggers the rebuild.
  r.on(RoomEvent.TrackUnpublished, rebuildTracks as never);
  r.on(RoomEvent.LocalTrackPublished, rebuildTracks as never);
  r.on(RoomEvent.LocalTrackUnpublished, rebuildTracks as never);
  // TrackMuted on a REMOTE track means the publisher disabled the
  // track without unpublishing. The <video> element keeps the last
  // frame indefinitely. We rebuild so the muted track gets filtered
  // out of the rendered list — FeaturedTile separately listens for
  // mute on the underlying MediaStreamTrack and falls back to the
  // avatar, but rebuilding is cheap and adds a second safety net.
  r.on(RoomEvent.TrackMuted, rebuildTracks as never);
  r.on(RoomEvent.TrackUnmuted, rebuildTracks as never);

  // ── Remote audio: route through hidden <video> elements ─────────────
  //
  // On iOS Safari, when the page has an active getUserMedia microphone
  // stream, the OS treats the page as a "voice call" and routes ALL
  // audio output to the EARPIECE (small ear speaker), not the
  // loudspeaker. The fix is to attach remote audio tracks to a
  // `<video playsinline>` element instead of `<audio>`. Video elements
  // get classified as "media playback" and route to the loudspeaker
  // even with a hot mic. The element is invisible (0×0, opacity:0)
  // because we only want the audio routing side-effect.
  //
  // We do this for every device/browser, not just iOS, because:
  //   - On non-iOS the behavior is identical to <audio>
  //   - The duplication-with-LiveKit's-own-attach risk is mitigated
  //     by setting muted=true on those auto-attached audio elements
  //     when we find them via the SDK's track API (next pass)
  //
  // The element is appended to body; cleanup happens on
  // TrackUnsubscribed below to avoid orphan elements on participant
  // churn.
  //
  // (Audio chain map is declared further down alongside the WebAudio
  // routing — that's the source of truth for sinks now.)

  /**
   * iOS Safari blocks autoplay of media elements (even muted ones can
   * sometimes get blocked) without an active user gesture. When a new
   * remote participant joins LATER — after the join-room click has
   * lapsed — TrackSubscribed fires, we create our `<video>` audio sink,
   * call play(), and it rejects with NotAllowedError. The audio sits
   * silent until something fixes it.
   *
   * The fix: install a one-shot capture-phase listener on the document
   * for the next user gesture (touch/click/key). When fired, retry
   * play() on every queued audio element, then remove the listener.
   * The user perceives this as "tap anywhere to unmute" though most of
   * the time their natural next interaction (saying something, hitting
   * a button) will silently kick the audio loose.
   */
  let pendingGesture = false;
  function armPlayOnGesture(_el: HTMLMediaElement) {
    if (pendingGesture) return;
    pendingGesture = true;
    const tryPlay = () => {
      pendingGesture = false;
      for (const chain of audioChainsByTrackSid.values()) {
        chain.element.play().catch(() => undefined);
      }
      document.removeEventListener('pointerdown', tryPlay, true);
      document.removeEventListener('keydown', tryPlay, true);
      document.removeEventListener('touchstart', tryPlay, true);
    };
    document.addEventListener('pointerdown', tryPlay, true);
    document.addEventListener('keydown', tryPlay, true);
    document.addEventListener('touchstart', tryPlay, true);
  }

  // ── Remote-audio playback chains keyed by trackSid ─────────────────
  //
  // We use LiveKit's built-in `track.attach()` rather than routing
  // through WebAudio. The WebAudio approach (MediaStreamSource →
  // GainNode → MediaStreamDestination → element) is appealing because
  // it lets us scale volume above 100%, but it's fragile in practice:
  //
  //   - The AudioContext gets created in `suspended` state when we
  //     instantiate it inside an async TrackSubscribed callback
  //     (modern autoplay policies), and resume() doesn't always re-
  //     light a chain that's been suspended on creation. Net effect:
  //     audio is silent on both sides of the call until the user
  //     happens to click somewhere again — no visible failure mode.
  //   - MediaStreamSource on a remote RTC track is a known
  //     compatibility minefield across Chrome and Safari versions.
  //
  // Trade: per-user volume is now capped at 0..100% rather than 0..200%.
  // That's fine for v1 — "I can't hear my friends" is a hard failure,
  // "I can't boost user X by 1.5×" is a nicety.
  interface AudioChain {
    /** LiveKit-managed audio element (returned by track.attach()). */
    element: HTMLMediaElement;
    /** The owning participant's user id, used to look up prefs. */
    userId: string;
    /** Keep a reference to the LiveKit track so we can detach on
        unsubscribe — LiveKit cleans up its internal MediaStream
        listeners only when detach() is called. */
    track: { detach?: (el?: HTMLMediaElement) => HTMLMediaElement | HTMLMediaElement[] };
  }
  const audioChainsByTrackSid = new Map<string, AudioChain>();
  function applyGainForChain(chain: AudioChain) {
    const userGain = voicePrefs.computeUserGain(chain.userId);
    // Clamp to 0..1 — HTMLMediaElement.volume doesn't accept higher.
    // computeUserGain can return up to 2 (200%); we silently floor
    // to 1 here. Volumes > 100% would require routing back through
    // WebAudio — see the class comment above for why we don't.
    const effective = deafenedFlag ? 0 : Math.min(1, userGain);
    chain.element.volume = effective;
  }
  function applyGainForAllChains() {
    for (const chain of audioChainsByTrackSid.values()) {
      applyGainForChain(chain);
    }
  }
  // React to per-user / master volume changes from the UI. The
  // unsubscribe is stashed on the room for leaveVoice to call.
  const unsubscribePrefs = voicePrefs.subscribeVoicePrefs(applyGainForAllChains);

  r.on(RoomEvent.TrackSubscribed, ((track: unknown, publication: unknown, participant: unknown) => {
    const t = track as {
      kind?: string;
      attach?: () => HTMLMediaElement;
      detach?: (el?: HTMLMediaElement) => HTMLMediaElement | HTMLMediaElement[];
      mediaStreamTrack?: MediaStreamTrack;
    };
    const pub = publication as { trackSid?: string };
    const part = participant as { identity?: string };
    if (t.kind !== 'audio' || !t.attach || !pub.trackSid) return;
    const userId = part.identity ?? '';
    // If we already attached this sid (re-subscribe race), drop the
    // prior chain cleanly so the new attach owns the element. Detach
    // can throw if LiveKit already tore the track down internally;
    // we don't care — the element is going away regardless.
    const existing = audioChainsByTrackSid.get(pub.trackSid);
    if (existing) {
      try {
        existing.track.detach?.(existing.element);
      } catch {
        // see comment above
      }
      existing.element.remove();
      audioChainsByTrackSid.delete(pub.trackSid);
    }
    // LiveKit's attach() creates an <audio> element pre-wired to the
    // remote stream. It handles MSE quirks, autoplay retries on
    // mobile, etc. Much more robust than rolling our own element.
    const element = t.attach();
    element.setAttribute('data-zk-audio-sink', '1');
    element.style.display = 'none';
    document.body.appendChild(element);

    const chain: AudioChain = { element, userId, track: t };
    audioChainsByTrackSid.set(pub.trackSid, chain);
    applyGainForChain(chain);

    // Attach our own WebAudio probe to the decoded MediaStreamTrack.
    // This drives the speaking indicator regardless of whether
    // LiveKit's audioLevel / IsSpeakingChanged signals work in this
    // SFU configuration. See attachRemoteSpeakerProbe above for the
    // full rationale.
    if (t.mediaStreamTrack && userId) {
      attachRemoteSpeakerProbe(pub.trackSid, userId, t.mediaStreamTrack);
    }

    // Element.play() may reject on iOS if no user gesture is active.
    // The room is joined via a click so we're usually in-gesture, but
    // late-joining participants subscribe AFTER our gesture has
    // lapsed; play() rejects with NotAllowedError there. The one-shot
    // gesture listener retries on the user's next click.
    element.play().catch((err: unknown) => {
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError') {
        armPlayOnGesture(element);
      }
    });
  }) as never);
  r.on(RoomEvent.TrackUnsubscribed, ((track: unknown, publication: unknown) => {
    const pub = publication as { trackSid?: string };
    if (!pub.trackSid) return;
    // Tear down our WebAudio speaker probe FIRST so its interval
    // stops before we drop other state.
    detachRemoteSpeakerProbe(pub.trackSid);
    const chain = audioChainsByTrackSid.get(pub.trackSid);
    if (chain) {
      // Detach with the `this` correctly bound to the track object —
      // calling an extracted method via `(t?.detach ?? other)?.(...)`
      // drops the `this` reference and LiveKit's detach() then
      // crashes on `this.attachedElements`. We branch instead so the
      // method call retains its receiver. Try/catch guards against
      // LiveKit throwing because the track was already torn down by
      // a prior cleanup path.
      const t = track as {
        detach?: (el?: HTMLMediaElement) => HTMLMediaElement | HTMLMediaElement[];
      };
      try {
        if (t && typeof t.detach === 'function') {
          t.detach(chain.element);
        } else if (typeof chain.track.detach === 'function') {
          chain.track.detach(chain.element);
        }
      } catch {
        // Best-effort cleanup; the element is removed from the DOM
        // below either way, so a detach failure just means LiveKit
        // can't free its internal pointer to the element. The
        // garbage collector handles it once we drop our reference.
      }
      chain.element.remove();
      audioChainsByTrackSid.delete(pub.trackSid);
    }
  }) as never);
  // Stash the cleanup on the room so leaveVoice can purge any
  // remaining elements (covers edge cases where TrackUnsubscribed
  // doesn't fire before disconnect).
  (r as unknown as { _audioCleanup?: () => void })._audioCleanup = () => {
    unsubscribePrefs();
    for (const chain of audioChainsByTrackSid.values()) {
      // detach() returns the element(s); we still own the DOM node,
      // so explicitly remove from the body. Wrap in try/catch in case
      // LiveKit already disposed the track and detach throws on
      // missing internal state.
      try {
        chain.track.detach?.(chain.element);
      } catch {
        // best-effort
      }
      chain.element.remove();
    }
    audioChainsByTrackSid.clear();
  };
  // Exposed so setDeafened (which lives at module scope and can't
  // reach into this closure otherwise) can rerun the per-chain gain
  // computation without re-implementing it.
  (r as unknown as { _reapplyGains?: () => void })._reapplyGains = applyGainForAllChains;
  r.on(RoomEvent.ParticipantDisconnected, rebuildTracks as never);

  // Connect first, then enable the mic. Connecting establishes the
  // WebSocket signaling channel + ICE; enabling the mic publishes the
  // local track. Doing them in this order means a connect failure
  // doesn't leave us with a hot mic the user thought wasn't on.
  try {
    await r.connect(args.wsUrl, args.token);
  } catch (err) {
    // Connect failed — make sure the E2EE worker (if we spun one up for
    // this call) doesn't outlive the dead Room.
    terminateE2eeWorker();
    // This Room never became `room`, so no teardown path will ever reach
    // it — but its pollers and audio sinks were wired up before connect.
    releaseRoomResources(r as unknown as RoomInternals);
    // The intent claim dies with this join — dropped by connectToVoice's
    // finally, which is the one place that knows whether a LATER join is
    // already waiting with a claim of its own.
    //
    // Rejected because the user hung up — hangUpVoice's Room.disconnect()
    // ("Client initiated disconnect"), or a real failure that raced it:
    // either way this join was cancelled, not failed.
    if (gen !== hangupGen) {
      // LiveKit rejects the pending connect FIRST and only then sends its
      // leave and closes the engine. Wait for that close (this call queues
      // behind the hang-up's on the Room's own lock) before letting the
      // chain move on, or the next join's Room starts connecting while
      // this one still holds our identity on the server.
      try {
        await r.disconnect();
      } catch {
        // Closing already; nothing more to wait for.
      }
      throw cancelledError();
    }
    const msg = (err as Error).message ?? 'connection failed';
    throw new VoiceError('connect_failed', `Couldn't reach voice server: ${msg}`);
  }
  // Connected, but the user hung up as it resolved (too late for LiveKit's
  // cancel to abort it). Undo it HERE, before the Room becomes `room`:
  // nothing outside this function has seen it yet, so no other teardown
  // path would ever reach it.
  if (gen !== hangupGen) {
    try {
      await r.disconnect();
    } catch {
      // Already closing under the hang-up's own cancel.
    }
    releaseRoomResources(r as unknown as RoomInternals);
    terminateE2eeWorker();
    throw cancelledError();
  }

  // Claim the Room as the active session AS SOON AS connect succeeds —
  // before any mic publish — so that if a later step throws (e.g. a
  // listen-only / stage-audience token rejects setMicrophoneEnabled with
  // a 403), disconnectVoice() can actually tear the connection down
  // instead of no-opping on a null `room` and leaking the live Room +
  // its pollers + the prefs subscription forever.
  room = r as unknown as RoomLike;
  localIdentity = r.localParticipant.identity;
  // Track the connected channel for the self-move detector. Set for
  // EVERY join (guild/stage/DM) the moment we have it — the prior code
  // only set this for calls that passed channelId (DM calls), so a
  // moderator dragging a web user between GUILD voice channels never
  // reconnected them (getConnectedChannelId() was null → the detector
  // early-returned and the user's audio silently died in the old room).
  connectedChannelId = args.channelId ?? null;
  // Settled state now describes this join, so its claim has done its job.
  if (args.channelId) releaseVoiceChannel(args.channelId);
  // Own the session for the takeover watcher from the SAME instant. This
  // used to be claimed at the very end of the connect, after mic publish,
  // output switching, PTT and gain setup — so when two joins raced, the
  // module kept whichever finished LAST rather than whichever the server
  // kept, and the watcher then tore the user out of their own call. A
  // failure after this point tears down through disconnectVoice(), which
  // clears it again. A caller that passes no sessionId leaves it null:
  // takeover detection just doesn't fire on this device.
  activeSessionId = args.sessionId ?? null;
  publishConnectionState('connected');

  const localPubs = r.localParticipant as unknown as { trackPublications: Map<string, TrackPublicationLike> };

  // Publish the mic only for publishing contexts. Stage AUDIENCE (and
  // AFK / voice-disabled channels) get canPublish=false tokens, and
  // LiveKit throws a 403 PublishTrackError if we try to publish under
  // one — which is exactly the leak above. `args.publish === false`
  // marks those listen-only joins so we skip the mic entirely (they
  // still subscribe and hear everyone).
  if (wantPublish) {
    // Raced against a hang-up rather than awaited outright: LiveKit can park
    // a publish the hang-up interrupted for its 15 s publish timeout (see
    // stopOrphanedMicCapture), and the chain — the next join — must not
    // wait that out.
    const publishing = r.localParticipant.setMicrophoneEnabled(
      true,
      inputDeviceId ? { deviceId: inputDeviceId } : undefined,
    );
    let published: Awaited<typeof publishing> | typeof HUNG_UP;
    try {
      published = await orHangUp(publishing, gen);
    } catch (err) {
      // Publishing failed on a token we believed could publish — tear
      // the whole connection down (now safe because `room` is set) and
      // surface a clear error rather than stranding a half-joined room.
      // Raw teardown — we're inside the serial chain (see performConnect).
      await performDisconnect();
      // A hang-up closed the engine under the pending publish (that is
      // what rejected it): cancelled, not a microphone failure.
      if (gen !== hangupGen) throw cancelledError();
      throw new VoiceError(
        'connect_failed',
        `Couldn't start your microphone: ${(err as Error)?.message ?? 'unknown error'}`,
      );
    }
    if (published === HUNG_UP) {
      // Hung up mid-publish: the capture LiveKit may still be opening is
      // ours to stop, then the same silent teardown as the checkpoint below.
      stopOrphanedMicCapture(r.localParticipant, publishing, ParticipantEvent.AudioStreamAcquired);
      await performDisconnect();
      throw cancelledError();
    }
    // Mic is live after the call above, so the local mute state is false.
    // Reset explicitly: mutedFlag is module-scoped and could otherwise
    // carry a stale `true` from a previous session into this join (the PTT
    // branch below re-sets it to true when appropriate).
    mutedFlag = false;
  }

  // Hung up during the publish, or as it resolved: the join never finished,
  // so it ends without a sound — the hangup chime isn't armed yet, so this
  // teardown is silent, and the connect chime below never plays.
  if (gen !== hangupGen) {
    await performDisconnect();
    throw cancelledError();
  }

  // Connect chime. Placed AFTER the mic publish, not at the `connected`
  // transition above, because the publish failure path tears the room back
  // down — chiming earlier would narrate a connect-then-hangup pair for a
  // join that never actually happened (the user gets an error toast instead).
  //
  // This is a genuine join by construction: connectToVoice() is never the
  // reconnect path. LiveKit's own resume fires RoomEvent.Reconnected and
  // republishes 'connected' without coming back through here, so a flapping
  // network can't machine-gun this sound.
  //
  // Arming the hangup chime here (and only here) is what makes the end-of-call
  // sound exactly-once per successfully-joined session.
  hangupChimeArmed = true;
  playCallConnect();

  // Apply saved output device after connect — switchActiveDevice needs
  // a live Room. Failures here are non-fatal (Firefox/Safari may not
  // support output switching at all); the audio still plays through
  // the system default.
  const outputDeviceId = getSavedOutputDeviceId();
  if (outputDeviceId) {
    try {
      await r.switchActiveDevice('audiooutput', outputDeviceId);
    } catch {
      // Best effort.
    }
  }

  // Initial track snapshot so the UI doesn't have to wait for the
  // first track event before rendering empty/non-empty state.
  rebuildTracks();

  // Mic-publish-dependent setup. None of this applies to a listen-only
  // join (no published track to monitor, gain, process, or PTT-toggle).
  if (wantPublish) {
    // PTT keyboard listeners. Installed once per page load — checking
    // the audio mode from localStorage on each event so changes from the
    // settings UI take effect immediately without re-installing.
    installPttListeners();

    // If the user is in PTT mode, mute by default. They have to push the
    // key to talk. This MUST happen after setMicrophoneEnabled(true)
    // above; LiveKit otherwise wouldn't have a published audio track to
    // toggle on/off via the keyboard listener.
    if (getAudioMode() === 'ptt') {
      mutedFlag = true;
      try {
        await r.localParticipant.setMicrophoneEnabled(false);
      } catch (err) {
        // A hang-up closed the Room under us: the checkpoint at the end of
        // this setup ends the join. Anything else fails it, as before.
        if (gen === hangupGen) throw err;
      }
    }

    // Start the local-level monitor so the user's own tile shows the
    // green ring when they speak. The monitor reads the actual published
    // mic track, so we need to grab it after setMicrophoneEnabled(true).
    // Walk the local participant's track publications to find the audio
    // track LiveKit just published.
    for (const [, pub] of localPubs.trackPublications) {
      if (pub.kind === 'audio' && pub.track?.mediaStreamTrack) {
        startLocalLevelMonitor(pub.track.mediaStreamTrack);
        break;
      }
    }

    // Manual gain mode: replace the captured mic track with a
    // Web-Audio-gained version so the user's `micGain` slider
    // actually affects the published signal. Only relevant when
    // gainMode === 'manual' — 'agc' and 'off' both leave the
    // LiveKit-captured track alone. Best-effort: if the replace
    // fails (browser compat edge case, LiveKit internal change in
    // a future version) we keep the un-gained track and log; voice
    // still works, the slider just has no effect.
    //
    // Skipped once the user has hung up: it opens a second mic capture,
    // and the checkpoint below is about to end the call anyway.
    if (audioPrefs.gainMode === 'manual' && gen === hangupGen) {
      for (const [, pub] of localPubs.trackPublications) {
        if (pub.kind === 'audio' && pub.track && 'replaceTrack' in pub.track) {
          try {
            const { activateManualGain } = await import('./manualGain');
            await activateManualGain({
              liveKitTrack: pub.track as unknown as Parameters<typeof activateManualGain>[0]['liveKitTrack'],
              inputDeviceId,
            });
          } catch (err) {
            // Non-fatal — voice continues with the un-gained track.
            // The user will see the slider in settings but it won't
            // affect the live published signal until next reconnect.
            // eslint-disable-next-line no-console
            console.warn('manual gain activation failed:', err);
          }
          break;
        }
      }
    }

    // Noise/compression processing chain — runs as a LiveKit
    // TrackProcessor on top of whatever the mic track is at this
    // point (raw browser-captured OR manual-gain-replaced if the
    // user is in that mode). Adds high-pass / compressor / low-pass
    // / makeup-gain stages targeting the noise classes browser-
    // native noiseSuppression doesn't catch — desk thumps, AC hum,
    // dynamic-range swings, hiss above the speech band. See
    // ./audioProcessor.ts for tuning rationale per stage.
    //
    // Gated on the existing noiseSuppression preference: if the
    // user has turned suppression off (they explicitly want raw
    // mic — maybe for music or for accessibility/processing
    // downstream), we skip this chain too. Consistent with their
    // intent rather than silently overriding it. (Skipped after a
    // hang-up too, like manual gain above.)
    if (audioPrefs.noiseSuppression && gen === hangupGen) {
      for (const [, pub] of localPubs.trackPublications) {
        if (pub.kind === 'audio' && pub.track && 'setProcessor' in pub.track) {
          try {
            const { createNoiseCompressor } = await import('./audioProcessor');
            await (pub.track as unknown as {
              setProcessor: (p: ReturnType<typeof createNoiseCompressor>) => Promise<void>;
            }).setProcessor(createNoiseCompressor());
          } catch (err) {
            // Non-fatal — voice continues without the processing
            // chain. The user is on the un-processed signal which
            // is still better than no audio. Log so a future bug
            // hunt has a starting point.
            // eslint-disable-next-line no-console
            console.warn('noise compressor activation failed:', err);
          }
          break;
        }
      }
    }
  }

  // Hung up during the setup above, right after the connect chime. The
  // join did finish, so this teardown is that session's one hangup chime
  // (armed above); nothing below — wake lock, media session, CallKit — is
  // set up for a call that is already over.
  if (gen !== hangupGen) {
    await performDisconnect();
    throw cancelledError();
  }

  // Background-stay-alive setup: ask the OS not to lock the screen
  // (Wake Lock API), register the page as an active audio source
  // (Media Session API), and wire the platform Hang Up button to
  // hang up. Without this the OS suspends mic capture as
  // soon as the screen locks, killing the call mid-conversation.
  // Best-effort — every API is feature-detected inside the helper.
  void enterCallBackgroundMode({
    title: args.backgroundTitle ?? 'Voice call',
    artist: 'Zekktris',
    onHangup: () => {
      // The user tapped Hang Up on the lock screen / in the browser's
      // media controls: a user hang-up like any in-app one. Through the
      // app's hang-up helper when it has registered one, so the server
      // hears about it too (a local-only teardown left the call row, and
      // the call UI, up with dead media); otherwise at least end it here.
      if (args.channelId && systemHangupHandler) systemHangupHandler(args.channelId);
      else void hangUpVoice();
    },
  });

  // Native iOS — register the outgoing call with CallKit. This
  // is the load-bearing call for "locked-screen audio works":
  // CallKit promotes our audio session to the elevated category
  // that iOS keeps alive when the screen locks. Without this,
  // wake-lock + media-session alone aren't enough; iOS strips mic
  // access on lock regardless. No-op on web (existing wake-lock
  // path stays in charge). Gated on `isDmCall` (not merely channelId):
  // CallKit should model 1:1 DM calls only — registering a guild-voice
  // or stage join as a CallKit "call" is wrong (and now that every join
  // passes channelId for move detection, a bare channelId check would
  // do exactly that).
  if (args.channelId && args.isDmCall) {
    activeChannelId = args.channelId;
    void (async () => {
      try {
        const { reportOutgoingCall, isNative } = await import('./native');
        if (!isNative()) return;
        await reportOutgoingCall({
          callId: args.channelId!,
          calleeName: args.backgroundTitle ?? 'Voice call',
        });
      } catch {
        // ignore — falls back to web wake-lock path
      }
    })();
  }
}

// Loose structural types for LiveKit's remote participant + publication
// objects — used by `rebuildTracks` above. Keeping them here avoids a
// type-export from livekit-client that would break the dynamic-import
// code-split.
interface RemoteParticipantLike {
  identity: string;
  trackPublications: Map<string, TrackPublicationLike>;
}
interface TrackPublicationLike {
  kind: string;
  source?: string;
  trackSid: string;
  /** LiveKit's view on the publication's subscription status. False
   *  on the subscriber side once the publisher has unpublished —
   *  even before TrackUnpublished/TrackUnsubscribed fire, depending
   *  on SDK/server version. Used as a stricter inclusion gate. */
  isSubscribed?: boolean;
  /** Publication-level muted flag. Distinct from the underlying
   *  MediaStreamTrack's `muted` property — the SDK sets this when
   *  the publisher mutes their track even if the local subscriber's
   *  MediaStreamTrack hasn't received the silence frames yet. */
  isMuted?: boolean;
  track?: {
    mediaStreamTrack?: MediaStreamTrack;
    /** LocalVideoTrack only. Re-acquires the camera through the SDK's
     *  `constraintsForOptions` from an explicit VideoCaptureOptions bag
     *  instead of the track's remembered `_constraints`. Optional here
     *  because the same structural type also describes REMOTE
     *  publications, which have no such method. */
    restartTrack?: (options?: {
      resolution?: { width: number; height: number; frameRate: number };
    }) => Promise<void>;
    /** The RTCRtpSender carrying this local track. Used to re-cap the
     *  encoder budget when the capture came back smaller than asked
     *  (see reconcileCameraCapture). Absent on remote publications. */
    sender?: RTCRtpSender;
  };
}

/**
 * Close the active voice connection. Safe to call when not connected —
 * returns immediately.
 *
 * `keepAudioContext` is set ONLY by the channel-switch reconnect path: that
 * path already primed the shared AudioContext inside the click gesture, and a
 * new connect follows immediately, so closing the context here would force it
 * to be re-created OUTSIDE the gesture (born suspended on Safari → speaking
 * rings stop lighting up until the next interaction). A real leave closes it.
 *
 * `silent` suppresses the end-of-call chime. Set it when the teardown isn't a
 * call ENDING from the user's point of view — a channel switch, a moderator
 * moving them, or another device taking the session over. All three are
 * followed by (or equivalent to) continuing to be in voice somewhere.
 *
 * Serialized against every other session op (see `serialized`), so it can
 * never run concurrently with a connect on the same Room. Callers already
 * inside the chain must use `performDisconnect` directly.
 *
 * It WAITS for a join in flight and never cancels one: this is the internal
 * teardown (channel switch, moderator-move rejoin, session takeover, stage
 * role change), each followed by a join of its own. A user ending the call
 * calls [hangUpVoice] instead.
 */
export function disconnectVoice(
  opts: { keepAudioContext?: boolean; silent?: boolean } = {},
): Promise<void> {
  // Deliberately does NOT clear claims: a disconnect is the FIRST half of
  // every channel switch, and the incoming join's claim must survive it.
  // Each claim is released by its own join settling, or by its caller.
  return serialized(() => performDisconnect(opts));
}

/**
 * Hang up: the USER ended the call — a Leave / Hang up / Cancel button, the
 * 1:1 auto-end, the eviction teardown, the OS media controls. Unlike
 * [disconnectVoice] it does not queue behind a join still in flight; it
 * cancels it, at once:
 *
 *  - the hang-up generation moves on, so every join begun before this
 *    instant — claimed, queued or running — unwinds with
 *    VoiceError('cancelled') at its next checkpoint, playing neither chime
 *    (see connectToVoice);
 *  - what a join is waiting on with no end in sight (the livekit chunk, the
 *    getUserMedia probe behind a permission prompt) is given up on;
 *  - the Room under construction gets LiveKit's own cancel,
 *    Room.disconnect(): a pending connect rejects instead of running out
 *    its 15 s + 15 s timeouts, and a pending mic publish is given up on
 *    rather than waited out (LiveKit can park one for 15 s), with the
 *    capture LiveKit opened for it stopped (stopOrphanedMicCapture);
 *  - getConnectedChannelId() reads null from here on (see its doc), and so
 *    does getActiveVoiceSessionId(): this device stops owning the session
 *    at the click. A join whose teardown is still unwinding (LiveKit can
 *    hold a cancelled mic publish for seconds) must not leave its stale id
 *    for Shell's takeover watcher to compare against a REJOIN's fresh one
 *    — it would read the rejoin as another device's and tear it down.
 *
 * Then the full teardown queues on the session chain like any other, so
 * the next join still waits for the cancelled one to settle and two
 * connects never overlap on one identity (DUPLICATE_IDENTITY). Claims are
 * left alone, as disconnectVoice leaves them: each join releases its own.
 *
 * Cheap with nothing in flight. The promise settles once the local teardown
 * is done; callers fire and forget it. It never tells the server — that is
 * AppState's hangUpCall, which every hang-up control goes through.
 */
export function hangUpVoice(): Promise<void> {
  hangupGen += 1;
  const fired = nextHangup;
  nextHangup = createHangupSignal();
  fired.fire();
  connectedChannelId = null;
  activeSessionId = null;
  const building = connectingRoom;
  if (building) {
    try {
      void building.disconnect().catch(() => {});
    } catch {
      // Best effort: the queued teardown below still runs.
    }
  }
  return serialized(() => performDisconnect());
}

/** What the OS / browser media controls' Hang Up runs (see the
    enterCallBackgroundMode call in performConnect). */
let systemHangupHandler: ((channelId: string) => void) | null = null;

/**
 * Route the OS / browser media controls' Hang Up (Android lock screen,
 * Chrome's media hub, picture-in-picture) through the app's own hang-up
 * helper, given the call's channel, so it ends the call on the server like
 * the in-app buttons do. AppState registers it; null unregisters, leaving a
 * local-only [hangUpVoice].
 */
export function setSystemHangupHandler(handler: ((channelId: string) => void) | null): void {
  systemHangupHandler = handler;
}

async function performDisconnect(
  opts: { keepAudioContext?: boolean; silent?: boolean } = {},
): Promise<void> {
  if (!room) return;
  // Hangup chime. Fired HERE, at the single chokepoint every teardown path
  // funnels through, so it covers both required paths with one call site:
  // the local user pressing leave/hangup, and the remote party ending it
  // (Shell's DM auto-end and RoomEvent.Disconnected both land here).
  //
  // `hangupChimeArmed` makes it exactly-once per connected session. `room`
  // isn't nulled until after the awaited teardown below, so the re-entrant
  // disconnectVoice() that RoomEvent.Disconnected fires *during*
  // room.disconnect() would otherwise sail past the `!room` guard and chime
  // a second time.
  //
  // Deafened means no audio, and that includes our own chrome — read the flag
  // now, before the teardown at the bottom resets it.
  if (hangupChimeArmed) {
    hangupChimeArmed = false;
    if (!opts.silent && !deafenedFlag) playCallEnd();
  }
  // Tear down our hidden audio sinks and every poller this Room owns,
  // before disconnecting LiveKit — otherwise we leak <video> elements
  // when the unsubscribe events don't fire in the right order during
  // shutdown, and the pollers tick on into the next session.
  releaseRoomResources(room as unknown as RoomInternals);
  // Tear down the manual-gain chain (second mic capture + AudioContext)
  // if it was active. It has no other caller, so without this a user in
  // manual-gain mode keeps a live mic capture (OS recording indicator
  // lit) until the tab closes. Fire-and-forget dynamic import mirrors
  // the activation path. No-op when manual gain was never engaged.
  void import('./manualGain').then((m) => m.deactivateManualGain()).catch(() => {});
  // Defensive: remove anything still tagged in the DOM, in case the
  // map and the DOM diverged. track.attach() yields <audio> for audio
  // tracks, so this MUST match audio elements too — a video-only
  // selector matched nothing and let orphaned <audio> sinks keep
  // playing after leave.
  document
    .querySelectorAll('audio[data-zk-audio-sink], video[data-zk-audio-sink]')
    .forEach((el) => {
      (el as HTMLMediaElement).srcObject = null;
      el.remove();
    });
  try {
    await room.disconnect();
  } catch {
    // Already-disconnected rooms throw; ignore.
  }
  room = null;
  localIdentity = null;
  mutedFlag = false;
  // Tear down the E2EE worker (if this was an encrypted call) now that
  // the Room is gone, so its frame-crypto machinery is freed and no
  // worker lingers into the next call.
  terminateE2eeWorker();
  // Release session ownership — this device no longer holds a voice
  // session, so the takeover watcher should stop comparing against it.
  // If the user joins again, connectToVoice will re-set this.
  activeSessionId = null;
  stopLocalLevelMonitor();
  publishRtt(null);
  // Tear down every per-track WebAudio speaker probe.
  for (const sid of Array.from(remoteSpeakerProbes.keys())) {
    detachRemoteSpeakerProbe(sid);
  }
  remoteWebAudioSpeakers.clear();
  // Release the shared AudioContext — UNLESS this is a channel-switch
  // reconnect (keepAudioContext), where the gesture-primed context must
  // survive into the immediate re-connect (see the doc comment).
  if (!opts.keepAudioContext) closeSharedAudioContext();
  // Exit call-background mode: release the screen wake lock, clear
  // media-session metadata, drop the visibility listener. Fire-and-
  // forget — none of these can fail in a way that should block
  // disconnect cleanup.
  void exitCallBackgroundMode();
  // Tell CallKit the call is over so iOS releases the elevated
  // audio session and dismisses the system call UI. No-op on web.
  // Capture the channel id BEFORE we clear active session refs.
  const endedChannelId = activeChannelId;
  void (async () => {
    try {
      const { endNativeCall, isNative } = await import('./native');
      if (!isNative() || !endedChannelId) return;
      await endNativeCall(endedChannelId);
    } catch {
      // ignore
    }
  })();
  activeChannelId = null;
  connectedChannelId = null;
  // Clear pub/sub state so the UI's voice-view drops empty.
  publishSpeakers(new Set());
  publishTracks([]);
  publishQuality(new Map());
  publishConnectionState('disconnected');
  deafenedFlag = false;
}

/**
 * Mute or unmute the local microphone. Toggles the local published
 * audio track — peers stop seeing speaker activity from us as soon as
 * this resolves. The server-side mute flag lives separately (REST
 * `POST /voice/state`); the UI calls both so other clients see the
 * mute icon even before they receive media activity changes.
 *
 * No-op when not connected.
 */
export async function setMicMuted(muted: boolean): Promise<void> {
  if (!room) return;
  mutedFlag = muted;
  await room.localParticipant.setMicrophoneEnabled(!muted);
}

/**
 * Deafen / undeafen — silences ALL incoming audio from the room. We
 * implement it by walking remote participants and setting their audio
 * tracks' `volume` to 0. LiveKit doesn't have a one-shot "deafen me"
 * API because some apps want partial deafen (mute one user but not
 * another); for our use case, blanket-zero on every audio track is
 * the right behavior.
 *
 * The convention (matches Discord): deafening also implies muting —
 * if you can't hear, others see you can't speak either. The server
 * enforces this coupling on the voice_state row; we mirror it here
 * so the local track follows.
 *
 * No-op when not connected.
 */
export async function setDeafened(deafened: boolean): Promise<void> {
  if (!room) return;
  deafenedFlag = deafened;
  // The gain chains route via WebAudio (see joinVoice's audioChain
  // setup). Trigger a re-apply by walking the room's chain map. We
  // can't reach into joinVoice's local scope from here, so stash a
  // re-apply callback on the room when joinVoice runs (similar to
  // _audioCleanup) — and call it. If absent (room not joined via the
  // new code path), fall back to LiveKit's setVolume + element.volume.
  const reapply = (room as unknown as { _reapplyGains?: () => void })._reapplyGains;
  if (reapply) {
    reapply();
  } else {
    // Fallback for any code path that bypassed the WebAudio chain.
    for (const [, p] of room.remoteParticipants as Map<string, RemoteParticipantLike>) {
      for (const [, pub] of p.trackPublications) {
        if (pub.kind === 'audio' && pub.track) {
          const t = pub.track as unknown as { setVolume?: (v: number) => void };
          if (t.setVolume) t.setVolume(deafened ? 0 : 1);
        }
      }
    }
    document
      .querySelectorAll('audio[data-zk-audio-sink], video[data-zk-audio-sink]')
      .forEach((el) => {
        (el as HTMLMediaElement).volume = deafened ? 0 : 1;
      });
  }
  // Deafen couples the mic on the way in AND the way out — pressing
  // deafen disables the mic so other users see the right icon and you
  // don't accidentally broadcast while you're not listening; pressing
  // undeafen re-enables it so you're fully back in the conversation
  // without having to click unmute separately. Previously only the
  // deafen direction was handled, which left users muted after
  // undeafening with no visible indication of why their mic was off.
  if (deafened) {
    await room.localParticipant.setMicrophoneEnabled(false);
  } else {
    await room.localParticipant.setMicrophoneEnabled(true);
  }
}

let deafenedFlag = false;
/** True if the user is currently deafened (incoming audio muted). */
export function isDeafened(): boolean {
  return deafenedFlag;
}

/** How far below the requested capture size we tolerate before calling
    the result "materially smaller". Measured on the SHORT edge, so a
    1280x720 request landing on 1024x576 passes (the browser picked a
    near neighbour) while one landing on 640x480 does not. */
const CAPTURE_SHORTFALL_RATIO = 0.9;
/** Floor for a reconciled encoder budget. Even a badly downgraded
    capture should not be starved below roughly the 'low' tier. */
const MIN_RECONCILED_BITRATE = 500_000;

/** The local camera publication, or null. Structural access into the
    SDK's publication map — wrapped because a shape change here must
    never break camera toggling. */
function findLocalCameraPublication(): TrackPublicationLike | null {
  if (!room) return null;
  try {
    const localPubs = room.localParticipant as unknown as {
      trackPublications: Map<string, TrackPublicationLike>;
    };
    for (const [, pub] of localPubs.trackPublications) {
      if (pub.source === 'camera') return pub;
    }
  } catch {
    // Ignore — treated as "no publication", which only costs us the
    // explicit re-assert below.
  }
  return null;
}

/**
 * Reconcile the tier we ASKED for against what the camera actually
 * handed back, and re-cap the sender if they disagree.
 *
 * Why this exists: nothing in the capture path guarantees we get the
 * resolution we requested, and until now a shortfall was completely
 * invisible. `restart()` (which every unmute and every device switch
 * routes through) destructures the remembered constraints into
 * `{deviceId, facingMode}` + `otherConstraints`, and builds the
 * getUserMedia request from the FIRST pair only — width/height/frameRate
 * are not in the request at all. deviceId is always truthy (the SDK
 * force-fills `{ideal:'default'}`), so the reacquire is effectively
 * getUserMedia({video:{deviceId:'default'}}) → the browser's default
 * capture profile, commonly 640x480. The resolution is applied only
 * afterwards via applyConstraints(otherConstraints) with BARE NUMBERS,
 * which per spec are 'ideal' — a hint the source is free to ignore.
 *
 * Net effect without this function: after a camera off→on the user can
 * be capturing 640x480 while the sender still budgets 2.5 Mbps for a
 * 1280x720 target, so the encoder spends a 720p bitrate painting an
 * upscaled 480p. It looks soft, and no amount of available bandwidth
 * fixes it because bandwidth was never the constraint.
 *
 * So: measure, log it (this is the observability half — the failure had
 * no signal at all before), and scale the encoder budget down by the
 * pixel ratio. Only ever LOWERS a rung, never raises one, and never
 * touches rungs already below the new cap, so simulcast's small layers
 * are left alone. All of it is best-effort — a throw here must not
 * degrade working video.
 */
function reconcileCameraCapture(
  pub: TrackPublicationLike | null,
  preset: { width: number; height: number; maxBitrate: number },
  tier: CameraQuality,
): void {
  try {
    const settings = pub?.track?.mediaStreamTrack?.getSettings();
    const gotW = settings?.width ?? 0;
    const gotH = settings?.height ?? 0;
    // Some browsers withhold dimensions until the first frame; nothing
    // to compare against, so leave the publish alone.
    if (!gotW || !gotH) return;

    const wantShort = Math.min(preset.width, preset.height);
    const gotShort = Math.min(gotW, gotH);
    if (gotShort >= wantShort * CAPTURE_SHORTFALL_RATIO) return;

    const scaled = Math.max(
      MIN_RECONCILED_BITRATE,
      Math.round(preset.maxBitrate * ((gotW * gotH) / (preset.width * preset.height))),
    );
    console.warn('[voice] camera captured below the requested tier', {
      tier,
      requested: `${preset.width}x${preset.height}`,
      actual: `${gotW}x${gotH}`,
      requestedBitrate: preset.maxBitrate,
      cappedBitrate: scaled,
    });

    const sender = pub?.track?.sender;
    const params = sender?.getParameters();
    if (!params?.encodings?.length) return;
    let changed = false;
    for (const enc of params.encodings) {
      if (typeof enc.maxBitrate === 'number' && enc.maxBitrate > scaled) {
        enc.maxBitrate = scaled;
        changed = true;
      }
    }
    if (!changed) return;
    // Fire-and-forget: setParameters rejects if the sender was replaced
    // underneath us (a concurrent restart), which is harmless — the new
    // publish runs its own reconcile.
    void sender?.setParameters(params).catch((e) => {
      console.warn('[voice] could not re-cap camera bitrate', e);
    });
  } catch (e) {
    console.warn('[voice] camera capture reconcile failed', e);
  }
}

/**
 * Enable / disable the local camera. When enabled, publishes the
 * webcam track which other participants render as a video tile. When
 * disabled, unpublishes (peers see the tile go away).
 *
 * Throws if camera permission is denied — same `VoiceError` shape as
 * mic errors so the UI can show a clear instruction.
 */
export async function setCameraEnabled(on: boolean): Promise<void> {
  if (!room) return;
  try {
    if (on) {
      // Resolve the user's saved quality preference and translate it
      // into a `resolution` option for LiveKit. 'auto' means we omit
      // the option and let the SDK + browser negotiate adaptively.
      // Entitlement clamp: which camera resolutions need which tier is
      // admin-configurable (defaults: 2K Guardian, 4K Legend). A saved
      // premium tier the membership no longer covers captures/publishes
      // at the highest allowed tier; the preference survives for a
      // re-upgrade.
      const saved = getSavedCameraQuality();
      const q: CameraQuality = isCameraQualityAllowed(saved)
        ? saved
        : highestAllowedCameraQuality();
      const preset = CAMERA_QUALITY_PRESETS[q];
      // Whether a camera publication ALREADY exists. If it does, this
      // "turn the camera on" is an unmute, not a fresh publish — and
      // livekit-client's unmute is exactly the path that loses the
      // resolution constraint (see reconcileCameraCapture for the full
      // mechanism). Captured before the call because the call creates
      // the publication when there wasn't one.
      const hadPublication = findLocalCameraPublication() !== null;
      // H.264 for the camera so it uses the browser's hardware encoder/decoder
      // (sharper, lower CPU) — overrides the VP8 publishDefault for THIS track
      // only; screen share keeps VP8.
      // 'balanced' on EVERY camera tier. This is the "auto correct itself"
      // lever: it lets libwebrtc's quality scaler shed resolution when the
      // uplink or CPU can't fund the target — and, critically, climb back up
      // when conditions recover. The SDK's height-based default gave 1080p+
      // 'maintain-resolution', which forbids shedding pixels, so a constrained
      // encoder held 1920x1080 and spent its bits on quantizer instead: a
      // full-size, permanently smeared image with no path back to sharp.
      // Screen share deliberately keeps maintain-resolution (set separately) —
      // text must stay legible, and dropping frames there is the right trade.
      const cameraPublish: VideoPublishOpts = {
        videoCodec: 'h264',
        degradationPreference: 'balanced',
      };
      if (preset) {
        // Named tiers carry their own encoder budget as a per-publish
        // override (merged over publishDefaults). Without this the
        // camera inherits publishDefaults.videoEncoding from the AUDIO
        // quality preset — capped at ≤1.5 Mbps, which silently strangles
        // 1080p and above no matter how sharp the capture is. 'auto'
        // (the else branch) deliberately keeps the publishDefaults
        // encoding — that's its whole contract.
        cameraPublish.videoEncoding = {
          maxBitrate: preset.maxBitrate,
          maxFramerate: preset.frameRate,
        };
        if (q === 'k2' || q === 'k4' || q === 'p1080') {
          // Explicit simulcast rungs for the heavy tiers: 360p + 720p
          // (LiveKit's own presets, 16:9). LiveKit's automatic layer
          // selection scales rungs off the primary encoding, which at
          // 8–14 Mbps produces mid layers that are still too fat for a
          // weak downlink — pinning two modest rungs guarantees every
          // viewer a decodable layer. Dynacast drops unwatched rungs.
          //
          // p1080 is in this list for the OPPOSITE reason. Left to the
          // SDK, `defaultSimulcastLayers` returns the FIXED pair
          // [h180, h360] — 320x180@160k and 640x360@450k, constants
          // that do not scale with capture resolution. Since 1920 >= 960
          // the SDK emits three rungs, so the published ladder was
          // 180p / 360p / 1080p: a 3x resolution cliff with nothing in
          // between. A viewer on a middling link gets pinned to the
          // 360p rung and VoiceView renders camera tiles `object-cover`,
          // so that 640x360 is upscaled AND cropped into the tile —
          // exactly the "blurry webcam" report. [h360, h720] closes the
          // gap: 360p / 720p / 1080p.
          //
          // The fatter middle rung is close to free because the Room
          // runs dynacast:true (see the comment at the Room ctor) — the
          // SFU tells us which layers actually have subscribers and the
          // encoder stops producing the ones nobody is watching. In the
          // common 1:1 case only the rung that viewer wants is encoded,
          // so the cost of offering 720p is paid only when it is used.
          //
          // p720 / auto / low are deliberately NOT listed. p720 and auto
          // capture at 1280x720, where the SDK's own [h180, h360] is
          // already the sane ladder under a 720p top rung; low captures
          // 640x480 (4:3), where `size < 960` means the SDK emits just
          // two rungs anyway. Pinning the defaults explicitly would be
          // pure churn with an identical published result.
          const { VideoPresets } = await loadLivekit();
          cameraPublish.videoSimulcastLayers = [VideoPresets.h360, VideoPresets.h720];
        }
        await room.localParticipant.setCameraEnabled(
          true,
          {
            resolution: {
              width: preset.width,
              height: preset.height,
              frameRate: preset.frameRate,
            },
          },
          cameraPublish,
        );
      } else {
        await room.localParticipant.setCameraEnabled(true, undefined, cameraPublish);
      }
      // Re-assert the tier explicitly when this was an UNMUTE rather than
      // a fresh publish. setCameraEnabled(true) on an existing publication
      // bottoms out in the SDK's unmute → restart(undefined, true), which
      // rebuilds the capture request from the track's remembered
      // `_constraints` — and, per the mechanism documented on
      // reconcileCameraCapture, drops width/height/frameRate out of the
      // getUserMedia call entirely. restartTrack({resolution}) instead
      // routes through the SDK's `constraintsForOptions` from the tier we
      // just resolved, so the request is rebuilt from a KNOWN state rather
      // than from whatever the track happens to remember, and the track's
      // constraints are re-seeded with our width/height for every later
      // restart. Costs one extra getUserMedia on camera-on (a brief
      // re-acquire), which is worth it to stop shipping an upscaled 480p.
      //
      // Deliberately NOT 'exact'/'min' — `resolution` flattens to bare
      // numbers, i.e. 'ideal'. An exact constraint would throw
      // OverconstrainedError on any webcam that can't hit the number,
      // turning soft video into NO video for every user with 1080p saved
      // and a 720p-max camera. Ask nicely, then reconcile below.
      if (hadPublication && preset) {
        const pub = findLocalCameraPublication();
        try {
          await pub?.track?.restartTrack?.({
            resolution: {
              width: preset.width,
              height: preset.height,
              frameRate: preset.frameRate,
            },
          });
        } catch (e) {
          // The camera is already live at this point — a failed
          // re-assert leaves the (possibly smaller) capture publishing,
          // which the reconcile below then budgets for correctly. Never
          // escalate this into a "camera failed" error for the user.
          console.warn('[voice] camera tier re-assert failed', e);
        }
      }
      // Now check what we actually got. Whatever path we took above, the
      // browser was only ever given a hint — this is the step that makes
      // a shortfall observable and stops the encoder from spending a
      // 2.5 Mbps 720p budget on an upscaled 480p frame.
      if (preset) {
        reconcileCameraCapture(findLocalCameraPublication(), preset, q);
      }
      // contentHint='motion' on the published camera track — the mirror
      // of the 'detail' hint on screen share (see setScreenShareEnabled).
      // Camera feeds are continuous natural motion; the hint biases the
      // encoder toward temporal smoothness over per-frame edge fidelity.
      // Only fill the hint in when the SDK/browser left it empty — never
      // fight an explicit value.
      try {
        const localPubs = room.localParticipant as unknown as {
          trackPublications: Map<string, TrackPublicationLike>;
        };
        for (const [, pub] of localPubs.trackPublications) {
          if (pub.source === 'camera' && pub.track?.mediaStreamTrack) {
            const t = pub.track.mediaStreamTrack as MediaStreamTrack & {
              contentHint?: string;
            };
            if ('contentHint' in t && !t.contentHint) t.contentHint = 'motion';
          }
        }
      } catch {
        // contentHint is a hint; failure to set it is harmless.
      }
    } else {
      await room.localParticipant.setCameraEnabled(false);
    }
    // Re-assert mic mute state. LiveKit's setCameraEnabled triggers
    // a getUserMedia call for video; on some platforms this also
    // re-evaluates the audio constraints and republishes the mic
    // track. A republished track is born UNMUTED at the SDK level
    // regardless of our prior setMicrophoneEnabled(false), which is
    // how a deliberately-muted user ends up unmuted when they turn
    // their camera on. The second setMicrophoneEnabled call here is
    // a no-op if the mic was already in the right state, and a
    // corrective re-mute if it wasn't.
    if (mutedFlag) {
      await room.localParticipant.setMicrophoneEnabled(false);
    }
  } catch (err) {
    throw mediaErrorToVoiceError(err);
  }
}

/**
 * Start / stop screen sharing. Browser shows the OS picker for which
 * window/screen to share when `on` is true. Stopping unpublishes the
 * track and peers see the tile disappear.
 *
 * Note: screen-share over WebRTC has its own permission flow distinct
 * from microphone — denying the OS picker doesn't throw a
 * NotAllowedError, it just rejects with NotAllowedError → mapped here.
 */
export async function setScreenShareEnabled(on: boolean): Promise<void> {
  if (!room) return;
  try {
    if (on) {
      // Apply the saved screen-share quality — the tier's resolution
      // with the smooth-motion 60fps toggle folded in (same effective
      // params the Room's screenShareEncoding was built from). Unlike
      // camera, there's no 'auto' for screen share — desktop content
      // has consistent motion characteristics so a preset is always
      // reasonable.
      // audio:true requests a system/tab audio track alongside the
      // video. In the Electron desktop app the main process supplies
      // a loopback audio source; in Chromium browsers this captures
      // tab audio (when the user picks a tab and ticks "share audio").
      const params = getEffectiveScreenShareParams();
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          resolution: {
            width: params.width,
            height: params.height,
            frameRate: params.frameRate,
          },
          audio: true,
        },
        // Per-publish encoder budget for THIS share. Without it the
        // encoder caps come from publishDefaults.screenShareEncoding,
        // which is frozen at Room construction — so a mid-call tier or
        // smooth-motion change followed by a share restart would apply
        // the new capture resolution but keep the OLD bitrate/framerate
        // caps (1080p60 frames squeezed through a 30fps 5 Mbps budget).
        // Passing it here makes "turn the share off and on" honestly
        // re-apply the whole preset, matching the Settings help text.
        {
          screenShareEncoding: {
            maxBitrate: params.maxBitrate,
            maxFramerate: params.frameRate,
          },
        },
      );
      // Set contentHint='detail' on the published screen track. The
      // browser's video encoder uses this as a rate-distortion hint:
      // detail biases bit allocation toward preserving sharp edges
      // (text, UI lines) at the cost of smooth motion. The default
      // hint for getDisplayMedia is 'motion' on some browsers, which
      // is wrong for the typical share (code, slides, dashboards) —
      // it spends bits on inter-frame smoothness that nobody can see
      // and starves the next keyframe, causing freezes for viewers
      // when packet loss demands an IDR refresh.
      // The Map iterator finds the screen_share publication; we set
      // the hint on its underlying MediaStreamTrack directly.
      try {
        const localPubs = room.localParticipant as unknown as {
          trackPublications: Map<string, TrackPublicationLike>;
        };
        for (const [, pub] of localPubs.trackPublications) {
          if (pub.source === 'screen_share' && pub.track?.mediaStreamTrack) {
            (pub.track.mediaStreamTrack as MediaStreamTrack & {
              contentHint?: string;
            }).contentHint = 'detail';
          }
        }
      } catch {
        // contentHint is a hint; failure to set it is harmless,
        // the stream still works at the default behavior.
      }
    } else {
      await room.localParticipant.setScreenShareEnabled(false);
    }
    // Re-assert mic mute state — see setCameraEnabled for rationale.
    if (mutedFlag) {
      await room.localParticipant.setMicrophoneEnabled(false);
    }
  } catch (err) {
    throw mediaErrorToVoiceError(err);
  }
}

// ── Live state subscriptions ───────────────────────────────────────────────
//
// Voice components need to react to two kinds of live state:
//   1. Active speakers (Set<userId>) — for the green ring on speaker avatars
//   2. Video/screen tracks (VoiceTrackInfo[]) — for the tile grid
//
// We expose these as tiny pub/sub stores rather than React state because
// they update frequently (speakers can change every 100ms), often outside
// of any rendered component, and need to be readable from non-React code
// (the voice manager itself, the join action that doesn't have hooks).
// `useSyncExternalStore` reads from these in the components below.

type SpeakerListener = (speakers: Set<string>) => void;
type TrackListener = (tracks: VoiceTrackInfo[]) => void;
/** Coarse connection state surfaced to the UI so it can show a
    "Reconnecting…" banner or drop the call view on a terminal drop. */
export type VoiceConnectionState = 'connected' | 'reconnecting' | 'disconnected';
type ConnectionStateListener = (state: VoiceConnectionState) => void;

/** Per-user LiveKit connection quality, surfaced on voice tiles as
    signal bars. Mirrors the SDK's ConnectionQuality enum; `unknown`
    covers the brief window before LiveKit has an estimate. Keyed by
    userId (= participant identity = snowflake string). */
export type VoiceQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
type QualityListener = (quality: Map<string, VoiceQuality>) => void;

const speakerListeners = new Set<SpeakerListener>();
const trackListeners = new Set<TrackListener>();
const connectionStateListeners = new Set<ConnectionStateListener>();
const qualityListeners = new Set<QualityListener>();
/** Local connection round-trip time (ms) for the header connection pill. */
type RttListener = (rttMs: number | null) => void;
const rttListeners = new Set<RttListener>();
let currentSpeakers: Set<string> = new Set();
let currentTracks: VoiceTrackInfo[] = [];
let currentConnectionState: VoiceConnectionState = 'disconnected';
let currentQuality: Map<string, VoiceQuality> = new Map();
let currentRttMs: number | null = null;

/** Coerce the SDK's ConnectionQuality (a string enum) into our union,
    defaulting anything unexpected to 'unknown' so a future SDK value
    can't leak through as an untyped string. */
function normalizeVoiceQuality(q: unknown): VoiceQuality {
  switch (q) {
    case 'excellent':
      return 'excellent';
    case 'good':
      return 'good';
    case 'poor':
      return 'poor';
    case 'lost':
      return 'lost';
    default:
      return 'unknown';
  }
}

// ── Remote-track WebAudio speaker probes ───────────────────────────────────
//
// Belt-and-suspenders for remote speaking detection. The SDK-based
// layers (ActiveSpeakersChanged event, per-participant IsSpeakingChanged,
// and the p.audioLevel polling loop) all DEPEND on the SDK/SFU populating
// audio-level data — and on some LiveKit Cloud configurations they
// silently don't. The local user's own ring works because we run our
// own AnalyserNode on the local mic; remote tiles need the same
// treatment on the remote audio MediaStreamTrack.
//
// Each probe owns its own AudioContext + AnalyserNode + interval. The
// probe's currently-detected boolean lives in `remoteWebAudioSpeakers`,
// which we OR with the SDK's reported set every time anything changes.
// This way the WebAudio probe layer can independently add a participant
// to the speaker set even when the SDK is reporting nothing.

interface RemoteSpeakerProbe {
  /** Source node attached to the shared context. Held so we can
   *  disconnect it on detach — otherwise the MediaStream stays
   *  plumbed into the shared AudioContext's graph. */
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buf: Uint8Array;
  interval: number;
  identity: string;
  /** Latest boolean from this probe; used so we only emit on change. */
  speaking: boolean;
}
/** Keyed by track sid (one probe per remote audio track). */
const remoteSpeakerProbes = new Map<string, RemoteSpeakerProbe>();
/** Identities currently detected as speaking by the WebAudio layer. */
const remoteWebAudioSpeakers = new Set<string>();

/** Threshold for "is speaking" on remote audio. Matches local-VAD's
 *  threshold for symmetric behavior — your friends register as speaking
 *  at the same volume that you do. */
const REMOTE_WEBAUDIO_SPEAKING_THRESHOLD = 0.025;

function publishRemoteWebAudioUpdate(): void {
  const next = new Set(currentSpeakers);
  // Add every identity our WebAudio probes have flagged as speaking.
  for (const id of remoteWebAudioSpeakers) next.add(id);
  // Conservatively remove identities that we KNOW (via our probes)
  // aren't speaking — but only if we have a probe for them. Without a
  // probe, leave the SDK-based layers in charge.
  const probeIdentities = new Set<string>();
  for (const probe of remoteSpeakerProbes.values()) probeIdentities.add(probe.identity);
  for (const id of next) {
    if (id === localIdentity) continue;
    if (probeIdentities.has(id) && !remoteWebAudioSpeakers.has(id)) {
      next.delete(id);
    }
  }
  publishSpeakers(next);
}

function attachRemoteSpeakerProbe(
  trackSid: string,
  identity: string,
  mediaTrack: MediaStreamTrack,
): void {
  // Tear down any prior probe on the same sid (re-subscribe race).
  detachRemoteSpeakerProbe(trackSid);
  const ctx = getOrCreateSharedAudioContext();
  if (!ctx) {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
      // eslint-disable-next-line no-console
      console.warn('[voice] webaudio probe: no shared audio context');
    }
    return;
  }
  try {
    const source = ctx.createMediaStreamSource(new MediaStream([mediaTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const probe: RemoteSpeakerProbe = {
      source,
      analyser,
      buf,
      interval: 0,
      identity,
      speaking: false,
    };
    probe.interval = window.setInterval(() => {
      // Defensive: if the shared context slipped into 'suspended'
      // somehow (e.g. browser dragged to background), the analyser
      // reads zeros. Resume opportunistically — no-op if already
      // running. Cheap to call repeatedly.
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => undefined);
      }
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]!;
      const level = sum / (buf.length * 255);
      const nowSpeaking = level > REMOTE_WEBAUDIO_SPEAKING_THRESHOLD;
      if (nowSpeaking === probe.speaking) return;
      probe.speaking = nowSpeaking;
      if (nowSpeaking) remoteWebAudioSpeakers.add(identity);
      else remoteWebAudioSpeakers.delete(identity);
      if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
        // eslint-disable-next-line no-console
        console.log('[voice] webaudio probe', { identity, speaking: nowSpeaking, level: level.toFixed(3), ctxState: ctx.state });
      }
      publishRemoteWebAudioUpdate();
    }, 50);
    remoteSpeakerProbes.set(trackSid, probe);
  } catch (e) {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
      // eslint-disable-next-line no-console
      console.warn('[voice] webaudio probe init failed', e);
    }
  }
}

function detachRemoteSpeakerProbe(trackSid: string): void {
  const probe = remoteSpeakerProbes.get(trackSid);
  if (!probe) return;
  clearInterval(probe.interval);
  // Disconnect the source so the MediaStream stops feeding the
  // shared context. analyser is GC'd when probe leaves the map.
  try {
    probe.source.disconnect();
  } catch {
    // Already disconnected (track ended, ctx closed) — benign.
  }
  remoteSpeakerProbes.delete(trackSid);
  if (probe.speaking) {
    remoteWebAudioSpeakers.delete(probe.identity);
    publishRemoteWebAudioUpdate();
  }
}

export function subscribeSpeakers(listener: SpeakerListener): () => void {
  speakerListeners.add(listener);
  return () => {
    speakerListeners.delete(listener);
  };
}
export function getCurrentSpeakers(): Set<string> {
  return currentSpeakers;
}

export function subscribeTracks(listener: TrackListener): () => void {
  trackListeners.add(listener);
  return () => {
    trackListeners.delete(listener);
  };
}
export function getCurrentTracks(): VoiceTrackInfo[] {
  return currentTracks;
}

export function subscribeConnectionState(listener: ConnectionStateListener): () => void {
  connectionStateListeners.add(listener);
  return () => {
    connectionStateListeners.delete(listener);
  };
}
export function getConnectionState(): VoiceConnectionState {
  return currentConnectionState;
}
function publishConnectionState(state: VoiceConnectionState): void {
  if (state === currentConnectionState) return;
  currentConnectionState = state;
  // Tell the Electron shell a call is up. It watchdogs the renderer and
  // RELOADS it when it looks wedged, which destroys the Room and drops the
  // call for the user and — mid screen-share — for every viewer at once.
  // Encoding a high-resolution share is exactly what stalls the main thread
  // long enough to look wedged, so the shell must not take that action while
  // a call is running. No-op in a browser, where the bridge is absent.
  try {
    (
      window as unknown as { zekktris?: { setCallActive?: (active: boolean) => void } }
    ).zekktris?.setCallActive?.(state !== 'disconnected');
  } catch {
    // A shell without the bridge (older desktop build) — nothing to tell.
  }
  for (const l of connectionStateListeners) l(state);
}

export function subscribeConnectionQuality(listener: QualityListener): () => void {
  qualityListeners.add(listener);
  return () => {
    qualityListeners.delete(listener);
  };
}
export function getConnectionQuality(): Map<string, VoiceQuality> {
  return currentQuality;
}
function publishQuality(m: Map<string, VoiceQuality>): void {
  currentQuality = m;
  for (const l of qualityListeners) l(m);
}

export function subscribeRtt(listener: RttListener): () => void {
  rttListeners.add(listener);
  return () => {
    rttListeners.delete(listener);
  };
}
export function getRtt(): number | null {
  return currentRttMs;
}
function publishRtt(ms: number | null): void {
  if (ms === currentRttMs) return;
  currentRttMs = ms;
  for (const l of rttListeners) l(ms);
}

function publishSpeakers(s: Set<string>): void {
  currentSpeakers = s;
  // Diagnostic logging — gated by `localStorage.zekktrisVoiceDebug = "1"`
  // so production isn't noisy. When enabled, every speaker-set
  // transition logs the new set with a stack-hint about which layer
  // triggered it. Useful for diagnosing "wave doesn't show for the
  // other user" reports: open DevTools on the OBSERVER's client,
  // enable the flag, have the other user speak, and watch what fires.
  if (typeof localStorage !== 'undefined' && localStorage.getItem('zekktrisVoiceDebug') === '1') {
    // eslint-disable-next-line no-console
    console.log('[voice] publishSpeakers', { speakers: Array.from(s), size: s.size, ts: Date.now() });
  }
  for (const l of speakerListeners) l(s);
}
function publishTracks(t: VoiceTrackInfo[]): void {
  currentTracks = t;
  for (const l of trackListeners) l(t);
}

// ── Local audio level + self-speaking detection ────────────────────────────
//
// Why this exists separately from LiveKit's ActiveSpeakers events:
//
//   1. Most LiveKit setups don't fire ActiveSpeakersChanged for the
//      LOCAL participant — the SFU only computes activity from media
//      it receives, and the local mic stream goes UP, not down. Result:
//      every other tile shows the green ring when its owner talks, but
//      yours never does. We compute local activity client-side and
//      merge it into the speaker set.
//
//   2. We need a numeric audio level (0..1) for the meter on your tile.
//      The Web Audio AnalyserNode gives us frequency-domain data in
//      ~16 KHz time slices — averaging the magnitudes is a cheap
//      proxy for "loudness."
//
// Implementation: tap the local microphone track via WebAudio after
// LiveKit publishes it, run an AnalyserNode at 60Hz, expose the level
// through a pub/sub. When the level crosses a threshold we mark
// ourselves as speaking and merge into the speaker set.

// ── Shared AudioContext ────────────────────────────────────────────────────
//
// One AudioContext for all our local + remote probes. Created the
// first time someone joins voice (during a user gesture — the click
// on Join), then reused for every probe attached afterwards.
//
// Why shared: AudioContexts are scarce (browsers cap at ~6) and ONLY
// the one created during a fresh user gesture starts in 'running'
// state. Async events like RoomEvent.TrackSubscribed fire long after
// the gesture has lapsed, so AudioContexts created inside them start
// 'suspended' and stay there even after ctx.resume() — autoplay
// policies are stricter than just the resume() API surface implies,
// particularly on Safari where resume() resolves successfully but the
// context remains silently inert. Sharing one context that was born
// in the gesture sidesteps the whole class of bug.
let sharedAudioContext: AudioContext | null = null;

/**
 * Resolve the shared AudioContext, lazily creating + resuming it. The
 * common case: called from inside the join-voice gesture's call
 * stack, so creation lands in 'running' state directly.
 *
 * Defensive: also arms a gesture-resume listener whenever we detect
 * the context is suspended. Safari's resume() can RESOLVE its
 * promise while leaving the context inert, so the per-call resume()
 * isn't sufficient on its own — we want a guaranteed fallback when
 * the user next interacts with the page.
 */
function getOrCreateSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    if (sharedAudioContext.state === 'suspended') {
      void sharedAudioContext.resume().catch(() => undefined);
      armSharedContextResumeOnGesture();
    }
    return sharedAudioContext;
  }
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioContext = new Ctor();
    if (sharedAudioContext.state === 'suspended') {
      void sharedAudioContext.resume().catch(() => undefined);
      armSharedContextResumeOnGesture();
    }
    return sharedAudioContext;
  } catch {
    return null;
  }
}

/**
 * Arms a one-shot gesture listener that resumes the shared
 * AudioContext on the next user interaction. Idempotent — repeated
 * calls within the suspended window collapse into a single listener.
 *
 * Why: Safari's autoplay policy is asymmetric. AudioContext.resume()
 * RESOLVES its promise even when the context stays inert. Without
 * an explicit gesture-driven retry, the context can remain
 * suspended for the entire call — analyser reads zeros, speaker
 * detection never fires, the user can hear remote audio (LiveKit's
 * own audio routing isn't affected) but the visual ring never
 * appears.
 *
 * Listener is `capture: true` so we run before app-level handlers
 * eat the event, and uses `{ once: true }` semantics via the
 * resumeArmed flag rather than the option (older Safari).
 */
let sharedResumeArmed = false;
function armSharedContextResumeOnGesture(): void {
  if (sharedResumeArmed) return;
  sharedResumeArmed = true;
  const tryResume = () => {
    sharedResumeArmed = false;
    document.removeEventListener('pointerdown', tryResume, true);
    document.removeEventListener('keydown', tryResume, true);
    document.removeEventListener('touchstart', tryResume, true);
    if (sharedAudioContext && sharedAudioContext.state === 'suspended') {
      void sharedAudioContext.resume().catch(() => undefined);
    }
  };
  document.addEventListener('pointerdown', tryResume, true);
  document.addEventListener('keydown', tryResume, true);
  document.addEventListener('touchstart', tryResume, true);
}

/**
 * Public hook for "join voice" UI buttons. Synchronously creates the
 * shared AudioContext while we're still inside the user gesture's
 * call stack, BEFORE the async path of connectToVoice (room.connect,
 * setMicrophoneEnabled, etc) has a chance to consume the activation.
 *
 * Callers: IncomingCallModal.accept, DmHeaderCallButton.start,
 * VoiceView's channel-join handlers — every place where the user
 * clicks something that will end up triggering audio. The function
 * is intentionally narrow (no parameters, no return inspection
 * required) so adding it at the top of a handler is one line.
 */
export function prepareVoiceAudio(): void {
  getOrCreateSharedAudioContext();
}

function closeSharedAudioContext(): void {
  if (sharedAudioContext) {
    void sharedAudioContext.close().catch(() => undefined);
    sharedAudioContext = null;
  }
}

let analyserNode: AnalyserNode | null = null;
let levelInterval: number | null = null;

type LevelListener = (level: number) => void;
const levelListeners = new Set<LevelListener>();
let currentLevel = 0;

// (Previously exposed subscribeLocalLevel / getCurrentLocalLevel
//  here. Both were defined for a planned UI that never landed —
//  MicLevelMeter ended up using its own getUserMedia stream.
//  Removed to shrink the public surface; the internal levelListeners
//  Set + currentLevel var stay because the speaker-detection loop
//  still writes to them, and the empty-Set iteration is a no-op.)
void levelListeners;
void currentLevel;

/**
 * Threshold above which we consider the local user to be "speaking."
 * Tuned to match VAD: too low and the green ring stays on during
 * normal background noise; too high and quiet voices don't register.
 * 0.05 (5% of full scale) is around the level of audible speech in a
 * quiet room. The same threshold is what LiveKit uses by default.
 */
const SPEAKING_THRESHOLD = 0.05;

function startLocalLevelMonitor(track: MediaStreamTrack): void {
  stopLocalLevelMonitor();
  try {
    const ctx = getOrCreateSharedAudioContext();
    if (!ctx) return;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 256;
    source.connect(analyserNode);
    const buf = new Uint8Array(analyserNode.frequencyBinCount);
    let lastSpeaking = false;
    levelInterval = window.setInterval(() => {
      if (!analyserNode) return;
      analyserNode.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]!;
      const level = sum / (buf.length * 255);
      currentLevel = level;
      for (const l of levelListeners) l(level);
      const speakingNow = level > SPEAKING_THRESHOLD && !mutedFlag;
      if (speakingNow !== lastSpeaking) {
        lastSpeaking = speakingNow;
        const newSet = new Set(currentSpeakers);
        if (speakingNow && localIdentity) newSet.add(localIdentity);
        else if (localIdentity) newSet.delete(localIdentity);
        publishSpeakers(newSet);
      }
    }, 50);
  } catch {
    // Defensive — node creation can throw on some Safari configs.
  }
}

function stopLocalLevelMonitor(): void {
  if (levelInterval !== null) {
    clearInterval(levelInterval);
    levelInterval = null;
  }
  // Don't close the shared AudioContext here — remote-track probes
  // may still be attached to it. The shared ctx gets closed only in
  // the full-disconnect path (disconnectVoice → closeSharedAudioContext).
  analyserNode = null;
  currentLevel = 0;
  for (const l of levelListeners) l(0);
}

let localIdentity: string | null = null;
let mutedFlag = false;

// ── Push-to-talk ───────────────────────────────────────────────────────────
//
// PTT is a global keyboard listener that holds the mic muted by default
// and unmutes only while the configured key is pressed. Modes:
//
//   - 'vad'   : default, voice-activity detection (always-on mic).
//   - 'ptt'   : push-to-talk, mic muted unless `pttKey` is held.
//
// The configured key is a KeyboardEvent.code (so 'Space', 'KeyV', etc.).
// We use `code` and not `key` because `key` is layout-dependent — a
// French AZERTY user pressing the same physical key has a different
// `key` value but the same `code`.
//
// Storage: localStorage keys 'zekktris.audio.mode' + 'zekktris.audio.pttKey'.

export type AudioMode = 'vad' | 'ptt';

const STORAGE_AUDIO_MODE = 'zekktris.audio.mode';
const STORAGE_PTT_KEY = 'zekktris.audio.pttKey';
const DEFAULT_PTT_KEY = 'Space';

export function getAudioMode(): AudioMode {
  try {
    return (localStorage.getItem(STORAGE_AUDIO_MODE) as AudioMode) ?? 'vad';
  } catch {
    return 'vad';
  }
}
export function setAudioMode(mode: AudioMode): void {
  try {
    localStorage.setItem(STORAGE_AUDIO_MODE, mode);
  } catch {}
  // Re-apply mute state immediately if a call is in flight.
  if (room) {
    if (mode === 'ptt') {
      // Switching INTO ptt → mute right now (user has to push to talk).
      mutedFlag = true;
      void room.localParticipant.setMicrophoneEnabled(false);
    } else if (!deafenedFlag) {
      // Switching OUT of ptt → unmute — but NOT while deafened (deafen
      // implies muted; force-unmuting here would start broadcasting
      // while the user is supposed to be silent). The deafen toggle
      // owns the mic in that state and will re-enable it on undeafen.
      mutedFlag = false;
      void room.localParticipant.setMicrophoneEnabled(true);
    }
  }
}

export function getPttKey(): string {
  try {
    return localStorage.getItem(STORAGE_PTT_KEY) ?? DEFAULT_PTT_KEY;
  } catch {
    return DEFAULT_PTT_KEY;
  }
}
export function setPttKey(code: string): void {
  try {
    localStorage.setItem(STORAGE_PTT_KEY, code);
  } catch {}
}

// ── Deafen hotkey (F7) ───────────────────────────────────────────────────────
//
// A single configured key toggles deafen while in a call. Opt-in — the
// default is the empty string (disabled), so a stray keypress can't deafen
// someone who never bound it. Storage key 'zekktris.audio.deafenKey', a
// KeyboardEvent.code (same rationale as the PTT key: layout-independent).
//
// The keydown is handled inside the same global listener as PTT (installed
// once per session in installPttListeners), so the hotkey works from any
// view while a call is live — not just the voice screen. The actual toggle
// is delegated to a handler the voice UI registers, so it runs the FULL
// deafen flow (mute coupling + server sync so other participants see the
// deaf/mute icons). If no UI is mounted, we fall back to a local-only
// setDeafened (deafens incoming audio without the server round-trip).
const STORAGE_DEAFEN_KEY = 'zekktris.audio.deafenKey';
export function getDeafenKey(): string {
  try {
    return localStorage.getItem(STORAGE_DEAFEN_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setDeafenKey(code: string): void {
  try {
    localStorage.setItem(STORAGE_DEAFEN_KEY, code);
  } catch {}
}
let deafenHotkeyHandler: (() => void) | null = null;
/** Register the full deafen-toggle handler (mute coupling + server sync).
    The voice UI sets this on mount and clears it on unmount. */
export function setDeafenHotkeyHandler(fn: (() => void) | null): void {
  deafenHotkeyHandler = fn;
}

let pttKeyDown = false;
let pttListenersInstalled = false;

function installPttListeners(): void {
  if (pttListenersInstalled) return;
  pttListenersInstalled = true;

  const onKeyDown = (e: KeyboardEvent) => {
    // Don't intercept while typing in an input/textarea/contenteditable.
    // Otherwise space-bar-to-talk would never insert spaces in messages.
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }
    // Deafen hotkey (F7): works in any audio mode, only while in a call.
    // Opt-in — empty key disables it. Delegates to the registered full
    // toggle (server sync) when the voice UI is mounted, else local-only.
    const deafenKey = getDeafenKey();
    if (deafenKey && room && e.code === deafenKey) {
      e.preventDefault();
      if (deafenHotkeyHandler) deafenHotkeyHandler();
      else void setDeafened(!deafenedFlag);
      return;
    }
    if (getAudioMode() !== 'ptt') return;
    if (e.code !== getPttKey()) return;
    if (pttKeyDown) return;
    // Deafened implies muted (Discord's invariant, enforced across the
    // rest of the voice code). A PTT key tap must NOT punch through it
    // and start transmitting while the UI + server still show the user
    // as deaf+muted — that broadcasts audio they believe is silenced.
    if (deafenedFlag) return;
    pttKeyDown = true;
    if (room) {
      mutedFlag = false;
      void room.localParticipant.setMicrophoneEnabled(true);
    }
    e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (getAudioMode() !== 'ptt') return;
    if (e.code !== getPttKey()) return;
    if (!pttKeyDown) return;
    pttKeyDown = false;
    if (room) {
      mutedFlag = true;
      void room.localParticipant.setMicrophoneEnabled(false);
    }
  };

  // Window blur clears the held state — otherwise alt-tabbing while
  // holding PTT leaves the mic stuck open.
  const onBlur = () => {
    if (pttKeyDown) {
      pttKeyDown = false;
      if (room && getAudioMode() === 'ptt') {
        mutedFlag = true;
        void room.localParticipant.setMicrophoneEnabled(false);
      }
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
}

/** Human-readable label for a KeyboardEvent.code value. */
export function formatKeyCode(code: string): string {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3); // 'KeyV' → 'V'
  if (code.startsWith('Digit')) return code.slice(5); // 'Digit1' → '1'
  if (code.startsWith('Arrow')) return code.replace('Arrow', '↑↓←→'.charAt(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].indexOf(code)));
  return code;
}
