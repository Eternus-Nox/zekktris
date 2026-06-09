/**
 * Auth screens
 * ------------
 * Login + Register share the same centered-card layout. The form components
 * are minimal on purpose (v1) — no fancy validation, no password strength
 * meter; the server is the source of truth and surfaces errors on submit.
 *
 * Both forms call the same auth context method; success navigates to "/".
 * Failure displays the server's error message in red.
 */

import { useState, useEffect, useRef, type FormEvent, type KeyboardEventHandler, type Ref, type RefObject } from 'react';
import { ZekktrisMark } from '../lib/ZekktrisMark';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@zekktris/client';
import { useAuth } from './AuthContext';

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-1 px-4 safe-area-padded relative overflow-hidden">
      {/* Same ambient abyss the Shell mounts. Auth screens are the
          user's first impression of Zekktris — having the plasma
          aurora + starfield behind the form matters more here than
          anywhere else. pointer-events: none keeps it purely
          decorative. */}
      <div className="abyss" aria-hidden />
      <div className="w-full max-w-md glass glass-edge rounded-xl p-8 shadow-2xl relative z-10">
        <div className="mb-6 flex items-start gap-3">
          {/* Zekktris mark. icon.svg is the same artwork used as the
              favicon + PWA tile, so the visual identity is consistent
              from "before sign-in" through "running as installed
              app". 40px reads cleanly next to the wordmark; larger
              than the favicon stamp but compact enough to leave the
              title room. */}
          <ZekktrisMark size={40} className="w-10 h-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">Zekktris</h1>
            {subtitle ?? <p className="text-ink-2 mt-1">{title}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  type = 'text',
  value,
  onChange,
  autoComplete,
  required = true,
  hint,
  minLength,
  maxLength,
  inputRef,
  onKeyDown,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  /** Helper text rendered below the input. Use to communicate
      requirements (length, allowed characters) BEFORE the user
      submits and gets a backend rejection. */
  hint?: string;
  minLength?: number;
  maxLength?: number;
  /** Forwarded ref to the underlying <input>, for focus management
      (e.g. Enter-to-advance between fields). */
  inputRef?: Ref<HTMLInputElement>;
  /** Key handler on the input. */
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  return (
    <label className="block">
      <span className="text-sm text-ink-2">{label}</span>
      <input
        ref={inputRef}
        className="mt-1 w-full bg-bg-1/60 backdrop-blur-sm border rounded-md px-3 py-2 outline-none transition-all focus:shadow-[0_0_0_1px_var(--accent-glow),0_0_14px_var(--accent-glow)]"
        style={{ borderColor: 'var(--zk-line)' }}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
      />
      {hint && (
        <span className="text-xs text-ink-3 mt-1 block">{hint}</span>
      )}
    </label>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="bg-red-950/40 border border-red-900/60 text-red-200 rounded-md px-3 py-2 text-sm">
      {message}
    </div>
  );
}

function SubmitButton({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full bg-gradient-to-br from-accent to-accent-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed text-bg-0 font-semibold rounded-md py-2 transition-all shadow-[0_0_0_1px_var(--accent-glow),0_4px_18px_var(--accent-glow)]"
    >
      {pending ? '…' : children}
    </button>
  );
}

// ── Login ──────────────────────────────────────────────────────────────────

// localStorage key for the last successfully-used email. We persist it
// after a successful login so the next visit pre-fills the field. The
// value is just the email string (no other identifying data); same
// privacy posture as a "remember me" checkbox that defaults on.
const LAST_EMAIL_KEY = 'zekktris.auth.last_email';

function getStoredLastEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

function setStoredLastEmail(email: string): void {
  try {
    if (email) localStorage.setItem(LAST_EMAIL_KEY, email);
  } catch {
    // localStorage may be disabled (private mode, embedded contexts);
    // failing soft is correct — autofill is a convenience, not a
    // requirement.
  }
}

