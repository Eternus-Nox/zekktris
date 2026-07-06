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

import { useState, useRef, useEffect, useCallback, type FormEvent, type KeyboardEventHandler, type Ref, type RefObject } from 'react';
import { ZekktrisMark } from '../lib/ZekktrisMark';
import { Eye, EyeOff, Key, QrCode } from '../lib/icons';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '@zekktris/client';
import { useAuth } from './AuthContext';

/**
 * Split-panel auth shell: a left brand pillar (Zekktris mark + wordmark,
 * desktop only) beside the form column, both inside one rounded glass card
 * centered over the ambient abyss. On mobile the pillar collapses to a
 * compact logo row above the form. The form column owns its own heading
 * ("Welcome back" / "Create an account").
 */
function AuthShell({
  heading,
  children,
}: {
  heading?: string;
  children: React.ReactNode;
}) {
  return (
    // The document itself can't scroll (html/body is locked to the viewport),
    // so the auth surface is its OWN scroll container — otherwise a tall form
    // (register) gets clipped on short viewports with no way to reach the
    // submit button. `.abyss` is position:fixed, so it stays put while the
    // card scrolls. The inner min-h-full wrapper centers the card when it fits
    // and lets it scroll (from the top, no clipping) when it doesn't.
    <div className="h-screen overflow-y-auto bg-bg-1 relative">
      {/* Same ambient abyss the Shell mounts — auth is the user's first
          impression of Zekktris, so it gets the full plasma + starfield. */}
      <div className="abyss" aria-hidden />
      <div className="relative z-10 min-h-full flex items-center justify-center px-4 py-8 safe-area-padded">
        <div className="w-full max-w-3xl grid md:grid-cols-2 glass glass-edge rounded-2xl overflow-hidden shadow-2xl">
        {/* Brand pillar — desktop only. */}
        <div
          className="hidden md:flex flex-col items-center justify-center gap-4 p-10 border-r"
          style={{ borderColor: 'var(--zk-line-soft)' }}
        >
          <ZekktrisMark size={120} className="w-28 h-28 shrink-0" />
          <span className="text-4xl font-bold tracking-tight">Zekktris</span>
        </div>
        {/* Form column. */}
        <div className="p-8 sm:p-10">
          {/* Compact brand row for mobile (pillar is hidden there). */}
          <div className="md:hidden flex items-center justify-center gap-2 mb-6">
            <ZekktrisMark size={40} className="w-10 h-10 shrink-0" />
            <span className="text-2xl font-bold tracking-tight">Zekktris</span>
          </div>
          {heading && <h1 className="text-2xl font-bold text-center mb-6">{heading}</h1>}
          {children}
        </div>
        </div>
      </div>
    </div>
  );
}

/** Password input with a show/hide eye toggle (matches the auth mockups). */
function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  maxLength,
  inputRef,
  onKeyDown,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  minLength?: number;
  maxLength?: number;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="text-sm text-ink-2">{label}</span>
      <div className="relative mt-1">
        <input
          ref={inputRef}
          className="w-full bg-bg-1/60 backdrop-blur-sm border rounded-md pl-3 pr-10 py-2 outline-none transition-all focus:shadow-[0_0_0_1px_var(--accent-glow),0_0_14px_var(--accent-glow)]"
          style={{ borderColor: 'var(--zk-line)' }}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete={autoComplete}
          required
          minLength={minLength}
          maxLength={maxLength}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink-1 p-1"
          aria-label={show ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </label>
  );
}

/** "I agree to the Terms of Service and Privacy Policy" consent checkbox. */
function TosCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded accent-[var(--accent)] shrink-0"
      />
      <span>
        I agree to the{' '}
        {/* open in a new tab + stopPropagation so reading the docs doesn't
            navigate away from (and lose) the half-filled register form, nor
            toggle this checkbox. */}
        <a
          href="/terms"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-accent hover:underline"
        >
          Terms of Service
        </a>{' '}
        and{' '}
        <a
          href="/privacy"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-accent hover:underline"
        >
          Privacy Policy
        </a>
      </span>
    </label>
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

const DOB_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Month / Day / Year selects collected at signup. Reusable across the
 *  register + invite forms. Compose the parts with `composeDob`; the server
 *  age-gates under-13. */
