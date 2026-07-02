/**
 * OutgoingCallModal
 * -----------------
 * Centered ringing screen shown to the caller of a 1:1 DM. Replaces
 * the previous OutgoingCallStrip (a row above the composer) with a
 * full-screen popup that mirrors IncomingCallModal — caller and
 * callee both see a consistent prominent UI during the ring phase.
 *
 * UX:
 *   - Large callee avatar (96px) with alien-pulse ring.
 *   - "Calling…" subtitle with an animated dot pulse.
 *   - One large red Hangup button (no Accept — the caller initiated
 *     the call; the only positive action here is canceling it).
 *
 * The modal automatically goes away the moment the partner answers
 * (call becomes active, DmCallBar at the top takes over) or the
 * caller hangs up.
 *
 * Hangup: disconnectVoice + rest.leaveVoice + a "Call ended" toast.
 * The black-hole-swallow animation lives on the VoiceView side and
 * fires when the user hangs up an answered call; here the call is
 * still ringing, so we just exit cleanly.
 */

import { useState, useEffect } from 'react';
import { ApiError, type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState, voiceStatesForChannel, selfVoiceState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { disconnectVoice } from '../lib/voice';
import { startRingback, stopRingback } from '../lib/sounds';
import { PhoneOff } from '../lib/icons';
import { AvatarImage } from '../lib/AvatarImage';
import { avatarColor } from '../lib/avatar';
import { Portal } from '../lib/Portal';

export function OutgoingCallModal({ channel }: { channel: Channel }) {
  const { state } = useAppState();
  const { rest, user } = useAuth();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);

  const selfId = user?.id;
  const myVoice = selfVoiceState(state.voiceStatesByUser, selfId);
  const myInThis = myVoice?.channelId === channel.id;
  const callStates = voiceStatesForChannel(state.voiceStatesByUser, channel.id);
  const otherInThis = callStates.some((v) => v.userId !== selfId);

  // Gates: 1:1 DM only, we're in voice in THIS channel, and the
  // other party isn't in voice yet. The moment they answer, the
  // call becomes active and DmCallBar (in the chrome area) takes
  // over — this modal naturally disappears.
  const ringing =
    channel.type === 'dm' && myInThis && !otherInThis;

  // Outgoing ringback — the tone the caller hears while waiting for an
  // answer. Plays while ringing; stops on connect or hang-up. Hook runs
  // unconditionally (Rules of Hooks); the body no-ops when not ringing.
  // Suppressed on native, where the OS provides call audio.
  useEffect(() => {
    if (!ringing) return;
    let cancelled = false;
    void (async () => {
      try {
        const { isNative } = await import('../lib/native');
        if (isNative() || cancelled) return;
      } catch {
        // not native — proceed
      }
      if (!cancelled) startRingback();
    })();
    return () => {
      cancelled = true;
      stopRingback();
    };
  }, [ringing]);

  if (!ringing) return null;

  const recipient = channel.recipients?.find((r) => r.id !== selfId);
  const calleeName = recipient?.displayName ?? recipient?.username ?? 'Direct call';
  const initials = calleeName.slice(0, 1).toUpperCase();
  const tone = recipient ? avatarColor(recipient.id) : 'bg-bg-3';

  async function hangup() {
    if (busy) return;
    setBusy(true);
    try {
      await disconnectVoice();
      let endedOk = true;
      try {
        await rest.leaveVoice(channel.id);
      } catch (e) {
        // 404 = row already gone server-side; treat as success.
        if (e instanceof ApiError && e.status === 404) {
          // suppress; ended
        } else {
          endedOk = false;
          toasts.push(e instanceof ApiError ? e.message : 'Failed to hang up', 'error');
        }
      }
      if (endedOk) toasts.push('Call ended', 'info');
    } finally {
      // Stop the ringback audio defensively: if leaveVoice() failed, the server
      // row persists → `ringing` stays true → the effect's cleanup never fires,
      // so the ring would play indefinitely. stopRingback() is idempotent.
      stopRingback();
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-bg-1/70 backdrop-blur-sm"
        aria-modal="true"
        role="dialog"
        aria-label={`Calling ${calleeName}`}
      >
        <div className="w-full max-w-sm bg-bg-2 border border-line zk-modal shadow-xl px-6 py-8 flex flex-col items-center gap-5">
          {/* Callee avatar */}
          <div
            className={`relative w-24 h-24 rounded-full flex items-center justify-center text-3xl font-semibold overflow-hidden zk-alien-pulse ${tone}`}
            aria-hidden="true"
          >
            <span className="zk-avatar-initials">{initials}</span>
            <AvatarImage src={recipient?.avatarUrl ?? null} alt="" />
          </div>

          <div className="text-center">
            <div className="text-lg font-semibold text-ink-1 max-w-full break-words">
              {calleeName}
            </div>
            <div className="text-sm text-amber-300/90 flex items-center justify-center gap-1.5 mt-1">
              {/* Two-stage ping dot: outer fades, inner stays. Same
                  visual idiom as the old strip. */}
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
              </span>
              <span>Calling…</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void hangup()}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-full bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-red-300 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-wait"
            aria-label="Hang up"
          >
            <PhoneOff size={16} />
            <span>{busy ? 'Hanging up…' : 'Hang up'}</span>
          </button>
        </div>
      </div>
    </Portal>
  );
}
