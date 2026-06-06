/**
 * Notification sounds
 * -------------------
 * Synthesized via the Web Audio API — no audio files to bundle, load,
 * or serve. Works identically in the browser, the installed PWA, and
 * the Electron desktop shell.
 *
 * Two sounds:
 *   - playMessagePing()  a soft bell for new mentions / DMs (one-shot)
 *   - startRingtone()    a looping phone-style ring for incoming calls
 *   - stopRingtone()     stops the loop (on answer / decline / timeout)
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

// ── Message ping ────────────────────────────────────────────────────────────
// A gentle two-note bell. Rate-limited so a burst of mentions doesn't
// stack into a chord.
let lastPingAt = 0;

export function playMessagePing(): void {
  const now = Date.now();
  if (now - lastPingAt < 1000) return;
  lastPingAt = now;

  const ctx = getCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    // [frequencyHz, startOffsetSec, durationSec, peakGain]
    const tones: Array<[number, number, number, number]> = [
      [880, 0, 0.14, 0.09], // high tap
      [660, 0.11, 0.22, 0.08], // settle a touch lower
    ];
    for (const [freq, start, dur, peak] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.012);
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
