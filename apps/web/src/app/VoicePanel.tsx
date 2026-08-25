/**
 * VoicePanel
 * ----------
 * Pinned bottom strip of the channel-list column, visible only when the
 * user is currently connected to a voice channel. Surfaces:
 *   - Which channel they're in
 *   - Mute toggle (round 1: presence-only — sends the flag to the server
 *     so other clients see the mute icon, but no audio is actually muted
 *     because there's no audio yet)
 *   - Disconnect button
 *
 * Round 2 will mount a LiveKit Room here and add real audio device
 * controls. The shape of this component is the right surface for that —
 * the mute toggle currently calls `updateVoiceState`; round 2 will
 * additionally toggle the local audio track. The leave button calls the
 * REST endpoint AND will also disconnect the LiveKit Room.
 */
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector, selfVoiceState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Volume2, Mic, MicOff, PhoneOff, Headphones, HeadphonesOff } from '../lib/icons';
import { disconnectVoice, setMicMuted, setDeafened, isDeafened } from '../lib/voice';

export function VoicePanel({ activeChannelId }: { activeChannelId?: string | null }) {
  // Mounted in the Shell rail — subscribe to the narrow slices this panel
  // reads instead of the whole state (a full useAppState() re-rendered it
  // on every reducer dispatch).
  const voiceStatesByUser = useAppStateSelector((v) => v.state.voiceStatesByUser);
  const channelsByGuild = useAppStateSelector((v) => v.state.channelsByGuild);
  const restForChannel = useAppStateSelector((v) => v.restForChannel);
  const { user } = useAuth();
  const toasts = useToasts();
  const my = selfVoiceState(voiceStatesByUser, user?.id);
  // Local-deafen mirror so toggling re-renders this component.
  const [deafened, setDeafenedState] = useState(isDeafened());

  useEffect(() => {
    return () => {
      void disconnectVoice();
    };
  }, []);

  // Memoized channel lookup. Without memo, this walked every guild's
  // channel list on every render (O(guilds × channels)) just to map a
  // channelId → channel; with memo, it only re-walks when the channel
  // dict changes or the user moves to a different voice channel.
  // Calling useMemo unconditionally (before any early return) keeps
  // hook order stable.
  const channel = useMemo(() => {
    if (!my?.channelId) return null;
    for (const list of Object.values(channelsByGuild)) {
      const found = list.find((c) => c.id === my.channelId);
      if (found) return found;
    }
    return null;
  }, [channelsByGuild, my?.channelId]);

  if (!my || !my.channelId) return null;
  // Hide when the main view is already rendering the voice arena for
  // this channel — VoiceView's own controls bar is the canonical
  // surface in that case, and a copy of mute/deafen/leave in the rail
  // is just visual noise. Reappears the moment the user navigates to
  // a different channel, so they can still leave or mute without
  // returning.
  if (activeChannelId && my.channelId === activeChannelId) return null;

  const channelLabel = channel?.name ?? 'Voice channel';

  async function toggleMute() {
    if (!my?.channelId) return;
    const nextMuted = !my.selfMute;
    // Unmuting while deafened also drops deafen (can't be audible while
    // deafened — matches Discord).
    const dropDeafen = !nextMuted && (deafened || my.selfDeaf);
    try {
      await setMicMuted(nextMuted);
      if (dropDeafen) await setDeafened(false);
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Failed to toggle mic', 'error');
      return;
    }
    if (dropDeafen) setDeafenedState(false);
    try {
      await (await restForChannel(my.channelId)).updateVoiceState(
        my.channelId,
        dropDeafen
          ? { selfMute: nextMuted, selfDeaf: false }
          : { selfMute: nextMuted },
      );
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Server mute sync failed', 'error');
    }
  }

  async function toggleDeafen() {
    if (!my?.channelId) return;
    const next = !deafened;
    try {
      await setDeafened(next);
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Failed to deafen', 'error');
      return;
    }
    setDeafenedState(next);
    // Server-side: deafen and mute are coupled in both directions —
    // deafen → also muted (you can't broadcast while not listening);
    // undeafen → also unmuted (the user clicked the symmetric action
    // and expects to be fully back in the conversation). Previously
    // this only set selfMute=true on deafen and left it at whatever
    // the prior state was on undeafen, so users undeafening saw
    // their mute indicator persist until they clicked unmute too.
    try {
      await (await restForChannel(my.channelId)).updateVoiceState(my.channelId, {
        selfDeaf: next,
        selfMute: next,
      });
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Server deafen sync failed', 'error');
    }
  }

  async function leave() {
    if (!my?.channelId) return;
    await disconnectVoice();
    try {
      await (await restForChannel(my.channelId)).leaveVoice(my.channelId);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to leave', 'error');
    }
  }

  return (
    <div className="border-t border-line bg-bg-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <Volume2 size={14} className="text-emerald-500 shrink-0" />
        {/* iOS parity (Voice.swift VoicePanel): a green "Voice Connected"
            label over the channel title. The guild name is deliberately
            not shown here — iOS only carries the two lines. */}
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold text-emerald-500 truncate">
            Voice Connected
          </div>
          <div className="text-xs text-ink-2 truncate">{channelLabel}</div>
        </div>
        <button
          onClick={() => void toggleMute()}
          className={`w-8 h-8 flex items-center justify-center rounded-full bg-bg-3 transition-colors ${
            my.selfMute ? 'text-red-400 hover:brightness-110' : 'text-ink-1 hover:brightness-110'
          }`}
          title={my.selfMute ? 'Unmute' : 'Mute'}
          aria-label={my.selfMute ? 'Unmute microphone' : 'Mute microphone'}
        >
          {my.selfMute ? <MicOff size={14} /> : <Mic size={14} />}
        </button>
        <button
          onClick={() => void toggleDeafen()}
          className={`w-8 h-8 flex items-center justify-center rounded-full bg-bg-3 transition-colors ${
            deafened ? 'text-red-400 hover:brightness-110' : 'text-ink-1 hover:brightness-110'
          }`}
          title={deafened ? 'Undeafen' : 'Deafen'}
          aria-label={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? <HeadphonesOff size={14} /> : <Headphones size={14} />}
        </button>
        <button
          onClick={() => void leave()}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-red-500 text-white hover:brightness-110 transition-colors"
          title="Leave call"
          aria-label="Leave call"
        >
          <PhoneOff size={14} />
        </button>
      </div>
    </div>
  );
}
