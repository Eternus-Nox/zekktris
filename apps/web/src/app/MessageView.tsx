/**
 * MessageView
 * -----------
 * Right column: header → message list → composer.
 *
 * Auto-scroll behavior: if the user is "pinned to bottom" (within 24px of
 * the scroll bottom when new content arrives), we keep them pinned. If
 * they've scrolled up to read history, we DON'T yank them down on new
 * messages — that's an anti-pattern. We just keep their position stable.
 *
 * Sending: optimistic UI is deliberately NOT used for v1. The REST round
 * trip is fast enough on local-network deployments and skipping optimism
 * means we never have to reconcile "the optimistic id vs the real id"
 * when MESSAGE_CREATE arrives via gateway. (Trade: very slight perceived
 * latency on send.)
 */

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hasLocalKey, subscribeToKeyChanges, getKeyVersion } from '../lib/e2ee';
import { ensurePurgeProofRegistered } from '../lib/e2eePurgeProof';
import type { Channel, Message, PokeHistoryEntry, PublicUser } from '@zekktris/client';
import { ApiError } from '@zekktris/client';
import { POKE_TYPES, POKE_VARIANTS, type PokeType } from '../lib/poke';
import { e2eeSupported, E2EE_INSECURE_MESSAGE } from '../lib/e2eeSupport';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector, useDmNickname, voiceStatesForChannel, dmE2eeSuppressed } from '../state/AppState';
import { useTypingPing, useTypingUsers } from '../state/Typing';
import { useToasts } from '../state/Toasts';
import { MessageItem, replyPreviewText } from './MessageItem';
import { PinPanel } from './PinPanel';
import { SearchPanel } from './SearchPanel';
import { useNavigate } from 'react-router-dom';
import { Hash, Paperclip, Camera, Pin, Search, CornerUpLeft, X, MessageSquare, Smile, BarChart, StickerSquare, Mic, Trash, Settings as SettingsIcon, Phone, PhoneOff, Archive, ArrowDown, ArrowUp, Calendar, ChevronDown, ChevronLeft, ChevronRight, CheckCircle, Lock, Users as UsersIcon } from '../lib/icons';
import { SchedulePickerModal } from './SchedulePickerModal';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { DmStreakPill } from './DMList';
// Lazy-loaded: the DM settings/privacy panel only mounts when opened.
const DmSettingsPanel = lazy(() =>
  import('./DmSettingsPanel').then((m) => ({ default: m.DmSettingsPanel })),
);
// Lazy-loaded: the shared-media gallery (full-screen, body-portaled) only
// mounts when opened. Hosted here — NOT inside DmSettingsPanel — because a
// body-portaled child of the panel trips the panel's outside-click handler.
const MediaGalleryModal = lazy(() =>
  import('./MediaGalleryModal').then((m) => ({ default: m.MediaGalleryModal })),
);
import { connectToVoice, disconnectVoice, VoiceError, prepareVoiceAudio, claimVoiceChannel, releaseVoiceChannel } from '../lib/voice';
import { PollComposerModal, type PollDraft } from './PollComposerModal';
import { StickerPicker } from './StickerPicker';
import { useVoiceRecorder } from '../lib/useVoiceRecorder';
import { compressImage } from '../lib/compressImage';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { EmojiPicker } from './EmojiPicker';
import { useMentionAutocomplete } from '../lib/useMentionAutocomplete';
import { useEmojiAutocomplete } from '../lib/useEmojiAutocomplete';
import { ErrorBoundary } from '../lib/ErrorBoundary';
import { computeMemberGuildPerms, hasBit, threadToggleErrorMessage } from '../lib/permissions';
import { useProfileCard } from '../lib/useProfileCard';

// Threshold for "auto-follow the bottom on new messages." If the user
// is within this many pixels of the bottom when a new message arrives,
// we scroll them down to it. Larger value = more aggressive auto-scroll
// (small accidental scrolls still get pulled to new messages); smaller =
// stricter (must be literally at the bottom). 200px is ~one message of
// slack, which matches the common chat UX: a casual scroll-up doesn't
// strand you out of the live conversation, but a deliberate scrollback
// of more than a screen-worth does.
const PIN_THRESHOLD_PX = 200;

