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
 *   - Quiet grey "Calling…" subtitle (no pulsing dot — iOS parity).
 *   - One large red Cancel button (no Accept — the caller initiated
 *     the call; the only positive action here is canceling it).
 *
 * The modal automatically goes away the moment the partner answers
 * (call becomes active, DmCallBar at the top takes over) or the
 * caller hangs up.
 *
 * Hangup: AppState's hangUpCall (the modal goes at the click, the
 * teardown and the server leave run behind it) + a "Call ended" toast
 * once the server has us out.
 * The black-hole-swallow animation lives on the VoiceView side and
 * fires when the user hangs up an answered call; here the call is
 * still ringing, so we just exit cleanly.
 */

import { useState, useEffect } from 'react';
import { type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState, voiceStatesForChannel, selfVoiceState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { startRingback, stopRingback } from '../lib/sounds';
import { PhoneOff } from '../lib/icons';
import { AvatarImage } from '../lib/AvatarImage';
import { avatarColor } from '../lib/avatar';
import { Portal } from '../lib/Portal';

export function OutgoingCallModal({ channel }: { channel: Channel }) {
  const { state, hangUpCall } = useAppState();
  const { user } = useAuth();
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
    // The caller pressed Cancel: the ring stops now, not once the server
    // has agreed.
    stopRingback();
    try {
      // The modal goes at once (hangUpCall drops our row, which is what
      // `ringing` reads) while the teardown — cancelling a connect that is
      // still under way — and the server leave run behind it. A failed
      // leave is toasted there (a 404 counts as ended).
      const ended = await hangUpCall(channel.id);
      if (ended) toasts.push('Call ended', 'info');
    } finally {
      // Belt and braces: the optimistic leave unmounts this modal, whose
      // effect cleanup stops the ring too. (If the leave failed and the
      // server still has our ring-out, the modal comes back — and rings —
      // as a fresh instance, after this runs.) stopRingback() is idempotent.
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
            {/* Quiet grey "Calling…" with no pulsing dot — matches iOS
                (Voice.swift OutgoingCallView: 14pt Theme.ink3, no dot). */}
            <div className="text-sm text-ink-3 flex items-center justify-center gap-1.5 mt-1">
              <span>Calling…</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void hangup()}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-full bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-red-300 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-wait"
            aria-label="Cancel"
          >
            <PhoneOff size={16} />
            <span>{busy ? 'Cancelling…' : 'Cancel'}</span>
          </button>
        </div>
      </div>
    </Portal>
  );
}
