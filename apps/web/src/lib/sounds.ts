/**
 * Notification sounds
 * -------------------
 * Synthesized via the Web Audio API — no audio files to bundle, load,
 * or serve. Works identically in the browser, the installed PWA, and
 * the Electron desktop shell.
 *
 * Sounds:
 *   - playMessagePing()  a soft bell for new mentions / DMs (one-shot)
 *   - startRingtone()    a looping phone-style ring for incoming calls
 *   - stopRingtone()     stops the loop (on answer / decline / timeout)
 *   - playCallConnect()  you joined/answered a call
 *   - playCallEnd()      the call ended (either side)
 *   - playVoiceJoin()    someone ELSE entered your voice channel
 *   - playVoiceLeave()   someone ELSE left your voice channel
 *
 * A single shared AudioContext is lazily created on first use. Browsers
 * suspend audio until a user gesture; we resume best-effort and the
 * next sound retries if it's still suspended.
 */

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  type AudioCtor = typeof AudioContext;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => undefined);
  }
  return audioCtx;
}

// ── Shared one-shot tone scheduler ──────────────────────────────────────────
/**
 * Schedule a sequence of sine tones relative to "now".
 *
 * Each tone is `[frequencyHz, startOffsetSec, durationSec, peakGain]`.
 * The envelope is a short exponential attack into `peakGain` followed by
 * an exponential decay to (near) silence — exponential rather than linear
 * because ramping a gain node to a hard 0 produces an audible click.
 *
 * Every one-shot sound in this file goes through here so they share one
 * envelope shape and one failure mode: sound is decorative, so a dead or
 * blocked AudioContext is swallowed rather than surfaced.
 */
function scheduleTones(tones: Array<[number, number, number, number]>): void {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    for (const [freq, start, dur, peak] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // Attack is normally 12ms, but must stay well inside the tone or a
      // short blip would still be ramping up when it's told to decay
      // (which inverts the envelope and clicks).
      const attack = Math.min(0.012, dur * 0.3);
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + start + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.05);
    }
  } catch {
    // Sound is non-essential; the badge is the authoritative signal.
  }
}

// ── Message ping ────────────────────────────────────────────────────────────
// A gentle two-note bell. Rate-limited so a burst of mentions doesn't
// stack into a chord.
let lastPingAt = 0;

export function playMessagePing(): void {
  const now = Date.now();
  if (now - lastPingAt < 1000) return;
  lastPingAt = now;

  scheduleTones([
    [880, 0, 0.14, 0.09], // high tap
    [660, 0.11, 0.22, 0.08], // settle a touch lower
  ]);
}

// ── Ringtone ──────────────────────────────────────────────────────────────────
// A looping phone-style ring for incoming calls. Each "ring" is a pair
// of short dual-tone bursts ("br-ring"), then a gap, repeating until
// stopRingtone() is called. We schedule one ring immediately and then
// every RING_PERIOD_MS via an interval.

const RING_PERIOD_MS = 3200;
let ringInterval: ReturnType<typeof setInterval> | null = null;
// Live nodes for the current ring, so stopRingtone can cut them off
// mid-burst instead of letting the tail play out.
let ringNodes: Array<OscillatorNode> = [];

function scheduleOneRing(ctx: AudioContext): void {
  // Classic ringer uses two simultaneous frequencies (440 + 480 Hz).
  // Two bursts: on 0.4s, off 0.2s, on 0.4s.
  const t0 = ctx.currentTime + 0.02;
  const bursts: Array<[number, number]> = [
    [0, 0.4],
    [0.6, 0.4],
  ];
  const freqs = [440, 480];
  for (const [start, dur] of bursts) {
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      // Soft attack/release so each burst doesn't click.
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.03);
      gain.gain.setValueAtTime(0.12, t0 + start + dur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
      ringNodes.push(osc);
      osc.onended = () => {
        ringNodes = ringNodes.filter((n) => n !== osc);
      };
    }
  }
}

export function startRingtone(): void {
  const ctx = getCtx();
  if (!ctx) return;
  // Already ringing — don't stack a second loop.
  if (ringInterval) return;
  try {
    scheduleOneRing(ctx);
    ringInterval = setInterval(() => {
      const c = getCtx();
      if (c) scheduleOneRing(c);
    }, RING_PERIOD_MS);
  } catch {
    stopRingtone();
  }
}

