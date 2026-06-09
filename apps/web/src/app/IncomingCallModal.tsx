/**
 * IncomingCallModal
 * -----------------
 * Centered, portal-mounted ringing screen for 1:1 DM calls. Replaces
 * the previous IncomingCallStrip (a compact row above the composer)
 * with a prominent full-screen popup that draws the user's attention
 * the way a phone's "incoming call" screen does.
 *
 * UX:
 *   - Large caller avatar (96px) center-stage with the alien-pulse
 *     ring — the same visual cue used elsewhere for "active voice
 *     transmission."
 *   - Display name + "Incoming call…" subtitle.
 *   - Two large buttons: green Answer (Phone) and red Decline (X).
 *   - Backdrop click is NOT a dismiss — accidental backdrop taps
 *     shouldn't drop a call. Use Decline explicitly.
 *   - Esc-to-decline IS supported as a keyboard escape hatch.
 *
 * Logic mirrors the old strip:
 *   - declinedRef holds session-scoped decline state; resets when
 *     the underlying call ends (other party goes away).
 *   - accept() → rest.joinVoice → connectToVoice.
 *   - decline() → rest.declineCall, falling back to local declinedRef
 *     if the server is unreachable.
 *   - clearCallNotification on accept/decline so OS push notif goes away.
 *
 * Mounting: same place as the old strip — MessageView, inside the 1:1
 * DM branch. Only renders when an incoming call is actually pending.
 */

