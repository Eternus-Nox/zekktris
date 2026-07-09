/**
 * MicLevelMeter
 * -------------
 * Live input-level visualization for the voice settings panel. Opens
 * its own getUserMedia stream (independent of any active voice
 * connection), runs the samples through an AnalyserNode, and renders
 * a horizontal bar that follows the current RMS level plus a peak-
 * hold marker that decays slowly.
 *
 * Why a second getUserMedia (rather than reading the in-call mic).
 * Most users adjust audio settings BEFORE joining a call — that's
 * exactly when the meter is most useful. Tapping the in-call mic
 * would only work while connected; we want the meter to function
 * from a cold start so the user can set their gain before joining.
 *
 * Cleanup. The stream and AudioContext are torn down on unmount AND
 * on visibility-hidden (so leaving the settings tab to another app
 * doesn't hold an open mic indicator on macOS / iOS). The component
 * also pauses its animation frame when the document isn't visible
 * to avoid wasting CPU.
 *
 * Honest UX caveat. Showing this meter requires mic permission. If
 * the user has previously denied mic access for the origin, calling
 * getUserMedia will throw — we surface that as a friendly inline
 * message rather than a thrown error, since the rest of voice
 * settings is still useful even without the meter.
 */

import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from './icons';
import { getVoicePrefs, setNoiseGateThreshold, subscribeVoicePrefs } from './voicePrefs';
import { isMediaCaptureAvailable, mediaUnavailableMessage } from './mediaSupport';