export function MessageView({
  channel,
  jumpToMessageId,
  onOpenMembers,
}: {
  channel: Channel;
  /** When supplied, MessageView loads a window of messages centered
      on this id (if not already in state) and scrolls to it with a
      brief highlight flash. Driven by the `/channels/G/C/M` route
      shape — used for message-link jumping. */
  jumpToMessageId?: string;
  /** Opens the member list (mobile drawer). Renders an inline members
      button in the header for guild channels, so the order reads
      search · pin · members. Desktop shows the member column instead,
      so the button is mobile-only (xl:hidden). */
  onOpenMembers?: () => void;
}) {
  // Granular subscriptions (was `useAppState()`): the channel container now
  // re-renders only when a slice it actually reads changes, not on every
  // dispatch (typing/presence/voice in unrelated channels). `messages` and
  // `loaded` are selected as per-channel slices so a message landing in a
  // BACKGROUND channel doesn't re-render the open conversation.
  const loadMessages = useAppStateSelector((v) => v.loadMessages);
  const loadMessagesAround = useAppStateSelector((v) => v.loadMessagesAround);
  const reconcileChannel = useAppStateSelector((v) => v.reconcileChannel);
  const refreshChannelLatest = useAppStateSelector((v) => v.refreshChannelLatest);
  const ackChannel = useAppStateSelector((v) => v.ackChannel);
  const clearPokePill = useAppStateSelector((v) => v.clearPokePill);
  const sendMessageOptimistic = useAppStateSelector((v) => v.sendMessageOptimistic);
  const messages = useAppStateSelector((v) => v.state.messagesByChannel[channel.id]);
  const loaded = useAppStateSelector((v) => v.state.loadedChannels.has(channel.id));
  const readStateByChannel = useAppStateSelector((v) => v.state.readStateByChannel);
  const channelsByGuild = useAppStateSelector((v) => v.state.channelsByGuild);
  const membersByGuild = useAppStateSelector((v) => v.state.membersByGuild);
  const guildsById = useAppStateSelector((v) => v.state.guildsById);
  const rolesByGuild = useAppStateSelector((v) => v.state.rolesByGuild);
  const supervision = useAppStateSelector((v) => v.state.supervision);
  // Opening the conversation answers the poke. Not folded into the ack: a poke
  // creates no message, so a DM with nothing unread never acks and the pill
  // would stay on the row for good.
  useEffect(() => {
    clearPokePill(channel.id);
  }, [channel.id, clearPokePill]);

  const nav = useNavigate();
  const { user, rest } = useAuth();
  const toasts = useToasts();

  // Load messages whenever we land on a channel that hasn't been loaded.
  // When a jumpToMessageId is present we load the around-window so the
  // target is in state before the scroll-into-view effect fires. If
  // the around-window comes back empty (deleted message, no access to
  // this specific channel slice, or the id simply doesn't exist), fall
  // back to a normal load so the user lands on the channel's recent
  // messages rather than an empty pane. A toast tells them what
  // happened — failing silently looks broken.
  // One-shot guard so the load below fires AT MOST once per jumpId
  // per channel session. Without this, the effect re-runs whenever
  // `loaded` flips (immediately after our own loadMessagesAround
  // completes), and since jumpToMessageId is still in the URL it
  // would re-fire — duplicate API call, then another, etc., until
  // the user navigates away. Same guard pattern as scrolledForRef
  // below; reset on channel change in the same effect that resets
  // scrolledForRef.
  const fetchedForJumpRef = useRef<string | null>(null);
  useEffect(() => {
    if (jumpToMessageId) {
      if (fetchedForJumpRef.current === jumpToMessageId) return;
      fetchedForJumpRef.current = jumpToMessageId;
      void loadMessagesAround(channel.id, jumpToMessageId)
        .then(({ found }) => {
          if (!found) {
            toasts.push("That message isn't available — showing recent messages instead", 'info');
            return loadMessages(channel.id);
          }
          return undefined;
        })
        .catch(() => {
          // Best-effort recovery: if around itself errors, try a
          // normal load. If THAT errors too we surface nothing —
          // user can refresh.
          void loadMessages(channel.id).catch(() => undefined);
        });
      return;
    }
    if (!loaded) {
      void loadMessages(channel.id).catch(() => undefined);
    } else {
      // Already loaded this session — reconcile against the server so any
      // messages missed while this channel was closed (a missed live event,
      // a suspended socket, a resume-buffer gap) appear on re-open instead of
      // only after a full page refresh. Append-only; cheap no-op when current.
      void reconcileChannel(channel.id).catch(() => undefined);
    }
  }, [channel.id, loaded, loadMessages, loadMessagesAround, reconcileChannel, jumpToMessageId, toasts]);

  // Browsers (especially laptops) silently kill or stall a backgrounded
  // tab's WebSocket with no close event, so live MESSAGE_CREATE events stop
  // arriving while the tab is hidden. When the tab regains focus/visibility,
  // reconcile the open channel so messages that landed while we were away
  // appear immediately — instead of the user having to refresh the page.
  // Append-only + cheap (a no-op `after` fetch when already current).
  useEffect(() => {
    // Return-from-background (tab regains focus/visibility): use the BULLETPROOF
    // latest-window catch-up — the same recovery re-opening the channel does —
    // so a message that arrived while the tab was hidden can never leave the
    // open chat stale. The after-cursor reconcile can miss here (stale cursor,
    // fetch racing the socket coming back); the latest fetch shares none of
    // those failure modes. Merged (dedup by id) so scroll/history are preserved.
    const catchUpIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshChannelLatest(channel.id).catch(() => undefined);
      }
    };
    // The frequent while-visible poll stays on the cheap after-cursor reconcile
    // (a no-op zero-row fetch when already current).
    const reconcileIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void reconcileChannel(channel.id).catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', catchUpIfVisible);
    window.addEventListener('focus', catchUpIfVisible);
    // Near-live convergence for the OPEN conversation. The live gateway push
    // is the fast path, but it can silently fail to deliver (a half-dead
    // socket, a reverse proxy that isn't upgrading the WebSocket, a missed
    // frame) — and when it does, the ONLY thing that makes an incoming message
    // appear is this reconcile. Poll every 3s while the tab is visible so a
    // message from the other person (or another of your own devices) shows up
    // within a few seconds even when the socket is dead, instead of the user
    // having to reload. Cheap: an append-only `after` fetch that returns zero
    // rows in the common (already-current) case.
    const poll = window.setInterval(reconcileIfVisible, 3_000);
    return () => {
      document.removeEventListener('visibilitychange', catchUpIfVisible);
      window.removeEventListener('focus', catchUpIfVisible);
      window.clearInterval(poll);
    };
  }, [channel.id, reconcileChannel, refreshChannelLatest]);

  // Scroll-into-view + flash highlight for the jump target. We wait
  // for the message to appear in state (load above) then in the DOM
  // (next paint after the messages render). A small RAF chain handles
  // the timing — querySelector right after dispatch wouldn't find the
  // element because React hasn't committed the layout yet.
  //
  // One-shot guard via `scrolledForRef`: once we successfully scroll
  // to a given message id, we stop responding to subsequent messages
  // updates. Without this guard, any new message arriving via gateway
  // would re-trigger the effect (because the deps changed) and yank
  // the viewport back to the original target — annoying behavior if
  // the user has scrolled away to read context.
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpToMessageId) return;
    if (scrolledForRef.current === jumpToMessageId) return;
    if (!messages?.some((m) => m.id === jumpToMessageId)) return;
    const id = jumpToMessageId;
    let cancelled = false;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const tryScroll = (): boolean => {
      const el = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('message-flash');
      flashTimer = setTimeout(() => el.classList.remove('message-flash'), 1800);
      scrolledForRef.current = id;
      return true;
    };
    let tries = 0;
    function attempt() {
      if (cancelled) return;
      if (tryScroll()) return;
      if (++tries > 30) return;
      requestAnimationFrame(attempt);
    }
    requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [jumpToMessageId, messages]);

  // Reset the one-shot guards whenever the user navigates to a new
  // channel — otherwise switching channels with the same chat open
  // would skip the scroll if both URLs happen to share the same
  // messageId fragment (unlikely but cheap to handle).
  useEffect(() => {
    scrolledForRef.current = null;
    fetchedForJumpRef.current = null;
  }, [channel.id]);

  // Auto-ack: when the channel has loaded messages and is currently open,
  // mark its most recent message as read. This fires on initial open AND
  // on every new message (since `messages` reference changes on append).
  // The reducer's monotonic guard means redundant acks at the same id are
  // harmless; a stale read marker just stays where it was.
  //
  // Trade-off: if the user is mid-scrollback when a new message arrives,
  // we still ack — Discord does the same. The simplification avoids
  // entangling the ack logic with scroll position. The user can recover
  // unread state by navigating away and back if they really care; no
  // server-side data is lost.

  // Frozen unread boundary — iOS parity (AppStore.swift unreadBoundaryId,
  // frozen in openChannel BEFORE the ack advances the read state). Captured
  // synchronously at render time on channel switch so it always wins the
  // race with the auto-ack effect below (effects run post-render). Only set
  // when the channel actually has unread messages past the stored read
  // marker — same gate as iOS — so a fully-read channel never grows a
  // divider when new messages arrive while it's open. Drives the red
  // "New messages" divider + guild-channel land-on-first-unread in Scroller.
  const unreadBoundaryRef = useRef<{ channelId: string; boundary: string | null } | null>(null);
  if (unreadBoundaryRef.current?.channelId !== channel.id) {
    const prevRead = readStateByChannel[channel.id]?.lastMessageId;
    const last = channel.lastMessageId;
    const hasUnread =
      typeof prevRead === 'string' &&
      typeof last === 'string' &&
      isNumericId(prevRead) &&
      isNumericId(last) &&
      BigInt(last) > BigInt(prevRead);
    unreadBoundaryRef.current = { channelId: channel.id, boundary: hasUnread ? prevRead : null };
  }
  const unreadBoundary = unreadBoundaryRef.current?.boundary ?? null;

  useEffect(() => {
    if (!messages || messages.length === 0) return;
    // Walk back from the tail to find the most recent message with a
    // real (server-issued) id. Optimistic placeholders carry a
    // `local-...` id that's incompatible with bigint snowflake math —
    // acking with one would crash the read-state reducer's BigInt()
    // comparison. We just skip pending rows; the gateway echo or REST
    // 201 will replace them with real ids momentarily, and this effect
    // re-runs on every messages-array identity change so we'll catch
    // it then.
    let last: typeof messages[number] | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.pending || m.failed) continue;
      // Defensive: also filter ids that aren't pure digits. Snowflakes
      // are decimal strings; anything else (UUIDs, local-prefixed,
      // empty) shouldn't reach the BigInt path either.
      if (!/^\d+$/.test(m.id)) continue;
      last = m;
      break;
    }
    if (!last) return;
    const rs = readStateByChannel[channel.id];
    if (rs?.lastMessageId === last.id) return; // already acked
    void ackChannel(channel.id, last.id);
    // We intentionally only depend on the channel id and the messages array
    // identity, not on the read-state map — the inner equality guard above
    // handles the "already acked" case without retriggering on every state
    // update elsewhere in the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, messages]);

  // For DMs the channel has no name; resolve the recipient from the
  // server-supplied `recipients` field on the channel (excludes self),
  // falling back to a message-author scan for legacy channels.
  const isDM = channel.type === 'dm' || channel.type === 'group_dm';
  const isThread = channel.type === 'public_thread';
  // Memoized: the legacy fallback path walks the messages array
  // backward to find a non-self author; we don't want that running
  // on every render (the path is rarely hit in practice, but the
  // common case still allocates an inline closure). Memo gates on
  // the inputs that could change the result.
  const dmRecipient = useMemo(() => {
    if (!isDM) return null;
    if (channel.recipients && channel.recipients.length > 0) {
      return channel.recipients[0]!;
    }
    if (!messages) return null;
    const selfId = user?.id;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.author && m.author.id && m.author.id !== selfId) return m.author;
    }
    return null;
  }, [isDM, channel.recipients, messages, user?.id]);
  // Personal DM nickname (viewer-private) overrides the peer's real name.
  const dmNick = useDmNickname(dmRecipient?.id);
  const dmDisplayName = dmNick ?? dmRecipient?.displayName;
  // Thread parent — when viewing a thread, the breadcrumb in the header
  // shows the parent channel's name and lets the user navigate back. We
  // resolve via channelsByGuild so we don't need an extra REST call.
  const threadParent = useMemo(() => {
    if (!isThread || !channel.parentId || !channel.guildId) return null;
    const list = channelsByGuild[channel.guildId];
    return list?.find((c) => c.id === channel.parentId) ?? null;
  }, [isThread, channel.parentId, channel.guildId, channelsByGuild]);

  // ── Thread lifecycle state ─────────────────────────────────────────────
  //
  // threadArchived: true when the thread has a non-null threadArchivedAt.
  // The composer gates rendering on this — archived threads are
  // read-only at the server (POST messages rejects with 403) and the
  // UI mirrors that by hiding the composer + showing an archived
  // banner with an Unarchive CTA.
  //
  // canManageThread: true when the user has MANAGE_THREADS from their
  // guild roles (admin / mod), OR when they appear to be the thread's
  // creator (heuristic via the first message in the thread — for
  // forum posts the first message IS the post body; the author is
  // by definition the creator). For message-rooted threads the
  // first message might be the creator's first reply rather than
  // the anchor's author, but the heuristic is conservative — false
  // positives just show a button that the server 403s, false
  // negatives hide a button the user IS entitled to. The server is
  // the source of truth either way.
  //
  // MANAGE_THREADS is a per-channel permission: the server checks it
  // against the parent channel's (and its category's) overrides. The
  // web client has no per-channel resolver, so a channel-level deny
  // still shows the buttons (the server 403s; the toast explains why)
  // and a channel-only allow hides them.
  const threadArchived = isThread && channel.threadArchivedAt != null;

  const myMember = useMemo(() => {
    if (!channel.guildId || !user) return null;
    return (
      membersByGuild[channel.guildId]?.find((m) => m.userId === user.id) ?? null
    );
  }, [channel.guildId, user, membersByGuild]);

  const canManageThread = useMemo(() => {
    if (!isThread || !channel.guildId || !user || !myMember) return false;
    const guild = guildsById[channel.guildId];
    if (!guild) return false;
    // MANAGE_THREADS from guild roles (channel overrides not applied).
    const roles = rolesByGuild[channel.guildId] ?? [];
    const isOwner = guild.ownerId === user.id;
    const perms = computeMemberGuildPerms(roles, channel.guildId, myMember.roleIds, isOwner);
    if (hasBit(perms, 33 /* MANAGE_THREADS */)) return true;
    // Creator heuristic via the first message in the thread.
    const list = messages;
    if (!list || list.length === 0) return false;
    // First message by snowflake order. The messages list is kept
    // sorted ascending by id (see Scroller), so [0] is the oldest.
    return list[0]?.authorId === user.id;
  }, [
    isThread,
    channel.guildId,
    channel.id,
    user,
    myMember,
    guildsById,
    rolesByGuild,
    messages,
  ]);

  // Deleting a thread is DELETE /channels/:id, which needs MANAGE_CHANNELS on
  // the thread's channel (MANAGE_THREADS or being the creator isn't enough),
  // so the Delete button follows that bit — guild-level, like the others.
  const canDeleteThread = useMemo(() => {
    if (!isThread || !channel.guildId || !user || !myMember) return false;
    const guild = guildsById[channel.guildId];
    if (!guild) return false;
    const roles = rolesByGuild[channel.guildId] ?? [];
    const perms = computeMemberGuildPerms(
      roles,
      channel.guildId,
      myMember.roleIds,
      guild.ownerId === user.id,
    );
    return hasBit(perms, 10 /* MANAGE_CHANNELS */);
  }, [isThread, channel.guildId, user, myMember, guildsById, rolesByGuild]);

  // Whether to offer @everyone / @here in the mention autocomplete. Guild
  // channels only, and only when the caller actually has MENTION_EVERYONE
  // (owner/ADMINISTRATOR short-circuit to all-bits inside the compute), so we
  // never suggest a mention the server would 403. Guild-level perms — a
  // per-channel overwrite granting it in an otherwise-denied channel isn't
  // reflected, but the server stays the final authority either way.
  const canMentionEveryone = useMemo(() => {
    if (!channel.guildId || !user || !myMember) return false;
    const guild = guildsById[channel.guildId];
    if (!guild) return false;
    const roles = rolesByGuild[channel.guildId] ?? [];
    const perms = computeMemberGuildPerms(
      roles,
      channel.guildId,
      myMember.roleIds,
      guild.ownerId === user.id,
    );
    return hasBit(perms, 9 /* MENTION_EVERYONE */);
  }, [channel.guildId, user, myMember, guildsById, rolesByGuild]);

  const headerLabel = isDM
    ? (dmDisplayName ?? channel.name ?? 'Direct message')
    : (channel.name ?? '(unnamed)');
  // Presence dot color for the DM header avatar (same mapping as DMList).
  const dmStatus = dmRecipient?.status ?? 'offline';
  const dmStatusDot =
    dmStatus === 'online'
      ? 'bg-emerald-500'
      : dmStatus === 'idle'
        ? 'bg-amber-500'
        : dmStatus === 'dnd'
          ? 'bg-red-500'
          : 'bg-ink-3';
  const composerPlaceholder = isDM
    ? `Message ${dmDisplayName ?? 'this conversation'}`
    : isThread
      ? `Message thread`
      : `Message #${channel.name ?? ''}`;

  // Reply state: the message currently being replied to. Null when no reply
  // is in progress. Set from the per-message Reply action; cleared on send
  // or via the cancel button on the composer's reply chip.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // Stable callback for the per-message Reply action. Every visible
  // MessageItem receives this prop; without useCallback the inline
  // arrow would be a fresh function reference on every render of
  // this component, defeating React.memo on MessageItem. setReplyTo
  // (from useState) is itself stable across renders, so this useCallback
  // never re-creates — its identity is fixed for the lifetime of the
  // component instance. (When MessageView re-mounts on channel switch
  // the new instance gets its own stable identity.)
  const onReply = useCallback((m: Message) => setReplyTo(m), []);

  // One-shot reply prefill for guild-channel message deep-links (iOS
  // parity: a notification tap both scrolls to the target message AND
  // puts the composer into reply mode targeting it — guild channels
  // only; DMs get scroll-only). Keyed per jump id so a new message
  // arriving later doesn't re-trigger, and reset on channel switch so
  // revisiting the same link works again.
  const replyPrefillForRef = useRef<string | null>(null);
  useEffect(() => {
    replyPrefillForRef.current = null;
  }, [channel.id]);
  useEffect(() => {
    if (!jumpToMessageId || isDM) return;
    if (replyPrefillForRef.current === jumpToMessageId) return;
    const target = messages?.find((m) => m.id === jumpToMessageId);
    if (!target) return;
    replyPrefillForRef.current = jumpToMessageId;
    setReplyTo(target);
  }, [jumpToMessageId, isDM, messages]);

  // ── Jump-to-newest chevron ──────────────────────────────────────────────
  // "The user has scrolled away from the newest message." Owned HERE rather
  // than inside Scroller because the chevron is anchored 2px above the
  // composer — Scroller's *sibling*. Nothing inside the scroll area can hit
  // that mark: a permanent 20px typing strip plus the timeout / locked-E2EE
  // banners sit between the two, and their combined height varies.
  // Scroller publishes this from the SAME PIN_THRESHOLD_PX measurement that
  // gates auto-follow and the "New messages" pill, so the two affordances
  // can never disagree about where "the bottom" is.
  const [scrolledUp, setScrolledUp] = useState(false);
  // Stable identity so Scroller's prop doesn't change every render.
  const onScrolledUpChange = useCallback((v: boolean) => setScrolledUp(v), []);
  // Imperative handle to Scroller's scrollToBottom(). A ref, not a state
  // callback: publishing it must never re-render this (large) view.
  const jumpToNewestRef = useRef<(() => void) | null>(null);

  const isDM1to1 = channel.type === 'dm';
  // Auxiliary panel — pin list and search take up the same overlay slot
  // (the right-hand overlay above the message stream); they're mutually
  // exclusive. `null` collapses both. Search keeps its query string here
  // too so re-opening doesn't lose state mid-session.
  const [overlay, setOverlay] = useState<'pins' | 'search' | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // ── DM auto-delete settings panel ───────────────────────────────────────
  // Only relevant for 1:1 DMs in v1. Group DMs (channel.type ===
  // 'group_dm') don't expose this affordance yet — the "first viewer
  // among any recipient" semantic gets weird with 3+ people, so we
  // hold off until we have a clearer mental model. The cog button is
  // hidden in that case via the isDM1to1 gate below.
  const [dmSettingsOpen, setDmSettingsOpen] = useState(false);
  // Shared-media gallery visibility. Hosted at the MessageView level (a
  // stable parent) so the full-screen, body-portaled modal isn't a child of
  // the click-outside-trapped DmSettingsPanel.
  const [mediaGalleryOpen, setMediaGalleryOpen] = useState(false);
  // Reactive E2EE key availability so the locked-DM banner appears/disappears
  // live the moment the conversation is unlocked (mirrors MessageItem).
  const keyVersion = useSyncExternalStore(subscribeToKeyChanges, getKeyVersion, getKeyVersion);
  // A DM encrypted before purge proofs existed (or by an older client) has
  // none on the server; register ours as soon as this device holds the key.
  useEffect(() => {
    void ensurePurgeProofRegistered(rest, channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rest, channel.id, channel.e2eeEnabled, channel.e2eeVerifier, channel.e2eePurgeProofSet, keyVersion]);
  // Ref to the cog button so the DmSettingsPanel's click-outside
  // listener can ignore clicks on the toggle itself. Without this,
  // clicking the cog while the panel is open fires the panel's
  // mousedown listener (closes), then the button's onClick toggles
  // (reopens) — net effect: panel never closes.
  const dmSettingsToggleRef = useRef<HTMLButtonElement | null>(null);

  // ── Thread archive/unarchive state ─────────────────────────────────────
  // Single busy flag for both directions (the button is only visible for
  // one direction at a time based on threadArchived). Server broadcasts
  // CHANNEL_UPDATE which updates channel.threadArchivedAt in AppState; we
  // don't apply optimistic local state since the round-trip is fast.
  const [archiveBusy, setArchiveBusy] = useState(false);

  async function handleArchiveToggle() {
    if (archiveBusy || !isThread) return;
    setArchiveBusy(true);
    try {
      if (threadArchived) {
        await rest.unarchiveThread(channel.id);
        toasts.push('Thread unarchived', 'success');
      } else {
        await rest.archiveThread(channel.id);
        toasts.push('Thread archived', 'info');
      }
    } catch (e) {
      toasts.push(threadToggleErrorMessage(e, 'Could not change archive state'), 'error');
    } finally {
      setArchiveBusy(false);
    }
  }

  // ── Thread resolved state ──────────────────────────────────────────────
  // Mirror of the archive flow. Calls rest.resolveThread /
  // unresolveThread; the gateway dispatches CHANNEL_UPDATE which
  // patches channel.threadResolvedAt in AppState so the UI flips.
  const threadResolved = isThread && channel.threadResolvedAt != null;
  const [resolveBusy, setResolveBusy] = useState(false);

  async function handleResolveToggle() {
    if (resolveBusy || !isThread) return;
    setResolveBusy(true);
    try {
      if (threadResolved) {
        await rest.unresolveThread(channel.id);
        toasts.push('Marked as unresolved', 'info');
      } else {
        await rest.resolveThread(channel.id);
        toasts.push('Marked as resolved', 'success');
      }
    } catch (e) {
      toasts.push(threadToggleErrorMessage(e, 'Could not change resolved state'), 'error');
    } finally {
      setResolveBusy(false);
    }
  }

  // ── Thread delete ──────────────────────────────────────────────────────
  // Hard-delete is irreversible (unlike archive) so it's behind a
  // confirm() prompt. After server confirms, we navigate back to the
  // parent forum since the user's current page is about to be a 404.
  // The CHANNEL_DELETE broadcast removes the channel from AppState in
  // the same tick — by the time the navigate runs, the destination
  // already has the post gone from the list.
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function handleDeleteThread() {
    if (deleteBusy || !isThread) return;
    const label = channel.name ?? 'this thread';
    if (
      !confirm(
        `Delete "${label}"?\n\nAll messages will be permanently removed. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleteBusy(true);
    try {
      await rest.deleteChannel(channel.id);
      toasts.push('Thread deleted', 'info');
      // Navigate back to the parent forum (or to the guild root if
      // somehow the parent is missing). The CHANNEL_DELETE broadcast
      // updates AppState in parallel.
      if (channel.parentId && channel.guildId) {
        nav(`/channels/${channel.guildId}/${channel.parentId}`);
      } else if (channel.guildId) {
        nav(`/channels/${channel.guildId}`);
      }
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Could not delete thread',
        'error',
      );
      setDeleteBusy(false);
    }
    // No finally — on success we navigate away, so resetting state on
    // an unmounted component would warn. The catch branch resets.
  }

  return (
    <>
      <header
        className={`px-4 h-12 border-b flex items-center gap-2 relative ${isThread ? '' : 'pl-12 xl:pl-4'}`}
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        {/* Header icon / back button. For threads we render an explicit
            back-arrow button that navigates to the parent forum/channel
            — the existing breadcrumb in the title only shows on sm+ so
            mobile users had no way back. For non-thread channels we
            render the type-appropriate static icon in the accent color
            (matches the ForumView header for visual consistency across
            channel types). */}
        {isThread && channel.parentId && channel.guildId ? (
          <button
            type="button"
            onClick={() =>
              nav(`/channels/${channel.guildId}/${channel.parentId}`)
            }
            className="shrink-0 w-10 h-10 -ml-1 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 transition-colors"
            aria-label="Back to forum"
            title="Back to forum"
          >
            <ChevronLeft size={20} />
          </button>
        ) : isDM ? (
          // Recipient avatar with presence dot + conditional E2EE lock
          // corner badge (iOS parity: MessageViews.swift DM header shows a
          // 28pt Avatar with status, lock.fill badge pinned top-trailing
          // when the conversation is E2EE). Same markup as the DM-list row.
          <span className="relative w-7 h-7 shrink-0">
            <span
              className={`absolute inset-0 rounded-full text-[11px] flex items-center justify-center font-medium ${avatarColor(dmRecipient?.id ?? channel.id)}`}
            >
              {avatarInitials(headerLabel) || '?'}
            </span>
            <AvatarImage src={dmRecipient?.avatarUrl} />
            <span
              aria-hidden
              className={`absolute bottom-0 right-0 w-[10px] h-[10px] rounded-full border-2 border-bg-1 ${dmStatusDot}`}
            />
            {channel.e2eeEnabled && (
              // End-to-end encrypted indicator — pinned to the avatar's
              // top-right corner, exactly like the DM-list row badge (see
              // DMList.tsx for the pixel-placement rationale).
              <span
                className="absolute -top-0.5 -right-0.5 w-[13px] h-[13px] rounded-full bg-bg-2 border border-accent/45"
                title="End-to-end encrypted"
                aria-label="End-to-end encrypted"
              >
                <Lock size={8} className="absolute left-[2px] top-[1px] -translate-x-[0.5px] text-accent" />
              </span>
            )}
          </span>
        ) : isThread ? (
          <MessageSquare size={18} className="text-accent shrink-0" />
        ) : (
          <Hash size={18} className="text-accent shrink-0" />
        )}
        {/* Thread breadcrumb: shows "in #parent-channel" with a clickable
            link back to the parent. Long thread names truncate before the
            breadcrumb so users always see "this is a thread of X". */}
        {isThread && threadParent ? (
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="font-semibold truncate">{headerLabel}</span>
            <span className="text-ink-3 text-xs shrink-0 hidden sm:inline">in</span>
            <button
              type="button"
              onClick={() => {
                if (threadParent.guildId) {
                  nav(`/channels/${threadParent.guildId}/${threadParent.id}`);
                }
              }}
              className="text-xs text-ink-3 hover:text-ink-1 hover:underline truncate shrink-0 hidden sm:flex items-center gap-0.5"
              title={`Open #${threadParent.name ?? '(channel)'}`}
            >
              <Hash size={11} />
              {threadParent.name ?? '(channel)'}
            </button>
          </div>
        ) : (
          <>
            {/* In a 1:1 DM the name is a button that opens the SAME ProfileCard
                popover every avatar in the app opens (useProfileCard). Guild
                channels and group DMs keep the plain static span — there's no
                single user behind a #channel / group name to profile. */}
            {isDM1to1 && dmRecipient ? (
              <DmHeaderName user={dmRecipient} label={headerLabel} />
            ) : (
              <span className="font-semibold truncate">{headerLabel}</span>
            )}
            {/* Messaging-streak chip right after the name (iOS parity:
                StreakChip in the DM header when streak > 0). */}
            {isDM && typeof channel.streak === 'number' && channel.streak > 0 && (
              <DmStreakPill streak={channel.streak} />
            )}
            {channel.topic && (
              <>
                <span className="text-ink-3 shrink-0 hidden sm:inline">·</span>
                <span className="text-ink-2 text-sm truncate hidden sm:inline">{channel.topic}</span>
              </>
            )}
          </>
        )}
        {/* Header actions on the right. Search is visible everywhere. The
            Pins button is hidden in DMs — pinning 403s there anyway, and
            saved (bookmarked) messages cover the "keep this" need — but
            stays in guild channels, where pins are a shared feature. */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* Search leads the action group — ahead of the DM call button and
              the channel Pins button. Hidden in E2EE DMs (iOS parity): the
              server only holds ciphertext there, so search can never match
              message content — showing a button that always returns nothing
              reads as broken. */}
          {channel.e2eeEnabled !== true && (
            <button
              type="button"
              onClick={() => setOverlay(overlay === 'search' ? null : 'search')}
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                overlay === 'search'
                  ? 'bg-bg-3 text-ink-1'
                  : 'text-ink-3 hover:text-ink-1 hover:bg-bg-3'
              }`}
              aria-label="Search messages"
              title="Search"
            >
              <Search size={16} />
            </button>
          )}
          {/* Call button shows for ALL DMs including group DMs (iOS
              parity: the phone button gates on channel.isDM which covers
              dm + group_dm; only poke is 1:1-only). The join/leave flow
              inside the button is channel-generic. */}
          {isDM && (
            <DmHeaderCallButton channel={channel} />
          )}
          {isDM1to1 && (
            <DmHeaderPokeButton channel={channel} />
          )}
          {isDM1to1 && (
            <button
              ref={dmSettingsToggleRef}
              type="button"
              onClick={() => setDmSettingsOpen((v) => !v)}
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                dmSettingsOpen
                  ? 'bg-bg-3 text-ink-1'
                  : 'text-ink-3 hover:text-ink-1 hover:bg-bg-3'
              }`}
              aria-label="DM auto-delete settings"
              title="Auto-delete settings"
              aria-expanded={dmSettingsOpen}
            >
              <SettingsIcon size={16} />
            </button>
          )}
          {isThread && canManageThread && (
            <button
              type="button"
              onClick={() => void handleResolveToggle()}
              disabled={resolveBusy}
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors disabled:opacity-50 disabled:cursor-wait ${
                threadResolved
                  ? 'text-emerald-300 hover:text-ink-1 hover:bg-bg-3 ring-1 ring-emerald-400/40'
                  : 'text-ink-3 hover:text-emerald-300 hover:bg-bg-3'
              }`}
              aria-label={threadResolved ? 'Mark as unresolved' : 'Mark as resolved'}
              title={threadResolved ? 'Resolved — click to clear' : 'Mark as resolved'}
              aria-pressed={threadResolved}
            >
              <CheckCircle size={16} />
            </button>
          )}
          {isThread && canManageThread && (
            <button
              type="button"
              onClick={() => void handleArchiveToggle()}
              disabled={archiveBusy}
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors disabled:opacity-50 disabled:cursor-wait ${
                threadArchived
                  ? 'text-accent hover:text-ink-1 hover:bg-bg-3 ring-1 ring-accent/40'
                  : 'text-ink-3 hover:text-ink-1 hover:bg-bg-3'
              }`}
              aria-label={threadArchived ? 'Unarchive thread' : 'Archive thread'}
              title={threadArchived ? 'Unarchive thread' : 'Archive thread'}
            >
              <Archive size={16} />
            </button>
          )}
          {isThread && canDeleteThread && (
            <button
              type="button"
              onClick={() => void handleDeleteThread()}
              disabled={deleteBusy}
              className="w-8 h-8 flex items-center justify-center rounded transition-colors text-ink-3 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-wait"
              aria-label="Delete thread"
              title="Delete thread"
            >
              <Trash size={16} />
            </button>
          )}
          {!isDM && (
            <button
              type="button"
              onClick={() => setOverlay(overlay === 'pins' ? null : 'pins')}
              className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                overlay === 'pins'
                  ? 'bg-bg-3 text-ink-1'
                  : 'text-ink-3 hover:text-ink-1 hover:bg-bg-3'
              }`}
              aria-label="View pinned messages"
              title="Pinned messages"
            >
              <Pin size={16} />
            </button>
          )}
          {/* Members — guild channels only (DMs have no member list).
              Mobile-only: desktop shows the always-on member column, so this
              opens the drawer on phones. Sits after Pin → search · pin ·
              members. Replaces the old floating top-right button that
              overlapped these header actions. */}
          {!isDM && (
            <button
              type="button"
              onClick={() => onOpenMembers?.()}
              className="xl:hidden w-8 h-8 flex items-center justify-center rounded transition-colors text-ink-3 hover:text-ink-1 hover:bg-bg-3"
              aria-label="Members"
              title="Members"
            >
              <UsersIcon size={16} />
            </button>
          )}
        </div>
        {isDM1to1 && dmSettingsOpen && user && (
          <Suspense fallback={null}>
            <DmSettingsPanel
              channel={channel}
              selfId={user.id}
              onClose={() => setDmSettingsOpen(false)}
              onOpenMedia={() => {
                // Close the popover so it isn't stranded behind the
                // full-screen gallery, then open the gallery (hosted below,
                // outside the panel's DOM subtree).
                setDmSettingsOpen(false);
                setMediaGalleryOpen(true);
              }}
              toggleButtonRef={dmSettingsToggleRef}
            />
          </Suspense>
        )}
        {isDM1to1 && mediaGalleryOpen && (
          <Suspense fallback={null}>
            <MediaGalleryModal
              channel={channel}
              onClose={() => setMediaGalleryOpen(false)}
            />
          </Suspense>
        )}
      </header>

      <div className="flex-1 min-h-0 flex relative">
        <div className="flex-1 min-w-0 flex flex-col">
          <Scroller
            messages={messages}
            channel={channel}
            loaded={loaded}
            selfId={user?.id}
            onReply={onReply}
            jumpToMessageId={jumpToMessageId}
            unreadBoundary={unreadBoundary}
            onScrolledUpChange={onScrolledUpChange}
            jumpToNewestRef={jumpToNewestRef}
          />

          <TypingIndicator channelId={channel.id} />

          {/* Timeout banner — proactive: shows above the composer
              while the current user is timed out in this guild. The
              send path also catches TIMED_OUT errors and toasts, but
              this banner spares the user from typing a message just
              to learn they can't send it. Guild-channel only (DMs
              have no timeout concept). The "until" timestamp is read
              from membersByGuild rather than usersById because
              timeouts are guild-scoped — the same user can be timed
              out in one guild and free in another. */}
          {(() => {
            if (!channel.guildId || !user) return null;
            const memberList = membersByGuild[channel.guildId];
            const selfMember = memberList?.find((m) => m.userId === user.id);
            const iso = selfMember?.communicationDisabledUntil;
            if (!iso) return null;
            const until = new Date(iso);
            if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) return null;
            const sameDay = until.toDateString() === new Date().toDateString();
            const friendly = sameDay
              ? until.toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : until.toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                });
            return (
              <div
                role="status"
                aria-live="polite"
                className="mx-3 mb-2 px-3 py-2 rounded-md bg-amber-950/40 border border-amber-900/60 text-amber-200 text-xs flex items-center gap-2"
              >
                <span className="font-medium">Timed out</span>
                <span className="text-amber-300/80">
                  You can send messages again at {friendly}
                </span>
              </div>
            );
          })()}

          {threadArchived ? (
            // Archived thread — composer is hidden and replaced with a
            // banner. Server enforces read-only via the POST messages
            // gate; this banner makes the state legible client-side so
            // users don't try to type and hit a 403. Managers see an
            // Unarchive CTA; non-managers see only the status.
            <div
              role="status"
              className="mx-3 mt-2 mb-5 px-4 py-3 rounded-lg border border-line bg-bg-2/60 flex items-start gap-3"
            >
              <Archive size={18} className="text-ink-3 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-1">
                  This thread is archived
                </p>
                <p className="text-xs text-ink-3 mt-0.5">
                  No new messages can be posted. Existing messages stay
                  visible and searchable.
                </p>
              </div>
              {canManageThread && (
                <button
                  type="button"
                  onClick={() => void handleArchiveToggle()}
                  disabled={archiveBusy}
                  className="shrink-0 px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-wait text-white text-xs font-medium transition-colors"
                >
                  {archiveBusy ? 'Unarchiving…' : 'Unarchive'}
                </button>
              )}
            </div>
          ) : (
            <>
            {/* Locked-E2EE banner. When a DM is encrypted but this device
                has no key, every message shows a lock tombstone and sending
                is blocked — without a visible way to unlock, a newcomer reads
                it as "my messages are gone." This gives an explicit
                [Enter password] that opens the existing unlock panel. Gate
                matches the send-gate exactly so banner-visible ⇔ send-blocked.
                keyVersion makes it disappear live on unlock. On a plain-http
                origin (no WebCrypto) a password can't help, so the banner
                says why instead. */}
            {isDM1to1 &&
              channel.e2eeEnabled === true &&
              !dmE2eeSuppressed(supervision, channel) &&
              !e2eeSupported() && (
                <div
                  role="status"
                  className="mx-3 mb-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 flex items-center gap-3"
                >
                  <Lock size={16} className="text-amber-400 shrink-0" />
                  <div className="flex-1 min-w-0 text-sm text-ink-2">{E2EE_INSECURE_MESSAGE}</div>
                </div>
              )}
            {isDM1to1 &&
              channel.e2eeEnabled === true &&
              !dmE2eeSuppressed(supervision, channel) &&
              e2eeSupported() &&
              !hasLocalKey(channel.id) &&
              (void keyVersion, true) && (
                <div
                  role="status"
                  className="mx-3 mb-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 flex items-center gap-3"
                >
                  <Lock size={16} className="text-amber-400 shrink-0" />
                  <div className="flex-1 min-w-0 text-sm">
                    <span className="text-amber-200 font-medium">This conversation is encrypted.</span>
                    <span className="text-ink-2 hidden sm:inline"> Enter the password to read and send messages.</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDmSettingsOpen(true)}
                    className="shrink-0 px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-xs sm:text-sm font-medium transition-colors"
                  >
                    Enter password
                  </button>
                </div>
              )}
            {/* Composer wrapper — exists ONLY to anchor the jump-to-newest
                chevron. `bottom-full` + `mb-[2px]` puts the button exactly
                2px above the composer's top border: in the message-list
                area, never inside the text box, never over the send button.
                The right offset lines the 44px tap target up with the send
                button's centre — the composer pads `px-4` (16) and the input
                row `px-2` (8), and the send button is `w-8`, so its centre
                sits 16+8+16 = 40px from the right edge; 40 − 22 = 18.
                Rendered conditionally rather than faded out: at the bottom
                it must be gone from the tree, not an invisible 44px square
                sitting on top of the composer eating taps. */}
            <div className="relative">
              {scrolledUp && (
                <button
                  type="button"
                  onClick={() => jumpToNewestRef.current?.()}
                  className="group absolute bottom-full right-[18px] mb-[2px] w-11 h-11 flex items-end justify-center z-20"
                  title="Jump to newest messages"
                  aria-label="Jump to newest messages"
                >
                  {/* 36px disc / 15px glyph / opaque bg-2 / 1px line border /
                      black-35% shadow at y+2 blur 6 — the one cross-platform
                      spec, taken from iOS. The fill is opaque (not `/90` with
                      a backdrop-blur) because nothing but message rows sits
                      behind it, and the blur was buying a compositing layer
                      for an effect no one could see.

                      `items-end` (not `items-center`) is load-bearing: the
                      44px box is the >=44px tap target, and centring the 36px
                      disc inside it leaves 4px of dead padding UNDER the disc.
                      Added to the 2px margin that made the visible gap 6px —
                      three times the spec — while the code still read as "2".
                      Bottom-aligning makes the DISC flush with the box, so the
                      2px margin is the gap you actually see. iOS grows its tap
                      target up-and-left for the same reason
                      (MessageViews.swift, .bottomTrailing) and Android moved
                      its 2dp outside .size(). Measured, not eyeballed. */}
                  <span className="w-9 h-9 flex items-center justify-center rounded-full border border-line bg-bg-2 shadow-[0_2px_6px_rgba(0,0,0,0.35)] text-ink-2 group-hover:text-ink-1 group-hover:bg-bg-3 transition-colors">
                    <ChevronDown size={15} />
                  </span>
                </button>
              )}
            <Composer
              channel={channel}
              placeholder={composerPlaceholder}
              canMentionEveryone={canMentionEveryone}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              onSend={async (content, files, poll, stickerId, voiceMessage) => {
                // Apply built-in slash command transforms first
                // (`/me waves` → `*alice waves*` etc). Pure text
                // sugar; the server stores the transformed text.
                // Done BEFORE encryption so E2EE wraps the
                // substituted output and recipients see the same
                // styled message.
                let processedContent = content;
                if (content && content.startsWith('/')) {
                  const { transformSlashCommand } = await import(
                    '../lib/slashCommands'
                  );
                  const slash = transformSlashCommand(content, {
                    displayName: user?.displayName,
                    username: user?.username,
                  });
                  processedContent = slash.content;
                }

                // ── E2EE shared-key model ──────────────────────────────
                //   If E2EE is enabled on this DM, the user must have
                //   the conversation password's derived key cached
                //   locally before they can send. We don't silently
                //   fall back to plaintext when the key is missing:
                //   the user explicitly enabled E2EE and surprise-
                //   leaking a single message would defeat the
                //   purpose. Instead, surface a toast prompting them
                //   to enter the password — that part is handled by
                //   the password-prompt UI in MessageView when the
                //   user opens an E2EE'd DM without a local key.
                let outgoingContent = processedContent;
                if (
                  isDM1to1 &&
                  processedContent &&
                  processedContent.trim().length > 0 &&
                  channel.e2eeEnabled &&
                  !dmE2eeSuppressed(supervision, channel)
                ) {
                  try {
                    if (!e2eeSupported()) {
                      toasts.push(E2EE_INSECURE_MESSAGE, 'error');
                      return; // abort send
                    }
                    const { encryptForDm, hasLocalKey } = await import('../lib/e2ee');
                    if (!hasLocalKey(channel.id)) {
                      toasts.push(
                        'Enter the conversation password to send encrypted messages.',
                        'error',
                      );
                      return; // abort send
                    }
                    const encrypted = await encryptForDm(
                      processedContent,
                      channel.id,
                      channel.e2eeVerifier,
                    );
                    if (encrypted) {
                      // Ciphertext is ~34% larger than plaintext; if it would
                      // exceed the server's content cap, fail clearly here
                      // rather than letting the server reject it with a cryptic
                      // length error.
                      if (encrypted.length > 4000) {
                        toasts.push(
                          'This message is too long to send in an encrypted DM. Shorten it and try again.',
                          'error',
                        );
                        return;
                      }
                      outgoingContent = encrypted;
                    } else {
                      // null here also covers a stale key dropped by the
                      // verifier guard — encryptForDm cleared it, so the next
                      // attempt prompts for the new conversation password.
                      toasts.push(
                        'Encryption failed — message not sent.',
                        'error',
                      );
                      return;
                    }
                  } catch {
                    toasts.push('Encryption failed — message not sent.', 'error');
                    return;
                  }
                }

                // E2EE: attachments must be encrypted too — including voice
                // notes (the player decrypts .zke audio for playback). Guard
                // the key for ANY attachment-bearing message: the text guard
                // above only fires when there's text, so an attachment-only
                // send would otherwise slip through and leak plaintext.
                let encryptAttachmentsForDm: string | undefined;
                if (
                  isDM1to1 &&
                  files.length > 0 &&
                  channel.e2eeEnabled &&
                  !dmE2eeSuppressed(supervision, channel)
                ) {
                  const { hasLocalKey } = await import('../lib/e2ee');
                  if (!hasLocalKey(channel.id)) {
                    toasts.push(
                      'Enter the conversation password to send encrypted attachments.',
                      'error',
                    );
                    return;
                  }
                  encryptAttachmentsForDm = channel.id;
                }

                // Optimistic insertion — bubble appears immediately, with
                // upload progress and a retry affordance on failure. The
                // promise resolves once the REST call settles either way
                // (success → real DTO replaces placeholder; failure →
                // bubble flips to `failed` state). We don't propagate
                // failure to the caller because the in-stream UI handles
                // retry; bubbling it would just re-show the toast on top.
                await sendMessageOptimistic(channel.id, {
                  content: outgoingContent,
                  files,
                  replyToId: replyTo?.id,
                  ...(poll ? { poll } : {}),
                  ...(stickerId ? { stickerId } : {}),
                  ...(voiceMessage ? { voiceMessage } : {}),
                  ...(encryptAttachmentsForDm ? { encryptAttachmentsForDm } : {}),
                });
                setReplyTo(null);
              }}
              onScheduleSend={async (content, scheduledForIso) => {
                // Run slash commands so a "/me waves" scheduled for
                // tomorrow still renders as the action when it fires.
                let processedContent = content;
                if (content && content.startsWith('/')) {
                  const { transformSlashCommand } = await import(
                    '../lib/slashCommands'
                  );
                  const slash = transformSlashCommand(content, {
                    displayName: user?.displayName,
                    username: user?.username,
                  });
                  processedContent = slash.content;
                }
                // E2EE: pre-encrypt under the conversation key. The server
                // stores and later fires the ciphertext verbatim (it never
                // needs the plaintext); the recipient decrypts on receipt
                // like any encrypted message. The passphrase-derived key is
                // stable, so it's still valid when the message fires —
                // re-keying the DM before then invalidates pending sends.
                let scheduledContent = processedContent;
                if (
                  isDM1to1 &&
                  processedContent &&
                  processedContent.trim().length > 0 &&
                  channel.e2eeEnabled &&
                  !dmE2eeSuppressed(supervision, channel)
                ) {
                  if (!e2eeSupported()) {
                    toasts.push(E2EE_INSECURE_MESSAGE, 'error');
                    return;
                  }
                  const { encryptForDm, hasLocalKey } = await import('../lib/e2ee');
                  if (!hasLocalKey(channel.id)) {
                    toasts.push(
                      'Enter the conversation password to schedule encrypted messages.',
                      'error',
                    );
                    return;
                  }
                  const encrypted = await encryptForDm(
                    processedContent,
                    channel.id,
                    channel.e2eeVerifier,
                  );
                  if (!encrypted) {
                    toasts.push('Encryption failed — message not scheduled.', 'error');
                    return;
                  }
                  // Ciphertext is ~34% larger than plaintext; if it exceeds the
                  // server's content cap, fail clearly here rather than letting
                  // the server reject it with a cryptic length error.
                  if (encrypted.length > 4000) {
                    toasts.push(
                      'This message is too long to schedule in an encrypted DM. Shorten it and try again.',
                      'error',
                    );
                    return;
                  }
                  scheduledContent = encrypted;
                }
                try {
                  await rest.scheduleMessage(channel.id, {
                    content: scheduledContent,
                    scheduledFor: scheduledForIso,
                    replyToMessageId: replyTo?.id ?? null,
                  });
                } catch (err) {
                  // Surface the server's specific error rather than
                  // letting the picker's generic "Schedule failed"
                  // catchall handle it. The server messages explain
                  // the actual reason (cooldown, permission, format).
                  toasts.push(
                    err instanceof ApiError
                      ? err.message
                      : 'Could not schedule the message',
                    'error',
                  );
                  throw err; // Re-throw so the picker keeps itself open for retry
                }
                setReplyTo(null);
                // Format the chosen time for the toast — matches the
                // picker's summary line so users get visual continuity.
                const d = new Date(scheduledForIso);
                const when = d.toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                });
                toasts.push(`Scheduled for ${when}.`, 'success');
              }}
            />
            </div>
            </>
          )}
        </div>

        {/* Right-side overlay: pin list or search results */}
        {overlay === 'pins' && (
          <PinPanel channel={channel} onClose={() => setOverlay(null)} />
        )}
        {overlay === 'search' && (
          <SearchPanel
            channel={channel}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onClose={() => setOverlay(null)}
          />
        )}
      </div>
    </>
  );
}

// ── Scroller (handles auto-scroll-to-bottom while letting users scroll up) ──

/**
 * Whether a message id looks like a server-issued snowflake (pure
 * digits) vs a client-issued optimistic placeholder (`local-...`).
 * BigInt() accepts only digits, so guarding with this prevents the
 * comparison from throwing when a placeholder id occupies the slot
 * mid-send.
 */
function isNumericId(id: string): boolean {
  if (id.length === 0) return false;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function Scroller({
  messages,
  channel,
  loaded,
  selfId,
  onReply,
  jumpToMessageId,
  unreadBoundary,
  onScrolledUpChange,
  jumpToNewestRef,
}: {
  messages: Message[] | undefined;
  channel: Channel;
  loaded: boolean;
  selfId: string | undefined;
  /** Per-message Reply action — picked up by MessageView and used to
      put the chosen message in the Composer's reply context. */
  onReply: (m: Message) => void;
  /** When set, scroll the matching message's group into view (the
      parent handles the flash highlight via the DOM). */
  jumpToMessageId?: string;
  /** Frozen last-read message id captured when the channel was opened
      (null when it had no unreads). Drives the red "New messages"
      divider, and guild channels land their initial scroll ON the
      divider instead of the bottom (iOS parity). */
  unreadBoundary: string | null;
  /** Publishes "the user is scrolled away from the newest message" to the
      parent, which owns the jump-to-newest chevron (it's anchored to the
      composer, our sibling — see MessageView). Fed by the same
      PIN_THRESHOLD_PX measurement that gates auto-follow, so the chevron
      and the "New messages" pill share one definition of "the bottom".
      Called only on transitions, never once per scroll event. */
  onScrolledUpChange?: (scrolledUp: boolean) => void;
  /** Filled with scrollToBottom() so the composer-anchored chevron can
      drive us. A ref rather than a callback prop: handing the parent a
      fresh function identity each render would re-render the whole view. */
  jumpToNewestRef?: { current: (() => void) | null };
}) {
  // Convenience alias — the rest of this function still references
  // `channelId` so we keep that local. Threading the full Channel down
  // gives us guildId for the per-row ProfileCard popover.
  const channelId = channel.id;
  const ref = useRef<HTMLDivElement | null>(null);
  // virtua handle — all programmatic scrolling goes through this.
  const vref = useRef<VirtualizerHandle>(null);
  /** Are we currently pinned to the bottom? Read before each commit. */
  const wasPinnedRef = useRef(true);
  /** Last value handed to onScrolledUpChange. Pin state is recomputed on
      every scroll event and every commit; only the transitions matter to
      the parent, so de-dupe here rather than leaning on React's
      same-value bail-out (which still costs a render pass). */
  const reportedScrolledUpRef = useRef(false);
  const prevChannelRef = useRef(channelId);
  /** Force the first post-switch snap to bottom even if we momentarily
      look scrolled-up (cached-empty channel that fills in late). */
  const forceSnapToBottomRef = useRef(true);
  /** Set when the initial scroll landed ON the unread divider instead of
      the bottom (guild channel with unreads). Read by the reveal chase so
      it doesn't yank the view back to the bottom afterwards. */
  const unreadLandedRef = useRef(false);
  /** Newest message id seen last render — detects appends. */
  const prevLastIdRef = useRef<string | null>(null);
  /** Oldest message id seen last render — detects prepends. */
  const oldestIdRef = useRef<string | null>(null);
  /** One-shot guard so a single trip into the scrollback band fires at
      most one load-older. Re-armed when the user leaves the band. */
  const triggerArmedRef = useRef(true);
  /** Drives the jump-to-bottom pill. */
  const [unreadBelow, setUnreadBelow] = useState(false);
  /** Hide the message list until the first post-switch snap-to-bottom
      lands, so a freshly-opened channel appears ALREADY at the newest
      message instead of rendering at the top and visibly jumping down.
      virtua has no initial-scroll-index, so we mount, snap, then reveal
      within a frame or two (imperceptible). Starts true: the first mount
      isn't a "switch" (the forceSnapToBottom append path snaps pre-paint
      there), so only an actual channel switch hides + re-reveals. */
  const [bottomReady, setBottomReady] = useState(true);
  /** When true, virtua keeps the viewport anchored to the END as items
      are prepended (older-message load) so the view doesn't lurch.
      Turned on just before a load-older fires; reset when loading ends. */
  const [shiftPrepend, setShiftPrepend] = useState(false);

  // Granular subscriptions (was `useAppState()`): the scroller re-renders
  // only when THIS channel's older-loading flags flip — selected as
  // per-channel booleans so other channels' pagination is invisible here.
  const loadOlderMessages = useAppStateSelector((v) => v.loadOlderMessages);
  const loadingOlder = useAppStateSelector((v) => v.state.loadingOlder.has(channelId));
  const exhausted = useAppStateSelector((v) => v.state.olderExhausted.has(channelId));

  // Memoized grouping (see groupMessages). Stable while `messages`
  // identity is stable, so gateway ticks / typing updates don't re-run it.
  const messageGroups = useMemo<Message[][]>(
    () => (messages ? groupMessages(messages) : []),
    [messages],
  );
  const isDM1to1 = channel.type === 'dm';
  // Whether the channel is any kind of DM (1:1 or group). DMs land the
  // initial scroll at the bottom even with unreads — only guild channels
  // land on the "New messages" divider (iOS parity).
  const isDMKind = channel.type === 'dm' || channel.type === 'group_dm';

  // DM read-receipt anchor. Exactly ONE receipt renders in a 1:1 DM —
  // under the newest own message — showing "Read h:mm" / "Delivered" /
  // "Sent". The moment a newer message is sent, any older "Read" status
  // disappears with it (iOS parity: MessageViews.swift dmReceipt anchors
  // only on `latest`). A previous version also anchored a second "Read"
  // on the last-read own message, which showed two receipts at once.
  const dmReceiptAnchor = useMemo(() => {
    if (!isDM1to1 || !selfId || !messages) return null;
    let latest: string | null = null;
    for (const m of messages) {
      // Skip own non-message rows: system_* types AND the streak-expiry notice
      // (a 'default' row carrying a streak_warning marker) — neither should be
      // the read-receipt anchor.
      if (m.authorId !== selfId || m.type.startsWith('system_')) continue;
      if (m.metadata?.kind === 'streak_warning') continue;
      latest = m.id;
    }
    return latest;
  }, [messages, selfId, isDM1to1]);

  // Index of the first message group past the frozen unread boundary.
  // The red "New messages" divider renders above this group, and guild
  // channels land their initial scroll on it (iOS parity:
  // MessageViews.swift shouldShowUnreadDivider + the land-on-divider
  // open scroll). Group-granular: the divider sits between author
  // groups, not mid-group.
  const unreadGroupIndex = useMemo(() => {
    if (!unreadBoundary || !isNumericId(unreadBoundary)) return null;
    const boundary = BigInt(unreadBoundary);
    for (let gi = 0; gi < messageGroups.length; gi++) {
      const first = messageGroups[gi]![0]!;
      if (isNumericId(first.id) && BigInt(first.id) > boundary) return gi;
    }
    return null;
  }, [messageGroups, unreadBoundary]);

  // Virtual item layout: index 0 is the top-of-stream indicator; message
  // groups occupy 1..N, so the last item index === messageGroups.length.
  const lastIndex = messageGroups.length;

  /** Publish the "scrolled away from the newest message" signal upward,
      de-duped to transitions. Separate from setPinned() because the
      channel-switch path needs to reset the signal WITHOUT rewriting the
      pin ref that the auto-follow logic depends on. */
  function reportScrolledUp(scrolledUp: boolean) {
    if (reportedScrolledUpRef.current === scrolledUp) return;
    reportedScrolledUpRef.current = scrolledUp;
    onScrolledUpChange?.(scrolledUp);
  }

  /** Single writer for the pin state: every place that measures the scroll
      distance goes through here, so the chevron's "you are scrolled up" and
      the auto-follow / "New messages" gate are by construction the same
      notion of at-the-bottom — one threshold, one measurement, one source. */
  function setPinned(pinned: boolean) {
    wasPinnedRef.current = pinned;
    reportScrolledUp(!pinned);
  }

  // Capture pin state before each commit. Reading scroll metrics off our
  // own container is valid with virtua (it sizes the inner element to the
  // full virtual height).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < PIN_THRESHOLD_PX);
  });

  // Keep shift on only while a load-older is in flight; reset once the
  // prepend (or a no-op/exhausted load) has settled. Runs after the
  // prepend commit, by which point virtua has already anchored.
  useEffect(() => {
    if (!loadingOlder) setShiftPrepend(false);
  }, [loadingOlder]);

  // Channel switch + prepend/append handling. All programmatic scrolling
  // goes through virtua's scrollToIndex; prepend stability is handled by
  // the `shiftPrepend` prop above.
  useLayoutEffect(() => {
    // Channel switch: reset bookkeeping and snap to the newest message.
    if (channelId !== prevChannelRef.current) {
      prevChannelRef.current = channelId;
      oldestIdRef.current = messages?.[0]?.id ?? null;
      prevLastIdRef.current = messages?.[messages.length - 1]?.id ?? null;
      triggerArmedRef.current = true;
      forceSnapToBottomRef.current = true;
      unreadLandedRef.current = false;
      setShiftPrepend(false);
      setUnreadBelow(false);
      // Hide the chevron across the switch. virtua applies scrollToIndex
      // asynchronously, so the pin measurement taken right after this
      // commit can still read the OUTGOING channel's scroll position and
      // flash the chevron for a frame. The snap itself fires a scroll
      // event, and handleScroll re-raises the signal immediately if we
      // deliberately landed on the unread divider instead of the bottom.
      reportScrolledUp(false);
      // Guild channel with unread history (cached case): land the initial
      // scroll ON the "New messages" divider instead of the bottom (iOS
      // parity — MessageViews.swift lands guild channels on the divider;
      // DMs keep the iMessage-style land-at-bottom). `+1` skips the
      // top-of-stream indicator at item 0. No hide-gate here: we're
      // intentionally NOT at the bottom, so reveal immediately.
      if (!isDMKind && unreadGroupIndex !== null && messageGroups.length > 0) {
        unreadLandedRef.current = true;
        forceSnapToBottomRef.current = false;
        vref.current?.scrollToIndex(unreadGroupIndex + 1, { align: 'start' });
        setBottomReady(true);
        return;
      }
      // Hide the list until the first snap lands, so a cached channel
      // opens ALREADY at the newest message rather than painting at the
      // top and visibly jumping down. (When messages load AFTER the
      // switch, the forceSnapToBottom append path below snaps pre-paint,
      // so that case never shows a jump and doesn't need the gate.)
      if (messageGroups.length > 0) setBottomReady(false);
      // Synchronous pre-paint snap for the cached-messages case: virtua
      // positions at its best estimate for the last index before the
      // browser paints, so the very first (hidden) frame is at bottom.
      vref.current?.scrollToIndex(messageGroups.length, { align: 'end' });
      // Then a short chase: images/embeds grow rows after the first
      // commit and virtua keeps adjusting as it measures. We REVEAL only
      // once the list is confirmed pinned at the bottom (checked on the
      // frame AFTER each snap, since virtua applies scrollToIndex
      // asynchronously) — revealing before then would flash the top and
      // look like a scroll-down. A final unconditional reveal guarantees
      // the list can never get stuck hidden (e.g. a measurement quirk).
      const revealIfPinned = () => {
        requestAnimationFrame(() => {
          if (prevChannelRef.current !== channelId) { setBottomReady(true); return; }
          const el = ref.current;
          if (!el) { setBottomReady(true); return; }
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (distance < PIN_THRESHOLD_PX) setBottomReady(true);
        });
      };
      const chase = (delays: number[]) => {
        if (delays.length === 0) { setBottomReady(true); return; }
        const [d, ...rest] = delays;
        setTimeout(() => {
          if (prevChannelRef.current !== channelId) { setBottomReady(true); return; }
          // The first append landed on the unread divider (uncached guild
          // channel with unreads) — don't yank the view back to the bottom.
          if (unreadLandedRef.current) { setBottomReady(true); return; }
          const el = ref.current;
          if (!el) { setBottomReady(true); return; }
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (forceSnapToBottomRef.current || distance < 400) {
            vref.current?.scrollToIndex(messageGroups.length, { align: 'end' });
          }
          revealIfPinned();
          chase(rest);
        }, d);
      };
      chase([0, 50, 150, 400]);
      return;
    }

    // Prepend detection — oldest id changed to an older snowflake.
    // local-* optimistic ids aren't numeric; treat those as "not older".
    const newOldest = messages?.[0]?.id ?? null;
    const isPrepend =
      !!newOldest &&
      !!oldestIdRef.current &&
      newOldest !== oldestIdRef.current &&
      isNumericId(newOldest) &&
      isNumericId(oldestIdRef.current) &&
      BigInt(newOldest) < BigInt(oldestIdRef.current);
    if (isPrepend) {
      // virtua kept us anchored via shift; just re-arm-gate the trigger.
      triggerArmedRef.current = false;
    }
    oldestIdRef.current = newOldest;

    // Append detection — newest id changed (and it isn't a prepend).
    const newLast = messages?.[messages.length - 1]?.id ?? null;
    const isAppend = !!newLast && newLast !== prevLastIdRef.current && !isPrepend;
    const newTailAuthorId =
      isAppend && messages ? messages[messages.length - 1]?.author?.id : null;
    const isOwnAppend = isAppend && !!selfId && newTailAuthorId === selfId;
    prevLastIdRef.current = newLast;

    // First append after a switch: land at bottom regardless of stale pin.
    if (forceSnapToBottomRef.current && isAppend) {
      // Guild channel whose messages arrived AFTER the switch: land on the
      // unread divider rather than the bottom (see the switch branch above).
      if (!isDMKind && unreadGroupIndex !== null) {
        unreadLandedRef.current = true;
        forceSnapToBottomRef.current = false;
        vref.current?.scrollToIndex(unreadGroupIndex + 1, { align: 'start' });
        return;
      }
      vref.current?.scrollToIndex(lastIndex, { align: 'end' });
      forceSnapToBottomRef.current = false;
      setUnreadBelow(false);
      return;
    }
    // Own send: always jump to the bottom to watch it land.
    if (isOwnAppend) {
      vref.current?.scrollToIndex(lastIndex, { align: 'end' });
      setUnreadBelow(false);
      return;
    }
    // Pinned: stay pinned on append (never snap on a prepend).
    if (wasPinnedRef.current && !isPrepend) {
      vref.current?.scrollToIndex(lastIndex, { align: 'end' });
      setUnreadBelow(false);
    } else if (isAppend) {
      setUnreadBelow(true);
    }
  }, [channelId, messages, selfId, lastIndex]);

  // Jump-to-message: bring the target group into the mounted range so the
  // parent's flash-highlight (which queries the live DOM) can find it.
  const jumpedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpToMessageId) {
      jumpedForRef.current = null;
      return;
    }
    if (jumpedForRef.current === jumpToMessageId) return;
    const gi = messageGroups.findIndex((g) => g.some((m) => m.id === jumpToMessageId));
    if (gi < 0) return;
    jumpedForRef.current = jumpToMessageId;
    // +1 for the header item at index 0.
    vref.current?.scrollToIndex(gi + 1, { align: 'center' });
  }, [jumpToMessageId, messageGroups]);

  /**
   * Scroll handler: pin tracking + scrollback trigger. Fires a single
   * load-older when the user enters the top band; re-arms on leaving it.
   */
  const SCROLLBACK_TRIGGER_PX = 200;
  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distance < PIN_THRESHOLD_PX;
    setPinned(pinned);
    if (pinned && unreadBelow) setUnreadBelow(false);

    // Prefetch the next older page ~1.5 viewports BEFORE the top, so the page
    // is usually already in state when the user reaches the top (no visible
    // wait). Falls back to the 200px floor on tiny viewports.
    const triggerPx = Math.max(SCROLLBACK_TRIGGER_PX, el.clientHeight * 1.5);
    if (el.scrollTop > triggerPx) {
      triggerArmedRef.current = true;
      return;
    }
    if (!triggerArmedRef.current) return;
    if (loadingOlder || exhausted) return;
    triggerArmedRef.current = false;
    // Anchor to the end so the incoming prepend doesn't lurch the view.
    setShiftPrepend(true);
    void loadOlderMessages(channelId).catch(() => {
      // Re-arm so a manual scroll-up can retry. shift resets via the
      // loadingOlder effect once the reducer clears the loading flag.
      triggerArmedRef.current = true;
    });
  }

  /** Jump-to-bottom (pill, and the composer-anchored chevron). */
  function scrollToBottom() {
    vref.current?.scrollToIndex(messageGroups.length, { align: 'end', smooth: true });
    setUnreadBelow(false);
  }

  // Hand the parent an imperative handle to the jump. The chevron that
  // calls it is rendered next to the composer — our sibling — which has no
  // way to reach `vref`. No dep array: re-published on every commit so the
  // closed-over messageGroups.length is never a stale target, and cleared
  // on unmount so a torn-down scroller can't be driven.
  useEffect(() => {
    if (!jumpToNewestRef) return;
    jumpToNewestRef.current = scrollToBottom;
    return () => {
      jumpToNewestRef.current = null;
    };
  });

  if (!loaded || !messages) {
    // Skeleton rows during the initial fetch.
    return (
      <div ref={ref} className="flex-1 overflow-y-auto scrollbar-thin px-4 pb-2 pt-4">
        {SKELETON_ROW_WIDTHS.map((w, i) => (
          <div key={i} className="flex gap-3 py-1.5 animate-pulse">
            <div className="w-9 h-9 rounded-full bg-bg-3 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-baseline gap-2">
                <div className="h-3 w-20 rounded bg-bg-3" />
                <div className="h-2.5 w-10 rounded bg-bg-3/70" />
              </div>
              <div className={`h-3 rounded bg-bg-3/80 ${w}`} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div ref={ref} className="flex-1 overflow-y-auto scrollbar-thin px-4 pt-8 pb-4 text-ink-3 text-sm flex items-end justify-center">
        <span className="text-center">No messages yet. Say something to break the ice.</span>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative">
      <div
        ref={ref}
        onScroll={handleScroll}
        className={`absolute inset-0 overflow-y-auto scrollbar-thin px-4 pb-2 ${
          bottomReady ? '' : 'opacity-0'
        }`}
      >
        <Virtualizer ref={vref} scrollRef={ref} shift={shiftPrepend}>
          {[
            // Item 0: top-of-stream indicator (loading older / beginning).
            <div key="__top">
              {loadingOlder && (
                <div className="flex items-center justify-center gap-2 py-3 text-ink-3 text-xs">
                  <span className="w-3 h-3 rounded-full border-2 border-ink-3 border-t-transparent animate-spin" aria-hidden />
                  <span>Loading older messages…</span>
                </div>
              )}
              {!loadingOlder && exhausted && (
                <div className="px-2 py-3 text-ink-3 text-xs">
                  <span className="font-medium text-ink-2">Beginning of channel.</span>{' '}
                  This is where the conversation started.
                </div>
              )}
            </div>,
            // Items 1..N: one per author-grouped message block, with a
            // date divider when the calendar day rolls over.
            ...messageGroups.map((group, gi, allGroups) => {
              const firstMsg = group[0]!;
              const prevGroup = gi > 0 ? allGroups[gi - 1] : null;
              const prevLast = prevGroup ? prevGroup[prevGroup.length - 1]! : null;
              const showDivider =
                !prevLast || !sameLocalDay(firstMsg.createdAt, prevLast.createdAt);
              return (
                <div key={firstMsg.id} className={gi === 0 ? 'pt-4' : 'pt-3'}>
                  {showDivider && <DateDivider iso={firstMsg.createdAt} />}
                  {gi === unreadGroupIndex && <UnreadDivider />}
                  {group.map((m, i) => (
                    <ErrorBoundary
                      key={m.id}
                      fallback={(err) => (
                        <div className="px-4 py-2 text-xs text-red-300/80 italic">
                          Couldn't render this message: {err.message || 'unknown error'}
                        </div>
                      )}
                    >
                      <MessageItem
                        message={m}
                        continuation={i > 0}
                        selfId={selfId}
                        onReply={onReply}
                        channel={channel}
                        showDmReceipt={
                          isDM1to1 &&
                          m.authorId === selfId &&
                          !m.type.startsWith('system_') &&
                          m.id === dmReceiptAnchor
                        }
                      />
                    </ErrorBoundary>
                  ))}
                </div>
              );
            }),
          ]}
        </Virtualizer>
      </div>
      {/* Jump-to-bottom pill. Shown when the user is scrolled up
          reading older messages AND new messages have arrived since
          they left the live region. One tap jumps them back to the
          bottom and clears the unread state. Position pinned to the
          bottom-center of the scrollable area; z-10 keeps it above
          the message rows but below modals. */}
      {unreadBelow && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent hover:bg-accent/90 text-white text-xs font-medium shadow-lg z-10 transition-transform hover:scale-105"
          aria-label="Jump to newest messages"
        >
          <ArrowDown size={12} />
          <span>New messages</span>
        </button>
      )}
    </div>
  );
}

/**
 * Red "New messages" separator marking where the user last left off —
 * iOS parity (MessageViews.swift UnreadDividerView): a danger-red
 * hairline with a bold 10px label at its right end. Anchored at the
 * boundary frozen when the channel was opened, so it stays put while
 * the auto-ack advances the server-side read marker.
 */
function UnreadDivider() {
  return (
    <div
      className="flex items-center gap-2 py-[3px] select-none"
      role="separator"
      aria-label="New messages"
    >
      <div className="flex-1 h-px bg-red-400" />
      <span className="text-[10px] font-bold text-red-400 shrink-0">New messages</span>
    </div>
  );
}

/**
 * Inline date separator between message groups when the calendar day
 * changes. The label is relative for recent days ("Today"/"Yesterday")
 * and a full date otherwise. Visually it's a centered label inside a
 * horizontal hairline rule — same idiom Discord and most chat apps use.
 */
function DateDivider({ iso }: { iso: string }) {
  return (
    <div className="flex items-center gap-3 my-2 select-none" role="separator" aria-label={formatDateDivider(iso)}>
      <div className="flex-1 h-px bg-line" />
      <span className="text-[0.65rem] uppercase tracking-wider font-semibold text-ink-3">
        {formatDateDivider(iso)}
      </span>
      <div className="flex-1 h-px bg-line" />
    </div>
  );
}

/** Two ISO timestamps fall on the same local-time calendar day. */
function sameLocalDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// Pre-constructed Intl formatters for the date divider — see the
// matching comment in MessageItem.tsx for the rationale. Four shapes
// to cover the same-year/different-year × within-week/older matrix.
const DIVIDER_MD_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
});
const DIVIDER_WMD_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});
const DIVIDER_MDY_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});
const DIVIDER_WMDY_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});

function formatDateDivider(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const dayMs = 24 * 60 * 60 * 1000;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startToday - startThat) / dayMs);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  const includeWeekday = daysAgo < 7;
  if (sameYear) {
    return includeWeekday ? DIVIDER_WMD_FMT.format(d) : DIVIDER_MD_FMT.format(d);
  }
  return includeWeekday ? DIVIDER_WMDY_FMT.format(d) : DIVIDER_MDY_FMT.format(d);
}

// 1 minute: a message sent a minute or more after the previous one starts a
// NEW block with the avatar + timestamp, so exchanges don't clump together
// (user request; iOS + Android match).
const GROUP_WINDOW_MS = 60 * 1000;
// Re-show the author header (avatar + name) at least every N messages within an
// uninterrupted same-author run, so a long monologue doesn't lose its label and
// you can tell who's talking without scrolling up. Mirrors the iOS client's
// headerEveryNInRun. Implemented by capping each author block at N messages.
const MESSAGES_PER_HEADER_RUN = 6;

/** Per-row width classes for the loading skeleton — picked to look
    irregular (not all identical), so the placeholder doesn't read as a
    repeating pattern. Six rows is enough to fill a typical viewport. */
const SKELETON_ROW_WIDTHS = ['w-3/4', 'w-1/2', 'w-5/6', 'w-2/3', 'w-1/3', 'w-3/5'];

// ── Composer drafts (in-memory, per channel) ───────────────────────────────
//
// Switching channels mid-typing used to nuke whatever you'd written. This
// keeps a small per-channel cache so navigating away and back restores the
// draft. Module-scope module-state is fine here — drafts are user-local
// and we don't want them to outlive a page reload anyway (which the user
// would expect to clear in-progress work). For larger draft sets we could
// move to localStorage, but module memory is simpler and matches the
// implicit "drafts are ephemeral" contract.

const drafts = new Map<string, string>();

function readDraft(channelId: string): string {
  return drafts.get(channelId) ?? '';
}

function writeDraft(channelId: string, value: string): void {
  if (value.length === 0) drafts.delete(channelId);
  else drafts.set(channelId, value);
}

function clearDraft(channelId: string): void {
  drafts.delete(channelId);
}

// Memoize Date.parse — groupMessages re-runs over the WHOLE message array on
// every scrollback prepend (the memo key changes when a page is prepended), so
// without caching it re-parses every message's timestamp on each older page.
// Timestamps are immutable, so a string→epoch cache makes regroup-on-prepend
// an O(new-rows) parse instead of O(total). Bounded for a long session.
const parsedTimeCache = new Map<string, number>();
function tsMs(iso: string): number {
  let t = parsedTimeCache.get(iso);
  if (t === undefined) {
    t = Date.parse(iso);
    if (parsedTimeCache.size > 10000) parsedTimeCache.clear();
    parsedTimeCache.set(iso, t);
  }
  return t;
}

function groupMessages(msgs: Message[]): Message[][] {
  const out: Message[][] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    const lastMsg = last?.[last.length - 1];
    // System messages (system_call, system_join, system_pin, etc.) and the
    // streak-warning notice never chain with anything. They render as
    // standalone notices — not as a "message from author X" — so chaining them
    // with surrounding messages would suppress the avatar/name on the adjacent
    // regular message even though it's effectively starting a new conversation.
    // Force a group break on either side. NOTE the streak warning is a 'default'
    // row carrying metadata.kind === 'streak_warning' (not a system_ type), so
    // it must be detected separately or it would chain (it's posted under a
    // participant's authorId) and swallow the next message's avatar.
    const isNotice = (x: Message) =>
      x.type.startsWith('system_') || x.metadata?.kind === 'streak_warning';
    const currentIsSystem = isNotice(m);
    const lastIsSystem = lastMsg ? isNotice(lastMsg) : false;
    if (
      lastMsg &&
      !currentIsSystem &&
      !lastIsSystem &&
      lastMsg.authorId === m.authorId &&
      lastMsg.authorId !== null &&
      // Cap the run so the header re-appears every N messages (iOS parity).
      last.length < MESSAGES_PER_HEADER_RUN &&
      tsMs(m.createdAt) - tsMs(lastMsg.createdAt) < GROUP_WINDOW_MS
    ) {
      last.push(m);
    } else {
      out.push([m]);
    }
  }
  return out;
}

// ── Composer ────────────────────────────────────────────────────────────────

/**
 * Maximum file count in one message. Mirrors the api's MAX_FILES_PER_MESSAGE
 * default; the server is the source of truth, but enforcing locally lets us
 * disable the picker before the user assembles a request that's going to
 * fail. If the operator has tuned the server limit, the client just enforces
 * a stricter cap — no harm.
 */
const MAX_FILES = 10;

function Composer({
  channel,
  placeholder,
  canMentionEveryone,
  replyTo,
  onCancelReply,
  onSend,
  onScheduleSend,
}: {
  channel: Channel;
  placeholder?: string;
  /** Offer @everyone / @here in the mention autocomplete (computed by the
      parent from the caller's channel permissions). */
  canMentionEveryone?: boolean;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  /**
   * Submit handler. Called when the user hits Send OR picks a sticker.
   *   - 4th arg: optional poll attachment — when present, the message
   *     can have empty content (the poll is the body).
   *   - 5th arg: optional sticker id — when present, the message has
   *     just the sticker (no text/files/poll).
   *   - 6th arg: optional voice metadata — when present, the FIRST
   *     file is treated as a voice message. Server requires exactly
   *     one audio file in `files`, no text, and no other body shape.
   */
  onSend: (
    content: string,
    files: File[],
    poll?: PollDraft,
    stickerId?: string,
    voiceMessage?: { durationSeconds: number; waveform: string },
  ) => Promise<void>;
  /**
   * Schedule-send handler. Called from the schedule picker after
   * the user chooses a future timestamp. Receives (content, ISO).
   * Parent wires this to rest.scheduleMessage. Attachments are not
   * supported in v1 of scheduling, so this signature is text-only.
   */
  onScheduleSend?: (content: string, scheduledForIso: string) => Promise<void>;
}) {
  // Initialise from any saved draft for this channel. We pass the
  // channel id as the lazy-init seed so React only reads the draft
  // store on first mount per channel — switching channels remounts
  // the Composer (the parent renders a different `channel`) so the
  // initial state is correctly seeded again.
  const [text, setText] = useState(() => readDraft(channel.id));
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Emoji picker open state. The picker is anchored above its toggle
  // button (above-right of the composer) so it doesn't push composer
  // contents around. Closing happens via outside-click / Escape (the
  // EmojiPicker component handles those itself) or after a selection.
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  // Poll attachment state — null until the user opens the poll
  // composer modal and creates one. Once attached, the composer
  // shows a chip with the question + "Remove" button. Sending the
  // message clears it. Polls don't survive channel switches (we
  // don't persist them in the draft store like text), and since
  // text drafts already feel ephemeral by design, that matches
  // expectations.
  const [pollDraft, setPollDraft] = useState<PollDraft | null>(null);
  const [pollModalOpen, setPollModalOpen] = useState(false);
  /** Schedule-send picker open state. The button beside the poll
      icon opens this; the picker fires onScheduleSend on confirm. */
  const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
  /** Mobile composer-tools toggle. On small screens the icon cluster
      (poll / schedule / sticker / emoji / voice) collapses behind a
      single chevron to keep the composer uncluttered; tapping the
      chevron reveals them. On sm+ the cluster is always inline and
      this flag is ignored (CSS `sm:flex` overrides). */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  // Voice recorder. Owns its own state machine (idle/recording/ready)
  // and exposes a finalised File + waveform. The Composer's overlay
  // renders only when the recorder is active or has a result.
  const recorder = useVoiceRecorder();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // Touch devices get a small attach menu so "Take photo" can sit beside
  // "Upload a file" (mirrors the iOS attach menu); desktop has no camera, so
  // the paperclip uploads directly there. Pointer type is static per device.
  const isCoarsePointer = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
    [],
  );

  /**
   * Insert an emoji code at the textarea's current cursor position.
   * `code` is either a unicode glyph (👍) or a `:name:` token. We
   * append a trailing space so the next character the user types
   * doesn't accidentally extend a `:name:` token. Cursor lands after
   * the inserted text.
   */
  function insertAtCursor(code: string) {
    const ta = taRef.current;
    if (!ta) {
      // No textarea ref — fall back to appending. Shouldn't happen in
      // practice but covers the edge case where the picker fires
      // before mount completes.
      setText((prev) => `${prev}${code} `);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const insertion = `${code} `;
    const next = `${before}${insertion}${after}`;
    setText(next);
    // Restore focus + place cursor after the inserted text on next
    // microtask so the new value has been applied.
    queueMicrotask(() => {
      const t = taRef.current;
      if (!t) return;
      t.focus();
      const pos = before.length + insertion.length;
      t.setSelectionRange(pos, pos);
    });
  }
  const ping = useTypingPing(channel.id);
  const toasts = useToasts();
  // @mention autocomplete — popover that fires when the user types
  // `@` after whitespace. Returns a popover element to render and
  // intercepts ArrowUp/ArrowDown/Enter/Tab/Esc when active. We feed
  // it the textarea ref + a setValue callback so it can apply
  // selections directly to our state without round-tripping through
  // a synthetic event.
  const mentionAC = useMentionAutocomplete({
    channel,
    textareaRef: taRef,
    setValue: setText,
    canMentionEveryone,
  });
  // `:name:` autocomplete — same shape as mentionAC. Both hooks expose
  // (onChange, onKeyDown, popover, active) so we forward textarea
  // events to both. Their detection regions don't overlap (`@…` vs
  // `:…`) so they can both be active at most one-at-a-time per
  // cursor position.
  const emojiAC = useEmojiAutocomplete({
    channel,
    textareaRef: taRef,
    setValue: setText,
  });

  // Persist the in-progress text to the per-channel draft store on
  // every change. Cleared on send (see `submit`). Files are NOT
  // persisted — they're File objects backed by the OS picker, and
  // re-reading them across navigations isn't reliable. The UX
  // tradeoff: text drafts survive channel switches; attachments
  // need to be re-attached. That matches Discord's behaviour.
  useEffect(() => {
    writeDraft(channel.id, text);
  }, [channel.id, text]);

  // When the channel id changes (parent re-rendered with a different
  // channel), pull the draft for the new channel into local state.
  // Without this the Composer's local `text` state would lag behind
  // the channel switch by one render. Comparing channelIdRef to the
  // current id avoids redundant setText calls on unrelated re-renders.
  const channelIdRef = useRef(channel.id);
  useEffect(() => {
    if (channelIdRef.current !== channel.id) {
      channelIdRef.current = channel.id;
      setText(readDraft(channel.id));
      setFiles([]);
    }
  }, [channel.id]);

  // Auto-focus the textarea when entering reply mode so the user can
  // start typing immediately. Only fires on TRANSITION from null → set,
  // not on every replyTo change (refocusing every keystroke would be
  // disruptive — the textarea is already focused while typing anyway).
  const lastReplyId = useRef<string | null>(null);
  useEffect(() => {
    if (replyTo && replyTo.id !== lastReplyId.current) {
      taRef.current?.focus();
    }
    lastReplyId.current = replyTo?.id ?? null;
  }, [replyTo]);

  function addFiles(incoming: FileList | File[]) {
    const arr = Array.from(incoming);
    let accepted: File[] = [];
    setFiles((prev) => {
      const remaining = MAX_FILES - prev.length;
      if (remaining <= 0) {
        toasts.push(`At most ${MAX_FILES} files per message`, 'error');
        return prev;
      }
      if (arr.length > remaining) {
        toasts.push(`Only the first ${remaining} of ${arr.length} files were attached`, 'info');
      }
      accepted = arr.slice(0, remaining);
      return [...prev, ...accepted];
    });
    // Compress accepted images client-side, then swap each original in
    // state for its (smaller) compressed version by identity. Done off
    // the critical path so the previews appear instantly; the upload on
    // send uses whatever's in state at that point. Failures keep the
    // original file, so this can never block or break an attachment.
    if (accepted.length > 0) {
      void Promise.all(
        accepted.map(async (f) => ({ from: f, to: await compressImage(f) })),
      ).then((pairs) => {
        const changed = pairs.filter((p) => p.to !== p.from);
        if (changed.length === 0) return;
        setFiles((prev) =>
          prev.map((f) => changed.find((p) => p.from === f)?.to ?? f),
        );
      });
    }
    // After the OS file picker closes, focus is on the body (or the
    // hidden input). Restoring it to the textarea means Enter will
    // submit the attachment-only message — without this the user
    // had to click the textarea first to send a file with no text.
    // requestAnimationFrame defers past the React state flush so the
    // textarea is in the DOM by the time we focus it.
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    // Same rationale as addFiles — keep the textarea focused so a
    // user clearing files without sending can keep typing or hit
    // Enter on the remaining attachments.
    requestAnimationFrame(() => taRef.current?.focus());
  }

  async function submit() {
    const trimmed = text.trim();
    // A send is valid if the message has text, attachments, OR a poll.
    // Poll-only messages are a Discord pattern — the poll is the body.
    if ((!trimmed && files.length === 0 && !pollDraft) || pending) return;
    setPending(true);
    try {
      await onSend(trimmed, files, pollDraft ?? undefined);
      setText('');
      setFiles([]);
      setPollDraft(null);
      clearDraft(channel.id);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Send failed', 'error');
    } finally {
      setPending(false);
      taRef.current?.focus();
    }
  }

  // Auto-resize textarea as the user types (cap at ~6 lines).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [text]);

  // Drag-drop handlers. We track an active counter on the wrapper element
  // because dragenter/dragleave fire for child elements too; using
  // `dragging` as a boolean directly causes flicker as the user moves the
  // pointer over inner nodes. Counter approach: enter ++, leave --.
  const dragCounter = useRef(0);

  return (
    <div
      // Mobile composer sits ABOVE the iOS home-indicator zone
      // PLUS Siri's edge-swipe region. The arbitrary-value padding
      // resolves to `max(env(safe-area-inset-bottom) + 12px, 40px)`
      // — whichever is larger between (system safe area + 12px) and
      // a flat 40px floor. PWAs expose a non-zero env value
      // (~12-34px depending on device); a regular Safari tab
      // exposes 0 so the 40px floor still keeps the composer clear
      // of the home gesture area. `sm:pb-4` reverts on desktop
      // where there's no system bar to dodge.
      className="zk-composer px-4 pt-2 pb-[max(calc(env(safe-area-inset-bottom)+0.75rem),2.5rem)] sm:pb-4 border-t relative"
      style={{ borderTopColor: 'var(--zk-line-soft)' }}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        dragCounter.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        dragCounter.current--;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        dragCounter.current = 0;
        setDragging(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          addFiles(e.dataTransfer.files);
        }
      }}
    >
      {dragging && (
        <div
          className="absolute inset-1 rounded-lg border-2 border-dashed border-accent bg-accent/10 z-10 flex items-center justify-center text-accent font-medium pointer-events-none"
          aria-hidden
        >
          Drop to attach files
        </div>
      )}

      {files.length > 0 && (
        <FilePreviewRow files={files} onRemove={removeFile} />
      )}

      {/* Reply chip — shown above the input when a reply is in progress.
          Truncated quote of the message content; X to cancel. The whole
          chip is also clickable on the icon side as a courtesy. Hitting
          Escape while focused on the textarea also clears the reply
          (handled in the textarea keydown). */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-1.5 mb-1 rounded-md bg-bg-3 border border-line text-xs">
          <CornerUpLeft size={12} className="text-accent shrink-0" />
          <span className="text-ink-3 shrink-0">Replying to</span>
          <span className="font-medium text-ink-1 shrink-0">
            {replyTo.author?.displayName ?? replyTo.author?.username ?? 'unknown'}
          </span>
          <span className="text-ink-2 truncate flex-1 min-w-0">
            {/* Same preview rules as the in-stream quote bar: never the raw
                E2EE wire string (cached plaintext or a lock label instead),
                plus typed sticker/voice/attachment/poll fallbacks. */}
            {replyPreviewText(replyTo)}
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            className="w-5 h-5 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-2 shrink-0"
            aria-label="Cancel reply"
            title="Cancel reply (Esc)"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Poll chip — shown above the input when a poll is staged. Click
          the body to re-open the modal and edit; X removes the poll
          attachment without sending. */}
      {pollDraft && (
        <div className="flex items-center gap-2 px-3 py-1.5 mb-1 rounded-md bg-accent/10 border border-accent/30 text-xs">
          <BarChart size={12} className="text-accent shrink-0" />
          <button
            type="button"
            onClick={() => setPollModalOpen(true)}
            className="flex-1 min-w-0 text-left"
          >
            <span className="text-ink-3 shrink-0">Poll: </span>
            <span className="font-medium text-ink-1 truncate">{pollDraft.question}</span>
            <span className="text-ink-3 ml-2">({pollDraft.options.length} options)</span>
          </button>
          <button
            type="button"
            onClick={() => setPollDraft(null)}
            className="w-5 h-5 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-2 shrink-0"
            aria-label="Remove poll"
            title="Remove poll"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {pollModalOpen && (
        <PollComposerModal
          onCancel={() => setPollModalOpen(false)}
          onSubmit={(draft) => {
            setPollDraft(draft);
            setPollModalOpen(false);
          }}
        />
      )}

      {schedulePickerOpen && (
        <SchedulePickerModal
          onClose={() => setSchedulePickerOpen(false)}
          onPick={async (iso) => {
            const trimmed = text.trim();
            if (!trimmed || !onScheduleSend) {
              setSchedulePickerOpen(false);
              return;
            }
            setPending(true);
            try {
              await onScheduleSend(trimmed, iso);
              setText('');
              clearDraft(channel.id);
              setSchedulePickerOpen(false);
            } catch (e) {
              // Re-show by leaving the picker open; toast is the parent's
              // responsibility (matches the onSend error path).
              toasts.push(
                e instanceof ApiError ? e.message : 'Schedule failed',
                'error',
              );
            } finally {
              setPending(false);
              taRef.current?.focus();
            }
          }}
        />
      )}

      {/* Recording / preview overlay. Replaces the input row visually
          while recording so the user can't accidentally type into the
          textarea (which would queue text for an already-doomed
          send), and gets a clear focal point for stop / cancel. The
          row underneath is still in the DOM so the Composer's height
          stays roughly consistent. */}
      {recorder.status === 'recording' && (
        <div className="flex items-center gap-3 bg-bg-2 rounded-lg px-3 py-3 border border-red-500/50 mb-2">
          {/* Pulsing red dot — universal "we're recording" signal. */}
          <span
            className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0 animate-pulse"
            aria-hidden
          />
          <span className="text-xs tabular-nums text-ink-1 shrink-0 font-medium">
            {formatRecordingTime(recorder.elapsedMs)}
          </span>
          {/* Live waveform — rolling window of the most recent samples.
              Bars grow and shrink as the user speaks; quiet stretches
              show short bars rather than empty space. */}
          <div className="flex items-center gap-[2px] flex-1 h-6 min-w-0">
            {recorder.liveWaveform.length === 0 ? (
              <span className="text-xs text-ink-3 italic">Listening…</span>
            ) : (
              recorder.liveWaveform.map((v, i) => {
                const height = 4 + Math.round((v / 255) * 20);
                return (
                  <div
                    key={i}
                    className="w-[3px] rounded-sm bg-red-500/70"
                    style={{ height: `${height}px` }}
                  />
                );
              })
            )}
          </div>
          <button
            type="button"
            onClick={() => recorder.cancel()}
            className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 shrink-0"
            title="Cancel recording"
            aria-label="Cancel recording"
          >
            <Trash size={14} />
          </button>
          <button
            type="button"
            onClick={() => recorder.stop()}
            className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 shrink-0"
          >
            Stop
          </button>
        </div>
      )}

      {/* Preview state — recording finished, waiting for the user to
          send or discard. We render a one-shot voice player that
          previews the result blob via an object URL. */}
      {recorder.status === 'ready' && recorder.result && (
        <div className="flex items-center gap-3 bg-bg-2 rounded-lg px-3 py-2 border border-line mb-2">
          <span className="text-xs text-ink-3 shrink-0">
            Voice ({formatRecordingTime(recorder.result.durationSeconds * 1000)})
          </span>
          <div className="flex items-center gap-[2px] flex-1 h-6 min-w-0">
            {/* Final waveform preview — same renderer would work, but
                we want to keep this overlay light so we draw a static
                glance rather than the full interactive player. */}
            {decodeFinalWaveform(recorder.result.waveformBase64).map((v, i) => {
              const height = 3 + Math.round((v / 255) * 18);
              return (
                <div
                  key={i}
                  className="w-[3px] rounded-sm bg-accent/70"
                  style={{ height: `${height}px` }}
                />
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => recorder.cancel()}
            className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 shrink-0"
            title="Discard"
            aria-label="Discard voice message"
          >
            <Trash size={14} />
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!recorder.result) return;
              const { file, durationSeconds, waveformBase64 } = recorder.result;
              try {
                await onSend('', [file], undefined, undefined, {
                  durationSeconds,
                  waveform: waveformBase64,
                });
                recorder.reset();
              } catch (e) {
                toasts.push(
                  e instanceof ApiError ? e.message : 'Send failed',
                  'error',
                );
              }
            }}
            className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 shrink-0"
          >
            Send
          </button>
        </div>
      )}

      {/* Recorder error — surfaces permission denials etc. The user
          can dismiss to clear, then optionally retry. */}
      {recorder.status === 'error' && recorder.errorMessage && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2 mb-2 text-sm">
          <span className="flex-1 text-red-300 truncate">{recorder.errorMessage}</span>
          <button
            type="button"
            onClick={() => recorder.reset()}
            className="text-xs text-ink-3 hover:text-ink-1 px-2 py-1 rounded hover:bg-bg-3 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <div
        className="flex items-center gap-1.5 bg-bg-2/60 backdrop-blur-sm rounded-lg px-2 py-1.5 border transition-all relative focus-within:shadow-[0_0_0_1px_var(--accent-glow),0_0_18px_var(--accent-glow)]"
        style={{ borderColor: 'var(--zk-line)' }}
      >
        {/* Attach — file upload, plus a camera option on touch devices.
            Desktop has no useful capture surface, so the paperclip opens the
            file picker directly there; on mobile it opens a small menu so
            "Take photo" can sit beside "Upload a file" (mirrors the iOS
            attach menu). Camera is mobile-only. */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              if (files.length >= MAX_FILES) return;
              if (isCoarsePointer) setAttachMenuOpen((o) => !o);
              else fileInputRef.current?.click();
            }}
            disabled={files.length >= MAX_FILES}
            className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title={files.length >= MAX_FILES ? `Max ${MAX_FILES} files` : 'Attach'}
            aria-label="Attach"
            aria-haspopup={isCoarsePointer ? 'menu' : undefined}
            aria-expanded={isCoarsePointer ? attachMenuOpen : undefined}
          >
            <Paperclip size={16} />
          </button>
          {attachMenuOpen && (
            <>
              {/* Invisible backdrop closes the menu on any outside tap.
                  No body portal — avoids the click-outside trap. */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setAttachMenuOpen(false)}
              />
              <div
                className="absolute bottom-full left-0 mb-1 z-50 min-w-[180px] rounded-lg border bg-bg-2 shadow-lg py-1"
                style={{ borderColor: 'var(--zk-line)' }}
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ink-1 hover:bg-bg-3 text-left"
                >
                  <Paperclip size={15} className="text-ink-2 shrink-0" />
                  Upload a file
                </button>
                {/* Camera — mobile only (this menu only opens on touch). */}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    cameraInputRef.current?.click();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ink-1 hover:bg-bg-3 text-left"
                >
                  <Camera size={15} className="text-ink-2 shrink-0" />
                  Take photo
                </button>
              </div>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = '';
          }}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Fire a typing ping (throttled to once per 4s by the hook).
            // We only ping when the user is actively adding content, not
            // when erasing — small thing, but it keeps Backspace silent.
            if (e.target.value.length > text.length) ping();
            // Feed autocompletes the new value + cursor position so
            // they can decide whether to open/close/refilter. Both
            // hooks check independently; their trigger zones don't
            // overlap (`@` vs `:`), so at most one is active at a
            // time.
            const caret = e.target.selectionStart ?? e.target.value.length;
            mentionAC.onChange(e.target.value, caret);
            emojiAC.onChange(e.target.value, caret);
          }}
          onKeyUp={(e) => {
            // Cursor moves via arrow keys / Home / End / mouse without
            // changing the value — re-detect to handle "cursor moved
            // out of (or into) an @-zone or :-zone".
            const ta = e.target as HTMLTextAreaElement;
            const caret = ta.selectionStart ?? 0;
            mentionAC.onChange(ta.value, caret);
            emojiAC.onChange(ta.value, caret);
          }}
          onClick={(e) => {
            const ta = e.target as HTMLTextAreaElement;
            const caret = ta.selectionStart ?? 0;
            mentionAC.onChange(ta.value, caret);
            emojiAC.onChange(ta.value, caret);
          }}
          onKeyDown={(e) => {
            // Autocompletes consume ArrowUp/ArrowDown/Enter/Tab/Esc
            // first when active. If either returns true, we stop here
            // so the same key doesn't ALSO submit the message.
            if (mentionAC.onKeyDown(e)) return;
            if (emojiAC.onKeyDown(e)) return;

            // Enter sends; Shift+Enter inserts a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
              return;
            }
            // Escape cancels a reply-in-progress (Discord pattern). Doesn't
            // touch text/files — those are still draftable. Only fires
            // when there's actually a reply, so it doesn't compete with
            // any other Esc handler the textarea might want.
            if (e.key === 'Escape' && replyTo) {
              e.preventDefault();
              onCancelReply?.();
            }
          }}
          onPaste={(e) => {
            // Paste an image straight from the clipboard (Cmd/Ctrl+V) as an
            // attachment — works in channels and DMs; goes through the same
            // path as a picked/captured image (compression + E2EE on send).
            const items = e.clipboardData?.items;
            if (!items || files.length >= MAX_FILES) return;
            const imgs: File[] = [];
            for (const it of items) {
              if (it.kind === 'file' && it.type.startsWith('image/')) {
                const f = it.getAsFile();
                if (f) imgs.push(f);
              }
            }
            if (imgs.length > 0) {
              e.preventDefault(); // don't also paste the image's name as text
              addFiles(imgs);
            }
          }}
          rows={1}
          enterKeyHint="send"
          placeholder={placeholder ?? `Message #${channel.name ?? ''}`}
          className="flex-1 min-w-0 bg-transparent outline-none resize-none placeholder:text-ink-3 leading-6 text-[16px] sm:text-sm py-1 self-center"
        />
        {mentionAC.popover}
        {emojiAC.popover}

        {/* Right-side icon cluster — poll, sticker, emoji, voice.
            All on the right of the textarea (Fluxer-style). The Send
            button is intentionally absent: Enter submits, Shift+Enter
            inserts a newline. The same handlers wire to the textarea's
            onKeyDown above. */}
        {/* Mobile tools toggle. Only shown on small screens — taps
            to reveal/hide the composer icon cluster, which would
            otherwise crowd the narrow composer. On sm+ the cluster
            is always inline so this toggle is hidden. */}
        <button
          type="button"
          onClick={() => setToolsOpen((v) => !v)}
          className="sm:hidden w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label={toolsOpen ? 'Hide options' : 'Show options'}
          aria-expanded={toolsOpen}
        >
          {toolsOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

        {/* Tool cluster — poll, schedule, sticker, emoji, voice.
            Collapsed behind the chevron on mobile (hidden unless
            toolsOpen); always inline on sm+ via `sm:!flex`. */}
        <div
          className={`${toolsOpen ? 'flex' : 'hidden'} sm:!flex items-center gap-0.5 shrink-0`}
        >
        {channel.type === 'guild_text' && (
          <button
            type="button"
            onClick={() => setPollModalOpen(true)}
            disabled={!!pollDraft}
            className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title={pollDraft ? 'Poll already attached' : 'Create poll'}
            aria-label="Create poll"
          >
            <BarChart size={16} />
          </button>
        )}

        {/* Schedule send. Always visible/clickable so users discover
            the affordance. Empty-text guard lives in the click handler
            with a toast so they get explicit feedback instead of a
            mysteriously-dead button. Hidden only when files are
            attached (v1 scheduling doesn't support attachments). */}
        {files.length === 0 && (
          <button
            type="button"
            onClick={() => {
              if (!text.trim()) {
                toasts.push('Type a message first, then schedule it.', 'info');
                return;
              }
              if (pending) return;
              setSchedulePickerOpen(true);
            }}
            className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title="Schedule send"
            aria-label="Schedule send"
          >
            <Calendar size={16} />
          </button>
        )}

        {channel.type === 'guild_text' && channel.guildId && (
          <StickerComposerSlot
            guildId={channel.guildId}
            open={stickerPickerOpen}
            onToggle={() => setStickerPickerOpen((v) => !v)}
            onClose={() => setStickerPickerOpen(false)}
            onPick={async (stickerId) => {
              setStickerPickerOpen(false);
              try {
                await onSend('', [], undefined, stickerId);
              } catch (e) {
                toasts.push(
                  e instanceof ApiError ? e.message : 'Sticker send failed',
                  'error',
                );
              }
            }}
          />
        )}

        <button
          type="button"
          onClick={() => setEmojiPickerOpen((v) => !v)}
          className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          title="Emoji"
          aria-label="Insert emoji"
          aria-expanded={emojiPickerOpen}
        >
          <Smile size={16} />
        </button>

        <button
          type="button"
          onClick={() => {
            if (recorder.status === 'idle') void recorder.start();
          }}
          disabled={recorder.status !== 'idle'}
          className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title="Record voice message"
          aria-label="Record voice message"
        >
          <Mic size={16} />
        </button>
        </div>

        {/* Send button — always visible, to the right of the tool
            cluster (stays put when the mobile cluster collapses).
            Enter still submits; this is the explicit/touch affordance.
            Enabled whenever there's something to send: text, an
            attachment, or a poll — so an attachment-only message sends
            with no text. submit() enforces the same rule. */}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={pending || (!text.trim() && files.length === 0 && !pollDraft)}
          className="w-8 h-8 flex items-center justify-center rounded-full shrink-0 self-center bg-accent text-bg-0 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          title="Send message"
          aria-label="Send message"
        >
          <ArrowUp size={16} />
        </button>

        {emojiPickerOpen && (
          <div className="absolute bottom-full right-0 mb-2 z-30">
            <EmojiPicker
              guildId={channel.guildId ?? null}
              onSelect={(code) => {
                insertAtCursor(code);
                setEmojiPickerOpen(false);
              }}
              onClose={() => setEmojiPickerOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── File preview row ───────────────────────────────────────────────────────

function FilePreviewRow({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {files.map((f, i) => (
        <FilePreviewItem key={`${f.name}-${i}`} file={f} onRemove={() => onRemove(i)} />
      ))}
    </div>
  );
}

function FilePreviewItem({ file, onRemove }: { file: File; onRemove: () => void }) {
  // For images, generate a blob URL so we can render an actual thumbnail.
  // The URL is revoked on unmount to prevent leaking memory across many
  // pick/remove cycles.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <div className="relative group">
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="w-16 h-16 rounded-md object-cover border border-line"
        />
      ) : (
        <div className="w-16 h-16 rounded-md bg-bg-2 border border-line flex flex-col items-center justify-center text-[0.65rem] text-ink-2 px-1 text-center">
          <span className="text-lg" aria-hidden>📄</span>
          <span className="truncate w-full">{file.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-bg-3 border border-line text-ink-1 text-xs flex items-center justify-center hover:bg-red-900 hover:border-red-800 hover:text-red-100 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}

// ── TypingIndicator ────────────────────────────────────────────────────────

function TypingIndicator({ channelId }: { channelId: string }) {
  // Granular subscription (was `useAppState()`): only the user cache drives
  // the typing names; presence/message/voice dispatches no longer re-render.
  const usersById = useAppStateSelector((v) => v.state.usersById);
  const userIds = useTypingUsers(channelId);
  if (userIds.length === 0) return <div className="h-5" aria-hidden />;

  // Resolve names from the user cache; fall back to a neutral label for ids
  // we don't recognize yet (shouldn't happen in practice, but keeps the UI
  // resilient if a typing event arrives for someone we haven't seen).
  const names = userIds
    .map((id) => usersById[id])
    .map((u) => u?.displayName ?? 'someone');

  let text: string;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = 'Several people are typing…';

  return (
    <div className="h-5 px-4 text-xs text-ink-2 italic flex items-center gap-1.5">
      <Dots />
      <span>{text}</span>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex gap-0.5">
      <span className="w-1 h-1 rounded-full bg-ink-3 animate-pulse" style={{ animationDelay: '0ms' }} />
      <span className="w-1 h-1 rounded-full bg-ink-3 animate-pulse" style={{ animationDelay: '150ms' }} />
      <span className="w-1 h-1 rounded-full bg-ink-3 animate-pulse" style={{ animationDelay: '300ms' }} />
    </span>
  );
}

/**
 * Format milliseconds as M:SS — used by the recording overlay's live
 * timer and the preview-state duration label. We round seconds rather
 * than truncating so the displayed time matches what the server
 * stores (which is also rounded).
 */
function formatRecordingTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/**
 * Decode the recorder's base64 waveform into a sample array for the
 * preview-state visual. Returns a 32-bar fallback shape on decode
 * failure so the preview never collapses to nothing.
 */
function decodeFinalWaveform(b64: string): number[] {
  try {
    const bin = atob(b64);
    const out: number[] = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return Array.from({ length: 32 }, () => 80);
  }
}

/**
 * StickerComposerSlot — composer button + portal-anchored picker.
 *
 * The picker is rendered into a Portal (see StickerPicker) so it can
 * float above the composer without being clipped by the chat header,
 * channel sidebar, or any ancestor with overflow:hidden. The trigger
 * button lives in the composer row; we hand its ref to the picker so
 * it can position itself just above and right-aligned to the button.
 */
function StickerComposerSlot({
  guildId,
  open,
  onToggle,
  onClose,
  onPick,
}: {
  guildId: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (stickerId: string) => void | Promise<void>;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={onToggle}
        className="w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
        title="Sticker"
        aria-label="Send sticker"
        aria-expanded={open}
      >
        <StickerSquare size={18} />
      </button>
      {open && (
        <StickerPicker
          guildId={guildId}
          anchorRef={btnRef}
          onClose={onClose}
          onPick={onPick}
        />
      )}
    </>
  );
}

/**
 * The recipient's name in the DM header, as a click target that opens the
 * shared ProfileCard popover.
 *
 * Its own component (rather than a `useProfileCard()` call up in MessageView)
 * for one reason: the hook owns open/close state, and MessageView is a very
 * large tree — parking that state here keeps opening the card from
 * re-rendering the whole message view.
 *
 * `label` is passed separately from `user` because the header shows the
 * viewer-private DM nickname when one is set, while the card itself should
 * still receive the real user object.
 */
function DmHeaderName({ user, label }: { user: PublicUser; label: string }) {
  const { onAvatarClick, cardElement } = useProfileCard();
  return (
    <>
      <button
        type="button"
        onClick={(e) => onAvatarClick(user, e)}
        className="font-semibold truncate min-w-0 text-left hover:underline decoration-ink-3/60 underline-offset-2 transition-colors"
        title={`View profile for ${label}`}
        aria-label={`View profile for ${label}`}
      >
        {label}
      </button>
      {cardElement}
    </>
  );
}

/**
 * Compact Call button in the DM header. Three visual states:
 *   - idle           — green phone, click to start a call
 *   - in-call        — red hangup, click to leave
 *   - incoming       — pulsing green phone, click to accept (same path as start)
 *
 * State derives entirely from voice state — no local optimistic
 * flags, so it stays in sync with what the gateway has actually
 * confirmed. When the call is active the split-screen layout in Shell
 * mounts VoiceView above MessageView with full controls (mute /
 * deafen / camera / screenshare / leave); this header button is the
 * quick-toggle affordance.
 */
function DmHeaderCallButton({ channel }: { channel: Channel }) {
  // Granular subscriptions (was `useAppState()`).
  const mergeChannelVoiceStates = useAppStateSelector((v) => v.mergeChannelVoiceStates);
  const rest = useAppStateSelector((v) => v.rest);
  const voiceStatesByUser = useAppStateSelector((v) => v.state.voiceStatesByUser);
  const supervision = useAppStateSelector((v) => v.state.supervision);
  const { user } = useAuth();
  const toasts = useToasts();

  const selfId = user?.id;
  const callStates = voiceStatesForChannel(voiceStatesByUser, channel.id);
  const myInThis = voiceStatesByUser[selfId ?? '']?.channelId === channel.id;
  const otherInThis = callStates.some((v) => v.userId !== selfId);
  const incoming = !myInThis && otherInThis;

  const [busy, setBusy] = useState(false);
  // Auto-join guard. The SW routes "Answer" taps on incoming-call
  // notifications to `?autojoin=1`; this effect picks up that hint
  // and fires start() exactly once per landing. We track the
  // channel id that was autojoined (not just a boolean) so a user
  // who lands on DM A via Accept, then later lands on DM B with
  // its own autojoin=1, doesn't get the second autojoin silently
  // skipped because a stale "we already autojoined" flag is still
  // true from the first one. Storing the id makes the check
  // channel-scoped.
  const autojoinedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (autojoinedForRef.current === channel.id) return;
    if (typeof window === 'undefined') return;
    const search = new URLSearchParams(window.location.search);
    if (search.get('autojoin') !== '1') return;
    autojoinedForRef.current = channel.id;
    // Strip the param immediately so it isn't picked up by a
    // re-render or a navigation refresh. replaceState doesn't
    // trigger a React-router update, which is what we want — the
    // route is already correct.
    search.delete('autojoin');
    const clean =
      window.location.pathname +
      (search.toString() ? `?${search.toString()}` : '') +
      window.location.hash;
    window.history.replaceState({}, '', clean);
    void start();
    // start is stable enough for our purposes — even if its
    // closure values drift between mount and effect run, start()
    // itself bails on the busy/myInThis checks. The channel.id
    // gate is the only meaningful change-detection here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  async function start() {
    if (busy || myInThis) return;
    // Parental controls: a supervised child barred from voice can't call.
    if (supervision?.restrictions && !supervision.restrictions.allowVoice) {
      toasts.push('Voice calls are restricted by your parent', 'error');
      return;
    }
    setBusy(true);
    // Prime shared audio context inside the click gesture's call stack
    // — see lib/voice.prepareVoiceAudio for the rationale.
    prepareVoiceAudio();
    // Claim the target BEFORE the REST call — the server fans our
    // VOICE_STATE_UPDATE out over the gateway before it writes the join
    // response, so the echo can arrive before connectToVoice runs and read
    // as "a moderator dragged me somewhere else."
    claimVoiceChannel(channel.id);
    try {
      const r = await rest.joinVoice(channel.id);
      mergeChannelVoiceStates(channel.id, r.channelVoiceStates);
      if (r.token && r.wsUrl) {
        try {
          await connectToVoice({
            token: r.token,
            wsUrl: r.wsUrl,
            sessionId: r.voiceState.sessionId,
            channelId: channel.id,
            isDmCall: channel.type === 'dm',
            // Encrypt the call media when this 1:1 DM has E2EE on, using
            // the same shared key the DM uses for messages.
            ...(channel.type === 'dm' && channel.e2eeEnabled
              ? { e2ee: { channelId: channel.id, verifier: channel.e2eeVerifier } }
              : {}),
          });
        } catch (e) {
          // Roll back the server-side join so a failed media connect doesn't
          // strand us as a silent ghost — for a 1:1 DM call that means the
          // other party sits in dead air with someone who "answered." The
          // gateway echoes the leave. Best-effort.
          void rest.leaveVoice(channel.id).catch(() => {});
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
        toasts.push('Voice isn’t set up on this server yet, so there’s no audio. Ask the server admin to enable voice.', 'info');
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to start call', 'error');
    } finally {
      // Release the claim on every exit — connectToVoice clears it when it
      // settles, but the REST-failed / no-token paths never call it, and a
      // stranded claim would make getConnectedChannelId() lie.
      releaseVoiceChannel(channel.id);
      setBusy(false);
    }
  }

  async function leave() {
    if (busy || !myInThis) return;
    setBusy(true);
    try {
      await disconnectVoice();
      try {
        await rest.leaveVoice(channel.id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          toasts.push(e instanceof ApiError ? e.message : 'Failed to hang up', 'error');
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // In an active 1:1 DM call (both parties connected), Shell renders
  // the split-screen layout with VoiceView at the top — VoiceView's
  // Leave button is the canonical hangup affordance there. Rendering
  // the same hangup in this header creates a second redundant
  // trigger, so suppress it.
  if (myInThis && otherInThis && channel.type === 'dm') {
    return null;
  }

  if (myInThis) {
    return (
      <button
        type="button"
        onClick={() => void leave()}
        disabled={busy}
        className="w-8 h-8 flex items-center justify-center rounded text-red-300 hover:text-red-200 hover:bg-red-900/40 disabled:opacity-50"
        aria-label="Hang up"
        title="Hang up"
      >
        <PhoneOff size={16} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={busy}
      className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
        incoming
          ? 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60 animate-pulse'
          : 'text-ink-3 hover:text-emerald-300 hover:bg-bg-3'
      } disabled:opacity-50`}
      aria-label={incoming ? 'Accept incoming call' : 'Start call'}
      title={incoming ? 'Accept incoming call' : 'Start a call'}
    >
      <Phone size={16} />
    </button>
  );
}

/**
 * DM header poke/nudge button. Tapping opens a small palette (the swipeable
 * variant set on iOS / the watch; a click-to-send row here); each emoji fires
 * POST /channels/:id/poke. The poke is an ephemeral nudge — it leaves no
 * message; the recipient gets a transient toast (or big-emoji push when away).
 */
/** Compact relative time for the poke-history lines ("just now", "2m", "3h", "5d"). */
function pokeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function DmHeaderPokeButton({ channel }: { channel: Channel }) {
  const rest = useAppStateSelector((v) => v.rest);
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<PokeHistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Fetch the recent-pokes history each time the popover opens (refetch-on-open
  // keeps it simple; the list is capped at 6 server-side).
  const toggle = () => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      if (next) {
        setLoadingHistory(true);
        void rest
          .listPokes(channel.id)
          .then((r) => setHistory(r.pokes))
          .catch(() => setHistory([]))
          .finally(() => setLoadingHistory(false));
      }
      return next;
    });
  };

  const send = async (pokeType: PokeType) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await rest.poke(channel.id, pokeType);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not send that poke', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        className="group w-8 h-8 flex items-center justify-center rounded hover:bg-bg-3 transition-colors disabled:opacity-50"
        aria-label="Poke"
        title="Poke / nudge"
        aria-expanded={open}
      >
        {/* The 👉 pointing-hand emoji, greyed out (grayscale + dimmed) so it
            sits quietly next to the grayscale Search/Call/Settings icons;
            it regains its color on hover. */}
        <span
          aria-hidden
          className="text-[16px] leading-none grayscale opacity-60 group-hover:grayscale-0 group-hover:opacity-100 transition"
        >
          👉
        </span>
      </button>
      {open && (
        <>
          {/* Click-away backdrop (local, not a portal) */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-9 z-20 w-60 rounded-lg border border-line bg-bg-2 p-2 shadow-lg">
            {/* Recent pokes from this person (max 6). */}
            <div className="px-1 pb-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-ink-3">
              Recent pokes
            </div>
            {loadingHistory ? (
              <div className="px-1 pb-2 text-xs text-ink-3">Loading…</div>
            ) : history.length === 0 ? (
              <div className="px-1 pb-2 text-xs text-ink-3">No pokes yet — say hi below.</div>
            ) : (
              <ul className="pb-1.5 max-h-40 overflow-y-auto">
                {history.map((p) => {
                  const v = POKE_VARIANTS[p.pokeType as PokeType] ?? POKE_VARIANTS.poke;
                  return (
                    <li
                      key={p.id}
                      className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-ink-1"
                    >
                      <span aria-hidden className="text-[15px] leading-none shrink-0">
                        {v.emoji}
                      </span>
                      <span className="truncate">
                        <span className="font-medium">{p.initiatorName}</span>{' '}
                        <span className="text-ink-2">{v.verb}</span>
                      </span>
                      <span className="ml-auto shrink-0 text-[0.65rem] text-ink-3">
                        {pokeAgo(p.createdAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Poke palette — click an emoji to send. */}
            <div className="flex items-center gap-0.5 border-t border-line pt-1.5">
              {POKE_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => void send(t)}
                  className="w-8 h-8 flex items-center justify-center rounded hover:bg-bg-3 text-[17px] leading-none"
                  aria-label={POKE_VARIANTS[t].label}
                  title={POKE_VARIANTS[t].label}
                >
                  <span aria-hidden>{POKE_VARIANTS[t].emoji}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
