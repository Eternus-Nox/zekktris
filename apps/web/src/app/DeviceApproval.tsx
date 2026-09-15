/**
 * Device-approval — the LOGGED-IN half
 * ------------------------------------
 * A device that is already signed in reviews and answers a login request that
 * a logged-out device opened. The logged-out half lives in
 * auth/AuthScreens.tsx (DeviceLoginPage).
 *
 * THIS SCREEN IS THE SECURITY CONTROL FOR THE WHOLE FLOW.
 *
 * The server cannot defend against the one attack that matters here: an
 * attacker starts a device-login request on their own machine, then talks the
 * victim into approving it ("support needs you to read me the code" / "scan
 * this to claim your prize"). From the server's side that is a genuine session
 * making a genuine approval — indistinguishable from the real thing. The only
 * thing standing between the user and a stolen account is what this screen
 * shows them before they press the button. Hence:
 *
 *   - The metadata is rendered in TWO SEPARATE GROUPS, and the split is the
 *     point. `ipAddress` / `sameNetwork` / `requestedAt` are observed by the
 *     server and a remote attacker cannot forge them. `declaredName` /
 *     `userAgent` / `platform` / `locale` are claims made by the requesting
 *     device — an attacker will happily call their VPS "Your iPhone". They are
 *     labelled as claims, and they are never shown as the headline.
 *   - `sameNetwork: false` gets a loud warning. It is the single signal a
 *     remote phisher can never make true.
 *   - Deny is at least as prominent as Approve, and is listed first.
 *   - The consequence ("full access to your account") is stated on the screen,
 *     not buried in a tooltip.
 *
 * DO NOT simplify this into a "Someone wants to sign in — [Approve]" prompt.
 * That is the version that gets people robbed. See the header of
 * apps/api/src/auth/device-login-store.ts for the full write-up.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, type DeviceLoginRequestInfo } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { AlertTriangle, Check, Shield, X } from '../lib/icons';
import { deviceLabel, platformLabel } from '../lib/deviceInfo';
import { ZekktrisMark } from '../lib/ZekktrisMark';

/** Mirror of the server's normalizeUserCode (device-login-store.ts): upper-case,
    drop anything that isn't [0-9A-Z], then fold the confusable letters the code
    alphabet excludes. The server normalizes again on receipt — this copy only
    keeps the input field honest while the user types. */
function normalizeUserCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** Accept a raw scan/paste: an `/approve-device?code=…` URL or a bare code. */
export function extractUserCode(raw: string): string {
  const m = raw.match(/[?&]code=([^&\s]+)/i);
  return normalizeUserCode(m ? decodeURIComponent(m[1]!) : raw).slice(0, 8);
}

/** Display form, matching the server's `ABCD-EFGH`. */
function formatUserCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** mm:ss for the expiry countdown. */
function countdown(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "just now" / "3 min ago" for the server-stamped request time. */
function relativeTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs) || secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return new Date(iso).toLocaleString();
}

/** One labelled row in either metadata group. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1">
      <span className="w-24 shrink-0 text-[11px] uppercase tracking-wider text-ink-3 pt-0.5">
        {label}
      </span>
      <span className="flex-1 min-w-0 text-sm text-ink-1 break-words">{children}</span>
    </div>
  );
}

type Phase = 'entry' | 'looking' | 'review' | 'deciding' | 'approved' | 'denied';

/**
 * The panel itself: code entry → metadata review → approve/deny.
 * Rendered both as a Settings section and as the standalone /approve-device
 * page that the QR points at.
 */