import { useRef, useState, useEffect } from 'react';
import { ApiError, type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState, voiceStatesForChannel, selfVoiceState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { connectToVoice, VoiceError, prepareVoiceAudio } from '../lib/voice';
import { clearCallNotification } from '../lib/clearCallNotification';
import { startRingtone, stopRingtone } from '../lib/sounds';
import { showDesktopNotification } from '../lib/desktopNotify';
import { getNotifyPrefs } from '../lib/notifyPrefs';
import { Phone, X } from '../lib/icons';
import { AvatarImage } from '../lib/AvatarImage';
import { avatarColor } from '../lib/avatar';
import { Portal } from '../lib/Portal';

export function IncomingCallModal({ channel }: { channel: Channel }) {
  const { state, mergeChannelVoiceStates } = useAppState();
  const { rest, user } = useAuth();
  const toasts = useToasts();

  // Session-scoped decline; same pattern as the old strip.
  const declinedRef = useRef(false);
  // Holds the latest accept() so the native CallKit "answered" listener
  // (registered in an effect, before accept is defined) can invoke it.
  const acceptRef = useRef<() => void>(() => {});
  const [, forceRender] = useState(0);
  const [busy, setBusy] = useState(false);

  const selfId = user?.id;
  const callStates = voiceStatesForChannel(state.voiceStatesByUser, channel.id);
  const myVoice = selfVoiceState(state.voiceStatesByUser, selfId);
  const myInThis = myVoice?.channelId === channel.id;
  const other = callStates.find((v) => v.userId !== selfId);

  // Reset decline + dismiss OS push when the call goes away.
  useEffect(() => {
    if (!other) {
      if (declinedRef.current) declinedRef.current = false;
      clearCallNotification(channel.id);
    }
  }, [other, channel.id]);

  // Ringtone. Play the looping ring while the call is pending — i.e.
  // someone is calling (other present), we haven't joined (myInThis
  // false), and we haven't declined. Stop the instant any of those
  // flip, and always stop on unmount. On native (Capacitor/CallKit)
  // the system provides the ringer, so we skip the web ringtone there
  // to avoid double-ringing.
  // Device-local "Incoming calls" toggle (Settings) gates the audible ring
  // and the call notification, mirroring the native app's notifyCalls switch.
  // Read at render: the decision is made when a call arrives (the normal
  // case); the modal still renders so an attentive user can answer.
  const ringing =
    getNotifyPrefs().notifyCalls && !!other && !myInThis && !declinedRef.current;
  useEffect(() => {
    if (!ringing) return;
    let cancelled = false;
    let callNotification: Notification | null = null;
    void (async () => {
      try {
        const { isNative } = await import('../lib/native');
        if (isNative() || cancelled) return;
      } catch {
        // not native — proceed with the web ringtone
      }
      if (!cancelled) startRingtone();
      // Native desktop pop-up for the incoming call (Electron only).
      if (!cancelled) {
        const callerName =
          (other && state.usersById[other.userId]?.displayName) ||
          (other && state.usersById[other.userId]?.username) ||
          'Someone';
        callNotification = showDesktopNotification({
          title: 'Incoming call',
          body: `${callerName} is calling…`,
          tag: `call:${channel.id}`,
          requireInteraction: true,
        });
      }
    })();
    return () => {
      cancelled = true;
      stopRingtone();
      if (callNotification) {
        try {
          callNotification.close();
        } catch {
          // ignore
        }
      }
    };
  }, [ringing]);

  // Native iOS CallKit presentation. When running inside the
  // Capacitor shell, fire the system incoming-call UI so the
  // phone rings + the locked-screen answer screen appears. The
  // web modal below still renders as the in-app fallback for
  // unlocked/foreground state and for browser users. End the
  // CallKit session when the modal unmounts (call cleared).
  useEffect(() => {
    if (!other) return;
    let cancelled = false;
    void (async () => {
      try {
        const { presentIncomingCall, isNative } = await import(
          '../lib/native'
        );
        if (!isNative() || cancelled) return;
        const callerName =
          state.usersById[other.userId]?.displayName ??
          state.usersById[other.userId]?.username ??
          'Incoming call';
        await presentIncomingCall({
          callId: channel.id,
          callerName,
          // 1:1 DM calls are voice-only; the receiver upgrades to
          // video after answering. CallKit's hasVideo flag controls
          // whether the answer UI shows a video preview slot.
          hasVideo: false,
        });
      } catch {
        // ignore — fall back to in-app modal
      }
    })();
    return () => {
      cancelled = true;
      void (async () => {
        try {
          const { endNativeCall, isNative } = await import('../lib/native');
          if (!isNative()) return;
          await endNativeCall(channel.id);
        } catch {
          // ignore
        }
      })();
    };
    // Re-run if the call participant changes (e.g. someone else joins
    // a group), so the displayed caller name stays accurate.
  }, [other, channel.id, state.usersById]);

  // When the user answers from the native (CallKit) lock-screen UI, the
  // ZekktrisCalls plugin fires `callAnswered`. Join the LiveKit room via the
  // same path the in-app Answer button uses, so answering from the locked
  // phone actually connects the call. No-op on web / without the plugin. The
  // modal is already scoped to this DM channel, so the event's callId is
  // ignored (it's a padded-UUID form of the channel id anyway).
  useEffect(() => {
    if (!other) return;
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        const { onCallAnswered, isNative } = await import('../lib/native');
        if (!isNative() || cancelled) return;
        unsub = await onCallAnswered(() => {
          acceptRef.current();
        });
        if (cancelled) unsub();
      } catch {
        // ignore — the in-app Answer button still works
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [other, channel.id]);

  // Esc-to-decline. Bound at the document level (rather than the
  // modal element) because the modal mounts via Portal and focus may
  // not be on the modal when an Esc arrives.
  useEffect(() => {
    if (channel.type !== 'dm') return;
    if (myInThis || myVoice) return;
    if (!other || declinedRef.current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        void decline();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // The decline closure captures the current channel id which is
    // stable across this effect's lifetime; intentionally minimal deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, channel.type, myInThis, myVoice, other]);

  // Visibility gates. Same conditions as the strip.
  if (channel.type !== 'dm') return null;
  if (myInThis) return null;
  if (myVoice) return null;
  if (!other) return null;
  if (declinedRef.current) return null;

  const caller = state.usersById[other.userId];
  const callerName = caller?.displayName || caller?.username || 'Someone';
  const initials = callerName.slice(0, 1).toUpperCase();
  const tone = avatarColor(other.userId);

  async function accept() {
    if (busy) return;
    setBusy(true);
    // Stop the ringtone the instant the user answers (the `ringing`
    // flag only flips once the voice state round-trips, which has a
    // perceptible lag).
    stopRingtone();
    // Prime the shared AudioContext now, while we're still inside
    // the click event's synchronous call stack. The async path below
    // (rest.joinVoice → connectToVoice → setMicrophoneEnabled) consumes
    // the user gesture; if we let it run first, the context would be
    // created post-gesture and stay suspended on Safari + strict-
    // autoplay Chrome, breaking remote speaker detection.
    prepareVoiceAudio();
    clearCallNotification(channel.id);
    try {
      const r = await rest.joinVoice(channel.id);
      mergeChannelVoiceStates(channel.id, r.channelVoiceStates);
      if (r.token && r.wsUrl) {
        try {
          await connectToVoice({
            token: r.token,
            wsUrl: r.wsUrl,
            sessionId: r.voiceState.sessionId,
            backgroundTitle: `Call with ${callerName}`,
            // This modal only renders for 1:1 DMs (guarded above). If the
            // DM is encrypted, key the call media with the same shared
            // key — answering a call you can't decrypt is pointless, so a
            // locked key is surfaced as an error here.
            ...(channel.e2eeEnabled
              ? { e2ee: { channelId: channel.id, verifier: channel.e2eeVerifier } }
              : {}),
          });
        } catch (e) {
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
        toasts.push('Joined (presence-only — voice not configured)', 'info');
      }
    } catch (e) {
      // A 404 here usually means the call already ended on the server
      // (caller hung up, ring timed out, or the channel was reaped)
      // between the ring arriving and the user tapping Answer. The raw
      // "Voice channel not found" message is confusing in that situation;
      // surface a friendlier line and proactively clear the stale voice
      // state for this channel so the now-dead modal goes away.
      if (e instanceof ApiError && e.status === 404) {
        mergeChannelVoiceStates(channel.id, []);
        toasts.push('The call ended before you could answer', 'info');
      } else {
        toasts.push(e instanceof ApiError ? e.message : 'Failed to accept call', 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    clearCallNotification(channel.id);
    stopRingtone();
    try {
      // Server-side decline ends the call by removing the caller
      // from voice. Both clients see the voice-state update over the
      // gateway, which causes this modal to disappear automatically.
      await rest.declineCall(channel.id);
    } catch {
      // Server unreachable — fall back to local-only suppression.
      declinedRef.current = true;
      forceRender((n) => n + 1);
    }
  }

  // Keep the native CallKit "answered" listener pointed at the current
  // accept() closure (runs each render the modal is visible).
  acceptRef.current = () => {
    void accept();
  };

  return (
    <Portal>
      {/* Backdrop. fixed inset-0, low-opacity scrim. Deliberately not
          a button — accidental backdrop taps shouldn't drop a call. */}
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-bg-1/70 backdrop-blur-sm"
        aria-modal="true"
        role="dialog"
        aria-label={`Incoming call from ${callerName}`}
      >
        <div className="w-full max-w-sm bg-bg-2 border border-line zk-modal shadow-xl px-6 py-8 flex flex-col items-center gap-5">
          {/* Caller avatar */}
          <div
            className={`relative w-24 h-24 rounded-full flex items-center justify-center text-3xl font-semibold overflow-hidden zk-alien-pulse ${tone}`}
            aria-hidden="true"
          >
            <span>{initials}</span>
            <AvatarImage src={caller?.avatarUrl ?? null} alt="" />
          </div>

          {/* Name + subtitle */}
          <div className="text-center">
            <div className="text-lg font-semibold text-ink-1 max-w-full break-words">
              {callerName}
            </div>
            <div className="text-sm text-ink-3 flex items-center justify-center gap-1.5 mt-1">
              <Phone size={12} className="shrink-0" />
              <span>Incoming call…</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3 w-full pt-2">
            <button
              type="button"
              onClick={() => void decline()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-full bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-red-300 text-sm font-medium transition-colors"
              aria-label="Decline call"
            >
              <X size={16} />
              <span>Decline</span>
            </button>
            <button
              type="button"
              onClick={() => void accept()}
              disabled={busy}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-full bg-green-500/15 hover:bg-green-500/25 border border-green-500/40 text-green-300 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-wait"
              aria-label="Answer call"
            >
              <Phone size={16} />
              <span>{busy ? 'Connecting…' : 'Answer'}</span>
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
