/**
 * manualGain
 * ----------
 * Web Audio processing for the "manual gain mode" voice setting.
 *
 * Background. When the user picks `gainMode === 'manual'` in voice
 * settings, browser AGC is disabled (so it doesn't fight the user's
 * manual adjustment) and we pipe the captured mic through a
 * GainNode whose `.gain.value` is bound to the `micGain` preference.
 * The result is a MediaStreamTrack that LiveKit publishes in place
 * of the raw mic capture.
 *
 * Why this exists separately. LiveKit's `setMicrophoneEnabled(true)`
 * does its own getUserMedia + publish in one shot. We don't want to
 * replace the entire mic-enable path — it handles the muted-on-PTT
 * case, the device-id pinning, the publish-after-connect ordering.
 * Instead this module runs AFTER the LiveKit track is up, gets a
 * second raw mic stream, processes it through a GainNode, and
 * swaps the underlying MediaStreamTrack on the published
 * LocalAudioTrack via `replaceTrack`. The result is one publish
 * event from the listener's perspective with no audible gap.
 *
 * What happens with the LiveKit-created track. After replaceTrack,
 * the original mic stream from LiveKit's getUserMedia is no longer
 * connected to the sender. We stop it explicitly to release the OS
 * mic resource — without that, the OS shows two recording
 * indicators (one for LiveKit's capture, one for ours) which is
 * confusing and on macOS triggers a privacy-indicator UI bug
 * (orange dot stays on after disconnect).
 *
 * Cleanup. On voice disconnect we close the AudioContext and stop
 * our raw stream's tracks. Calling apply twice without disconnect
 * is idempotent — the old chain is torn down first.
 */

import { getVoicePrefs, subscribeVoicePrefs } from './voicePrefs';
import { isMediaCaptureAvailable, mediaUnavailableMessage } from './mediaSupport';

interface ManualGainState {
  audioContext: AudioContext;
  gainNode: GainNode;
  rawStream: MediaStream;
  /** The LiveKit local-audio track whose underlying MediaStreamTrack
      we replaced. Kept so we can restore on cleanup if needed. */
  liveKitTrack: LocalAudioTrackLike;
  /** Subscription to voicePrefs changes — bumps gainNode.gain.value
      whenever micGain changes via the settings slider. */
  prefsUnsub: () => void;
}

/** Minimal duck-type of LiveKit's LocalAudioTrack — we only use the
    methods we call here, so we avoid importing the heavy SDK type. */
interface LocalAudioTrackLike {
  mediaStreamTrack: MediaStreamTrack;
  replaceTrack(track: MediaStreamTrack): Promise<unknown>;
}

let active: ManualGainState | null = null;

/**
 * Activate manual gain processing for the given LiveKit local audio
 * track. Idempotent — calling again tears down the previous chain
 * first so a settings change while in a call doesn't accumulate
 * AudioContexts.
 *
 * The track parameter is the LiveKit LocalAudioTrack that's already
 * been published (via setMicrophoneEnabled(true)). After this returns
 * successfully, its underlying MediaStreamTrack will be the gained
 * destination of our Web Audio chain, not the raw mic.
 *
 * Errors propagate — callers should treat a failure as "manual gain
 * not active, falling back to whatever LiveKit captured." The voice
 * setup code logs but doesn't fatal-error since the user's voice
 * still works without the gain processing; they just don't get the
 * gain adjustment.
 */
export async function activateManualGain(args: {
  liveKitTrack: LocalAudioTrackLike;
  inputDeviceId: string | undefined;
}): Promise<void> {
  await deactivateManualGain();

  const prefs = getVoicePrefs();

  // Get a fresh raw mic stream with AGC explicitly OFF (since we're
  // applying gain manually, AGC would fight us). Echo cancellation
  // and noise suppression still respect the user's settings — those
  // are independent of gain control.
  if (!isMediaCaptureAvailable()) {
    throw new Error(mediaUnavailableMessage());
  }
  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: args.inputDeviceId ? { exact: args.inputDeviceId } : undefined,
      echoCancellation: prefs.echoCancellation,
      noiseSuppression: prefs.noiseSuppression,
      autoGainControl: false,
    },
  });

  // Build the Web Audio chain: source → gain → destination. The
  // destination is the track LiveKit's sender will see.
  const audioContext = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(rawStream);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = prefs.micGain;
  const destination = audioContext.createMediaStreamDestination();
  source.connect(gainNode).connect(destination);

  const processedTrack = destination.stream.getAudioTracks()[0];
  if (!processedTrack) {
    // Shouldn't happen — MediaStreamDestination always yields a track —
    // but be defensive so a hypothetical future browser quirk doesn't
    // leave the chain in a half-built state.
    rawStream.getTracks().forEach((t) => t.stop());
    void audioContext.close();
    throw new Error('manual gain: AudioContext yielded no destination track');
  }

  // Stop the OLD MediaStreamTrack (the one LiveKit captured at
  // setMicrophoneEnabled time) so the OS releases that mic handle.
  // Without this the OS shows two recording indicators and on macOS
  // the menubar privacy indicator stays orange after disconnect.
  const previousMediaTrack = args.liveKitTrack.mediaStreamTrack;

  // Swap the underlying MediaStreamTrack on the published
  // LocalAudioTrack. LiveKit's sender renegotiates internally; from
  // the listener's perspective this is a seamless track replacement
  // with no audible interruption.
  await args.liveKitTrack.replaceTrack(processedTrack);

  // Stop the previous track AFTER replace — stopping before would
  // create a tiny gap of silence on the listener's side.
  previousMediaTrack.stop();

  // Subscribe to pref changes so the user dragging the slider in
  // settings updates the gain in real time. We use the smoothed
  // setter `setValueAtTime` rather than direct assignment to avoid
  // zipper noise on rapid slider drags — 20ms ramp is short enough
  // to feel instant but long enough that the AudioParam doesn't
  // step-discontinuity-pop.
  const prefsUnsub = subscribeVoicePrefs(() => {
    if (!active) return;
    const next = getVoicePrefs().micGain;
    const t = audioContext.currentTime;
    active.gainNode.gain.cancelScheduledValues(t);
    active.gainNode.gain.linearRampToValueAtTime(next, t + 0.02);
  });

  active = {
    audioContext,
    gainNode,
    rawStream,
    liveKitTrack: args.liveKitTrack,
    prefsUnsub,
  };
}

/**
 * Tear down the manual-gain chain. Stops the raw mic stream tracks
 * and closes the AudioContext. Idempotent.
 *
 * This does NOT restore the previously-captured LiveKit track —
 * by this point voice is being disconnected anyway, and the
 * publication will tear down via LiveKit's normal flow. If we
 * needed to drop manual gain mid-call without disconnecting, the
 * caller would re-call setMicrophoneEnabled(false) then (true)
 * after this, which gets back to LiveKit's default capture.
 */
export async function deactivateManualGain(): Promise<void> {
  if (!active) return;
  const { audioContext, rawStream, prefsUnsub } = active;
  active = null;
  try {
    prefsUnsub();
  } catch {
    // ignore
  }
  rawStream.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {
      // ignore
    }
  });
  try {
    await audioContext.close();
  } catch {
    // already closed, race during teardown — non-fatal
  }
}