export function DeviceApprovalPanel({ initialCode }: { initialCode?: string }) {
  const { rest } = useAuth();
  const [raw, setRaw] = useState(() => formatUserCode(extractUserCode(initialCode ?? '')));
  const [phase, setPhase] = useState<Phase>('entry');
  const [info, setInfo] = useState<DeviceLoginRequestInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const lookup = useCallback(
    async (input: string) => {
      const code = extractUserCode(input);
      if (code.length < 8) {
        setErr('Enter the 8-character code shown on the other device.');
        return;
      }
      setPhase('looking');
      setErr(null);
      try {
        const r = await rest.lookupDeviceLogin(code);
        setInfo(r);
        setSecondsLeft(r.expiresIn);
        setPhase('review');
      } catch (e) {
        setPhase('entry');
        setInfo(null);
        // 404 is the server's answer for unknown AND expired — deliberately
        // one response, so this screen must not claim to know which.
        setErr(
          e instanceof ApiError && e.status === 404
            ? "We couldn't find that request. Check the code, or it may have already expired."
            : e instanceof ApiError
              ? e.message
              : 'Could not look up that code.',
        );
      }
    },
    [rest],
  );

  // A code arriving from the QR deep link is looked up automatically — but it
  // is NEVER auto-approved. The whole point of the flow is that a human reads
  // this screen and decides.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    const code = extractUserCode(initialCode ?? '');
    if (code.length < 8) return;
    autoRan.current = true;
    void lookup(code);
  }, [initialCode, lookup]);

  // Expiry countdown. When it runs out the request is dead server-side, so drop
  // the review UI rather than leave a button that can only fail.
  //
  // Only while 'review': once a decision is in flight the server is the judge,
  // and a timer firing mid-request would tear down the screen underneath an
  // approval that is about to succeed.
  useEffect(() => {
    if (!info) return;
    if (phase !== 'review') return;
    if (secondsLeft <= 0) {
      setInfo(null);
      setPhase('entry');
      setErr('That request expired before it was answered. Start a new one on the other device.');
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft, info, phase]);

  async function decide(approve: boolean) {
    if (!info) return;
    setPhase('deciding');
    setErr(null);
    try {
      if (approve) await rest.approveDeviceLogin(info.userCode);
      else await rest.denyDeviceLogin(info.userCode);
      setPhase(approve ? 'approved' : 'denied');
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 409 || status === 404) {
        // Terminal: answered by someone else, or expired. Nothing left to act
        // on, so clear the review entirely.
        setInfo(null);
        setPhase('entry');
        setErr(
          status === 409
            ? 'That request had already been answered. Nothing was changed.'
            : 'That request expired before it was answered.',
        );
      } else {
        // Transient (offline, 429, 5xx) — the request is probably still live.
        // Keep the metadata on screen so the user can retry without hunting
        // down the code again.
        setPhase('review');
        setErr(e instanceof ApiError ? e.message : 'Could not answer that request. Try again.');
      }
    }
  }

  function reset() {
    setInfo(null);
    setRaw('');
    setErr(null);
    setPhase('entry');
    // Don't let the deep-link effect re-run and drag the user back into a
    // request they just finished answering.
    autoRan.current = true;
  }

  // ── Terminal states ──────────────────────────────────────────────────────

  if (phase === 'approved' || phase === 'denied') {
    const approved = phase === 'approved';
    return (
      <div
        className={`rounded-lg border p-4 space-y-3 ${
          approved ? 'border-emerald-600/40 bg-emerald-600/10' : 'border-line bg-bg-1/60'
        }`}
      >
        <div className="flex items-center gap-2">
          {approved ? (
            <Check size={18} className="text-emerald-300 shrink-0" />
          ) : (
            <X size={18} className="text-ink-2 shrink-0" />
          )}
          <span className="text-sm font-medium text-ink-1">
            {approved ? 'Approved — that device is signing in now.' : 'Denied. That device was not signed in.'}
          </span>
        </div>
        <p className="text-sm text-ink-3 leading-relaxed">
          {approved
            ? "If that wasn't you, go to Active Sessions below and sign that device out, then change your password."
            : 'Nothing was shared with it. If you did not expect that request at all, change your password.'}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="text-sm px-3 py-2 rounded-md border border-line text-ink-2 hover:bg-bg-3"
        >
          Review another code
        </button>
      </div>
    );
  }

  // ── Review: the actual decision ──────────────────────────────────────────

  if (info && (phase === 'review' || phase === 'deciding')) {
    const d = info.device;
    const busy = phase === 'deciding';
    return (
      <div className="rounded-lg border border-line bg-bg-1/60 p-4 space-y-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-lg tracking-widest text-ink-1">
            {info.userCode}
          </span>
          <span className="text-xs text-ink-3 shrink-0">Expires in {countdown(secondsLeft)}</span>
        </div>

        {/* The consequence, stated plainly and before the buttons. */}
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
          <div className="flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-300 shrink-0" />
            <span className="text-sm font-medium text-amber-200">
              Approving gives this device full access to your account
            </span>
          </div>
          <p className="text-[13px] text-ink-2 leading-relaxed">
            Messages, DMs, servers, settings and billing — everything you can do, it can do, until
            you sign it out. Only approve a device you are holding right now. Zekktris staff will
            never ask you to approve a device or read out a code.
          </p>
        </div>

        {/* The one unforgeable signal, when it's bad news. */}
        {!d.sameNetwork && (
          <div className="rounded-md border border-red-400/50 bg-red-400/10 p-3 space-y-1">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className="text-red-300 shrink-0" />
              <span className="text-sm font-medium text-red-200">
                This device is on a different network from yours
              </span>
            </div>
            <p className="text-[13px] text-ink-2 leading-relaxed">
              A device sitting next to you is normally on the same network. If you are not physically
              holding the device that shows this code, deny.
            </p>
          </div>
        )}

        {/* Group 1 — server-observed. Cannot be forged by a remote attacker. */}
        <div className="rounded-md border border-line bg-bg-2/60 p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Shield size={14} className="text-accent shrink-0" />
            <span className="text-[11px] uppercase tracking-wider text-ink-2">
              Seen by Zekktris — these cannot be faked
            </span>
          </div>
          <Row label="IP address">
            <span className="font-mono text-[13px]">{d.ipAddress ?? 'Unknown'}</span>
          </Row>
          <Row label="Location">
            {/* The server does no GeoIP and refuses to guess; say so rather than
                render a blank the user reads as "nothing suspicious". */}
            {d.approxLocation ?? <span className="text-ink-3">Not available</span>}
          </Row>
          <Row label="Network">
            {d.sameNetwork ? (
              <span className="text-emerald-300">Same network as this device</span>
            ) : (
              <span className="text-red-300">Different network from this device</span>
            )}
          </Row>
          <Row label="Requested">{relativeTime(d.requestedAt)}</Row>
        </div>

        {/* Group 2 — device claims. Presented as claims, never as facts. */}
        <div className="rounded-md border border-line bg-bg-2/60 p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <AlertTriangle size={14} className="text-ink-3 shrink-0" />
            <span className="text-[11px] uppercase tracking-wider text-ink-2">
              Claimed by that device — unverified
            </span>
          </div>
          <Row label="Calls itself">
            {d.declaredName ?? <span className="text-ink-3">No name given</span>}
          </Row>
          <Row label="Platform">{platformLabel(d.platform)}</Row>
          <Row label="Browser">
            <span>{deviceLabel(d.userAgent)}</span>
            {d.userAgent && (
              <span className="block font-mono text-[11px] text-ink-3 break-all mt-0.5">
                {d.userAgent}
              </span>
            )}
          </Row>
          <Row label="Language">{d.locale ?? <span className="text-ink-3">Unknown</span>}</Row>
        </div>

        {err && (
          <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-300">
            {err}
          </div>
        )}

        {/* Deny first and at least as heavy as Approve — when in doubt the
            cheap, reversible action should be the one under the thumb. */}
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={() => void decide(false)}
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border border-red-400/60 bg-red-400/20 text-sm font-semibold text-red-100 hover:bg-red-400/30 disabled:opacity-50"
          >
            <X size={16} />
            {busy ? 'Working…' : "Deny — this isn't me"}
          </button>
          <button
            type="button"
            onClick={() => void decide(true)}
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-md border border-accent/40 bg-accent/15 text-sm font-semibold text-ink-1 hover:bg-accent/25 disabled:opacity-50"
          >
            <Check size={16} />
            {busy ? 'Working…' : 'Approve this device'}
          </button>
        </div>
      </div>
    );
  }

  // ── Entry ────────────────────────────────────────────────────────────────

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void lookup(raw);
      }}
      className="space-y-3"
    >
      <label className="block space-y-1.5">
        <span className="text-xs uppercase tracking-wider text-ink-3">Code from the new device</span>
        <input
          type="text"
          value={raw}
          onChange={(e) => setRaw(formatUserCode(extractUserCode(e.target.value)))}
          placeholder="ABCD-EFGH"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={9}
          className="w-full bg-bg-1 border border-line rounded-md px-3 py-2 font-mono text-lg tracking-widest text-ink-1 placeholder:text-ink-3 placeholder:tracking-normal focus:outline-none focus:border-accent"
        />
      </label>
      {err && (
        <div className="rounded-md border border-red-400/40 bg-red-400/10 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}
      <button
        type="submit"
        disabled={phase === 'looking' || extractUserCode(raw).length < 8}
        className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-md border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-50"
      >
        {phase === 'looking' ? 'Checking…' : 'Review this request'}
      </button>
    </form>
  );
}

