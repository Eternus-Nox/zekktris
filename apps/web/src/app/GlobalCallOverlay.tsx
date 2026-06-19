/**
 * GlobalCallOverlay
 * -----------------
 * Mounts the IncomingCallModal / OutgoingCallModal at the application
 * root so call popups appear no matter which view the user is on.
 *
 * The per-channel modals (IncomingCallModal, OutgoingCallModal) gate
 * their own visibility on the specific channel they're passed. This
 * wrapper scans ALL DM channels to find the one (if any) currently
 * in a calling state, then forwards that channel to the appropriate
 * modal.
 *
 * Detection rules — these mirror the gates inside each modal, lifted
 * to a global scope:
 *
 *   Incoming: there exists a 1:1 DM channel where another user is in
 *     voice AND the current user is not in voice anywhere. The user
 *     is being rung; surface the modal so they can answer or decline.
 *
 *   Outgoing: the current user is in voice inside a 1:1 DM channel
 *     AND no other recipient is in voice in that same channel. The
 *     user is ringing out; surface the hangup modal.
 *
 * Incoming and outgoing are mutually exclusive — incoming requires
 * the user NOT to be in voice, outgoing requires them TO be in voice.
 *
 * Multi-call edge case: if two different DMs are ringing the user
 * simultaneously, we pick the first one we find. After the user
 * accepts or declines, the scan re-evaluates and surfaces the next
 * one automatically.
 */

import { useMemo, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector, voiceStatesForChannel, selfVoiceState } from '../state/AppState';
import { IncomingCallModal } from './IncomingCallModal';
import { OutgoingCallModal } from './OutgoingCallModal';

export function GlobalCallOverlay() {
  // Mounted unconditionally in the Shell — subscribe only to the two
  // slices the call scan reads (voice states + DM list) instead of the
  // whole state, so unrelated dispatches don't re-render it.
  const voiceStatesByUser = useAppStateSelector((v) => v.state.voiceStatesByUser);
  const dmChannels = useAppStateSelector((v) => v.state.dmChannels);
  const { user } = useAuth();
  const selfId = user?.id;
  const myVoice = selfVoiceState(voiceStatesByUser, selfId);

  // ── Teardown-flash guard ──────────────────────────────────────────────
  //
  // A ring-out is "I'm in voice and the partner has never picked up yet."
  // But `myVoice && !otherInThis` is ALSO transiently true while a call is
  // ENDING: when either side hangs up, the partner's voice state clears
  // (via the gateway) a beat before our own does, so for the ~1s teardown
  // window we look exactly like a fresh ring-out. Without a guard, a normal
  // hang-up briefly re-shows the "Calling…" modal (with ringback) before
  // our own state clears — reads as "it called them again for a second then
  // ended."
  //
  // So we remember whether the partner was EVER present during THIS call.
  // Once they have been, `!otherInThis` means "call ending", not "ringing
  // out", and we suppress the outgoing modal. Derived purely from the
  // current voice snapshot and updated idempotently during render (a ref,
  // not state — it must not trigger a re-render). Mirrors the Shell DM-call
  // auto-end's partnerWasHereRef.
  const partnerSeenRef = useRef<{ channelId: string; seen: boolean } | null>(null);
  const myVoiceChannelId = myVoice?.channelId ?? null;
  if (!myVoiceChannelId || !selfId) {
    // Not in voice → reset so the next call starts with a clean flag.
    partnerSeenRef.current = null;
  } else {
    if (partnerSeenRef.current?.channelId !== myVoiceChannelId) {
      partnerSeenRef.current = { channelId: myVoiceChannelId, seen: false };
    }
    const otherHere = voiceStatesForChannel(voiceStatesByUser, myVoiceChannelId).some(
      (v) => v.userId !== selfId,
    );
    if (otherHere) partnerSeenRef.current.seen = true;
  }
  const partnerEverSeen = partnerSeenRef.current?.seen ?? false;

  // Resolve incoming and outgoing channels in one pass. useMemo
  // gates the work on the inputs the scan actually reads — voice
  // states, dm channel list, the user's own voice state. Without
  // memoization this would recompute on every render of any state
  // change (typing indicators, message arrivals, etc.) which is
  // wasteful for a function that's just looking up call state.
  const { incomingChannel, outgoingChannel } = useMemo(() => {
    if (!selfId) return { incomingChannel: null, outgoingChannel: null };

    // Outgoing path: if the user is in voice in a 1:1 DM and no one
    // else is there yet, that's a ring-out. Resolve the channel
    // from the dmChannels list (filtering to type='dm' to skip
    // group DMs — outgoing modal logic only handles 1:1).
    if (myVoice) {
      const ch = dmChannels.find(
        (c) => c.id === myVoice.channelId && c.type === 'dm',
      );
      if (ch) {
        const inThis = voiceStatesForChannel(voiceStatesByUser, ch.id);
        const otherInThis = inThis.some((v) => v.userId !== selfId);
        if (!otherInThis) {
          // `myVoice && !otherInThis` is a ring-out ONLY if the partner
          // has never been here. If they HAD been, this is the call
          // tearing down (partner left, our own state not cleared yet) —
          // showing "Calling…" then would flash a phantom outgoing call
          // for the teardown window. Suppress it; the Shell auto-end takes
          // over and shows "Call ended".
          if (partnerEverSeen) {
            return { incomingChannel: null, outgoingChannel: null };
          }
          // Genuine ring-out. No incoming can fire simultaneously
          // because incoming requires !myVoice.
          return { incomingChannel: null, outgoingChannel: ch };
        }
      }
      // User is in voice in something OTHER than a 1:1 DM, or the
      // partner has answered (call is active — modals are off,
      // DmCallBar in MessageView handles the active state). Either
      // way: no overlay needed.
      return { incomingChannel: null, outgoingChannel: null };
    }

    // Incoming path: user is NOT in voice anywhere; find a 1:1 DM
    // where someone else is. First match wins.
    for (const c of dmChannels) {
      if (c.type !== 'dm') continue;
      const inThis = voiceStatesForChannel(voiceStatesByUser, c.id);
      // We know !myVoice here, so no voice state in this channel can
      // be ours. Any presence at all = someone else ringing us.
      if (inThis.length > 0) {
        return { incomingChannel: c, outgoingChannel: null };
      }
    }
    return { incomingChannel: null, outgoingChannel: null };
  }, [selfId, myVoice, dmChannels, voiceStatesByUser, partnerEverSeen]);

  return (
    <>
      {incomingChannel && <IncomingCallModal channel={incomingChannel} />}
      {outgoingChannel && <OutgoingCallModal channel={outgoingChannel} />}
    </>
  );
}
