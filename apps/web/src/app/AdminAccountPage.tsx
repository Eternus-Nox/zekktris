/**
 * AdminAccountPage
 * ----------------
 * Admin → Users → an account. One page per account, replacing the Users
 * tab's row of inline buttons and expanding panels.
 *
 * Who sees what (user-decided 2026-09-27) — the server enforces all of it;
 * this component only avoids offering what the caller can't do:
 *   admins      account info, edit username / email / DOB, send password
 *               reset, role, membership, mute, ban, sign out, delete, notes,
 *               contacts
 *   moderators  mute, ban, sign out, DOB unlock, notes — no account info and
 *               no contacts. They also can't act on other staff accounts.
 *
 * Contacts load only when asked for: viewing them writes a staff audit row,
 * so merely opening the page mustn't.
 */

import { useEffect, useState } from 'react';
import {
  ApiError,
  type AdminAccount,
  type AdminAccountContacts,
  type AdminContactPerson,
  type AdminMuteDuration,
  type AdminUser,
  type StaffNote,
} from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { AvatarImage } from '../lib/AvatarImage';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { TierBadge } from '../lib/TierBadge';
import {
  AtSign,
  Ban,
  Bookmark,
  Calendar,
  CheckCircle,
  ChevronLeft,
  Edit,
  Inbox,
  Key,
  LogOut,
  MessageSquare,
  MicOff,
  Plus,
  RefreshCw,
  Shield,
  Trash,
  Users,
} from '../lib/icons';

const MUTE_DURATIONS: { value: AdminMuteDuration; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '1w', label: '1 week' },
  { value: 'perm', label: 'Permanent' },
];
const BAN_DURATIONS: { value: '1m' | '3m' | '6m' | 'perm'; label: string }[] = [
  { value: '1m', label: '1 month' },
  { value: '3m', label: '3 months' },
  { value: '6m', label: '6 months' },
  { value: 'perm', label: 'Permanent' },
];

const btn =
  'text-xs px-2.5 py-1.5 rounded bg-bg-3 hover:bg-bg-1 text-ink-2 hover:text-ink-1 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5';
const dangerBtn =
  'text-xs px-2.5 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5';
const input =
  'bg-bg-1 border border-line rounded-md px-2.5 py-1.5 text-sm text-ink-1 placeholder:text-ink-3 focus:outline-none focus:border-accent min-w-0';