/**
 * Settings → Security section. Same panel, wrapped in the section chrome the
 * rest of that tab uses.
 */
export function DeviceApprovalSection() {
  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">Sign in a new device</div>
      <p className="text-sm text-ink-3 leading-relaxed">
        Signing in somewhere new? On that device choose{' '}
        <span className="text-ink-1">Log in with another device</span> — it shows a QR code and an
        8-character code. Scan the QR with this device&apos;s camera, or type the code here, and
        you&apos;ll be shown exactly what you&apos;re about to approve.
      </p>
      <DeviceApprovalPanel />
    </section>
  );
}

/**
 * Standalone /approve-device page — where the QR on the new device points.
 *
 * Deliberately its own full-page screen rather than a Shell pane: it is a
 * security decision arriving from an out-of-band scan, and it should not be
 * buried three clicks into Settings or competing with a chat view for
 * attention. Signed-out visitors are bounced through login and returned here
 * with the code intact.
 */
export function ApproveDevicePage() {
  const { token, hydrating } = useAuth();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const code = searchParams.get('code') ?? '';

  if (hydrating) return null;
  if (!token) {
    // Preserve the code across the login round-trip. LoginPage only honours
    // same-origin paths for `next`, which this is.
    const next = `/approve-device${code ? `?code=${encodeURIComponent(code)}` : ''}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  return (
    <div className="zk-screen overflow-y-auto bg-bg-1 relative">
      <div className="abyss" aria-hidden />
      <div className="relative z-10 min-h-full flex items-center justify-center px-4 py-8 safe-area-padded">
        <div className="w-full max-w-lg glass glass-edge rounded-2xl overflow-hidden shadow-2xl">
          <div className="p-6 sm:p-8 space-y-4">
            <div className="flex items-center gap-2">
              <ZekktrisMark size={32} className="w-8 h-8 shrink-0" />
              <span className="text-xl font-bold tracking-tight">Approve a sign-in</span>
            </div>
            <p className="text-sm text-ink-2 leading-relaxed">
              A device is asking to sign in to your account. Check the details below against the
              device in your hand before you decide.
            </p>
            <DeviceApprovalPanel initialCode={code} />
            <button
              type="button"
              onClick={() => nav('/', { replace: true })}
              className="block w-full text-center text-xs text-ink-3 hover:text-ink-2 underline"
            >
              Back to Zekktris
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
