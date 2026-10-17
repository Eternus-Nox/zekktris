/**
 * Shell
 * -----
 * Three-column app layout: guild rail → channel rail → message view (→
 * member list, in guild mode).
 *
 * The currently-selected guild and channel live in URL params. Routes:
 *   /                              → first guild's first channel
 *   /channels/:guildId             → guild's last visited channel (or first)
 *   /channels/:guildId/:channelId  → specific channel
 *   /channels/@me                  → DMs view (column 2 = DM list, no member list)
 *   /channels/@me/:channelId       → specific DM open
 *
 * The "@me" sentinel rides the same :guildId param slot — react-router
 * matches it as an opaque string. Inside Shell we branch on it: in DM
 * mode we swap ChannelList for DMList, replace the message view's source
 * (DM channel from state.dmChannels), and hide the member list column.
 */

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { ZekktrisMark } from '../lib/ZekktrisMark';
import { Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { VerifyEmailGate } from './VerifyEmail';
// Route-level views are code-split: they're not on the critical path
// for first paint (admin is rarely opened, settings/voice are
// on-demand), so lazy-loading keeps them out of the initial bundle.
const VoiceView = lazy(() => import('./VoiceView').then((m) => ({ default: m.VoiceView })));
const AdminPanel = lazy(() => import('./AdminPanel').then((m) => ({ default: m.AdminPanel })));
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })));
const FamilySettings = lazy(() =>
  import('./FamilySettings').then((m) => ({ default: m.FamilySettings })),
);

