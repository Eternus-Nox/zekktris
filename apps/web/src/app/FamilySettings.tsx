/**
 * Family / parental controls settings (Phase 1)
 * ---------------------------------------------
 * Lets a guardian request supervision of a child account, manage active
 * links + outgoing requests, and lets any user accept/decline a request
 * to supervise THEIR account. Supervision is consent-gated (the child
 * accepts) and transparent (a supervised user sees it here and in the
 * app-wide banner).
 *
 * Monitoring (viewing a child's messages/contacts), watch-words, and
 * restrictions attach to these links in later phases.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppState } from '../state/AppState';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import {
  ApiError,
  type Attachment,
  type FamilyUser,
  type FamilyChildChannel,
  type FamilyChildMessage,
  type ChildRestrictions,
  type FamilyRequest,
  type FamilyChildGuild,
  type FamilyFlag,
  type PublicUser,
} from '@zekktris/client';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { Users, ChevronLeft, ChevronRight } from '../lib/icons';
import { ExpiredBadge, ExpiredMediaCard, EXPIRED_TITLE } from '../lib/mediaRetention';
import { useNavigate } from 'react-router-dom';

/** Mirrors the server cap (supervision.MAX_CHILDREN_PER_PARENT). */
const MAX_CHILDREN = 6;

/** iOS `sectionTitle`: uppercase, tracked, muted — the shared section label. */
const SECTION_LABEL = 'text-[11px] font-bold uppercase tracking-wider text-ink-3';

/** iOS renders an accent-tinted checkmark.circle.fill for an allowed ability. */
function AllowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" className="shrink-0 text-emerald-400" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.18" />
      <path d="M8 12.5l2.5 2.5 5-5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A grey xmark.circle.fill for a restricted ability. */
function DenyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" className="shrink-0 text-ink-3" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.18" />
      <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** iOS decline control on request rows: a plain xmark button. */