export function DateOfBirthField({
  month,
  day,
  year,
  onMonth,
  onDay,
  onYear,
}: {
  month: string;
  day: string;
  year: string;
  onMonth: (v: string) => void;
  onDay: (v: string) => void;
  onYear: (v: string) => void;
}) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 120 }, (_, i) => thisYear - i);
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const selectCls =
    'mt-1 w-full bg-bg-1/60 backdrop-blur-sm border rounded-md px-2 py-2 outline-none transition-all focus:shadow-[0_0_0_1px_var(--accent-glow)] text-ink-1';
  return (
    <div>
      <span className="text-sm text-ink-2">Date of birth</span>
      <div className="mt-1 grid grid-cols-3 gap-2">
        <select aria-label="Birth month" className={selectCls} style={{ borderColor: 'var(--zk-line)' }} value={month} onChange={(e) => onMonth(e.target.value)} required>
          <option value="">Month</option>
          {DOB_MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1)}>{m}</option>
          ))}
        </select>
        <select aria-label="Birth day" className={selectCls} style={{ borderColor: 'var(--zk-line)' }} value={day} onChange={(e) => onDay(e.target.value)} required>
          <option value="">Day</option>
          {days.map((d) => (
            <option key={d} value={String(d)}>{d}</option>
          ))}
        </select>
        <select aria-label="Birth year" className={selectCls} style={{ borderColor: 'var(--zk-line)' }} value={year} onChange={(e) => onYear(e.target.value)} required>
          <option value="">Year</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>{y}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Compose Month/Day/Year selections into a YYYY-MM-DD string, or '' if any
 *  part is unset (so callers can require a complete date before submit). */
