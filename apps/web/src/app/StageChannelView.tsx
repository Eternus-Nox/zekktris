/**
 * StageChannelView
 * ----------------
 * Renders in the main panel when the active channel is a stage channel
 * (channel.type === 'guild_stage'). Visually distinct from VoiceView:
 * a wide topic banner up top, a "Speakers" row of larger avatar tiles
 * in the middle, an "Audience" grid below it, and self-controls at the
 * bottom that swap between audience-mode (Raise hand / Leave) and
 * speaker-mode (Mic / Stop speaking / Leave).
 *
 * Mods see an extra "Raised hands" panel listing audience members who
 * have requested promotion, with a one-click promote button per row.
 *
 * LiveKit:
 *   - On join, the server returns a token gated on speaker status
 *     (publish=true for speakers, publish=false for audience).
 *   - When the user's own row flips between speaker and audience —
 *     i.e. a mod promoted or demoted them — we re-fetch a token
 *     (`rest.joinStage`) and reconnect LiveKit. This trades a brief
 *     ~500ms reconnect for not having to call LiveKit's
 *     update-participant API server-side. Acceptable for v1.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import {
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  Edit,
  Hand,
} from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { computeMemberGuildPerms, hasPermissionBit, memberIsAdmin } from '../lib/permissions';
import {
  connectToVoice,
  disconnectVoice,
  setMicMuted,
  VoiceError,
} from '../lib/voice';

const AUDIENCE_VISIBLE = 12; // before "+N more" overflow

export function StageChannelView({ channel }: { channel: Channel }) {
  // Narrow selectors — a stage view stays mounted for the whole session, and
  // a whole-state useAppState() re-rendered it on every reducer dispatch.
  const stageParticipantsByChannel = useAppStateSelector((v) => v.state.stageParticipantsByChannel);
  const guildsById = useAppStateSelector((v) => v.state.guildsById);
  const rolesByGuild = useAppStateSelector((v) => v.state.rolesByGuild);
  const membersByGuild = useAppStateSelector((v) => v.state.membersByGuild);
  const usersById = useAppStateSelector((v) => v.state.usersById);
  const { user, rest } = useAuth();
  const toasts = useToasts();
  const navigate = useNavigate();

  // Pull the current participant list from AppState; populated by the
  // initial REST fetch (below) and refreshed by every gateway
  // STAGE_PARTICIPANTS_UPDATE.
  const participants = stageParticipantsByChannel[channel.id] ?? [];
  const myParticipant = user
    ? participants.find((p) => p.userId === user.id) ?? null
    : null;
  const inStage = !!myParticipant;

  // Permission resolution for moderator UI. Members with
  // MANAGE_CHANNELS (bit 10) OR ADMINISTRATOR get the promote /
  // demote / topic-edit affordances. Server is the authoritative gate;
  // this client-side check just decides what UI to show.
  const isMod = (() => {
    if (!user || !channel.guildId) return false;
    const guild = guildsById[channel.guildId];
    if (!guild) return false;
    if (guild.ownerId === user.id) return true;
    const roles = rolesByGuild[channel.guildId] ?? [];
    const member = membersByGuild[channel.guildId]?.find((m) => m.user.id === user.id);
    const memberRoleIds = member?.roleIds ?? [];
    if (memberIsAdmin(roles, channel.guildId, memberRoleIds, false)) return true;
    const perms = computeMemberGuildPerms(roles, channel.guildId, memberRoleIds, false);
    return hasPermissionBit(perms, 10); // MANAGE_CHANNELS
  })();

  const speakers = participants.filter((p) => p.isSpeaker);
  const audience = participants.filter((p) => !p.isSpeaker);
  const raisedHands = audience.filter((p) => p.handRaised);

  // Track our own LiveKit mic-mute state. The voice manager keeps
  // authoritative state; we mirror in React for the toggle button.
  const [micMuted, setMicMutedLocal] = useState(false);
  // Re-render when the publish-permission flips: if our row goes
  // speaker→audience or vice-versa, the LiveKit session needs a new
  // token. The effect below handles that.
  const wasSpeakerRef = useRef<boolean | null>(null);

  // Bootstrap: fetch participants once on mount (gateway delivers
  // updates afterwards). Skipped if AppState already has the list.
  useEffect(() => {
    if (stageParticipantsByChannel[channel.id]) return;
    void rest
      .listStageParticipants(channel.id)
      .then(() => undefined) // dispatch happens via gateway; the REST hit primes the slice on the server side
      .catch(() => undefined);
    // We don't dispatch from here; the REST response shape returns the
    // list but our reducer expects gateway-shaped events. The next
    // STAGE_PARTICIPANTS_UPDATE will arrive within ~1 RTT of any
    // mutation. Acceptable v1 — a small fetch-and-discard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // Auto-reconnect when speaker status flips. This handles both
  // promotion (audience→speaker, need publish permission) and
  // demotion (speaker→audience, lose it).
  useEffect(() => {
    if (!myParticipant) {
      wasSpeakerRef.current = null;
      return;
    }
    const wasSpeaker = wasSpeakerRef.current;
    const isSpeaker = myParticipant.isSpeaker;
    if (wasSpeaker !== null && wasSpeaker !== isSpeaker) {
      // Status changed — re-join to get a fresh token.
      void (async () => {
        try {
          await disconnectVoice();
          const r = await rest.joinStage(channel.id);
          if (r.token && r.wsUrl) {
            await connectToVoice({
              token: r.token,
              wsUrl: r.wsUrl,
              channelId: channel.id,
              // Audience tokens are canPublish=false — publishing under
              // one throws a 403. Mirror the server-granted capability.
              publish: r.participant.isSpeaker,
            });
          }
          toasts.push(
            isSpeaker ? 'You can now speak' : 'You are now in the audience',
            'info',
          );
        } catch (e) {
          toasts.push(
            e instanceof Error ? e.message : 'Stage reconnect failed',
            'error',
          );
        }
      })();
    }
    wasSpeakerRef.current = isSpeaker;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myParticipant?.isSpeaker]);

  // ── Actions ────────────────────────────────────────────────────────────

  async function joinAsAudience() {
    try {
      const r = await rest.joinStage(channel.id);
      if (r.token && r.wsUrl) {
        try {
          await connectToVoice({
            token: r.token,
            wsUrl: r.wsUrl,
            channelId: channel.id,
            // Audience joins get a no-publish token — tell voice.ts to
            // skip the mic entirely (it'd 403 otherwise and leak the room).
            publish: r.participant.isSpeaker,
          });
        } catch (e) {
          toasts.push(
            e instanceof VoiceError ? e.message : 'Voice connect failed',
            'error',
          );
        }
      } else {
        toasts.push('Voice isn’t set up on this server yet — you’ve joined the channel, but no audio will connect. Ask the server admin to enable voice.', 'info');
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to join stage', 'error');
    }
  }

  async function leave() {
    await disconnectVoice();
    try {
      await rest.leaveStage(channel.id);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to leave stage', 'error');
    }
    if (channel.guildId) {
      navigate(`/channels/${channel.guildId}`);
    }
  }

  async function raiseHand() {
    try {
      await rest.raiseHand(channel.id);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to raise hand', 'error');
    }
  }

  async function lowerHand() {
    try {
      await rest.lowerHand(channel.id);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to lower hand', 'error');
    }
  }

  async function setSpeaker(targetUserId: string, isSpeaker: boolean) {
    try {
      await rest.setStageSpeaker(channel.id, targetUserId, isSpeaker);
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Failed to update speaker',
        'error',
      );
    }
  }

  function toggleMic() {
    const next = !micMuted;
    setMicMutedLocal(next);
    setMicMuted(next);
  }

  // ── Topic editor ──────────────────────────────────────────────────────

  const [topicEditing, setTopicEditing] = useState(false);
  const [topicDraft, setTopicDraft] = useState(channel.topic ?? '');
  useEffect(() => {
    setTopicDraft(channel.topic ?? '');
  }, [channel.topic]);
  async function saveTopic() {
    try {
      const trimmed = topicDraft.trim();
      await rest.setStageTopic(channel.id, trimmed.length === 0 ? null : trimmed);
      setTopicEditing(false);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to save topic', 'error');
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-1">
      {/* Header / topic banner. */}
      <header className="px-4 sm:px-6 py-3 sm:py-4 border-b border-line shrink-0 bg-bg-2 pl-14 xl:pl-6">
        <div className="flex items-center gap-2 mb-1 text-xs text-ink-3 uppercase tracking-wider">
          <Volume2 size={12} />
          <span>Stage</span>
        </div>
        <h1 className="text-lg font-semibold text-ink-1 truncate">{channel.name}</h1>
        {topicEditing ? (
          <div className="mt-2 flex flex-col sm:flex-row gap-2">
            <input
              autoFocus
              type="text"
              value={topicDraft}
              maxLength={1024}
              onChange={(e) => setTopicDraft(e.target.value)}
              placeholder="What's this stage about?"
              className="flex-1 px-3 py-1.5 bg-bg-1 border border-line rounded-md text-sm"
            />
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => void saveTopic()}
                className="px-3 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setTopicEditing(false);
                  setTopicDraft(channel.topic ?? '');
                }}
                className="px-3 py-1.5 rounded-md bg-bg-3 text-sm hover:bg-bg-3/70"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-1 flex items-start gap-2">
            <p className="flex-1 text-sm text-ink-2 break-words">
              {channel.topic || (isMod ? 'Set a topic to tell members what this stage is about.' : 'No topic set.')}
            </p>
            {isMod && (
              <button
                onClick={() => setTopicEditing(true)}
                className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 shrink-0"
                aria-label="Edit topic"
                title="Edit topic"
              >
                <Edit size={13} />
              </button>
            )}
          </div>
        )}
      </header>

      {/* Speakers + audience. Scrollable middle section. */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 sm:px-6 py-4 sm:py-6 space-y-6">
        <Section title="Speakers" count={speakers.length}>
          {speakers.length === 0 ? (
            <p className="text-sm text-ink-3 italic">No one speaking yet.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {speakers.map((p) => {
                const u = usersById[p.userId];
                const tone = avatarColor(p.userId);
                const initials = avatarInitials(u?.displayName);
                return (
                  <div key={p.userId} className="flex flex-col items-center gap-1.5 w-20">
                    <div className="relative">
                      <div className={`w-16 h-16 rounded-full flex items-center justify-center text-lg font-semibold overflow-hidden ${tone}`}>
                        <span aria-hidden>{initials}</span>
                        <AvatarImage src={u?.avatarUrl ?? null} />
                      </div>
                    </div>
                    <span className="text-xs text-ink-1 truncate max-w-full text-center">
                      {u?.displayName ?? '…'}
                    </span>
                    {isMod && p.userId !== user?.id && (
                      <button
                        onClick={() => void setSpeaker(p.userId, false)}
                        className="text-[0.65rem] text-ink-3 hover:text-red-400 underline"
                        title="Move to audience"
                      >
                        Demote
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        {/* Raised hands queue — mod only. */}
        {isMod && raisedHands.length > 0 && (
          <Section title="Raised hands" count={raisedHands.length} accent>
            <ul className="flex flex-col gap-2">
              {raisedHands.map((p) => {
                const u = usersById[p.userId];
                const tone = avatarColor(p.userId);
                const initials = avatarInitials(u?.displayName);
                return (
                  <li
                    key={p.userId}
                    className="flex items-center gap-3 px-3 py-2 bg-bg-2 border border-accent/30 rounded-md"
                  >
                    <div className={`relative w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold overflow-hidden shrink-0 ${tone}`}>
                      <span aria-hidden>{initials}</span>
                      <AvatarImage src={u?.avatarUrl ?? null} />
                    </div>
                    <Hand size={14} className="text-accent shrink-0" />
                    <span className="flex-1 text-sm truncate">{u?.displayName ?? '…'}</span>
                    <button
                      onClick={() => void setSpeaker(p.userId, true)}
                      className="px-3 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 shrink-0"
                    >
                      Promote
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <Section title="Audience" count={audience.length}>
          {audience.length === 0 ? (
            <p className="text-sm text-ink-3 italic">No one in the audience.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {audience.slice(0, AUDIENCE_VISIBLE).map((p) => {
                const u = usersById[p.userId];
                const tone = avatarColor(p.userId);
                const initials = avatarInitials(u?.displayName);
                return (
                  <div
                    key={p.userId}
                    className="flex flex-col items-center gap-1 w-14"
                    title={u?.displayName ?? ''}
                  >
                    <div className="relative">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-semibold overflow-hidden ${tone}`}>
                        <span aria-hidden>{initials}</span>
                        <AvatarImage src={u?.avatarUrl ?? null} />
                      </div>
                      {p.handRaised && (
                        <span
                          className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-bg-1 rounded-full flex items-center justify-center"
                          aria-label="Hand raised"
                        >
                          <Hand size={10} className="text-accent" />
                        </span>
                      )}
                    </div>
                    <span className="text-[0.65rem] text-ink-2 truncate max-w-full text-center">
                      {u?.displayName ?? '…'}
                    </span>
                  </div>
                );
              })}
              {audience.length > AUDIENCE_VISIBLE && (
                <div className="flex items-center justify-center w-14 h-10 bg-bg-3 rounded-full text-xs text-ink-3">
                  +{audience.length - AUDIENCE_VISIBLE}
                </div>
              )}
            </div>
          )}
        </Section>
      </div>

      {/* Self controls. */}
      <footer className="border-t border-line px-3 py-3 sm:px-6 shrink-0 bg-bg-2">
        {!inStage ? (
          <button
            onClick={() => void joinAsAudience()}
            className="w-full px-4 py-2.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90"
          >
            Join stage
          </button>
        ) : myParticipant?.isSpeaker ? (
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={toggleMic}
              // Match VoiceView's ControlButton muted state: a subtle red tint
              // with a red icon, NOT a solid-red flood + white icon (the
              // off-theme look). Unmuted stays the neutral bg-3 button.
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
                micMuted ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400' : 'bg-bg-3 hover:bg-bg-3/70 text-ink-1'
              }`}
              title={micMuted ? 'Unmute' : 'Mute'}
              aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {micMuted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              onClick={() => void setSpeaker(user?.id ?? '', false)}
              className="px-4 py-2 rounded-md bg-bg-3 hover:bg-bg-3/70 text-sm"
              title="Stop speaking and move to audience"
            >
              Stop speaking
            </button>
            <button
              onClick={() => void leave()}
              className="w-11 h-11 rounded-full flex items-center justify-center bg-red-500/80 hover:bg-red-500 text-white"
              title="Leave stage"
              aria-label="Leave stage"
            >
              <PhoneOff size={18} />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => void (myParticipant?.handRaised ? lowerHand() : raiseHand())}
              className={`px-4 py-2.5 rounded-md text-sm font-medium flex items-center gap-2 ${
                myParticipant?.handRaised
                  ? 'bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25'
                  : 'bg-bg-3 hover:bg-bg-3/70'
              }`}
              title={myParticipant?.handRaised ? 'Lower hand' : 'Raise hand to request to speak'}
            >
              <Hand size={14} />
              {myParticipant?.handRaised ? 'Hand raised' : 'Raise hand'}
            </button>
            <button
              onClick={() => void leave()}
              className="w-11 h-11 rounded-full flex items-center justify-center bg-red-500/80 hover:bg-red-500 text-white"
              title="Leave stage"
              aria-label="Leave stage"
            >
              <PhoneOff size={18} />
            </button>
          </div>
        )}
      </footer>
    </div>
  );
}

function Section({
  title,
  count,
  accent = false,
  children,
}: {
  title: string;
  count: number;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className={`text-xs uppercase tracking-wider font-semibold mb-2 ${accent ? 'text-accent' : 'text-ink-3'}`}>
        {title} <span className="ml-1 opacity-70">{count}</span>
      </h2>
      {children}
    </section>
  );
}

// (component definition complete)
