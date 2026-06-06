/**
 * Web Audio noise/compression processor for the outgoing mic track.
 *
 * Implements LiveKit's TrackProcessor interface — attach to a
 * LocalAudioTrack via track.setProcessor() and LiveKit will publish
 * the processed stream instead of the raw mic.
 *
 * Pipeline:
 *
 *     [raw mic] → [highpass 85Hz] → [compressor] → [lowpass 10kHz] → [makeup gain] → [publish]
 *
 * Browser-native noiseSuppression (the getUserMedia flag) runs
 * BEFORE this chain. So the order of operations is:
 *
 *   1. Hardware capture
 *   2. Browser's noise suppressor (steady-state noise removal)
 *   3. Browser's AGC (volume normalization, if enabled)
 *   4. Highpass (this file) — kills low rumble the suppressor leaves
 *   5. Compressor — evens out dynamic range
 *   6. Lowpass — cuts hiss above speech
 *   7. Makeup gain — restores compressed level
 *   8. Encode + send via LiveKit
 *
 * Stages 4-7 collectively eliminate the noise + level-instability
 * cases the browser-native suppressor doesn't catch. Tuned for
 * voice (not music); the lowpass would mangle music transients.
 */

import type { TrackProcessor, AudioProcessorOptions, Track } from 'livekit-client';

/**
 * Build a fresh processor instance. Each LiveKit LocalAudioTrack
 * needs its own — sharing across tracks would have the second
 * track's source replace the first's, breaking the chain.
 */
