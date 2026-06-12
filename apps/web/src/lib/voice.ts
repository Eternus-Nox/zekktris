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
    setScreenShareEnabled(on: boolean, opts?: ScreenOpts): Promise<unknown>;
    identity: string;
  };
  remoteParticipants: Map<string, unknown>;
  switchActiveDevice(kind: 'audioinput' | 'audiooutput' | 'videoinput', deviceId: string): Promise<unknown>;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  off(event: string, cb: (...args: unknown[]) => void): unknown;
};

interface VideoOpts {
  resolution?: { width: number; height: number; frameRate: number };
}
// Per-publish overrides (merged over the Room's publishDefaults). Used to give
// the CAMERA an H.264 codec without changing screen share (which stays VP8).
interface VideoPublishOpts {
  videoCodec?: 'vp8' | 'h264' | 'vp9' | 'av1';
}
interface ScreenOpts {
  resolution?: { width: number; height: number; frameRate: number };
  audio?: boolean;
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
  /** Display title for the OS lock-screen / media controls "Now
      Playing" entry. Typically the other DM party's display name
      or the channel name. Omit to fall back to "Voice call". */
  backgroundTitle?: string;
  /** Channel id of the voice call. Used by the native CallKit
      bridge as the unique call identifier so the system call UI
      can match incoming/outgoing/ended events. Optional — web
      contexts don't need it; native callers should always thread
      it through. */
  channelId?: string;
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
    call UI would linger after our internal teardown. */
let activeChannelId: string | null = null;

export function getActiveVoiceSessionId(): string | null {
  return activeSessionId;
}

/** Channel id of the currently-connected voice room. Used by the
    self-move detector in AppState to decide whether a VOICE_STATE_UPDATE
    for our own user represents an admin-initiated move (channelId
    differs from connected) vs. a benign state delta (mute/deaf
    toggle on the same channel). Null when not connected. */
export function getConnectedChannelId(): string | null {
  return activeChannelId;
}

import { getCurrentPreset } from './voiceQuality';
import * as voicePrefs from './voicePrefs';
import { enterCallBackgroundMode, exitCallBackgroundMode } from './callBackground';
import { getCallKeyString } from './e2ee';
import { isMediaCaptureAvailable, mediaUnavailableMessage } from './mediaSupport';

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
// fluidity for typical use (chat, code, presentations).

export type CameraQuality = 'auto' | 'low' | 'medium' | 'high';
export type ScreenQuality = 'low' | 'standard' | 'high_motion' | 'k2';

export const CAMERA_QUALITY_PRESETS: Record<
  CameraQuality,
  { width: number; height: number; frameRate: number; label: string; description: string } | null
> = {
  // null means "let LiveKit pick" — we omit the resolution option entirely
  // so the SDK's adaptive logic + browser hints decide.
  auto: null,
  low: {
    width: 640,
    height: 480,
    frameRate: 15,
    label: 'Low (480p, 15 fps)',
    description: 'Saves bandwidth. Good for slow networks.',
  },
  medium: {
    width: 1280,
    height: 720,
    frameRate: 30,
    label: 'Medium (720p, 30 fps)',
    description: 'Balanced. Recommended.',
  },
  high: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    label: 'High (1080p, 30 fps)',
    description: 'Best quality. Needs a strong uplink.',
  },
};

export const SCREEN_QUALITY_PRESETS: Record<
  ScreenQuality,
  {
    width: number;
    height: number;
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
  low: {
    width: 1280,
    height: 720,
    frameRate: 15,
    maxBitrate: 1_500_000,
    label: 'Low (720p, 15 fps)',
    description: 'Saves bandwidth. Best for static content like documents.',
  },
  standard: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 3_000_000,
    label: 'Standard (1080p, 30 fps)',
    description: 'Balanced. Recommended for most use.',
  },
  high_motion: {
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 5_000_000,
    label: 'High motion (1080p, 60 fps)',
    description: 'Smooth motion. Best for gaming or video playback. Heavy on bandwidth.',
  },
  k2: {
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 5_500_000,
    label: '2K (1440p, 30 fps)',
    description: 'Sharper than 1080p. Good for code, design work, or large monitors. Needs solid uplink.',
  },
};

