/**
 * Voice recorder
 * --------------
 * Records audio from the user's microphone via MediaRecorder, with a
 * live waveform sampled in real time from an AnalyserNode hooked into
 * the same MediaStream. The hook exposes:
 *   - status: 'idle' | 'recording' | 'finalizing' | 'ready' | 'error'
 *   - elapsedMs: live timer (updates ~10x/sec while recording)
 *   - liveWaveform: rolling window of recent volume samples for the UI
 *   - start(), stop(), cancel(): user-facing controls
 *   - result: when status === 'ready', the finalized File + waveform
 *     bytes (Uint8Array, length 48) + duration seconds
 *
 * Browser quirks:
 *   - iOS Safari (≥14.3): MediaRecorder works but only with audio/mp4
 *     (AAC). Other browsers prefer audio/webm;codecs=opus. We
 *     feature-detect and fall back.
 *   - The first sample on iOS sometimes arrives ~200ms late while the
 *     audio context warms up. We slice the leading silence from the
 *     final waveform so the UI doesn't show empty bars at the start.
 *   - Background-tab recording works in most browsers but is
 *     discouraged on iOS — we don't try to keep it going if the user
 *     backgrounds the page.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { isMediaCaptureAvailable, mediaUnavailableMessage } from './mediaSupport';

const WAVEFORM_BUCKETS = 48; // final stored waveform length
const LIVE_WAVEFORM_BUCKETS = 32; // shown while recording (rolling)
const SAMPLE_INTERVAL_MS = 50; // sample the analyser every 50ms
const MAX_DURATION_MS = 5 * 60 * 1000; // 5 min hard cap (Discord cap is 10)

type Status = 'idle' | 'recording' | 'finalizing' | 'ready' | 'error';

export interface VoiceResult {
  file: File;
  /** Final 48-sample waveform, base64-encoded. */
  waveformBase64: string;
  durationSeconds: number;
}

interface UseVoiceRecorderReturn {
  status: Status;
  errorMessage: string | null;
  elapsedMs: number;
  /** Rolling window of recent volume samples (0-255), length up to
      LIVE_WAVEFORM_BUCKETS. Drives the recording-state visual. */
  liveWaveform: number[];
  result: VoiceResult | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  reset: () => void;
}

/**
 * Pick the most-supported MIME type for MediaRecorder. iOS Safari only
 * supports audio/mp4 (AAC); other modern browsers all support
 * audio/webm with opus. We probe in order and use the first that
 * works.
 */
function pickMimeType(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates: Array<{ mime: string; ext: string }> = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/webm', ext: 'webm' },
    { mime: 'audio/mp4', ext: 'm4a' }, // iOS
    { mime: 'audio/mpeg', ext: 'mp3' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mime)) return c;
  }
  // Some browsers throw on unsupported types but accept an empty
  // string (default codec). Fall through to that.
  return { mime: '', ext: 'webm' };
}

