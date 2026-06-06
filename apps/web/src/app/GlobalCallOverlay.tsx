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

import { useMemo } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useAppState, voiceStatesForChannel, selfVoiceState } from '../state/AppState';
import { IncomingCallModal } from './IncomingCallModal';
import { OutgoingCallModal } from './OutgoingCallModal';

export function GlobalCallOverlay() {
  const { state } = useAppState();
  const { user } = useAuth();
  const selfId = user?.id;
  const myVoice = selfVoiceState(state, selfId);

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
      const ch = state.dmChannels.find(
        (c) => c.id === myVoice.channelId && c.type === 'dm',
      );
      if (ch) {
        const inThis = voiceStatesForChannel(state, ch.id);
        const otherInThis = inThis.some((v) => v.userId !== selfId);
        if (!otherInThis) {
          // Ring-out state. No incoming can fire simultaneously
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
    for (const c of state.dmChannels) {
      if (c.type !== 'dm') continue;
      const inThis = voiceStatesForChannel(state, c.id);
      // We know !myVoice here, so no voice state in this channel can
      // be ours. Any presence at all = someone else ringing us.
      if (inThis.length > 0) {
        return { incomingChannel: c, outgoingChannel: null };
      }
    }
    return { incomingChannel: null, outgoingChannel: null };
  }, [selfId, myVoice, state]);

  return (
    <>
      {incomingChannel && <IncomingCallModal channel={incomingChannel} />}
      {outgoingChannel && <OutgoingCallModal channel={outgoingChannel} />}
    </>
  );
}