export function LoginPage() {
  const { login, token, hydrating, rest } = useAuth();
  const nav = useNavigate();
  // SSO availability — fetched once; the button only renders when configured.
  const [sso, setSso] = useState<{ enabled: boolean; buttonLabel: string } | null>(null);
  useEffect(() => {
    let alive = true;
    rest
      .getSsoConfig()
      .then((r) => alive && setSso(r))
      .catch(() => alive && setSso({ enabled: false, buttonLabel: '' }));
    return () => {
      alive = false;
    };
  }, [rest]);
  // Initialize from storage so a returning user sees their address
  // already filled in — they only need to type the password. lazy
  // initial state so the localStorage read happens once at mount.
  const [email, setEmail] = useState<string>(() => getStoredLastEmail());
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  // Once the server returns `requires2FA: true`, we switch into a
  // second step: the email/password fields lock and a code input
  // appears. We hold onto password locally for the resubmission;
  // this keeps the password out of any global state, just in the
  // component's memory for as long as the user is mid-login.
  const [needs2FA, setNeeds2FA] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  // `?next=` lets callers like the invite landing page bounce the
  // user through login and back. We only honor same-origin paths
  // (must start with "/") so a malicious link can't open-redirect
  // a freshly-logged-in user to an external URL.
  const rawNext = searchParams.get('next');
  const nextPath = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  // Surface a one-shot success message after a completed password
  // reset. The reset flow lands users here with ?reset=ok; we show
  // a small green banner so they know the action took effect.
  const justReset = searchParams.get('reset') === 'ok';
  // An SSO attempt that failed bounces back here with ?sso_error=<message>.
  const ssoError = searchParams.get('sso_error');

  if (hydrating) return null;
  if (token) return <Navigate to={nextPath} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setErr(null);
    try {
      await login(email, password, needs2FA ? code : undefined);
      setStoredLastEmail(email);
      nav(nextPath, { replace: true });
    } catch (e) {
      // Distinguish "needs 2FA" from a real error. Our rest layer
      // throws ApiError with the response body; the server flags
      // 401 with requires2FA in the body for the missing-code case.
      if (e instanceof ApiError && (e.details as { requires2FA?: boolean } | undefined)?.requires2FA) {
        setNeeds2FA(true);
        // No error banner — just transition to the code step.
      } else {
        setErr(e instanceof ApiError ? e.message : 'Login failed');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard title={needs2FA ? 'Two-factor authentication' : 'Welcome back'}>
      {justReset && !needs2FA && (
        <div className="mb-4 rounded-md border border-emerald-600/40 bg-emerald-600/15 px-3 py-2 text-sm text-emerald-300">
          Your password was reset. Sign in with your new password below.
        </div>
      )}
      {ssoError && !needs2FA && (
        <div className="mb-4 rounded-md border border-red-600/40 bg-red-600/15 px-3 py-2 text-sm text-red-300">
          {ssoError}
        </div>
      )}
      {sso?.enabled && !needs2FA && (
        <div className="mb-4 space-y-3">
          <a
            href="/api/v1/auth/sso/login"
            className="block w-full text-center rounded-md border border-line bg-bg-2 px-3 py-2 text-sm font-medium text-ink-1 hover:border-accent transition-colors"
          >
            {sso.buttonLabel || 'Sign in with SSO'}
          </a>
          <div className="flex items-center gap-3 text-xs text-ink-3">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        {!needs2FA ? (
          <>
            <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
            <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
          </>
        ) : (
          <>
            <p className="text-sm text-ink-2 leading-snug">
              Enter the 6-digit code from your authenticator app, or one of your recovery codes.
            </p>
            <Field
              label="Code"
              type="text"
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
            />
          </>
        )}
        {err && <ErrorBanner message={err} />}
        <SubmitButton pending={pending}>
          {needs2FA ? 'Verify' : 'Sign in'}
        </SubmitButton>
        {needs2FA && (
          <button
            type="button"
            onClick={() => {
              setNeeds2FA(false);
              setCode('');
              setPassword('');
              setErr(null);
            }}
            className="block w-full text-center text-xs text-ink-3 hover:text-ink-2 underline"
          >
            Back to sign in
          </button>
        )}
        {!needs2FA && (
          <>
            <p className="text-sm text-center pt-1">
              <Link
                to="/forgot-password"
                className="text-ink-3 hover:text-accent hover:underline"
              >
                Forgot your password?
              </Link>
            </p>
            <p className="text-sm text-ink-2 text-center pt-2">
              New here?{' '}
              <Link to="/register" className="text-accent hover:underline">
                Create an account
              </Link>
            </p>
          </>
        )}
      </form>
    </AuthCard>
  );
}

// ── SSO completion ───────────────────────────────────────────────────────────

/**
 * Landing page the SSO callback redirects to after it set the refresh cookie.
 * We exchange the cookie for an access token + load the user, then bounce to
 * the app. On failure we send the user back to /login with a message.
 */
export function SsoCompletePage() {
  const { completeSso, token, hydrating } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await completeSso();
        if (alive) nav('/', { replace: true });
      } catch {
        if (alive) {
          nav('/login?sso_error=' + encodeURIComponent('Could not complete SSO sign-in.'), {
            replace: true,
          });
          setErr('Could not complete SSO sign-in.');
        }
      }
    })();
    return () => {
      alive = false;
    };
    // completeSso is stable; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (token && !hydrating) return <Navigate to="/" replace />;
  return (
    <AuthCard title="Signing you in…">
      <p className="text-sm text-ink-2 text-center">
        {err ?? 'Completing single sign-on, one moment…'}
      </p>
    </AuthCard>
  );
}

