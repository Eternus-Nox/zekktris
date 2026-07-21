/**
 * FriendsView
 * -----------
 * Default landing for `/channels/@me`. Shows the user's relationship
 * graph on a single scrolling page with stacked, caps-labelled
 * sections (mirroring iOS FriendsView):
 *
 *   - ADD A FRIEND  (always) — username field + Add button
 *   - REQUESTS      (if any incoming) — friend requests to act on
 *   - PENDING       (if any outgoing) — requests you sent
 *   - FRIENDS       (always)
 *   - BLOCKED       (if any)
 *
 * Reads from `state.relationships`, which is hydrated at boot by
 * AppState. Mutations (accept / reject / cancel / remove / unblock)
 * fire the matching REST call AND optimistically dispatch
 * `applyRelationship` so the row updates without waiting for a refetch.
 *
 * Each row exposes a "Send message" affordance that opens (or creates)
 * a DM channel with that user, mirroring the ProfileCard behaviour.
 */
import { useMemo, useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type PublicUser } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { useProfileCard } from '../lib/useProfileCard';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { AvatarDecoration } from '../lib/avatarDecorations';
import {
  MessageSquare,
  UserMinus,
  Shield,
  X,
  CheckCircle,
  Users as UsersIcon,
  Phone,
  ChevronLeft,
} from '../lib/icons';
import { connectToVoice, VoiceError, prepareVoiceAudio } from '../lib/voice';

