/**
 * AdminPanel
 * ----------
 * Instance-admin dashboard. Lives at /admin and is gated to users with
 * `isAdmin === true` on their SelfUser. Non-admins (or unauthenticated
 * users) get bounced back to the home route.
 *
 * Four tabs share a common header:
 *   - Overview  → /admin/stats          (counts + recent activity)
 *   - Users     → /admin/users          (search + ban/admin actions)
 *   - Guilds    → /admin/guilds         (server list with member counts)
 *   - Storage   → /admin/storage        (attachment + avatar disk usage)
 *
 * Each tab does its own fetch on mount. There's no global admin store
 * because admin traffic is rare and the data is intentionally
 * snapshot-style (the operator's "what is the state of the instance
 * right now" question) — refetch on tab switch is the right behavior.
 */

import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  ApiError,
  type AdminActivity,
  type AdminGuild,
  type AdminPeekChannel,
  type AdminPeekGuild,
  type AdminPeekMessage,
  type AdminStats,
  type InstanceMetrics,
  type LivekitDiagnostic,
  type InstanceRestoreResult,
  type AdminStorage,
  type StorageItem,
  type StorageListing,
  type StorageCategory,
  type AdminUser,
} from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { AdminSecurityTab } from './AdminSecurityTab';
import { useToasts } from '../state/Toasts';
import { AvatarImage } from '../lib/AvatarImage';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { Hash, Lock, Search as SearchIcon, Shield, Volume2, X as CloseIcon, Users, Archive, BarChart, ChevronLeft } from '../lib/icons';

type Tab = 'overview' | 'users' | 'guilds' | 'storage' | 'security' | 'backup';