export function createNoiseCompressor(): TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  // Closure state held across init/restart/destroy. We track every
  // node we create so destroy() can disconnect them — Web Audio
  // doesn't garbage-collect connected nodes, leaks compound across
  // mic restarts (mute toggle, device change).
  let source: MediaStreamAudioSourceNode | null = null;
  let highpass: BiquadFilterNode | null = null;
  let compressor: DynamicsCompressorNode | null = null;
  let lowpass: BiquadFilterNode | null = null;
  let makeup: GainNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;

  // Noise-gate state. The gate is a software downward expander:
  //   - An AnalyserNode taps the post-compressor signal so we
  //     measure the same envelope the meter shows the user.
  //   - A GainNode AFTER the makeup stage applies 0/1 (closed/open)
  //     with smooth ramps so listeners don't hear clicks.
  //   - A requestAnimationFrame loop reads the analyser and decides
  //     open/closed against the current threshold (~60Hz check rate
  //     — way faster than human speech onset, so we won't clip the
  //     front of a syllable).
  //   - Hysteresis + hold-time prevents fluttering: a brief silence
  //     mid-word doesn't slam the gate shut.
  let gateAnalyser: AnalyserNode | null = null;
  let gateGain: GainNode | null = null;
  let gateBuffer: Uint8Array<ArrayBuffer> | null = null;
  let gateRaf = 0;
  let gateTimer: ReturnType<typeof setInterval> | null = null;
  let gateOnVisibility: (() => void) | null = null;
  let gateThreshold = 0; // 0..1, in same units as MicLevelMeter
  let gatePrefsUnsub: (() => void) | null = null;

  function build(opts: AudioProcessorOptions): MediaStreamTrack {
    const ctx = opts.audioContext;

    // Wrap the raw mic track in a stream so MediaStreamSource can
    // take it. Single-track stream; LiveKit always passes one track.
    const inputStream = new MediaStream([opts.track]);
    source = ctx.createMediaStreamSource(inputStream);

    // Stage 1: High-pass at 85Hz. Removes AC hum (50Hz EU, 60Hz US),
    // HVAC rumble, table thumps, footsteps thumping desks, mic-stand
    // bumps. Q=0.7 gives a natural-sounding rolloff (12dB/octave at
    // the corner). Male fundamentals start around 85Hz so we stay
    // safely below speech content.
    highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 85;
    highpass.Q.value = 0.7;

    // Stage 2: Dynamics compressor. Broadcast-style settings:
    //
    //   threshold -22dB: typical voice peaks; compressor engages
    //     when the signal exceeds this. Below threshold the signal
    //     is unaffected (no audible "pumping").
    //   knee 6dB:       soft knee — compression ratio ramps in
    //     gradually around the threshold instead of hitting hard.
    //     Sounds more natural for voice.
    //   ratio 4:1:      moderate compression. For every 4dB the
    //     signal exceeds threshold, output rises 1dB. Tames bursts
    //     without flattening dynamics entirely.
    //   attack 3ms:     fast enough to catch transient peaks (key
    //     clacks, coughs) before they clip.
    //   release 250ms:  natural-sounding decay back to unity gain
    //     after a peak. Too fast → pumping; too slow → audible
    //     ducking on the syllable after a peak.
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    // Stage 3: Low-pass at 10kHz. Cuts hiss/sibilance above the
    // useful speech band. Speech intelligibility tops out around
    // 6-8kHz; "s" and "sh" sit at 6-9kHz; we leave 10kHz headroom
    // so consonants stay crisp while removing the tape-hiss-style
    // noise that creeps in above speech.
    lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 10000;
    lowpass.Q.value = 0.7;

    // Stage 4: Makeup gain. The compressor knocks ~3-4dB off the
    // signal level on average; we add it back so the final published
    // track lands at a consistent loudness. 1.5x ≈ +3.5dB.
    makeup = ctx.createGain();
    makeup.gain.value = 1.5;

    // Stage 5: Noise gate. Side-chained envelope detector + a gate
    // GainNode that flips between 0 and 1 with smooth ramps. Built
    // from a Web-Audio-native AnalyserNode (no AudioWorklet) so it
    // works on every browser without extra build plumbing. The
    // gate is wired post-makeup so the envelope detector reads the
    // SAME signal level the user sees on the MicLevelMeter — the
    // threshold value from the slider matches what's on the bar.
    //
    // Disabled when threshold is 0 (the gate just passes everything
    // through), so the default behavior is unchanged from before
    // this stage existed; the user opts in by dragging the meter's
    // threshold line up.
    gateAnalyser = ctx.createAnalyser();
    gateAnalyser.fftSize = 1024;
    gateAnalyser.smoothingTimeConstant = 0.3;
    gateBuffer = new Uint8Array(new ArrayBuffer(gateAnalyser.fftSize));

    gateGain = ctx.createGain();
    gateGain.gain.value = 1; // start open

    // Stage 6: Output destination. Provides a MediaStream we hand
    // back to LiveKit as the processed track.
    destination = ctx.createMediaStreamDestination();

    // Wire the chain.
    //   makeup → gateGain → destination (main signal path)
    //   makeup → gateAnalyser           (side-chain envelope read)
    source.connect(highpass);
    highpass.connect(compressor);
    compressor.connect(lowpass);
    lowpass.connect(makeup);
    makeup.connect(gateGain);
    makeup.connect(gateAnalyser); // side-chain — not connected to dest
    gateGain.connect(destination);

    // Initial threshold + subscription for live updates from the
    // settings UI. Reading the pref lazily here means we don't
    // need a hard dep on voicePrefs from the public API of this
    // module — it's optional and pulled at runtime.
    void (async () => {
      const { getVoicePrefs, subscribeVoicePrefs } = await import('./voicePrefs');
      gateThreshold = getVoicePrefs().noiseGateThreshold ?? 0;
      gatePrefsUnsub = subscribeVoicePrefs(() => {
        gateThreshold = getVoicePrefs().noiseGateThreshold ?? 0;
      });
    })();

    // Animation frame loop: poll the analyser ~60Hz, decide
    // open/closed, ramp the gate gain smoothly.
    //
    // Hysteresis: the gate opens at threshold but doesn't close
    // until level falls 6dB BELOW threshold AND stays there for
    // 150ms. Without hysteresis the gate flutters open/closed
    // between syllables (typical speech pauses are 100-200ms
    // long with brief glottal-stop dips below threshold).
    //
    // Ramp: 8ms attack on open, 80ms release on close. Open
    // fast so the start of a syllable isn't clipped; close
    // slow so listeners don't hear an audible "thump" at the
    // end of each phrase.
    let belowSince = 0;
    let gateIsOpen = true;
    const HOLD_MS = 150;
    const HYSTERESIS = 0.85; // close threshold = open * 0.85
    const openGate = () => {
      if (!gateGain) return;
      gateGain.gain.cancelScheduledValues(ctx.currentTime);
      gateGain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.008);
      gateIsOpen = true;
      belowSince = 0;
    };
    const tick = () => {
      if (!gateAnalyser || !gateBuffer || !gateGain) return;
      // Threshold of 0 disables the gate entirely. We keep the
      // loop running so re-enabling via slider drag works without
      // restarting the chain, but skip all the math.
      if (gateThreshold <= 0) {
        if (!gateIsOpen) openGate();
        return;
      }
      // Fail OPEN whenever the tab is hidden/backgrounded. The driving
      // timer is throttled hard (and rAF would stop outright) when the
      // page isn't visible, so we can't reliably run the envelope
      // detector — and a stuck-closed gate would silently mute the
      // user mid-sentence while they look at another window. Passing
      // everything through is the safe failure mode.
      if (typeof document !== 'undefined' && document.hidden) {
        if (!gateIsOpen) openGate();
        return;
      }

      gateAnalyser.getByteTimeDomainData(gateBuffer);
      // RMS in the same units the meter uses — 0..1 after
      // perceptual curve. Matches MicLevelMeter exactly so the
      // threshold value on the slider corresponds to what the
      // user sees on the bar.
      let sum = 0;
      for (let i = 0; i < gateBuffer.length; i++) {
        const v = (gateBuffer[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / gateBuffer.length);
      const level = Math.min(1, Math.pow(rms, 0.6));

      const now = performance.now();
      const closeThreshold = gateThreshold * HYSTERESIS;
      if (gateIsOpen) {
        if (level < closeThreshold) {
          if (belowSince === 0) belowSince = now;
          if (now - belowSince >= HOLD_MS) {
            // Close the gate — 80ms release ramp.
            gateGain.gain.cancelScheduledValues(ctx.currentTime);
            gateGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
            gateIsOpen = false;
          }
        } else {
          belowSince = 0;
        }
      } else {
        if (level >= gateThreshold) {
          // Open the gate — 8ms attack ramp.
          openGate();
        }
      }
    };
    // Drive the gate from a steady interval rather than rAF.
    // requestAnimationFrame is paused completely when the tab is in the
    // background, which froze the gate (a common cause of "my mic cuts
    // out when I'm not looking at the call"). A ~33ms interval keeps
    // ticking; combined with the fail-open-when-hidden check above, the
    // gate never gets stuck closed.
    gateTimer = setInterval(tick, 33);
    // Open immediately the moment the page is hidden, without waiting
    // for the (now heavily throttled) interval to fire.
    gateOnVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) openGate();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', gateOnVisibility);
    }

    const tracks = destination.stream.getAudioTracks();
    if (tracks.length === 0) {
      throw new Error(
        'createNoiseCompressor: MediaStreamDestination produced no audio tracks',
      );
    }
    return tracks[0]!;
  }

  function teardown() {
    // Cancel the gate's polling loop FIRST so it doesn't try to
    // read from nodes that are about to be disconnected.
    if (gateRaf) {
      cancelAnimationFrame(gateRaf);
      gateRaf = 0;
    }
    if (gateTimer) {
      clearInterval(gateTimer);
      gateTimer = null;
    }
    if (gateOnVisibility) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', gateOnVisibility);
      }
      gateOnVisibility = null;
    }
    if (gatePrefsUnsub) {
      gatePrefsUnsub();
      gatePrefsUnsub = null;
    }
    // Disconnect each node so the graph is removed from the audio
    // context's processing tree. Without disconnect(), nodes stay
    // alive (Web Audio's GC contract is "if reachable from any
    // connected destination, keep processing"). Wrap each in try/
    // catch because disconnect on an already-disconnected node
    // throws InvalidAccessError on some browsers.
    for (const node of [
      source,
      highpass,
      compressor,
      lowpass,
      makeup,
      gateAnalyser,
      gateGain,
      destination,
    ]) {
      try {
        node?.disconnect();
      } catch {
        // already disconnected — fine
      }
    }
    source = null;
    highpass = null;
    compressor = null;
    lowpass = null;
    makeup = null;
    gateAnalyser = null;
    gateGain = null;
    gateBuffer = null;
    destination = null;
  }

  // Build the processor object. processedTrack is mutable so init()
  // can populate it; LiveKit reads it after init() resolves and
  // again after restart().
  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: 'zk-noise-compressor',
    async init(opts) {
      processor.processedTrack = build(opts);
    },
    async restart(opts) {
      // LiveKit calls restart when the source track changes (device
      // switch, mute-cycle on some browsers). Tear down the old
      // chain before building a new one so we don't leak nodes.
      teardown();
      processor.processedTrack = build(opts);
    },
    async destroy() {
      teardown();
      processor.processedTrack = undefined;
    },
  };
  return processor;
}
