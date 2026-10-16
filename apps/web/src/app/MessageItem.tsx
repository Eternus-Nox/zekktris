/**
 * MessageItem
 * -----------
 * Renders one message. When `continuation` is true, the avatar/header is
 * suppressed and the message text aligns under the previous one — this
 * produces the visual "thread" effect for back-to-back messages from the
 * same author.
 *
 * Edit/delete UI: hover-revealed buttons at the right edge. Only shown on
 * own messages for v1; mod-delete-others is deferred to a follow-up.
 *
 * Content rendering: passes through `renderMessageContent` which handles
 * inline markdown (bold/italic/code), mentions (resolved against the
 * AppState user cache), and auto-linking. Attachments and reactions render
 * as their own components below the text.
 */

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { UserTag, staffShimmerColor } from '../lib/UserTag';
import type { Channel, Message, MessageEmbed } from '@zekktris/client';
import { ApiError } from '@zekktris/client';
import { useAppStateSelector, useDmNickname, isUserBlocked } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { renderMessageContent } from '../lib/markdown';
import { maskProfanity } from '../lib/profanity';
import { memberDisplayColor } from '../lib/permissions';
import { Reactions } from './Reactions';
import { Attachments } from './Attachments';
import { MessageEmbeds } from './MessageEmbeds';
import { PollMessage } from './PollMessage';
import { ForwardedMessageBlock } from './ForwardedMessageBlock';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { AvatarDecoration } from '../lib/avatarDecorations';
import { useProfileCard } from '../lib/useProfileCard';
import { Edit, Trash, Pin, CornerUpLeft, Forward as ForwardIcon, MessageSquare, Smile, Phone, Shield, Bookmark } from '../lib/icons';
import { useE2eeLinkPreviews } from '../lib/e2eeLinkPreviews';
import { e2eeSupported, E2EE_INSECURE_SHORT } from '../lib/e2eeSupport';
import { decryptForDm, peekDecryptedText, encryptForDm, isEncryptedWireFormat, hasLocalKey, subscribeToKeyChanges, getKeyVersion } from '../lib/e2ee';
import { POKE_VARIANTS, type PokeType } from '../lib/poke';
import { ForwardModal } from './ForwardModal';
import { EmojiPicker } from './EmojiPicker';

interface Props {
  message: Message;
  /** True when this message is rendered under a same-author predecessor. */
  continuation: boolean;
  selfId: string | undefined;
  /** Optional reply callback — clicking the Reply hover button surfaces
      the message to the parent so the composer can pick it up. Omitted
      in contexts that don't have a composer (search results panel,
      pinned-messages panel) — the button hides when this is missing. */
  onReply?: (m: Message) => void;
  /** Override for the channel hover actions resolve against. PinPanel
      and SearchPanel render messages outside their parent channel's
      Scroller; they pass the channel explicitly so pin/edit checks
      still resolve correctly. */
  channel?: Channel;
  /** Render the Sent/Delivered/Read indicator at the bottom-right of
      the message body. Caller decides where it goes (see MessageView,
      which sets it on the sender's last own message in a 1:1 DM
      only). When false / unset, no receipt UI is rendered at all —
      the row is identical to a non-DM render. */
  showDmReceipt?: boolean;
}

// Extract http(s) URLs from text for client-side link-preview resolution on
// E2EE messages. Mirrors the server's message extractor (services/embeds.ts):
// same conservative regex + trailing-punctuation trim, deduped, capped.
const URL_RE = /https?:\/\/[^\s<>"]+/gi;
function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let m of matches) {
    while (m.length > 0 && /[.,;!?)]$/.test(m)) m = m.slice(0, -1);
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
    if (out.length >= 5) break;
  }
  return out;
}

// ── Channel mentions ──────────────────────────────────────────────────────
// `<#123>` tokens in a message body — the same token lib/markdown.tsx turns
// into a channel chip (its group 8). We extract the ids per row so the row can
// resolve ONLY the channels it actually references out of AppState, instead of
// subscribing to the whole `state.channelsByGuild` map. That map's reference is
// replaced on EVERY message in EVERY guild channel (the lastMessageId bump in
// bumpGuildRecency rebuilds it), so subscribing to it re-rendered — and
// re-ran the markdown/mention parse for — every mounted MessageItem on every
// single incoming message. The overwhelming majority of messages mention no
// channel at all, so the narrow subscription below settles on a constant.
const CHANNEL_MENTION_RE = /<#(\d+)>/g;
/** Stable empty results so the "no mentions" path never flips a reference. */
const NO_MENTION_IDS: string[] = [];
type MentionedChannel = { channel: Channel; guildId: string };
const NO_MENTIONED_CHANNELS: Record<string, MentionedChannel> = {};

