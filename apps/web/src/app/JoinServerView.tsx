/**
 * JoinServerView
 * --------------
 * Form for joining a guild via invite code. Renders as a Shell content
 * pane (rail + content layout) instead of a modal. Leaving without
 * joining is done by clicking another rail tile.
 *
 * Two-step flow (mirrors iOS JoinByInviteSheet): the user pastes a code
 * and taps "Preview Invite" to fetch the invite metadata, then confirms
 * on a preview card ("Join {name}") — or picks "Use a different code" to
 * go back and re-enter one.
 *
 * NB: a SEPARATE flow handles inbound invite links (`/invite/:code`) —
 * this view is for the user who has a code copied and wants to paste it
 * in. The /invite/:code route reuses InvitePage which auto-accepts when
 * authenticated; this view is the explicit "enter a code" path.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from '../lib/icons';
import { ApiError, type InvitePreview } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { avatarColor, avatarInitials } from '../lib/avatar';

export function JoinServerView() {
  const { rest } = useAuth();
  const { refreshGuilds } = useAppState();
  const nav = useNavigate();

  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Strip a leading https://… so the user can paste a full invite URL.
  function cleanCode() {
    return code.trim().split('/').filter(Boolean).pop() ?? '';
  }

  // Step 1 — fetch the invite metadata and show the preview card.
  async function doPreview(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setErr(null);
    try {
      const r = await rest.previewInvite(cleanCode());
      setPreview(r.invite);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not find that invite');
    } finally {
      setPending(false);
    }
  }

  // Step 2 — accept the previewed invite and jump into the server.
  async function doJoin() {
    if (pending || !preview) return;
    setPending(true);
    setErr(null);
    try {
      const r = await rest.acceptInvite(preview.code);
      await refreshGuilds();
      nav(`/channels/${r.guildId}/${r.channelId}`);
    } catch (e) {
      const restricted =
        e instanceof ApiError &&
        (e.details as { supervisionRestricted?: string } | undefined)?.supervisionRestricted ===
          'guild';
      if (restricted) {
        try {
          await rest.familyRequestGuild(preview.code);
          setErr('This server is restricted. We asked your parent to approve it.');
        } catch {
          setErr('This server is restricted by your parent.');
        }
      } else {
        setErr(e instanceof ApiError ? e.message : 'Could not accept invite');
      }
      setPending(false);
    }
  }

  return (
    <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
      <header className="h-12 border-b bg-bg-2/85 backdrop-blur-sm px-3 sm:px-4 flex items-center gap-2 sm:gap-3 shrink-0 zk-header-strip">
        <button
          onClick={() => nav('/channels/@me')}
          className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={18} />
        </button>
        <h1 className="text-base sm:text-lg font-semibold truncate">Join with invite</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="max-w-lg mx-auto px-4 sm:px-6 py-8 sm:py-12">
          {preview ? (
            <InvitePreviewCard
              invite={preview}
              pending={pending}
              err={err}
              onJoin={() => void doJoin()}
              onReset={() => {
                setPreview(null);
                setErr(null);
              }}
            />
          ) : (
            <form
              onSubmit={doPreview}
              className="glass glass-edge rounded-xl p-5 sm:p-6 shadow-sm space-y-4"
            >
              <label className="block">
                <span className="text-xs uppercase tracking-wider font-semibold text-ink-3">
                  Invite code or link
                </span>
                <input
                  type="text"
                  className="mt-2 w-full bg-bg-1/60 backdrop-blur-sm border rounded-md px-3 py-2.5 outline-none font-mono transition-all focus:shadow-[0_0_0_1px_var(--accent-glow),0_0_14px_var(--accent-glow)]"
                  style={{ borderColor: 'var(--zk-line)' }}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="abcd1234 or https://…/invite/abcd1234"
                  required
                />
                <span className="block mt-1.5 text-xs text-ink-3">
                  We'll auto-strip the URL prefix if you paste a full link.
                </span>
              </label>
              {err && (
                <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                  {err}
                </div>
              )}
              <button
                type="submit"
                disabled={pending || !code.trim()}
                className="w-full px-4 py-2.5 rounded-md bg-gradient-to-br from-accent to-accent-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed text-bg-0 font-semibold transition-all shadow-[0_0_0_1px_var(--accent-glow),0_4px_18px_var(--accent-glow)]"
              >
                {pending ? 'Checking…' : 'Preview Invite'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function InvitePreviewCard({
  invite,
  pending,
  err,
  onJoin,
  onReset,
}: {
  invite: InvitePreview;
  pending: boolean;
  err: string | null;
  onJoin: () => void;
  onReset: () => void;
}) {
  const g = invite.guild;
  const tone = avatarColor(g.id);
  const initials = avatarInitials(g.name);
  const count = Number(g.memberCount);

  return (
    <div className="glass glass-edge rounded-xl overflow-hidden shadow-sm">
      {/* Banner (image or accent→accent2 gradient fallback) */}
      <div className="relative h-28 w-full">
        {g.bannerUrl ? (
          <img src={g.bannerUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-accent/55 to-accent-2/45" />
        )}
        {/* Squircle server icon overlapping the banner's bottom edge */}
        <div className="absolute -bottom-8 left-5">
          {g.iconUrl ? (
            <img
              src={g.iconUrl}
              alt=""
              className="w-16 h-16 rounded-2xl object-cover ring-4 ring-bg-1 shadow-lg"
              draggable={false}
            />
          ) : (
            <div
              className={`w-16 h-16 rounded-2xl flex items-center justify-center text-xl font-bold ring-4 ring-bg-1 shadow-lg ${tone}`}
            >
              {initials}
            </div>
          )}
        </div>
      </div>

      <div className="pt-11 px-5 pb-5">
        <div className="text-xs uppercase tracking-wider font-semibold text-ink-3">
          You've been invited to join
        </div>
        <h2 className="mt-1 text-xl font-bold text-ink-1 break-words">{g.name}</h2>
        {g.description && (
          <p className="mt-1 text-sm text-ink-2 break-words leading-relaxed">
            {g.description}
          </p>
        )}
        <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-3 tabular-nums">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span>
            {count.toLocaleString()} {count === 1 ? 'member' : 'members'}
          </span>
        </div>

        {err && (
          <div className="mt-4 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
            {err}
          </div>
        )}

        <button
          type="button"
          onClick={onJoin}
          disabled={pending}
          className="mt-4 w-full px-4 py-2.5 rounded-md bg-gradient-to-br from-accent to-accent-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed text-bg-0 font-semibold transition-all shadow-[0_0_0_1px_var(--accent-glow),0_4px_18px_var(--accent-glow)]"
        >
          {pending ? 'Joining…' : `Join ${g.name}`}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={pending}
          className="mt-2 w-full text-center text-xs text-ink-3 hover:text-ink-1 transition-colors disabled:opacity-60"
        >
          Use a different code
        </button>
      </div>
    </div>
  );
}
