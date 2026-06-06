/**
 * Voice preferences
 * -----------------
 * Per-listener customizations that apply on top of LiveKit's stream:
 *
 *   - per-user mute (silence a specific participant just for me; the
 *     server doesn't know or care)
 *   - per-user volume 0..200% (boost individual loud-or-quiet voices
 *     to a comfortable level)
 *   - master output gain 0..200% (overall amplification of incoming
 *     voice on top of the system volume slider)
 *   - microphone gain 0..200% (boost outgoing voice for everyone
 *     who's listening to me)
 *
 * Persistence is localStorage so settings survive reloads but stay
 * local — they're a property of the listener's machine, not their
 * account. (A future pass could lift this to a server-synced "voice
 * settings" payload on /@me, but the data is small enough that local
 * is fine for v1.)
 *
 * The store is a tiny subscribe/getSnapshot module rather than a
 * useState pyramid because preferences are read from many places
 * (the audio routing layer in voice.ts, the participant tiles in
 * VoiceView, the master controls bar, the settings menu) and need
 * to stay in sync without prop-drilling.
 */

const STORAGE_KEY = 'zekktris.voice.prefs.v1';

export interface UserVoicePrefs {
  /** True ⇒ this listener has locally muted that participant. */
  muted: boolean;
  /** 0..2 (where 1.0 is unity gain). Stored as a fraction; the UI
      surfaces it as a percentage. */
  volume: number;
}

interface VoicePrefsState {
  /** Per-participant overrides keyed by user id. Absent entries
      implicitly mean default ({ muted: false, volume: 1 }). */
  perUser: Record<string, UserVoicePrefs>;
  /** Global multiplier applied to ALL remote voice tracks. */
  masterVolume: number;
  /** Local-mic gain multiplier applied before the track is
      published. Only takes effect when `gainMode === 'manual'` —
      otherwise the mic publishes through LiveKit's default capture
      path and this value is ignored. Range 0..2 (where 1.0 is
      unity gain). */
  micGain: number;
  /** Browser-native audio processing flags applied at getUserMedia
      time. The noise-suppression and echo-cancellation toggles
      stay as booleans because they only have on/off semantics.
      AGC is now part of `gainMode` since it interacts with the
      manual gain slider. Changes take effect on next voice connect. */
  noiseSuppression: boolean;
  echoCancellation: boolean;
  /**
   * Gain mode — replaces the old binary `autoGainControl` flag.
   *   - 'agc':    browser AGC enabled. The mic level is normalized
   *               automatically; the manual-gain slider has no
   *               effect. The default — what most users want for
   *               voice chat.
   *   - 'manual': browser AGC OFF, the mic stream is piped through
   *               a Web Audio GainNode whose value comes from
   *               `micGain`. The user has full control; useful for
   *               hardware preamps, "I sound too quiet/loud after
   *               AGC normalizes me," or any case where AGC's
   *               compression artifacts are unwanted.
   *   - 'off':    browser AGC OFF, no manual gain processing. The
   *               raw mic signal is published as captured. Useful
   *               when you have a hardware audio chain (preamp,
   *               dynamics processor) doing the work and want the
   *               software path to be transparent.
   */
  gainMode: 'agc' | 'manual' | 'off';
  /**
   * Noise gate threshold — RMS level below which the outgoing
   * mic is silenced. Normalized 0..1 on the same scale the
   * MicLevelMeter renders (so the value matches what the user
   * sees on the bar). Default 0 = gate disabled (pass everything
   * the suppressor + compressor produce). Typical setting after
   * tuning: 0.05–0.15 — enough to gate out keyboard noise, AC
   * hum, breathing, when the user isn't actively speaking,
   * while keeping the entire dynamic range of normal speech.
   *
   * Implemented as an envelope-following GainNode in the audio
   * processor chain — fast attack on the gate-open transition
   * (won't clip the front of a syllable) and a hold + slow
   * release on gate-close (avoids "popping" between words).
   *
   * Stored as a number rather than a boolean+number pair so the
   * settings UI can drag the threshold to zero to effectively
   * disable the gate without an extra toggle.
   */
  noiseGateThreshold: number;
}

const DEFAULTS: VoicePrefsState = {
  perUser: {},
  masterVolume: 1,
  micGain: 1,
  noiseSuppression: true,
  echoCancellation: true,
  gainMode: 'agc',
  // Disabled by default — gating without tuning can clip the start
  // of quiet phrases. Users opt in by dragging the meter's threshold
  // line up to a position above their noise floor.
  noiseGateThreshold: 0,
};

let state: VoicePrefsState = load();
const listeners = new Set<() => void>();

