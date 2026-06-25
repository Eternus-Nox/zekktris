/**
 * FriendsView
 * -----------
 * Default landing for `/channels/@me`. Shows the user's relationship
 * graph in three tabs:
 *
 *   - All:       Friends (any pending requests omitted)
 *   - Pending:   Incoming + outgoing friend requests
 *   - Blocked:   Users this account has blocked
 *
 * Reads from `state.relationships`, which is hydrated at boot by
 * AppState. Mutations (accept / reject / cancel / remove / unblock)
 * fire the matching REST call AND optimistically dispatch
 * `applyRelationship` so the row updates without waiting for a refetch.
 *
 * Each row exposes a "Send message" affordance that opens (or creates)
 * a DM channel with that user, mirroring the ProfileCard behaviour.
 *
 * Empty states are friendly ("No friends yet — open someone's profile
 * to add them") rather than apologetic; "no blocked users" is the
 * desired state, not a failure.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type PublicUser } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { useProfileCard } from '../lib/useProfileCard';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { AvatarDecoration } from '../lib/avatarDecorations';
import { MessageSquare, UserPlus, UserMinus, Shield, X, Users as UsersIcon, Phone, ChevronLeft } from '../lib/icons';
import { connectToVoice, VoiceError, prepareVoiceAudio } from '../lib/voice';

type TabId = 'all' | 'pending' | 'blocked' | 'add';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'all', label: 'All friends' },
  { id: 'pending', label: 'Pending' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'add', label: 'Add Friend' },
];

export function FriendsView() {
  const { state, loadRelationships } = useAppState();
  const { user: self, rest } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<TabId>('all');
  const [query, setQuery] = useState('');
  const { onAvatarClick, cardElement } = useProfileCard();

  // "Add friend" composer state (the Add Friend tab).
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
        setTab('all');
      } else {
        setAddMsg({ kind: 'success', text: `Friend request sent to @${uname}.` });
        setTab('pending');
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

  // Bucket relationships by tab. Memoised so typing in the search box
  // doesn't rebucket the whole list on every keystroke; we filter the
  // pre-bucketed lists in the render.
  const buckets = useMemo(() => {
    const friends: typeof state.relationships = [];
    const pending: typeof state.relationships = [];
    const blocked: typeof state.relationships = [];
    for (const r of state.relationships) {
      if (r.type === 'friend') friends.push(r);
      else if (r.type === 'incoming_request' || r.type === 'outgoing_request') pending.push(r);
      else if (r.type === 'blocked') blocked.push(r);
    }
    // Sort friends alphabetically by display name, pending oldest-first
    // (so the user can act on the longest-waiting requests), blocked
    // alphabetically.
    friends.sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    blocked.sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
    return { friends, pending, blocked };
  }, [state.relationships]);

  // Filter the active bucket by the search query (case-insensitive
  // substring on display name OR username).
  const visible = useMemo(() => {
    const list =
      tab === 'all' ? buckets.friends : tab === 'pending' ? buckets.pending : buckets.blocked;
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter(
      (r) =>
        r.user.displayName.toLowerCase().includes(q) ||
        r.user.username.toLowerCase().includes(q),
    );
  }, [tab, buckets, query]);

  const counts = {
    all: buckets.friends.length,
    pending: buckets.pending.length,
    blocked: buckets.blocked.length,
    add: 0,
  };

  return (
    <div className="flex flex-col h-full bg-bg-1">
      <header className="px-4 sm:px-6 py-3 border-b border-line shrink-0 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => nav('/channels/@me')}
            className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
            aria-label="Back to direct messages"
          >
            <ChevronLeft size={18} />
          </button>
          <UsersIcon size={18} className="text-accent shrink-0" />
          <span className="font-semibold">Friends</span>
        </div>
        {/* Tabs. On mobile they get their own row and expand to share
            the full width so each is a comfortable tap target. On
            sm+ they sit inline with the title. */}
        <div className="flex items-center gap-1 sm:ml-2 -mx-1 sm:mx-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex-1 sm:flex-initial px-3 py-1.5 rounded-md text-sm transition-colors ${
                tab === t.id
                  ? 'bg-bg-3 text-ink-1'
                  : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3/50'
              }`}
            >
              {t.label}
              {counts[t.id] > 0 && (
                <span className="ml-1.5 text-xs text-ink-3">
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {tab === 'add' ? (
        /* Add Friend tab — search for a person by username and send them a
           request. (Adding is by exact username, which keeps the directory
           private — there's no browsable list of every account.) */
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 sm:px-6 py-5">
          <div className="max-w-md">
            <h2 className="text-sm font-semibold text-ink-1">Add a friend</h2>
            <p className="text-xs text-ink-3 mt-0.5 mb-3">
              Search for someone by their exact username to send a friend request.
            </p>
            <div className="flex gap-2">
              <input
                type="search"
                autoFocus
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
                className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium bg-gradient-to-br from-accent to-accent-2 text-bg-0 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                <UserPlus size={16} />
                {addPending ? 'Sending…' : 'Send Request'}
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
          </div>
        </div>
      ) : (
        <>
          <div className="px-4 sm:px-6 py-3 border-b border-line shrink-0">
            <input
              type="search"
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full bg-bg-2 border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
            {visible.length === 0 ? (
              <EmptyTab tab={tab} hasQuery={query.trim().length > 0} />
            ) : (
              <ul className="divide-y divide-line">
                {visible.map((r) => (
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
          </div>
        </>
      )}

      {cardElement}
    </div>
  );
}

function EmptyTab({ tab, hasQuery }: { tab: TabId; hasQuery: boolean }) {
  const lines: Record<TabId, [string, string]> = {
    all: [
      'No friends yet',
      'Use the Add Friend tab to search for someone by username and send a request.',
    ],
    pending: [
      'No pending requests',
      'Friend requests you send or receive will show up here until they’re accepted or declined.',
    ],
    blocked: [
      "You haven’t blocked anyone",
      "Open a profile and pick Block to silence someone’s messages from your view.",
    ],
    add: ['Add a friend', 'Search for someone by username.'],
  };
  const queryLines: [string, string] = [
    'No matches',
    'Try a different name or username.',
  ];
  const [title, sub] = hasQuery ? queryLines : lines[tab];
  return (
    <div className="h-full min-h-[40vh] flex flex-col items-center justify-center text-center px-6">
      <div className="text-ink-2 text-sm font-medium">{title}</div>
      <div className="text-ink-3 text-xs mt-1 max-w-sm">{sub}</div>
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

  return (
    <li className="flex items-center gap-3 px-4 sm:px-6 py-3 hover:bg-bg-2/40 transition-colors">
      <button
        type="button"
        onClick={(e) => onAvatarClick(user, e)}
        className="relative w-10 h-10 shrink-0 hover:ring-2 hover:ring-accent/50 rounded-full transition-shadow"
        aria-label={`Open profile for ${user.displayName}`}
      >
        <span className={`absolute inset-0 rounded-full text-sm flex items-center justify-center font-semibold ${tone}`} aria-hidden="true">
          {initials}
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

      <div className="flex items-center gap-1 shrink-0">
        {relType === 'friend' && (
          <>
            {!isSelf && (
              <RowButton
                onClick={() => void startVoiceCall()}
                icon={<Phone size={14} />}
                label="Call"
                disabled={callPending}
              />
            )}
            <RowButton
              onClick={() => void openDM()}
              icon={<MessageSquare size={14} />}
              label="Message"
            />
            <RowButton
              onClick={() => void remove(`${user.displayName} removed`)}
              icon={<UserMinus size={14} />}
              label="Remove"
              destructive
              disabled={busy}
            />
          </>
        )}
        {relType === 'incoming_request' && (
          <>
            <RowButton
              onClick={() => void accept()}
              icon={<UserPlus size={14} />}
              label="Accept"
              accent
              disabled={busy}
            />
            <RowButton
              onClick={() => void remove('Friend request declined')}
              icon={<X size={14} />}
              label="Decline"
              disabled={busy}
            />
          </>
        )}
        {relType === 'outgoing_request' && (
          <RowButton
            onClick={() => void remove('Friend request cancelled')}
            icon={<X size={14} />}
            label="Cancel"
            disabled={busy}
          />
        )}
        {relType === 'blocked' && (
          <RowButton
            onClick={() => void unblock()}
            icon={<Shield size={14} />}
            label="Unblock"
            disabled={busy}
          />
        )}
      </div>
    </li>
  );
}

function RowButton({
  onClick,
  icon,
  label,
  accent,
  destructive,
  disabled,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  accent?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const tone = accent
    ? 'bg-accent hover:bg-accent/90 text-white'
    : destructive
      ? 'bg-bg-3 hover:bg-red-950/40 text-ink-2 hover:text-red-300'
      : 'bg-bg-3 hover:bg-bg-3/80 text-ink-2 hover:text-ink-1';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-60 ${tone}`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