export function FriendsView() {
  const { state, loadRelationships } = useAppState();
  const { user: self, rest } = useAuth();
  const nav = useNavigate();
  const { onAvatarClick, cardElement } = useProfileCard();

  // "Add friend" composer state.
  const [addUsername, setAddUsername] = useState('');
  const [addPending, setAddPending] = useState(false);
  const [addMsg, setAddMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  );

  async function submitAdd() {
    const uname = addUsername.trim().replace(/^@/, '');
    if (!uname || addPending) return;
    setAddPending(true);
    setAddMsg(null);
    try {
      const r = await rest.sendFriendRequestByUsername(uname);
      // No gateway event fires to the sender, so refetch to pull in the
      // new relationship (with full user data) for the list.
      await loadRelationships();
      if (r.type === 'friend') {
        setAddMsg({ kind: 'success', text: `You're now friends with @${uname}!` });
      } else {
        setAddMsg({ kind: 'success', text: `Friend request sent to @${uname}.` });
      }
      setAddUsername('');
    } catch (e) {
      setAddMsg({
        kind: 'error',
        text: e instanceof ApiError ? e.message : 'Could not send the request.',
      });
    } finally {
      setAddPending(false);
    }
  }

  // Bucket relationships. Memoised so re-renders don't rebucket.
  const buckets = useMemo(() => {
    const friends: typeof state.relationships = [];
    const incoming: typeof state.relationships = [];
    const outgoing: typeof state.relationships = [];
    const blocked: typeof state.relationships = [];
    for (const r of state.relationships) {
      if (r.type === 'friend') friends.push(r);
      else if (r.type === 'incoming_request') incoming.push(r);
      else if (r.type === 'outgoing_request') outgoing.push(r);
      else if (r.type === 'blocked') blocked.push(r);
    }
    friends.sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
    incoming.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    outgoing.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    blocked.sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
    return { friends, incoming, outgoing, blocked };
  }, [state.relationships]);

  return (
    <div className="flex flex-col h-full bg-bg-1">
      <header className="px-4 sm:px-6 py-3 border-b border-line shrink-0 flex items-center gap-2">
        <button
          type="button"
          onClick={() => nav('/channels/@me')}
          className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={20} />
        </button>
        <UsersIcon size={18} className="text-accent shrink-0" />
        <span className="font-semibold">Friends</span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-5 space-y-7">
          {/* ADD A FRIEND — always first, always visible. */}
          <section>
            <SectionLabel>Add a friend</SectionLabel>
            <div className="flex gap-2">
              <input
                type="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Find a person by username"
                value={addUsername}
                onChange={(e) => {
                  setAddUsername(e.target.value);
                  if (addMsg) setAddMsg(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitAdd();
                }}
                className="flex-1 min-w-0 bg-bg-2 border border-line rounded-md px-3 py-2 text-sm outline-none focus:border-accent transition-colors"
              />
              <button
                type="button"
                onClick={() => void submitAdd()}
                disabled={addPending || addUsername.trim().length === 0}
                className="shrink-0 px-4 py-2 rounded-md text-sm font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {addPending ? 'Sending…' : 'Add'}
              </button>
            </div>
            {addMsg && (
              <p
                className={`text-xs mt-2 ${
                  addMsg.kind === 'success' ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {addMsg.text}
              </p>
            )}
          </section>

          {/* REQUESTS — incoming friend requests. */}
          {buckets.incoming.length > 0 && (
            <section>
              <SectionLabel>Requests</SectionLabel>
              <ul className="rounded-xl border border-line bg-bg-2/40 overflow-hidden divide-y divide-line">
                {buckets.incoming.map((r) => (
                  <FriendRow
                    key={r.user.id}
                    user={r.user}
                    relType={r.type}
                    isSelf={self?.id === r.user.id}
                    onAvatarClick={onAvatarClick}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* PENDING — outgoing requests you sent. */}
          {buckets.outgoing.length > 0 && (
            <section>
              <SectionLabel>Pending</SectionLabel>
              <ul className="rounded-xl border border-line bg-bg-2/40 overflow-hidden divide-y divide-line">
                {buckets.outgoing.map((r) => (
                  <FriendRow
                    key={r.user.id}
                    user={r.user}
                    relType={r.type}
                    isSelf={self?.id === r.user.id}
                    onAvatarClick={onAvatarClick}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* FRIENDS — always shown (with an empty hint when none). */}
          <section>
            <SectionLabel>Friends</SectionLabel>
            {buckets.friends.length === 0 ? (
              <p className="text-xs text-ink-3 px-1">
                No friends yet — add someone by username above.
              </p>
            ) : (
              <ul className="rounded-xl border border-line bg-bg-2/40 overflow-hidden divide-y divide-line">
                {buckets.friends.map((r) => (
                  <FriendRow
                    key={r.user.id}
                    user={r.user}
                    relType={r.type}
                    isSelf={self?.id === r.user.id}
                    onAvatarClick={onAvatarClick}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* BLOCKED — only when there's something to show. */}
          {buckets.blocked.length > 0 && (
            <section>
              <SectionLabel>Blocked</SectionLabel>
              <ul className="rounded-xl border border-line bg-bg-2/40 overflow-hidden divide-y divide-line">
                {buckets.blocked.map((r) => (
                  <FriendRow
                    key={r.user.id}
                    user={r.user}
                    relType={r.type}
                    isSelf={self?.id === r.user.id}
                    onAvatarClick={onAvatarClick}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {cardElement}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-wider text-ink-3 mb-2 px-1">
      {children}
    </div>
  );
}

function FriendRow({
  user,
  relType,
  isSelf,
  onAvatarClick,
}: {
  user: PublicUser;
  relType: 'friend' | 'incoming_request' | 'outgoing_request' | 'blocked';
  isSelf: boolean;
  onAvatarClick: (u: PublicUser, e: React.MouseEvent) => void;
}) {
  const { rest } = useAuth();
  const { applyRelationship, mergeChannelVoiceStates } = useAppState();
  const toasts = useToasts();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  /** Pending state for the call button — prevents double-clicks
      from kicking off two REST round-trips. Separate from `busy`
      (which guards friend-request actions) so a call attempt
      doesn't disable Accept/Decline buttons unrelated to it. */
  const [callPending, setCallPending] = useState(false);

  const tone = avatarColor(user.id);
  const initials = avatarInitials(user.displayName);
  const dot =
    user.status === 'online'
      ? 'bg-emerald-500'
      : user.status === 'idle'
        ? 'bg-amber-500'
        : user.status === 'dnd'
          ? 'bg-red-500'
          : 'bg-ink-3';

  async function openDM() {
    try {
      const r = await rest.openDM(user.id);
      nav(`/channels/@me/${r.channel.id}`);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not open DM', 'error');
    }
  }

  /**
   * Open (or resolve) the 1:1 DM with this user, navigate into it,
   * then start a voice call. Three-step flow:
   *   1. openDM — resolve/create the DM channel
   *   2. joinVoice — server adds us to the voice state + mints a LiveKit token
   *   3. connectToVoice — WebRTC handshake
   *
   * If step 2 or 3 fails, we still navigate into the DM so the user
   * lands somewhere they can retry from (the DM header has its own
   * call button). Prime the shared audio context inside the click —
   * iOS Safari requires the AudioContext to be created in a user
   * gesture or autoplay won't grant playback permission.
   */
  async function startVoiceCall() {
    if (callPending) return;
    setCallPending(true);
    prepareVoiceAudio();
    try {
      const dm = await rest.openDM(user.id);
      nav(`/channels/@me/${dm.channel.id}`);
      try {
        const r = await rest.joinVoice(dm.channel.id);
        mergeChannelVoiceStates(dm.channel.id, r.channelVoiceStates);
        if (r.token && r.wsUrl) {
          await connectToVoice({
            token: r.token,
            wsUrl: r.wsUrl,
            sessionId: r.voiceState.sessionId,
            channelId: dm.channel.id,
            isDmCall: true,
            backgroundTitle: `Call with ${user.displayName || user.username}`,
            // 1:1 DM with E2EE on → encrypt the call media with the same
            // shared key the DM uses for messages.
            ...(dm.channel.e2eeEnabled
              ? { e2ee: { channelId: dm.channel.id, verifier: dm.channel.e2eeVerifier } }
              : {}),
          });
        } else {
          toasts.push('Voice isn’t set up on this server yet, so there’s no audio. Ask the server admin to enable voice.', 'info');
        }
      } catch (e) {
        // Roll back the server-side join so a failed media connect doesn't
        // leave the callee in dead air with a caller who never actually
        // connected. Harmless no-op if joinVoice itself was what failed. The
        // gateway echoes the leave. Best-effort.
        void rest.leaveVoice(dm.channel.id).catch(() => {});
        toasts.push(
          e instanceof VoiceError
            ? e.message
            : e instanceof ApiError
              ? e.message
              : 'Could not start the call',
          'error',
        );
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not open DM', 'error');
    } finally {
      setCallPending(false);
    }
  }

  async function accept() {
    if (busy) return;
    setBusy(true);
    try {
      await rest.acceptFriendRequest(user.id);
      applyRelationship(user, 'friend');
      toasts.push('Friend request accepted', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Accept failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(label: string) {
    if (busy) return;
    setBusy(true);
    try {
      await rest.removeFriend(user.id);
      applyRelationship(user, null);
      toasts.push(`${label}`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function unblock() {
    if (busy) return;
    setBusy(true);
    try {
      await rest.unblockUser(user.id);
      applyRelationship(user, null);
      toasts.push(`${user.displayName} unblocked`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Unblock failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Block straight from the friend row's overflow menu — mirrors the iOS
      friend-row context menu (Remove friend + Block, both destructive). The
      optimistic 'blocked' relationship moves the row to the BLOCKED bucket. */
  async function block() {
    if (busy) return;
    setBusy(true);
    try {
      await rest.blockUser(user.id);
      applyRelationship(user, 'blocked');
      toasts.push(`${user.displayName} blocked`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Block failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-4 sm:px-4 py-3 hover:bg-bg-2/40 transition-colors">
      <button
        type="button"
        onClick={(e) => onAvatarClick(user, e)}
        className="relative w-10 h-10 shrink-0 hover:ring-2 hover:ring-accent/50 rounded-full transition-shadow"
        aria-label={`Open profile for ${user.displayName}`}
      >
        <span className={`absolute inset-0 rounded-full text-sm flex items-center justify-center font-semibold ${tone}`} aria-hidden="true">
          <span className="zk-avatar-initials">{initials}</span>
        </span>
        <AvatarImage src={user.avatarUrl} />
        {/* Custom avatar frame/decoration, if the user picked one. Sits above
            the image but below the status dot (rendered after). */}
        <AvatarDecoration decoration={user.avatarDecoration} />
        {/* Status dot — for blocked rows we don't show it (you opted out
            of seeing their presence). */}
        {relType !== 'blocked' && (
          <span
            aria-hidden
            className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-bg-1 ${dot}`}
          />
        )}
      </button>

      <button
        type="button"
        onClick={(e) => onAvatarClick(user, e)}
        className="flex-1 min-w-0 text-left"
      >
        <div className="text-sm text-ink-1 truncate font-medium">
          {user.displayName}
          {isSelf && <span className="ml-1 text-xs text-ink-3 font-normal">(you)</span>}
        </div>
        <div className="text-xs text-ink-3 truncate">
          {relType === 'incoming_request'
            ? 'Incoming friend request'
            : relType === 'outgoing_request'
              ? 'Outgoing friend request'
              : `@${user.username}`}
        </div>
      </button>

      <div className="flex items-center gap-1.5 shrink-0">
        {relType === 'friend' && (
          <>
            {/* Primary affordance is the message icon (matching iOS); the
                rest live behind a compact overflow menu. */}
            <IconButton
              onClick={() => void openDM()}
              label="Message"
              icon={<MessageSquare size={16} />}
            />
            <FriendOverflowMenu
              onCall={isSelf ? undefined : () => void startVoiceCall()}
              callDisabled={callPending}
              onRemove={() => void remove(`${user.displayName} removed`)}
              removeDisabled={busy}
              onBlock={isSelf ? undefined : () => void block()}
              blockDisabled={busy}
            />
          </>
        )}
        {relType === 'incoming_request' && (
          <>
            {/* Icon-only accept (green filled check) + decline (muted x). */}
            <button
              type="button"
              onClick={() => void accept()}
              disabled={busy}
              aria-label="Accept friend request"
              title="Accept"
              className="text-emerald-500 hover:text-emerald-400 disabled:opacity-50 transition-colors"
            >
              <CheckCircle size={26} />
            </button>
            <button
              type="button"
              onClick={() => void remove('Friend request declined')}
              disabled={busy}
              aria-label="Decline friend request"
              title="Decline"
              className="w-[26px] h-[26px] flex items-center justify-center rounded-full bg-bg-3 text-ink-3 hover:text-ink-1 disabled:opacity-50 transition-colors"
            >
              <X size={16} />
            </button>
          </>
        )}
        {relType === 'outgoing_request' && (
          <IconButton
            onClick={() => void remove('Friend request cancelled')}
            label="Cancel request"
            icon={<X size={16} />}
            disabled={busy}
          />
        )}
        {relType === 'blocked' && (
          <button
            type="button"
            onClick={() => void unblock()}
            disabled={busy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-bg-3 text-ink-2 hover:text-ink-1 transition-colors disabled:opacity-60"
          >
            <Shield size={14} />
            <span className="hidden sm:inline">Unblock</span>
          </button>
        )}
      </div>
    </li>
  );
}

function IconButton({
  onClick,
  label,
  icon,
  disabled,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="w-8 h-8 flex items-center justify-center rounded-md bg-bg-3 text-ink-2 hover:text-ink-1 hover:bg-bg-3/80 transition-colors disabled:opacity-60"
    >
      {icon}
    </button>
  );
}

/**
 * Compact "…" overflow menu for friend rows — holds Call, Remove and Block
 * so the row shows only the message icon at rest (matching iOS, where
 * remove/block live in a long-press menu). Outside-click is handled by a
 * full-screen invisible backdrop so it can't leave a lingering hit-test
 * trap on a hosting popover.
 */
function FriendOverflowMenu({
  onCall,
  callDisabled,
  onRemove,
  removeDisabled,
  onBlock,
  blockDisabled,
}: {
  onCall?: () => void;
  callDisabled?: boolean;
  onRemove: () => void;
  removeDisabled?: boolean;
  onBlock?: () => void;
  blockDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-8 h-8 flex items-center justify-center rounded-md bg-bg-3 text-ink-2 hover:text-ink-1 transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </button>
      {open && (
        <>
          {/* Invisible full-screen backdrop closes the menu on any outside
              click without a document-level listener. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-line bg-bg-1 elevation-pop py-1"
          >
            {onCall && (
              <button
                type="button"
                role="menuitem"
                disabled={callDisabled}
                onClick={() => {
                  setOpen(false);
                  onCall();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ink-1 hover:bg-bg-3 disabled:opacity-60 transition-colors"
              >
                <Phone size={15} /> Call
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              disabled={removeDisabled}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-950/40 disabled:opacity-60 transition-colors"
            >
              <UserMinus size={15} /> Remove
            </button>
            {onBlock && (
              <button
                type="button"
                role="menuitem"
                disabled={blockDisabled}
                onClick={() => {
                  setOpen(false);
                  onBlock();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-950/40 disabled:opacity-60 transition-colors"
              >
                <Shield size={15} /> Block
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