function load(): VoicePrefsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<VoicePrefsState> & { autoGainControl?: unknown };
    // Backward-compat migration. Older saved prefs had a binary
    // `autoGainControl: boolean` instead of `gainMode`. We map:
    //   autoGainControl === true  → 'agc' (the historical default)
    //   autoGainControl === false → 'off' (explicit-disable case)
    // The 'manual' mode is new; users opt into it via the new
    // settings UI, never via migration. If `gainMode` is already
    // present on the saved record we honor it directly.
    let gainMode: 'agc' | 'manual' | 'off' = 'agc';
    if (parsed.gainMode === 'agc' || parsed.gainMode === 'manual' || parsed.gainMode === 'off') {
      gainMode = parsed.gainMode;
    } else if (typeof parsed.autoGainControl === 'boolean') {
      gainMode = parsed.autoGainControl ? 'agc' : 'off';
    }
    return {
      perUser:
        parsed.perUser && typeof parsed.perUser === 'object'
          ? sanitizePerUser(parsed.perUser as Record<string, UserVoicePrefs>)
          : {},
      masterVolume: clampVolume(parsed.masterVolume),
      micGain: clampVolume(parsed.micGain),
      noiseSuppression:
        typeof parsed.noiseSuppression === 'boolean' ? parsed.noiseSuppression : true,
      echoCancellation:
        typeof parsed.echoCancellation === 'boolean' ? parsed.echoCancellation : true,
      gainMode,
      noiseGateThreshold:
        typeof parsed.noiseGateThreshold === 'number' && isFinite(parsed.noiseGateThreshold)
          ? Math.max(0, Math.min(1, parsed.noiseGateThreshold))
          : 0,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitizePerUser(
  raw: Record<string, UserVoicePrefs>,
): Record<string, UserVoicePrefs> {
  const out: Record<string, UserVoicePrefs> = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    out[id] = {
      muted: !!p.muted,
      volume: clampVolume(p.volume),
    };
  }
  return out;
}

function clampVolume(v: unknown): number {
  if (typeof v !== 'number' || !isFinite(v)) return 1;
  // Hard ceiling at 2.0 (200%). Going higher risks clipping + ear
  // damage and offers diminishing returns; modern audio gear has
  // ample headroom in the 0–200% range.
  return Math.max(0, Math.min(2, v));
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / private-mode failures are non-fatal — the prefs just
    // won't survive a reload.
  }
  for (const l of listeners) l();
  // Schedule a debounced server-sync. Rapid slider drags otherwise
  // produce one PATCH per pixel of movement; 500ms after the last
  // change is long enough to coalesce a drag into one request and
  // short enough that a tab close shortly after won't lose the
  // change in practice.
  scheduleServerSync();
}

// ── Server sync ─────────────────────────────────────────────────────────────
//
// The voicePrefs module doesn't directly depend on the REST client —
// importing it here would couple a leaf utility to the API layer and
// require all consumers (audio routing, settings UI, level meters)
// to drag that dependency along.
//
// Instead, the React boot code injects a syncer function via
// setVoicePrefsSyncer() once a session is authenticated. The
// syncer is called debounced from persist() whenever state
// changes; failures are swallowed (the local copy is still
// correct, the server one just lags behind by one edit cycle).

type Syncer = (state: VoicePrefsState) => Promise<unknown>;
let syncer: Syncer | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleServerSync() {
  if (!syncer) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const snapshot = state;
    void syncer!(snapshot).catch(() => {
      // Network failures are non-fatal — local state is still
      // authoritative at runtime. The next persisted change will
      // try again with the latest snapshot.
    });
  }, 500);
}

/**
 * Inject the server-sync function. Called once by the React boot
 * code after auth resolves with the REST client bound. Pass null
 * to detach (e.g. on logout).
 */
export function setVoicePrefsSyncer(fn: Syncer | null): void {
  syncer = fn;
}

/**
 * Apply a server-fetched voice-prefs blob over the local state.
 * Each present key on the server overwrites the corresponding
 * local key; keys absent on the server keep their local value
 * (a brand-new server row is an empty object and shouldn't
 * stomp the user's existing local prefs).
 *
 * This function does NOT trigger a re-sync — applying the server
 * snapshot then immediately PATCHing it back would burn an extra
 * request per app boot.
 */