function channelMentionIds(text: string): string[] {
  // Cheap bail before touching the regex — nearly every message takes it.
  if (!text.includes('<#')) return NO_MENTION_IDS;
  const out: string[] = [];
  CHANNEL_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHANNEL_MENTION_RE.exec(text)) !== null) {
    const id = m[1]!;
    if (!out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : NO_MENTION_IDS;
}

/**
 * One-line preview of a reply's parent message — shared by the in-stream
 * quote bar and the composer's reply chip. Mirrors iOS replyPreviewText
 * (MessageViews.swift): an E2EE parent shows this device's cached
 * plaintext when it has already been decrypted — NEVER the raw
 * `zkE2EE/…` wire string — or a lock label otherwise; an empty-text
 * parent falls back to a typed sticker/voice/attachment/poll label.
 */
export function replyPreviewText(m: Message, filterProfanity = false): string {
  let text = m.content;
  if (isEncryptedWireFormat(text)) {
    const cached = peekDecryptedText(text, m.channelId);
    if (cached === null) return '🔒 Encrypted message';
    text = cached;
  }
  if (filterProfanity && text) text = maskProfanity(text);
  if (text) return text;
  if (m.stickerId) return '🏷️ Sticker';
  if (m.attachments.some((a) => a.isVoiceMessage)) return '🎤 Voice message';
  if (m.attachments.length > 0) return '📎 Attachment';
  if (m.poll) return '📊 Poll';
  return 'Message';
}

function MessageItemBase({ message, continuation, selfId, onReply, channel, showDmReceipt }: Props) {
  // Granular selectors instead of `useAppState()`. The previous code
  // pulled the full context value, which meant any state change
  // anywhere re-rendered every visible MessageItem — a 50-message
  // channel paying 50 row re-renders for every typing indicator,
  // presence update, or unrelated event. Each selector below
  // subscribes to exactly the slice this component reads; reference
  // equality on the selector's return value gates re-renders.
  //
  // Callbacks (retrySendMessage, discardFailedMessage) are
  // useCallback-stable so selecting them via context-selector is
  // essentially free — the returned reference doesn't change between
  // dispatches and useContextSelector bails. State slices change
  // independently per the reducer's structural sharing; selecting
  // each top-level slice means we only re-render when that slice's
  // reference flips. The PRESENCE_PATCH/USER_REPLACE bail-early
  // fixes (#11a/#11b) ensure no-op events don't flip slice references
  // unnecessarily, so this migration's payoff is real.
  const retrySendMessage = useAppStateSelector((v) => v.retrySendMessage);
  const rest = useAppStateSelector((v) => v.rest);
  const discardFailedMessage = useAppStateSelector((v) => v.discardFailedMessage);
  const membersByGuild = useAppStateSelector((v) => v.state.membersByGuild);
  const rolesByGuild = useAppStateSelector((v) => v.state.rolesByGuild);
  const relationships = useAppStateSelector((v) => v.state.relationships);
  // NOTE: deliberately NOT subscribing to state.channelsByGuild here. The
  // reducer replaces that map on every message received in any guild channel
  // (forward-only lastMessageId bump), so a whole-map subscription invalidated
  // every mounted MessageItem — the hottest render path in the app — on every
  // single message. Everything this row needed from it is now derived from the
  // `channel` prop, or read through the narrow per-message selectors below
  // (mentioned channels, anchored thread).
  // Parental control: a supervised child's message views mask swear words.
  const filterProfanity = useAppStateSelector(
    (v) => v.state.supervision?.restrictions?.filterProfanity ?? false,
  );
  const emojisByGuild = useAppStateSelector((v) => v.state.emojisByGuild);
  const usersById = useAppStateSelector((v) => v.state.usersById);
  // Resolve the reply-quote PARENT directly in the selector instead of
  // subscribing to the whole per-channel array. Subscribing to the array
  // re-rendered EVERY visible row on every append/edit/reaction/receipt in the
  // open channel (the array ref flips), defeating React.memo on the hottest
  // path. useContextSelector compares the selector's RESULT by Object.is, and
  // the reducer preserves individual message object refs across sibling
  // mutations — so a non-reply row selects a constant `null`, and a reply row
  // re-renders only when ITS parent message object actually changes.
  const repliedTo = useAppStateSelector((v) =>
    message.replyToId
      ? v.state.messagesByChannel[message.channelId]?.find((m) => m.id === message.replyToId) ?? null
      : null,
  );
  const guildsById = useAppStateSelector((v) => v.state.guildsById);
  const savedMessageIds = useAppStateSelector((v) => v.state.savedMessageIds);
  const toggleSavedMessage = useAppStateSelector((v) => v.toggleSavedMessage);
  const isSaved = savedMessageIds.has(message.id);
  const { onAvatarClick, cardElement } = useProfileCard({ guildId: channel?.guildId ?? undefined });
  const toasts = useToasts();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const [pendingEdit, setPendingEdit] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  // Per-message reveal toggle for blocked authors. The block list
  // hides messages by default; clicking the placeholder reveals THIS
  // ONE message. Doesn't persist across re-renders if the row scrolls
  // out of view, which matches the "I'm checking what they said
  // because I have to, not because I want to read their feed" intent.
  const [revealed, setRevealed] = useState(false);
  // Per-message tap-to-show actions toggle. On desktop the action bar
  // appears on hover (CSS-driven, no JS state needed). On touch
  // devices there's no hover, so previously the bar was always shown
  // — visually noisy. Now: tap the message to toggle the bar; tap
  // again or tap elsewhere to dismiss. The document-level click
  // listener below handles the "tap elsewhere" case.
  const [actionsOpen, setActionsOpen] = useState(false);
  const [showForward, setShowForward] = useState(false);
  // React-from-hover-strip picker. Replaces the standalone "+ react"
  // pill that used to render below messages with zero reactions.
  // The picker anchors below the React button in the action strip;
  // we keep a ref so a future revision can position relative to it
  // (currently it floats to the right of the message row).
  const [reactPickerOpen, setReactPickerOpen] = useState(false);
  const reactBtnRef = useRef<HTMLButtonElement | null>(null);
  const messageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!actionsOpen) return;
    function onDocClick(e: MouseEvent) {
      // Close when tapping anywhere outside this message row. Inside
      // the row we leave the action bar alone — its own buttons handle
      // their own clicks (and the message body is a fine target for
      // re-tapping to dismiss, which we want).
      const el = messageRef.current;
      if (el && !el.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    }
    // Use a capture-phase listener so we run before any nested
    // stopPropagation handlers can swallow the event.
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, [actionsOpen]);

  const isOwn = selfId !== undefined && message.authorId === selfId;
  // Authors can edit/delete their own message only within a minute of posting
  // (the server enforces this; here we hide the controls to match).
  const [, recheckMutateWindow] = useState(0);
  const withinMutateWindow = Date.now() - new Date(message.createdAt).getTime() <= 60_000;
  // React.memo would otherwise leave Edit/Delete shown past 60s until some
  // unrelated re-render; arm a one-shot timer (only for your own, still-mutable
  // message) to re-render right when the window closes so they disappear on time.
  useEffect(() => {
    if (!isOwn) return;
    const msLeft = 60_000 - (Date.now() - new Date(message.createdAt).getTime());
    if (msLeft <= 0) return;
    const t = setTimeout(() => recheckMutateWindow((n) => n + 1), msLeft + 50);
    return () => clearTimeout(t);
  }, [isOwn, message.createdAt]);
  const author = message.author;
  // Webhook persona: when message.webhookId is set, the message was
  // posted via an incoming webhook. The author embedded in the DTO is
  // still the webhook's owner (so audit/mention math work) but the
  // displayed identity should be the webhook's name + avatar, with
  // per-message overrides taking precedence over the webhook's stored
  // persona. We compute a single "displayName/displayAvatar" pair used
  // throughout the row so we don't have to thread the webhook check
  // into every render site.
  const isWebhook = !!message.webhookId;
  // A webhook is its own persona — never fall back to the creator's name or
  // avatar (that's the owner row, kept only for audit/mention math). If the
  // webhook has no avatar set, displayAvatarUrl is null and the avatar gutter
  // renders neutral initials on a webhook-id tone instead of the owner's pic.
  // Personal DM nickname (viewer-private): in a DM, the peer's messages show
  // the nickname the viewer set for them, in place of their real name.
  const isDmChannel = channel?.type === 'dm' || channel?.type === 'group_dm';
  const authorDmNick = useDmNickname(!isWebhook ? author?.id : undefined);
  const displayName = isWebhook
    ? message.authorOverrideName || 'Webhook'
    : ((isDmChannel ? authorDmNick : undefined) ?? author?.displayName ?? 'Unknown');
  const displayAvatarUrl = isWebhook
    ? (message.authorOverrideAvatar ?? null)
    : (author?.avatarUrl ?? null);
  const initials = avatarInitials(displayName);
  // Avatar tone: deterministic per-id for users; for webhooks we use
  // the webhook id so two webhooks in the same channel get distinct
  // tones, instead of inheriting the owner's tone.
  const avatarTone = avatarColor(isWebhook ? message.webhookId : author?.id);

  // Resolve the author's display color from their highest-positioned
  // role with a non-zero color. This needs the guild's role list AND
  // the author's role assignments — both come from AppState (loaded
  // lazily by the member-list and role-tab paths). When either piece
  // is missing the helper returns null and we fall back to text-ink-1.
  // We don't trigger a load here because that would fire on every
  // message render; the channel-load path already arranges for
  // members + roles to come in.
  const guildId = channel?.guildId ?? undefined;
  const authorMember =
    guildId && author
      ? membersByGuild[guildId]?.find((m) => m.userId === author.id)
      : undefined;
  const guildRoles = guildId ? rolesByGuild[guildId] : undefined;
  const authorRoleColor =
    guildId && author && guildRoles && authorMember
      ? memberDisplayColor(guildRoles, guildId, authorMember.roleIds)
      : null;
  // Instance-staff shimmer overrides the role color entirely (null otherwise).
  const authorShimmer = author ? staffShimmerColor(author) : null;

  // Block enforcement: precomputed here, applied at render time below
  // (after all hooks are declared so the hook order stays stable
  // across the blocked → revealed → unblocked transitions).
  const blockedHidden =
    !!author &&
    !isOwn &&
    isUserBlocked(relationships, author.id) &&
    !revealed;

  // (renderCtx — the lookup context handed to renderMessageContent — is built
  // further down, right above `renderedContent`. It needs `displayContent`
  // (the decrypted body for E2EE rows) to know which channel mentions to
  // resolve, so it can't be assembled until decryption has been classified.)

  // ── E2EE decryption ─────────────────────────────────────────────────────
  // If the content is wrapped in our `zkE2EE/1:` wire format, attempt
  // to decrypt with the other party's public key + my local private
  // key. Decryption uses the precomputed shared key flavor of
  // crypto_box, so the same code path works whether I'm the sender
  // OR the recipient — the "other party" is just whoever isn't me
  // in the 1:1 DM.
  //
  // Three buckets:
  //   - Not encrypted (plain content) → render as-is
  //   - Encrypted + decryptable      → render the plaintext + lock icon
  //   - Encrypted + decryption failed → render a tombstone placeholder
  //                                     instead of the base64 ciphertext
  // Subscribe to E2EE key changes so we re-render (and re-run the
  // decryption useMemo below) the moment a local key becomes
  // available. Without this, messages rendered BEFORE the user
  // unlocks the conversation stay rendered in the "no-key"
  // tombstone state — the memo only depends on message.content +
  // channel, neither of which changes when a key is saved.
  const keyVersion = useSyncExternalStore(subscribeToKeyChanges, getKeyVersion, getKeyVersion);

  // Synchronous classification — cheap, runs every render with no async.
  // Decides whether the message is encrypted and whether we even have a key,
  // so the locked / "enter password" tombstone shows instantly without
  // waiting on the async cipher below.
  const encMeta = useMemo<{ isEncrypted: boolean; noKey: boolean }>(() => {
    if (!isEncryptedWireFormat(message.content)) {
      return { isEncrypted: false, noKey: false };
    }
    // No channel, or no local key cached on this device yet → can't decrypt;
    // the UI should prompt "enter password" rather than "couldn't decrypt".
    if (!channel || !hasLocalKey(channel.id)) {
      return { isEncrypted: true, noKey: true };
    }
    return { isEncrypted: true, noKey: false };
    // keyVersion is in the deps so a fresh unlock re-runs classification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.content, channel, channel?.id, keyVersion]);

  // AES-256-GCM decryption is async (WebCrypto), so the plaintext arrives via
  // effect + state rather than synchronously in a memo.
  //   plaintext === null && failed === false → still decrypting (transient)
  //   plaintext === null && failed === true  → have a key but it didn't work
  //                                             (rotated key / corrupt / v1)
  const [decResult, setDecResult] = useState<{ plaintext: string | null; failed: boolean }>(() => {
    // Seed synchronously from the decrypted-text cache so a row scrolled back
    // into view (virtua re-mounts it) paints plaintext on the FIRST frame
    // instead of flashing empty then filling a frame later.
    if (encMeta.isEncrypted && !encMeta.noKey && channel) {
      const hit = peekDecryptedText(message.content, channel.id);
      if (hit !== null) return { plaintext: hit, failed: false };
    }
    return { plaintext: null, failed: false };
  });
  useEffect(() => {
    if (!encMeta.isEncrypted || encMeta.noKey || !channel) {
      // Nothing to decrypt — reset so nothing stale lingers.
      setDecResult({ plaintext: null, failed: false });
      return;
    }
    // Don't blank an already-shown plaintext while re-decrypting (e.g. on an
    // unrelated keyVersion bump) — only the resolved value replaces it, which
    // avoids a flash of empty content. Stale async results are dropped.
    let cancelled = false;
    void decryptForDm(message.content, channel.id).then((plain) => {
      if (cancelled) return;
      setDecResult({ plaintext: plain, failed: plain === null });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.content, channel, channel?.id, encMeta.isEncrypted, encMeta.noKey, keyVersion]);

  // Client-side link previews for E2EE messages. The server can't unfurl
  // ciphertext, so an E2EE message arrives with embeds: []; once we have the
  // decrypted plaintext we extract URLs and resolve previews via /unfurl.
  // That sends each link to the server, so it only happens when the user
  // opted in on this device ("Link previews in encrypted chats", default off).
  const e2eeLinkPreviews = useE2eeLinkPreviews();
  const [e2eeEmbeds, setE2eeEmbeds] = useState<MessageEmbed[]>([]);
  useEffect(() => {
    const plain = decResult.plaintext;
    // Only for E2EE messages with no server-resolved embeds and a successful
    // decryption.
    if (!e2eeLinkPreviews || !encMeta.isEncrypted || encMeta.noKey || !plain) {
      setE2eeEmbeds([]);
      return;
    }
    if (message.embeds && message.embeds.length > 0) {
      setE2eeEmbeds([]);
      return;
    }
    const urls = extractUrls(plain);
    if (urls.length === 0) {
      setE2eeEmbeds([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const found: MessageEmbed[] = [];
      for (const u of urls) {
        try {
          const { embed } = await rest.unfurl(u);
          if (embed) found.push(embed);
        } catch {
          // best-effort per URL
        }
      }
      if (!cancelled) setE2eeEmbeds(found);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e2eeLinkPreviews, decResult.plaintext, encMeta.isEncrypted, encMeta.noKey, message.embeds, message.channelId]);

  // Combined view in the original shape the rest of the component consumes.
  const decryption: {
    plaintext: string | null;
    isEncrypted: boolean;
    failed: boolean;
    /** Sub-state of `failed`: did decryption fail because we lack a local key
        (user hasn't entered the password), or because the key was wrong / the
        message is corrupted? Lets the UI distinguish "🔒 enter password" from
        "couldn't decrypt — keys changed". */
    noKey: boolean;
  } = !encMeta.isEncrypted
    ? { plaintext: null, isEncrypted: false, failed: false, noKey: false }
    : encMeta.noKey
      ? { plaintext: null, isEncrypted: true, failed: true, noKey: true }
      : {
          plaintext: decResult.plaintext,
          isEncrypted: true,
          failed: decResult.failed,
          noKey: false,
        };

  // What the renderer + edit composer should see. For encrypted
  // messages that decrypted successfully, this is the plaintext.
  // For plaintext messages it's the original content. For
  // encrypted-but-failed messages it's the empty string (the
  // tombstone placeholder takes over the render slot below).
  const displayContent = decryption.isEncrypted
    ? decryption.plaintext ?? ''
    : message.content;

  // ── Channel-mention resolution ─────────────────────────────────────────
  // Resolve ONLY the channels THIS message mentions, instead of subscribing
  // to the whole channelsByGuild map (see the note at the top of the hook
  // block). Almost every message mentions none, in which case the selector
  // returns a module-level constant and never re-renders the row.
  //
  // The selector's RESULT is what useContextSelector compares (Object.is), so
  // the built map has to be reference-stable across dispatches that didn't
  // change anything we read. We memoise it behind a signature covering
  // exactly what a mentioned channel contributes to the render: its id, its
  // owning guild (for the click target) and its name (for the chip label).
  const mentionedChannelIds = useMemo(
    () => channelMentionIds(displayContent),
    [displayContent],
  );
  const mentionedChannelsCache = useRef<{ sig: string; value: Record<string, MentionedChannel> }>({
    sig: '',
    value: NO_MENTIONED_CHANNELS,
  });
  const mentionedChannels = useAppStateSelector((v) => {
    if (mentionedChannelIds.length === 0) return NO_MENTIONED_CHANNELS;
    const value: Record<string, MentionedChannel> = {};
    let sig = '';
    for (const id of mentionedChannelIds) {
      for (const [gid, list] of Object.entries(v.state.channelsByGuild)) {
        const found = list.find((c) => c.id === id);
        if (!found) continue;
        value[id] = { channel: found, guildId: gid };
        sig += `${id} ${gid} ${found.name ?? ''}`;
        break;
      }
    }
    // Nothing resolved → sig stays '' → falls back to the initial cache entry,
    // which is the shared empty map. Correct: there is nothing to look up.
    const cached = mentionedChannelsCache.current;
    if (cached.sig === sig) return cached.value;
    mentionedChannelsCache.current = { sig, value };
    return value;
  });

  // Build the lookup context for renderMessageContent. We re-bind only when
  // the underlying maps change — usersById/emojisByGuild are stable
  // references between most renders thanks to the reducer's structural
  // sharing, and mentionedChannels is the signature-memoised narrow slice
  // built just above.
  const renderCtx = useMemo(
    () => {
      // Channel may be a DM (no guildId) — DMs don't have custom emoji
      // since emoji are guild-scoped, so `lookupEmoji` returns undefined
      // and `:name:` tokens stay as text. For guild channels, we look
      // up `message.channelId`'s owning guild to find the right emoji
      // index.
      // The message's channel is the one being viewed (the `channel` prop), so
      // there's no need to scan every guild's channel list to find it — pure
      // waste on every row, and in a DM the scan always finds nothing. DMs have
      // no custom (guild) emoji, so guildEmojis is undefined there.
      const guildEmojis =
        channel?.guildId != null ? emojisByGuild[channel.guildId] : undefined;

      return {
        // usersById is seeded only from message authors, so a DM mention of
        // someone who hasn't sent a loaded message would miss → "@unknown".
        // Fall back to the DM recipients and this message's author so DM
        // mentions resolve to the real name.
        lookupUser: (id: string) =>
          usersById[id] ??
          channel?.recipients?.find((r) => r.id === id) ??
          (message.author?.id === id ? message.author : undefined),
        // Pre-resolved above from the ids this message actually mentions —
        // no global channel scan on the hot path, and no whole-map
        // subscription to keep it fresh.
        lookupChannel: (id: string) => mentionedChannels[id]?.channel,
        selfUserId: selfId,
        onChannelClick: (channelId: string) => {
          // The owning guild was resolved alongside the channel, so the URL
          // is built without re-scanning every guild's channel list.
          const gid = mentionedChannels[channelId]?.guildId;
          if (gid) nav(`/channels/${gid}/${channelId}`);
        },
        onUserClick: onAvatarClick,
        lookupEmoji: guildEmojis
          ? (name: string) => guildEmojis.find((e) => e.name === name)
          : undefined,
      };
    },
    [usersById, mentionedChannels, emojisByGuild, selfId, nav, message.author, channel?.guildId, channel?.recipients, onAvatarClick],
  );

  // Memoize the rendered content so we don't re-run the inline-markdown
  // regex passes on every parent re-render. useAppState() makes
  // MessageItem re-render on every state change anywhere in the app,
  // and the message body is the most expensive piece of the per-row
  // render — mentions/channels/emojis/URLs each cost a pattern pass.
  // The deps are `displayContent` (decrypted text for E2EE messages
  // or raw content otherwise) and `renderCtx` (memoized just above),
  // so this memo bails on the common no-content-change render.
  const renderedContent = useMemo(
    () =>
      renderMessageContent(
        filterProfanity ? maskProfanity(displayContent) : displayContent,
        renderCtx,
      ),
    [displayContent, renderCtx, filterProfanity],
  );

  async function saveEdit() {
    const trimmed = editText.trim();
    if (!trimmed) {
      setEditErr('Content cannot be empty');
      return;
    }
    setPendingEdit(true);
    setEditErr(null);
    // Re-encrypt for the edit if the original was E2EE. Edits of
    // plaintext messages stay plaintext; edits of encrypted messages
    // stay encrypted. Skipping the re-encryption would leak plaintext
    // into the audit history.
    let outgoing = trimmed;
    if (decryption.isEncrypted) {
      // Never fall back to sending plaintext for an encrypted message —
      // that would leak cleartext into server-stored history for a
      // conversation the user believes is end-to-end encrypted. Require a
      // channel and a live key, and abort (rather than degrade) otherwise.
      if (!channel || !hasLocalKey(channel.id)) {
        setEditErr('Enter the conversation password to edit.');
        setPendingEdit(false);
        return;
      }
      const encrypted = await encryptForDm(trimmed, channel.id, channel.e2eeVerifier);
      if (!encrypted) {
        setEditErr('Encryption failed — message not changed.');
        setPendingEdit(false);
        return;
      }
      outgoing = encrypted;
    }
    try {
      await rest.editMessage(message.channelId, message.id, outgoing);
      setEditing(false);
    } catch (e) {
      setEditErr(e instanceof ApiError ? e.message : 'Edit failed');
    } finally {
      setPendingEdit(false);
    }
  }

  async function deleteMessage() {
    // Confirm — for v1 a native confirm() is enough; replaced with a styled
    // modal in the polish pass.
    if (!confirm('Delete this message?')) return;
    try {
      await rest.deleteMessage(message.channelId, message.id);
    } catch (e) {
      // No state to roll back; the gateway will deliver the delete event.
      // If REST failed, the event won't come, and the message stays —
      // which surfaces the failure honestly.
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    }
  }

  /**
   * Toggle pin/unpin. Optimistic update is skipped — the gateway will
   * deliver MESSAGE_UPDATE within a frame or two, and pin actions are
   * rare enough that the round-trip latency isn't noticeable. If the
   * REST call fails (e.g. the user lacks MANAGE_MESSAGES because their
   * role just changed) the toast surfaces the error.
   */
  async function togglePin() {
    try {
      if (message.pinned) {
        await rest.unpinMessage(message.channelId, message.id);
      } else {
        await rest.pinMessage(message.channelId, message.id);
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Pin/unpin failed', 'error');
    }
  }

  // Thread creation from text-channel messages was removed when
  // threads moved exclusively under the forum system. The createThread
  // REST endpoint still exists for the future forum-post flow. The
  // existingThread badge further down (back-compat for threads created
  // before this change) remains navigable but no new threads are
  // started from this surface.

  // (repliedTo — the parent message for the quote bar — is resolved directly
  // in the selector above. If the parent isn't loaded, e.g. it's older than the
  // scroll-back window, it's null and the UI falls back to a placeholder so the
  // user still knows there WAS a reply.)

  // Permission gate for Pin: any guild member with MANAGE_MESSAGES on the
  // channel. We don't compute the bitfield here (it's expensive and
  // would re-run on every render); instead we use the simpler heuristic
  // that the message author OR a guild owner sees the pin button.
  // The server still enforces; client-side gating is just to avoid
  // showing buttons that 403. Refining this with full permission
  // resolution is a polish item.
  // The owning guild used to be found by scanning every guild's channel list,
  // which is what forced the whole-map subscription. The row already receives
  // its channel as a prop (all three call sites — MessageView, PinPanel,
  // SearchPanel — pass it), and guild-scoped search results are still inside
  // that same guild, so `channel.guildId` is the same answer without the scan.
  // DMs (and the no-channel-prop case) have no guild → null, exactly as the
  // scan returned before since DM channels never live in channelsByGuild.
  const guildIdForChannel = channel?.guildId ?? null;
  const guild = guildIdForChannel ? guildsById[guildIdForChannel] : undefined;

  // A "member joined" welcome (system_join) is authored, in the data, by the
  // joining user — but it reads as the SERVER welcoming the newcomer, so we
  // swap the author identity to the guild's name + icon (the welcome body
  // still @-mentions the newcomer). isServerAuthor also suppresses the
  // profile click, role color, clan tag, and avatar decoration for this row.
  const isServerAuthor = message.type === 'system_join';
  const authorDisplayName = isServerAuthor ? (guild?.name ?? 'Server') : displayName;
  const authorAvatarUrl = isServerAuthor ? (guild?.iconUrl ?? null) : displayAvatarUrl;
  const authorInitials = isServerAuthor ? avatarInitials(guild?.name ?? 'Server') : initials;
  const authorAvatarTone = isServerAuthor ? avatarColor(guild?.id) : avatarTone;
  // Whether the author name/avatar is an interactive (profile-opening) user.
  const authorInteractive = !isWebhook && !isServerAuthor && !!author;

  const canPin =
    guild !== undefined &&
    selfId !== undefined &&
    (guild.ownerId === selfId || message.authorId === selfId);

  // If a thread already exists anchored to this message (back-compat
  // for any threads created before threads moved exclusively under
  // forums), the badge below the message body lets the user navigate
  // into it. We don't create new ones from this surface anymore.
  // Resolved through a narrow selector rather than off the whole
  // channelsByGuild map: the selector's RESULT is what gates the re-render, so
  // a row with no anchored thread selects a constant `null` and never
  // re-renders when the map churns. When a thread does exist the reducer
  // preserves that channel object's reference across sibling list rebuilds
  // (bumpGuildRecency slices the array but keeps the elements), so the
  // subscription only fires when the thread itself actually changes.
  const existingThread = useAppStateSelector(
    (v) =>
      (guildIdForChannel
        ? v.state.channelsByGuild[guildIdForChannel]?.find(
            (c) => c.type === 'public_thread' && c.parentMessageId === message.id,
          )
        : undefined) ?? null,
  );

  // Suppress unused-channel-prop warning. Future: thread permissions
  // through here so the standalone PinPanel/SearchPanel renders use
  // the same `canPin` calculation as inline messages.
  void channel;

  // Render a thin placeholder for blocked-author messages. All hooks
  // above this branch always run, so React's hook count stays stable
  // across the (blocked, revealed) state transitions. Only the
  // returned JSX differs.
  if (blockedHidden) {
    return (
      <div
        data-message-id={message.id}
        className="group relative flex gap-3 py-1 -mx-4 px-4 hover:bg-bg-2/40"
      >
        <div className="w-10 h-10 shrink-0" aria-hidden />
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="text-xs italic text-ink-3 hover:text-ink-2 underline decoration-dotted underline-offset-2 self-center text-left"
        >
          Blocked message — click to show
        </button>
      </div>
    );
  }

  // DM streak-expiry warning — a 'default'-type row carrying a metadata
  // marker. Render as a quiet centered notice (not a bubble that looks like a
  // participant sent it). The content (with its 🔥) is authored server-side.
  if (message.metadata?.kind === 'streak_warning') {
    return (
      <div
        data-message-id={message.id}
        className="group relative flex items-center justify-center gap-2 py-1.5 px-4 text-center text-xs text-ink-2"
      >
        <span>{message.content}</span>
      </div>
    );
  }

  // Poke / nudge — a 'default'-type row with a poke metadata marker. Render
  // as a centered notice ("👉 Alice poked you" / "👉 You poked them"), never a
  // bubble. The recipient's client also pings/animates on arrival.
  if (message.metadata?.kind === 'poke') {
    const variant = POKE_VARIANTS[message.metadata.pokeType as PokeType] ?? POKE_VARIANTS.poke;
    const pokerName = message.author?.displayName ?? message.author?.username ?? 'Someone';
    const text = isOwn ? `You ${variant.sentVerb}` : `${pokerName} ${variant.verb}`;
    return (
      <div
        data-message-id={message.id}
        className="group relative flex items-center justify-center gap-1.5 py-1.5 px-4 text-center text-xs text-ink-2"
      >
        <span aria-hidden>{variant.emoji}</span>
        <span>{text}</span>
      </div>
    );
  }

  // System call messages — render as a compact inline notice rather
  // than the regular message bubble. The metadata payload carries the
  // call summary (missed flag + duration); the rendered string is
  // formatted client-side so we don't have to ship localized strings
  // from the server.
  if (message.type === 'system_call') {
    const meta = message.metadata && message.metadata.kind === 'call' ? message.metadata : null;
    const missed = meta?.missed ?? false;
    const durationMs = meta?.durationMs ?? 0;
    // "Missed call from X": pull the author's display name from the
    // embedded author (the server populates this with the call
    // initiator). The receiver and initiator both see the same
    // message — it reads naturally as "from X" because X is whoever
    // started the call.
    const callerName =
      message.author?.displayName ??
      message.author?.username ??
      'Someone';
    const durationLabel = formatCallDuration(durationMs);
    // The caller (initiator === author === isOwn) shouldn't read "Missed call
    // from <self>". For them an unanswered call is simply "No answer"; the
    // callee still sees "Missed call from <caller>". Red "missed" styling is
    // reserved for the callee — the caller's own unanswered call is a quiet,
    // neutral notice, not an alert.
    const alert = missed && !isOwn;
    const summary = missed
      ? isOwn
        ? 'No answer'
        : `Missed call from ${callerName}`
      : `Call ended · ${durationLabel}`;
    return (
      <div
        data-message-id={message.id}
        className="group relative flex items-center gap-2 py-1.5 px-4 text-xs text-ink-3"
      >
        <Phone size={12} className={alert ? 'text-red-400/80 shrink-0' : 'text-ink-3 shrink-0'} />
        <span className={alert ? 'text-red-300/90' : 'text-ink-2'}>{summary}</span>
        <span className="text-ink-3/70">·</span>
        <time
          dateTime={message.createdAt}
          className="tabular-nums text-ink-3/70"
          title={new Date(message.createdAt).toLocaleString()}
        >
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      </div>
    );
  }

  return (
    <div
      ref={messageRef}
      data-message-id={message.id}
      onClick={(e) => {
        // Tap-to-toggle the action bar on touch devices. We avoid
        // hijacking taps that target interactive descendants (links,
        // images, buttons in the action bar itself) so they retain
        // their own behavior. Also skip when there's an active text
        // selection — that's the user trying to copy text, not open
        // a menu.
        const target = e.target as HTMLElement;
        if (target.closest('a, button, img, video, input, textarea')) return;
        const sel = window.getSelection?.()?.toString();
        if (sel && sel.length > 0) return;
        setActionsOpen((v) => !v);
      }}
      // Layout pattern: fixed-width avatar gutter on every row.
      // Non-continuation rows fill it with the actual avatar;
      // continuation rows leave it empty. This guarantees the
      // content column lines up byte-for-byte regardless of which
      // mode the row is in — previous markup gated it on flex gap +
      // avatar presence, which left continuation content shifted
      // 16px from non-continuation content.
      className={`group relative flex flex-wrap ${
        continuation ? 'py-0.5' : 'py-1'
      } hover:bg-bg-2/40 -mx-4 px-4 ${message.pinned ? 'bg-amber-500/[0.04]' : ''} ${
        message.pending ? 'opacity-60' : ''
      } ${message.failed ? 'bg-red-500/5' : ''}`}
    >
      {/* Replied-to quote bar — appears above the avatar + content
          on its own flex row (w-full triggers flex-wrap to break to
          a new line). Appears above continuations too because the
          relationship is per-message, not per-author-cluster. The
          left padding (4.25rem) lines up with the username column —
          the preview visually sits under where the username starts
          on the row below. */}
      {(repliedTo || message.replyToId) && (
        <div className="w-full flex items-center gap-1.5 text-xs text-ink-3 mb-0.5 pl-[4.25rem] pr-4 pointer-events-none">
          <CornerUpLeft size={11} className="shrink-0" />
          {repliedTo ? (
            <>
              {/* 16px avatar of the replied author — iOS parity
                  (MessageViews.swift replyPreview renders a 16pt Avatar
                  before the name). Same initials-under-image pattern as
                  the row avatar, scaled down. */}
              <span
                className={`relative w-4 h-4 rounded-full overflow-hidden shrink-0 flex items-center justify-center text-[0.5rem] font-semibold ${avatarColor(repliedTo.author?.id)}`}
                aria-hidden
              >
                <span className="zk-avatar-initials">
                  {avatarInitials(repliedTo.author?.displayName ?? repliedTo.author?.username ?? '?')}
                </span>
                <AvatarImage src={repliedTo.author?.avatarUrl ?? null} />
              </span>
              <span className="font-medium text-ink-2 shrink-0">
                {repliedTo.author?.displayName ?? repliedTo.author?.username ?? 'unknown'}
              </span>
              <span className="truncate">{replyPreviewText(repliedTo, filterProfanity)}</span>
            </>
          ) : (
            /* Parent not in the loaded window (older than the scrollback
               window, or deleted): still show that this IS a reply — iOS
               renders the same italic placeholder. */
            <span className="italic truncate">Replying to a message</span>
          )}
        </div>
      )}

      {/* Avatar gutter. Fixed width and ALWAYS rendered so the
          content column to its right has a consistent left edge
          regardless of grouping. For non-continuation rows, fill
          with the avatar button. For continuation rows, leave it
          empty — Discord shows the timestamp on hover here, which
          we can add later. Avatar is 40px (w-10) — matches Discord
          and Fluxer's standard message-author avatar size. */}
      <div className="w-10 mr-3 shrink-0">
        {!continuation && (
          <div className="relative w-10 h-10 mt-0.5">
            <button
              type="button"
              onClick={authorInteractive && author ? (e) => onAvatarClick(author, e) : undefined}
              disabled={!authorInteractive}
              className={`relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold overflow-hidden ${authorAvatarTone} ${authorInteractive ? 'cursor-pointer hover:ring-2 hover:ring-accent/50 transition' : 'cursor-default'}`}
              aria-label={authorInteractive ? `Open profile for ${authorDisplayName}` : undefined}
            >
              <span aria-hidden="true" className="zk-avatar-initials">{authorInitials}</span>
              <AvatarImage src={authorAvatarUrl} />
            </button>
            {!isWebhook && !isServerAuthor && <AvatarDecoration decoration={author?.avatarDecoration} />}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        {!continuation && (
          <div className="flex items-center gap-2">
            {authorInteractive && author && <UserTag user={author} className="-mr-1.5" />}
            <button
              type="button"
              onClick={authorInteractive && author ? (e) => onAvatarClick(author, e) : undefined}
              disabled={!authorInteractive}
              style={
                authorShimmer
                  ? ({ ['--sc']: authorShimmer } as CSSProperties)
                  : authorInteractive && authorRoleColor
                    ? { color: authorRoleColor }
                    : undefined
              }
              className={`font-medium ${
                authorShimmer
                  ? `zk-staff-shimmer${author?.staffGlow ? ' zk-staff-glow' : ''}`
                  : authorInteractive && authorRoleColor
                    ? ''
                    : 'text-ink-1'
              } ${authorInteractive ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
            >
              {authorDisplayName}
            </button>
            {/* E2EE indicator. Small gradient shield to the right of
                the author name on every successfully-decrypted
                encrypted message. self-center overrides the parent's
                items-baseline alignment so the icon centers
                vertically with the name text. The blue→violet
                gradient matches the title-bar indicator and reads
                distinct from plain accent icons. */}
            {isWebhook && (
              // A small "WEBHOOK" pill next to webhook-authored messages
              // so users can tell at a glance whether the persona is
              // a real account or an integration. Discord uses "BOT";
              // we use "WEBHOOK" to match the configuration UI label.
              // accent-2 tint — iOS parity (MessageViews.swift: WEBHOOK
              // is Theme.accent2 on accent2/20; BOT is accent on accent/20).
              <span
                className="inline-flex items-center px-1.5 rounded bg-accent-2/20 text-accent-2 text-[0.55rem] font-bold uppercase tracking-wider leading-[1.1rem]"
                title="Sent via webhook"
              >
                Webhook
              </span>
            )}
            {!isWebhook && author?.isBot && (
              // BOT pill for bot-account authors. Accent tint, distinct
              // from the accent-2 webhook pill (matches iOS).
              <span
                className="inline-flex items-center px-1.5 rounded bg-accent/20 text-accent text-[0.55rem] font-bold uppercase tracking-wider leading-[1.1rem]"
                title="Bot account"
              >
                Bot
              </span>
            )}
            <span
              className="text-xs text-ink-3"
              title={new Date(message.createdAt).toLocaleString()}
            >
              {formatTimestamp(message.createdAt)}
            </span>
            {message.pinned && (
              <span className="inline-flex items-center gap-0.5 text-[0.6rem] uppercase tracking-wider text-amber-400" title="Pinned message">
                <Pin size={10} />
                <span>Pinned</span>
              </span>
            )}
          </div>
        )}

        {editing ? (
          <div className="mt-1 mb-2">
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(false);
                  setEditText(displayContent);
                }
              }}
              rows={Math.min(6, editText.split('\n').length + 1)}
              className="w-full bg-bg-1 border border-accent/60 rounded-md px-3 py-2 outline-none resize-none text-ink-1"
            />
            <div className="flex items-center justify-between mt-1 text-xs text-ink-3">
              <span>
                <kbd className="px-1 bg-bg-3 rounded">esc</kbd> to cancel · <kbd className="px-1 bg-bg-3 rounded">enter</kbd> to save
              </span>
              {editErr && <span className="text-red-300">{editErr}</span>}
              <span>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditText(displayContent);
                  }}
                  className="px-2 py-0.5 rounded text-ink-2 hover:bg-bg-3"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void saveEdit()}
                  disabled={pendingEdit}
                  className="px-2 py-0.5 rounded bg-accent hover:bg-accent/90 text-white ml-1 disabled:opacity-60"
                >
                  Save
                </button>
              </span>
            </div>
          </div>
        ) : decryption.isEncrypted && decryption.failed ? (
          <div className="text-ink-3 italic text-sm whitespace-pre-wrap break-words flex items-center gap-1.5">
            <Shield size={11} className="text-ink-3 shrink-0" />
            <span>
              {!e2eeSupported()
                ? E2EE_INSECURE_SHORT
                : decryption.noKey
                  ? 'Encrypted — enter the password (banner above the message box) to read.'
                  : "Couldn't decrypt this message — the password may have changed."}
            </span>
          </div>
        ) : (
          <div className="zk-select-text text-ink-1 whitespace-pre-wrap break-words">
            {renderedContent}
            {message.editedAt && (
              <span className="text-ink-3 text-xs ml-1" title={`edited ${new Date(message.editedAt).toLocaleString()}`}>
                (edited)
              </span>
            )}
          </div>
        )}

        {message.attachments.length > 0 && (
          <Attachments attachments={message.attachments} channelId={message.channelId} />
        )}
        {/* Sticker — standalone body at ~160px. The DTO carries a
            `stickerId` even when the sticker has been deleted (we
            preserve historical messages); render a tombstone if so.
            Otherwise show the image with the sticker description as
            alt text for accessibility. */}
        {message.stickerId && (
          message.sticker ? (
            <div className="mt-1">
              <img
                src={message.sticker.url}
                alt={message.sticker.description ?? message.sticker.name}
                title={message.sticker.name}
                className="block w-40 h-40 object-contain"
                draggable={false}
              />
            </div>
          ) : (
            <p className="mt-1 text-sm italic text-ink-3">[sticker unavailable]</p>
          )
        )}
        <MessageEmbeds embeds={message.embeds && message.embeds.length > 0 ? message.embeds : e2eeEmbeds} />
        {message.forwardedFrom && <ForwardedMessageBlock source={message.forwardedFrom} />}
        {message.poll && (
          <PollMessage
            channelId={message.channelId}
            messageId={message.id}
            poll={message.poll}
            authorId={message.authorId}
          />
        )}
        {/* Mount only when there ARE reactions — the component returns null
            otherwise, but mounting it still cost two state subscriptions + a
            scan per row. The hover "+react" picker is independent (above). */}
        {message.reactions.length > 0 && <Reactions message={message} guildId={guildId} />}

        {/* DM receipt indicator. Renders inside the message bubble at the
            bottom-right so it visually sits below the hover action strip
            (which floats top-right). Compact: tiny font, single line,
            no row of its own. Caller (MessageView) only sets the prop
            on the sender's last own message in a 1:1 DM, so this only
            ever renders in the right place; everywhere else it's a
            no-op. */}
        {showDmReceipt && <DmReceiptIndicator message={message} />}

        {/* "Continued in thread" pill. Only shown for messages that have
            a thread anchored to them. Click navigates to the thread.
            Visual treatment is intentionally subtle — accent text on a
            faint accent-tinted background — so the message body itself
            stays the primary focus. */}
        {existingThread && (
          <button
            onClick={() => {
              if (existingThread.guildId) {
                nav(`/channels/${existingThread.guildId}/${existingThread.id}`);
              }
            }}
            className="mt-1 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent/[0.08] hover:bg-accent/[0.15] border border-accent/20 hover:border-accent/40 text-xs text-accent transition-colors max-w-full"
          >
            <MessageSquare size={11} className="shrink-0" />
            <span className="font-medium truncate">
              {existingThread.name ?? 'Thread'}
            </span>
            <span className="text-accent/60 shrink-0">→</span>
          </button>
        )}

        {/* Failed-send footer. The optimistic placeholder remains in the
            stream when the REST call fails (network, 4xx, etc); we offer
            inline Retry + Discard so the user doesn't have to retype.
            Pending state shows nothing extra — opacity-60 on the row is
            enough signal. */}
        {message.failed && (
          <div className="mt-1 flex items-center gap-2 text-xs text-red-300">
            <span className="font-medium">Failed to send.</span>
            <button
              type="button"
              onClick={() => void retrySendMessage(message.channelId, message.id)}
              className="underline hover:text-red-200"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => discardFailedMessage(message.channelId, message.id)}
              className="underline hover:text-red-200"
            >
              Discard
            </button>
          </div>
        )}
      </div>

      {/* Hover actions. Order: Reply / Pin / Thread / Edit / Delete. On
          fine-pointer devices the strip stays hidden until row hover (keeps
          the message stream visually quiet). On coarse-pointer / touch
          devices, hover never fires — so we make the strip always-visible
          there, with a slightly more compact look so it doesn't dominate
          the row. The arbitrary variant `[@media(hover:none)]:` is
          Tailwind's escape hatch for media queries it doesn't ship a
          preset for. */}
      {!editing && !message.pending && !message.failed && (
        <div
          className={`absolute right-1 sm:right-2 top-1 z-[1] items-center gap-0 sm:gap-0.5 bg-bg-2 border border-line rounded-md p-0.5 shadow-sm ${
            actionsOpen ? 'flex' : 'hidden group-hover:flex'
          }`}
        >
          {onReply && (
            <button
              onClick={() => onReply(message)}
              className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center text-ink-2 hover:text-ink-1 hover:bg-bg-3 rounded"
              title="Reply"
              aria-label="Reply to message"
            >
              <CornerUpLeft size={13} />
            </button>
          )}
          {/* React button — opens an emoji picker anchored below the
              action bar. The picker calls addReaction; the gateway
              echoes back the REACTION_ADD which the reducer applies
              to message.reactions, so the existing reaction-pill row
              updates automatically. Sits next to Reply per the rail
              UX brief (react adjacent to reply). */}
          <button
            ref={reactBtnRef}
            onClick={() => setReactPickerOpen((v) => !v)}
            className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center text-ink-2 hover:text-ink-1 hover:bg-bg-3 rounded"
            title="Add reaction"
            aria-label="Add reaction"
          >
            <Smile size={13} />
          </button>
          {canPin && (
            <button
              onClick={() => void togglePin()}
              className={`w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center hover:bg-bg-3 rounded ${
                message.pinned ? 'text-amber-400 hover:text-amber-300' : 'text-ink-2 hover:text-ink-1'
              }`}
              title={message.pinned ? 'Unpin' : 'Pin to channel'}
              aria-label={message.pinned ? 'Unpin message' : 'Pin message'}
            >
              <Pin size={13} />
            </button>
          )}
          {/* Forward — opens the ForwardModal to re-send this message
              into another channel/DM. Mirrors the iOS row context
              menu's Forward action (MessageViews.swift), which sits
              between Pin and Save. Skipped for local- optimistic ids
              (nothing on the server to forward yet), same as Save. */}
          {!message.id.startsWith('local-') && (
            <button
              onClick={() => setShowForward(true)}
              className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center text-ink-2 hover:text-ink-1 hover:bg-bg-3 rounded"
              title="Forward"
              aria-label="Forward message"
            >
              <ForwardIcon size={13} />
            </button>
          )}
          {/* Save / bookmark — per-user, private. Filled icon while
              saved. Optimistically toggles via the AppState helper;
              REST failure reverts + toasts. Available on every
              message (not just own) since bookmarks are personal. */}
          {!message.id.startsWith('local-') && (
            <button
              onClick={() => void toggleSavedMessage(message.id)}
              className={`w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center hover:bg-bg-3 rounded ${
                isSaved ? 'text-accent hover:text-accent-2' : 'text-ink-2 hover:text-ink-1'
              }`}
              title={isSaved ? 'Remove bookmark' : 'Save message'}
              aria-label={isSaved ? 'Remove bookmark' : 'Save message'}
              aria-pressed={isSaved}
            >
              <Bookmark size={13} filled={isSaved} />
            </button>
          )}
          {/* Thread-start button removed: threads are now exclusively
              a forum-system concept. New threads can't be started
              from text-channel messages; existing threads anchored to
              messages remain navigable via the badge below the body
              (see existingThread block above). */}
          {isOwn && withinMutateWindow && (
            <>
              <button
                onClick={() => {
                  setEditing(true);
                  setEditText(displayContent);
                }}
                className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center text-ink-2 hover:text-ink-1 hover:bg-bg-3 rounded"
                title="Edit"
                aria-label="Edit message"
              >
                <Edit size={13} />
              </button>
              <button
                onClick={() => void deleteMessage()}
                className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center text-red-400 hover:text-red-300 hover:bg-red-950/40 rounded"
                title="Delete"
                aria-label="Delete message"
              >
                <Trash size={13} />
              </button>
            </>
          )}
        </div>
      )}
      {cardElement}
      {showForward && (
        <ForwardModal message={message} onClose={() => setShowForward(false)} />
      )}
      {reactPickerOpen && (
        <ReactionPickerPortal
          anchorRef={reactBtnRef}
          guildId={guildIdForChannel ?? undefined}
          onSelect={(emoji) => {
            setReactPickerOpen(false);
            void rest.addReaction(message.channelId, message.id, emoji).catch(() => {
              // Reactions component shows surfaced errors via toasts;
              // we deliberately drop here since this is the hover-
              // strip variant and the user just sees nothing happen
              // on permission denials. Most failures are race
              // conditions (message deleted, channel gone) where
              // silence is fine.
            });
          }}
          onClose={() => setReactPickerOpen(false)}
        />
      )}
    </div>
  );
}

// Pre-constructed Intl formatters. The previous code built a new
// Intl.DateTimeFormat under the hood on every formatTimestamp call —
// fine in isolation, but this function fires once per visible
// message on every render of MessageItem. With 100 visible messages
// that's 100+ Intl setups per render, each ~10-50µs of locale data
// construction. Pre-constructing the formatters at module load
// eliminates that setup cost; `.format(date)` on a cached formatter
// is ~10x faster than the convenience call.
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

// iOS parity (Components.swift shortTime → "h:mm a"): the header
// timestamp is ALWAYS the short local time — the calendar day is
// conveyed solely by the date divider between groups. The full
// date/time lives in the timestamp's `title` tooltip at the call site.
function formatTimestamp(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}

/**
 * Memoized export. React.memo short-circuits re-renders when no prop
 * reference changed — combined with the selector migration above
 * (each state slice has its own subscription so MessageItem only
 * re-renders when one of its selected slices actually changes) and
 * with the parent's stabilized onReply callback (MessageView now
 * wraps it in useCallback), the memoization is meaningful: in a
 * channel with 50 messages, an event that doesn't touch any slice
 * MessageItem reads doesn't re-render any row at all. Previously
 * every gateway event re-rendered all 50.
 *
 * The comparator is shallow (React.memo's default behaviour) for every
 * prop EXCEPT `channel`, which gets a field-wise comparison:
 *   - `message` is a value from the reducer, which uses structural
 *     sharing — unchanged messages keep the same reference.
 *   - `continuation`, `selfId`, `showDmReceipt` are primitives.
 *   - `onReply` is wrapped in useCallback by MessageView.
 *   - `channel` CANNOT be compared by identity: the reducer replaces the
 *     open channel's object on every message it receives (the forward-only
 *     lastMessageId bump does `{ ...ch, lastMessageId }`), so identity
 *     comparison re-rendered every row in the channel on every message even
 *     though nothing the row displays had changed. `channelPropsEqual`
 *     below compares only the fields this component actually reads.
 */
/**
 * Compact DM read-receipt indicator. Rendered inside the message
 * body at the bottom-right, below the area where the action strip
 * floats. Shows one of three states based on which timestamps the
 * server has stamped:
 *
 *   Sent           — neither deliveredAt nor viewedAt set
 *   Delivered      — deliveredAt set, viewedAt not yet
 *   Read 3:42 PM   — viewedAt set, formatted local time
 *
 * Both timestamps are NULL when the recipient has DM read receipts
 * disabled — in that case we render "Sent" indefinitely, which is
 * the privacy contract. The component doesn't know about the
 * recipient's toggle directly; it just renders what the server says
 * via the message's viewedAt/deliveredAt fields.
 *
 * Visual treatment: right-aligned, ink-3 color, 10px font. The
 * bubble's natural bottom padding gives it a small gap from the
 * preceding row; no extra spacing needed.
 */
function DmReceiptIndicator({ message }: { message: Message }) {
  if (message.viewedAt) {
    let time = '';
    try {
      const d = new Date(message.viewedAt);
      time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch {
      // Malformed timestamp from server — shouldn't happen, but if it
      // does, just show "Read" without the time rather than crashing.
    }
    return (
      <div className="text-right text-[0.65rem] text-ink-3 select-none mt-0.5">
        {/* "Read 3:42 PM" — no separator dot, matching iOS
            (MessageViews.swift: "Read \(shortTime(viewedAt))"). */}
        Read{time && ` ${time}`}
      </div>
    );
  }
  return (
    <div className="text-right text-[0.65rem] text-ink-3 select-none mt-0.5">
      {message.deliveredAt ? 'Delivered' : 'Sent'}
    </div>
  );
}

/**
 * Field-wise equality for the `channel` prop.
 *
 * These are the ONLY fields MessageItemBase reads off `channel` (verified
 * against every `channel`/`channel?.` reference in the component):
 *   - `id`            — E2EE key lookup / decrypt / re-encrypt on edit
 *   - `guildId`       — profile card, role color, custom emoji, pin gate,
 *                       anchored-thread lookup, reaction picker
 *   - `type`          — DM vs group DM (drives the DM-nickname substitution)
 *   - `recipients`    — DM mention fallback in renderCtx.lookupUser
 *   - `e2eeVerifier`  — passed to encryptForDm when saving an edit
 * Plus presence: undefined vs a channel object is always a change.
 *
 * `recipients` is compared by reference, matching what the renderCtx memo
 * already did. The reducer's `{ ...ch }` spreads preserve that array's
 * identity, so recency bumps don't trip it; a genuine channel refetch does,
 * which errs on the safe (re-render) side.
 *
 * If a future change reads another channel field, ADD IT HERE — a missing
 * field renders stale.
 */
function channelPropsEqual(a: Channel | undefined, b: Channel | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.guildId === b.guildId &&
    a.type === b.type &&
    a.e2eeVerifier === b.e2eeVerifier &&
    a.recipients === b.recipients
  );
}

function messageItemPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.message === next.message &&
    prev.continuation === next.continuation &&
    prev.selfId === next.selfId &&
    prev.onReply === next.onReply &&
    prev.showDmReceipt === next.showDmReceipt &&
    channelPropsEqual(prev.channel, next.channel)
  );
}

export const MessageItem = memo(MessageItemBase, messageItemPropsEqual);

/**
 * Format a millisecond span as a call-duration string.
 *
 *   0           → "0s"
 *   42500       → "42s"          (rounds down to seconds)
 *   65000       → "1m 5s"
 *   3661000     → "1h 1m 1s"     (only includes hours when ≥ 1h)
 *
 * Used by the system_call render path so the message reads as
 * "Call ended · 5m 23s" instead of an ugly raw ms count.
 */
function formatCallDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Reaction picker, portaled into document.body with viewport-aware
 * positioning. Necessary because the previous absolute-positioned
 * variant (`absolute top-9`) clipped on messages near the bottom of
 * the viewport — the picker is up to 320px tall and ran off-screen
 * when anchored below the action bar.
 *
 * Layout decision:
 *   - Anchor the picker BELOW the button (top = button.bottom + 4)
 *     when there's room (>= ~320px to viewport bottom).
 *   - Otherwise flip and anchor ABOVE (bottom = vh - button.top + 4).
 *
 * The picker is right-aligned to the button's right edge so it
 * always lives flush against the action bar. We clamp left so a
 * picker against the right viewport edge doesn't push off-screen
 * to the left on a narrow phone.
 *
 * Coords recompute on window resize and on scroll (chat scrolling
 * moves the anchor in viewport space, so the picker must follow).
 */
function ReactionPickerPortal({
  anchorRef,
  guildId,
  onSelect,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  guildId?: string;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  // Picker dimensions baked into EmojiPicker. If those change, bump
  // these constants to match — they only need to be approximate
  // since we just use them to decide which side of the anchor to
  // render on.
  const PICKER_WIDTH = 288;
  const PICKER_MAX_HEIGHT = 320;
  const GAP = 4;
  const VIEWPORT_MARGIN = 8;

  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    function recompute() {
      const btn = anchorRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Right-align to the button's right edge. Compute left so
      // the picker's right edge sits at rect.right.
      let left = rect.right - PICKER_WIDTH;
      // Clamp inside viewport on narrow screens.
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
      if (left + PICKER_WIDTH > vw - VIEWPORT_MARGIN) {
        left = vw - PICKER_WIDTH - VIEWPORT_MARGIN;
      }

      // Decide above vs below. Prefer below; flip up only when below
      // would clip.
      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;
      if (spaceBelow >= PICKER_MAX_HEIGHT + GAP + VIEWPORT_MARGIN) {
        setCoords({ top: rect.bottom + GAP, left });
      } else if (spaceAbove >= PICKER_MAX_HEIGHT + GAP + VIEWPORT_MARGIN) {
        setCoords({ bottom: vh - rect.top + GAP, left });
      } else {
        // Neither side has full space. Pick whichever has more and
        // let the picker's own max-h-80 scroll handle overflow.
        if (spaceBelow >= spaceAbove) {
          setCoords({ top: rect.bottom + GAP, left });
        } else {
          setCoords({ bottom: vh - rect.top + GAP, left });
        }
      }
    }
    recompute();
    window.addEventListener('resize', recompute);
    // Scroll events come from the chat scroller (a descendant) and
    // bubble to window because window listens in capture phase.
    // Using { capture: true } catches scroll events from any
    // nested scroll container.
    window.addEventListener('scroll', recompute, { capture: true });
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, { capture: true });
    };
  }, [anchorRef]);

  if (!coords) return null;

  return createPortal(
    <div
      className="fixed z-50"
      style={{
        top: coords.top,
        bottom: coords.bottom,
        left: coords.left,
      }}
    >
      <EmojiPicker guildId={guildId} onSelect={onSelect} onClose={onClose} />
    </div>,
    document.body,
  );
}