export function composeDob(month: string, day: string, year: string): string {
  if (!month || !day || !year) return '';
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
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
  const { login, loginWithPasskey, token, hydrating } = useAuth();
  const [passkeyPending, setPasskeyPending] = useState(false);
  const passkeySupported =
    typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
  const nav = useNavigate();
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

  async function onPasskey() {
    setPasskeyPending(true);
    setErr(null);
    try {
      await loginWithPasskey();
      nav(nextPath, { replace: true });
    } catch (e) {
      // The user dismissing the OS/browser passkey prompt throws — that's not
      // an error worth surfacing. Show a message only for real failures.
      const name = e instanceof Error ? e.name : '';
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setErr(e instanceof ApiError ? e.message : 'Passkey sign-in failed.');
      }
    } finally {
      setPasskeyPending(false);
    }
  }

  return (
    <AuthShell heading={needs2FA ? 'Two-factor authentication' : 'Welcome back'}>
      {justReset && !needs2FA && (
        <div className="mb-4 rounded-md border border-emerald-600/40 bg-emerald-600/15 px-3 py-2 text-sm text-emerald-300">
          Your password was reset. Sign in with your new password below.
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4">
        {!needs2FA ? (
          <>
            <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
            <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
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
            {/* OR divider + alternative sign-in methods, shown as side-by-side
                buttons: a passkey on THIS device (when supported) and a code
                shown on ANOTHER already-signed-in device. The device-code option
                is always available; when passkeys aren't, it takes the full row. */}
            <div className="flex items-center gap-3 pt-1" aria-hidden>
              <span className="h-px flex-1" style={{ background: 'var(--zk-line)' }} />
              <span className="text-xs text-ink-3">OR</span>
              <span className="h-px flex-1" style={{ background: 'var(--zk-line)' }} />
            </div>
            <div className="flex items-stretch gap-2">
              {passkeySupported && (
                <button
                  type="button"
                  onClick={onPasskey}
                  disabled={passkeyPending}
                  className="flex-1 flex items-center justify-center gap-2 bg-bg-1/60 border rounded-md py-2 text-sm font-medium hover:bg-bg-3 disabled:opacity-60 transition-colors"
                  style={{ borderColor: 'var(--zk-line)' }}
                >
                  <Key size={16} />
                  {passkeyPending ? 'Waiting…' : 'Passkey'}
                </button>
              )}
              <Link
                to="/login/device"
                className="flex-1 flex items-center justify-center gap-2 bg-bg-1/60 border rounded-md py-2 text-sm font-medium hover:bg-bg-3 transition-colors"
                style={{ borderColor: 'var(--zk-line)' }}
              >
                <QrCode size={16} />
                Another device
              </Link>
            </div>
            <p className="text-sm text-ink-2 text-center pt-2">
              New here?{' '}
              <Link to="/register" className="text-accent hover:underline">
                Create an account
              </Link>
            </p>
          </>
        )}
      </form>
    </AuthShell>
  );
}

/** Pull the 16-digit code out of a raw scan/paste: a `/login/device?c=…` URL,
    or bare digits (spaces stripped). */
function extractQuickLoginCode(raw: string): string {
  const m = raw.match(/[?&]c=(\d{6,})/);
  if (m) return m[1]!;
  return raw.replace(/\D/g, '');
}

/**
 * Redeem a quick-login code shown on another (already-signed-in) device.
 * Reached via the "Log in with another device" link OR by scanning the QR
 * (which points a phone camera at /login/device?c=… and auto-submits).
 */
export function DeviceLoginPage() {
  const { loginWithDeviceCode, token, hydrating } = useAuth();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(() => extractQuickLoginCode(searchParams.get('c') ?? ''));
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const barcodeSupported =
    typeof window !== 'undefined' &&
    'BarcodeDetector' in window &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  const submit = useCallback(
    async (raw: string) => {
      const c = extractQuickLoginCode(raw);
      if (c.length < 6) {
        setErr('Enter the code shown on your other device.');
        return;
      }
      setPending(true);
      setErr(null);
      try {
        await loginWithDeviceCode(c);
        nav('/', { replace: true });
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : 'Could not sign in with that code.');
      } finally {
        setPending(false);
      }
    },
    [loginWithDeviceCode, nav],
  );

  // Arriving from a scanned QR URL (?c=…) → sign in immediately.
  const autoCode = searchParams.get('c');
  useEffect(() => {
    if (autoCode) void submit(autoCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Camera QR scan (Chromium/desktop; feature-gated so Safari/iOS falls back to
  // manual entry). Runs only while `scanning`; tears the camera down on exit.
  useEffect(() => {
    if (!scanning) return;
    let raf = 0;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) {
              setScanning(false);
              void submit(codes[0].rawValue as string);
              return;
            }
          } catch {
            /* per-frame detect can throw before the first frame — ignore */
          }
          raf = requestAnimationFrame(() => void tick());
        };
        raf = requestAnimationFrame(() => void tick());
      } catch {
        setErr('Could not open the camera. Type the code instead.');
        setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [scanning, submit]);

  if (hydrating) return null;
  if (token) return <Navigate to="/" replace />;

  return (
    <AuthShell heading="Log in with another device">
      <div className="space-y-4">
        <p className="text-sm text-ink-2 leading-snug">
          On a device you&apos;re already signed in on, open{' '}
          <span className="text-ink-1">Settings → Log in on another device</span> and enter the
          16-digit code here — or scan the QR.
        </p>
        {scanning ? (
          <div className="space-y-2">
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full rounded-md bg-black aspect-square object-cover"
            />
            <button
              type="button"
              onClick={() => setScanning(false)}
              className="block w-full text-center text-xs text-ink-3 hover:text-ink-2 underline"
            >
              Cancel scan
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(code);
            }}
            className="space-y-4"
          >
            <Field
              label="16-digit code"
              type="text"
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
            />
            {err && <ErrorBanner message={err} />}
            <SubmitButton pending={pending}>Sign in</SubmitButton>
            {barcodeSupported && (
              <button
                type="button"
                onClick={() => {
                  setErr(null);
                  setScanning(true);
                }}
                className="w-full flex items-center justify-center gap-2 bg-bg-1/60 border rounded-md py-2 text-sm font-medium hover:bg-bg-3 transition-colors"
                style={{ borderColor: 'var(--zk-line)' }}
              >
                Scan QR code
              </button>
            )}
          </form>
        )}
        <p className="text-sm text-center">
          <Link to="/login" className="text-ink-3 hover:text-accent hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </AuthShell>
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
  const [dobMonth, setDobMonth] = useState('');
  const [dobDay, setDobDay] = useState('');
  const [dobYear, setDobYear] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  // Invite/signup code. Pre-filled from an invite link's ?code= so a
  // friend handed a link doesn't have to type it. Required only on
  // invite-only instances (the server enforces) — otherwise ignored.
  const [code, setCode] = useState(() => searchParams.get('code') ?? '');
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
    const dateOfBirth = composeDob(dobMonth, dobDay, dobYear);
    if (!dateOfBirth) {
      setErr('Enter your date of birth.');
      return;
    }
    if (!agreed) {
      setErr('Please agree to the Terms of Service and Privacy Policy.');
      return;
    }
    setPending(true);
    setErr(null);
    try {
      await register({
        email,
        username,
        displayName: displayName || username,
        password,
        dateOfBirth,
        code: code.trim() || undefined,
      });
      nav(nextPath, { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Registration failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell heading="Create an account">
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
          <PasswordField
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            inputRef={passwordRef}
            onKeyDown={enterTo(repeatRef)}
          />
          <PasswordStrength password={password} />
        </div>
        <div>
          <PasswordField
            label="Confirm Password"
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
        <DateOfBirthField
          month={dobMonth}
          day={dobDay}
          year={dobYear}
          onMonth={setDobMonth}
          onDay={setDobDay}
          onYear={setDobYear}
        />
        <Field
          label="Invite code"
          value={code}
          onChange={setCode}
          required={false}
          maxLength={64}
          hint="Only needed if this server is invite-only. Paste the code you were given (invite links fill this in for you)."
        />
        <TosCheckbox checked={agreed} onChange={setAgreed} />
        {err && <ErrorBanner message={err} />}
        <SubmitButton pending={pending}>Create account</SubmitButton>
        <p className="text-sm text-ink-2 text-center pt-2">
          Already have an account?{' '}
          <Link to="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
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
      <AuthShell heading="Check your email">
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
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Reset your password">
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
    </AuthShell>
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
      <AuthShell heading="Reset link is invalid">
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
      </AuthShell>
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
    <AuthShell heading="Choose a new password">
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
    </AuthShell>
  );
}