export function AdminPanel() {
  const navigate = useNavigate();
  const { user, hydrating } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  /**
   * Ghost-mode observe state. When set, AdminPanel renders the
   * ObserveView for that specific guild instead of the tabbed
   * (overview / users / guilds / storage) UI. Clearing this state
   * returns to the tabs. We deliberately don't sync this to the URL
   * — refreshing the page returns to /admin (the tabs), which feels
   * right for a moderation tool: observe state is ephemeral, not a
   * persistent navigation location.
   */
  const [observing, setObserving] = useState<{ guildId: string; guildName: string } | null>(null);

  if (hydrating) return null;
  // Redirect non-admins. Two cases: unauthenticated (no user) goes to
  // login with a next=, and non-admin authenticated users go home.
  // We treat the route as if it doesn't exist for them rather than
  // showing a "you don't have permission" page — there's no need to
  // signal the admin surface to non-admins.
  //
  // These checks are also performed in Shell (which is what renders
  // AdminPanel now that it lives inside the shared layout), but we
  // keep them here as defense-in-depth — anything that mounts the
  // AdminPanel component directly without going through Shell would
  // otherwise skip the gate.
  if (!user) return <Navigate to="/login?next=/admin" replace />;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  return (
    // No min-h-screen wrapper: AdminPanel now renders inside Shell's
    // <main> which provides the layout chrome (full-height, scroll
    // container). Using flex-col + h-full instead so the inner
    // scroll region fills available vertical space and the header
    // stays pinned.
    <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
      <header
        className="px-3 sm:px-4 border-b shrink-0"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <div className="h-12 flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => navigate('/channels/@me')}
            className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
            aria-label="Back to direct messages"
          >
            <ChevronLeft size={18} />
          </button>
          <Shield size={16} className="text-accent shrink-0" />
          <h1 className="text-base sm:text-lg font-semibold truncate">Instance admin</h1>
          <span className="hidden sm:inline-block ml-2 text-xs text-ink-3 truncate">
            {/* Identify which instance / which admin is signed in — useful when
                an op is logged into multiple environments. */}
            signed in as <span className="font-medium text-ink-2">{user.username}</span>
          </span>
        </div>
        {!observing && (
          <nav
            className="flex gap-1 -mb-px overflow-x-auto scrollbar-thin"
            role="tablist"
            aria-label="Admin sections"
          >
            {(
              [
                { id: 'overview', label: 'Overview' },
                { id: 'users', label: 'Users' },
                { id: 'guilds', label: 'Servers' },
                { id: 'storage', label: 'Storage' },
                { id: 'security', label: 'Security' },
                { id: 'backup', label: 'Backup' },
              ] as { id: Tab; label: string }[]
            ).map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.id)}
                  className={`px-3 py-2 text-sm border-b-2 transition-colors whitespace-nowrap ${
                    active
                      ? 'border-accent text-ink-1 font-medium'
                      : 'border-transparent text-ink-3 hover:text-ink-2'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </nav>
        )}
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {observing ? (
          <ObserveView
            guildId={observing.guildId}
            guildName={observing.guildName}
            onClose={() => setObserving(null)}
          />
        ) : (
          <div className="px-4 sm:px-8 py-6">
            {tab === 'overview' && <OverviewTab />}
            {tab === 'users' && <UsersTab />}
            {tab === 'guilds' && (
              <GuildsTab
                onObserve={(guildId, guildName) => setObserving({ guildId, guildName })}
              />
            )}
            {tab === 'storage' && <StorageTab />}
            {tab === 'security' && <AdminSecurityTab />}
            {tab === 'backup' && <BackupAdminTab />}
          </div>
        )}
      </main>
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────

function OverviewTab() {
  const { rest } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [activity, setActivity] = useState<AdminActivity | null>(null);
  const [metrics, setMetrics] = useState<InstanceMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Voice/LiveKit diagnostic — run on demand (it probes the SFU over the
  // network), not auto-loaded with the counts above.
  const [diag, setDiag] = useState<LivekitDiagnostic | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);

  async function runVoiceDiagnostic() {
    if (diagRunning) return;
    setDiagRunning(true);
    setDiagError(null);
    try {
      const r = await rest.adminVoiceDiagnostic();
      setDiag(r.diagnostic);
    } catch (e) {
      setDiagError(e instanceof ApiError ? e.message : 'Diagnostic failed');
    } finally {
      setDiagRunning(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    // Fetch stats and activity in parallel — neither blocks the other,
    // and a failure in one doesn't kill the other's render. The two
    // are surfaced in separate sections of the Overview so a partial
    // load is genuinely useful (stats can be visible while activity
    // is still loading or has errored).
    void rest
      .adminStats()
      .then((r) => {
        if (cancelled) return;
        setStats(r.stats);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Failed to load stats');
      });
    void rest
      .adminActivity()
      .then((r) => {
        if (cancelled) return;
        setActivity(r.activity);
      })
      .catch(() => {
        // Activity is supplementary — silent-fail so a transient backend
        // issue doesn't tear down the Overview tab.
      });
    void rest
      .adminMetrics()
      .then((r) => {
        if (cancelled) return;
        setMetrics(r.metrics);
      })
      .catch(() => {
        // Operational metrics are supplementary — silent-fail like activity.
      });
    return () => {
      cancelled = true;
    };
  }, [rest]);

  // Human-readable uptime (e.g. "3d 4h", "12m").
  function fmtUptime(s: number): string {
    if (s < 60) return `${s}s`;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!stats) return <p className="text-sm text-ink-3">Loading…</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      <AdminTabHeader
        icon={BarChart}
        title="Overview"
        subtitle="A live snapshot of this instance — counts refresh when you revisit the tab."
      />
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label="Users" value={stats.users.total.toLocaleString()} subtle={`${stats.users.banned} banned`} />
        <StatCard label="Servers" value={stats.guilds.toLocaleString()} />
        <StatCard label="Channels" value={stats.channels.toLocaleString()} />
        <StatCard label="Messages" value={stats.messages.total.toLocaleString()} subtle={`${stats.messages.last24h.toLocaleString()} in last 24h`} />
        <StatCard label="Active sessions" value={stats.activeSessions.toLocaleString()} subtle="proxy for online users" />
        <StatCard label="Snapshot" value={new Date(stats.generatedAt).toLocaleTimeString()} subtle="generated at" />
      </section>

      {/* Operational / runtime metrics — live process + infra health. Renders
          only once the metrics call resolves; the counts above stay useful on
          their own if it's slow or errors. */}
      {metrics && (
        <section className="space-y-2">
          <h3 className="text-xs uppercase tracking-wider text-ink-3">Operational</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard
              label="Gateway connections"
              value={metrics.gateway.connections.toLocaleString()}
              subtle={`${metrics.gateway.onlineUsers.toLocaleString()} users online`}
            />
            <StatCard
              label="In voice"
              value={metrics.voice.participants.toLocaleString()}
              subtle={`${metrics.voice.rooms.toLocaleString()} active ${metrics.voice.rooms === 1 ? 'room' : 'rooms'}`}
            />
            <StatCard
              label="Scheduled messages"
              value={metrics.scheduledMessages.pending.toLocaleString()}
              subtle={`${metrics.scheduledMessages.due.toLocaleString()} due now`}
            />
            <StatCard
              label="Uptime"
              value={fmtUptime(metrics.process.uptimeSeconds)}
              subtle={`worker ${metrics.process.workerId}`}
            />
            <StatCard
              label="Database"
              value={metrics.db.ok ? 'Healthy' : 'Down'}
              subtle={`${metrics.db.latencyMs}ms query`}
            />
            <StatCard
              label="Redis"
              value={
                !metrics.redis.configured
                  ? 'Not configured'
                  : metrics.redis.healthy
                    ? 'Healthy'
                    : 'Unreachable'
              }
              subtle={metrics.redis.configured ? 'gateway bus + blacklist' : 'in-memory bus'}
            />
          </div>
        </section>
      )}

      {activity && (activity.recentUsers.length > 0 || activity.recentGuilds.length > 0) && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ActivityList
            title="Recent signups"
            empty="No registrations yet."
            items={activity.recentUsers.map((u) => ({
              key: u.id,
              avatarUrl: u.avatarUrl,
              avatarSeed: u.id,
              avatarName: u.displayName ?? u.username,
              primary: u.displayName ?? u.username,
              secondary: `@${u.username}`,
              when: u.createdAt,
            }))}
          />
          <ActivityList
            title="New servers"
            empty="No servers yet."
            items={activity.recentGuilds.map((g) => ({
              key: g.id,
              avatarUrl: g.iconUrl,
              avatarSeed: g.id,
              avatarName: g.name,
              primary: g.name,
              secondary: `id ${g.id}`,
              when: g.createdAt,
            }))}
          />
        </section>
      )}

      {/* Voice / LiveKit diagnostic — the #1 self-host gotcha. Run on demand. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs uppercase tracking-wider text-ink-3">Voice / LiveKit</h3>
          <button
            onClick={() => void runVoiceDiagnostic()}
            disabled={diagRunning}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-bg-2 text-ink-1 border border-line hover:border-accent transition-colors disabled:opacity-50"
          >
            {diagRunning ? 'Testing…' : diag ? 'Re-run test' : 'Test voice'}
          </button>
        </div>
        {diagError && <p className="text-sm text-red-300">{diagError}</p>}
        {diag && (
          <div className="rounded-md border border-line bg-bg-2/40 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                  diag.ok
                    ? 'bg-green-500/20 text-green-300 border border-green-500/40'
                    : diag.configured
                      ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                }`}
              >
                {diag.ok ? 'Server checks OK' : diag.configured ? 'Problem found' : 'Not configured'}
              </span>
              {diag.wsUrl && <span className="text-xs text-ink-3 font-mono truncate">{diag.wsUrl}</span>}
            </div>
            <ul className="space-y-1.5">
              {diag.checks.map((ch) => (
                <li key={ch.id} className="flex items-start gap-2 text-xs">
                  <span
                    className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-full flex items-center justify-center text-[0.6rem] font-bold ${
                      ch.status === 'pass'
                        ? 'bg-green-500/25 text-green-300'
                        : ch.status === 'fail'
                          ? 'bg-red-500/25 text-red-300'
                          : ch.status === 'warn'
                            ? 'bg-amber-500/25 text-amber-300'
                            : 'bg-bg-3 text-ink-3'
                    }`}
                    aria-label={ch.status}
                  >
                    {ch.status === 'pass' ? '✓' : ch.status === 'fail' ? '✕' : ch.status === 'warn' ? '!' : '–'}
                  </span>
                  <span className="min-w-0">
                    <span className="text-ink-1 font-medium">{ch.label}</span>
                    <span className="text-ink-3"> — {ch.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!diag && !diagRunning && !diagError && (
          <p className="text-xs text-ink-3">
            Tests LiveKit end-to-end: keys, the URL clients connect to, token minting, and whether the
            server can reach the SFU. The most common self-host failure is the API not being able to
            reach LiveKit, or media (UDP 7882) not being open to clients.
          </p>
        )}
      </section>

      <p className="text-xs text-ink-3 leading-relaxed">
        These counts are a snapshot at request time. Switch tabs and back to
        refresh. Storage usage has its own tab with file-level breakdown.
      </p>
    </div>
  );
}

/**
 * Renders a small "what happened recently" list — either signups or
 * server creations. Shared because both lists have identical visual
 * shape (avatar + name + secondary line + timestamp), just different
 * data sources.
 */
function ActivityList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{
    key: string;
    avatarUrl: string | null;
    avatarSeed: string;
    avatarName: string;
    primary: string;
    secondary: string;
    when: string;
  }>;
}) {
  return (
    <div className="bg-bg-2 border border-line rounded-lg p-4">
      <h2 className="text-xs text-ink-3 uppercase tracking-wider font-semibold mb-3">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-ink-3">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => {
            const tone = avatarColor(it.avatarSeed);
            return (
              <li key={it.key} className="flex items-center gap-2 min-w-0">
                <div className={`relative w-7 h-7 rounded-full overflow-hidden shrink-0 ${tone} text-xs font-bold flex items-center justify-center`}>
                  <span>{avatarInitials(it.avatarName)}</span>
                  <AvatarImage src={it.avatarUrl} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink-1 truncate">{it.primary}</div>
                  <div className="text-xs text-ink-3 truncate">{it.secondary}</div>
                </div>
                <div className="text-xs text-ink-3 shrink-0 tabular-nums" title={new Date(it.when).toLocaleString()}>
                  {relativeTime(it.when)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Compact relative-time formatter for the activity feed. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function StatCard({
  label,
  value,
  subtle,
}: {
  label: string;
  value: string;
  subtle?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-bg-2 p-4 transition-colors hover:border-accent/30">
      <div className="text-[11px] text-ink-3 uppercase tracking-wider font-semibold">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold text-ink-1 tabular-nums">{value}</div>
      {subtle && <div className="mt-1 text-xs text-ink-3">{subtle}</div>}
    </div>
  );
}

// Shared tab header — a gradient squircle icon + title + optional subtitle and
// trailing action, matching the Family page's section header so the admin
// surface reads as part of the same app rather than a bolt-on console.
function AdminTabHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-5">
      <div className="flex items-start gap-3 min-w-0">
        <div className="shrink-0 w-10 h-10 rounded-2xl bg-gradient-to-br from-accent to-accent-2 grid place-items-center text-bg-0 shadow-[0_8px_28px_var(--accent-glow)]">
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink-1 leading-tight truncate">{title}</h2>
          {subtitle && <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ── Users tab ─────────────────────────────────────────────────────────────

function UsersTab() {
  const { rest, user: self } = useAuth();
  const toasts = useToasts();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [q, setQ] = useState('');
  const [bannedOnly, setBannedOnly] = useState(false);
  const [pending, setPending] = useState<string | null>(null); // userId currently mutating

  // Debounce the search input — 250ms is long enough that quick typists
  // don't fire one request per keystroke, short enough that the user
  // doesn't perceive lag.
  const trimmed = useMemo(() => q.trim(), [q]);
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      void rest
        .adminListUsers({ q: trimmed || undefined, limit: 25, bannedOnly: bannedOnly || undefined })
        .then((r) => {
          if (cancelled) return;
          setUsers(r.users);
        })
        .catch((e) => {
          if (cancelled) return;
          toasts.push(e instanceof ApiError ? e.message : 'Failed to load users', 'error');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [rest, trimmed, bannedOnly, toasts]);

  async function toggleBan(u: AdminUser) {
    setPending(u.id);
    try {
      if (u.bannedAt) {
        await rest.adminUnbanUser(u.id);
        toasts.push(`Unbanned ${u.username}`, 'success');
      } else {
        await rest.adminBanUser(u.id);
        toasts.push(`Banned ${u.username}`, 'success');
      }
      // Optimistic refresh — reflect new state immediately.
      setUsers((prev) =>
        prev?.map((x) => (x.id === u.id ? { ...x, bannedAt: u.bannedAt ? null : new Date().toISOString() } : x)) ?? null,
      );
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Action failed', 'error');
    } finally {
      setPending(null);
    }
  }

  async function toggleAdmin(u: AdminUser) {
    setPending(u.id);
    try {
      await rest.adminSetUserAdmin(u.id, !u.isAdmin);
      toasts.push(`${u.username} is ${u.isAdmin ? 'no longer ' : ''}an admin`, 'success');
      setUsers((prev) =>
        prev?.map((x) => (x.id === u.id ? { ...x, isAdmin: !u.isAdmin } : x)) ?? null,
      );
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Action failed', 'error');
    } finally {
      setPending(null);
    }
  }

  /**
   * Force-logout: revoke all sessions for this user and close their
   * live WebSockets. Distinct from ban — the account is still active,
   * the user just has to sign back in. Useful for phish recovery
   * ("this user clicked a phishing link, sign them out everywhere")
   * or stale-device cleanup ("they replaced their phone, the old one
   * still has an active session").
   */
  async function forceLogout(u: AdminUser) {
    setPending(u.id);
    try {
      await rest.adminLogoutUser(u.id);
      toasts.push(`Signed out ${u.username} from all devices`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Sign-out failed', 'error');
    } finally {
      setPending(null);
    }
  }

  async function removeUser(u: AdminUser) {
    if (
      !window.confirm(
        `Permanently delete @${u.username}? This removes their account and data and cannot be undone.`,
      )
    )
      return;
    setPending(u.id);
    try {
      await rest.adminDeleteUser(u.id);
      toasts.push(`Deleted ${u.username}`, 'success');
      setUsers((prev) => prev?.filter((x) => x.id !== u.id) ?? null);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3 max-w-5xl">
      <AdminTabHeader
        icon={Users}
        title="Users"
        subtitle="Search accounts, review bans, and manage sessions."
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <SearchIcon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by username, display name, or email"
            className="w-full bg-bg-2 border border-line rounded-md pl-8 pr-3 py-1.5 text-sm text-ink-1 placeholder:text-ink-3 focus:outline-none focus:border-accent"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={bannedOnly}
            onChange={(e) => setBannedOnly(e.target.checked)}
            className="accent-accent"
          />
          <span>Banned only</span>
        </label>
      </div>

      {!users ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-ink-3 py-8 text-center">No users match.</p>
      ) : (
        <ul className="space-y-1">
          {users.map((u) => {
            const isSelf = self?.id === u.id;
            const tone = avatarColor(u.id);
            const initials = avatarInitials(u.displayName ?? u.username);
            return (
              <li
                key={u.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2.5 px-3 py-3.5 rounded-md bg-bg-2 border border-line"
              >
                <div className={`relative w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden ${tone}`}>
                  <span>{initials}</span>
                  <AvatarImage src={u.avatarUrl} />
                </div>
                <div className="min-w-0 grow basis-48">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-medium text-ink-1 truncate max-w-full">
                      {u.displayName ?? u.username}
                    </span>
                    {u.isAdmin && (
                      <span className="text-[0.6rem] uppercase font-bold tracking-wider bg-accent/20 text-accent px-1 py-0.5 rounded">
                        admin
                      </span>
                    )}
                    {u.bannedAt && (
                      <span className="text-[0.6rem] uppercase font-bold tracking-wider bg-red-500/20 text-red-400 px-1 py-0.5 rounded">
                        banned
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-ink-3 truncate">
                    @{u.username} · {u.email}
                  </div>
                  <div
                    className="text-xs text-ink-3 mt-0.5"
                    title={u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : 'No recorded activity'}
                  >
                    {u.lastSeenAt ? `Last online ${relativeTime(u.lastSeenAt)}` : 'Never online'}
                  </div>
                </div>
                {!isSelf && (
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0 ml-auto">
                    <button
                      onClick={() => toggleAdmin(u)}
                      disabled={pending === u.id}
                      className="text-xs px-2.5 py-1.5 rounded bg-bg-3 hover:bg-bg-1 text-ink-2 hover:text-ink-1 disabled:opacity-50 transition-colors"
                      title={u.isAdmin ? 'Remove admin' : 'Make admin'}
                    >
                      {u.isAdmin ? 'Demote' : 'Promote'}
                    </button>
                    {/* Sign-out button — only shown when the user isn't
                        already banned, since banning revokes sessions
                        implicitly and a redundant "sign out a banned
                        user" button is just noise. */}
                    {!u.bannedAt && (
                      <button
                        onClick={() => forceLogout(u)}
                        disabled={pending === u.id}
                        className="text-xs px-2.5 py-1.5 rounded bg-bg-3 hover:bg-bg-1 text-ink-2 hover:text-ink-1 disabled:opacity-50 transition-colors"
                        title="Force sign-out from all devices (account stays active)"
                      >
                        Sign out
                      </button>
                    )}
                    <button
                      onClick={() => toggleBan(u)}
                      disabled={pending === u.id}
                      className={`text-xs px-2.5 py-1.5 rounded disabled:opacity-50 transition-colors ${
                        u.bannedAt
                          ? 'bg-bg-3 hover:bg-bg-1 text-ink-2 hover:text-ink-1'
                          : 'bg-red-500/10 hover:bg-red-500/20 text-red-400'
                      }`}
                      title={u.bannedAt ? 'Unban' : 'Ban'}
                    >
                      {u.bannedAt ? 'Unban' : 'Ban'}
                    </button>
                    <button
                      onClick={() => removeUser(u)}
                      disabled={pending === u.id}
                      className="text-xs px-2.5 py-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50 transition-colors"
                      title="Permanently delete this account"
                    >
                      Delete
                    </button>
                  </div>
                )}
                {isSelf && (
                  <span className="text-xs text-ink-3 italic shrink-0 ml-auto">you</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Guilds tab ────────────────────────────────────────────────────────────

function GuildsTab({ onObserve }: { onObserve: (guildId: string, guildName: string) => void }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [guilds, setGuilds] = useState<AdminGuild[] | null>(null);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const trimmed = useMemo(() => q.trim(), [q]);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      void rest
        .adminListGuilds({ q: trimmed || undefined, limit: 50 })
        .then((r) => {
          if (cancelled) return;
          setGuilds(r.guilds);
        })
        .catch((e) => {
          if (cancelled) return;
          toasts.push(e instanceof ApiError ? e.message : 'Failed to load guilds', 'error');
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [rest, trimmed, toasts]);

  /**
   * Confirm + delete. We use window.confirm rather than building a
   * custom modal because (a) this is an admin tool, not a user-facing
   * flow, and (b) the destructive-action confirmation is exactly what
   * the browser native dialog is good at. The guild name is included
   * in the message so a misclick on the wrong row is harder to miss.
   */
  async function deleteGuild(g: AdminGuild) {
    const ok = window.confirm(
      `Permanently delete server "${g.name}" (${g.memberCount} member${g.memberCount === 1 ? '' : 's'})?\n\n` +
        `Members will be disconnected and the server will disappear from their app immediately. ` +
        `This is a soft delete — message history and files stay on disk for forensic recovery, ` +
        `but the server is no longer reachable through the app.`,
    );
    if (!ok) return;
    setPending(g.id);
    try {
      await rest.adminDeleteGuild(g.id);
      toasts.push(`Deleted ${g.name}`, 'success');
      setGuilds((prev) => prev?.filter((x) => x.id !== g.id) ?? null);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3 max-w-5xl">
      <AdminTabHeader
        icon={Hash}
        title="Servers"
        subtitle="Browse every guild on this instance and observe one in read-only mode."
      />
      <div className="relative">
        <SearchIcon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by server name"
          className="w-full bg-bg-2 border border-line rounded-md pl-8 pr-3 py-1.5 text-sm text-ink-1 placeholder:text-ink-3 focus:outline-none focus:border-accent"
        />
      </div>

      {!guilds ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : guilds.length === 0 ? (
        <p className="text-sm text-ink-3 py-8 text-center">No servers match.</p>
      ) : (
        <ul className="space-y-1">
          {guilds.map((g) => {
            const tone = avatarColor(g.id);
            return (
              <li
                key={g.id}
                className="flex flex-col sm:flex-row sm:items-center gap-3 px-3 py-3 sm:py-2 rounded-md bg-bg-2 border border-line"
              >
                {/* Top row on mobile (icon + name + meta), or
                    leading column on desktop. */}
                <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                  {g.iconUrl ? (
                    <img src={g.iconUrl} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                  ) : (
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${tone}`}>
                      {avatarInitials(g.name)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium text-ink-1 truncate">{g.name}</span>
                      {g.discoverable && (
                        <span className="text-[0.6rem] uppercase font-bold tracking-wider bg-emerald-500/20 text-emerald-400 px-1 py-0.5 rounded">
                          discoverable
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">
                      {g.memberCount.toLocaleString()} member{g.memberCount === 1 ? '' : 's'} · created{' '}
                      {new Date(g.createdAt).toLocaleDateString()}
                    </div>
                    {/* Guild ID under the meta line on mobile — was
                        previously next to the action buttons where it
                        ate space the name needed. Hidden on desktop
                        since it lives at the start of the action row
                        (left of Observe) there. */}
                    <div className="sm:hidden text-[0.65rem] text-ink-3 font-mono mt-1 truncate">
                      Server ID: {g.id}
                    </div>
                  </div>
                </div>
                {/* Action row on mobile (full width below the meta),
                    or trailing column on desktop. */}
                <div className="flex items-center gap-1 shrink-0 sm:gap-2 sm:ml-auto">
                  <span className="hidden sm:inline mr-2 text-xs text-ink-3 font-mono">Server ID: {g.id}</span>
                  <button
                    onClick={() => onObserve(g.id, g.name)}
                    disabled={pending === g.id}
                    className="text-xs px-2 py-1 rounded bg-bg-3 hover:bg-accent/20 text-ink-2 hover:text-accent disabled:opacity-50 transition-colors"
                    title="Observe this server (read-only, undetected)"
                  >
                    Observe
                  </button>
                  <button
                    onClick={() => deleteGuild(g)}
                    disabled={pending === g.id}
                    className="text-xs px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-400 disabled:opacity-50 transition-colors"
                    title="Permanently delete this server"
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Storage tab ───────────────────────────────────────────────────────────

function StorageTab() {
  const { rest } = useAuth();
  const [storage, setStorage] = useState<AdminStorage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rest
      .adminStorage()
      .then((r) => {
        if (cancelled) return;
        setStorage(r.storage);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Failed to load storage');
      });
    return () => {
      cancelled = true;
    };
  }, [rest]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!storage) return <p className="text-sm text-ink-3">Loading…</p>;

  return (
    <div className="space-y-4 max-w-3xl">
      <AdminTabHeader
        icon={Archive}
        title="Storage"
        subtitle="Attachment and avatar usage, with a file-level breakdown."
      />
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard
          label="On-disk usage"
          value={formatBytes(storage.onDisk.totalBytes)}
          subtle={`${storage.onDisk.totalCount.toLocaleString()} file${storage.onDisk.totalCount === 1 ? '' : 's'} stored`}
        />
        <StatCard
          label="Reclaimable"
          value={formatBytes(storage.onDisk.unusedBytes)}
          subtle={`${storage.onDisk.unusedCount.toLocaleString()} unused file${storage.onDisk.unusedCount === 1 ? '' : 's'}`}
        />
        <StatCard label="Avatars" value={storage.avatars.count.toLocaleString()} subtle="users with custom avatars" />
        <StatCard label="Banners" value={storage.banners.count.toLocaleString()} subtle="users with custom banners" />
        <StatCard label="Custom emojis" value={storage.emojis.count.toLocaleString()} subtle="across all servers" />
        <StatCard label="Stickers" value={storage.stickers.count.toLocaleString()} subtle="across all servers" />
      </section>
      <p className="text-xs text-ink-3 leading-relaxed">
        On-disk usage and the reclaimable figure are read from the actual files
        each time this page loads. Avatar / banner / emoji / sticker sizes aren't
        tracked in the database — counts only. The list below reads real on-disk
        sizes and flags anything no longer referenced so you can reclaim it.
      </p>

      <StorageItemsManager />
    </div>
  );
}

// ── Per-file storage manager ──────────────────────────────────────────────
//
// Lists every on-disk attachment with its size and whether it's still
// referenced. Lets the operator delete individual files and clear all
// unused ones in one sweep.

const CAT_LABELS: Record<StorageCategory, string> = {
  attachment: 'Attachments',
  avatar: 'Avatars',
  banner: 'Banners',
  emoji: 'Emoji',
  sticker: 'Stickers',
  other: 'Other',
  unused: 'Unused',
};
const CAT_ORDER: Array<StorageCategory | 'all'> = [
  'all', 'attachment', 'avatar', 'banner', 'emoji', 'sticker', 'other', 'unused',
];
const IMG_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'];
const VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];
const AUDIO_FORMATS = ['mp3', 'ogg', 'wav', 'm4a', 'flac', 'aac', 'opus'];

function StorageItemsManager() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [category, setCategory] = useState<StorageCategory | 'all'>('all');
  const [sort, setSort] = useState<'size' | 'recent'>('size');
  const [guildId, setGuildId] = useState<string>(''); // '' = all servers
  const [guilds, setGuilds] = useState<{ id: string; name: string }[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [listing, setListing] = useState<StorageListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [sweeping, setSweeping] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Debounce the filter input so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // Load the server list once for the "filter by server" dropdown.
  useEffect(() => {
    let cancelled = false;
    rest
      .adminListGuilds({ limit: 200 })
      .then((r) => {
        if (!cancelled) {
          setGuilds(
            r.guilds
              .map((g) => ({ id: g.id, name: g.name }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [rest]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rest
      .adminStorageItems({ page, category, sort, q: q || undefined, guildId: guildId || undefined })
      .then((r) => {
        if (!cancelled) {
          setListing(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Failed to load files');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, category, sort, q, guildId, nonce, rest]);

  async function remove(item: StorageItem) {
    const label = item.filename ? `"${item.filename}"` : `item ${item.id}`;
    const warn = item.referenced
      ? `\n\nThis file is STILL IN USE — deleting it will break wherever it's shown.`
      : '';
    if (!window.confirm(`Delete ${label} from disk?${warn}`)) return;
    setBusy((s) => new Set(s).add(item.id));
    try {
      await rest.adminDeleteStorageItem(item.id);
      toasts.push('File deleted', 'success');
      setNonce((n) => n + 1);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(item.id);
        return n;
      });
    }
  }

  async function compress(item: StorageItem) {
    setBusy((s) => new Set(s).add(item.id));
    try {
      const r = await rest.adminCompressStorageItem(item.id);
      if (r.changed) {
        const saved = r.beforeBytes - r.afterBytes;
        toasts.push(
          `Compressed — saved ${formatBytes(saved)} (${formatBytes(r.beforeBytes)} → ${formatBytes(r.afterBytes)})`,
          'success',
        );
        setNonce((n) => n + 1);
      } else {
        toasts.push('Already as small as it gets — no change', 'info');
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Compression failed', 'error');
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(item.id);
        return n;
      });
    }
  }

  async function cleanUnused() {
    if (!listing || listing.unusedCount === 0) return;
    if (
      !window.confirm(
        `Delete all ${listing.unusedCount} unused file${listing.unusedCount === 1 ? '' : 's'} (${formatBytes(listing.unusedBytes)})? Only files older than the 1-hour grace window are removed.`,
      )
    )
      return;
    setSweeping(true);
    try {
      const r = await rest.adminStorageGc();
      toasts.push(`Removed ${r.deleted} unused file${r.deleted === 1 ? '' : 's'}`, 'success');
      setPage(1);
      setNonce((n) => n + 1);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Cleanup failed', 'error');
    } finally {
      setSweeping(false);
    }
  }

  const totalPages = listing ? Math.max(1, Math.ceil(listing.total / listing.pageSize)) : 1;

  return (
    <section className="space-y-3">
      {/* Category tabs */}
      <div className="flex flex-wrap gap-1.5">
        {CAT_ORDER.map((c) => {
          const count =
            c === 'all'
              ? listing?.totalCount
              : listing?.categoryCounts[c as StorageCategory];
          const active = category === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => {
                setCategory(c);
                setPage(1);
              }}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                active
                  ? 'bg-accent/15 border-accent/40 text-ink-1'
                  : 'bg-bg-2 border-line text-ink-2 hover:bg-bg-3'
              }`}
            >
              {c === 'all' ? 'All' : CAT_LABELS[c as StorageCategory]}
              {typeof count === 'number' && (
                <span className="ml-1 text-ink-3">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Toolbar: totals + sort + cleanup */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-ink-2">
          {listing ? (
            <>
              <span className="font-semibold text-ink-1">{listing.total.toLocaleString()}</span>{' '}
              shown ·{' '}
              {guildId
                ? `${formatBytes(listing.filteredBytes)} in this server`
                : `${formatBytes(listing.totalBytes)} total`}
              {!guildId && listing.unusedCount > 0 && (
                <span className="text-ink-3">
                  {' '}· <span className="text-amber-400">{listing.unusedCount} unused</span> (
                  {formatBytes(listing.unusedBytes)})
                </span>
              )}
            </>
          ) : (
            'Loading…'
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-ink-3">Server</label>
          <select
            value={guildId}
            onChange={(e) => {
              setGuildId(e.target.value);
              setPage(1);
            }}
            className="text-xs bg-bg-2 border border-line rounded-md px-2 py-1 text-ink-1 max-w-[12rem]"
          >
            <option value="">All servers</option>
            {guilds.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Filter by filename…"
            className="text-xs bg-bg-2 border border-line rounded-md px-2 py-1 text-ink-1 placeholder:text-ink-3 w-44"
          />
          <label className="text-xs text-ink-3">Sort</label>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as 'size' | 'recent');
              setPage(1);
            }}
            className="text-xs bg-bg-2 border border-line rounded-md px-2 py-1 text-ink-1"
          >
            <option value="size">Largest</option>
            <option value="recent">Last modified</option>
          </select>
          <button
            type="button"
            onClick={() => void cleanUnused()}
            disabled={sweeping || !listing || listing.unusedCount === 0}
            className="text-xs px-3 py-1.5 rounded-md border border-line bg-bg-2 text-ink-1 hover:bg-bg-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sweeping ? 'Cleaning…' : 'Clean up unused'}
          </button>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : !listing ? (
        <p className="text-sm text-ink-3">Loading files…</p>
      ) : listing.items.length === 0 ? (
        <p className="text-sm text-ink-3">No files in this category.</p>
      ) : (
        <ul
          className={`rounded-md border border-line divide-y divide-line overflow-hidden ${loading ? 'opacity-60' : ''}`}
        >
          {listing.items.map((item) => {
            const viewUrl = item.filename
              ? `/cdn/${item.id}/${encodeURIComponent(item.filename)}`
              : null;
            return (
              <li
                key={item.id}
                className="px-3 py-2 bg-bg-2/40 text-sm"
              >
                <div
                  onClick={
                    viewUrl
                      ? () => setExpandedId((cur) => (cur === item.id ? null : item.id))
                      : undefined
                  }
                  title={
                    viewUrl
                      ? expandedId === item.id
                        ? 'Click to collapse'
                        : 'Click to preview'
                      : undefined
                  }
                  className={viewUrl ? 'cursor-pointer' : ''}
                >
                  <div className="flex items-center gap-2">
                  <span
                    className="flex-1 min-w-0 truncate text-ink-1"
                    title={item.filename ?? item.id}
                  >
                    {item.filename ?? <span className="text-ink-3">(unnamed)</span>}
                  </span>
                  {item.compressed === false && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void compress(item);
                      }}
                      disabled={busy.has(item.id)}
                      className="shrink-0 text-xs px-2 py-1 rounded border border-line text-ink-2 hover:bg-bg-3 hover:text-ink-1 disabled:opacity-40"
                      title="Re-compress this image on the server to reclaim space"
                    >
                      {busy.has(item.id) ? '…' : 'Compress'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(item);
                    }}
                    disabled={busy.has(item.id)}
                    className="shrink-0 text-xs px-2 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                  >
                    {busy.has(item.id) ? '…' : 'Delete'}
                  </button>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                  <span
                    className={`px-1.5 py-0.5 rounded ${item.referenced ? 'bg-bg-3 text-ink-3' : 'bg-amber-500/15 text-amber-400'}`}
                  >
                    {CAT_LABELS[item.category]}
                  </span>
                  {item.referenced && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                      In use
                    </span>
                  )}
                  {item.format && <span className="uppercase">{item.format}</span>}
                  <span className="tabular-nums text-ink-2">{formatBytes(item.sizeBytes)}</span>
                  <span
                    className="tabular-nums"
                    title={new Date(item.mtimeMs).toLocaleString()}
                  >
                    {relativeTime(new Date(item.mtimeMs).toISOString())}
                  </span>
                </div>
                </div>
                {viewUrl && expandedId === item.id && (
                  <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                    {IMG_FORMATS.includes(item.format ?? '') ? (
                      <img
                        src={viewUrl}
                        alt={item.filename ?? ''}
                        loading="lazy"
                        className="max-h-80 max-w-full rounded-lg border border-line object-contain bg-bg-0"
                      />
                    ) : VIDEO_FORMATS.includes(item.format ?? '') ? (
                      <video
                        src={viewUrl}
                        controls
                        className="max-h-80 max-w-full rounded-lg border border-line bg-black"
                      />
                    ) : AUDIO_FORMATS.includes(item.format ?? '') ? (
                      <audio src={viewUrl} controls className="w-full" />
                    ) : (
                      <div className="text-xs text-ink-3">
                        No inline preview for {item.format ? `.${item.format}` : 'this file type'}.
                      </div>
                    )}
                    <div className="mt-1">
                      <a
                        href={viewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-ink-3 hover:text-accent"
                      >
                        Open original ↗
                      </a>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Pagination */}
      {listing && listing.total > listing.pageSize && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="px-2.5 py-1 rounded-md border border-line bg-bg-2 text-ink-1 hover:bg-bg-3 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-ink-3">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="px-2.5 py-1 rounded-md border border-line bg-bg-2 text-ink-1 hover:bg-bg-3 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return `${(n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ── Observe view (ghost mode) ─────────────────────────────────────────────
//
// Read-only inspection of any guild's channels and message history. The
// admin doesn't appear in the member list, doesn't send a join event,
// doesn't show up in typing indicators or voice-state lists. From the
// guild's perspective, this fetch is invisible.
//
// Layout: two-pane inside the admin main area. Left column is the
// channel list for the observed guild; right column is the message
// list for whichever channel the operator picked. The banner at the
// top is deliberately conspicuous — the operator should always know
// they're in observe mode and not accidentally typing in a real chat.

function ObserveView({
  guildId,
  guildName,
  onClose,
}: {
  guildId: string;
  guildName: string;
  onClose: () => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [guild, setGuild] = useState<AdminPeekGuild | null>(null);
  const [channels, setChannels] = useState<AdminPeekChannel[] | null>(null);
  const [selected, setSelected] = useState<AdminPeekChannel | null>(null);
  const [messages, setMessages] = useState<AdminPeekMessage[] | null>(null);
  const [isVoiceChannel, setIsVoiceChannel] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Fetch the guild + channel list when entering observe mode (or when
  // the operator picks a different guild). Auto-select the first text
  // channel by default — the operator usually wants to start reading
  // immediately, and the first channel is conventionally the lobby.
  useEffect(() => {
    let cancelled = false;
    setGuild(null);
    setChannels(null);
    setSelected(null);
    setMessages(null);
    void rest
      .adminPeekGuild(guildId)
      .then((r) => {
        if (cancelled) return;
        setGuild(r.guild);
        setChannels(r.channels);
        // Pick the first text-ish channel for the default selection.
        // Text channels are conventionally the entry point; falling back
        // to whichever is first if no text channels exist.
        const firstText = r.channels.find((ch) => ch.type === 'guild_text') ?? r.channels[0];
        if (firstText) setSelected(firstText);
      })
      .catch((e) => {
        if (cancelled) return;
        toasts.push(e instanceof ApiError ? e.message : 'Failed to load server', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [rest, guildId, toasts]);

  // Fetch message backlog when the selected channel changes.
  useEffect(() => {
    if (!selected) {
      setMessages(null);
      setIsVoiceChannel(false);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    setMessages(null);
    void rest
      .adminPeekChannelMessages(selected.id, { limit: 50 })
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        setIsVoiceChannel(r.voiceChannel);
      })
      .catch((e) => {
        if (cancelled) return;
        toasts.push(e instanceof ApiError ? e.message : 'Failed to load messages', 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rest, selected, toasts]);

  return (
    <div className="h-full flex flex-col">
      {/* Conspicuous banner — make sure the operator never forgets
          they're in observe mode. The amber tone differentiates it
          from regular admin chrome (accent purple) and the
          informational copy spells out the invariants explicitly. */}
      <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 sm:px-8 py-2 flex items-center gap-3 shrink-0">
        <Shield size={16} className="text-amber-400 shrink-0" />
        <div className="text-sm text-amber-200 flex-1 min-w-0">
          <span className="font-semibold">Observing</span>
          <span className="text-amber-200/70"> · members don't see you · read-only · voice excluded</span>
        </div>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 transition-colors flex items-center gap-1"
          title="Stop observing"
        >
          <CloseIcon size={12} />
          Stop
        </button>
      </div>

      {/* Header: which guild, member count. Sits below the banner so
          the "observing" status reads first. */}
      <header className="border-b border-line bg-bg-2 px-4 sm:px-8 py-3 flex items-center gap-3 shrink-0">
        {guild?.iconUrl ? (
          <img src={guild.iconUrl} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-bg-3 flex items-center justify-center text-xs font-bold shrink-0">
            {avatarInitials(guildName)}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink-1 truncate">{guildName}</div>
          {guild && (
            <div className="text-xs text-ink-3 truncate">
              {guild.memberCount.toLocaleString()} member{guild.memberCount === 1 ? '' : 's'} ·{' '}
              created {new Date(guild.createdAt).toLocaleDateString()}
            </div>
          )}
        </div>
      </header>

      {/* Two-pane body. Channel list narrow on the left, message
          list takes the rest. Stack vertically on narrow widths so
          mobile observation is at least usable; on the cramped phone
          layout the operator scrolls past the channel list to reach
          the messages. */}
      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        <aside className="sm:w-60 shrink-0 border-r border-line bg-bg-2 overflow-y-auto scrollbar-thin">
          <ObserveChannelList
            channels={channels}
            selectedId={selected?.id ?? null}
            onSelect={(ch) => setSelected(ch)}
          />
        </aside>
        <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin bg-bg-1">
          <ObserveMessageList
            channel={selected}
            messages={messages}
            isVoiceChannel={isVoiceChannel}
            loading={loadingMessages}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Channel list panel for ObserveView. Groups by category (parentId)
 * to match the regular guild ChannelList shape. Categories don't have
 * messages themselves so clicking them does nothing — the click target
 * is each individual channel.
 */
function ObserveChannelList({
  channels,
  selectedId,
  onSelect,
}: {
  channels: AdminPeekChannel[] | null;
  selectedId: string | null;
  onSelect: (ch: AdminPeekChannel) => void;
}) {
  if (!channels) return <p className="px-3 py-4 text-sm text-ink-3">Loading channels…</p>;
  if (channels.length === 0)
    return <p className="px-3 py-4 text-sm text-ink-3">No channels.</p>;

  const categories = channels.filter((c) => c.type === 'guild_category');
  const orphans = channels.filter(
    (c) => c.type !== 'guild_category' && c.parentId === null,
  );
  const byParent = new Map<string, AdminPeekChannel[]>();
  for (const c of channels) {
    if (c.type === 'guild_category') continue;
    if (c.parentId === null) continue;
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }

  return (
    <div className="py-2">
      {orphans.length > 0 && (
        <div className="mb-2">
          {orphans.map((c) => (
            <ChannelLink
              key={c.id}
              channel={c}
              active={c.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {categories.map((cat) => {
        const inside = byParent.get(cat.id) ?? [];
        if (inside.length === 0) return null;
        return (
          <div key={cat.id} className="mb-2">
            <div className="px-3 pt-2 pb-1 text-[0.65rem] font-bold uppercase tracking-wider text-ink-3">
              {cat.name}
            </div>
            {inside.map((c) => (
              <ChannelLink
                key={c.id}
                channel={c}
                active={c.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ChannelLink({
  channel,
  active,
  onSelect,
}: {
  channel: AdminPeekChannel;
  active: boolean;
  onSelect: (ch: AdminPeekChannel) => void;
}) {
  const isVoice = channel.type === 'guild_voice' || channel.type === 'guild_stage';
  // Visual hint: voice channels get a speaker icon and a tooltip
  // explaining they can't be observed. The operator can still click
  // (we'll show the "voice channel" empty state) but the icon
  // signals "don't bother."
  const Icon = isVoice ? Volume2 : channel.nsfw ? Lock : Hash;
  return (
    <button
      type="button"
      onClick={() => onSelect(channel)}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
        active ? 'bg-bg-3 text-ink-1' : 'text-ink-2 hover:bg-bg-3 hover:text-ink-1'
      }`}
      title={isVoice ? 'Voice channels can\'t be listened to in observe mode' : undefined}
    >
      <Icon size={14} className={isVoice ? 'text-ink-3' : 'text-ink-3'} />
      <span className="truncate">{channel.name}</span>
    </button>
  );
}

/**
 * Message list pane for ObserveView. Renders slim DTOs — no
 * mentions/polls/forwards/stickers, just author + content +
 * attachment thumbnails + reaction tallies. The presentation is
 * deliberately not pixel-identical to the real MessageView so the
 * operator can never mistake observe mode for normal chat.
 */
function ObserveMessageList({
  channel,
  messages,
  isVoiceChannel,
  loading,
}: {
  channel: AdminPeekChannel | null;
  messages: AdminPeekMessage[] | null;
  isVoiceChannel: boolean;
  loading: boolean;
}) {
  if (!channel) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-sm text-ink-3 text-center">
        Pick a channel to observe.
      </div>
    );
  }
  if (isVoiceChannel) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center max-w-md mx-auto">
        <div className="space-y-2">
          <Volume2 size={32} className="mx-auto text-ink-3" />
          <p className="text-sm text-ink-2 font-medium">Voice channel</p>
          <p className="text-xs text-ink-3 leading-relaxed">
            Voice and stage channels can't be listened to in observe mode —
            LiveKit lists participants to everyone in the room, so there's no way
            to be undetected. You can still see who's currently in the channel from
            the Users tab if needed.
          </p>
        </div>
      </div>
    );
  }
  if (loading || !messages) {
    return (
      <div className="px-6 py-4 text-sm text-ink-3">Loading messages…</div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="px-6 py-4 text-sm text-ink-3">No messages in this channel yet.</div>
    );
  }

  return (
    <div>
      <div className="px-6 pt-4 pb-2 border-b border-line">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink-1">
          <Hash size={14} className="text-ink-3" />
          <span>{channel.name}</span>
        </div>
        {channel.topic && (
          <p className="text-xs text-ink-3 mt-1">{channel.topic}</p>
        )}
      </div>
      <ul className="px-4 py-3 space-y-3">
        {messages.map((m) => (
          <ObserveMessage key={m.id} message={m} />
        ))}
      </ul>
    </div>
  );
}

function ObserveMessage({ message: m }: { message: AdminPeekMessage }) {
  const displayName = m.authorDisplayName ?? m.authorUsername ?? 'Unknown';
  const tone = avatarColor(m.authorId ?? m.id);
  const initials = avatarInitials(displayName);
  return (
    <li className="flex gap-3 px-2 py-1.5 rounded-md hover:bg-bg-2 transition-colors">
      <div className={`relative w-8 h-8 rounded-full overflow-hidden shrink-0 ${tone} text-xs font-bold flex items-center justify-center`}>
        <span>{initials}</span>
        <AvatarImage src={m.authorAvatarUrl} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-ink-1 truncate">{displayName}</span>
          {m.authorUsername && m.authorUsername !== displayName && (
            <span className="text-xs text-ink-3">@{m.authorUsername}</span>
          )}
          <span className="text-xs text-ink-3">
            {new Date(m.createdAt).toLocaleString()}
          </span>
          {m.editedAt && (
            <span className="text-xs text-ink-3 italic">edited</span>
          )}
          {m.hasReply && (
            <span className="text-[0.65rem] uppercase tracking-wider text-ink-3 bg-bg-3 px-1 rounded">
              reply
            </span>
          )}
          {m.hasForward && (
            <span className="text-[0.65rem] uppercase tracking-wider text-ink-3 bg-bg-3 px-1 rounded">
              forward
            </span>
          )}
          {m.hasSticker && (
            <span className="text-[0.65rem] uppercase tracking-wider text-ink-3 bg-bg-3 px-1 rounded">
              sticker
            </span>
          )}
        </div>
        {m.content && (
          <p className="text-sm text-ink-2 whitespace-pre-wrap break-words mt-0.5">
            {m.content}
          </p>
        )}
        {m.attachments.length > 0 && (
          <ul className="mt-1 space-y-1">
            {m.attachments.map((a) => {
              const isImage = a.contentType.startsWith('image/');
              return (
                <li key={a.id}>
                  {isImage ? (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block max-w-xs"
                    >
                      <img
                        src={a.url}
                        alt={a.filename}
                        className="max-h-48 max-w-full rounded border border-line"
                        loading="lazy"
                      />
                    </a>
                  ) : (
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-accent hover:underline"
                    >
                      📎 {a.filename} ({formatBytes(a.size)})
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r) => (
              <span
                key={r.emoji}
                className="text-xs px-1.5 py-0.5 rounded bg-bg-3 text-ink-2"
              >
                {r.emoji} {r.count}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

// ── Backup tab (instance-level config backup / restore) ─────────────────────
//
// Instance-admin tool: download a single JSON bundling every guild's config
// backup (settings/roles/channels/overrides + optional branding), and restore
// a bundle by rebuilding each guild as a NEW guild owned by the admin. This is
// a CONFIGURATION backup, not a data dump — users/messages live in pg_dump.

function BackupAdminTab() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [includeImages, setIncludeImages] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [results, setResults] = useState<InstanceRestoreResult[] | null>(null);

  async function download() {
    if (exporting) return;
    setExporting(true);
    try {
      const { backup } = await rest.adminExportBackup(includeImages);
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zekktris-instance-backup-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toasts.push(
        backup.truncated
          ? `Downloaded ${backup.guildCount} guilds (capped — older guilds omitted)`
          : `Downloaded backup of ${backup.guildCount} guild${backup.guildCount === 1 ? '' : 's'}`,
        backup.truncated ? 'info' : 'success',
      );
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Backup failed', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || restoring) return;
    setRestoring(true);
    setResults(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('That file isn’t valid JSON');
      }
      const { created } = await rest.adminRestoreBackup(parsed);
      setResults(created);
      const okCount = created.filter((r) => r.ok).length;
      toasts.push(
        `Restored ${okCount}/${created.length} guild${created.length === 1 ? '' : 's'} as new servers`,
        okCount === created.length ? 'success' : 'info',
      );
    } catch (err) {
      toasts.push(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Restore failed', 'error');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <AdminTabHeader
        icon={Archive}
        title="Backup & Restore"
        subtitle="Download every server's configuration as one file, or rebuild servers from a backup."
      />

      <section className="border border-line rounded-md p-4 space-y-3">
        <h3 className="text-sm font-semibold text-ink-1">Download instance backup</h3>
        <p className="text-xs text-ink-3 leading-relaxed">
          Bundles each server's settings, roles, channel structure, and permission overrides into one
          JSON file. This is a <strong>configuration</strong> backup — it does not include users,
          memberships, or messages (back those up with a Postgres <code>pg_dump</code>).
        </p>
        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={includeImages}
            onChange={(e) => setIncludeImages(e.target.checked)}
          />
          Include server icons &amp; banners (larger file)
        </label>
        <button
          onClick={() => void download()}
          disabled={exporting}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-bg-2 text-ink-1 border border-line hover:border-accent transition-colors disabled:opacity-50"
        >
          {exporting ? 'Preparing…' : 'Download backup'}
        </button>
      </section>

      <section className="border border-line rounded-md p-4 space-y-3">
        <h3 className="text-sm font-semibold text-ink-1">Restore from backup</h3>
        <p className="text-xs text-ink-3 leading-relaxed">
          Rebuilds every server in the file as a <strong>new</strong> server owned by you — existing
          servers are never modified. Useful for migrating to a fresh instance or recovering deleted
          server structures.
        </p>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} className="hidden" />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={restoring}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-bg-2 text-ink-1 border border-line hover:border-accent transition-colors disabled:opacity-50"
        >
          {restoring ? 'Restoring…' : 'Choose backup file…'}
        </button>

        {results && (
          <ul className="space-y-1 pt-1">
            {results.map((r, i) => (
              <li key={`${r.sourceGuildId}-${i}`} className="flex items-start gap-2 text-xs">
                <span
                  className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-full flex items-center justify-center text-[0.6rem] font-bold ${
                    r.ok ? 'bg-green-500/25 text-green-300' : 'bg-red-500/25 text-red-300'
                  }`}
                >
                  {r.ok ? '✓' : '✕'}
                </span>
                <span className="min-w-0">
                  <span className="text-ink-1 font-medium">{r.name}</span>
                  <span className="text-ink-3"> — {r.ok ? 'restored' : r.error ?? 'failed'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
