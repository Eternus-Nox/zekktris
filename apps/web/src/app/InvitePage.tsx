/**
 * InvitePage
 * ----------
 * Landing for /invite/:code. The flow:
 *
 *   1. Fetch the public preview (no auth required) so the user can
 *      see what they're being invited to before deciding.
 *   2. If the visitor is signed in, auto-accept and navigate them
 *      into the guild's landing channel. A manual "Join" button is
 *      shown as a fallback if auto-accept hasn't fired yet.
 *   3. If the visitor is NOT signed in, show "Sign in" and "Create
 *      account" buttons. Both append ?next=/invite/{code} so when
 *      authentication completes, AuthContext bounces them back here
 *      and the auto-accept kicks in.
 *
 * Routing duality. App.tsx's `/invite/:code` route picks the wrapper
 * based on token presence:
 *   - authenticated → renders inside <Shell> with the rail visible
 *     (matches the discover/admin/mentions/settings pattern).
 *   - anonymous     → renders standalone with the full-takeover
 *     auth-card frame.
 * `Frame` switches its sizing on the same token flag so that when
 * rendered inside Shell the page uses h-full and Shell's chrome shows
 * through, instead of stacking another full-viewport background.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, type InvitePreview } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { UserPlus } from '../lib/icons';

export function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const { rest, token, hydrating } = useAuth();
  const nav = useNavigate();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  // Fetch the preview on mount. No auth required — the server treats
  // this endpoint as public so anonymous browsers can see what's on
  // the other side of an invite link before signing up.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void rest
      .previewInvite(code)
      .then((r) => {
        if (cancelled) return;
        setPreview(r.invite);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Invite not found');
      });
    return () => {
      cancelled = true;
    };
  }, [code, rest]);

  async function accept() {
    if (!code || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const r = await rest.acceptInvite(code);
      // Land on the channel the invite was created for if the server
      // returned one; otherwise the guild root (Shell will pick a
      // sensible channel via its own routing fallback).
      if (r.channelId) {
        nav(`/channels/${r.guildId}/${r.channelId}`, { replace: true });
      } else {
        nav(`/channels/${r.guildId}`, { replace: true });
      }
    } catch (e) {
      const restricted =
        e instanceof ApiError &&
        (e.details as { supervisionRestricted?: string } | undefined)?.supervisionRestricted ===
          'guild';
      if (restricted) {
        try {
          await rest.familyRequestGuild(code);
          setError('This server is restricted. We asked your parent to approve it.');
        } catch {
          setError('This server is restricted by your parent.');
        }
      } else {
        setError(e instanceof ApiError ? e.message : 'Could not join server');
      }
      setAccepting(false);
    }
  }

  // Auto-accept once the user is authenticated. This drives the
  // "sign up → land back here → join automatically" flow without
  // making AuthContext aware of the invite system. The first run
  // happens immediately after the preview loads if the user is
  // already signed in; the second run happens after a fresh login
  // or register navigates back to /invite/:code.
  useEffect(() => {
    if (hydrating || !token || !preview) return;
    void accept();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrating, token, preview]);

  if (hydrating) return null;

  const inShell = !!token;

  // ── Error / not-found state ──────────────────────────────────────────
  if (error && !preview) {
    return (
      <Frame inShell={inShell}>
        <div className="text-center py-6">
          <div className="w-12 h-12 rounded-full bg-red-500/10 text-red-400 mx-auto mb-3 flex items-center justify-center text-2xl font-bold">
            !
          </div>
          <h2 className="text-lg font-semibold text-ink-1">Invite invalid</h2>
          <p className="text-sm text-ink-2 mt-1">{error}</p>
          {/* Anonymous visitors get a sign-in nudge; authenticated
              users use the rail to navigate away (no back button
              needed here). */}
          {!inShell && (
            <Link
              to="/login"
              className="inline-block mt-4 px-4 py-2 rounded-md bg-bg-3 hover:bg-bg-1 text-ink-1 text-sm"
            >
              Sign in
            </Link>
          )}
        </div>
      </Frame>
    );
  }

  // ── Loading state ───────────────────────────────────────────────────
  if (!preview) {
    return (
      <Frame inShell={inShell}>
        <p className="text-center text-ink-3 text-sm py-6">Loading invite…</p>
      </Frame>
    );
  }

  // ── Loaded state ────────────────────────────────────────────────────
  const tone = avatarColor(preview.guild.id);
  const initials = avatarInitials(preview.guild.name);
  const nextQS = code ? `?next=${encodeURIComponent(`/invite/${code}`)}` : '';

  return (
    <Frame inShell={inShell}>
      {/* Banner — 16:9 to match the in-app guild banner shape on the
          channel list. Falls back to a tinted block when no banner
          is set. object-cover for a polished marketing-card feel on
          this surface (the live channel-list render also covers). */}
      <div className={`-mx-8 -mt-2 mb-6 aspect-[16/9] ${preview.guild.bannerUrl ? '' : tone} overflow-hidden`}>
        {preview.guild.bannerUrl && (
          <img
            src={preview.guild.bannerUrl}
            alt=""
            className="w-full h-full object-cover"
            draggable={false}
          />
        )}
      </div>
      <div className="flex items-center gap-3 mb-4">
        {preview.guild.iconUrl ? (
          <img
            src={preview.guild.iconUrl}
            alt=""
            className="w-14 h-14 rounded-lg object-cover shrink-0"
            draggable={false}
          />
        ) : (
          <div
            className={`w-14 h-14 rounded-lg flex items-center justify-center text-lg font-semibold shrink-0 ${tone}`}
          >
            {initials}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
            You've been invited to join
          </div>
          <h2 className="text-lg font-semibold text-ink-1 truncate">{preview.guild.name}</h2>
        </div>
      </div>
      {preview.guild.description && (
        <p className="text-sm text-ink-2 leading-relaxed mb-4 line-clamp-3">
          {preview.guild.description}
        </p>
      )}
      <div className="flex items-center gap-2 mb-5 text-xs text-ink-3 tabular-nums">
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        <span>
          {preview.guild.memberCount.toLocaleString()}{' '}
          {preview.guild.memberCount === 1 ? 'member' : 'members'}
        </span>
      </div>

      {error && (
        <p className="mb-3 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {/* Auth-state-dependent CTA. Signed-in users see a single
          accept button (auto-fires on mount via the effect above —
          this button is the fallback for the rare case where the
          effect hasn't run yet, and a manual click during accept-
          in-flight). Signed-out users see the sign-in / sign-up
          choice. */}
      {token ? (
        <button
          type="button"
          onClick={() => void accept()}
          disabled={accepting}
          className="w-full px-4 py-2 rounded-md bg-gradient-to-br from-accent to-accent-2 hover:brightness-110 text-bg-0 text-sm font-semibold disabled:opacity-60 transition-all shadow-[0_0_0_1px_var(--accent-glow),0_4px_18px_var(--accent-glow)]"
        >
          {accepting ? 'Joining…' : `Join ${preview.guild.name}`}
        </button>
      ) : (
        <div className="space-y-2">
          <Link
            to={`/login${nextQS}`}
            className="block w-full px-4 py-2 rounded-md bg-gradient-to-br from-accent to-accent-2 hover:brightness-110 text-bg-0 text-sm font-semibold text-center transition-all shadow-[0_0_0_1px_var(--accent-glow),0_4px_18px_var(--accent-glow)]"
          >
            Sign in to join
          </Link>
          <Link
            to={`/register${nextQS}`}
            className="block w-full px-4 py-2 rounded-md bg-bg-3 hover:bg-bg-1 text-ink-1 text-sm font-medium text-center"
          >
            Create an account
          </Link>
        </div>
      )}
    </Frame>
  );
}

/** Card frame for the invite page. Two sizing modes:
 *   - inShell=false (anonymous visitor): full-page takeover with the
 *     auth-card aesthetic — centered on the viewport over bg-bg-1.
 *     No header strip since this isn't an in-app section, it's a
 *     public landing for a deep-linked URL.
 *   - inShell=true  (authenticated, rendered inside Shell): h-full
 *     content pane with the same h-12 header strip the other rail
 *     surfaces (Mentions/Settings/Admin/Discover/CreateServer/
 *     JoinServer) use, so the section label stays consistent. The
 *     centered card sits below the header.
 */
function Frame({ children, inShell }: { children: React.ReactNode; inShell: boolean }) {
  if (inShell) {
    return (
      <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
        <header className="h-12 border-b bg-bg-2/85 backdrop-blur-sm px-3 sm:px-4 flex items-center gap-2 sm:gap-3 shrink-0 zk-header-strip">
          <UserPlus size={16} className="text-accent shrink-0" />
          <h1 className="text-base sm:text-lg font-semibold truncate">Server invite</h1>
        </header>
        <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center px-4 py-6">
          <div className="w-full max-w-md glass glass-edge rounded-xl px-8 pt-2 pb-8 shadow-2xl overflow-hidden relative">
            <div className="mb-2 flex items-center justify-center gap-3 pt-4">
              <img src="/icon.svg?v=zk1" alt="" className="w-8 h-8 shrink-0" draggable={false} />
              <span className="text-base font-semibold tracking-tight text-ink-1">Zekktris</span>
            </div>
            {children}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-1 px-4 safe-area-padded relative overflow-hidden">
      {/* Same ambient abyss as the auth screens — invite landings
          are also a "first impression" surface (often a user's first
          look at a Zekktris instance before they sign in), so they
          get the full plasma + starfield treatment behind the card. */}
      <div className="abyss" aria-hidden />
      <div className="w-full max-w-md glass glass-edge rounded-xl px-8 pt-2 pb-8 shadow-2xl overflow-hidden relative z-10">
        <div className="mb-2 flex items-center justify-center gap-3 pt-4">
          <img src="/icon.svg?v=zk1" alt="" className="w-8 h-8 shrink-0" draggable={false} />
          <span className="text-base font-semibold tracking-tight text-ink-1">Zekktris</span>
        </div>
        {children}
      </div>
    </div>
  );
}