function fmtDate(iso: string | null, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}
function fmtDob(dob: string | null): string {
  if (!dob) return 'Not on record';
  return new Date(`${dob}T00:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
function isActive(at: string | null | undefined, until: string | null | undefined): boolean {
  if (!at) return false;
  return !until || new Date(until).getTime() > Date.now();
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md bg-bg-2 border border-line p-3 space-y-2.5">
      <h3 className="text-[0.7rem] uppercase font-bold tracking-wider text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="text-ink-3 w-32 shrink-0">{label}</span>
      <span className="text-ink-1 min-w-0 break-words">{children}</span>
    </div>
  );
}

export function AdminAccountPage({
  user,
  onBack,
  onChanged,
  onDeleted,
}: {
  /** The list row the page was opened from — enough for the header and for
      a moderator's whole view. Admins also load the full record. */
  user: AdminUser;
  onBack: () => void;
  onChanged: (patch: Partial<AdminUser>) => void;
  onDeleted: () => void;
}) {
  const { rest, user: self } = useAuth();
  const toasts = useToasts();
  const selfIsAdmin = self?.isAdmin === true;
  // Moderators may not act on staff accounts (server rejects it too).
  const canModerate = selfIsAdmin || (!user.isAdmin && !user.isModerator);
  const isSelf = self?.id === user.id;

  const [account, setAccount] = useState<AdminAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<'username' | 'email' | 'dob' | null>(null);
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<'mute' | 'ban' | 'role' | 'gift' | null>(null);
  const [giftTier, setGiftTier] = useState<'scout' | 'guardian' | 'legend'>('scout');
  const [giftDuration, setGiftDuration] = useState<'1m' | '3m' | '6m' | 'forever'>('forever');
  const [notes, setNotes] = useState<StaffNote[] | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [contacts, setContacts] = useState<AdminAccountContacts | 'loading' | null>(null);

  // Live state, starting from the list row and overwritten by the full record.
  const muted = account ? account.muted : isActive(user.mutedAt, user.mutedUntil);
  const mutedUntil = account ? account.mutedUntil : (user.mutedUntil ?? null);
  const banned = account ? account.banned : isActive(user.bannedAt, user.bannedUntil);
  const bannedUntil = account ? account.bannedUntil : user.bannedUntil;

  useEffect(() => {
    let cancelled = false;
    if (selfIsAdmin) {
      rest
        .adminGetAccount(user.id)
        .then((r) => !cancelled && setAccount(r.account))
        .catch((e) => toasts.push(e instanceof ApiError ? e.message : 'Failed to load account', 'error'));
    }
    if (canModerate) {
      rest
        .adminListNotes(user.id)
        .then((r) => !cancelled && setNotes(r.notes))
        .catch(() => !cancelled && setNotes([]));
    }
    return () => {
      cancelled = true;
    };
  }, [rest, user.id, selfIsAdmin, canModerate, toasts]);

  async function run(key: string, fn: () => Promise<void>, fail = 'Action failed') {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : fail, 'error');
    } finally {
      setBusy(null);
    }
  }
  const refresh = async () => {
    if (!selfIsAdmin) return;
    const r = await rest.adminGetAccount(user.id);
    setAccount(r.account);
  };

  function startEdit(field: 'username' | 'email' | 'dob') {
    setEditing(field);
    setDraft(
      field === 'username'
        ? (account?.username ?? user.username)
        : field === 'email'
          ? (account?.email ?? '')
          : (account?.dateOfBirth ?? ''),
    );
  }

  const saveEdit = () =>
    run('edit', async () => {
      const value = draft.trim();
      if (editing === 'username') {
        const r = await rest.adminSetUsername(user.id, value);
        onChanged({ username: r.username });
        toasts.push(`Username changed to @${r.username}`, 'success');
      } else if (editing === 'email') {
        const r = await rest.adminSetEmail(user.id, value);
        onChanged({ email: value.toLowerCase() });
        toasts.push(
          r.oldAddressNotified ? 'Email changed — the old address was notified' : 'Email changed',
          'success',
        );
      } else if (editing === 'dob') {
        await rest.adminSetDateOfBirth(user.id, value);
        onChanged({ dateOfBirth: value });
        toasts.push('Date of birth updated', 'success');
      }
      setEditing(null);
      await refresh();
    });

  const sendReset = () => {
    if (
      !window.confirm(
        `Email @${user.username} a password-reset link and sign them out of every device?`,
      )
    )
      return;
    void run('reset', async () => {
      await rest.adminSendPasswordReset(user.id);
      toasts.push('Reset link sent and all sessions signed out', 'success');
      await refresh();
    });
  };

  const mute = (duration: AdminMuteDuration) =>
    run('mute', async () => {
      const r = await rest.adminMuteUser(user.id, duration);
      onChanged({ mutedAt: new Date().toISOString(), mutedUntil: r.mutedUntil });
      setPanel(null);
      toasts.push(`Muted @${user.username}`, 'success');
      await refresh();
    });
  const unmute = () =>
    run('mute', async () => {
      await rest.adminUnmuteUser(user.id);
      onChanged({ mutedAt: null, mutedUntil: null });
      toasts.push(`Unmuted @${user.username}`, 'success');
      await refresh();
    });

  const ban = (duration: '1m' | '3m' | '6m' | 'perm') =>
    run('ban', async () => {
      await rest.adminBanUser(user.id, duration);
      const months = { '1m': 1, '3m': 3, '6m': 6, perm: 0 }[duration];
      onChanged({
        bannedAt: new Date().toISOString(),
        bannedUntil: months ? new Date(Date.now() + months * 30 * 86_400_000).toISOString() : null,
      });
      setPanel(null);
      toasts.push(`Banned @${user.username}`, 'success');
      await refresh();
    });
  const unban = () =>
    run('ban', async () => {
      await rest.adminUnbanUser(user.id);
      onChanged({ bannedAt: null, bannedUntil: null });
      toasts.push(`Unbanned @${user.username}`, 'success');
      await refresh();
    });

  const signOut = () =>
    run('logout', async () => {
      await rest.adminLogoutUser(user.id);
      toasts.push(`Signed @${user.username} out of all devices`, 'success');
      await refresh();
    });

  const unlockDob = () =>
    run('dob-lock', async () => {
      await rest.adminResetDobLock(user.id);
      toasts.push(`@${user.username} can change their date of birth once more`, 'success');
      await refresh();
    });

  const setRole = (role: 'administrator' | 'moderator' | 'none') =>
    run('role', async () => {
      await rest.adminSetUserRole(user.id, role);
      onChanged({ isAdmin: role === 'administrator', isModerator: role === 'moderator' });
      setPanel(null);
      toasts.push('Role updated', 'success');
      await refresh();
    });

  const gift = () =>
    run('gift', async () => {
      const r = await rest.adminGiftSubscription(user.id, giftTier, giftDuration);
      onChanged({
        subscriptionTier: r.subscription.tier as AdminUser['subscriptionTier'],
        subscriptionExpiresAt: r.subscription.expiresAt,
      });
      setPanel(null);
      toasts.push(`Gave the ${giftTier} tier`, 'success');
      await refresh();
    });
  const removeMembership = () =>
    run('gift', async () => {
      await rest.adminRemoveSubscription(user.id);
      onChanged({ subscriptionTier: null, subscriptionExpiresAt: null });
      toasts.push('Perk tier removed', 'success');
      await refresh();
    });

  const deleteAccount = () => {
    if (
      !window.confirm(
        `Permanently delete @${user.username}? This removes their account and data and cannot be undone.`,
      )
    )
      return;
    void run('delete', async () => {
      await rest.adminDeleteUser(user.id);
      toasts.push(`Deleted @${user.username}`, 'success');
      onDeleted();
    });
  };

  const addNote = () =>
    run('note', async () => {
      const body = noteDraft.trim();
      if (!body) return;
      await rest.adminAddNote(user.id, body);
      setNoteDraft('');
      setNotes((await rest.adminListNotes(user.id)).notes);
    });
  const deleteNote = (n: StaffNote) =>
    run('note', async () => {
      await rest.adminDeleteNote(user.id, n.id);
      setNotes((prev) => prev?.filter((x) => x.id !== n.id) ?? null);
    });

  const loadContacts = () => {
    setContacts('loading');
    rest
      .adminGetAccountContacts(user.id)
      .then(setContacts)
      .catch((e) => {
        setContacts(null);
        toasts.push(e instanceof ApiError ? e.message : 'Failed to load contacts', 'error');
      });
  };

  const tone = avatarColor(user.id);
  const initials = avatarInitials(user.displayName ?? user.username);

  return (
    <div className="space-y-3 max-w-3xl">
      <button onClick={onBack} className={btn}>
        <ChevronLeft size={14} /> All users
      </button>

      {/* Header */}
      <div className="flex items-center gap-3 rounded-md bg-bg-2 border border-line p-3">
        <div className={`relative w-14 h-14 rounded-full flex items-center justify-center text-sm font-bold shrink-0 overflow-hidden ${tone}`}>
          <span className="zk-avatar-initials">{initials}</span>
          <AvatarImage src={user.avatarUrl} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-base font-semibold text-ink-1 truncate">
              {user.displayName ?? user.username}
            </span>
            {user.isAdmin && (
              <span className="text-[0.6rem] uppercase font-bold tracking-wider bg-accent/20 text-accent px-1 py-0.5 rounded">administrator</span>
            )}
            {user.isModerator && (
              <span className="text-[0.6rem] uppercase font-bold tracking-wider bg-sky-500/20 text-sky-400 px-1 py-0.5 rounded">moderator</span>
            )}
            {banned && (
              <span className="text-[0.6rem] uppercase font-bold tracking-wider bg-red-500/20 text-red-400 px-1 py-0.5 rounded">
                {bannedUntil ? `banned · until ${fmtDate(bannedUntil)}` : 'banned'}
              </span>
            )}
            {muted && (
              <span className="text-[0.6rem] uppercase font-bold tracking-wider bg-amber-500/20 text-amber-400 px-1 py-0.5 rounded">
                {mutedUntil ? `muted · until ${fmtDate(mutedUntil, true)}` : 'muted'}
              </span>
            )}
            <TierBadge tier={user.subscriptionTier} />
          </div>
          <div className="text-xs text-ink-3">@{user.username}</div>
        </div>
      </div>

      {/* Account info — admins only */}
      {selfIsAdmin && (
        <Section title="Account">
          {!account ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : (
            <>
              {editing ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink-3 w-32 shrink-0">
                    {editing === 'username' ? 'New username' : editing === 'email' ? 'New email' : 'Date of birth'}
                  </span>
                  <input
                    autoFocus
                    type={editing === 'dob' ? 'date' : editing === 'email' ? 'email' : 'text'}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void saveEdit()}
                    className={`${input} flex-1`}
                  />
                  <button onClick={() => void saveEdit()} disabled={busy === 'edit' || !draft.trim()} className={btn}>
                    <CheckCircle size={13} /> Save
                  </button>
                  <button onClick={() => setEditing(null)} className={btn}>
                    Cancel
                  </button>
                  {editing === 'email' && (
                    <p className="basis-full text-[0.7rem] text-ink-3">
                      The new address is treated as verified, and the old address gets a notice that it was changed.
                    </p>
                  )}
                  {editing === 'dob' && (
                    <p className="basis-full text-[0.7rem] text-ink-3">
                      Must be 13 or older. An age under 18 turns on minor supervision for the account.
                    </p>
                  )}
                </div>
              ) : null}
              <Row label="Username">
                @{account.username}{' '}
                <button onClick={() => startEdit('username')} className="ml-1 text-ink-3 hover:text-ink-1 align-middle" title="Change username">
                  <Edit size={12} />
                </button>
              </Row>
              <Row label="Email">
                {account.email}{' '}
                <span className={`text-[0.65rem] ${account.emailVerified ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {account.emailVerified ? 'verified' : 'unverified'}
                </span>{' '}
                <button onClick={() => startEdit('email')} className="ml-1 text-ink-3 hover:text-ink-1 align-middle" title="Change email">
                  <Edit size={12} />
                </button>
              </Row>
              <Row label="Date of birth">
                {fmtDob(account.dateOfBirth)}
                {account.isMinor && <span className="ml-1.5 text-[0.65rem] text-amber-400">minor</span>}
                <span className="ml-1.5 text-[0.65rem] text-ink-3">{account.dobLocked ? 'locked' : 'self-change open'}</span>{' '}
                <button onClick={() => startEdit('dob')} className="ml-1 text-ink-3 hover:text-ink-1 align-middle" title="Set date of birth">
                  <Edit size={12} />
                </button>
              </Row>
              <Row label="Joined">{fmtDate(account.createdAt)}</Row>
              <Row label="Last online">{fmtDate(account.lastSeenAt, true)}</Row>
              <Row label="Two-factor">{account.twoFactorEnabled ? 'On' : 'Off'}</Row>
              <Row label="Signed-in devices">{account.activeSessions}</Row>
              <Row label="Servers / friends">
                {account.guildCount} / {account.friendCount}
              </Row>
              <Row label="Perk tier">
                {account.subscriptionTier
                  ? `${account.subscriptionTier} · ${account.subscriptionExpiresAt ? `until ${fmtDate(account.subscriptionExpiresAt)}` : 'forever'}`
                  : 'None'}
              </Row>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <button onClick={sendReset} disabled={busy === 'reset' || isSelf} className={btn} title="Emails the standard reset link. You never see it or choose the password.">
                  <Key size={13} /> Send password reset
                </button>
                <button onClick={() => void unlockDob()} disabled={busy === 'dob-lock'} className={btn} title="Let them change their date of birth themselves, once">
                  <Calendar size={13} /> Allow one DOB change
                </button>
              </div>
            </>
          )}
        </Section>
      )}

      {/* Moderation */}
      {!isSelf && canModerate && (
        <Section title="Moderation">
          <div className="flex flex-wrap gap-1.5">
            {muted ? (
              <button onClick={() => void unmute()} disabled={busy === 'mute'} className={btn}>
                <CheckCircle size={13} /> Unmute
              </button>
            ) : (
              <button onClick={() => setPanel(panel === 'mute' ? null : 'mute')} className={btn}>
                <MicOff size={13} /> Mute
              </button>
            )}
            {banned ? (
              <button onClick={() => void unban()} disabled={busy === 'ban'} className={btn}>
                <CheckCircle size={13} /> Unban
              </button>
            ) : (
              <button onClick={() => setPanel(panel === 'ban' ? null : 'ban')} className={dangerBtn}>
                <Ban size={13} /> Ban
              </button>
            )}
            {!banned && (
              <button onClick={() => void signOut()} disabled={busy === 'logout'} className={btn}>
                <LogOut size={13} /> Sign out everywhere
              </button>
            )}
            {!selfIsAdmin && (
              <button onClick={() => void unlockDob()} disabled={busy === 'dob-lock'} className={btn}>
                <Calendar size={13} /> Allow one DOB change
              </button>
            )}
            {selfIsAdmin && (
              <>
                <button onClick={() => setPanel(panel === 'role' ? null : 'role')} className={btn}>
                  <Shield size={13} /> Role
                </button>
                <button onClick={() => setPanel(panel === 'gift' ? null : 'gift')} className={btn}>
                  <Bookmark size={13} /> Perk tier
                </button>
                <button onClick={deleteAccount} disabled={busy === 'delete'} className={dangerBtn}>
                  <Trash size={13} /> Delete account
                </button>
              </>
            )}
          </div>

          {panel === 'mute' && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-line">
              <span className="text-xs text-ink-3 mr-1">Mute for:</span>
              {MUTE_DURATIONS.map((d) => (
                <button key={d.value} onClick={() => void mute(d.value)} disabled={busy === 'mute'} className="text-xs px-2.5 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-40">
                  {d.label}
                </button>
              ))}
              <span className="basis-full text-[0.65rem] text-ink-3">
                They can still sign in and read, but can’t send messages or DMs, react, or talk in voice. Muting drops them out of any call.
              </span>
            </div>
          )}
          {panel === 'ban' && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-line">
              <span className="text-xs text-ink-3 mr-1">Ban for:</span>
              {BAN_DURATIONS.map((d) => (
                <button key={d.value} onClick={() => void ban(d.value)} disabled={busy === 'ban'} className="text-xs px-2.5 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40">
                  {d.label}
                </button>
              ))}
              <span className="basis-full text-[0.65rem] text-ink-3">
                Bans revoke sessions and evict from all voice — the account can’t be used until it’s lifted.
              </span>
            </div>
          )}
          {panel === 'role' && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-line">
              <span className="text-xs text-ink-3">
                Role: <span className="text-ink-1 font-medium">{user.isAdmin ? 'Administrator' : user.isModerator ? 'Moderator' : 'None'}</span>
              </span>
              {!user.isAdmin && (
                <button onClick={() => void setRole('administrator')} disabled={busy === 'role'} className="text-xs px-2.5 py-1 rounded border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-40">
                  Administrator
                </button>
              )}
              {!user.isModerator && (
                <button onClick={() => void setRole('moderator')} disabled={busy === 'role'} className="text-xs px-2.5 py-1 rounded border border-sky-500/40 bg-sky-500/15 text-ink-1 hover:bg-sky-500/25 disabled:opacity-40">
                  Moderator
                </button>
              )}
              {(user.isAdmin || user.isModerator) && (
                <button onClick={() => void setRole('none')} disabled={busy === 'role'} className="text-xs px-2.5 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40">
                  Remove role
                </button>
              )}
            </div>
          )}
          {panel === 'gift' && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-line">
              <select value={giftTier} onChange={(e) => setGiftTier(e.target.value as typeof giftTier)} className="text-xs bg-bg-3 border border-line rounded px-1.5 py-1 text-ink-1" aria-label="Perk tier">
                {/* Plain names, as on iOS and Android: tiers are free perks staff
                    give out, so the old "$2 / $5 / $10" prices are gone. */}
                <option value="scout">Scout</option>
                <option value="guardian">Guardian</option>
                <option value="legend">Legend</option>
              </select>
              <select value={giftDuration} onChange={(e) => setGiftDuration(e.target.value as typeof giftDuration)} className="text-xs bg-bg-3 border border-line rounded px-1.5 py-1 text-ink-1" aria-label="Perk tier duration">
                <option value="1m">1 month</option>
                <option value="3m">3 months</option>
                <option value="6m">6 months</option>
                <option value="forever">Forever</option>
              </select>
              <button onClick={() => void gift()} disabled={busy === 'gift'} className="text-xs px-2.5 py-1 rounded border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-40 inline-flex items-center gap-1">
                <Plus size={13} /> Give
              </button>
              {user.subscriptionTier && (
                <button onClick={() => void removeMembership()} disabled={busy === 'gift'} className="text-xs px-2.5 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40 inline-flex items-center gap-1">
                  <RefreshCw size={13} /> Remove tier
                </button>
              )}
            </div>
          )}
        </Section>
      )}

      {!canModerate && (
        <p className="text-sm text-ink-3">Moderators can’t act on staff accounts.</p>
      )}

      {/* Notes — admins and moderators */}
      {canModerate && (
        <Section title="Staff notes">
          <p className="text-[0.7rem] text-ink-3">Only staff can see these. The account never does.</p>
          <div className="flex gap-2">
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="Add a note…"
              className={`${input} flex-1 resize-y`}
            />
            <button onClick={() => void addNote()} disabled={busy === 'note' || !noteDraft.trim()} className={`${btn} self-start`}>
              <MessageSquare size={13} /> Add
            </button>
          </div>
          {notes === null ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : notes.length === 0 ? (
            <p className="text-sm text-ink-3">No notes yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {notes.map((n) => (
                <li key={n.id} className="rounded bg-bg-1 border border-line px-2.5 py-2">
                  <div className="flex items-center gap-2 text-[0.7rem] text-ink-3">
                    <span>{n.author ? `@${n.author.username}` : 'former staff'}</span>
                    <span>·</span>
                    <span>{fmtDate(n.createdAt, true)}</span>
                    {(selfIsAdmin || n.author?.id === self?.id) && (
                      <button onClick={() => void deleteNote(n)} disabled={busy === 'note'} className="ml-auto text-ink-3 hover:text-red-400" title="Delete note">
                        <Trash size={12} />
                      </button>
                    )}
                  </div>
                  <p className="text-sm text-ink-1 whitespace-pre-wrap break-words mt-0.5">{n.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* Contacts — admins only, loaded on request (viewing is audited) */}
      {selfIsAdmin && (
        <Section title="Contacts">
          {contacts === null ? (
            <button onClick={loadContacts} className={btn} title="Viewing contacts is recorded in the staff log">
              <Users size={13} /> Show contacts
            </button>
          ) : contacts === 'loading' ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : (
            <div className="space-y-3">
              <ContactList title="Friends" icon={<Users size={12} />} people={contacts.friends} />
              <ContactList title="Friend requests received" icon={<Inbox size={12} />} people={contacts.incomingRequests} />
              <ContactList title="Friend requests sent" icon={<AtSign size={12} />} people={contacts.outgoingRequests} />
              <ContactList title="Blocked" icon={<Ban size={12} />} people={contacts.blocked} />
              <ContactList title="Direct messages with" icon={<MessageSquare size={12} />} people={contacts.dmPartners} />
              <p className="text-[0.65rem] text-ink-3">Names only — message content is never shown.</p>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function ContactList({
  title,
  icon,
  people,
}: {
  title: string;
  icon: React.ReactNode;
  people: AdminContactPerson[];
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-ink-2 font-medium mb-1">
        {icon} {title} <span className="text-ink-3">({people.length})</span>
      </div>
      {people.length === 0 ? (
        <p className="text-xs text-ink-3 pl-4">None</p>
      ) : (
        <ul className="grid sm:grid-cols-2 gap-1">
          {people.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded bg-bg-1 border border-line px-2 py-1.5 min-w-0">
              <div className={`relative w-6 h-6 rounded-full flex items-center justify-center text-[0.55rem] font-bold shrink-0 overflow-hidden ${avatarColor(p.id)}`}>
                <span className="zk-avatar-initials">{avatarInitials(p.displayName || p.username)}</span>
                <AvatarImage src={p.avatarUrl} />
              </div>
              <div className="min-w-0">
                <div className="text-xs text-ink-1 truncate">{p.displayName || p.username}</div>
                <div className="text-[0.65rem] text-ink-3 truncate">@{p.username} · since {new Date(p.since).toLocaleDateString()}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
