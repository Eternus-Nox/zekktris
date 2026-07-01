/**
 * MemberList
 * ----------
 * Right column showing the active guild's members. Lazy-loaded the first
 * time we land on a guild; live-updates via GUILD_MEMBER_ADD/REMOVE events
 * (handled in AppState's reducer).
 *
 * Click a member to open a DM with them. The api's POST /users/@me/channels
 * is idempotent — re-clicking the same member just returns the existing
 * DM channel without creating a new one. New DMs also fire CHANNEL_CREATE
 * over the gateway, which the AppState reducer routes into the dmChannels
 * slice, so the second column populates immediately when the user lands
 * on /channels/@me/<id>.
 *
 * For v1 we don't show online/offline groups (presence isn't fully wired
 * yet) or roles (role colors / hoisted display would mean a roles
 * sub-loader and per-member top-role computation). It's a flat list with
 * avatar + name + display-name, sorted by display name.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { UserTag } from '../lib/UserTag';
import { useAppStateSelector } from '../state/AppState';
import { useAuth } from '../auth/AuthContext';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { AvatarDecoration } from '../lib/avatarDecorations';
import { memberDisplayColor } from '../lib/permissions';
import { useProfileCard } from '../lib/useProfileCard';
import { X as CloseIcon, Clock } from '../lib/icons';
import type { GuildMember, PublicUser, Role } from '@zekktris/client';

export function MemberList({
  guildId,
  onClose,
}: {
  guildId: string | undefined;
  /** When provided, render an inline close button in the header. Used
      by the mobile slide-out panel. On xl+ the panel is permanently
      docked, so onClose stays undefined and no button shows. */
  onClose?: () => void;
}) {
  // Granular subscriptions (was `useAppState()`, which re-rendered this
  // member list on EVERY dispatch). Select only the slices read below; the
  // local `state` object just keeps the existing `state.X` reads unchanged.
  const membersByGuild = useAppStateSelector((v) => v.state.membersByGuild);
  const rolesByGuild = useAppStateSelector((v) => v.state.rolesByGuild);
  const loadedMembers = useAppStateSelector((v) => v.state.loadedMembers);
  const loadMembers = useAppStateSelector((v) => v.loadMembers);
  const loadRoles = useAppStateSelector((v) => v.loadRoles);
  const state = { membersByGuild, rolesByGuild, loadedMembers };
  const { user } = useAuth();
  const { onAvatarClick, cardElement } = useProfileCard({ guildId });
  // virtua scroll plumbing — the scroll viewport is the existing
  // overflow-y-auto div; vref is reserved for future programmatic scrolls.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const vref = useRef<VirtualizerHandle>(null);
  const members = guildId ? state.membersByGuild[guildId] : undefined;
  const loaded = guildId ? state.loadedMembers.has(guildId) : false;
  // Roles drive the per-member display color (highest hoisted role
  // with a non-zero color paints the name). Loaded lazily on first
  // render of the member list and cached forever after — role
  // changes are infrequent and the role-edit UI dispatches its own
  // ROLES_SET on save.
  const guildRoles = guildId ? state.rolesByGuild[guildId] : undefined;

  useEffect(() => {
    if (!guildId || loaded) return;
    void loadMembers(guildId).catch(() => undefined);
  }, [guildId, loaded, loadMembers]);
  useEffect(() => {
    if (!guildId || guildRoles) return;
    void loadRoles(guildId).catch(() => undefined);
  }, [guildId, guildRoles, loadRoles]);

  /**
   * Build the grouped sections for display.
   *
   * Discord-style hoisting: each role with `hoist: true` becomes its
   * own section. Each member is placed under their HIGHEST hoisted
   * role (highest = lowest `position` value, i.e. closest to top of
   * the role list per the role ordering convention). Members with no
   * hoisted role land in a default "Members" bucket. Offline members
   * are pulled out of every section and shown together at the bottom
   * — Discord's behavior; keeps the visible groups about who's
   * actually around right now.
   *
   * Within each section, sort by display name (case-insensitive).
   * Sections themselves order by hoisted role position (highest first),
   * then "Members", then "Offline".
   */
  type Section = { id: string; label: string; color: string | null; members: GuildMember[] };
  const sections = useMemo<Section[]>(() => {
    if (!members) return [];
    const hoistedRoles = (guildRoles ?? [])
      .filter((r) => r.hoist && r.guildId === guildId)
      .sort((a, b) => a.position - b.position);

    // Map roleId → section index for fast member assignment.
    const roleIdx = new Map<string, number>();
    hoistedRoles.forEach((r, i) => roleIdx.set(r.id, i));

    // One bucket per hoisted role + default + offline.
    const buckets: Section[] = hoistedRoles.map((r) => ({
      id: `role:${r.id}`,
      label: r.name,
      // Hoisted-section labels pick up the role's color when it has
      // one — matches the per-name color on member rows.
      color: r.color !== 0 ? `#${r.color.toString(16).padStart(6, '0')}` : null,
      members: [],
    }));
    const defaultBucket: Section = { id: 'default', label: 'Online', color: null, members: [] };
    const offlineBucket: Section = { id: 'offline', label: 'Offline', color: null, members: [] };

    for (const m of members) {
      // Offline members go to the offline bucket regardless of their
      // hoisted role — Discord's rule. 'invisible' is masked to
      // 'offline' on the wire so we never see it client-side; check
      // both for safety in case a future field leak surfaces it.
      if (m.user.status === 'offline' || m.user.status === 'invisible') {
        offlineBucket.members.push(m);
        continue;
      }
      // Find the highest hoisted role this member has. roleIdx is
      // ordered with index 0 = highest, so we take the smallest index.
      let bestIdx = -1;
      for (const rid of m.roleIds) {
        const idx = roleIdx.get(rid);
        if (idx !== undefined && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
      }
      if (bestIdx === -1) defaultBucket.members.push(m);
      else buckets[bestIdx]!.members.push(m);
    }

    const sortByName = (a: GuildMember, b: GuildMember) => {
      const an = (a.nickname ?? a.user.displayName).toLowerCase();
      const bn = (b.nickname ?? b.user.displayName).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    };
    for (const b of buckets) b.members.sort(sortByName);
    defaultBucket.members.sort(sortByName);
    offlineBucket.members.sort(sortByName);

    // Skip empty sections (Discord style — no point showing
    // "Moderators — 0"). Default and offline always show their count
    // when non-empty; same rule, just no early-return for them.
    const out: Section[] = [];
    for (const b of buckets) if (b.members.length > 0) out.push(b);
    if (defaultBucket.members.length > 0) out.push(defaultBucket);
    if (offlineBucket.members.length > 0) out.push(offlineBucket);
    return out;
  }, [members, guildRoles, guildId]);

  // Flatten the grouped sections into a single ordered list so virtua can
  // virtualize at ROW granularity (a 500-member guild renders ~visible rows,
  // not all 500). Each header and each member becomes its own virtual item;
  // order is preserved exactly (hoisted roles, Online, Offline). This holds
  // data only — JSX is built in render so MemberRow keeps its fresh
  // callbacks and stays memoized.
  type VirtualItem =
    | { kind: 'header'; section: Section }
    | { kind: 'member'; member: GuildMember; isOffline: boolean };
  const virtualItems = useMemo<VirtualItem[]>(() => {
    const items: VirtualItem[] = [];
    for (const section of sections) {
      items.push({ kind: 'header', section });
      const isOffline = section.id === 'offline';
      for (const member of section.members) {
        items.push({ kind: 'member', member, isOffline });
      }
    }
    return items;
  }, [sections]);

  if (!guildId) return null;

  const totalCount = members?.length ?? 0;

  return (
    <aside
      className="bg-bg-2/85 backdrop-blur-sm border-l h-full flex flex-col"
      style={{ borderLeftColor: 'var(--zk-line-soft)' }}
    >
      <div className="px-4 py-3 border-b border-line flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-ink-3 flex-1 flex items-center gap-1.5">
          <span>Members</span>
          {loaded ? (
            <>
              <span className="text-ink-3 font-normal" aria-hidden>━</span>
              <span className="text-ink-3 normal-case tabular-nums">{totalCount}</span>
            </>
          ) : null}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="xl:hidden w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
            aria-label="Close members"
          >
            <CloseIcon size={16} />
          </button>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin py-2">
        {!loaded ? (
          <div className="px-4 text-ink-3 text-sm">Loading…</div>
        ) : totalCount === 0 ? (
          <div className="px-4 text-ink-3 text-sm">No members yet</div>
        ) : (
          <Virtualizer ref={vref} scrollRef={scrollRef}>
            {virtualItems.map((item, i) =>
              item.kind === 'header' ? (
                // Section header: role name + member count, colored to the
                // role's color when it has one. Tracks Discord's
                // "Moderators — 3" format. mt above every header except the
                // first replaces the old per-section mb-3 gap.
                <div
                  key={`header-${item.section.id}`}
                  className={`px-3 pb-0.5 text-[0.7rem] uppercase tracking-wider font-semibold flex items-center gap-1.5 ${i === 0 ? 'pt-1' : 'pt-4'}`}
                  style={item.section.color ? { color: item.section.color } : undefined}
                >
                  <span className={item.section.color ? '' : 'text-ink-3'}>{item.section.label}</span>
                  <span className="text-ink-3 font-normal" aria-hidden>
                    ━
                  </span>
                  <span className="text-ink-3 font-normal tabular-nums">
                    {item.section.members.length}
                  </span>
                </div>
              ) : (
                <MemberRow
                  key={`member-${item.member.userId}`}
                  member={item.member}
                  isSelf={user?.id === item.member.userId}
                  isOffline={item.isOffline}
                  guildId={guildId}
                  guildRoles={guildRoles}
                  onAvatarClick={onAvatarClick}
                />
              ),
            )}
          </Virtualizer>
        )}
      </div>
      {cardElement}
    </aside>
  );
}

/**
 * One member row. Memoized so the MemberList parent's re-renders
 * (which fire on every state change consumed via useAppState) don't
 * propagate into every row.
 *
 * Each prop is reference-stable when its underlying data is stable:
 *   - `member` comes from the membersByGuild slice; the reducer's
 *     immutable updates preserve the row reference when nothing
 *     about this specific member changed (presence is the common
 *     update, and PRESENCE_PATCH only allocates a new member object
 *     for the affected user, not the rest of the list).
 *   - `isSelf`, `isOffline` are primitives.
 *   - `guildRoles` is the rolesByGuild[guildId] reference, stable
 *     until roles are added/removed/edited.
 *   - `onAvatarClick` comes from the useProfileCard hook; it's
 *     useCallback-stable within the hook.
 *
 * Net effect: in a 500-member guild, a presence change for one
 * member re-renders one row instead of all 500.
 */
const MemberRow = memo(function MemberRow({
  member: m,
  isSelf,
  isOffline,
  guildId,
  guildRoles,
  onAvatarClick,
}: {
  member: GuildMember;
  isSelf: boolean;
  isOffline: boolean;
  guildId: string | undefined;
  guildRoles: Role[] | undefined;
  onAvatarClick: (user: PublicUser, e: React.MouseEvent<HTMLElement>) => void;
}) {
  const display = m.nickname ?? m.user.displayName;
  const initials = avatarInitials(display);
  const tone = avatarColor(m.userId);
  const onlineDot =
    m.user.status === 'online'
      ? 'bg-emerald-500'
      : m.user.status === 'idle'
        ? 'bg-amber-500'
        : m.user.status === 'dnd'
          ? 'bg-red-500'
          : 'bg-ink-3';
  const roleColor =
    guildId && guildRoles
      ? memberDisplayColor(guildRoles, guildId, m.roleIds)
      : null;
  // Active-timeout state. Reading from the row directly (rather than
  // re-fetching from server) is fine because guildMemberUpdate
  // gateway events keep this field in sync — the patch route fires
  // a member-update broadcast immediately after the DB write.
  const timeoutUntil = (() => {
    const iso = m.communicationDisabledUntil;
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return null;
    return d;
  })();
  const timeoutTitle = timeoutUntil
    ? `Timed out until ${timeoutUntil.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}`
    : undefined;
  return (
    <div className={`px-1 ${isOffline ? 'opacity-60' : ''}`}>
      <button
        type="button"
        onClick={(e) => onAvatarClick(m.user, e)}
        className="w-full px-2 py-1 mx-1 flex items-center gap-2 rounded hover:bg-bg-3 text-left transition-colors"
        title={isSelf ? 'Open your profile' : `Open profile for ${display}`}
      >
        <span className="relative w-9 h-9 shrink-0">
          <span className={`zk-avatar-initials absolute inset-0 rounded-full text-xs flex items-center justify-center font-semibold ${tone}`}>
            {initials}
          </span>
          <AvatarImage src={m.user.avatarUrl} />
          <AvatarDecoration decoration={m.user.avatarDecoration} />
          {/* Presence dot paints last + z-10 so the avatar frame can never
              cover it. */}
          <span
            aria-hidden
            className={`absolute bottom-0 right-0 z-10 w-3 h-3 rounded-full border-2 border-bg-2 ${onlineDot}`}
          />
        </span>
        <UserTag user={m.user} />
        <span
          className={`truncate text-sm ${roleColor ? '' : 'text-ink-1'}`}
          style={roleColor ? { color: roleColor } : undefined}
        >
          {display}
        </span>
        {m.user.isBot && (
          <span
            className="shrink-0 inline-flex items-center px-1.5 rounded bg-violet-500/20 text-violet-300 text-[0.5rem] font-bold uppercase tracking-wider leading-4"
            title="Bot account"
          >
            Bot
          </span>
        )}
        {timeoutUntil && (
          <span
            className="ml-1 text-amber-400 shrink-0"
            title={timeoutTitle}
            aria-label={timeoutTitle}
          >
            <Clock size={12} />
          </span>
        )}
        {m.nickname && (
          <span className="ml-auto text-xs text-ink-3 truncate">
            {m.user.username}
          </span>
        )}
      </button>
    </div>
  );
});