// Shared fallback while a code-split view's chunk loads.
const lazyFallback = (
  <div className="flex-1 min-h-0 grid place-items-center text-ink-3 text-sm">Loading…</div>
);
import { useAuth } from '../auth/AuthContext';
import { useNativePush } from './useNativePush';
import { useAppStateSelector, totalMentionCount, voiceStatesForChannel, selfVoiceState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { disconnectVoice, getActiveVoiceSessionId, getConnectedChannelId } from '../lib/voice';
import { GuildList } from './GuildList';
import { ChannelList } from './ChannelList';
import { DMList } from './DMList';
import { MessageView } from './MessageView';
import { GlobalCallOverlay } from './GlobalCallOverlay';
import { StageChannelView } from './StageChannelView';
import { ForumView } from './ForumView';
import { DiscoveryView } from './DiscoveryView';
import { MentionsView } from './MentionsView';
import { OnboardingModal } from './OnboardingModal';
import { CreateServerView } from './CreateServerView';
import { JoinServerView } from './JoinServerView';
import { InvitePage } from './InvitePage';
import { MemberList } from './MemberList';
import { VoicePanel } from './VoicePanel';
import { FriendsView } from './FriendsView';
import { SavedView } from './SavedView';
import { ScheduledMessagesView } from './ScheduledMessagesView';
import { MyEventsModal } from './MyEventsModal';
import { ChevronLeft, ChevronUp, ChevronDown, Users as UsersIcon } from '../lib/icons';
import type { Channel } from '@zekktris/client';
import { useKeyboardInset } from '../lib/useKeyboardInset';
import { QuickSwitcher } from './QuickSwitcher';
import { ErrorBoundary } from '../lib/ErrorBoundary';

const ME = '@me';

/**
 * How long a voice session-id mismatch must persist before the takeover
 * watcher acts on it. connectToVoice records this device's session id at
 * the very END of a join (after the Room is up and the mic is published),
 * but the server dispatches the VOICE_STATE_UPDATE carrying that same new
 * id the instant it upserts the row. Every legitimate join — and every
 * channel switch — therefore passes through a window where the server's id
 * is newer than ours and the comparison reads exactly like a takeover.
 * Re-checking after the join has had time to land keeps the real case
 * (another device joined; our local id never catches up) and drops the
 * self-inflicted one.
 */
const VOICE_TAKEOVER_GRACE_MS = 4000;

/**
 * Where the DM auto-end's "the partner HAS been in this call" latch is
 * persisted so it survives a reload / PWA restore.
 *
 * The latch itself lives in a ref, which is fresh on every mount — so a tab
 * that reloads mid-call (or a PWA the OS restored) comes back believing the
 * partner was never here. READY then hydrates OUR voice row but not the
 * partner's if they hung up in the meantime, and the auto-end below stays
 * disabled for the rest of the session: the user renders as "in a call" that
 * has already ended, their row sits on the server for everyone else to see,
 * and their own call button is dead until they hang up by hand.
 *
 * sessionStorage, deliberately, not localStorage: it is scoped to THIS tab,
 * so the latch can only ever re-arm a call this very tab was already
 * watching. A second tab, or a call ringing out from the user's phone, never
 * inherits it — which matters, because arming the latch on someone else's
 * ring-out would make this tab hang up a call that nobody has answered yet.
 */
const PARTNER_SEEN_KEY = 'zekktrisCallPartnerSeen';

/**
 * The latch value is `<channelId>:<voiceSessionId>`. Pinning it to the voice
 * session id — a fresh string the server mints on every join — is what stops
 * an entry stranded by an earlier call (tab closed mid-call, so the "we left"
 * branch never ran) from arming the NEXT call to the same DM, which would
 * hang up that call's ring-out the instant it started.
 */
function partnerSeenLatch(channelId: string, sessionId: string | null): string | null {
  return sessionId === null ? null : `${channelId}:${sessionId}`;
}

function readPartnerSeen(latch: string | null): boolean {
  if (latch === null) return false;
  try {
    return window.sessionStorage.getItem(PARTNER_SEEN_KEY) === latch;
  } catch {
    // Storage disabled (private mode, locked-down webview). The in-memory
    // ref still works for a tab that stays mounted; only the reload case
    // degrades to today's behavior.
    return false;
  }
}

function writePartnerSeen(latch: string | null): void {
  try {
    if (latch === null) window.sessionStorage.removeItem(PARTNER_SEEN_KEY);
    else window.sessionStorage.setItem(PARTNER_SEEN_KEY, latch);
  } catch {
    // See readPartnerSeen — persistence is a best-effort upgrade.
  }
}

export function Shell() {
  const { token, user, hydrating, rest, emailVerificationRequired } = useAuth();
  const params = useParams<{ guildId?: string; channelId?: string; messageId?: string }>();
  // Granular subscriptions (was `useAppState()`): the top-level shell no
  // longer re-renders on every dispatch — only when one of the slices it
  // actually reads changes. This is high-leverage: a Shell re-render
  // cascades into all four columns.
  const loadChannels = useAppStateSelector((v) => v.loadChannels);
  const voiceStatesByUser = useAppStateSelector((v) => v.state.voiceStatesByUser);
  const dmChannels = useAppStateSelector((v) => v.state.dmChannels);
  const guildIds = useAppStateSelector((v) => v.state.guildIds);
  const channelsByGuild = useAppStateSelector((v) => v.state.channelsByGuild);
  const guildsById = useAppStateSelector((v) => v.state.guildsById);
  // Read only for the stage gate on the eviction teardown below, and only ever
  // as a membership test — so subscribe to the KEY SET, flattened to a string,
  // rather than to the dict itself.
  //
  // Subscribing to the dict was a re-render storm: STAGE_PARTICIPANTS_SET
  // allocates a new dict on every update, and stage-participant updates fan out
  // to the whole CHANNEL audience (dispatch.stageParticipantsUpdate), not just
  // to people in the room. So every join / leave / hand-raise / promote in any
  // stage re-rendered Shell — which cascades into all four columns, see above —
  // for every member who can merely SEE that channel. The key set changes only
  // when a stage channel first appears in state or is removed, which is the only
  // thing this gate can actually observe, so the storm disappears while the
  // answer stays identical.
  const stageChannelIdKey = useAppStateSelector((v) =>
    Object.keys(v.state.stageParticipantsByChannel).sort().join(','),
  );
  const stageParticipantChannelIds = useMemo(
    () => new Set(stageChannelIdKey === '' ? [] : stageChannelIdKey.split(',')),
    [stageChannelIdKey],
  );
  const readStateByChannel = useAppStateSelector((v) => v.state.readStateByChannel);
  const nav = useNavigate();
  // Track on-screen keyboard height as a CSS variable so the layout
  // can stay above the keyboard even when iOS Safari fails to resize
  // the layout viewport. Hook does nothing on platforms / browsers
  // without visualViewport support.
  useKeyboardInset();
  // Native iOS only (no-op on web): after login, request push permission,
  // register the APNs device token with the server, and route taps.
  useNativePush();

  // Single-session-per-user enforcement. The voice_states table has
  // userId as the primary key — DB level there's only ever one row
  // per user, with joinVoice doing an upsert that REPLACES the prior
  // row with a fresh sessionId. But the LiveKit room can hold
  // simultaneous WebRTC connections from multiple devices using the
  // same `identity`, so when the user joins voice from a second
  // device, the first device's audio is still publishing — both
  // mics live, double-echo for other participants. The DB is the
  // source of truth for "which session is current"; this effect
  // watches the server-side sessionId for self and tears down the
  // local LiveKit connection if it ever differs from the one this
  // device established.
  //
  // Critical: we read the LOCAL session id from voice.ts (the one
  // THIS device claimed when its own connectToVoice ran), not from
  // a useRef tracking "first sessionId we saw." The useRef approach
  // false-positives on refresh + rejoin: READY hydrates with a
  // stale sessionId from before the refresh, we'd record that as
  // "ours," then when the user legitimately rejoins, the server
  // upserts a fresh sessionId and our ref-based check incorrectly
  // fires disconnect. Reading from voice.ts is accurate because
  // the lib only records a session id after a successful local
  // connect, and clears it on local disconnect.
  const toasts = useToasts();
  const myVoiceSessionId =
    voiceStatesByUser[user?.id ?? '']?.sessionId ?? null;
  useEffect(() => {
    const local = getActiveVoiceSessionId();
    // We can only meaningfully detect takeover when this device
    // currently owns a voice session AND the server reports a
    // session id we can compare against. Either being null means
    // there's nothing actionable: if local is null, this device
    // isn't connected so there's nothing to disconnect; if server
    // is null, the user isn't in voice anywhere per the server,
    // which is a different state-transition not a takeover.
    if (local === null || myVoiceSessionId === null) return;
    if (local === myVoiceSessionId) return;
    // Mismatch — but a join in flight on THIS device looks identical (see
    // VOICE_TAKEOVER_GRACE_MS), so require it to survive the grace before
    // acting, and re-read the local id at that point rather than trusting
    // the value captured above. Our own join lands its session id in the
    // meantime; a real takeover leaves it stale forever.
    const timer = window.setTimeout(() => {
      const settled = getActiveVoiceSessionId();
      if (settled === null || settled === myVoiceSessionId) return;
      // The server's session id for this user still doesn't match the
      // one this device locally established → another device
      // (phone, second tab, second computer) joined voice and
      // replaced our row. Tear down our local zombie connection
      // silently — the user is the one who joined from the other
      // device, so notifying them is just noise. Keep the console
      // warn for debugging session-id mismatches.
      // eslint-disable-next-line no-console
      console.warn(
        'Voice session taken over by another device (local %s, server %s)',
        settled,
        myVoiceSessionId,
      );
      // silent: same reasoning as the console.warn above — the user moved
      // themselves to another device, so the call didn't end from their point
      // of view. An end-of-call chime here is noise about a non-event.
      void disconnectVoice({ silent: true });
    }, VOICE_TAKEOVER_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [myVoiceSessionId, toasts]);

  // DM call auto-end: when you're in voice in a 1:1 DM channel and
  // the other party drops, end the call on your side too. DM calls
  // are inherently two-party — keeping one party connected after
  // the other leaves just produces an empty room with no audio
  // path, which is confusing UX.
  //
  // CRITICAL: we only auto-end if the partner WAS in voice with us
  // at some point during this session and is now gone. Without that
  // gate, this watcher would fire the instant we joined our own
  // outgoing call (since at that exact moment we're alone in the
  // channel — the partner hasn't picked up yet) and immediately
  // hang up our own ring-out. The ring-out IS supposed to leave us
  // alone in voice until the partner joins; that's the whole point.
  const myVoiceChannelId =
    voiceStatesByUser[user?.id ?? '']?.channelId ?? null;
  // Ref tracks "has the partner ever appeared in voice with me for
  // THIS channel during this session." Keyed by channelId so a fresh
  // call to a different DM starts with a clean flag. Reset when we
  // leave voice or switch channels.
  const partnerWasHereRef = useRef<{ channelId: string; seen: boolean } | null>(null);
  // Ref that prevents the auto-end from firing multiple times while
  // a previous leaveVoice round-trip is still in flight. State
  // deps (voiceStatesByUser, dmChannels) update from any dispatch,
  // so without this guard the effect could re-trigger the IIFE
  // before the server-side leave's voice-state-update came back —
  // producing duplicate "Call ended" toasts and a duplicate
  // disconnectVoice. Cleared once the local voice state actually
  // shows we're no longer in this channel.
  const leavingInProgressRef = useRef<string | null>(null);
  // Ref recording the channel whose end-of-call we have already announced
  // (audio torn down + "Call ended" toast). Kept SEPARATE from
  // leavingInProgressRef because the two have different lifetimes: the leave
  // DELETE is retried until it succeeds, but the call only ends once. Cleared
  // when the partner shows up again (a new call to announce the end of) and
  // when we drop out of voice entirely.
  const callEndedRef = useRef<string | null>(null);
  /**
   * Is `channelId` a STAGE room?
   *
   * Stage is the one connected state that legitimately has no voice_states
   * row of our own: joinStage writes stage_participants and nothing else
   * (apps/api/src/services/stage.ts), while connectToVoice still records the
   * channel as connected for every join. So for a stage participant —
   * audience AND speaker — "in a room, no row for me" is the normal steady
   * state, not the eviction signature the teardown below looks for.
   *
   * Two signals, because either can be missing on its own: the participant
   * list is fetched lazily by StageChannelView (absent until it lands), and a
   * guild's channel list can be dropped from state while the room is still up.
   */
  const isStageChannel = useCallback(
    (channelId: string): boolean => {
      // stage_participants IS how stage membership is represented, and this
      // slice is only ever written from stage events — an entry for the
      // channel (ours or anyone else's) marks it as a stage room.
      if (stageParticipantChannelIds.has(channelId)) return true;
      for (const list of Object.values(channelsByGuild)) {
        const ch = list.find((c) => c.id === channelId);
        if (ch) return ch.type === 'guild_stage';
      }
      return false;
    },
    [channelsByGuild, stageParticipantChannelIds],
  );
  // The armed teardown re-evaluates the stage gate when it FIRES rather than
  // trusting the render that armed it — the user can hang up and join a stage
  // inside the grace window. A ref, because that timer deliberately outlives
  // the effect run that created it.
  const isStageChannelRef = useRef(isStageChannel);
  useEffect(() => {
    isStageChannelRef.current = isStageChannel;
  }, [isStageChannel]);
  /**
   * The pending "the server evicted us" teardown.
   *
   * It lives in a ref, not in the effect's cleanup, because the effect re-runs
   * on every voiceStatesByUser / dmChannels change — the 10s in-call roster
   * reconcile or a DM-recipient presence patch is enough. Scoped to the effect
   * run, each of those unrelated dispatches cleared the pending teardown and
   * started a fresh countdown, so a busy roster could push the deadline out
   * indefinitely. Owned by the ref it is armed once per eviction and cancelled
   * only by the things that make it wrong: our voice row coming back, or the
   * connection going away.
   */
  const evictionTimerRef = useRef<number | null>(null);
  const cancelEviction = useCallback(() => {
    if (evictionTimerRef.current === null) return;
    window.clearTimeout(evictionTimerRef.current);
    evictionTimerRef.current = null;
  }, []);
  // Unmount only — cancelEviction is stable, so this never re-runs. A pending
  // teardown must not outlive the Shell.
  useEffect(() => cancelEviction, [cancelEviction]);
  useEffect(() => {
    const selfId = user?.id;
    if (!selfId || !myVoiceChannelId) {
      // Not in voice → clear the partner-was-here memory so a future
      // call to the same DM starts fresh. Also clear the leaving
      // guard since we're definitively out now.
      //
      // The PERSISTED half is dropped only when this mount was actually
      // tracking a call. This branch also runs on the first render after a
      // reload — before READY has hydrated our voice state — and clearing
      // there would erase the very record the rehydrated call needs to know
      // its partner had already answered.
      if (partnerWasHereRef.current !== null) writePartnerSeen(null);
      partnerWasHereRef.current = null;
      leavingInProgressRef.current = null;
      callEndedRef.current = null;
      // Our own row is GONE while this device is still in the SFU room: the
      // server ended the call for us — the callee declined, a moderator
      // disconnected us, or the socket-close grace evicted the row. (An AFK
      // move repoints the row instead of deleting it, so it lands on the
      // self-move detector, not here.) Nothing else covers this: the takeover
      // watcher above needs a server session id to compare against and there
      // is none once the row is deleted, and the self-move detector only
      // fires for a row that still names a channel. So without a teardown
      // here the Room — and the mic — stays live behind a UI that already
      // shows us out of the call. iOS does exactly this (AppStore's "server
      // evicted US" branch).
      //
      // SCOPE: only a channel we could ever have HELD a row for. Not being
      // connected at all is the obvious exclusion; STAGE is the one that is
      // easy to miss and fatal to get wrong — a stage listener (and speaker)
      // is connected to the room with no voice_states row by design, so
      // "connected, no row" there is the steady state, and tearing down on it
      // hangs up every stage participant seconds after they join. See
      // isStageChannel.
      const connected = getConnectedChannelId();
      if (connected === null || isStageChannel(connected)) {
        cancelEviction();
        return;
      }
      // Deferred behind the same grace as the takeover check, for the same
      // reason: a join in flight has a live room before its own state-update
      // echo lands, and that window is indistinguishable from an eviction.
      // The countdown is armed ONCE and owned by evictionTimerRef — a re-run
      // driven by unrelated churn (roster reconcile, presence patch) must not
      // restart it, or a busy roster keeps pushing the deadline out. It is
      // cancelled by our row returning, or by the connection going away.
      if (evictionTimerRef.current !== null) return;
      // The CONNECTION this teardown was armed for — room and session both.
      //
      // Arming once (above) means the timer can outlive the connection it was
      // armed against: evicted from X, user joins somewhere two seconds later,
      // and the fresh join's VOICE_STATE_UPDATE echo lands after the grace
      // expires. All the timer used to check was "connected to something that
      // isn't a stage", so it tore down the healthy new call — hangup chime and
      // all. Usually masked by the echo beating the join response and
      // cancelling at the bottom of this effect; this makes it not a race.
      //
      // Room id alone is not enough, because half of that sequence is re-joining
      // the SAME room X — where the id at fire time matches the id at arm time
      // and the guard would wave a brand-new connection through. The local voice
      // session id is what distinguishes them: voice.ts stamps a fresh one on
      // every successful connect and clears it on disconnect, so "same room,
      // different session" is exactly a re-join. Captured defensively — a null
      // here (a connection that carries no session id) just falls back to the
      // room-id check rather than blocking every teardown.
      const armedChannelId = connected;
      const armedSessionId = getActiveVoiceSessionId();
      evictionTimerRef.current = window.setTimeout(() => {
        evictionTimerRef.current = null;
        // Re-read live rather than trusting the arming render: the grace
        // window is long enough to hang up and land somewhere else. Only the
        // room this was armed for may be torn down (the null test is what
        // narrows the type; a null connection can't equal armedChannelId).
        const stillConnected = getConnectedChannelId();
        if (stillConnected === null || stillConnected !== armedChannelId) return;
        if (armedSessionId !== null && getActiveVoiceSessionId() !== armedSessionId) return;
        // The stage gate is re-evaluated at FIRE time, not trusted from the
        // arming render: a guild's channel list can land inside the grace window
        // and only then reveal the room as a stage.
        if (isStageChannelRef.current(stillConnected)) return;
        // Not silent: from the user's point of view the call ended, so the
        // hangup chime is the honest signal.
        void disconnectVoice();
      }, VOICE_TAKEOVER_GRACE_MS);
      return;
    }
    // We hold a voice row again (or still) → nothing was evicted; drop any
    // countdown armed while it was missing.
    cancelEviction();
    // If we're already mid-leave for this channel, do nothing — the
    // IIFE below started a leave that hasn't finished propagating
    // back to local state yet.
    if (leavingInProgressRef.current === myVoiceChannelId) return;
    // Reset the flag if we changed channels (joined a different call), seeding
    // it from the persisted latch: after a reload the partner may have been
    // here all along, and a fresh `seen: false` is what leaves the call
    // un-endable for the rest of the session (see PARTNER_SEEN_KEY).
    const latch = partnerSeenLatch(myVoiceChannelId, myVoiceSessionId);
    if (partnerWasHereRef.current?.channelId !== myVoiceChannelId) {
      partnerWasHereRef.current = {
        channelId: myVoiceChannelId,
        seen: readPartnerSeen(latch),
      };
    }
    // Is the channel I'm in a 1:1 DM? Look it up.
    const ch = dmChannels.find((c) => c.id === myVoiceChannelId);
    if (!ch || ch.type !== 'dm') return; // not a 1:1 DM — group calls + guild voice don't auto-end on partner leave
    // Is any OTHER user currently in this channel's voice?
    const othersInChannel = Object.values(voiceStatesByUser).some(
      (v) => v.channelId === myVoiceChannelId && v.userId !== selfId,
    );
    // If a partner is here right now, remember it. The flag stays
    // set even after they leave — that's how we detect "they were
    // here and now they're not."
    if (othersInChannel) {
      partnerWasHereRef.current.seen = true;
      // A partner is in the room, so this is a LIVE call — whatever end we
      // announced earlier was for a previous one, and the next end deserves
      // its own toast.
      callEndedRef.current = null;
      // Persist it too, so a reload / PWA restore of this tab rejoins the
      // call already knowing it was answered. Skipped when the row carries
      // no session id — there'd be nothing to pin the latch to, and writing
      // the clear value here would drop a good entry.
      if (latch !== null) writePartnerSeen(latch);
      return;
    }
    // No partner. Only fire the auto-end if the partner had been
    // here at some point. Otherwise this is just our ring-out
    // waiting for them to pick up — don't interrupt that.
    if (!partnerWasHereRef.current.seen) return;
    // Partner was here and is now gone → end the call locally.
    leavingInProgressRef.current = myVoiceChannelId;
    const leaving = myVoiceChannelId;
    // End the call on this device exactly once, latched separately from the
    // leave below. The two have different lifetimes: a failed DELETE is
    // retried on the next voice-state change (see the catch), but the call
    // itself only ends once — without this latch every retry re-announced
    // "Call ended", once per presence patch, for as long as the DELETE kept
    // failing. Local teardown comes first here for the same reason it does at
    // every hangup button (VoiceView, MessageView, OutgoingCallModal): the
    // mic should die when the call ends, not when the server gets around to
    // acknowledging it.
    if (callEndedRef.current !== leaving) {
      callEndedRef.current = leaving;
      void disconnectVoice();
      toasts.push('Call ended', 'info');
    }
    void (async () => {
      try {
        await rest.leaveVoice(leaving);
        // Success: leave the guard latched. Our row is about to disappear and
        // clear it, and releasing early would let a re-render fire a
        // duplicate leave before the gateway echo lands.
      } catch {
        // The leave failed, so the server still has us in the call and our
        // voice row never clears — which means the "we're out of voice"
        // branch that normally releases this guard will never run, and the
        // guard at the top of this effect swallows every later attempt.
        // One dropped request would otherwise disable hangup for the rest of
        // the session: local audio dead, still in the call for everyone else.
        // Release it so the next voice-state change retries the DELETE; the
        // retry is the REST call only — audio is already down and the user has
        // already been told.
        if (leavingInProgressRef.current === leaving) leavingInProgressRef.current = null;
      }
    })();
  }, [
    myVoiceChannelId,
    myVoiceSessionId,
    voiceStatesByUser,
    dmChannels,
    user?.id,
    rest,
    toasts,
    isStageChannel,
    cancelEviction,
  ]);

  // NOTE: All hooks must be declared BEFORE any early return below. Early
  // returns inside this component skip the hooks underneath them, and React
  // demands hook order be stable across renders — hydrating: true → false
  // would change the count of hooks called and crash the tree (manifests
  // as a grey screen on refresh because the error is thrown after the
  // initial loader render).

  const activeChannelId = params.channelId;
  const isDmMode = params.guildId === ME;
  // Discovery mode is a top-level pseudo-area like DMs — no guild,
  // no channel; the main pane renders a directory of joinable guilds.
  const location = useLocation();
  const isDiscoverMode = location.pathname.startsWith('/discover');
  // Admin mode: same pattern. /admin renders the AdminPanel content
  // in the main pane while keeping the GuildList rail visible on
  // the left (so the operator can hop back to a guild without losing
  // their place). Hides the secondary channel-list pane since no
  // guild context applies.
  const isAdminMode = location.pathname.startsWith('/admin');
  // Additional content-only modes added in the rail-content refactor.
  // Each renders inside the main pane with the rail visible and the
  // channel-list column hidden — same layout shape as discover/admin.
  // Leaving any of these is done by clicking elsewhere in the rail.
  const isMentionsMode = location.pathname.startsWith('/mentions');
  const isSettingsMode = location.pathname.startsWith('/settings');
  const isFamilyMode = location.pathname.startsWith('/family');
  const isCreateServerMode = location.pathname.startsWith('/create-server');
  const isJoinServerMode = location.pathname.startsWith('/join-server');
  const isInviteMode = location.pathname.startsWith('/invite/');
  // /friends is its own content-mode route — distinct from /channels/@me.
  // On desktop the two render the same FriendsView in main, but on mobile
  // /channels/@me shows ONLY the DM list (the main pane is hidden when no
  // channel is active and we're not in a content mode), so the Friends
  // button needs its own route to make the friends section reachable.
  const isFriendsMode = location.pathname.startsWith('/friends');
  // /saved is its own content-mode route — paginated bookmarks view.
  // Same mobile-routing rationale as friends: from /channels/@me on
  // mobile, the main pane is hidden when no channel is active, so a
  // standalone route is needed for the affordance to be reachable.
  const isSavedMode = location.pathname.startsWith('/saved');
  // /scheduled — paginated list of pending future-send messages.
  // Same content-mode treatment as saved/friends; main pane is the
  // ScheduledMessagesView component.
  const isScheduledMode = location.pathname.startsWith('/scheduled');
  // /events — cross-guild "your events" dashboard, rendered inline.
  const isEventsMode = location.pathname.startsWith('/events');
  // DM-adjacent views: they render a dedicated view in the MAIN pane
  // but keep the DM sidebar (DMList) visible alongside, so they feel
  // baked into the app rather than taking over the whole page.
  const isDmAuxMode =
    isFriendsMode || isSavedMode || isScheduledMode || isEventsMode;
  // True whenever the layout should show the DM sidebar: the DM
  // landing itself, or any DM-adjacent view.
  const isDmLayout = isDmMode || isDmAuxMode;
  // Aggregate flag for the FULL-WIDTH content modes (no secondary
  // sidebar at all). DM-adjacent views are deliberately NOT here —
  // they keep the DM sidebar.
  const isContentMode =
    isDiscoverMode ||
    isAdminMode ||
    isMentionsMode ||
    isSettingsMode ||
    isFamilyMode ||
    isCreateServerMode ||
    isJoinServerMode ||
    isInviteMode;

  // ── Guild-mode resolution ─────────────────────────────────────────────
  // In DM or content-mode there's no active guild — the main pane shows
  // FriendsView or one of the routed content views. We still let
  // activeGuildId fall through for the rail's "active" indicator (none)
  // but skip the channel-list resolution below.
  const activeGuildId = isDmLayout || isContentMode
    ? undefined
    : (params.guildId ?? guildIds[0]);
  const activeGuildChannels = activeGuildId ? channelsByGuild[activeGuildId] : undefined;

  // Keep the voice roster in the sidebar honest. It is otherwise built from
  // VOICE_STATE_UPDATE events alone, and one dropped event left people
  // invisible to everyone outside the call until somebody joined — at which
  // point the join's snapshot made them all appear at once. Re-read the
  // server's roster when the sidebar changes servers, whenever the window
  // regains focus or the network comes back, and every 15s while visible.
  //
  // Placed ABOVE every early return in this component: a hook below one runs
  // on some renders and not others, which is React #310.
  const reconcileGuildVoice = useAppStateSelector((v) => v.reconcileGuildVoice);
  useEffect(() => {
    if (!activeGuildId) return;
    const heal = (): void => {
      if (document.visibilityState === 'visible') void reconcileGuildVoice(activeGuildId);
    };
    heal();
    const id = window.setInterval(heal, 15_000);
    window.addEventListener('focus', heal);
    window.addEventListener('online', heal);
    document.addEventListener('visibilitychange', heal);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', heal);
      window.removeEventListener('online', heal);
      document.removeEventListener('visibilitychange', heal);
    };
  }, [activeGuildId, reconcileGuildVoice]);

  // Auto-select first text channel if guild is set but channel isn't.
  // Only fires on desktop — on mobile we want the user to land on the
  // channel list view and pick a channel explicitly. Auto-bouncing
  // them into the first channel on mobile would skip the channel-list
  // step entirely; they'd never see the surface that lets them
  // discover other channels, switch categories, see voice presence,
  // etc. On desktop the channel list is always visible alongside
  // the content so the auto-pick is a courtesy, not a navigation
  // skip — different ergonomic context, different default.
  useEffect(() => {
    if (hydrating || !token) return; // skip work during boot / logged-out
    if (isDmLayout || isContentMode || !activeGuildId) return;
    if (!activeGuildChannels) {
      void loadChannels(activeGuildId).catch(() => undefined);
      return;
    }
    if (params.channelId) return;
    // Mobile gate. matchMedia is reactive but we don't subscribe to
    // changes here — the user resizing past the breakpoint shouldn't
    // suddenly auto-bounce them into a channel they didn't pick. The
    // check is done once per effect run; if they navigate after a
    // resize the new effect run sees the new viewport.
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1280px)').matches) {
      return;
    }
    const firstText = activeGuildChannels.find((c) => c.type === 'guild_text');
    if (firstText) {
      nav(`/channels/${activeGuildId}/${firstText.id}`, { replace: true });
    }
  }, [hydrating, token, isDmLayout, isContentMode, activeGuildId, activeGuildChannels, params.channelId, loadChannels, nav]);

  // If nothing is in URL but the user is authenticated, land them
  // on the DMs dashboard. The previous behavior auto-routed to the
  // first guild — that meant opening the app dropped you straight
  // into a server channel even on a fresh device or after a long
  // gap, which felt like the app was making the call instead of
  // you. DMs/Friends is the neutral home: it's where the user
  // chooses what to do next (open a server from the rail, hop into
  // friends, browse discovery), without any default guild bias.
  useEffect(() => {
    if (hydrating || !token) return;
    if (isDmLayout || isContentMode) return;
    if (!params.guildId) {
      nav(`/channels/${ME}`, { replace: true });
    }
  }, [hydrating, token, isDmLayout, isContentMode, params.guildId, nav]);

  // ── Active-channel resolution ──────────────────────────────────────────
  const activeGuild = useMemo(
    () => (activeGuildId ? guildsById[activeGuildId] : undefined),
    [activeGuildId, guildsById],
  );
  const activeChannel = useMemo(() => {
    if (!activeChannelId) return undefined;
    if (isDmMode) {
      return dmChannels.find((c) => c.id === activeChannelId);
    }
    return activeGuildChannels?.find((c) => c.id === activeChannelId);
  }, [isDmMode, activeChannelId, dmChannels, activeGuildChannels]);

  // ── Mobile drawer state ───────────────────────────────────────────────
  // The guild rail is permanent now (always visible on every viewport),
  // so the old "channel column slides in from the left" drawer is gone.
  // The member list (right side) still uses a drawer on mobile —
  // it's secondary content that would crowd the main view if it
  // were always visible.
  //
  // Auto-close the member drawer whenever the active channel changes —
  // picking a channel should drop the user into the message view, not
  // strand them with the drawer still covering it.
  // Quick switcher (Cmd/Ctrl+K). Lives in Shell so any keystroke
  // anywhere in the app opens it. We intentionally don't gate on
  // text inputs being unfocused — Cmd+K should always work, even
  // mid-typing, matching Discord/Slack convention.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [membersOpen, setMembersOpen] = useState(false);
  useEffect(() => {
    setMembersOpen(false);
  }, [activeChannelId]);

  // Browser-tab title reflects unread mention count + active channel name.
  // Format: "(3) #general · Zekktris" when mentions exist; "#general · Zekktris"
  // when a channel is open; bare "Zekktris" at the empty state. Restoring
  // the bare title on unmount keeps the title clean if the Shell ever
  // gets remounted (auth flows, etc).
  // Memoized. totalMentionCount iterates every channel in the
  // read-state map; we don't want that walk on every Shell render
  // (every state dispatch, of which there are many). Gates on the
  // underlying map ref so it only recomputes when an unread/mention
  // count actually changes.
  const mentionCount = useMemo(
    () => totalMentionCount(readStateByChannel, activeChannelId),
    [readStateByChannel, activeChannelId],
  );
  useEffect(() => {
    const channelLabel = activeChannel?.name
      ? activeChannel.type === 'dm' || activeChannel.type === 'group_dm'
        ? `@${activeChannel.name}`
        : activeChannel.type === 'public_thread'
          ? activeChannel.name
          : `#${activeChannel.name}`
      : null;
    const prefix = mentionCount > 0 ? `(${mentionCount > 99 ? '99+' : mentionCount}) ` : '';
    const middle = channelLabel ? `${channelLabel} \u00b7 ` : '';
    document.title = `${prefix}${middle}Zekktris`;
    return () => {
      document.title = 'Zekktris';
    };
  }, [mentionCount, activeChannel?.name, activeChannel?.type]);

  // ── Auth gate ─────────────────────────────────────────────────────────
  // Placed AFTER all hooks so the hook order is stable across renders.
  // Without this discipline, the boot flow (hydrating: true → false on
  // getMe success) changes the number of hooks called, which React
  // detects and turns into an unrecoverable render error — manifested
  // as a grey/empty screen.
  if (hydrating) return <FullPageLoader />;
  if (!token || !user) return <Navigate to="/login" replace />;
  // Email-verification gate. Only when the deployment requires it (SMTP
  // configured) and this account hasn't verified — blocks the app until
  // they do. Never fires in no-email deployments (required=false).
  if (emailVerificationRequired && !user.emailVerified) {
    return <VerifyEmailGate />;
  }

  // Mobile full-screen: hide the 72px guild rail on small viewports for ALL
  // drilled-in surfaces, so each fills the whole screen with a back button —
  // the iOS pattern. That's a conversation (activeChannelId), any full-width
  // content mode (discover/admin/mentions/settings/family/create-server/
  // join-server/invite), or a DM-aux view (friends/saved/scheduled/events).
  // The ONLY mobile state that keeps the rail is the "hub" — the bare
  // DM/channel list (no channel, no content, no aux) — which is where the
  // rail belongs as the top-level switcher. Back buttons (Shell's floating
  // one for centered views + conversations, and per-view header buttons for
  // the rest) return to the hub. Desktop (xl+) is never affected.
  const railHiddenMobile =
    !!activeChannelId || isContentMode || isDmAuxMode;

  return (
    <>
      {/* Zekktris ambient background — soft plasma auroras + starfield
          painted behind the entire app. Mounted at Shell root so every
          screen (DMs, Discover, Settings, guild views) sits above it.
          Fixed positioning + pointer-events:none mean it never affects
          layout or click targets. */}
      <div className="abyss" aria-hidden />
      {/* Global call overlay — scans DM voice states and surfaces the
          appropriate Incoming/Outgoing modal regardless of which view
          the user is currently on. Was previously mounted inside
          MessageView, which meant DM calls were invisible if the user
          was looking at a guild channel or settings when the ring
          arrived. The component renders null when there's no call,
          so it's effectively free otherwise. */}
      <GlobalCallOverlay />
      <div
      style={{
        // Squeeze the layout by the keyboard inset (see useKeyboardInset).
        // On mobile platforms that don't fully resize the layout viewport
        // when the soft keyboard opens (iOS Safari especially), the
        // composer would otherwise tuck under the keyboard. With this
        // height subtraction, the grid + every column inside it shrinks
        // by the keyboard height — composer, voice bar, and inputs all
        // stay above the keyboard. The CSS var defaults to 0 outside
        // keyboard-open state so desktop and idle-mobile are unaffected.
        height: 'calc(100% - var(--kb-inset, 0px))',
        // Single full-height row so every column (rails + main) fills
        // to the bottom even when the main content is shorter than the
        // viewport (e.g. Friends / Saved / Scheduled / Events views).
        // minmax(0,...) preserves inner overflow scrolling.
        gridTemplateRows: 'minmax(0, 1fr)',
        // Lift above the .abyss layer so content paints above the
        // ambient background, not next to it.
        position: 'relative',
        zIndex: 1,
      }}
      className={`bg-bg-1/85 text-ink-1 relative grid safe-area-padded ${
        // Layout modes. The 72px guild rail is ALWAYS visible — on
        // every viewport, every mode. The columns to the right of
        // it vary by mode and by viewport:
        //
        //   xl+ (desktop):
        //     - Content modes (discover/admin/mentions/settings/
        //       create-server/join-server/invite): rail + main
        //       (no channel-list, no member list — these are
        //       full-width content)
        //     - DM: rail + DM-list + main
        //     - Guild: rail + channel-list + main + member-list
        //
        //   < xl (mobile/tablet):
        //     - Content modes: rail + main
        //     - DM/Guild: rail + ONE of {channel-list, main}, picked
        //       by whether a channel is active. The mutual swap is
        //       CSS-driven (see the `hidden`/`flex` toggles on the
        //       aside and main below), so we don't need a JS media
        //       query here — just a single 2-column grid that lets
        //       the right column be either pane.
        isContentMode
          ? isMentionsMode
            ? // Mentions keeps the server rail beside it (rail + content) at
              // every width, so it reads as a navigation surface, not a
              // full-screen takeover with a back button.
              'grid-cols-[72px_1fr]'
            : 'grid-cols-[1fr] xl:grid-cols-[72px_1fr]'
          : railHiddenMobile
            ? 'grid-cols-[1fr] xl:grid-cols-[72px_276px_1fr_300px]'
            : 'grid-cols-[72px_1fr] xl:grid-cols-[72px_276px_1fr_300px]'
      } ${
        // The 4th column (member list) is dropped from the desktop
        // template when in DM mode (DMs have no member list) or
        // when the active channel is a forum (forums are post-list
        // views — the member sidebar would take space the forum
        // can use). Threads UNDER the forum still get the member
        // list since they're conversations.
        isDmLayout || activeChannel?.type === 'guild_forum'
          ? 'xl:!grid-cols-[72px_276px_1fr]'
          : ''
      }`}
    >
      {/* ── Guild rail ────────────────────────────────────────────────
          Always visible. No drawer, no slide-in. This is the user's
          permanent navigation surface — Home / Discover / Mentions /
          their guilds / settings. Width is fixed at 72px to match
          the column reservation in the grid template.

          NB: no `pt-[env(safe-area-inset-top)]` here — the outer
          container has `safe-area-padded` which already pads the
          whole grid down by the inset. Adding it on the aside
          doubled the top padding and pushed the rail icons way
          too far down on iPhone with Dynamic Island. */}
      <aside
        className={`bg-bg-0/85 border-r border-line h-full overflow-y-auto scrollbar-thin shrink-0 w-[72px] pb-[env(safe-area-inset-bottom)] backdrop-blur-sm ${
          // Hidden on mobile while a conversation/call fills the screen;
          // always present on desktop (xl+). Mentions is the exception among
          // content modes — it keeps the rail on mobile too (see grid above).
          railHiddenMobile && !isMentionsMode ? 'hidden xl:block' : ''
        }`}
        style={{ borderRightColor: 'var(--zk-line-soft)' }}
      >
        <GuildList activeGuildId={isDmLayout ? ME : activeGuildId} />
      </aside>

      {/* ── Channel list / DM list ───────────────────────────────────
          On desktop (xl+): always visible (when in DM or guild mode).
          On mobile (< xl): visible ONLY when no channel is active.
          Tapping a channel selects it; the URL gains a :channelId
          segment; the CSS below flips this pane to hidden and the
          main pane to flex. This is the "drill in / back out" pattern
          familiar from iOS Mail and Discord's mobile app.

          Hidden entirely in Discover/Admin since those modes have no
          channel concept. The grid template above also drops the
          column reservation for these modes so nothing reserves the
          width. */}
      <aside
        className={`bg-bg-2/85 backdrop-blur-sm h-full flex-col shrink-0 pb-[env(safe-area-inset-bottom)] xl:flex xl:w-[276px] ${
          // In any content mode the grid template only has two
          // columns (rail + main), so this aside must be display:none
          // at every viewport — xl:hidden is necessary to defeat the
          // xl:flex above. Otherwise it'd create an implicit third
          // grid track and shove the main pane out of view.
          isContentMode ? 'hidden xl:hidden' : ''
        } ${
          // Mobile visibility: hidden when a channel is open OR we're in
          // a DM-aux view (friends/saved/scheduled/events show their
          // view in main on mobile), flex (full-width) otherwise. xl:
          // overrides force the desktop behavior regardless.
          activeChannelId || isDmAuxMode ? 'hidden' : 'flex w-full'
        }`}
        style={{ borderRightColor: 'var(--zk-line-soft)' }}
      >
        {isDmLayout ? (
          <DMList activeChannelId={activeChannelId} />
        ) : (
          <ChannelList
            guild={activeGuild}
            channels={activeGuildChannels}
            activeChannelId={activeChannelId}
            onOpenMembers={() => setMembersOpen(true)}
          />
        )}
        <VoicePanel activeChannelId={activeChannelId} />
      </aside>

      <main
        className={`bg-bg-1/90 h-full overflow-hidden flex-col flex-1 min-w-0 relative xl:flex ${
          // Mobile: shown when a channel is selected OR we're in a
          // content mode that doesn't use a channel-list column at all
          // (discover, admin, mentions, settings, create-server,
          // join-server, invite). Hidden otherwise — that's when the
          // channel-list pane is taking the right column.
          (activeChannelId || isContentMode || isDmAuxMode) ? 'flex' : 'hidden'
        }`}
      >
        {/* Mobile back button. Shown for a conversation (back to the
            channel/DM list) and for the Invite page (a centered card with
            no header of its own) — back to the DM hub. Every other content
            view (Discover/Mentions/Settings/Admin/Family/Create/Join) and
            the DM-aux views (Friends/Saved/Scheduled/Events) render their
            own back button inside their header — and so do threads (a
            back-to-forum arrow) — so they're excluded here to avoid a
            double button. `xl:hidden` keeps this mobile-only. */}
        {((activeChannelId && activeChannel?.type !== 'public_thread') || isInviteMode) && (
          <div className="xl:hidden absolute top-0 left-2 h-12 z-20 flex items-center gap-1">
            <button
              onClick={() =>
                activeChannelId
                  ? nav(isDmMode ? `/channels/${ME}` : `/channels/${activeGuildId}`)
                  : nav(`/channels/${ME}`)
              }
              className="-ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
              aria-label="Back"
            >
              <ChevronLeft size={20} />
            </button>
          </div>
        )}
        {/* Members toggle — ONLY for voice/stage views, whose headers don't
            host their own members button. Text channels and threads render an
            inline members button in the MessageView header (search · pin ·
            members), so the floating one is excluded there to avoid a
            duplicate that overlapped the header's right-aligned buttons. */}
        {!isDmMode && !isContentMode && activeGuildId &&
          (activeChannel?.type === 'guild_voice' || activeChannel?.type === 'guild_stage') && (
          <div className="xl:hidden absolute top-0 right-2 h-12 z-20 flex items-center gap-1">
            <button
              onClick={() => setMembersOpen(true)}
              className="-mr-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
              aria-label="Open members"
            >
              <UsersIcon size={18} />
            </button>
          </div>
        )}

        {activeChannel ? (
          // Wrap in an ErrorBoundary so a crash in MessageView/VoiceView
          // doesn't tear down the Shell chrome (sidebars, server list,
          // member list). The user can navigate to a different channel
          // and recover, instead of staring at a fully-grey screen.
          // Keyed by channel id so swapping channels resets the error
          // — a transient render bug doesn't lock the user out of
          // OTHER channels just because the bad one was visited.
          <ErrorBoundary key={activeChannel.id}>
            {(() => {
              // Active-DM-call branch: when the channel is a DM and
              // BOTH the current user and at least one other recipient
              // are in voice in this channel, render the full VoiceView
              // arena instead of MessageView. Ringing-in/out (only one
              // party in voice) stays on MessageView where DmCallBar
              // handles the call-in-progress strip.
              const isDm =
                activeChannel.type === 'dm' || activeChannel.type === 'group_dm';
              if (isDm && user) {
                const callStates = voiceStatesForChannel(voiceStatesByUser, activeChannel.id);
                const myVoice = selfVoiceState(voiceStatesByUser, user.id);
                const myInThis = myVoice?.channelId === activeChannel.id;
                const otherInThis = callStates.some((v) => v.userId !== user.id);
                if (myInThis && otherInThis) {
                  // Resolve display title for the call header. 1-on-1
                  // DMs use the recipient's display name; group DMs use
                  // the channel's saved name if set, otherwise a
                  // comma-joined list of recipient names.
                  const recipients = activeChannel.recipients ?? [];
                  const dmTitle =
                    activeChannel.type === 'dm'
                      ? (recipients[0]?.displayName ??
                          recipients[0]?.username ??
                          'Direct call')
                      : (activeChannel.name ??
                          (recipients
                            .map((r) => r.displayName ?? r.username)
                            .filter(Boolean)
                            .join(', ') ||
                            'Group call'));
                  // For 1:1 DM active calls, render a SPLIT layout so
                  // the participants can chat while talking. Voice
                  // arena takes the top 60%, message thread takes the
                  // bottom 40%. Group DM calls fall through to the
                  // historical full-bleed VoiceView treatment.
                  if (activeChannel.type === 'dm') {
                    // Chat-collapse state: lets the user toggle the
                    // bottom MessageView half open/closed during a
                    // 1:1 DM call, so the voice arena can take the
                    // full height when they're just talking (no
                    // typing). Per user direction:
                    //   "there should be a directional arrow to hide
                    //    the text chat and expand it to half view."
                    // Default is "expanded" — starting a call usually
                    // means wanting to see both surfaces.
                    return (
                      <DmCallSplit
                        channel={activeChannel}
                        dmTitle={dmTitle}
                        jumpToMessageId={params.messageId}
                      />
                    );
                  }
                  return (
                    <Suspense fallback={lazyFallback}>
                      <VoiceView channel={activeChannel} displayName={dmTitle} />
                    </Suspense>
                  );
                }
              }
              if (activeChannel.type === 'guild_voice') {
                return (
                  <Suspense fallback={lazyFallback}>
                    <VoiceView channel={activeChannel} />
                  </Suspense>
                );
              }
              if (activeChannel.type === 'guild_stage') {
                return <StageChannelView channel={activeChannel} />;
              }
              if (activeChannel.type === 'guild_forum') {
                return <ForumView channel={activeChannel} />;
              }
              return (
                <MessageView
                  channel={activeChannel}
                  jumpToMessageId={params.messageId}
                  onOpenMembers={() => setMembersOpen(true)}
                />
              );
            })()}
          </ErrorBoundary>
        ) : isAdminMode ? (
          <ErrorBoundary key="admin">
            <Suspense fallback={lazyFallback}>
              <AdminPanel />
            </Suspense>
          </ErrorBoundary>
        ) : isDiscoverMode ? (
          <ErrorBoundary key="discover">
            <DiscoveryView />
          </ErrorBoundary>
        ) : isMentionsMode ? (
          <ErrorBoundary key="mentions">
            <MentionsView />
          </ErrorBoundary>
        ) : isSettingsMode ? (
          <ErrorBoundary key="settings">
            <Suspense fallback={lazyFallback}>
              <SettingsView />
            </Suspense>
          </ErrorBoundary>
        ) : isFamilyMode ? (
          <ErrorBoundary key="family">
            <Suspense fallback={lazyFallback}>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-6">
                  <FamilySettings />
                </div>
              </div>
            </Suspense>
          </ErrorBoundary>
        ) : isCreateServerMode ? (
          <ErrorBoundary key="create-server">
            <CreateServerView />
          </ErrorBoundary>
        ) : isJoinServerMode ? (
          <ErrorBoundary key="join-server">
            <JoinServerView />
          </ErrorBoundary>
        ) : isInviteMode ? (
          <ErrorBoundary key="invite">
            <InvitePage />
          </ErrorBoundary>
        ) : isFriendsMode ? (
          // Dedicated /friends route. Same view as the /channels/@me
          // landing renders below, but as its own URL it gets to live
          // in the main pane on mobile (where /channels/@me would
          // only show the DM list). The Friends button in DMList
          // navigates here.
          <ErrorBoundary key="friends">
            <FriendsView />
          </ErrorBoundary>
        ) : isSavedMode ? (
          // /saved is the standalone bookmarks page — reached from
          // the DMList nav entry. Lives in main pane on mobile so
          // it's actually visible (the no-active-channel state on
          // /channels/@me hides main on mobile).
          <ErrorBoundary key="saved">
            <SavedView />
          </ErrorBoundary>
        ) : isScheduledMode ? (
          // /scheduled — pending future-send messages. Same content-
          // mode placement as Saved + Friends. The view auto-refreshes
          // every 30s while open so fired messages drop off the list
          // without manual reload.
          <ErrorBoundary key="scheduled">
            <ScheduledMessagesView />
          </ErrorBoundary>
        ) : isEventsMode ? (
          // /events — cross-guild "your events" dashboard, rendered
          // inline in the main pane (DM sidebar stays visible).
          <ErrorBoundary key="events">
            <MyEventsModal
              inline
              onClose={() => nav(`/channels/${ME}`)}
              onOpenGuild={(guildId) => nav(`/channels/${guildId}`)}
            />
          </ErrorBoundary>
        ) : isDmMode ? (
          // DM mode landing — render the friends panel rather than a
          // blank empty state. This is where users discover/manage
          // their relationship graph (Discord parity).
          <FriendsView />
        ) : (
          <EmptyState
            title={
              activeGuild ? 'No channel selected' : "You're not in any servers yet"
            }
            subtitle={
              activeGuild
                ? 'Pick a channel from the list, or create one.'
                : 'Use an invite link to join one, or create your own from the left rail.'
            }
          />
        )}
      </main>

      {/* ── Right rail: member list ────────────────────────────────────
          Visible inline on xl+ in guild mode. On lg and below it slides
          in from the right with the same drawer pattern. Hidden in DM
          mode — DMs don't have a member list. Skipped in all content
          modes too — there's no guild, so the list would render empty
          and the grid would still reserve a column for it. The grid
          template above already drops col 4 in those modes; this
          gates the wrapper to match. */}
      {!isDmMode && !isContentMode && activeChannel?.type !== 'guild_forum' && (
        <div
          className={`xl:contents ${
            membersOpen
              ? 'fixed inset-0 z-30 flex justify-end pointer-events-auto'
              : 'fixed inset-0 z-30 flex justify-end pointer-events-none xl:pointer-events-auto'
          }`}
        >
          <div
            className={`absolute inset-0 bg-black/50 transition-opacity xl:hidden ${
              membersOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            onClick={() => setMembersOpen(false)}
          />
          <div
            className={`relative xl:static h-full shrink-0 w-[86vw] max-w-[340px] xl:w-auto xl:max-w-none transition-transform xl:transition-none xl:translate-x-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] xl:pt-0 xl:pb-0 ${
              membersOpen ? 'translate-x-0' : 'translate-x-full xl:translate-x-0'
            }`}
          >
            <MemberList
              guildId={activeGuildId}
              onClose={() => setMembersOpen(false)}
            />
          </div>
        </div>
      )}

      <QuickSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
      {/* Onboarding gate. Shown when the user is viewing a guild and
          their membership state in that guild is 'pending'. The modal
          self-gates (renders null when not needed) so we can mount it
          unconditionally on any active-guild path without the parent
          knowing the onboarding state. */}
      {activeGuild && <OnboardingModal guild={activeGuild} />}
    </div>
    </>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center p-8">
      <div className="text-lg font-medium">{title}</div>
      <div className="text-ink-2 mt-2 max-w-sm">{subtitle}</div>
    </div>
  );
}

function FullPageLoader() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-ink-2">
      {/* Logo above the spinner text. The hydration window is brief
          (usually sub-second) but it's the first thing users see after
          opening the app or refreshing — a logo gives the splash a
          recognizable identity instead of a bare "Loading…" line. */}
      <ZekktrisMark size={48} className="w-12 h-12 opacity-80" />
      <span className="animate-pulse text-sm">Loading…</span>
    </div>
  );
}

/**
 * DmCallSplit
 * -----------
 * The split-screen layout used during a 1:1 DM call. Voice arena on
 * top (default flex-[3]), MessageView on bottom (default flex-[2]),
 * with a divider between them carrying a chevron toggle.
 *
 * The toggle collapses the chat half so the voice arena gets the
 * full viewport — useful when the conversation is purely voice and
 * the chat column is just stealing vertical space. Clicking again
 * restores the split. State lives here (not Shell or VoiceView)
 * because both halves are mounted from this component and need to
 * coordinate.
 *
 * No persistence — every new call starts expanded, since starting a
 * call usually means wanting to see both surfaces. Surviving across
 * calls would mean users wonder why the chat is missing for no
 * apparent reason after a previous call where they had collapsed it.
 */
function DmCallSplit({
  channel,
  dmTitle,
  jumpToMessageId,
}: {
  channel: Channel;
  dmTitle: string;
  jumpToMessageId?: string;
}) {
  const [chatCollapsed, setChatCollapsed] = useState(false);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Voice arena. When chat is collapsed, this takes 100% height
          minus the toggle row. When expanded, it takes the 3:2 share
          of the remaining (post-toggle-row) space. The wrapper is
          position:relative so VoiceView's absolutely-positioned
          controls bar (mute / deafen / camera / screen / leave)
          anchors to the bottom of THIS section, not the outer
          container — which would otherwise place it over the toggle
          row or the chat composer. */}
      <div className={`${chatCollapsed ? 'flex-1' : 'flex-[3]'} min-h-0 flex flex-col relative`}>
        <Suspense fallback={lazyFallback}>
          <VoiceView channel={channel} displayName={dmTitle} />
        </Suspense>
      </div>
      {/* Toggle row. Sits BELOW the voice section in flex order, so
          it's visually beneath the voice nav bar (mic / headphones /
          camera / screen / volume / Leave) that lives at the bottom
          of the voice section. The row itself is just a centering
          shim with no visual treatment of its own — the pill button
          inside carries the chrome. Negative top margin pulls the
          row up by ~1rem (matching the nav bar's intrinsic
          bottom-offset) so the pill sits close beneath the nav bar
          rather than separated by an empty gap. */}
      <div className="shrink-0 flex justify-center py-1 -mt-4 relative z-10">
        <button
          type="button"
          onClick={() => setChatCollapsed((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-bg-2 hover:bg-bg-3 border border-line text-xs text-ink-2 transition-colors shadow-sm"
          aria-label={chatCollapsed ? 'Show chat' : 'Hide chat'}
          title={chatCollapsed ? 'Show chat' : 'Hide chat'}
        >
          {chatCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          <span>{chatCollapsed ? 'Show chat' : 'Hide chat'}</span>
        </button>
      </div>
      {/* Chat half. Conditionally rendered — when collapsed we
          remove it from the tree entirely so the voice arena can
          claim the full flex column without a hidden empty <div>
          consuming gap or border space. */}
      {!chatCollapsed && (
        <div className="flex-[2] min-h-0 border-t border-line flex flex-col">
          <MessageView channel={channel} jumpToMessageId={jumpToMessageId} />
        </div>
      )}
    </div>
  );
}