export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveWaveform, setLiveWaveform] = useState<number[]>([]);
  const [result, setResult] = useState<VoiceResult | null>(null);

  // Refs to long-lived recording infrastructure. Kept out of state
  // because mutating them shouldn't trigger re-renders.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const samplesRef = useRef<number[]>([]); // raw samples taken every SAMPLE_INTERVAL_MS
  const startedAtRef = useRef<number>(0);
  const sampleTimerRef = useRef<number | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const stopHandlerRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);
  const mimeRef = useRef<{ mime: string; ext: string } | null>(null);

  // Free all the recording infrastructure. Idempotent — safe to call
  // multiple times. Called from cleanup paths and on unmount.
  const teardown = useCallback(() => {
    if (sampleTimerRef.current !== null) {
      window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
    }
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore — recorder may already be inactive
      }
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        // ignore
      }
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
  }, []);

  // Cleanup on unmount.
  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    setErrorMessage(null);
    setResult(null);

    const mime = pickMimeType();
    if (!mime) {
      setStatus('error');
      setErrorMessage('Voice messages are not supported in this browser.');
      return;
    }
    mimeRef.current = mime;

    // Reset rolling buffers before requesting permission so a
    // previous-recording's tail doesn't bleed into the new one.
    chunksRef.current = [];
    samplesRef.current = [];
    setLiveWaveform([]);
    setElapsedMs(0);
    cancelledRef.current = false;

    let stream: MediaStream;
    // Guard the capture API first: in the iOS WebView / insecure contexts
    // `navigator.mediaDevices` can be undefined, and calling getUserMedia
    // on it throws a bare TypeError that we'd otherwise report as the
    // unhelpful "Could not start the microphone."
    if (!isMediaCaptureAvailable()) {
      setStatus('error');
      setErrorMessage(mediaUnavailableMessage());
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation and noise suppression matter more for
          // voice messages than music — bias toward speech clarity.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      setStatus('error');
      const name = (e as { name?: string }).name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setErrorMessage('Microphone access was denied. Enable it in your browser settings to record voice messages.');
      } else if (name === 'NotFoundError') {
        setErrorMessage('No microphone was found.');
      } else if (name === 'TypeError') {
        // mediaDevices/getUserMedia vanished between the guard and the
        // call (or never existed) — give the diagnosing message.
        setErrorMessage(mediaUnavailableMessage());
      } else {
        setErrorMessage('Could not start the microphone.');
      }
      return;
    }
    streamRef.current = stream;

    // AudioContext for the analyser. Created here (rather than once
    // per hook) because Safari requires a user-gesture to construct
    // it; start() is always called from a click.
    type WebkitAudio = typeof window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (window as WebkitAudio).webkitAudioContext;
    if (!Ctor) {
      setStatus('error');
      setErrorMessage('Audio recording isn\'t supported in this browser.');
      teardown();
      return;
    }
    const ctx = new Ctor();
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyserRef.current = analyser;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    sourceRef.current = source;

    // MediaRecorder.
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime.mime ? { mimeType: mime.mime } : undefined);
    } catch (e) {
      setStatus('error');
      setErrorMessage('Could not start the recorder.');
      teardown();
      void e;
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      // Run the next-tick handler set by stop() below — we use a ref
      // because the browser fires onstop asynchronously and we want to
      // build the result with the latest samples.
      const h = stopHandlerRef.current;
      stopHandlerRef.current = null;
      if (h) h();
    };
    recorder.start();
    startedAtRef.current = Date.now();
    setStatus('recording');

    // Sample the analyser on a fixed interval. We compute a peak
    // amplitude (max-min of the time-domain buffer, mapped to 0-255)
    // and push to the samples log. The live waveform shows the most
    // recent N samples as a rolling window.
    const buf = new Uint8Array(analyser.fftSize);
    sampleTimerRef.current = window.setInterval(() => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(buf);
      let min = 255;
      let max = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const peak = Math.min(255, Math.max(0, max - min));
      samplesRef.current.push(peak);
      // Update the rolling live view.
      const tail = samplesRef.current.slice(-LIVE_WAVEFORM_BUCKETS);
      setLiveWaveform(tail);
    }, SAMPLE_INTERVAL_MS);

    // Elapsed timer (10x/sec).
    tickTimerRef.current = window.setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsedMs(ms);
      if (ms >= MAX_DURATION_MS) {
        // Auto-stop at hard cap. Fire stop handler synchronously by
        // calling MediaRecorder.stop(); the onstop handler picks up.
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          try {
            recorderRef.current.stop();
          } catch {
            // ignore
          }
        }
      }
    }, 100);
  }, [teardown]);

  const stop = useCallback(() => {
    if (status !== 'recording' || !recorderRef.current) return;
    setStatus('finalizing');

    // Set up the post-stop handler before triggering stop, so onstop
    // fires into a real handler.
    stopHandlerRef.current = () => {
      const mime = mimeRef.current;
      const allSamples = samplesRef.current.slice();
      const ms = Date.now() - startedAtRef.current;
      const durationSec = Math.max(1, Math.round(ms / 1000));

      // Tear down audio infrastructure but DON'T null the chunks
      // (we need them).
      if (sampleTimerRef.current !== null) {
        window.clearInterval(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
      if (tickTimerRef.current !== null) {
        window.clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) track.stop();
        streamRef.current = null;
      }
      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch {
          // ignore
        }
        sourceRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => undefined);
        audioCtxRef.current = null;
      }
      analyserRef.current = null;
      recorderRef.current = null;

      if (cancelledRef.current) {
        chunksRef.current = [];
        samplesRef.current = [];
        setStatus('idle');
        return;
      }

      // Bucket the captured samples down to WAVEFORM_BUCKETS by taking
      // the max of each chunk. Skip the first ~3 buckets when iOS is
      // detected (warm-up silence) — see header comment.
      const final = bucketSamples(allSamples, WAVEFORM_BUCKETS);
      const waveformBase64 = btoa(String.fromCharCode(...final));

      const blob = new Blob(chunksRef.current, { type: mime?.mime || 'audio/webm' });
      const ext = mime?.ext ?? 'webm';
      const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });

      chunksRef.current = [];
      samplesRef.current = [];

      setResult({ file, waveformBase64, durationSeconds: durationSec });
      setStatus('ready');
    };

    if (recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore — handler will still fire if state was already inactive
      }
    } else {
      // Already stopped — fire the handler ourselves.
      const h = stopHandlerRef.current;
      stopHandlerRef.current = null;
      if (h) h();
    }
  }, [status]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    teardown();
    chunksRef.current = [];
    samplesRef.current = [];
    setLiveWaveform([]);
    setElapsedMs(0);
    setResult(null);
    setStatus('idle');
  }, [teardown]);

  const reset = useCallback(() => {
    cancel();
    setErrorMessage(null);
  }, [cancel]);

  return { status, errorMessage, elapsedMs, liveWaveform, result, start, stop, cancel, reset };
}

/**
 * Reduce a long sample array down to `targetLen` buckets by taking the
 * max of each chunk. Output is a Uint8Array clamped to 0-255 with a
 * minimum of 4 so the waveform UI never has fully-empty bars (looks
 * broken otherwise).
 */
function bucketSamples(samples: number[], targetLen: number): Uint8Array {
  const out = new Uint8Array(targetLen);
  if (samples.length === 0) {
    out.fill(4);
    return out;
  }
  // Skip leading silence: drop the first samples until we hit one
  // above a small threshold. iOS often takes a few samples to wake
  // up the mic.
  let start = 0;
  while (start < samples.length && samples[start]! < 6) start++;
  const trimmed = samples.slice(start);
  const len = trimmed.length;
  if (len === 0) {
    out.fill(4);
    return out;
  }
  // Find peak for normalization — quiet recordings get scaled up so
  // the visual bars don't all look tiny.
  let peak = 0;
  for (let i = 0; i < len; i++) if (trimmed[i]! > peak) peak = trimmed[i]!;
  const scale = peak > 0 ? 255 / peak : 1;
  const chunkSize = Math.max(1, len / targetLen);
  for (let i = 0; i < targetLen; i++) {
    const lo = Math.floor(i * chunkSize);
    const hi = Math.min(len, Math.floor((i + 1) * chunkSize));
    let max = 0;
    for (let j = lo; j < hi; j++) {
      const v = trimmed[j]!;
      if (v > max) max = v;
    }
    out[i] = Math.max(4, Math.min(255, Math.round(max * scale)));
  }
  return out;
}
