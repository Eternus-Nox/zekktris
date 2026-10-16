/**
 * DmSettingsPanel
 * ---------------
 * Compact dropdown UI for the DM auto-delete TTL. Anchored to the
 * Settings cog in the DM header; closes on outside click or Escape.
 *
 * The TTL is a property of the conversation, not the user — changing
 * it here affects both recipients. Server enforces; this UI just
 * surfaces the four canonical options (off + 30 / 60 / 120 seconds)
 * which match the user's requested values. Other values are still
 * accepted by the API (10–86400 inclusive) but we keep the UI to a
 * curated set to avoid analysis paralysis.
 *
 * Behaviour:
 *   - Opens with a brief loading state while we fetch the current
 *     TTL. Subsequent open calls in the same session start with the
 *     last-known value (the gateway DM_SETTINGS_UPDATE event keeps
 *     a cached local value in sync across tabs).
 *   - Selecting a different option PATCHes the new value immediately,
 *     optimistically updates local state, and surfaces a toast on
 *     failure with a rollback to the previous selection.
 *   - The "What does this mean?" footer is a short, plain-language
 *     explanation that the lifetime starts when the OTHER party reads
 *     the message — important to avoid the assumption that the timer
 *     starts when the message is sent.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { Paperclip, Shield, XCircle } from '../lib/icons';

const OPTIONS: { value: number | null; label: string; sublabel?: string }[] = [
  { value: null, label: 'Off', sublabel: 'Messages stay forever' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
];

export function DmSettingsPanel({
  channel,
  selfId,
  onClose,
  onOpenMedia,
  toggleButtonRef,
}: {
  channel: Channel;
  selfId: string;
  onClose: () => void;
  /** Open the Shared-media gallery. The gallery is a full-screen,
      body-portaled modal, so it must be hosted by MessageView (a stable
      parent) rather than rendered inside this panel: a child portaled
      out of the panel's DOM subtree trips the panel's own outside-click
      handler (every click in the gallery looks "outside" the panel and
      closes it, unmounting the gallery). */
  onOpenMedia: () => void;
  /** Ref to the cog button that opens/closes this panel. The
      outside-click handler ignores clicks inside this element so
      that clicking the cog to close doesn't fire onClose + the
      button's own toggle handler back-to-back (which would
      reopen the panel immediately). */
  toggleButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const channelId = channel.id;
  const { rest } = useAuth();
  const toasts = useToasts();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [ttl, setTtl] = useState<number | null>(null);
  // This user's explicit notification-preview choice for this DM (null = not
  // set → fall back to the E2EE-aware default in the toggle).
  const [notifShowContent, setNotifShowContent] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);

  // Initial fetch. Best-effort — if it fails the user sees the
  // default ("Off") selected and any subsequent write still works.
  useEffect(() => {
    let cancelled = false;
    rest
      .getDmSettings(channelId)
      .then((r) => {
        if (cancelled) return;
        setTtl(r.ttlSecondsAfterRead);
        setNotifShowContent(r.notificationShowContent);
      })
      .catch(() => {
        // Don't toast — the panel is opening, surfacing an error
        // here would be noisy. The user can still pick an option.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, rest]);

  // Outside-click + Escape close. The toggle-button exception is
  // critical: clicking the cog to close fires mousedown FIRST (the
  // document listener catches it), then click (the button's onClick
  // toggles). Without the exception, the document listener would
  // call onClose() first (state → false), then the button's onClick
  // toggles (state → true) — and the panel reopens. Ignoring clicks
  // inside the toggle button lets the button's onClick own the
  // close action exclusively.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (toggleButtonRef?.current?.contains(target)) return;
      if (panelRef.current && !panelRef.current.contains(target)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, toggleButtonRef]);

  async function choose(next: number | null) {
    if (pending) return;
    const prev = ttl;
    // Optimistic update so the radio dot moves immediately. Rolls
    // back below on failure.
    setTtl(next);
    setPending(true);
    try {
      await rest.updateDmSettings(channelId, next);
      toasts.push(
        next === null
          ? 'Auto-delete turned off'
          : `Auto-delete set to ${labelFor(next)}`,
        'success',
      );
    } catch (e) {
      setTtl(prev);
      toasts.push(
        e instanceof ApiError ? e.message : 'Failed to update setting',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-10 z-30 w-72 bg-bg-2 border border-line rounded-lg shadow-xl overflow-hidden"
    >
      {/* Section order mirrors iOS DmSettingsSheet:
          Shared media → Notifications → Read receipts → Auto-delete → E2EE. */}
      <button
        type="button"
        onClick={onOpenMedia}
        className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left text-sm text-ink-2 hover:bg-bg-3"
      >
        <Paperclip size={15} className="text-accent shrink-0" />
        <span className="flex-1">Shared media</span>
        <span className="text-ink-3">›</span>
      </button>
      <NotificationPreviewToggle
        channel={channel}
        explicit={notifShowContent}
        onChange={setNotifShowContent}
      />
      <ReadReceiptsToggle />
      <header className="px-3 py-2 border-t border-b border-line">
        <h3 className="text-sm font-semibold text-ink-1">Auto-delete messages</h3>
        <p className="text-xs text-ink-3 mt-0.5 leading-snug">
          Messages will be removed after this delay <span className="text-ink-2 font-medium">once the other person reads them</span>.
        </p>
      </header>
      <ul className="py-1">
        {OPTIONS.map((opt) => {
          const selected = ttl === opt.value;
          return (
            <li key={String(opt.value)}>
              <button
                type="button"
                onClick={() => void choose(opt.value)}
                disabled={pending || !loaded}
                className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors disabled:opacity-60 ${
                  selected ? 'bg-accent/10' : 'hover:bg-bg-3'
                }`}
              >
                <span
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    selected ? 'border-accent' : 'border-ink-3'
                  }`}
                  aria-hidden
                >
                  {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm ${selected ? 'text-ink-1 font-medium' : 'text-ink-2'}`}>
                    {opt.label}
                  </span>
                  {opt.sublabel && (
                    <span className="block text-[0.7rem] text-ink-3 mt-0.5">{opt.sublabel}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <E2eeToggle channel={channel} selfId={selfId} />
      <CloseDmRow channel={channel} />
    </div>
  );
}

/**
 * Trailing destructive "Close DM" row — iOS parity: DmSettingsSheet ends
 * with a danger Close DM row (xmark.circle) plus a footnote explaining
 * the action is one-sided. Removes the conversation from this user's
 * list only; the other person keeps their copy. On success we navigate
 * back to the DM home since the current channel is about to disappear
 * from state (the gateway CHANNEL_DELETE broadcast removes it).
 */
function CloseDmRow({ channel }: { channel: Channel }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  return (
    <div className="border-t border-line px-3 py-2.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          void rest
            .closeDM(channel.id)
            .then(() => {
              navigate('/channels/@me');
            })
            .catch((e: unknown) => {
              toasts.push(
                e instanceof ApiError ? e.message : 'Could not close DM',
                'error',
              );
              setBusy(false);
            });
        }}
        className="w-full flex items-center gap-2.5 text-left text-sm text-red-400 hover:text-red-300 disabled:opacity-60 disabled:cursor-wait transition-colors"
      >
        <XCircle size={15} className="shrink-0" />
        <span className="flex-1">{busy ? 'Closing…' : 'Close DM'}</span>
      </button>
      <p className="text-[0.7rem] text-ink-3 mt-1.5 leading-snug">
        Removes this conversation from your list. The other person keeps their copy.
      </p>
    </div>
  );
}

/**
 * Per-DM, per-USER notification-preview toggle: whether push notifications for
 * this DM show the sender + message content, or a generic "New message".
 * Private to this user (their lock-screen exposure). The default depends on
 * E2EE — an encrypted DM defaults to generic (the server only holds
 * ciphertext; even revealing the sender leaks metadata), a plaintext DM
 * defaults to showing content. Flipping it stores an explicit override.
 * For an E2EE DM with "show content" on, the server reveals the sender's name
 * but the body stays generic (only an on-device decryptor could show the
 * plaintext).
 */
function NotificationPreviewToggle({
  channel,
  explicit,
  onChange,
}: {
  channel: Channel;
  explicit: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [pending, setPending] = useState(false);
  const isE2EE = channel.e2eeEnabled === true;
  const effective = explicit ?? !isE2EE;

  async function toggle() {
    if (pending) return;
    setPending(true);
    const next = !effective;
    onChange(next); // optimistic
    try {
      await rest.setDmNotificationPreview(channel.id, next);
    } catch (err) {
      onChange(explicit); // rollback
      toasts.push(
        err instanceof ApiError ? err.message : 'Could not update notification preview.',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-t border-line px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-ink-1">Show message in notifications</h3>
          <p className="text-xs text-ink-3 mt-0.5 leading-snug">
            {isE2EE ? (
              <>
                This chat is encrypted, so notifications only show that you have a new
                message. Turning this on reveals the <span className="text-ink-2">sender</span>;
                the message text stays hidden (only this device can decrypt it).
              </>
            ) : (
              <>
                Show the sender and a preview of the message on your lock screen. Off shows
                a generic <span className="text-ink-2">“New message”</span> instead.
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={effective}
          onClick={() => void toggle()}
          disabled={pending}
          className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-60 ${
            effective ? 'bg-accent' : 'bg-bg-3'
          }`}
          title={effective ? 'Hide message content in notifications' : 'Show message content in notifications'}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              effective ? 'left-[18px]' : 'left-0.5'
            }`}
            aria-hidden
          />
        </button>
      </div>
    </div>
  );
}

/**
 * Per-user read-receipts toggle. Distinct from the auto-delete TTL
 * above because its scope is the USER, not the conversation —
 * flipping this affects every DM you participate in, not just
 * this one. When off, the server suppresses delivered_at + viewed_at
 * stamping for messages this user receives, so senders see "Sent"
 * forever on DMs to you. The toggle is reciprocal: turning it off
 * also hides incoming senders' read status from your own view,
 * matching iMessage's privacy contract.
 *
 * Reads the current value from the SelfUser in AuthContext; writes
 * via patchMe and surfaces failures with a toast + rollback.
 */
function ReadReceiptsToggle() {
  const { rest, user, updateUser } = useAuth();
  const toasts = useToasts();
  const [pending, setPending] = useState(false);
  // SelfUser.dmReadReceiptsEnabled is optional in the type (back-compat
  // with sessions from before the column existed); treat undefined as
  // the server default `true`.
  const enabled = user?.dmReadReceiptsEnabled !== false;

  async function toggle() {
    if (!user || pending) return;
    setPending(true);
    const next = !enabled;
    // Optimistic. Rollback by writing the prior value back on error.
    updateUser({ dmReadReceiptsEnabled: next });
    try {
      const res = await rest.patchMe({ dmReadReceiptsEnabled: next });
      // Sync to the canonical server response in case anything else
      // changed concurrently (different tab, etc).
      updateUser(res.user);
    } catch (err) {
      updateUser({ dmReadReceiptsEnabled: enabled });
      const msg = err instanceof ApiError ? err.message : 'Could not update read receipts.';
      toasts.push(msg, 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-t border-line px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-ink-1">Send read receipts</h3>
          <p className="text-xs text-ink-3 mt-0.5 leading-snug">
            Let people you DM with see <span className="text-ink-2">Delivered</span> and{' '}
            <span className="text-ink-2">Read</span> under their messages. When off, you also
            won't see receipts on messages sent to you.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => void toggle()}
          disabled={pending || !user}
          className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-60 ${
            enabled ? 'bg-accent' : 'bg-bg-3'
          }`}
          title={enabled ? 'Turn off read receipts' : 'Turn on read receipts'}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              enabled ? 'left-[18px]' : 'left-0.5'
            }`}
            aria-hidden
          />
        </button>
      </div>
    </div>
  );
}

/**
 * Per-DM E2EE toggle + key backup affordances.
 *
 * Encryption status for a DM is stored server-side in
 * dm_recipients.public_key for each participant, surfaced back to
 * the client as `channel.e2eeKeys[userId]`. A user is enrolled on
 * this DM iff their entry exists in that map.
 *
 * Enable: generate the per-DM keypair (`getOrCreateDmKeyPair`),
 *   upload the public half via PUT, optimistically update local
 *   channel state with the new keys map.
 *
 * Disable: DELETE the server entry, clear the local private key,
 *   update local channel state. We keep the private key on
 *   disable? NO — for per-DM keys, we drop it. Re-enabling
 *   generates a fresh pair (because each DM has its own key, and
 *   keeping the old one would just leak the previous identity
 *   if the user toggles off->on). If the user wants to keep
 *   historic-message decryption, they should download the key
 *   first.
 *
 * Backup: a single download bundles ALL per-DM keys (so one file
 * restores access to every conversation on a new device).
 */
/**
 * E2EE toggle (shared-key model)
 * ------------------------------
 * Per-DM toggle in the settings cog. The conversation has ONE
 * shared symmetric key — both users have an identical key derived
 * client-side from a passphrase one of them picks. Server stores
 * only the salt + verifier (never the password or the key).
 *
 * State machine:
 *   Disabled            — toggle off. Tapping opens the
 *                         pick-password modal.
 *   Enabled + no key    — server says E2EE is on, but this device
 *                         has no cached key. Show an "Enter password"
 *                         prompt inside the panel; on submit derive
 *                         the key and verify against the server's
 *                         stored verifier.
 *   Enabled + have key  — normal state. Toggle on; show backup
 *                         affordances + disable button.
 *
 * Modals:
 *   PickPasswordModal   — opens when enabling; user picks + confirms
 *                         the conversation password.
 *   DisableConfirmModal — opens when disabling; explains the purge.
 *
 * Disabling DELETEs /e2ee-disable which clears the server state AND
 * purges every encrypted message in the conversation server-side.
 * Re-enabling generates a fresh salt; the old password is dead.
 */
function E2eeToggle({ channel, selfId }: { channel: Channel; selfId: string }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [pending, setPending] = useState(false);
  const [pickModalOpen, setPickModalOpen] = useState(false);
  const [disableModalOpen, setDisableModalOpen] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // Hide selfId — not used in the shared-key flow but keeps the
  // prop signature compatible with the panel's existing call site.
  void selfId;

  const enabled = channel.e2eeEnabled === true;

  // Whether THIS device has the derived key cached. Tracked via
  // state so the component re-renders after a successful unlock /
  // import / disable.
  const [haveLocalKey, setHaveLocalKey] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hasLocalKey } = await import('../lib/e2ee');
      if (!cancelled) setHaveLocalKey(hasLocalKey(channel.id));
    })();
    return () => {
      cancelled = true;
    };
  }, [channel.id, channel.e2eeEnabled, channel.e2eeSalt]);

  async function unlockWithPassword() {
    if (pending) return;
    if (!channel.e2eeSalt || !channel.e2eeVerifier) {
      setUnlockError('This conversation isn\'t encrypted right now.');
      return;
    }
    if (!unlockPassword) {
      setUnlockError('Enter a password.');
      return;
    }
    setPending(true);
    setUnlockError(null);
    try {
      const { deriveKeyFromPassword, computeVerifier, saveLocalKey } =
        await import('../lib/e2ee');
      const key = await deriveKeyFromPassword(unlockPassword, channel.e2eeSalt);
      const verifier = await computeVerifier(key);
      if (verifier !== channel.e2eeVerifier) {
        setUnlockError("That password doesn't match this conversation.");
        return;
      }
      saveLocalKey(channel.id, key);
      setHaveLocalKey(true);
      setUnlockPassword('');
      toasts.push('Encrypted conversation unlocked.', 'success');
    } catch {
      setUnlockError('Could not derive the key. Try again.');
    } finally {
      setPending(false);
    }
  }

  async function disableE2ee() {
    if (pending) return;
    setPending(true);
    try {
      // Prove we hold the key: derive the verifier AND the purge proof from
      // the local key and send both (the verifier is public, so the proof is
      // what the server actually trusts). The disable button is only shown
      // when unlocked (haveLocalKey), so the key should be present; bail
      // defensively if it isn't rather than firing a request the server will
      // reject.
      const { getLocalKey, computeVerifier, computePurgeProof, clearLocalKey } =
        await import('../lib/e2ee');
      const keyBytes = getLocalKey(channel.id);
      if (!keyBytes) {
        toasts.push('Unlock this conversation first to turn off encryption.', 'error');
        setDisableModalOpen(false);
        return;
      }
      const { encodeBase64 } = await import('tweetnacl-util');
      const keyBase64 = encodeBase64(keyBytes);
      const verifier = await computeVerifier(keyBase64);
      const purgeProof = await computePurgeProof(keyBase64);
      await rest.disableDmE2ee(channel.id, verifier, purgeProof);
      clearLocalKey(channel.id);
      setHaveLocalKey(false);
      setDisableModalOpen(false);
      toasts.push(
        'Encryption disabled. Encrypted messages were deleted.',
        'info',
      );
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Could not disable encryption',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  // Key download / import-from-backup was removed: the conversation PASSWORD
  // is the single unlock path (the per-DM key is re-derivable from it), so a
  // key file is redundant. See unlockWithPassword() above.

  return (
    <div className="border-t border-line px-3 py-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-ink-1 flex items-center gap-1.5">
            <Shield size={13} className="text-accent" />
            End-to-end encryption
          </h3>
          <p className="text-xs text-ink-3 mt-0.5 leading-snug">
            {enabled
              ? haveLocalKey
                ? 'Messages in this conversation are encrypted with a shared key only you and the other person hold.'
                : 'This conversation is encrypted. Enter the shared password to read and send messages.'
              : 'Off. Messages travel in plain text. Turn on to pick a shared password that encrypts this conversation.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => {
            if (pending) return;
            if (enabled) {
              // Turning E2EE off purges encrypted history, so it requires
              // the passphrase. If this device is locked (no local key),
              // send the user to the unlock prompt below instead of the
              // disable confirm — they must prove the password first.
              if (haveLocalKey) {
                setDisableModalOpen(true);
              } else {
                toasts.push(
                  'Unlock this conversation first to turn off encryption.',
                  'error',
                );
              }
            } else {
              setPickModalOpen(true);
            }
          }}
          disabled={pending}
          className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-60 ${
            enabled ? 'bg-accent' : 'bg-bg-3'
          }`}
          title={enabled ? 'Turn off encryption' : 'Turn on encryption'}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              enabled ? 'left-[18px]' : 'left-0.5'
            }`}
            aria-hidden
          />
        </button>
      </div>

      {/* Enabled + no local key on this device. Prompt to enter the
          password the OTHER party shared (or that you set earlier on
          another device). */}
      {enabled && !haveLocalKey && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2">
          <p className="text-xs text-amber-200 leading-snug">
            Enter the conversation password to unlock this DM on this device.
          </p>
          <input
            type="password"
            value={unlockPassword}
            onChange={(e) => {
              setUnlockPassword(e.target.value);
              setUnlockError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void unlockWithPassword();
            }}
            placeholder="Conversation password"
            className="w-full bg-bg-2 border border-line rounded-md px-2.5 py-1.5 text-sm text-ink-1 outline-none focus:border-accent transition-colors"
            autoComplete="off"
          />
          {unlockError && (
            <p className="text-xs text-red-300">{unlockError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void unlockWithPassword()}
              disabled={pending}
              className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-60 text-white text-xs"
            >
              Unlock
            </button>
          </div>
        </div>
      )}

      {/* Modals */}
      {pickModalOpen && (
        <PickPasswordModal
          channel={channel}
          onClose={() => setPickModalOpen(false)}
          onEnabled={() => {
            setPickModalOpen(false);
            setHaveLocalKey(true);
          }}
        />
      )}
      {disableModalOpen && (
        <DisableConfirmModal
          pending={pending}
          onClose={() => setDisableModalOpen(false)}
          onConfirm={() => void disableE2ee()}
        />
      )}
    </div>
  );
}

/**
 * Modal shown when enabling E2EE on a DM. User picks a passphrase
 * and confirms it. On submit: generate salt, derive key, compute
 * verifier + purge proof, PUT /e2ee-enable, cache local key.
 *
 * Includes a tip line that the user needs to share this password
 * with the other person via any out-of-band channel — text message,
 * in person, paper, etc. We deliberately don't offer to "send the
 * password through Zekktris" because that defeats the point.
 */
function PickPasswordModal({
  channel,
  onClose,
  onEnabled,
}: {
  channel: Channel;
  onClose: () => void;
  onEnabled: () => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    if (pending) return;
    if (password.length < 6) {
      setError('Use at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const {
        generateSalt,
        deriveKeyFromPassword,
        computeVerifier,
        computePurgeProof,
        saveLocalKey,
      } = await import('../lib/e2ee');
      const salt = generateSalt();
      const key = await deriveKeyFromPassword(password, salt);
      const verifier = await computeVerifier(key);
      const purgeProof = await computePurgeProof(key);
      await rest.enableDmE2ee(channel.id, salt, verifier, purgeProof);
      saveLocalKey(channel.id, key);
      toasts.push(
        'Encryption enabled. Share the password with the other person through any other channel.',
        'success',
      );
      onEnabled();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not enable encryption');
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-2 border border-line rounded-lg max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink-1 flex items-center gap-2">
          <Shield size={16} className="text-accent" />
          Set a conversation password
        </h2>
        <p className="text-sm text-ink-2 leading-relaxed">
          Pick a password for this conversation. You'll need to share it with
          the other person through some other channel — text message, in
          person, etc. — so they can unlock the conversation on their device.
        </p>
        <p className="text-xs text-ink-3 italic">
          The password never leaves your devices. The server only sees an
          irreversible verifier hash.
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          placeholder="Password"
          className="w-full bg-bg-1 border border-line rounded-md px-3 py-2 text-sm text-ink-1 outline-none focus:border-accent transition-colors"
          autoComplete="new-password"
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="Confirm password"
          className="w-full bg-bg-1 border border-line rounded-md px-3 py-2 text-sm text-ink-1 outline-none focus:border-accent transition-colors"
          autoComplete="new-password"
        />
        {error && <p className="text-xs text-red-300">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="px-3 py-1.5 rounded-md hover:bg-bg-3 text-sm text-ink-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={pending}
            className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-60 text-white text-sm font-medium"
          >
            Enable encryption
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Modal shown when disabling E2EE. Explains the purge — both
 * participants lose all encrypted message history in this
 * conversation.
 */
function DisableConfirmModal({
  pending,
  onClose,
  onConfirm,
}: {
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-2 border border-line rounded-lg max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink-1 flex items-center gap-2">
          <Shield size={16} className="text-red-400" />
          Disable encryption?
        </h2>
        <p className="text-sm text-ink-2 leading-relaxed">
          Disabling will <span className="font-semibold text-red-300">permanently delete every encrypted message</span> in this
          conversation for both of you. Plaintext messages from before
          encryption was enabled are preserved.
        </p>
        <p className="text-sm text-ink-2 leading-relaxed">
          You can re-enable encryption later, but it'll require a new password.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="px-3 py-1.5 rounded-md hover:bg-bg-3 text-sm text-ink-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-sm font-medium"
          >
            Disable + delete history
          </button>
        </div>
      </div>
    </div>
  );
}

function labelFor(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
