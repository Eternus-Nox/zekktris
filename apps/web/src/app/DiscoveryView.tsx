/**
 * DiscoveryView
 * -------------
 * Public guild directory, laid out to match the iOS DiscoveryView:
 *
 *   - Search field, then a single horizontal-scroll row of category
 *     chips (All + the canonical categories). Selecting a chip
 *     narrows the listing.
 *   - Below that, a single-column list of guild rows: icon on the
 *     left, name / description / member count in the middle, and a
 *     trailing Join (or Joined) pill.
 *
 * Joining: clicking the button calls the public-join endpoint, which
 * adds the user as a member with no invite code required. We then
 * navigate to the guild's first text channel (returned by the join
 * response) so the user lands on something useful.
 *
 * Error handling: 403 (banned) gets surfaced as a toast; 404 (guild
 * disappeared mid-browse) refreshes the list. Empty result is its
 * own UI state, not a confusing flash of "loading".
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  DISCOVERY_CATEGORIES,
  type DiscoverableGuild,
} from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Compass, Search, X, ChevronLeft } from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';

const ALL_CATEGORY = 'All';
type CategoryFilter = typeof ALL_CATEGORY | (typeof DISCOVERY_CATEGORIES)[number];

export function DiscoveryView() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const navigate = useNavigate();
  // Membership set drives the "Joined" pill on cards. AppState keeps
  // guildIds current via gateway events, so newly-joined servers
  // flip to "Joined" without a manual refresh.
  const { state } = useAppState();
  const memberOf = new Set(state.guildIds);

  const [guilds, setGuilds] = useState<DiscoverableGuild[] | null>(null);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>(ALL_CATEGORY);
  const [pending, setPending] = useState<Set<string>>(new Set());

  // Debounce so typing doesn't fire a request per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Fetch list whenever debounced query OR active category changes.
  // Previous list stays visible while reloading (no flash to a
  // skeleton) unless we have nothing yet.
  useEffect(() => {
    let cancelled = false;
    void rest
      .listDiscoverable({
        q: debouncedQuery || undefined,
        category: activeCategory === ALL_CATEGORY ? undefined : activeCategory,
      })
      .then((r) => {
        if (cancelled) return;
        setGuilds(r.guilds);
        setTotal(r.total);
      })
      .catch((e) => {
        if (cancelled) return;
        toasts.push(e instanceof ApiError ? e.message : 'Discovery failed', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, activeCategory, rest, toasts]);

  async function join(g: DiscoverableGuild) {
    if (pending.has(g.id)) return;
    setPending((prev) => new Set(prev).add(g.id));
    try {
      const r = await rest.joinDiscoverable(g.id);
      if (r.alreadyMember) {
        toasts.push(`You're already in ${g.name}`, 'info');
      } else {
        toasts.push(`Joined ${g.name}`, 'success');
      }
      if (r.channelId) {
        navigate(`/channels/${r.guildId}/${r.channelId}`);
      } else {
        navigate(`/channels/${r.guildId}`);
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not join server', 'error');
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(g.id);
        return next;
      });
    }
  }

  const categories: CategoryFilter[] = [ALL_CATEGORY, ...DISCOVERY_CATEGORIES];

  return (
    <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
      {/* Header strip — matches Mentions/Settings/Admin/CreateServer
          shape (h-12, same icon-on-left + title pattern). Keeps the
          top-of-content visual consistent across every rail surface. */}
      <header
        className="h-12 border-b bg-bg-2/85 backdrop-blur-sm px-3 sm:px-4 flex items-center gap-2 sm:gap-3 shrink-0"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <button
          onClick={() => navigate('/channels/@me')}
          className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={20} />
        </button>
        <Compass size={16} className="text-accent shrink-0" />
        <h1 className="text-base sm:text-lg font-semibold truncate">Discover</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="p-4 sm:p-6 space-y-4">
          {/* Search bar */}
          <label
            className="flex items-center gap-2 px-3 py-2 bg-bg-2/60 backdrop-blur-sm border rounded-md max-w-md transition-all focus-within:shadow-[0_0_0_1px_var(--accent-glow),0_0_12px_var(--accent-glow)]"
            style={{ borderColor: 'var(--zk-line)' }}
          >
            <Search size={14} className="text-ink-3 shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search servers"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-3"
            />
            {query.length > 0 && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-ink-3 hover:text-ink-1 shrink-0"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </label>

          {/* Category chips — a single horizontal-scroll row (matching
              iOS DiscoveryView). Active chip = solid accent fill with
              bg-0 text; inactive = bg-2. No gradient / glow. The
              negative margins let the row bleed to the container edges
              so chips scroll out under the padding rather than being
              clipped mid-chip at the padding boundary. */}
          <div className="flex gap-1.5 overflow-x-auto scrollbar-thin -mx-4 px-4 sm:-mx-6 sm:px-6 pb-1">
            {categories.map((c) => {
              const selected = c === activeCategory;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setActiveCategory(c)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    selected
                      ? 'bg-accent text-bg-0'
                      : 'bg-bg-2 text-ink-2 hover:bg-bg-3 hover:text-ink-1'
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>

          {/* Subtitle / result count — small, sits between the
              category chips and the server list. */}
          <p className="text-xs text-ink-3">
            {total > 0
              ? `${total} ${total === 1 ? 'server' : 'servers'} you can join${
                  activeCategory !== ALL_CATEGORY ? ` in ${activeCategory}` : ''
                }.`
              : 'Find communities to join.'}
          </p>

          {/* Server list */}
          {guilds === null ? (
            <p className="text-sm text-ink-3 italic mt-4">Loading…</p>
          ) : guilds.length === 0 ? (
            /* Empty state — centered icon + message, matching iOS.
               iOS uses an SF Symbol globe; the web icon set has no
               Globe, so Compass (this page's own glyph) stands in. */
            <div className="flex flex-col items-center justify-center text-center py-16 gap-3">
              <Compass size={40} className="text-ink-3" aria-hidden />
              <p className="text-sm text-ink-3 max-w-xs">
                {debouncedQuery
                  ? `No servers match "${debouncedQuery}".`
                  : activeCategory !== ALL_CATEGORY
                    ? `No servers in ${activeCategory} yet.`
                    : 'No public servers found'}
              </p>
            </div>
          ) : (
            /* Single-column list of horizontal rows (avatar left, text
               block center, trailing Join/Joined pill), matching iOS
               DiscoverRow. */
            <ul className="flex flex-col gap-2 mt-2">
              {guilds.map((g) => (
                <GuildRow
                  key={g.id}
                  guild={g}
                  pending={pending.has(g.id)}
                  isMember={memberOf.has(g.id)}
                  onJoin={() => void join(g)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function GuildRow({
  guild,
  pending,
  isMember,
  onJoin,
}: {
  guild: DiscoverableGuild;
  pending: boolean;
  isMember: boolean;
  onJoin: () => void;
}) {
  const tone = avatarColor(guild.id);
  const initials = avatarInitials(guild.name);
  const blurb = guild.discoveryDescription || guild.description;
  // Coerce to Number defensively — a stringified bigint would break the
  // strict `=== 1` singular/plural check below.
  const count = Number(guild.memberCount);

  return (
    <li
      className="bg-bg-2 border rounded-xl px-3 py-3 flex items-center gap-3 transition-all hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]"
      style={{ borderColor: 'var(--zk-line)' }}
    >
      {/* Avatar (44) */}
      {guild.iconUrl ? (
        <img
          src={guild.iconUrl}
          alt=""
          className="w-11 h-11 rounded-xl object-cover shrink-0"
          draggable={false}
        />
      ) : (
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center text-base font-semibold shrink-0 ${tone}`}
        >
          <span className="zk-avatar-initials">{initials}</span>
        </div>
      )}

      {/* Name / description / member count */}
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-ink-1 truncate text-sm">{guild.name}</div>
        <p className="text-xs text-ink-2 truncate">
          {blurb || 'No description provided.'}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-ink-3 tabular-nums">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span>
            {count.toLocaleString()} {count === 1 ? 'member' : 'members'}
          </span>
        </div>
      </div>

      {/* Trailing Join / Joined pill */}
      <button
        type="button"
        onClick={onJoin}
        disabled={pending || isMember}
        className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
          isMember
            ? 'bg-bg-3 text-ink-3 cursor-not-allowed'
            : 'bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed'
        }`}
      >
        {isMember ? 'Joined' : pending ? 'Joining…' : 'Join'}
      </button>
    </li>
  );
}