function XMark({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function PersonRow({
  user,
  children,
  onClick,
}: {
  user: FamilyUser;
  children?: React.ReactNode;
  onClick?: () => void;
}) {
  const name = user.displayName || user.username;
  return (
    <li
      className={`flex items-center gap-3 px-3 py-2 bg-bg-2 border border-line rounded-md ${
        onClick ? 'cursor-pointer hover:bg-bg-3' : ''
      }`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <span
        className="relative overflow-hidden shrink-0 w-9 h-9 rounded-full grid place-items-center text-xs font-semibold text-white"
        style={{ background: avatarColor(user.id) }}
      >
        <span className="zk-avatar-initials">{avatarInitials(name)}</span>
        <AvatarImage src={user.avatarUrl} alt={name} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-1">{name}</span>
        <span className="block truncate text-xs text-ink-3">@{user.username}</span>
      </span>
      {children}
    </li>
  );
}

/**
 * Read-only profile view for a contact in the child's orbit (a friend,
 * or a DM recipient). The parent isn't acting on the relationship — no
 * add/message/block — they're just seeing who this person is. Seeds from
 * the FamilyUser we already have, then enriches with the public profile.
 */
function ContactProfileModal({
  user,
  onClose,
}: {
  user: FamilyUser;
  onClose: () => void;
}) {
  const { rest } = useAuth();
  const [profile, setProfile] = useState<PublicUser | null>(null);
  useEffect(() => {
    let off = false;
    rest
      .getUser(user.id)
      .then((r) => !off && setProfile(r.user))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [rest, user.id]);

  const name = profile?.displayName || user.displayName || user.username;
  const username = profile?.username || user.username;
  const avatarUrl = profile?.avatarUrl ?? user.avatarUrl;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-bg-1 border border-line rounded-lg overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-20 bg-bg-3 relative">
          {profile?.bannerUrl && (
            <img src={profile.bannerUrl} alt="" className="w-full h-full object-cover" />
          )}
        </div>
        <div className="px-4 pb-4">
          <span
            className="relative overflow-hidden inline-grid place-items-center -mt-9 w-16 h-16 rounded-full border-4 border-bg-1 text-lg font-semibold text-white"
            style={{ background: avatarColor(user.id) }}
          >
            <span className="zk-avatar-initials">{avatarInitials(name)}</span>
            <AvatarImage src={avatarUrl} alt={name} />
          </span>
          <div className="mt-2 flex items-center gap-2">
            <h3 className="text-base font-semibold text-ink-1 truncate">{name}</h3>
            {profile?.isBot && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent uppercase">
                Bot
              </span>
            )}
          </div>
          <p className="text-sm text-ink-3">@{username}</p>
          {profile && (
            <p className="text-xs text-ink-3 mt-1 capitalize">{profile.status}</p>
          )}
          {profile?.customStatus && (
            <p className="text-sm text-ink-2 mt-2 break-words">
              {profile.customStatusEmoji ? `${profile.customStatusEmoji} ` : ''}
              {profile.customStatus}
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full text-sm px-3 py-2 rounded-md border border-line bg-bg-2 text-ink-2 hover:bg-bg-3"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function FamilySettings() {
  const navigate = useNavigate();
  const { state, reloadSupervision, loadDMs } = useAppState();
  const { rest } = useAuth();
  const toasts = useToasts();
  const sup = state.supervision;

  const [username, setUsername] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [viewingChild, setViewingChild] = useState<FamilyUser | null>(null);
  const [requests, setRequests] = useState<FamilyRequest[]>([]);

  const supervisesChildren = !!sup && sup.children.length > 0;
  useEffect(() => {
    if (!supervisesChildren) {
      setRequests([]);
      return;
    }
    let off = false;
    rest
      .familyRequests()
      .then((r) => !off && setRequests(r.requests))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [rest, supervisesChildren, state.familyNudge]);

  const resolveRequest = async (id: string, action: 'approve' | 'deny') => {
    setBusy(`req-${id}`);
    try {
      await (action === 'approve'
        ? rest.familyApproveRequest(id)
        : rest.familyDenyRequest(id));
      setRequests((rs) => rs.filter((r) => r.id !== id));
      toasts.push(action === 'approve' ? 'Approved' : 'Declined', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Something went wrong', 'error');
    } finally {
      setBusy(null);
    }
  };

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      await reloadSupervision();
      // Linking changes a supervised user's DM E2EE policy; refresh the
      // DM channels so encryption flips on/off immediately rather than
      // waiting for a reconnect.
      void loadDMs().catch(() => undefined);
      if (ok) toasts.push(ok, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Something went wrong', 'error');
    } finally {
      setBusy(null);
    }
  }

  const addChild = () => {
    const u = username.trim();
    if (!u) return;
    void run('add', () => rest.familyRequestLink(u), 'Supervision request sent').then(() =>
      setUsername(''),
    );
  };

  const inviteParent = () => {
    const email = parentEmail.trim();
    if (!email) return;
    setBusy('invite-parent');
    rest
      .familyRequestParent(email)
      .then(async (r) => {
        await reloadSupervision();
        setParentEmail('');
        toasts.push(
          r.status === 'awaiting_signup'
            ? "Invite emailed — they'll appear here once they make an account and accept."
            : 'Invite sent — waiting for them to accept.',
          'success',
        );
      })
      .catch((e) => toasts.push(e instanceof ApiError ? e.message : 'Something went wrong', 'error'))
      .finally(() => setBusy(null));
  };

  // Show the "link a guardian" surface to minors (and anyone with a pending
  // guardian invite or who already has a guardian and could add a second).
  const showGuardianInvite =
    !!sup &&
    (sup.isMinor ||
      sup.supervisedBy.length > 0 ||
      sup.graceActive ||
      sup.restrictedHeavily ||
      (sup.outgoingParentRequests?.length ?? 0) > 0);

  if (!sup) {
    return <p className="text-sm text-ink-3">Loading…</p>;
  }

  if (viewingChild) {
    return <ChildMonitor child={viewingChild} onBack={() => setViewingChild(null)} nudge={state.familyNudge} />;
  }

  // A minor (13–17) can't supervise anyone — they only get the child side
  // (link a guardian, who supervises me). Hide every parent-side control.
  const isMinor = !!sup.isMinor;

  return (
    <div className="space-y-6">
      {/* Header styled to match Settings — small accent icon + title over a
          soft divider — so parental controls feels part of the same surface. */}
      <header
        className="flex items-center gap-2 sm:gap-3 pb-3 border-b -mx-4 sm:-mx-6 px-4 sm:px-6"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <button
          onClick={() => navigate('/channels/@me')}
          className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={18} />
        </button>
        <Users size={16} className="text-accent shrink-0" />
        <div className="min-w-0">
          <h1 className="text-base sm:text-lg font-semibold text-ink-1 leading-tight truncate">
            Parental Controls
          </h1>
        </div>
      </header>

      <div className="rounded-xl border border-line bg-bg-1/60 p-3.5 text-xs text-ink-3 leading-relaxed">
        {isMinor ? (
          <>
            Connect a parent or guardian to your account. A supervised account is
            always shown that it&apos;s supervised — this is never hidden. While
            supervised, your direct messages aren&apos;t end-to-end encrypted (so your
            guardian can review them), except messages with your guardian, which
            stay private.
          </>
        ) : (
          <>
            Supervise a child account to help keep them safe. They must accept your
            request, and a supervised account is always shown that it&apos;s supervised —
            this is never hidden. While supervised, the child&apos;s direct messages
            aren&apos;t end-to-end encrypted (so you can review them), except messages
            between the two of you, which stay private.
          </>
        )}
      </div>

      {/* Minor age-gate state (child POV). */}
      {sup.restrictedHeavily ? (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3.5 text-sm text-red-200 leading-relaxed">
          Your account is restricted until a parent or guardian is linked. Ask a guardian to
          supervise your account by entering their email below.
        </div>
      ) : sup.graceActive ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-sm text-amber-200 leading-relaxed">
          Link a parent or guardian within{' '}
          <strong>
            {sup.graceDaysRemaining ?? 0} {(sup.graceDaysRemaining ?? 0) === 1 ? 'day' : 'days'}
          </strong>{' '}
          to keep full access. After that your account is limited until a guardian is connected.
        </div>
      ) : null}

      {/* Read-only summary of MY own restrictions when I'm supervised. Mirrors
          the iOS 'YOUR ACCOUNT IS SUPERVISED' card. */}
      {sup.restrictions && (
        <section className="space-y-2">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-accent">
            Your account is supervised
          </h4>
          <div className="rounded-md border border-line bg-bg-2 divide-y divide-line">
            {(
              [
                { key: 'canAddFriends', label: 'Add friends' },
                { key: 'canRemoveFriends', label: 'Remove friends' },
                { key: 'allowVoice', label: 'Join voice channels' },
                { key: 'allowVideo', label: 'Use video' },
                { key: 'allowStream', label: 'Stream' },
                { key: 'allowJoinGuilds', label: 'Join servers' },
                { key: 'allowMessaging', label: 'Send messages in servers' },
                { key: 'allowCreateGuild', label: 'Create servers' },
              ] as const
            ).map((r) => (
              <div key={r.key} className="flex items-center gap-2.5 px-3 py-2">
                {sup.restrictions?.[r.key] ? <AllowIcon /> : <DenyIcon />}
                <span className="text-sm text-ink-1">{r.label}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Link a guardian by email (child POV). */}
      {showGuardianInvite && (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>Link a guardian</h4>
          <p className="text-xs text-ink-3 leading-relaxed">
            Enter a parent or guardian&apos;s email. If they have an account they&apos;ll get a
            request to approve; otherwise we&apos;ll email them an invite to create one.
          </p>
          <div className="flex gap-2">
            <input
              type="email"
              value={parentEmail}
              onChange={(e) => setParentEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && inviteParent()}
              placeholder="guardian@email.com"
              className="flex-1 bg-bg-1/60 border rounded-md px-3 py-2 text-sm outline-none focus:shadow-[0_0_0_1px_var(--accent-glow)]"
              style={{ borderColor: 'var(--zk-line)' }}
            />
            <button
              type="button"
              disabled={busy !== null || !parentEmail.trim()}
              onClick={inviteParent}
              className="text-sm px-3 py-2 rounded-md border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-40 shrink-0"
            >
              {busy === 'invite-parent' ? '…' : 'Send invite'}
            </button>
          </div>
          {(sup.outgoingParentRequests?.length ?? 0) > 0 && (
            <ul className="space-y-1.5 pt-1">
              {sup.outgoingParentRequests!.map((u) => (
                <PersonRow key={u.id} user={u}>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-ink-3">Pending</span>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`cancel-${u.id}`, () => rest.familyRemoveLink(u.id), 'Invite cancelled')
                      }
                      className="text-xs px-2.5 py-1 rounded border border-line text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </span>
                </PersonRow>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Supervise a child — its own section, above the lists (iOS order).
          Parent-side only: a minor can't supervise anyone. */}
      {!isMinor && sup.children.length < MAX_CHILDREN && (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>Supervise a child account</h4>
          <div className="flex gap-2">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addChild();
              }}
              placeholder="Child's username"
              className="flex-1 min-w-0 text-sm bg-bg-2 border border-line rounded-md px-3 py-2 text-ink-1 placeholder:text-ink-3"
            />
            <button
              type="button"
              disabled={busy !== null || username.trim().length === 0}
              onClick={addChild}
              className="shrink-0 text-sm px-3 py-2 rounded-md border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-40"
            >
              {busy === 'add' ? 'Sending…' : 'Request'}
            </button>
          </div>
        </section>
      )}

      {/* Child-initiated requests awaiting MY (the parent's) acceptance. */}
      {!isMinor && (sup.incomingChildRequests?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>Asking you to supervise them</h4>
          <ul className="space-y-1.5">
            {sup.incomingChildRequests!.map((u) => (
              <PersonRow key={u.id} user={u}>
                <span className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`accchild-${u.id}`, () => rest.familyAcceptChildRequest(u.id), 'Now supervising')
                    }
                    className="text-xs font-medium px-2.5 py-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`declchild-${u.id}`, () => rest.familyRemoveLink(u.id), 'Declined')
                    }
                    aria-label="Decline"
                    className="w-7 h-7 grid place-items-center rounded-full text-ink-3 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40"
                  >
                    <XMark />
                  </button>
                </span>
              </PersonRow>
            ))}
          </ul>
        </section>
      )}

      {/* Requests awaiting MY acceptance */}
      {sup.incomingRequests.length > 0 && (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>Requests to accept</h4>
          <ul className="space-y-1.5">
            {sup.incomingRequests.map((u) => (
              <PersonRow key={u.id} user={u}>
                <span className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`acc-${u.id}`, () => rest.familyAcceptLink(u.id), 'Request accepted')
                    }
                    className="text-xs font-medium px-2.5 py-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run(`dec-${u.id}`, () => rest.familyRemoveLink(u.id))}
                    aria-label="Decline"
                    className="w-7 h-7 grid place-items-center rounded-full text-ink-3 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40"
                  >
                    <XMark />
                  </button>
                </span>
              </PersonRow>
            ))}
          </ul>
        </section>
      )}

      {/* Approval requests from supervised children */}
      {!isMinor && requests.length > 0 && (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>Requests to approve</h4>
          <ul className="space-y-1.5">
            {requests.map((r) => {
              const childName = r.child.displayName || r.child.username;
              const what =
                r.type === 'friend'
                  ? `add ${r.target ? r.target.displayName || r.target.username : 'a friend'}`
                  : `join ${r.guild?.name ? `“${r.guild.name}”` : 'a server'}`;
              return (
                <li
                  key={r.id}
                  className="px-3 py-2 bg-bg-2 border border-line rounded-md text-sm"
                >
                  <p className="text-ink-1">
                    <span className="font-medium">{childName}</span>
                    <span className="text-ink-2"> wants to {what}</span>
                  </p>
                  {r.note && <p className="text-xs text-ink-3 mt-0.5">“{r.note}”</p>}
                  <div className="flex gap-1.5 mt-1.5">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void resolveRequest(r.id, 'approve')}
                      className="text-xs px-2.5 py-1 rounded border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-40"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void resolveRequest(r.id, 'deny')}
                      className="text-xs px-2.5 py-1 rounded border border-line text-ink-2 hover:bg-bg-3 disabled:opacity-40"
                    >
                      Decline
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Who supervises me */}
      {sup.supervisedBy.length > 0 && (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>
            Supervising your account
            <span className="ml-1.5 font-normal normal-case">
              {sup.supervisedBy.length} of 2
            </span>
          </h4>
          <ul className="space-y-1.5">
            {sup.supervisedBy.map((u) => (
              <PersonRow key={u.id} user={u}>
                <span className="shrink-0 text-xs text-ink-3 px-1.5">Guardian</span>
              </PersonRow>
            ))}
          </ul>
          <p className="text-xs text-ink-3">
            Only a guardian can remove supervision.
          </p>
        </section>
      )}

      {/* Children I supervise — parent-side; hidden entirely for minors. */}
      {!isMinor && (
      <section className="space-y-2">
        <h4 className={SECTION_LABEL}>
          Children you supervise
          <span className="ml-1.5 font-normal normal-case">
            {sup.children.length} of {MAX_CHILDREN}
          </span>
        </h4>
        {sup.children.length === 0 ? (
          <p className="text-xs text-ink-3">No supervised accounts yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {sup.children.map((u) => (
              <PersonRow key={u.id} user={u} onClick={() => setViewingChild(u)}>
                <span className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={(e) => {
                      e.stopPropagation();
                      void run(`rm-${u.id}`, () => rest.familyRemoveLink(u.id));
                    }}
                    className="text-xs font-medium px-2 py-1 text-red-300 hover:text-red-200 disabled:opacity-40"
                  >
                    Remove
                  </button>
                  <ChevronRight size={16} className="text-ink-3" />
                </span>
              </PersonRow>
            ))}
          </ul>
        )}

        {sup.children.length >= MAX_CHILDREN && (
          <p className="text-xs text-ink-3 pt-1">
            You're supervising the maximum of {MAX_CHILDREN} accounts. Remove one
            to add another.
          </p>
        )}
      </section>
      )}

      {/* Outgoing requests (parent-side; hidden for minors) */}
      {!isMinor && sup.outgoingRequests.length > 0 && (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>Pending requests you've sent</h4>
          <ul className="space-y-1.5">
            {sup.outgoingRequests.map((u) => (
              <PersonRow key={u.id} user={u}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run(`cx-${u.id}`, () => rest.familyRemoveLink(u.id))}
                  className="shrink-0 text-xs px-2.5 py-1 rounded border border-line text-ink-2 hover:bg-bg-3 disabled:opacity-40"
                >
                  Cancel
                </button>
              </PersonRow>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * One attachment in the parent's read-only review of a child's DM.
 *
 * Two rules, both from `lib/mediaRetention`:
 *  1. Render the THUMBNAIL, not the original. These are ~200px preview
 *     boxes in a long scrolling list; pulling full-size originals into
 *     them is pure waste.
 *  2. Gate every full-size fetch (inline src, "open original",
 *     download) on `blobExpiredAt` — never on a missing `url`, which
 *     stays populated after retention ages the bytes out. An expired
 *     original must read as "no longer stored", not as a broken image:
 *     a parent needs to be able to tell "the server dropped this after
 *     N days" apart from "this failed to load" or, worse, "my child
 *     deleted the evidence".
 */
function ReviewAttachment({ at }: { at: Attachment }) {
  const expired = !!at.blobExpiredAt;
  const isImage = at.contentType.startsWith('image/');
  // The thumbnail survives retention forever; the original is only a
  // legitimate preview source while it is still stored.
  const preview = at.thumbnailUrl ?? (expired ? null : at.url);

  if (isImage && preview) {
    const img = (
      <img
        src={preview}
        alt={at.filename}
        title={expired ? EXPIRED_TITLE : at.filename}
        loading="lazy"
        decoding="async"
        className="max-h-48 rounded border border-line"
      />
    );
    // Still stored → the preview links out to the full-size original.
    // Expired → no link at all, plus the badge explaining why.
    return expired ? (
      <span className="relative mt-1 inline-block">
        {img}
        <ExpiredBadge />
      </span>
    ) : (
      <a
        href={at.url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-block"
      >
        {img}
      </a>
    );
  }

  // No usable preview: an expired file/video/voice note, or an expired
  // image old enough to predate thumbnails.
  if (expired) {
    return <ExpiredMediaCard className="mt-1" filename={at.filename} />;
  }

  return (
    <a
      href={at.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-block text-xs text-accent hover:underline"
    >
      📎 {at.filename}
    </a>
  );
}

/**
 * Parent read view of one supervised child: their conversations (read
 * only) and their friends. Authorized server-side by the active link.
 */
function ChildMonitor({
  child,
  onBack,
  nudge,
}: {
  child: FamilyUser;
  onBack: () => void;
  nudge: number;
}) {
  const { rest } = useAuth();
  const [channels, setChannels] = useState<FamilyChildChannel[] | null>(null);
  const [friends, setFriends] = useState<
    Array<{ type: string; user: FamilyUser }> | null
  >(null);
  const [openChannel, setOpenChannel] = useState<FamilyChildChannel | null>(null);
  const [messages, setMessages] = useState<FamilyChildMessage[] | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [restrictions, setRestrictions] = useState<ChildRestrictions | null>(null);
  const [guilds, setGuilds] = useState<FamilyChildGuild[] | null>(null);
  const [watchWords, setWatchWords] = useState<string[] | null>(null);
  const [newWord, setNewWord] = useState('');
  const [flags, setFlags] = useState<FamilyFlag[] | null>(null);
  const [profileUser, setProfileUser] = useState<FamilyUser | null>(null);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [savingRestr, setSavingRestr] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    rest
      .familyChildChannels(child.id)
      .then((r) => !off && setChannels(r.channels))
      .catch((e) => !off && setErr(e instanceof ApiError ? e.message : 'Failed to load'));
    rest
      .familyChildFriends(child.id)
      .then((r) => !off && setFriends(r.relationships))
      .catch(() => undefined);
    rest
      .familyChildRestrictions(child.id)
      .then((r) => !off && setRestrictions(r.restrictions))
      .catch(() => undefined);
    rest
      .familyChildGuilds(child.id)
      .then((r) => !off && setGuilds(r.guilds))
      .catch(() => undefined);
    rest
      .familyChildWatchWords(child.id)
      .then((r) => !off && setWatchWords(r.words))
      .catch(() => undefined);
    rest
      .familyChildFlags(child.id)
      .then((r) => !off && setFlags(r.flags))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [rest, child.id]);

  const PAGE = 25;
  useEffect(() => {
    if (!openChannel) return;
    let off = false;
    setMessages(null);
    setHasMoreOlder(false);
    rest
      .familyChildMessages(child.id, openChannel.id, { limit: PAGE })
      .then((r) => {
        if (off) return;
        // listMessages returns newest-first; show chronological.
        const sorted = [...r.messages].sort((a, b) =>
          BigInt(a.id) > BigInt(b.id) ? 1 : -1,
        );
        setMessages(sorted);
        setHasMoreOlder(r.messages.length >= PAGE);
      })
      .catch((e) => !off && setErr(e instanceof ApiError ? e.message : 'Failed to load'));
    return () => {
      off = true;
    };
  }, [rest, child.id, openChannel]);

  // Cursor paging: fetch the next 25 OLDER messages and prepend them.
  const loadOlder = async () => {
    if (!openChannel || !messages || messages.length === 0 || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await rest.familyChildMessages(child.id, openChannel.id, {
        before: messages[0].id, // chronological: index 0 is the oldest loaded
        limit: PAGE,
      });
      const older = [...r.messages].sort((a, b) =>
        BigInt(a.id) > BigInt(b.id) ? 1 : -1,
      );
      setMessages((cur) => [...older, ...(cur ?? [])]);
      setHasMoreOlder(r.messages.length >= PAGE);
    } catch {
      /* leave the button; user can retry */
    } finally {
      setLoadingOlder(false);
    }
  };

  // Live refresh of the flag feed when a new flag arrives over the
  // gateway (parent is watching this child). Skips the initial mount
  // (nudge starts unchanged) — the mount effect already loaded flags.
  const mountedNudge = useRef(nudge);
  useEffect(() => {
    if (nudge === mountedNudge.current) return;
    let off = false;
    rest
      .familyChildFlags(child.id)
      .then((r) => !off && setFlags(r.flags))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [rest, child.id, nudge]);

  const childName = child.displayName || child.username;
  const friendList = (friends ?? []).filter((f) => f.type === 'friend');
  const blockedList = (friends ?? []).filter((f) => f.type === 'blocked');

  const toggle = async (key: keyof ChildRestrictions) => {
    if (!restrictions || savingRestr) return;
    const next = { ...restrictions, [key]: !restrictions[key] };
    setRestrictions(next);
    setSavingRestr(true);
    try {
      const r = await rest.familySetRestrictions(child.id, { [key]: next[key] });
      setRestrictions(r.restrictions);
    } catch {
      setRestrictions(restrictions); // revert
    } finally {
      setSavingRestr(false);
    }
  };

  const chooseDmPolicy = async (dmPolicy: ChildRestrictions['dmPolicy']) => {
    if (!restrictions || savingRestr || restrictions.dmPolicy === dmPolicy) return;
    setRestrictions({ ...restrictions, dmPolicy });
    setSavingRestr(true);
    try {
      const r = await rest.familySetRestrictions(child.id, { dmPolicy });
      setRestrictions(r.restrictions);
    } catch {
      setRestrictions(restrictions); // revert
    } finally {
      setSavingRestr(false);
    }
  };

  const toggleGuildBlock = async (g: FamilyChildGuild) => {
    if (!guilds) return;
    const next = guilds.map((x) => (x.id === g.id ? { ...x, blocked: !x.blocked } : x));
    setGuilds(next);
    try {
      if (g.blocked) await rest.familyUnblockGuild(child.id, g.id);
      else await rest.familyBlockGuild(child.id, g.id);
    } catch {
      setGuilds(guilds); // revert
    }
  };

  const addWord = async () => {
    const raw = newWord.trim();
    if (!raw) return;
    setNewWord('');
    try {
      const r = await rest.familyAddWatchWord(child.id, raw);
      setWatchWords(r.words);
    } catch {
      /* ignore */
    }
  };

  const removeWord = async (w: string) => {
    try {
      const r = await rest.familyRemoveWatchWord(child.id, w);
      setWatchWords(r.words);
    } catch {
      /* ignore */
    }
  };

  // Click a flag → jump to that conversation if it's a DM we can open.
  const openFlag = (f: FamilyFlag) => {
    const ch = (channels ?? []).find((c) => c.id === f.channelId);
    if (ch) {
      setHighlightMessageId(f.messageId);
      setOpenChannel(ch);
    }
    // Viewing clears the flag from the alert list (server marks it
    // reviewed, so it won't come back on refresh either).
    void rest.familyMarkFlagReviewed(f.id).catch(() => undefined);
    setFlags((fs) => (fs ?? []).filter((x) => x.id !== f.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="shrink-0 w-8 h-8 grid place-items-center rounded-lg border border-line text-ink-2 hover:bg-bg-3 hover:text-ink-1 transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <span
          className="relative overflow-hidden shrink-0 w-10 h-10 rounded-full grid place-items-center text-sm font-semibold text-white"
          style={{ background: avatarColor(child.id) }}
        >
          <span className="zk-avatar-initials">{avatarInitials(childName)}</span>
          <AvatarImage src={child.avatarUrl} alt={childName} />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink-1 truncate leading-tight">
            {childName}
          </h3>
          <p className="text-xs text-ink-3">Supervised view</p>
        </div>
      </div>

      {err && <p className="text-sm text-red-400">{err}</p>}

      {openChannel ? (
        /* Drill-down: reading one conversation (iOS pushes this as its own view). */
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              setOpenChannel(null);
              setHighlightMessageId(null);
            }}
            className="text-xs text-accent hover:underline"
          >
            ← All conversations
          </button>
          <p className="text-xs text-ink-3">
            with {openChannel.recipient?.displayName || openChannel.recipient?.username || 'unknown'}
          </p>
          {!messages ? (
            <p className="text-sm text-ink-3">Loading messages…</p>
          ) : messages.length === 0 ? (
            <p className="text-sm text-ink-3">No messages.</p>
          ) : (
            <>
              {hasMoreOlder && (
                <button
                  type="button"
                  disabled={loadingOlder}
                  onClick={() => void loadOlder()}
                  className="w-full text-xs px-3 py-1.5 rounded-md border border-line bg-bg-2 text-ink-2 hover:bg-bg-3 disabled:opacity-40"
                >
                  {loadingOlder ? 'Loading…' : 'Load older messages'}
                </button>
              )}
              <ul className="space-y-2">
                {messages.map((m) => (
                  <li
                    key={m.id}
                    ref={
                      m.id === highlightMessageId
                        ? (el) => el?.scrollIntoView({ block: 'center' })
                        : undefined
                    }
                    className={`text-sm rounded-md transition-colors ${
                      m.id === highlightMessageId
                        ? 'bg-accent/10 ring-1 ring-accent/40 -mx-2 px-2 py-1'
                        : ''
                    }`}
                  >
                    <span className="text-ink-3 text-xs">
                      {m.authorId === child.id ? childName : m.authorDisplayName || m.authorUsername || 'Them'}
                      {' · '}
                      {new Date(m.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                      {m.deleted && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">
                          Deleted
                        </span>
                      )}
                    </span>
                    {m.content && (
                      <p
                        className={`whitespace-pre-wrap break-words ${
                          m.deleted ? 'text-ink-3 italic line-through decoration-red-400/40' : 'text-ink-1'
                        }`}
                      >
                        {m.content}
                      </p>
                    )}
                    {m.attachments.map((at) => (
                      <ReviewAttachment key={at.id} at={at} />
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        /* Everything on one scrolling page, matching iOS ChildControlsView. */
        <div className="space-y-6">
          {/* WHAT <NAME> CAN DO */}
          <section className="space-y-2">
            <h4 className={SECTION_LABEL}>What {childName} can do</h4>
            {!restrictions ? (
              <p className="text-sm text-ink-3">Loading…</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  {(
                    [
                      { key: 'canAddFriends', label: 'Add friends' },
                      { key: 'canRemoveFriends', label: 'Remove friends' },
                      { key: 'allowVoice', label: 'Join voice channels' },
                      { key: 'allowVideo', label: 'Use video' },
                      { key: 'allowStream', label: 'Stream' },
                      { key: 'allowJoinGuilds', label: 'Join servers' },
                      { key: 'allowMessaging', label: 'Send messages in servers' },
                      { key: 'allowCreateGuild', label: 'Create servers' },
                    ] as const
                  ).map((r) => {
                    const on = restrictions[r.key];
                    return (
                      <div
                        key={r.key}
                        className="flex items-center justify-between px-3 py-2 bg-bg-2 border border-line rounded-md"
                      >
                        <span className="text-sm text-ink-1">{r.label}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          disabled={savingRestr}
                          onClick={() => void toggle(r.key)}
                          className={`relative w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${
                            on ? 'bg-accent' : 'bg-bg-3'
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                              on ? 'left-[1.125rem]' : 'left-0.5'
                            }`}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-ink-3 leading-relaxed">
                  Turn an ability off to restrict it. For friends and servers,{' '}
                  {childName} can still send you a request to approve.
                </p>
              </>
            )}
          </section>

          {/* CONTENT — ON is more protective (mask swear words), so it sits
              apart from the ability toggles above, whose ON means allowed. */}
          {restrictions && (
            <section className="space-y-2">
              <h4 className={SECTION_LABEL}>Content</h4>
              <div className="flex items-center justify-between px-3 py-2 bg-bg-2 border border-line rounded-md">
                <div className="pr-3">
                  <span className="text-sm text-ink-1">Blur swear words</span>
                  <p className="text-xs text-ink-3 leading-snug">
                    Mask profanity in {childName}'s messages.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={restrictions.filterProfanity}
                  disabled={savingRestr}
                  onClick={() => void toggle('filterProfanity')}
                  className={`relative w-10 h-6 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                    restrictions.filterProfanity ? 'bg-accent' : 'bg-bg-3'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                      restrictions.filterProfanity ? 'left-[1.125rem]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            </section>
          )}

          {/* WHO THEY CAN DM — a 3-way policy, not a simple on/off. */}
          {restrictions && (
            <section className="space-y-2">
              <h4 className={SECTION_LABEL}>Who they can DM</h4>
              <div className="flex gap-1.5">
                {(
                  [
                    { value: 'none', label: 'No DMs' },
                    { value: 'friends', label: 'Friends only' },
                    { value: 'all', label: 'Anyone' },
                  ] as const
                ).map((opt) => {
                  const active = restrictions.dmPolicy === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={savingRestr}
                      aria-pressed={active}
                      onClick={() => void chooseDmPolicy(opt.value)}
                      className={`flex-1 text-sm px-2 py-1.5 rounded-md border transition-colors disabled:opacity-50 ${
                        active
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-line bg-bg-2 text-ink-2 hover:border-accent/40'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* <NAME>'S SERVERS */}
          <section className="space-y-2">
            <h4 className={SECTION_LABEL}>{childName}'s servers</h4>
            {!guilds ? (
              <p className="text-xs text-ink-3">Loading…</p>
            ) : guilds.length === 0 ? (
              <p className="text-xs text-ink-3">{childName} isn't in any servers.</p>
            ) : (
              <ul className="space-y-1.5">
                {guilds.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center gap-3 px-3 py-2 bg-bg-2 border border-line rounded-md"
                  >
                    <span
                      className="relative overflow-hidden shrink-0 w-8 h-8 rounded-lg grid place-items-center text-xs font-semibold text-white"
                      style={{ background: avatarColor(g.id) }}
                    >
                      <span className="zk-avatar-initials">{avatarInitials(g.name)}</span>
                      <AvatarImage src={g.iconUrl} alt={g.name} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-1">{g.name}</span>
                      {g.blocked && <span className="block text-xs text-red-300">Blocked</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => void toggleGuildBlock(g)}
                      className={`shrink-0 text-xs px-2.5 py-1 rounded border ${
                        g.blocked
                          ? 'border-line text-ink-2 hover:bg-bg-3'
                          : 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                      }`}
                    >
                      {g.blocked ? 'Unblock' : 'Block'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[0.7rem] text-ink-3 leading-relaxed">
              A blocked server can't be joined. {childName} can ask you to approve a
              specific server with an invite link.
            </p>
          </section>

          {/* <NAME>'S FRIENDS */}
          <section className="space-y-2">
            <h4 className={SECTION_LABEL}>{childName}'s friends</h4>
            {!friends ? (
              <p className="text-sm text-ink-3">Loading friends…</p>
            ) : friendList.length === 0 && blockedList.length === 0 ? (
              <p className="text-sm text-ink-3">No friends.</p>
            ) : (
              <>
                {friendList.length === 0 ? (
                  <p className="text-sm text-ink-3">No friends.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {friendList.map((f) => (
                      <PersonRow key={f.user.id} user={f.user} onClick={() => setProfileUser(f.user)}>
                        <ChevronRight size={16} className="shrink-0 text-ink-3" />
                      </PersonRow>
                    ))}
                  </ul>
                )}
                {blockedList.length > 0 && (
                  <div className="pt-1 space-y-1.5">
                    <h5 className={SECTION_LABEL}>Blocked</h5>
                    <ul className="space-y-1.5">
                      {blockedList.map((f) => (
                        <PersonRow key={f.user.id} user={f.user} onClick={() => setProfileUser(f.user)}>
                          <span className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">
                              Blocked
                            </span>
                            <ChevronRight size={16} className="text-ink-3" />
                          </span>
                        </PersonRow>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>

          {/* <NAME>'S DIRECT MESSAGES */}
          <section className="space-y-2">
            <h4 className={SECTION_LABEL}>{childName}'s direct messages</h4>
            {!channels ? (
              <p className="text-sm text-ink-3">Loading conversations…</p>
            ) : channels.length === 0 ? (
              <p className="text-sm text-ink-3">No direct-message conversations.</p>
            ) : (
              <ul className="space-y-1.5">
                {channels.map((ch) => (
                  <li key={ch.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setHighlightMessageId(null);
                        setOpenChannel(ch);
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 bg-bg-2 border border-line rounded-md hover:bg-bg-3 text-left"
                    >
                      <span
                        className="relative overflow-hidden shrink-0 w-9 h-9 rounded-full grid place-items-center text-xs font-semibold text-white"
                        style={{ background: avatarColor(ch.recipient?.id ?? ch.id) }}
                      >
                        <span className="zk-avatar-initials">{avatarInitials(ch.recipient?.displayName || ch.recipient?.username || '?')}</span>
                        <AvatarImage
                          src={ch.recipient?.avatarUrl}
                          alt={ch.recipient?.displayName || ch.recipient?.username || ''}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink-1">
                          {ch.recipient?.displayName || ch.recipient?.username || 'Unknown'}
                        </span>
                        {ch.recipient?.username && (
                          <span className="block truncate text-xs text-ink-3">
                            @{ch.recipient.username}
                          </span>
                        )}
                      </span>
                      <ChevronRight size={16} className="shrink-0 text-ink-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* WATCH WORDS */}
          <section className="space-y-2">
            <h4 className={SECTION_LABEL}>Watch words</h4>
            <p className="text-xs text-ink-3 leading-relaxed">
              Messages {childName} sends or receives that contain one of these
              words get flagged for you to review. Matching is case-insensitive.
              Add several at once by separating them with commas.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addWord();
                }}
                placeholder="e.g. address, phone number, meet up"
                className="flex-1 min-w-0 text-sm bg-bg-2 border border-line rounded-md px-3 py-2 text-ink-1 placeholder:text-ink-3"
              />
              <button
                type="button"
                disabled={newWord.trim().length === 0}
                onClick={() => void addWord()}
                className="shrink-0 text-sm px-3 py-2 rounded-md border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-40"
              >
                Add
              </button>
            </div>
            {!watchWords ? (
              <p className="text-sm text-ink-3">Loading…</p>
            ) : watchWords.length === 0 ? (
              <p className="text-sm text-ink-3">No watch words yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {watchWords.map((w) => (
                  <li
                    key={w}
                    className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 bg-bg-2 border border-line rounded-full text-sm text-ink-1"
                  >
                    <span className="leading-none">{w}</span>
                    <button
                      type="button"
                      onClick={() => void removeWord(w)}
                      aria-label={`Remove ${w}`}
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-base leading-none text-ink-3 hover:text-ink-1 hover:bg-bg-3"
                    >
                      <span className="-mt-px">×</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* FLAGGED MESSAGES */}
          <section className="space-y-2">
            <h4 className={SECTION_LABEL}>
              Flagged messages
              {flags && flags.some((f) => !f.reviewed) && (
                <span className="ml-1.5 font-normal normal-case text-amber-300">
                  {flags.filter((f) => !f.reviewed).length} new
                </span>
              )}
            </h4>
            {!flags ? (
              <p className="text-sm text-ink-3">Loading…</p>
            ) : flags.length === 0 ? (
              <p className="text-sm text-ink-3">No flagged messages.</p>
            ) : (
              <ul className="space-y-1.5">
                {flags.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => openFlag(f)}
                      className={`w-full text-left px-3 py-2 rounded-md border ${
                        f.reviewed
                          ? 'bg-bg-2 border-line'
                          : 'bg-amber-500/10 border-amber-500/30'
                      } hover:bg-bg-3`}
                    >
                      <div className="flex items-center gap-2 text-xs text-ink-3">
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                          {f.matchedWord}
                        </span>
                        <span>{f.byChild ? `${childName} sent` : 'received'}</span>
                        <span className="ml-auto">
                          {new Date(f.createdAt).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      {f.snippet && (
                        <p className="mt-1 text-sm text-ink-1 line-clamp-2 break-words">
                          {f.snippet}
                        </p>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {profileUser && (
        <ContactProfileModal user={profileUser} onClose={() => setProfileUser(null)} />
      )}
    </div>
  );
}