export function getSavedCameraQuality(): CameraQuality {
  try {
    const v = localStorage.getItem(STORAGE_CAMERA_QUALITY) ?? 'medium';
    if (v in CAMERA_QUALITY_PRESETS) return v as CameraQuality;
    return 'medium';
  } catch {
    return 'medium';
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
    const v = localStorage.getItem(STORAGE_SCREEN_QUALITY) ?? 'standard';
    if (v in SCREEN_QUALITY_PRESETS) return v as ScreenQuality;
    return 'standard';
  } catch {
    return 'standard';
  }
}

export function setSavedScreenQuality(q: ScreenQuality): void {
  try {
    localStorage.setItem(STORAGE_SCREEN_QUALITY, q);
  } catch {
    // ignore
  }
}

/** Encoder maxBitrate for screen share — pulled from the user's saved
    quality preset. Read at Room construction time. If the user changes
    their screen-quality preference, they need to leave and rejoin the
    voice channel for the new bitrate to take effect (LiveKit doesn't
    expose a runtime path to renegotiate publish defaults on an active
    room). */
function getScreenShareEncoderBitrate(): number {
  const q = getSavedScreenQuality();
  return SCREEN_QUALITY_PRESETS[q].maxBitrate;
}

function getScreenShareEncoderFramerate(): number {
  const q = getSavedScreenQuality();
  return SCREEN_QUALITY_PRESETS[q].frameRate;
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
  | 'unknown';

export class VoiceError extends Error {
  code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'VoiceError';
  }
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

/**
 * Establish a LiveKit connection and publish the local microphone
 * track. If a connection is already open, it's torn down first — voice
 * is single-channel by design.
 *
 * Throws a `VoiceError` with a code/message pair suitable for direct
 * display in a toast.
 */
export async function connectToVoice(args: ConnectArgs): Promise<void> {
  const { Room, RoomEvent, ParticipantEvent, ExternalE2EEKeyProvider, isE2EESupported } =
    await loadLivekit();

  // Pre-flight: do a getUserMedia ourselves with the user's saved
  // device id (if any). This catches permission/device errors with
  // crisp messages BEFORE LiveKit's connect path wraps them in
  // generic "could not establish session" errors. Track is stopped
  // immediately — LiveKit will re-acquire on its own when we publish.
  const inputDeviceId = getSavedInputDeviceId();
  // First make sure the capture API even exists. In the iOS WebView
  // (and any insecure-context load) `navigator.mediaDevices` can be
  // undefined; calling getUserMedia on it throws a bare TypeError
  // ("undefined is not an object …"). Surface a clear, self-diagnosing
  // message instead, and bail before LiveKit hits the same wall.
  if (!isMediaCaptureAvailable()) {
    throw new VoiceError('browser_unsupported', mediaUnavailableMessage());
  }
  try {
    const probe = await navigator.mediaDevices.getUserMedia({
      audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
    });
    probe.getTracks().forEach((t) => t.stop());
  } catch (err) {
    throw mediaErrorToVoiceError(err);
  }

  // Tear down any prior session before opening a new one. The previous
  // join's REST cleanup already happened via the server-side single-row
  // invariant, but the Room object on the client side needs to be
  // disposed independently.
  if (room) {
    try {
      await room.disconnect();
    } catch {
      // Disconnect failures are non-fatal — we're recreating anyway.
    }
    room = null;
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
      },
      videoEncoding: {
        maxBitrate: preset.videoBitrate,
        maxFramerate: 30,
      },
      // Screen share gets its OWN encoder budget — separate from
      // camera (which is what `videoEncoding` above governs). Without
      // this, screen content was getting camera-grade bitrates
      // applied to 1080p/60 frames, which left no headroom for
      // keyframes under packet loss. Viewers saw freezes that
      // recovered only on the next IDR. Bitrate scales with the
      // user's saved screen quality preset, and we cap framerate
      // at the preset's value (the actual stream rate is set by
      // setScreenShareEnabled's resolution arg, but encoders also
      // need to know the cap to plan rate control).
      screenShareEncoding: {
        maxBitrate: getScreenShareEncoderBitrate(),
        maxFramerate: getScreenShareEncoderFramerate(),
      },
      // VP8 is the most compatible codec across browsers (Safari
      // included) and handles screen content's sharp edges well
      // without the keyframe-latency penalties some VP9 hardware
      // encoders have. AV1 would be even better quality-per-bit
      // but isn't reliably supported by viewer browsers yet.
      videoCodec: 'vp8',
      // Stereo on the high preset for music; the low/normal presets
      // collapse to mono via the channel hint passed below.
      red: true, // forward-error-correction-ish; helps lossy networks
      dtx: true, // discontinuous transmission — saves bw during silence
    },
    // End-to-end media encryption, present only for unlocked 1:1 DM
    // calls (see the e2ee resolution block above). Spread so the key
    // stays absent — not `undefined` — for every other call type, which
    // is what LiveKit treats as "no E2EE."
    ...(e2eeRoomOpt ? { e2ee: e2eeRoomOpt } : {}),
  });

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
      throw new VoiceError(
        'e2ee_unsupported',
        `Couldn't enable end-to-end encryption for this call: ${
          (err as Error)?.message ?? 'unknown error'
        }`,
      );
    }
  }

  if (args.onStateChange) {
    r.on(RoomEvent.ConnectionStateChanged, args.onStateChange as never);
  }

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
  // Wire up any remotes that were already present when we connected
  // (the ParticipantConnected event won't fire retroactively for them).
  for (const [, p] of r.remoteParticipants as Map<string, SpeakingParticipant>) {
    attachSpeakingListener(p);
  }
  r.on(RoomEvent.ParticipantConnected, ((p: unknown) => {
    attachSpeakingListener(p as SpeakingParticipant);
  }) as never);
  r.on(RoomEvent.ParticipantDisconnected, ((p: unknown) => {
    const identity = (p as { identity: string }).identity;
    if (!currentSpeakers.has(identity)) return;
    const next = new Set(currentSpeakers);
    next.delete(identity);
    publishSpeakers(next);
  }) as never);

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
  remoteSpeakingPollInterval = window.setInterval(() => {
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
  const attachEndedListener = (mst: MediaStreamTrack) => {
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
        attachEndedListener(mst);
        const isScreen = pub.source === 'screen_share';
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
      attachEndedListener(mst);
      const isScreen = pub.source === 'screen_share';
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
  (r as unknown as { _stalePoll?: number })._stalePoll = stalePoll;
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
    const msg = (err as Error).message ?? 'connection failed';
    throw new VoiceError('connect_failed', `Couldn't reach voice server: ${msg}`);
  }
  await r.localParticipant.setMicrophoneEnabled(
    true,
    inputDeviceId ? { deviceId: inputDeviceId } : undefined,
  );
  // Mic is live after the call above, so the local mute state is false.
  // Reset explicitly: mutedFlag is module-scoped and could otherwise
  // carry a stale `true` from a previous session into this join (the PTT
  // branch below re-sets it to true when appropriate).
  mutedFlag = false;

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

  room = r as unknown as RoomLike;
  localIdentity = r.localParticipant.identity;
  // Initial track snapshot so the UI doesn't have to wait for the
  // first track event before rendering empty/non-empty state.
  rebuildTracks();

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
    await r.localParticipant.setMicrophoneEnabled(false);
  }

  // Start the local-level monitor so the user's own tile shows the
  // green ring when they speak. The monitor reads the actual published
  // mic track, so we need to grab it after setMicrophoneEnabled(true).
  // Walk the local participant's track publications to find the audio
  // track LiveKit just published.
  const localPubs = r.localParticipant as unknown as { trackPublications: Map<string, TrackPublicationLike> };
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
  if (audioPrefs.gainMode === 'manual') {
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
  // intent rather than silently overriding it.
  if (audioPrefs.noiseSuppression) {
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

  // Claim ownership of this session for the takeover watcher.
  // Done at the very end so a connect failure (which throws before
  // here) doesn't leave a stale activeSessionId behind. If the
  // caller didn't pass a sessionId (older callers or paths that
  // didn't thread it through yet), we leave activeSessionId null —
  // takeover detection just doesn't fire on this device, which
  // degrades to the prior behavior (no auto-disconnect) instead of
  // a false positive.
  activeSessionId = args.sessionId ?? null;

  // Background-stay-alive setup: ask the OS not to lock the screen
  // (Wake Lock API), register the page as an active audio source
  // (Media Session API), and wire the platform Hang Up button to
  // disconnectVoice. Without this the OS suspends mic capture as
  // soon as the screen locks, killing the call mid-conversation.
  // Best-effort — every API is feature-detected inside the helper.
  void enterCallBackgroundMode({
    title: args.backgroundTitle ?? 'Voice call',
    artist: 'Zekktris',
    onHangup: () => {
      // Fire-and-forget — the user tapping Hang Up on the lock
      // screen wants the call to end. If REST cleanup fails on
      // disconnectVoice, the takeover watcher will eventually
      // reconcile.
      void disconnectVoice();
    },
  });

  // Native iOS — register the outgoing call with CallKit. This
  // is the load-bearing call for "locked-screen audio works":
  // CallKit promotes our audio session to the elevated category
  // that iOS keeps alive when the screen locks. Without this,
  // wake-lock + media-session alone aren't enough; iOS strips mic
  // access on lock regardless. No-op on web (existing wake-lock
  // path stays in charge). Skipped when no channelId was passed
  // — without an id we can't track the call through CallKit's
  // identifier-based API.
  if (args.channelId) {
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
  track?: { mediaStreamTrack?: MediaStreamTrack };
}

/**
 * Close the active voice connection. Safe to call when not connected —
 * returns immediately.
 */
export async function disconnectVoice(): Promise<void> {
  if (!room) return;
  // Tear down our hidden audio sinks before disconnecting LiveKit so we
  // don't leak <video> elements if the unsubscribe events don't fire
  // in the right order during shutdown.
  const cleanup = (room as unknown as { _audioCleanup?: () => void })._audioCleanup;
  cleanup?.();
  // Clear the stale-tracks polling interval set up in connectToVoice.
  const stalePoll = (room as unknown as { _stalePoll?: number })._stalePoll;
  if (typeof stalePoll === 'number') clearInterval(stalePoll);
  // Defensive: remove anything still tagged in the DOM, in case the
  // map and the DOM diverged.
  document.querySelectorAll('video[data-zk-audio-sink]').forEach((el) => {
    (el as HTMLVideoElement).srcObject = null;
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
  if (remoteSpeakingPollInterval !== null) {
    clearInterval(remoteSpeakingPollInterval);
    remoteSpeakingPollInterval = null;
  }
  // Tear down every per-track WebAudio speaker probe.
  for (const sid of Array.from(remoteSpeakerProbes.keys())) {
    detachRemoteSpeakerProbe(sid);
  }
  remoteWebAudioSpeakers.clear();
  // Release the shared AudioContext. The next join will re-create
  // one inside that gesture's call stack.
  closeSharedAudioContext();
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
  // Clear pub/sub state so the UI's voice-view drops empty.
  publishSpeakers(new Set());
  publishTracks([]);
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
    document.querySelectorAll('video[data-zk-audio-sink]').forEach((el) => {
      (el as HTMLVideoElement).volume = deafened ? 0 : 1;
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
      const q = getSavedCameraQuality();
      const preset = CAMERA_QUALITY_PRESETS[q];
      // H.264 for the camera so it uses the browser's hardware encoder/decoder
      // (sharper, lower CPU) — overrides the VP8 publishDefault for THIS track
      // only; screen share keeps VP8. videoEncoding/simulcast still come from
      // publishDefaults via the merge.
      const cameraPublish: VideoPublishOpts = { videoCodec: 'h264' };
      if (preset) {
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
      // Apply the saved screen-share quality. Unlike camera, there's
      // no 'auto' for screen share — desktop content has consistent
      // motion characteristics so a preset is always reasonable.
      // audio:true requests a system/tab audio track alongside the
      // video. In the Electron desktop app the main process supplies
      // a loopback audio source; in Chromium browsers this captures
      // tab audio (when the user picks a tab and ticks "share audio").
      const q = getSavedScreenQuality();
      const preset = SCREEN_QUALITY_PRESETS[q];
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          resolution: {
            width: preset.width,
            height: preset.height,
            frameRate: preset.frameRate,
          },
          audio: true,
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

const speakerListeners = new Set<SpeakerListener>();
const trackListeners = new Set<TrackListener>();
let currentSpeakers: Set<string> = new Set();
let remoteSpeakingPollInterval: number | null = null;
let currentTracks: VoiceTrackInfo[] = [];

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
    } else {
      // Switching OUT of ptt → unmute (assuming user wasn't manually muted).
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
    if (getAudioMode() !== 'ptt') return;
    if (e.code !== getPttKey()) return;
    if (pttKeyDown) return;
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