export function MicLevelMeter() {
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  // Render the threshold from voicePrefs so the marker reflects the
  // saved position; subscribed so external changes (other tabs,
  // settings reset) keep us in sync.
  const [threshold, setThreshold] = useState(() => getVoicePrefs().noiseGateThreshold);
  useEffect(() => {
    return subscribeVoicePrefs(() => {
      setThreshold(getVoicePrefs().noiseGateThreshold);
    });
  }, []);
  const barRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  // Track ref for pointer-event hit-testing — we map clientX to a
  // 0..1 fraction of the meter's width when the user drags the
  // threshold marker.
  const trackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let mediaStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let gainNode: GainNode | null = null;
    let rafHandle = 0;
    let timeData: Uint8Array<ArrayBuffer> | null = null;
    // Peak-hold state: the indicator sticks at the highest recent
    // value for a beat, then decays linearly. Gives the user a
    // sense of headroom that a pure-RMS bar doesn't communicate.
    let peakLevel = 0;
    let peakHoldUntil = 0;
    // Subscribe to micGain pref changes so the visualized level
    // reflects what LiveKit would publish in manual mode. In agc
    // mode we don't apply gain in software (the browser does it
    // upstream), so the meter shows raw post-AGC level.
    let prefsUnsub = () => {};

    async function start() {
      try {
        if (!isMediaCaptureAvailable()) {
          if (!cancelled) setError(mediaUnavailableMessage());
          return;
        }
        mediaStream = await navigator.mediaDevices.getUserMedia({
          // Mirror the user's processing prefs for an accurate
          // visualization — what they see is what gets published
          // (modulo AGC which only runs when published, since we
          // can't enable the constraint in a pure-probe context
          // reliably across browsers).
          audio: {
            echoCancellation: getVoicePrefs().echoCancellation,
            noiseSuppression: getVoicePrefs().noiseSuppression,
            autoGainControl: getVoicePrefs().gainMode === 'agc',
          },
        });
        if (cancelled) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }
        audioContext = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext)();
        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        // For the meter view we apply the manual-gain pref so the
        // visualized level matches what the gained publish would
        // sound like. In 'agc' or 'off' mode the gain is 1.0 (the
        // visualization shows the unaltered signal).
        gainNode = audioContext.createGain();
        const initialMode = getVoicePrefs().gainMode;
        gainNode.gain.value = initialMode === 'manual' ? getVoicePrefs().micGain : 1.0;
        analyser = audioContext.createAnalyser();
        // 1024-bin FFT → 512 samples per frame, enough for an RMS
        // average without per-frame allocation overhead. We don't
        // need frequency resolution — just time-domain amplitude.
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.5;
        sourceNode.connect(gainNode).connect(analyser);
        timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));

        prefsUnsub = subscribeVoicePrefs(() => {
          if (!gainNode || !audioContext) return;
          const p = getVoicePrefs();
          const next = p.gainMode === 'manual' ? p.micGain : 1.0;
          // Smooth ramp matches the manual-gain pipeline so the
          // meter doesn't visually pop on slider drags.
          const t = audioContext.currentTime;
          gainNode.gain.cancelScheduledValues(t);
          gainNode.gain.linearRampToValueAtTime(next, t + 0.02);
        });

        setActive(true);

        const tick = () => {
          if (cancelled || !analyser || !timeData) return;
          // Loop only when the doc is visible — leaves macOS Safari
          // from chewing CPU on a backgrounded tab.
          if (document.visibilityState !== 'visible') {
            rafHandle = requestAnimationFrame(tick);
            return;
          }
          analyser.getByteTimeDomainData(timeData);
          // RMS over the buffer. Bytes are 0..255 centered on 128
          // (the AnalyserNode encodes unsigned PCM); subtract 128
          // to get a signed signal then square-root-mean. Normalize
          // by 128 so the result is 0..1.
          let sum = 0;
          for (let i = 0; i < timeData.length; i++) {
            const v = (timeData[i]! - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / timeData.length);
          // Gentle perceptual curve. Pure RMS makes typical speech
          // sit between 2% and 15% of the bar, which feels
          // unresponsive. A 0.6 power makes the bar reach into
          // the middle for normal speech without saturating on
          // every loud syllable.
          const display = Math.min(1, Math.pow(rms, 0.6));

          const now = performance.now();
          if (display > peakLevel) {
            peakLevel = display;
            peakHoldUntil = now + 800; // hold for ~0.8s
          } else if (now > peakHoldUntil) {
            // Linear decay at ~1.5 per second after hold expires.
            peakLevel = Math.max(display, peakLevel - 0.025);
          }

          if (barRef.current) {
            barRef.current.style.width = `${display * 100}%`;
          }
          if (peakRef.current) {
            peakRef.current.style.left = `${peakLevel * 100}%`;
          }
          if (valueRef.current) {
            // Showing the percentage adds a numeric anchor for users
            // who want to fine-tune their physical gain knob; bar
            // alone is vague.
            valueRef.current.textContent = `${Math.round(display * 100)}%`;
          }
          rafHandle = requestAnimationFrame(tick);
        };
        rafHandle = requestAnimationFrame(tick);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Mic unavailable';
        // Distinguish the two common refusal modes so the help
        // text is actionable. The DOMException name tells us which
        // gate failed.
        if ((err as DOMException)?.name === 'NotAllowedError') {
          setError('Mic permission denied — allow access to see your input level.');
        } else if ((err as DOMException)?.name === 'NotFoundError') {
          setError('No microphone detected.');
        } else if ((err as { name?: string })?.name === 'TypeError') {
          setError(mediaUnavailableMessage());
        } else {
          setError(msg);
        }
      }
    }
    // Fully release the mic + AudioContext (not just pause metering) so the OS
    // in-use indicator clears. Used on unmount AND when the tab/app backgrounds.
    function releaseStream() {
      cancelAnimationFrame(rafHandle);
      try {
        sourceNode?.disconnect();
        gainNode?.disconnect();
        analyser?.disconnect();
      } catch {
        // ignore
      }
      mediaStream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // ignore
        }
      });
      // Closing the AudioContext fully releases its resources.
      if (audioContext && audioContext.state !== 'closed') {
        void audioContext.close().catch(() => {
          // ignore
        });
      }
      sourceNode = null;
      gainNode = null;
      analyser = null;
      mediaStream = null;
      audioContext = null;
      timeData = null;
      setActive(false);
    }

    // The tick loop only PAUSED on hide (kept the stream live), so a backgrounded
    // Settings tab held the mic + OS in-use indicator open — contradicting the
    // documented teardown. Release on hide, re-acquire on show.
    let starting = false;
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        if (!cancelled && !mediaStream && !starting) {
          starting = true;
          void start().finally(() => {
            starting = false;
          });
        }
      } else {
        releaseStream();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    void start();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      prefsUnsub();
      releaseStream();
    };
  }, []);

  // Pointer drag handler for the threshold marker. The whole track
  // is a hit target — tap-to-set anywhere on the bar, drag to fine-
  // tune. Uses setPointerCapture so the drag survives even if the
  // pointer leaves the bar's bounds mid-drag (Web Audio settings
  // panels are often narrow; without capture, dragging slightly
  // off-bar would lose the gesture).
  function onTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = trackRef.current;
    if (!el) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    updateThreshold(e.clientX);
    function onMove(ev: PointerEvent) {
      updateThreshold(ev.clientX);
    }
    function onUp(ev: PointerEvent) {
      try {
        (e.target as Element).releasePointerCapture?.(ev.pointerId);
      } catch {
        // ignore — capture may have already been released by the browser
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function updateThreshold(clientX: number) {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = (clientX - rect.left) / rect.width;
    const clamped = Math.max(0, Math.min(1, fraction));
    setThreshold(clamped); // local state — instant visual feedback
    setNoiseGateThreshold(clamped); // persist + notify audio processor
  }

  // Keyboard support: arrow keys nudge by 1%, shift+arrow by 5%.
  // Home/End jump to 0/100. Standard slider semantics.
  function onMarkerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    const step = e.shiftKey ? 0.05 : 0.01;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = threshold - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = threshold + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    if (next === null) return;
    e.preventDefault();
    const clamped = Math.max(0, Math.min(1, next));
    setThreshold(clamped);
    setNoiseGateThreshold(clamped);
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-1 border border-line text-xs text-ink-3">
        <MicOff size={14} className="shrink-0 text-ink-3" />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 rounded-md bg-bg-1 border border-line">
      <div className="flex items-center gap-2 text-xs text-ink-2 mb-1.5">
        <Mic size={12} className={active ? 'text-emerald-400' : 'text-ink-3'} />
        <span className="font-medium">Mic input</span>
        <span ref={valueRef} className="ml-auto tabular-nums text-ink-3">0%</span>
      </div>
      {/* Meter track. Made taller (h-4 instead of h-2) and
          pointer-event aware so users can grab the threshold
          marker anywhere along the bar. Below-threshold portion
          is dimmed to visually indicate "this much of your input
          will be gated out." */}
      <div
        ref={trackRef}
        className="relative h-4 bg-bg-3 rounded-full overflow-hidden cursor-pointer select-none touch-none"
        onPointerDown={onTrackPointerDown}
        role="presentation"
      >
        {/* Active RMS bar — width updated each frame. The
            gradient drifts from green (safe) through amber to
            red (near-clipping) so the user gets a visual
            warning when they're peaking close to digital max. */}
        <div
          ref={barRef}
          className="absolute inset-y-0 left-0 transition-[width] duration-[40ms] pointer-events-none"
          style={{
            width: '0%',
            background:
              'linear-gradient(to right, rgb(52,211,153) 0%, rgb(52,211,153) 60%, rgb(251,191,36) 80%, rgb(239,68,68) 100%)',
            backgroundSize: '500% 100%',
            backgroundPosition: 'left center',
          }}
        />
        {/* Below-threshold scrim: a translucent overlay covering
            0..threshold% that visually communicates "this part
            of the signal will be gated out." Sits ABOVE the
            RMS bar so it can dim the bar's color within the
            gated region. */}
        {threshold > 0 && (
          <div
            className="absolute inset-y-0 left-0 pointer-events-none bg-bg-1/70"
            style={{ width: `${threshold * 100}%` }}
            aria-hidden
          />
        )}
        {/* Peak-hold marker — a thin vertical line that sticks
            at the highest recent value and slowly decays. */}
        <div
          ref={peakRef}
          className="absolute top-0 bottom-0 w-0.5 bg-ink-1/70 pointer-events-none"
          style={{ left: '0%' }}
        />
        {/* Threshold marker — a draggable vertical bar. Visible
            even when threshold === 0 (the gate is disabled) so
            the user can see where to grab and start dragging.
            Keyboard-focusable via tabIndex so users on screen
            readers / no-pointer setups can adjust it too. */}
        <div
          tabIndex={0}
          role="slider"
          aria-label="Noise gate threshold"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(threshold * 100)}
          aria-valuetext={
            threshold === 0
              ? 'Noise gate disabled'
              : `Noise gate at ${Math.round(threshold * 100)}%`
          }
          onKeyDown={onMarkerKeyDown}
          className="absolute top-0 bottom-0 w-1 -ml-0.5 bg-violet-400 cursor-ew-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-1"
          style={{ left: `${threshold * 100}%` }}
        >
          {/* Drag affordance — a small hex-shaped grip at the top
              of the line. Indicates this element is interactive
              even when it's at the bar's far left/right edges. */}
          <span
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-sm bg-violet-400 ring-2 ring-bg-1 pointer-events-none"
            aria-hidden
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-[0.65rem] text-ink-3 mt-1.5 leading-tight">
        <span>
          {threshold === 0
            ? 'No noise gate. Drag the line right to silence the mic below that level.'
            : `Noise gate at ${Math.round(threshold * 100)}% — input quieter than this is silenced.`}
        </span>
        {threshold > 0 && (
          <button
            type="button"
            className="text-violet-300 hover:text-violet-200 underline underline-offset-2"
            onClick={() => {
              setThreshold(0);
              setNoiseGateThreshold(0);
            }}
          >
            Disable
          </button>
        )}
      </div>
    </div>
  );
}