export function stopRingtone(): void {
  if (ringInterval) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
  // Cut any in-flight burst.
  for (const osc of ringNodes) {
    try {
      osc.stop();
    } catch {
      // already stopped
    }
  }
  ringNodes = [];
}

// ── Ringback ────────────────────────────────────────────────────────────────
// What the *caller* hears while waiting for the other side to answer.
// Softer and slower than the incoming ringtone (single longer tone,
// longer gap) so the two are clearly different sounds.

const RINGBACK_PERIOD_MS = 4000;
let ringbackInterval: ReturnType<typeof setInterval> | null = null;
let ringbackNodes: Array<OscillatorNode> = [];

function scheduleOneRingback(ctx: AudioContext): void {
  const t0 = ctx.currentTime + 0.02;
  const dur = 1.2;
  for (const f of [440, 480]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.05);
    gain.gain.setValueAtTime(0.06, t0 + dur - 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    ringbackNodes.push(osc);
    osc.onended = () => {
      ringbackNodes = ringbackNodes.filter((n) => n !== osc);
    };
  }
}

export function startRingback(): void {
  const ctx = getCtx();
  if (!ctx) return;
  if (ringbackInterval) return;
  try {
    scheduleOneRingback(ctx);
    ringbackInterval = setInterval(() => {
      const c = getCtx();
      if (c) scheduleOneRingback(c);
    }, RINGBACK_PERIOD_MS);
  } catch {
    stopRingback();
  }
}

export function stopRingback(): void {
  if (ringbackInterval) {
    clearInterval(ringbackInterval);
    ringbackInterval = null;
  }
  for (const osc of ringbackNodes) {
    try {
      osc.stop();
    } catch {
      // already stopped
    }
  }
  ringbackNodes = [];
}

// ── Voice-channel event sounds ──────────────────────────────────────────────
//
// Four short sine blips that mark voice lifecycle events. The exact
// frequencies, durations and peak gains below are a CROSS-PLATFORM
// CONTRACT — iOS and Android synthesize the same numbers so the app
// sounds like one product. Don't retune one platform in isolation.
//
//   CONNECT  C5→G5, 90ms each, peak 0.16 — ascending, definitive
//   HANGUP   G5→C5, 110ms each, peak 0.16 — descending, definitive
//   JOIN     E5→A5, 55ms each, peak 0.09 — short ascending blip
//   LEAVE    A5→E5, 55ms each, peak 0.09 — short descending blip
//
// Join/leave are deliberately ~half the volume and half the length of
// connect/hangup: they are AMBIENT events about other people that may
// fire often, not the local user's own deliberate action.
//
// Callers are responsible for the behavioural gates (self-vs-other,
// current-channel-only, deafened suppression) — this module only knows
// how to make noise. See lib/voice.ts and state/AppState.tsx.

const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880.0;

/** You joined or answered a call. Ascending, once per genuine join. */
export function playCallConnect(): void {
  scheduleTones([
    [C5, 0, 0.09, 0.16],
    [G5, 0.09, 0.09, 0.16],
  ]);
}

/** The call ended — local hangup or the remote party ending it. Descending. */
export function playCallEnd(): void {
  scheduleTones([
    [G5, 0, 0.11, 0.16],
    [C5, 0.11, 0.11, 0.16],
  ]);
}

// Join/leave are rate-limited independently. Five people joining at once
// should read as a single blip, not a chord — so within the window we
// drop rather than queue (a queued burst would just be the chord again,
// spread over a second). Connect/hangup are unlimited: they happen once
// per call by construction.
const VOICE_EVENT_MIN_GAP_MS = 300;
let lastJoinAt = 0;
let lastLeaveAt = 0;

/** SOMEONE ELSE entered the voice channel you're currently in. */
export function playVoiceJoin(): void {
  const now = Date.now();
  if (now - lastJoinAt < VOICE_EVENT_MIN_GAP_MS) return;
  lastJoinAt = now;
  scheduleTones([
    [E5, 0, 0.055, 0.09],
    [A5, 0.055, 0.055, 0.09],
  ]);
}

/** SOMEONE ELSE left the voice channel you're currently in. */
export function playVoiceLeave(): void {
  const now = Date.now();
  if (now - lastLeaveAt < VOICE_EVENT_MIN_GAP_MS) return;
  lastLeaveAt = now;
  scheduleTones([
    [A5, 0, 0.055, 0.09],
    [E5, 0.055, 0.055, 0.09],
  ]);
}
