/**
 * JoinServerView
 * --------------
 * Form for joining a guild via invite code. Renders as a Shell content
 * pane (rail + content layout) instead of a modal. Leaving without
 * joining is done by clicking another rail tile.
 *
 * Layout mirrors CreateServerView — hero icon + headline + form card
 * — so the two adjacent rail destinations feel like a coherent
 * pair rather than two different aesthetics.
 *
 * NB: a SEPARATE flow handles inbound invite links (`/invite/:code`) —
 * this view is for the user who has a code copied and wants to paste it
 * in. The /invite/:code route reuses InvitePage which auto-accepts when
 * authenticated; this view is the explicit "enter a code" path.
 */

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ChevronLeft } from '../lib/icons';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { UserPlus } from '../lib/icons';

export function JoinServerView() {
  const { rest } = useAuth();
  const { refreshGuilds } = useAppState();
  const nav = useNavigate();

  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setErr(null);
    try {
      // Strip leading https://… if user pasted a full URL.
      const cleaned = code.trim().split('/').filter(Boolean).pop() ?? '';
      const r = await rest.acceptInvite(cleaned);
      await refreshGuilds();
      nav(`/channels/${r.guildId}/${r.channelId}`);
    } catch (e) {
      const restricted =
        e instanceof ApiError &&
        (e.details as { supervisionRestricted?: string } | undefined)?.supervisionRestricted ===
          'guild';
      if (restricted) {
        const cleaned = code.trim().split('/').filter(Boolean).pop() ?? '';
        try {
          await rest.familyRequestGuild(cleaned);
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
        <UserPlus size={16} className="text-accent shrink-0" />
        <h1 className="text-base sm:text-lg font-semibold truncate">Join with invite</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="max-w-lg mx-auto px-4 sm:px-6 py-8 sm:py-12">
          <div className="flex flex-col items-center text-center mb-8">
            <div
              className="w-24 h-24 rounded-3xl flex items-center justify-center mb-4 shadow-lg ring-1 ring-line/50 bg-gradient-to-br from-accent/30 to-accent/10 text-accent"
              aria-hidden
            >
              <UserPlus size={40} />
            </div>
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              Join a server
            </h2>
            <p className="mt-2 text-sm text-ink-2 max-w-sm leading-relaxed">
              Paste an invite link or code below to join an existing server.
              Codes are short strings of letters and numbers; links look like{' '}
              <span className="font-mono text-ink-1">.../invite/<span className="text-accent">abcd1234</span></span>.
            </p>
          </div>

          <form onSubmit={submit} className="glass glass-edge rounded-xl p-5 sm:p-6 shadow-sm space-y-4">
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
              {pending ? 'Joining…' : 'Join server'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-ink-3">
            Don't have an invite?{' '}
            <Link to="/discover" className="text-accent hover:underline">
              Browse public servers
            </Link>{' '}
            or{' '}
            <Link to="/create-server" className="text-accent hover:underline">
              create your own
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