// ── Register ───────────────────────────────────────────────────────────────

/** Rough password-strength heuristic for the signup form — enough to nudge
    users toward a stronger secret without pretending to be a real estimator.
    The server enforces the 8-char minimum regardless. */
function passwordStrength(
  pw: string,
): { score: 0 | 1 | 2 | 3 | 4; label: string; tone: string } {
  if (pw.length === 0) return { score: 0, label: '', tone: '' };
  if (pw.length < 8) return { score: 1, label: 'Too short', tone: 'bg-red-500' };
  let bits = 1;
  if (pw.length >= 12) bits++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) bits++;
  if (/\d/.test(pw)) bits++;
  if (/[^A-Za-z0-9]/.test(pw)) bits++;
  const score = Math.min(4, bits) as 1 | 2 | 3 | 4;
  const labels: Record<number, string> = { 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong' };
  const tones: Record<number, string> = {
    1: 'bg-red-500',
    2: 'bg-amber-500',
    3: 'bg-lime-500',
    4: 'bg-emerald-500',
  };
  return { score, label: labels[score], tone: tones[score] };
}

/** Four-segment strength bar + label, shown under the password field once the
    user starts typing. Purely advisory. */
function PasswordStrength({ password }: { password: string }) {
  if (password.length === 0) return null;
  const { score, label, tone } = passwordStrength(password);
  return (
    <div className="mt-2">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= score ? tone : 'bg-white/10'
            }`}
          />
        ))}
      </div>
      <span className="text-xs text-ink-3 mt-1 block">
        Password strength: <span className="text-ink-2">{label}</span>
      </span>
    </div>
  );
}

export function RegisterPage() {
  const { register, token, hydrating } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  // Same ?next= treatment as LoginPage — same-origin paths only.
  const rawNext = searchParams.get('next');
  const nextPath = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  // Refs so pressing Enter walks down the form (email → username → display
  // name → password → repeat → submit) instead of submitting from the very
  // first field, which is the default <form> behaviour.
  const usernameRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);
  const enterTo =
    (ref: RefObject<HTMLInputElement>): KeyboardEventHandler<HTMLInputElement> =>
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        ref.current?.focus();
      }
    };

  if (hydrating) return null;
  if (token) return <Navigate to={nextPath} replace />;

  const mismatch = repeatPassword.length > 0 && repeatPassword !== password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== repeatPassword) {
      setErr("Passwords don't match.");
      repeatRef.current?.focus();
      return;
    }
    setPending(true);
    setErr(null);
    try {
      await register({ email, username, displayName: displayName || username, password });
      nav(nextPath, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Registration failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard title="Create your account">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          hint="We'll use this for sign-in and password resets."
          onKeyDown={enterTo(usernameRef)}
        />
        <Field
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          minLength={2}
          maxLength={32}
          hint="2–32 characters. Letters, numbers, and underscores."
          inputRef={usernameRef}
          onKeyDown={enterTo(displayNameRef)}
        />
        <Field
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
          required={false}
          maxLength={32}
          hint="Optional. Shown next to your messages; defaults to your username."
          inputRef={displayNameRef}
          onKeyDown={enterTo(passwordRef)}
        />
        <div>
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            hint="At least 8 characters."
            inputRef={passwordRef}
            onKeyDown={enterTo(repeatRef)}
          />
          <PasswordStrength password={password} />
        </div>
        <div>
          <Field
            label="Repeat password"
            type="password"
            value={repeatPassword}
            onChange={setRepeatPassword}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            inputRef={repeatRef}
          />
          {mismatch && (
            <span className="text-xs text-red-400 mt-1 block">
              Passwords don&apos;t match.
            </span>
          )}
        </div>
        {err && <ErrorBanner message={err} />}
        <SubmitButton pending={pending}>Create account</SubmitButton>
        <p className="text-sm text-ink-2 text-center pt-2">
          Already have an account?{' '}
          <Link to="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

// ── Forgot password ────────────────────────────────────────────────────────

/**
 * Step 1 of the password-reset flow. User enters their email, server
 * always replies ok (we don't leak existence), UI shows a generic
 * confirmation message regardless of outcome. If the email matched
 * an account, the user will get a reset link in their inbox; if not,
 * they get the same screen but no email — designed to be
 * indistinguishable from the user-doesn't-exist case.
 *
 * Server-side rate limit (3/hr per IP and per email) caps spam-the-
 * inbox attacks. Client doesn't need to enforce anything additional.
 */
export function ForgotPasswordPage() {
  const { rest, token, hydrating } = useAuth();
  const [email, setEmail] = useState<string>(() => getStoredLastEmail());
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (hydrating) return null;
  if (token) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setErr(null);
    try {
      await rest.forgotPassword({ email });
      setSubmitted(true);
    } catch (e) {
      // Most failures here are 503 (SMTP not configured) since the
      // server returns ok even for non-existent emails. Surface
      // those plainly — the user can't fix their own login state
      // if the operator hasn't set up email.
      setErr(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <AuthCard title="Check your email">
        <div className="space-y-4">
          <p className="text-sm text-ink-2 leading-relaxed">
            If an account exists with that email, we&apos;ve sent a password
            reset link. The link expires in 60 minutes.
          </p>
          <p className="text-sm text-ink-3 leading-relaxed">
            Didn&apos;t get an email? Check your spam folder. Still nothing
            after a few minutes? Confirm you used the email address on
            your account, then try again.
          </p>
          <Link
            to="/login"
            className="block text-center text-sm text-accent hover:underline pt-2"
          >
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password">
      <p className="text-sm text-ink-2 mb-4 leading-relaxed">
        Enter the email address you signed up with. If we find an
        account, we&apos;ll send a link to choose a new password.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        {err && <ErrorBanner message={err} />}
        <SubmitButton pending={pending}>Send reset link</SubmitButton>
        <p className="text-sm text-ink-2 text-center pt-2">
          <Link to="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

// ── Reset password (post-email-click landing) ──────────────────────────────

/**
 * Step 2 of the password-reset flow. Reads the token from the URL
 * query string (set by the link in the reset email), accepts a new
 * password (entered twice for confirmation), POSTs to the server.
 *
 * On success: the server has rotated the password AND revoked all
 * sessions, so we redirect to login rather than auto-authenticating
 * (the user has to log in fresh with the new password, which is
 * what they expect anyway after a reset).
 */
export function ResetPasswordPage() {
  const nav = useNavigate();
  const { rest, token: authToken, hydrating } = useAuth();
  const [searchParams] = useSearchParams();
  const resetToken = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (hydrating) return null;
  // We allow authenticated users to access this page — they might
  // be initiating a reset while logged in on another device. The
  // server-side flow doesn't care about the auth state of the
  // requester; it cares about the validity of the token.

  // Guard against missing/malformed token in the URL. Show a
  // friendly message rather than letting the user fill out the
  // form and getting a generic 400 on submit.
  if (!resetToken) {
    return (
      <AuthCard title="Reset link is invalid">
        <div className="space-y-4">
          <p className="text-sm text-ink-2 leading-relaxed">
            This page expected a reset token in the URL but didn&apos;t
            find one. The link in your email may be incomplete &mdash;
            try copying the entire URL into your browser.
          </p>
          <Link
            to="/forgot-password"
            className="block text-center text-sm text-accent hover:underline pt-2"
          >
            Request a new reset link
          </Link>
        </div>
      </AuthCard>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setErr(null);
    if (password !== confirm) {
      setErr("The two passwords don't match.");
      setPending(false);
      return;
    }
    try {
      await rest.resetPassword({ token: resetToken, newPassword: password });
      // Redirect to login. If the user was already signed in on this
      // device, their session was revoked server-side as part of the
      // reset; the next REST call would 401. Easier to just send
      // them to login now.
      nav('/login?reset=ok', { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard title="Choose a new password">
      <p className="text-sm text-ink-2 mb-4 leading-relaxed">
        Set a new password for your account. After saving, you&apos;ll
        be signed out of every device and need to sign in with the
        new password.
        {authToken && (
          <> (You&apos;re currently signed in &mdash; that session will end too.)</>
        )}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={8}
          maxLength={200}
          hint="At least 8 characters."
        />
        <Field
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          minLength={8}
          maxLength={200}
        />
        {err && <ErrorBanner message={err} />}
        <SubmitButton pending={pending}>Save new password</SubmitButton>
        <p className="text-sm text-ink-2 text-center pt-2">
          <Link to="/login" className="text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
