/**
 * DiscoveryView
 * -------------
 * Public guild directory with a two-pane layout:
 *
 *   - Left rail: category filter (All + the canonical categories).
 *     Clicking a category narrows the listing.
 *   - Right pane: search header + grid of guild cards. Cards show
 *     the icon, name, category, description, member count, and a
 *     Join (or Joined) button.
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
        <h1 className="text-base sm:text-lg font-semibold truncate">Discover Servers</h1>
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
              placeholder="Search communities..."
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

          {/* Category pills — wrap into 2-3 rows so all ten fit on
              every viewport without horizontal scrolling. The
              previous design used a left vertical sidebar on
              desktop and a single horizontal scroller on mobile;
              that was inconsistent across devices and the mobile
              scroller hid most of the categories until the user
              swiped. Wrapping pills give every category equal
              visibility at every viewport. */}
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => {
              const selected = c === activeCategory;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setActiveCategory(c)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                    selected
                      ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_12px_var(--accent-glow)]'
                      : 'bg-bg-2 text-ink-2 hover:bg-bg-3 hover:text-ink-1 hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>

          {/* Subtitle / result count — small, sits between the
              category pills and the cards grid. */}
          <p className="text-xs text-ink-3">
            {total > 0
              ? `${total} ${total === 1 ? 'server' : 'servers'} you can join${
                  activeCategory !== ALL_CATEGORY ? ` in ${activeCategory}` : ''
                }.`
              : 'Find communities to join.'}
          </p>

          {/* Cards grid */}
          {guilds === null ? (
            <p className="text-sm text-ink-3 italic mt-4">Loading…</p>
          ) : guilds.length === 0 ? (
            <p className="text-sm text-ink-3 mt-4">
              {debouncedQuery
                ? `No servers match "${debouncedQuery}".`
                : activeCategory !== ALL_CATEGORY
                  ? `No servers in ${activeCategory} yet.`
                  : 'No discoverable servers yet. Encourage server owners to opt-in via Server Settings → Discovery.'}
            </p>
          ) : (
            /* Card grid. minmax(280px, 1fr) with auto-fill wraps
               into rows of 2-3 cards on wide displays and collapses
               to a single column when the container is narrower
               than 280px+gap. Inline style rather than a Tailwind
               arbitrary class to avoid the cascade order trap where
               `grid-cols-1` defined elsewhere in the stylesheet
               could win against an arbitrary `[grid-template-
               columns:...]` and force a single fixed column. */
            <ul
              className="grid gap-4 mt-2"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
            >
              {guilds.map((g) => (
                <GuildCard
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

function GuildCard({
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
  // "Other" is the fallback display for servers without a category.
  const category = guild.discoveryCategory ?? 'Other';

  return (
    <li
      className="bg-bg-2/70 backdrop-blur-sm border rounded-lg p-4 flex flex-col transition-all hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]"
      style={{ borderColor: 'var(--zk-line)' }}
    >
      {/* Icon + name row */}
      <div className="flex items-center gap-3 mb-2">
        {guild.iconUrl ? (
          <img
            src={guild.iconUrl}
            alt=""
            className="w-12 h-12 rounded-lg object-cover shrink-0"
            draggable={false}
          />
        ) : (
          <div
            className={`w-12 h-12 rounded-lg flex items-center justify-center text-base font-semibold shrink-0 ${tone}`}
          >
            {initials}
          </div>
        )}
        <span className="font-semibold text-ink-1 truncate text-base">
          {guild.name}
        </span>
      </div>

      {/* Category badge */}
      <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
        {category}
      </div>

      {/* Description. Card height grows with content; line-clamp-4
          caps multi-paragraph pitches at four lines so the cards
          stay roughly the same height across the grid. */}
      <p className="text-sm text-ink-2 line-clamp-4 break-words flex-1 leading-relaxed">
        {blurb || 'No description provided.'}
      </p>

      {/* Member count. Coerce to Number defensively — if the API
          ever returns a stringified bigint here, the strict `=== 1`
          equality below would fail and we'd render "1 Members" for
          a single-member guild. Wrapping in Number() means strings
          like "1" still compare correctly. */}
      <div className="flex items-center gap-2 mt-4 text-xs text-ink-3 tabular-nums">
        {(() => {
          const count = Number(guild.memberCount);
          return (
            <>
              <span className="w-2 h-2 rounded-full bg-ink-3/40" />
              <span>
                {count.toLocaleString()}{' '}
                {count === 1 ? 'Member' : 'Members'}
              </span>
            </>
          );
        })()}
      </div>

      {/* Full-width Join (or Joined) button at the bottom */}
      <button
        type="button"
        onClick={onJoin}
        disabled={pending || isMember}
        className={`mt-3 w-full px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          isMember
            ? 'bg-emerald-600/15 text-emerald-300 border border-emerald-600/40 cursor-not-allowed'
            : 'bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed'
        }`}
      >
        {isMember ? '✓ Joined' : pending ? 'Joining…' : 'Join Community'}
      </button>
    </li>
  );
}