export function hydrateVoicePrefs(serverState: unknown): void {
  if (!serverState || typeof serverState !== 'object') return;
  const incoming = serverState as Partial<VoicePrefsState> & { autoGainControl?: unknown };
  // Run incoming through the same sanitization the loader uses so
  // a malformed or corrupted server blob can't poison local state.
  const next: VoicePrefsState = { ...state };
  if (incoming.perUser && typeof incoming.perUser === 'object') {
    next.perUser = sanitizePerUser(incoming.perUser as Record<string, UserVoicePrefs>);
  }
  if (typeof incoming.masterVolume === 'number') {
    next.masterVolume = clampVolume(incoming.masterVolume);
  }
  if (typeof incoming.micGain === 'number') {
    next.micGain = clampVolume(incoming.micGain);
  }
  if (typeof incoming.noiseSuppression === 'boolean') {
    next.noiseSuppression = incoming.noiseSuppression;
  }
  if (typeof incoming.echoCancellation === 'boolean') {
    next.echoCancellation = incoming.echoCancellation;
  }
  if (incoming.gainMode === 'agc' || incoming.gainMode === 'manual' || incoming.gainMode === 'off') {
    next.gainMode = incoming.gainMode;
  } else if (typeof incoming.autoGainControl === 'boolean') {
    // Backward-compat: pre-round-9 clients sent the legacy boolean.
    next.gainMode = incoming.autoGainControl ? 'agc' : 'off';
  }
  state = next;
  // Update localStorage to match so a refresh after hydration
  // doesn't fall back to the old local copy.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
  // Fire listeners so consumers re-read. We deliberately do NOT
  // call persist() here — that would trigger an unnecessary
  // round-trip PATCH echoing the same state back to the server.
  for (const l of listeners) l();
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getVoicePrefs(): VoicePrefsState {
  return state;
}

/** Stable singleton returned when a user has no overrides. Using a
    module-level constant (instead of a fresh object literal each
    call) is REQUIRED for useSyncExternalStore consumers: that hook
    compares snapshots by reference, so returning a new `{ muted:
    false, volume: 1 }` on every getUserPrefs() call would make
    React see the store as constantly changing and bail with a
    "Maximum update depth exceeded" (#185) infinite-render loop. */
const DEFAULT_USER_PREFS: UserVoicePrefs = Object.freeze({
  muted: false,
  volume: 1,
}) as UserVoicePrefs;

export function getUserPrefs(userId: string): UserVoicePrefs {
  return state.perUser[userId] ?? DEFAULT_USER_PREFS;
}

/** Compute the effective gain for a remote participant. Combines
    per-user volume with the global master multiplier; a muted user
    is always zero regardless of their volume slider position. */
export function computeUserGain(userId: string): number {
  const u = getUserPrefs(userId);
  if (u.muted) return 0;
  return u.volume * state.masterVolume;
}

export function setUserMuted(userId: string, muted: boolean): void {
  const cur = getUserPrefs(userId);
  state = {
    ...state,
    perUser: { ...state.perUser, [userId]: { ...cur, muted } },
  };
  persist();
}

export function setUserVolume(userId: string, volume: number): void {
  const cur = getUserPrefs(userId);
  state = {
    ...state,
    perUser: {
      ...state.perUser,
      [userId]: { ...cur, volume: clampVolume(volume) },
    },
  };
  persist();
}

export function resetUserPrefs(userId: string): void {
  if (!(userId in state.perUser)) return;
  const next = { ...state.perUser };
  delete next[userId];
  state = { ...state, perUser: next };
  persist();
}

export function setMasterVolume(volume: number): void {
  state = { ...state, masterVolume: clampVolume(volume) };
  persist();
}

export function setMicGain(gain: number): void {
  state = { ...state, micGain: clampVolume(gain) };
  persist();
}

/** Toggle the three browser-native audio processing constraints.
    Each takes effect on the next voice-room connection (we don't
    renegotiate the active mic track mid-call — LiveKit doesn't
    expose a clean path for that, and most users tweak these
    settings while NOT in a call anyway). */
export function setNoiseSuppression(on: boolean): void {
  state = { ...state, noiseSuppression: !!on };
  persist();
}

export function setEchoCancellation(on: boolean): void {
  state = { ...state, echoCancellation: !!on };
  persist();
}

/** Set the gain mode. See the docstring on VoicePrefsState.gainMode
    for the semantic difference between 'agc', 'manual', and 'off'. */
export function setGainMode(mode: 'agc' | 'manual' | 'off'): void {
  state = { ...state, gainMode: mode };
  persist();
}

/** Set the noise gate threshold. 0 = no gate (default); 1 = always
    gated (mic effectively muted). The MicLevelMeter exposes this
    as a draggable line on the meter so the user can position the
    threshold visually against their actual speech level. Audio
    processor's envelope-following gate uses this value at call
    time to decide whether to pass or silence the mic signal. */
export function setNoiseGateThreshold(threshold: number): void {
  if (typeof threshold !== 'number' || !isFinite(threshold)) return;
  const clamped = Math.max(0, Math.min(1, threshold));
  state = { ...state, noiseGateThreshold: clamped };
  persist();
}

/** Subscribe to any preference change. Returns an unsubscribe fn. */
export function subscribeVoicePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
