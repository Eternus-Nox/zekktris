/**
 * Email-verification gate + landing page.
 *
 * - VerifyEmailGate: a full-screen block shown by the Shell when the
 *   deployment requires email verification and the signed-in account
 *   hasn't verified yet. Offers resend, recheck, and sign-out.
 * - VerifyEmailPage: the /verify-email route the emailed link points at.
 *   Reads ?token, confirms it, then sends the user into the app.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '@zekktris/client';

export function VerifyEmailGate() {
  const { user, rest, logout, updateUser } = useAuth();
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // "Wrong email?" inline correction — the escape hatch for a typo at signup,
  // which would otherwise strand the account behind this gate forever.
  const [editing, setEditing] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  async function saveEmail() {
    const next = newEmail.trim();
    if (!next || savingEmail) return;
    setSavingEmail(true);
    setNote(null);
    try {
      const r = await rest.changeUnverifiedEmail(next);
      updateUser({ email: r.email });
      setEditing(false);
      setNewEmail('');
      setNote(`Email updated — verification sent to ${r.email}. Check your inbox (and spam).`);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not update your email. Try again shortly.');
    } finally {
      setSavingEmail(false);
    }
  }

  async function resend() {
    setSending(true);
    setNote(null);
    try {
      await rest.resendVerification();
      setNote('Verification email sent — check your inbox (and spam).');
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not send the email. Try again shortly.');
    } finally {
      setSending(false);
    }
  }

  async function recheck() {
    setChecking(true);
    setNote(null);
    try {
      const r = await rest.getMe();
      updateUser(r.user);
      if (!r.user.emailVerified) {
        setNote("Not verified yet — click the link in your email, then try again.");
      }
      // If verified, updateUser flips the gate off and the app appears.
    } catch {
      setNote('Could not refresh. Try again.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="fixed inset-0 grid place-items-center bg-bg-0 p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-bg-1 p-6 sm:p-8 shadow-2xl">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent to-accent-2 grid place-items-center text-bg-0 mb-4 text-2xl">
          ✉️
        </div>
        <h1 className="text-xl font-semibold text-ink-1">Verify your email</h1>
        <p className="text-sm text-ink-2 leading-relaxed mt-2">
          We sent a verification link to{' '}
          <span className="font-medium text-ink-1">{user?.email}</span>. Click it to
          start using Zekktris. This keeps accounts secure and tied to a real inbox.
        </p>

        {/* Typo escape hatch — correct the address and re-send, so a mistyped
            email doesn't lock the account out of the app permanently. */}
        {editing ? (
          <div className="mt-3 flex flex-col gap-2">
            <input
              type="email"
              autoFocus
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveEmail(); }}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-lg bg-bg-2 border border-line text-ink-1 text-sm focus:outline-none focus:border-accent"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void saveEmail()}
                disabled={savingEmail || !newEmail.trim()}
                className="flex-1 px-3 py-2 rounded-lg bg-accent text-bg-0 text-sm font-semibold hover:brightness-110 disabled:opacity-60 transition-all"
              >
                {savingEmail ? 'Saving…' : 'Update & resend'}
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setNewEmail(''); }}
                className="px-3 py-2 rounded-lg border border-line bg-bg-2 text-ink-2 hover:text-ink-1 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setEditing(true); setNewEmail(user?.email ?? ''); setNote(null); }}
            className="mt-2 text-xs text-accent hover:underline"
          >
            Wrong email address?
          </button>
        )}

        {note && (
          <p className="text-xs mt-3 px-3 py-2 rounded-lg bg-bg-2 border border-line text-ink-2">
            {note}
          </p>
        )}

        <div className="mt-5 space-y-2">
          <button
            type="button"
            onClick={() => void recheck()}
            disabled={checking}
            className="w-full px-4 py-2.5 rounded-lg bg-gradient-to-br from-accent to-accent-2 text-bg-0 font-semibold hover:brightness-110 disabled:opacity-60 transition-all"
          >
            {checking ? 'Checking…' : "I've verified — continue"}
          </button>
          <button
            type="button"
            onClick={() => void resend()}
            disabled={sending}
            className="w-full px-4 py-2.5 rounded-lg border border-line bg-bg-2 text-ink-1 hover:bg-bg-3 disabled:opacity-60 transition-colors text-sm"
          >
            {sending ? 'Sending…' : 'Resend verification email'}
          </button>
        </div>

        <button
          type="button"
          onClick={() => void logout()}
          className="mt-4 w-full text-xs text-ink-3 hover:text-ink-1 transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export function VerifyEmailPage() {
  const { rest, token: authToken, updateUser } = useAuth();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<
    { kind: 'pending' } | { kind: 'ok' } | { kind: 'error'; message: string }
  >({ kind: 'pending' });

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'error', message: 'No verification token in the link.' });
      return;
    }
    let cancelled = false;
    rest
      .verifyEmail(token)
      .then(async () => {
        if (cancelled) return;
        setStatus({ kind: 'ok' });
        // If signed in, refresh self so the gate clears immediately.
        if (authToken) {
          try {
            const r = await rest.getMe();
            updateUser(r.user);
          } catch {
            /* non-fatal */
          }
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus({
          kind: 'error',
          message: e instanceof ApiError ? e.message : 'Verification failed.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token, rest, authToken, updateUser]);

  return (
    <div className="fixed inset-0 grid place-items-center bg-bg-0 p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-bg-1 p-8 text-center shadow-2xl">
        {status.kind === 'pending' && (
          <p className="text-sm text-ink-2">Verifying your email…</p>
        )}
        {status.kind === 'ok' && (
          <>
            <div className="text-3xl mb-3">✅</div>
            <h1 className="text-xl font-semibold text-ink-1">Email verified</h1>
            <p className="text-sm text-ink-2 mt-2">Your account is ready to go.</p>
            <button
              type="button"
              onClick={() => nav(authToken ? '/' : '/login')}
              className="mt-5 w-full px-4 py-2.5 rounded-lg bg-gradient-to-br from-accent to-accent-2 text-bg-0 font-semibold hover:brightness-110 transition-all"
            >
              Continue
            </button>
          </>
        )}
        {status.kind === 'error' && (
          <>
            <div className="text-3xl mb-3">⚠️</div>
            <h1 className="text-xl font-semibold text-ink-1">Couldn't verify</h1>
            <p className="text-sm text-ink-2 mt-2">{status.message}</p>
            <Link
              to="/"
              className="mt-5 inline-block w-full px-4 py-2.5 rounded-lg border border-line bg-bg-2 text-ink-1 hover:bg-bg-3 transition-colors"
            >
              Back to app
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
