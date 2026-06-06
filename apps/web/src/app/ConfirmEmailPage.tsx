/**
 * ConfirmEmailPage
 * ----------------
 * Landing page for the verification link in the email-change
 * email. Reads ?token=... from the URL, POSTs it to the public
 * /auth/confirm-email-change endpoint, and shows success or
 * error state.
 *
 * Works without an active session — the token itself is the
 * credential, so the user can complete the change from any
 * device (including one they aren't currently signed into).
 *
 * On success, if the user IS signed in here, we refresh their
 * auth context so the new email shows up immediately in settings.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { Shield } from '../lib/icons';

type Status =
  | { kind: 'pending' }
  | { kind: 'success'; newEmail: string }
  | { kind: 'error'; message: string };

export function ConfirmEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const { user, rest, updateUser } = useAuth();

  const [status, setStatus] = useState<Status>({ kind: 'pending' });

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'error', message: 'No verification token in URL.' });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await rest.confirmEmailChange(token);
        if (cancelled) return;
        setStatus({ kind: 'success', newEmail: r.newEmail });
        // If the user IS logged in on this device, patch the local
        // auth snapshot so the email shown in settings is current.
        // Other sessions get the update via the USER_UPDATE gateway
        // event the server dispatches on confirm.
        if (user) {
          updateUser({ email: r.newEmail });
        }
      } catch (e) {
        if (cancelled) return;
        setStatus({
          kind: 'error',
          message:
            e instanceof ApiError
              ? e.message
              : 'Verification link is invalid or expired.',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, rest, user, updateUser]);

  return (
    <div className="min-h-screen bg-bg-1 text-ink-1 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-bg-2 border border-line rounded-lg p-6 space-y-3">
        <header className="flex items-center gap-2">
          <Shield size={18} className="text-accent" />
          <h1 className="text-lg font-semibold">Email verification</h1>
        </header>

        {status.kind === 'pending' && (
          <p className="text-sm text-ink-2">Verifying your new email address…</p>
        )}

        {status.kind === 'success' && (
          <>
            <div className="px-3 py-2 rounded-md bg-emerald-950/30 border border-emerald-900/40 text-sm text-emerald-200">
              Your email has been updated to{' '}
              <strong className="font-mono">{status.newEmail}</strong>.
            </div>
            <p className="text-xs text-ink-3">
              You can now sign in with the new address. Future password resets and notifications will be sent there.
            </p>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => nav(user ? '/channels/@me' : '/login')}
                className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium"
              >
                {user ? 'Back to Zekktris' : 'Sign in'}
              </button>
            </div>
          </>
        )}

        {status.kind === 'error' && (
          <>
            <div className="px-3 py-2 rounded-md bg-red-950/30 border border-red-900/40 text-sm text-red-200">
              {status.message}
            </div>
            <p className="text-xs text-ink-3">
              You can request a new verification email from your account settings.
            </p>
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => nav(user ? '/settings' : '/login')}
                className="px-3 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm text-ink-2"
              >
                {user ? 'Settings' : 'Sign in'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
