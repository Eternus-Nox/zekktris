/**
 * ChannelList
 * -----------
 * Second column. Lists the active guild's channels grouped by category.
 * Categories collapse client-side (state lives here, not in the store —
 * collapsed-by-default is fine but we use expanded as a sticky preference).
 *
 * Header has the guild name plus two action buttons:
 *   - + creates a channel (opens ChannelCreateModal)
 *   - gear opens the GuildSettingsModal (overview / invites / members /
 *     danger zone)
 *
 * Each channel row reveals an inline gear icon on hover that opens
 * ChannelEditModal — name/topic/slowmode + delete.
 */

import { lazy, Suspense, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Channel, type Guild } from '@zekktris/client';
import { useAppStateSelector, isChannelUnread, channelMentionCount, isChannelMuted, effectiveNotificationLevel } from '../state/AppState';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
// Lazy-loaded: this modal (and its role/member/automod editors) is ~120 KB and
// only mounts when the user opens server settings. Keeping it out of the eager
// bundle shrinks first paint; the chunk is fetched on first open and cached.
const GuildSettingsModal = lazy(() =>
  import('./GuildSettingsModal').then((m) => ({ default: m.GuildSettingsModal })),
);
import { GuildInfoCard } from './GuildInfoCard';
import { ChannelCreateModal } from './ChannelCreateModal';
import { ChannelEditModal } from './ChannelEditModal';
import { BrowseRolesModal } from './BrowseRolesModal';
import { EventsModal } from './EventsModal';
import { Hash, ChevronRight, ChevronDown, Edit, Volume2, MicOff, HeadphonesOff, Radio, Lock, Plus, Forum, Settings, ExternalLink, Users as UsersIcon } from '../lib/icons';
import { SpeakingRing } from '../lib/SpeakingRing';
import { AvatarImage } from '../lib/AvatarImage';
import { UserVolumePopover } from '../lib/UserVolumePopover';
import { avatarColor } from '../lib/avatar';
import { Portal } from '../lib/Portal';
import { ChannelMenu } from './ChannelMenu';
import { connectToVoice, VoiceError, subscribeSpeakers, getCurrentSpeakers, prepareVoiceAudio } from '../lib/voice';
import { memberIsAdmin } from '../lib/permissions';
import { useChannelDragReorder, type DragState } from '../lib/useChannelDragReorder';
import { useProfileCard } from '../lib/useProfileCard';

interface Props {
  guild: Guild | undefined;
  channels: Channel[] | undefined;
  activeChannelId: string | undefined;
  /** Opens the member list. On mobile this slides in the members drawer;
      on desktop the member column is always visible so the rail's members
      button is mobile-only (xl:hidden). Mirrors the iOS channel-rail
      header where members sits next to the + button. */
  onOpenMembers?: () => void;
}

export function ChannelList({ guild, channels, activeChannelId, onOpenMembers }: Props) {
  const { user, rest } = useAuth();
  // Granular subscriptions (was `useAppState()`). Only these slices drive
  // the list container; the local `appState` keeps existing reads unchanged.
  const membersByGuild = useAppStateSelector((v) => v.state.membersByGuild);
  const rolesByGuild = useAppStateSelector((v) => v.state.rolesByGuild);
  const notificationOverrides = useAppStateSelector((v) => v.state.notificationOverrides);
  const loadRoles = useAppStateSelector((v) => v.loadRoles);
  const applyChannelReorder = useAppStateSelector((v) => v.applyChannelReorder);
  const appState = { membersByGuild, rolesByGuild, notificationOverrides };
  const toasts = useToasts();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    'overview' | 'roles' | 'invites' | 'members' | 'danger'
  >('overview');
  const [showCreate, setShowCreate] = useState(false);
  // When the user clicks a category's "+" affordance, we open the
  // create-channel modal pre-scoped to that category so the new
  // channel lands under it. Null means the modal is either closed
  // (showCreate=false) or opened from the guild-wide header button.
  const [createInCategory, setCreateInCategory] = useState<{ id: string; name: string } | null>(null);
  // Reorder modal removed — drag-and-drop in the channel tree handles
  // reordering directly. Kept the import only for consumers of
  // canReorder permission gating.
  // Anchor point for the GuildInfoCard popover. `null` = closed.
  const [showInfo, setShowInfo] = useState<{ x: number; y: number } | null>(null);
  const [editChannel, setEditChannel] = useState<Channel | null>(null);
  // Browse-roles modal toggle. Owned by ChannelList (rather than
  // GuildInfoCard) so the modal stays open after the info-card
  // popover closes — the card unmounts on close, so a modal owned
  // by the card would tear down with it.
  const [showBrowseRoles, setShowBrowseRoles] = useState(false);
  // Events modal toggle. Same parent-owned pattern as browse-roles.
  const [showEvents, setShowEvents] = useState(false);
  // Stable close callbacks so the modals' Escape-key effects (which depend on
  // onClose) don't tear down + re-add their listeners on every parent render.
  const closeBrowseRoles = useCallback(() => setShowBrowseRoles(false), []);
  const closeEvents = useCallback(() => setShowEvents(false), []);

  // ── Permission + drag setup (must run on every render to keep the
  // hooks order stable; we tolerate guild=undefined here and gate the
  // resulting state on its presence at render time). ──
  const isOwner = !!user && !!guild && guild.ownerId === user.id;
  const myMember = guild
    ? appState.membersByGuild[guild.id]?.find((m) => m.userId === user?.id)
    : undefined;
  const guildRoles = guild ? (appState.rolesByGuild[guild.id] ?? null) : null;
  const canReorder = !!guild && memberIsAdmin(guildRoles, guild.id, myMember?.roleIds ?? null, isOwner);

  // Drag-and-drop reorder — runs unconditionally so hooks order stays
  // stable across renders where `guild` toggles. When the user can't
  // reorder, `enabled` is false and the hook is effectively a no-op.
  const { state: dragState, startDrag, wasJustDragging } = useChannelDragReorder({
    channels: guild ? (channels ?? []) : [],
    enabled: canReorder,
    onReorder: async (changes) => {
      if (!guild) return;
      // Optimistic: snap the channel list to the new order BEFORE
      // the REST round-trip so the user sees the drop immediately.
      // The matching gateway CHANNEL_UPDATE events that follow are
      // idempotent — they re-apply the same data without flicker.
      // If the server rejects the diff, we fall back to a refetch
      // in the catch branch so the local state realigns with the
      // server's authoritative view.
      applyChannelReorder(guild.id, changes);
      try {
        await rest.reorderChannels(guild.id, changes);
      } catch (e) {
        toasts.push(e instanceof ApiError ? e.message : 'Reorder failed', 'error');
        // Re-fetch the canonical channel list to revert our
        // optimistic patch. Cheap; the alternative (computing the
        // exact inverse changeset) compounds complexity for a rare
        // error path.
        try {
          const r = await rest.listGuildChannels(guild.id);
          applyChannelReorder(
            guild.id,
            r.channels.map((c) => ({ id: c.id, position: c.position, parentId: c.parentId ?? null })),
          );
        } catch {
          // If even the refetch fails the next CHANNEL_UPDATE will
          // converge state. Don't toast a second error.
        }
      }
    },
  });

  // Memoized so the O(n log n) group+sort runs only when the channel list
  // actually changes — not on every unrelated re-render (drag state, member/
  // role/override updates).
  //
  // MUST be computed BEFORE the `if (!guild)` early return below so the hook
  // count is identical whether or not a guild is active. ChannelList stays
  // mounted (just hidden) in content modes (Discover/Mentions), where
  // `guild` is undefined; toggling between a server and one of those on the
  // server rail would otherwise flip this hook in/out of the render and
  // throw React #310 / #300 ("rendered more/fewer hooks than last render").
  const grouped = useMemo(() => groupByCategory(channels ?? []), [channels]);

  if (!guild) {
    return (
      <div className="flex items-center justify-center h-full text-ink-3 px-4 text-center text-sm">
        Pick a server from the rail
      </div>
    );
  }

  // Lazy-load roles so canReorder eventually resolves to true for
  // admins. Cheap: idempotent at the AppState level. Safe to call
  // after the early return because by definition guild exists here.
  if (!guildRoles) void loadRoles(guild.id).catch(() => undefined);

  function toggle(catId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  return (
    <>
      {/* Optional banner image. Sits above the header text strip; the
          header itself stays a fixed-height row so the channel list
          scroll-region position doesn't depend on whether a banner
          is set. We use object-cover so portrait/landscape uploads
          both crop sensibly; max-h prevents an absurdly tall image
          from eating the visible channel list. */}
      {guild.bannerUrl && (
        /* Server banner — aspect-locked to 16:9, Discord's standard
           channel-list-header banner ratio (a 960×540 source renders
           at the same proportions on every sidebar width). At a
           240px-wide sidebar this is 240×135. object-cover crops to
           fit so the banner is always full-bleed regardless of the
           uploaded image's native dimensions. */
        <div className="relative aspect-[16/9] bg-bg-3 border-b border-line overflow-hidden shrink-0">
          <img
            src={guild.bannerUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        </div>
      )}
      {/* Header. Single button — clicking the name OR the chevron
          opens the GuildInfoCard menu (which carries Invite, Mark
          all read, Mute, Create channel, Settings, Leave). The
          chevron flips 180° when the menu is open so it doubles as
          a state indicator. The name stays on ONE line (truncated with
          an ellipsis if it's very long) so the header reads as a tidy
          single row alongside the action buttons. */}
      <div
        className="px-3 py-1.5 border-b shadow-sm shrink-0 flex items-center gap-1"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <button
          type="button"
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            // Anchor the popover under the header rather than at the
            // exact click point — keeps the dropdown predictable
            // regardless of where in the header the user clicked.
            setShowInfo({ x: rect.left + 8, y: rect.bottom });
          }}
          className="flex-1 min-w-0 flex items-center gap-1 px-1 -mx-1 py-1 rounded hover:bg-bg-3/40 transition-colors text-left"
          title="Server menu"
          aria-expanded={!!showInfo}
        >
          <span className="font-semibold text-sm text-ink-1 leading-tight flex-1 min-w-0 flex items-center gap-1.5">
            <span className="truncate">{guild.name}</span>
            {/* Guild-level mute indicator. Renders ONCE here when the
                user has muted the whole server, instead of stamping
                the same icon on every channel row in the list below.
                Channel-specific mutes still show their own icon next
                to the channel name (see ChannelRow). */}
            {appState.notificationOverrides[`guild:${guild.id}`] === 'nothing' && (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-ink-3 shrink-0"
                aria-label="Server muted"
              >
                <title>Server muted</title>
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
                <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
                <path d="M18 8a6 6 0 0 0-9.33-5" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            )}
          </span>
          <ChevronDown
            size={16}
            className={`shrink-0 mt-0.5 text-ink-2 transition-transform duration-150 ${
              showInfo ? 'rotate-180' : ''
            }`}
            aria-hidden
          />
        </button>
        {/* Right-aligned action cluster — mirrors the iOS channel-rail
            header: a create-channel "+" (managers only) followed by a
            members button. `canReorder` is the MANAGE_CHANNELS proxy used
            elsewhere in this file to gate channel creation. */}
        {canReorder && (
          <button
            type="button"
            onClick={() => {
              setCreateInCategory(null);
              setShowCreate(true);
            }}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 transition-colors"
            title="Create channel"
            aria-label="Create channel"
          >
            <Plus size={18} />
          </button>
        )}
        {/* Members. Mobile-only: on desktop (xl+) the member list is an
            always-visible right column, so a button there would be a
            no-op. On mobile it opens the members drawer. */}
        <button
          type="button"
          onClick={() => onOpenMembers?.()}
          className="xl:hidden shrink-0 w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 transition-colors"
          title="Members"
          aria-label="Members"
        >
          <UsersIcon size={18} />
        </button>
      </div>

      {/* Channel list */}
      <nav
        data-zk-channel-nav
        className="flex-1 min-h-0 overflow-y-auto scrollbar-thin py-1"
      >
        {/* Top-level (uncategorized) channel group. The wrapping
            <ul> always renders (even when empty) so the root tail
            <li data-zk-drop-tail="root"> stays available as a
            drop target — letting users pull a channel out of a
            category back to top-level even if there are no
            uncategorized channels yet. */}
        <ul className="px-2 mb-2">
          {grouped.uncategorized.map((ch) => (
            <ChannelRow
              key={ch.id}
              channel={ch}
              active={ch.id === activeChannelId}
              onEdit={() => setEditChannel(ch)}
              dragState={dragState}
              onDragStart={canReorder ? startDrag : undefined}
              wasJustDragging={wasJustDragging}
            />
          ))}
          {/* Tail drop-zone for the top-level channel group. Always
              present while reorder permission holds, so a user can
              drop a channel back to root even when no top-level
              channels currently exist. The bar grows taller while a
              drag is in progress and the user is hovering over it,
              giving a clearer hit target. */}
          {canReorder && (
            <li
              data-zk-drop-tail="root"
              className={`mx-1 rounded transition-all ${
                dragState.draggingId
                  ? 'h-10 border-2 border-dashed border-line/60'
                  : 'h-2'
              } ${
                dragState.targetId === 'root' && dragState.position === 'after'
                  ? 'bg-accent/30 border-accent shadow-[inset_0_0_0_1px_rgba(88,101,242,0.6)]'
                  : ''
              }`}
              aria-hidden
            />
          )}
        </ul>
        {grouped.categories.map(({ category, items }) => {
          const isCollapsed = collapsed.has(category.id);
          const catIsDragging = dragState.draggingId === category.id;
          const catIsDropInto =
            dragState.targetId === category.id && dragState.position === 'into';
          const catIsDropBefore =
            dragState.targetId === category.id && dragState.position === 'before';
          const catIsDropAfter =
            dragState.targetId === category.id && dragState.position === 'after';
          return (
            <div
              key={category.id}
              className={`mt-3 transition-opacity ${catIsDragging ? 'opacity-50' : ''}`}
            >
              {/* The category header doubles as a drop target. The
                  `data-zk-drop-into` attribute lets the drag hook
                  detect a "drop INTO this category" target; the
                  `data-zk-drag-id` lets the user drag the
                  category itself to reorder among other categories.
                  Both attributes coexist on the same element — the
                  hook resolves them in priority order (into > drag
                  source). */}
              <div
                {...(canReorder
                  ? {
                      'data-zk-drop-into': category.id,
                      'data-zk-drag-id': category.id,
                      'data-zk-drag-kind': 'category',
                    }
                  : {})}
                className={`relative ${
                  catIsDropBefore ? 'before:absolute before:-top-0.5 before:left-2 before:right-2 before:h-1 before:bg-accent before:rounded-full before:shadow-[0_0_0_2px_rgba(88,101,242,0.35)]' : ''
                } ${
                  catIsDropAfter ? 'after:absolute after:-bottom-0.5 after:left-2 after:right-2 after:h-1 after:bg-accent after:rounded-full after:shadow-[0_0_0_2px_rgba(88,101,242,0.35)]' : ''
                } ${catIsDropInto ? 'bg-accent/30 rounded shadow-[inset_0_0_0_1px_rgba(88,101,242,0.6)]' : ''}`}
              >
                <div className="group/cat flex items-center pr-1">
                  <button
                    onClick={() => toggle(category.id)}
                    onPointerDown={
                      canReorder
                        ? (e) => startDrag(category.id, 'category', category.name ?? '(unnamed)', e)
                        : undefined
                    }
                    className="flex-1 min-w-0 px-3 py-1 flex items-center gap-1 zk-cap hover:text-ink-2 select-none"
                    style={{ touchAction: canReorder ? 'pan-y' : undefined }}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    <span className="truncate">{category.name ?? '(unnamed)'}</span>
                  </button>
                  {/* Add-channel-to-category affordance. Only renders
                      for users who can reorder (MANAGE_CHANNELS proxy
                      — the same permission set is allowed to create
                      channels). Hidden until hover so the category
                      headers stay visually quiet by default; on
                      touch devices it stays visible since hover
                      doesn't fire. */}
                  {canReorder && (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditChannel(category);
                        }}
                        className="opacity-0 group-hover/cat:opacity-100 [@media(hover:none)]:opacity-100 w-5 h-5 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-opacity"
                        title={`Edit ${category.name ?? 'this category'} (permissions cascade to channels inside it)`}
                        aria-label={`Edit ${category.name ?? 'this category'}`}
                      >
                        <Settings size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCreateInCategory({
                            id: category.id,
                            name: category.name ?? '(unnamed)',
                          });
                          setShowCreate(true);
                        }}
                        className="opacity-0 group-hover/cat:opacity-100 [@media(hover:none)]:opacity-100 w-5 h-5 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-opacity"
                        title={`Add a channel to ${category.name ?? 'this category'}`}
                        aria-label={`Add a channel to ${category.name ?? 'this category'}`}
                      >
                        <Plus size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {!isCollapsed && (
                <ul className="px-2">
                  {items.map((ch) => (
                    <ChannelRow
                      key={ch.id}
                      channel={ch}
                      active={ch.id === activeChannelId}
                      onEdit={() => setEditChannel(ch)}
                      dragState={dragState}
                      onDragStart={canReorder ? startDrag : undefined}
                      wasJustDragging={wasJustDragging}
                    />
                  ))}
                  {/* Tail drop zone — drop here to append to the bottom of
                      this category. While a drag is in progress the bar
                      grows from 2px to 6px so it's easier to hit; lights
                      up to accent when targeted. */}
                  {canReorder && (
                    <li
                      data-zk-drop-tail={category.id}
                      className={`mx-1 rounded transition-all ${
                        dragState.draggingId ? 'h-10 border-2 border-dashed border-line/60' : 'h-2'
                      } ${
                        dragState.targetId === category.id && dragState.position === 'after'
                          ? 'bg-accent/30 border-accent shadow-[inset_0_0_0_1px_rgba(88,101,242,0.6)]'
                          : ''
                      }`}
                      aria-hidden
                    />
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      {/* Floating preview pill — shows the dragging channel/category
          label following the pointer. Rendered at document root via
          fixed positioning with pointer-events:none so it can't
          interfere with drop-target hit-testing. */}
      {dragState.draggingId && dragState.pointer && dragState.draggingLabel && (
        <div
          className="fixed pointer-events-none z-50 px-2 py-1 rounded bg-bg-2 border border-accent/60 text-xs text-ink-1 shadow-lg max-w-[200px] truncate"
          style={{
            left: dragState.pointer.x + 12,
            top: dragState.pointer.y - 8,
          }}
        >
          {dragState.draggingLabel}
        </div>
      )}

      {showSettings && (
        <Suspense fallback={null}>
          <GuildSettingsModal
            guild={guild}
            onClose={() => setShowSettings(false)}
            initialTab={settingsTab}
          />
        </Suspense>
      )}
      {showCreate && (
        <ChannelCreateModal
          guild={guild}
          parentCategoryId={createInCategory?.id}
          parentCategoryName={createInCategory?.name}
          onClose={() => {
            setShowCreate(false);
            setCreateInCategory(null);
          }}
        />
      )}
      {editChannel && <ChannelEditModal channel={editChannel} onClose={() => setEditChannel(null)} />}
      {showInfo && (
        <GuildInfoCard
          guild={guild}
          anchor={showInfo}
          onClose={() => setShowInfo(null)}
          onOpenSettings={() => {
            setSettingsTab('overview');
            setShowSettings(true);
          }}
          onOpenSettingsTab={(t) => {
            setSettingsTab(t);
            setShowSettings(true);
          }}
          onCreateChannel={() => {
            setShowCreate(true);
            setShowInfo(null);
          }}
          canCreateChannel={canReorder}
          onBrowseRoles={() => setShowBrowseRoles(true)}
          onOpenEvents={() => setShowEvents(true)}
        />
      )}
      {showBrowseRoles && (
        <BrowseRolesModal guild={guild} onClose={closeBrowseRoles} />
      )}
      {showEvents && (
        <EventsModal guild={guild} onClose={closeEvents} />
      )}
    </>
  );
}

function ChannelRow({
  channel,
  active,
  onEdit,
  dragState,
  onDragStart,
  wasJustDragging,
}: {
  channel: Channel;
  active: boolean;
  onEdit: () => void;
  /** Current drag state from the parent's useChannelDragReorder hook.
      Drives the per-row visual indicators (dim / drop-target line). */
  dragState: DragState;
  /** Pointer-down handler from the drag hook. Undefined when the user
      lacks permission to manage channels — in that case the row
      doesn't accept drags and rendering bypasses the data attributes. */
  onDragStart?: (channelId: string, kind: 'channel' | 'category', label: string, e: React.PointerEvent) => void;
  /** Returns true if a drag JUST completed (within ~250ms). The row's
      onClick handler checks this to swallow the synthetic click that
      `<Link>` receives after pointerup, otherwise completing a drag
      would also navigate to the dragged channel. The doc-level
      capture suppressor catches most cases but `<Link>`'s React
      Router click plumbing occasionally evades it; this is the
      explicit guard. */
  wasJustDragging?: () => boolean;
}) {
  if (channel.type === 'guild_category') return null; // categories handled by header
  if (channel.type === 'guild_voice') {
    return <VoiceChannelRow channel={channel} active={active} onEdit={onEdit} dragState={dragState} onDragStart={onDragStart} />;
  }
  if (channel.type === 'guild_stage') {
    // Stage channels render with a distinct icon (radio/megaphone-y)
    // but don't carry the live-presence row that VoiceChannelRow does;
    // the participant list lives inside the StageChannelView itself.
    return <StageChannelRow channel={channel} active={active} onEdit={onEdit} dragState={dragState} onDragStart={onDragStart} />;
  }
  if (channel.type === 'guild_forum') {
    // Forum channels are post containers — clicking navigates to the
    // ForumView which renders the post list. No unread/mention badges
    // because the forum row itself has no message stream; each post
    // (thread) tracks its own unread state separately. Edit affordance
    // matches the text-channel row.
    return <ForumChannelRow channel={channel} active={active} onEdit={onEdit} dragState={dragState} onDragStart={onDragStart} wasJustDragging={wasJustDragging} />;
  }
  if (channel.type === 'guild_link') {
    // Link channels are external URL bookmarks — clicking shows a
    // confirm-leave prompt rather than navigating into the channel.
    // No unread/mention badges (no message stream), and the icon
    // distinguishes them from regular text rows in the sidebar.
    return <LinkChannelRow channel={channel} onEdit={onEdit} dragState={dragState} onDragStart={onDragStart} wasJustDragging={wasJustDragging} />;
  }
  // Text channel — the only branch that needs row-level hooks (unread /
  // mention / mute state, context menu). It lives in its own component so
  // ChannelRow itself stays HOOKLESS: a ChannelRow fiber can be reused
  // across a guild switch where the channel at a given list position
  // changes type (e.g. voice→text). If the hooks lived here, that type
  // change would flip the hook count between renders and throw React #310
  // ("rendered more hooks than during the previous render"). A dedicated
  // child means each channel type owns its own fiber + hook list.
  return (
    <TextChannelRow
      channel={channel}
      active={active}
      onEdit={onEdit}
      dragState={dragState}
      onDragStart={onDragStart}
      wasJustDragging={wasJustDragging}
    />
  );
}

function TextChannelRow({
  channel,
  active,
  onEdit,
  dragState,
  onDragStart,
  wasJustDragging,
}: {
  channel: Channel;
  active: boolean;
  onEdit: () => void;
  dragState: DragState;
  onDragStart?: (channelId: string, kind: 'channel' | 'category', label: string, e: React.PointerEvent) => void;
  wasJustDragging?: () => boolean;
}) {
  // Granular subscriptions (was `useAppState()`): a channel row should only
  // re-render when its mute/read state changes, not on every dispatch.
  // notificationOverrides changes rarely (only on a mute / notif edit), so the
  // whole-map selector is fine. readStateByChannel is the HOT one — it's
  // rebuilt by reference on EVERY inbound message, so selecting the whole map
  // re-rendered every visible row on every message; it's read per-channel as
  // primitives below instead.
  const notificationOverrides = useAppStateSelector((v) => v.state.notificationOverrides);
  const ackChannel = useAppStateSelector((v) => v.ackChannel);
  const setNotificationOverride = useAppStateSelector((v) => v.setNotificationOverride);
  const state = { notificationOverrides };
  const toasts = useToasts();
  const navigate = useNavigate();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  // Mute suppresses the dimmer "unread" treatment but does NOT hide
  // mention badges — Discord's behaviour. The user opted out of being
  // distracted by every message, but explicit @-pings still surface.
  const muted = isChannelMuted(state.notificationOverrides, channel.id, channel.guildId ?? null);
  // Explicit channel-level mute vs guild-inherited. The per-row
  // bell-off icon should only render when this channel itself is
  // overridden to 'nothing' — if the muting comes from a
  // guild-wide mute, the indicator lives next to the guild title
  // (see ChannelList header) so we don't repeat it on every row.
  const channelExplicitlyMuted =
    state.notificationOverrides[`channel:${channel.id}`] === 'nothing';
  // Per-channel primitives — this row re-renders only when ITS unread flag or
  // mention count changes (the selected boolean/number is reference-stable),
  // not on every message in any channel.
  const rawUnread = useAppStateSelector(
    (v) => !active && isChannelUnread(channel, v.state.readStateByChannel),
  );
  const mentions = useAppStateSelector((v) => channelMentionCount(channel.id, v.state.readStateByChannel));
  const unread = muted ? false : rawUnread;

  const lastMessageId = channel.lastMessageId ?? null;

  // Drag indicators — derived from the parent's drag state. We only
  // dim/highlight when this row is involved in the active drag; rows
  // that aren't participants stay unchanged. The before/after lines
  // are 2px accent-colored bars rendered via CSS pseudo-elements so we
  // don't need extra DOM.
  const isDragging = dragState.draggingId === channel.id;
  const isDropBefore = dragState.targetId === channel.id && dragState.position === 'before';
  const isDropAfter = dragState.targetId === channel.id && dragState.position === 'after';

  return (
    <li
      className={`group/row relative transition-opacity ${isDragging ? 'opacity-40' : ''} ${
        isDropBefore ? 'before:absolute before:-top-px before:left-2 before:right-2 before:h-1 before:bg-accent before:rounded-full before:shadow-[0_0_0_2px_rgba(88,101,242,0.35)] before:z-10' : ''
      } ${
        isDropAfter ? 'after:absolute after:-bottom-px after:left-2 after:right-2 after:h-1 after:bg-accent after:rounded-full after:shadow-[0_0_0_2px_rgba(88,101,242,0.35)] after:z-10' : ''
      }`}
      {...(onDragStart
        ? {
            'data-zk-drag-id': channel.id,
            'data-zk-drag-kind': 'channel',
          }
        : {})}
    >
      <button
        type="button"
        // Programmatic navigation instead of a <Link>. The previous
        // implementation wrapped the row in a React Router <Link>,
        // which renders an <a> element. Anchor elements have
        // browser-level pointer/drag semantics that fought our
        // pointer-events-based drag implementation: even with
        // `draggable={false}` set, Safari and Chrome both flag
        // pointerdown on an <a> for special treatment, and on
        // touch devices the synthetic click that fires after
        // pointerup occasionally races past our just-dragged
        // guard. Switching to a real <button> brings text channels
        // in line with voice channels (which always worked) and
        // eliminates the anchor-specific edge cases entirely.
        onClick={(e) => {
          // If a drag just completed, swallow the click — we don't
          // want a drop to also trigger navigation to the row that
          // was being dragged. Mirror the voice-row behavior.
          if (wasJustDragging?.()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          navigate(`/channels/${channel.guildId}/${channel.id}`);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAnchor({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={
          onDragStart
            ? (e) => onDragStart(channel.id, 'channel', `# ${channel.name ?? ''}`, e)
            : undefined
        }
        // touch-action: 'pan-y' lets the browser scroll the channel list
        // vertically even when a swipe STARTS on a row, while the long-press
        // drag still works: a quick vertical swipe scrolls (and the reorder
        // hook cancels its pending long-press once the finger moves >8px),
        // whereas a stationary press fires the long-press and the drag's own
        // preventDefault then suppresses scrolling for the rest of the gesture.
        // (Previously 'none' here blocked scrolling entirely for touches that
        // landed on a row — you could only scroll from the gaps between rows.)
        style={onDragStart ? { touchAction: 'pan-y' } : undefined}
        className={`w-full flex items-center gap-2 px-2 py-1 rounded text-[0.9375rem] text-left transition-colors ${
          active
            ? 'row-active'
            : unread
              ? 'text-ink-1 font-medium hover:bg-bg-3/50'
              : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3/50'
        }`}
      >
        <span className="relative shrink-0">
          <Hash size={14} className="text-accent" />
          {channel.restricted && (
            // Padlock badge sitting at the top-right corner of the
            // channel-type icon. Compact (8px @ 3px stroke so it
            // reads at a glance), absolutely positioned so it
            // doesn't take row width. Negative offsets push it
            // outside the icon's bounds for the corner-badge feel.
            <Lock
              size={8}
              strokeWidth={3}
              className="absolute -top-1 -right-1.5 text-ink-3"
              aria-label="Restricted channel"
            />
          )}
        </span>
        <span className="truncate flex-1">{channel.name ?? '(unnamed)'}</span>
        {channelExplicitlyMuted && (
          // Subtle bell-with-strike glyph beside the channel name when
          // muted — gives users a permanent reminder of why they're
          // not seeing pings on this row.
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-ink-3 shrink-0 group-hover/row:hidden"
            aria-label="Muted"
          >
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
            <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
            <path d="M18 8a6 6 0 0 0-9.33-5" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
        {mentions > 0 ? (
          <span className="text-[0.65rem] font-bold bg-red-500 text-white rounded-full min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center group-hover/row:hidden">
            {mentions > 99 ? '99+' : mentions}
          </span>
        ) : unread ? (
          <span aria-label="unread" className="w-1.5 h-1.5 rounded-full bg-ink-1 shrink-0 group-hover/row:hidden" />
        ) : null}
      </button>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit();
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 hidden group-hover/row:flex [@media(hover:none)]:flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
        aria-label={`Edit channel #${channel.name ?? ''}`}
        title="Edit channel"
      >
        <Edit size={12} />
      </button>

      {/* Right-click / long-press menu. Items are conditional on what
          makes sense for the current channel state — Mark as read is
          always shown but disabled when there's nothing unread, etc. */}
      {menuAnchor && (
        <ChannelMenu
          anchor={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          items={[
            {
              label: 'Mark as read',
              disabled: !lastMessageId || !rawUnread,
              onClick: () => {
                if (!lastMessageId) return;
                void ackChannel(channel.id, lastMessageId).catch(() => {
                  toasts.push('Could not mark as read', 'error');
                });
              },
            },
            ...(() => {
              // 3-way per-channel notifications. 'all' = notify on every
              // message (server notifications), 'mentions' = only @mentions,
              // 'nothing' = mute. The active level (channel override, else the
              // inherited guild/default) is checkmarked.
              const current = effectiveNotificationLevel(
                state.notificationOverrides,
                channel.id,
                channel.guildId ?? null,
              );
              const set = (level: 'all' | 'mentions' | 'nothing') => () => {
                void setNotificationOverride('channel', channel.id, level).catch(() => {
                  toasts.push('Could not update notifications', 'error');
                });
              };
              const opt = (label: string, level: 'all' | 'mentions' | 'nothing') => ({
                label: current === level ? `✓ ${label}` : label,
                onClick: set(level),
              });
              return [
                opt('All messages', 'all'),
                opt('Only @mentions', 'mentions'),
                opt('Nothing (mute)', 'nothing'),
              ];
            })(),
            {
              label: 'Edit channel',
              onClick: onEdit,
            },
          ]}
        />
      )}

      {/* Nested thread rows removed — threads moved exclusively under
          the forum-channel system. Text channels no longer surface
          threads in the sidebar. (Existing threads remain in the
          database; this just hides them from this surface. When
          forum channels land they'll render their own thread/post
          list using the same ThreadRow component below.) */}
    </li>
  );
}

/**
 * Single thread row — rendered nested under its parent text channel.
 * Visually distinct from a regular channel: speech-bubble icon, smaller
 * indented font, and a translucent treatment for archived threads.
 */
// ThreadRow removed: threads moved exclusively under the forum-system.
// When forum channels land they'll need their own thread/post row
// renderer — re-introduce a forum-scoped component there rather than
// keeping a dormant one here. The grouping helper below still computes
// threadsByParent in case the forum renderer wants to consume it
// directly; trivially cheap and easy to drop if a separate forum
// grouping ends up being cleaner.

// ── Grouping ──────────────────────────────────────────────────────────────

interface Grouped {
  uncategorized: Channel[];
  categories: Array<{ category: Channel; items: Channel[] }>;
  /** Threads keyed by their parent TEXT-channel id. Lookup happens at
      render time so the parent row can pull its own thread list and
      render it nested below itself. */
  threadsByParent: Map<string, Channel[]>;
}

function groupByCategory(channels: Channel[]): Grouped {
  const sorted = [...channels].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : 1;
  });
  const categories = sorted.filter((c) => c.type === 'guild_category');
  const byCat = new Map<string, Channel[]>();
  const threadsByParent = new Map<string, Channel[]>();
  const uncategorized: Channel[] = [];
  for (const ch of sorted) {
    if (ch.type === 'guild_category') continue;
    // Threads live in a separate map keyed by their parent TEXT
    // channel — they share `parentId` with the category-nesting
    // pattern but should render nested under the text channel they
    // belong to, not at the same level.
    if (ch.type === 'public_thread') {
      if (!ch.parentId) continue; // malformed — skip rather than crash
      const arr = threadsByParent.get(ch.parentId) ?? [];
      arr.push(ch);
      threadsByParent.set(ch.parentId, arr);
      continue;
    }
    if (ch.parentId) {
      const arr = byCat.get(ch.parentId) ?? [];
      arr.push(ch);
      byCat.set(ch.parentId, arr);
    } else {
      uncategorized.push(ch);
    }
  }
  // Sort each parent's thread list: active (non-archived) first,
  // newest first within each group. Matches the server's listThreads
  // ordering, so client + server agree on what "the last 50 threads"
  // means visually.
  for (const list of threadsByParent.values()) {
    list.sort((a, b) => {
      const aArchived = a.threadArchivedAt != null;
      const bArchived = b.threadArchivedAt != null;
      if (aArchived !== bArchived) return aArchived ? 1 : -1;
      return a.id < b.id ? 1 : -1; // newer (larger snowflake) first
    });
  }
  return {
    uncategorized,
    categories: categories.map((cat) => ({
      category: cat,
      items: byCat.get(cat.id) ?? [],
    })),
    threadsByParent,
  };
}


// ── Voice channel row ──────────────────────────────────────────────────────
//
// Voice channels render differently from text:
//   - No navigate-to-message-view (voice channels have no messages)
//   - Click to JOIN voice (POST /channels/:id/voice/join)
//   - Show participants nested below as a tiny presence list
//   - The row itself is "active" if you're currently in this voice channel
//
// We deliberately don't reuse the unread/mention badge slot here because
// voice channels have no concept of "unread"; the participant count is
// the entire signal.

function StageChannelRow({
  channel,
  active,
  onEdit,
  dragState,
  onDragStart,
}: {
  channel: Channel;
  active: boolean;
  onEdit: () => void;
  dragState: DragState;
  onDragStart?: (channelId: string, kind: 'channel' | 'category', label: string, e: React.PointerEvent) => void;
}) {
  const stageParticipantsByChannel = useAppStateSelector((v) => v.state.stageParticipantsByChannel);
  const state = { stageParticipantsByChannel };
  const navigate = useNavigate();
  // Live participant count from the stage slice. Absence = "not loaded
  // yet"; we show no count rather than a 0 to avoid the user thinking
  // the stage is empty when it isn't.
  const participants = state.stageParticipantsByChannel[channel.id] ?? null;
  const speakerCount = participants?.filter((p) => p.isSpeaker).length ?? 0;

  const isDragging = dragState.draggingId === channel.id;
  const isDropBefore = dragState.targetId === channel.id && dragState.position === 'before';
  const isDropAfter = dragState.targetId === channel.id && dragState.position === 'after';

  // Click — navigates to the stage view; the actual join happens
  // inside StageChannelView when the user clicks "Join stage". This
  // differs from voice (where clicking the row joins) because stage
  // joins are typically more deliberate ("am I sure I want to listen
  // in to this discussion?"), and we want the user to see the topic
  // and speakers before they commit.
  function click() {
    navigate(`/channels/${channel.guildId}/${channel.id}`);
  }

  return (
    <li
      className={`group/row relative transition-opacity ${isDragging ? 'opacity-40' : ''} ${
        isDropBefore ? 'before:absolute before:-top-px before:left-2 before:right-2 before:h-1 before:bg-accent before:rounded-full before:shadow-[0_0_0_2px_rgba(88,101,242,0.35)] before:z-10' : ''
      } ${
        isDropAfter ? 'after:absolute after:-bottom-px after:left-2 after:right-2 after:h-1 after:bg-accent after:rounded-full after:shadow-[0_0_0_2px_rgba(88,101,242,0.35)] after:z-10' : ''
      }`}
      {...(onDragStart
        ? {
            'data-zk-drag-id': channel.id,
            'data-zk-drag-kind': 'channel',
          }
        : {})}
    >
      <button
        type="button"
        onClick={click}
        onPointerDown={
          onDragStart
            ? (e) => onDragStart(channel.id, 'channel', `📡 ${channel.name ?? ''}`, e)
            : undefined
        }
        style={onDragStart ? { touchAction: 'pan-y' } : undefined}
        className={`w-full flex items-center gap-2 px-2 py-1 rounded text-[0.9375rem] text-left transition-colors ${
          active ? 'row-active' : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3/50'
        }`}
      >
        <span className="relative shrink-0">
          {/* Theme accent like the other channel icons (#/voice/forum/link) —
              was the only one using the muted ink-3 tint. */}
          <Radio size={14} className="text-accent" />
          {channel.restricted && (
            <Lock
              size={8}
              strokeWidth={3}
              className="absolute -top-1 -right-1.5 text-ink-3"
              aria-label="Restricted channel"
            />
          )}
        </span>
        <span className="truncate flex-1">{channel.name ?? '(unnamed)'}</span>
        {participants && participants.length > 0 && (
          <span className="text-[0.65rem] text-ink-3 shrink-0 group-hover/row:hidden tabular-nums">
            {speakerCount > 0 ? `${speakerCount}/${participants.length}` : participants.length}
          </span>
        )}
      </button>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit();
        }}
        className="absolute right-1 top-1.5 w-6 h-6 hidden group-hover/row:flex [@media(hover:none)]:flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
        aria-label={`Edit stage channel ${channel.name ?? ''}`}
        title="Edit channel"
      >
        <Edit size={12} />
      </button>
    </li>
  );
}

/**
 * Forum channel row in the channel list. Same drag + click + edit
 * affordances as the text-channel row but without the unread/mention/
 * notification-override machinery — a forum channel doesn't carry its
 * own message stream (posts are separate channels with their own
 * unread state), so badging the forum row itself would be a misleading
 * "this forum has new content" indicator without a clear semantic.
 *
 * Future work: a roll-up indicator (e.g. "new posts" dot when any
 * child post has unread messages OR a fresh post landed) would be a
 * nice-to-have once we have the underlying child-state aggregation.
 */
function ForumChannelRow({
  channel,
  active,
  onEdit,
  dragState,
  onDragStart,
  wasJustDragging,
}: {
  channel: Channel;
  active: boolean;
  onEdit: () => void;
  dragState: DragState;
  onDragStart?: (channelId: string, kind: 'channel' | 'category', label: string, e: React.PointerEvent) => void;
  wasJustDragging?: () => boolean;
}) {
  const navigate = useNavigate();
  const isDragging = dragState.draggingId === channel.id;
  const isDropBefore = dragState.targetId === channel.id && dragState.position === 'before';
  const isDropAfter = dragState.targetId === channel.id && dragState.position === 'after';

  return (
    <li
      className={`group/row relative ${
        isDragging ? 'opacity-40' : ''
      } ${
        isDropBefore ? 'before:absolute before:-top-0.5 before:left-2 before:right-2 before:h-1 before:bg-accent before:rounded-full before:shadow-[0_0_0_2px_rgba(88,101,242,0.35)]' : ''
      } ${
        isDropAfter ? 'after:absolute after:-bottom-0.5 after:left-2 after:right-2 after:h-1 after:bg-accent after:rounded-full after:shadow-[0_0_0_2px_rgba(88,101,242,0.35)]' : ''
      }`}
      {...(onDragStart
        ? {
            'data-zk-drag-id': channel.id,
            'data-zk-drag-kind': 'channel',
          }
        : {})}
    >
      <button
        type="button"
        onClick={(e) => {
          if (wasJustDragging?.()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          navigate(`/channels/${channel.guildId}/${channel.id}`);
        }}
        onPointerDown={
          onDragStart
            ? (e) => onDragStart(channel.id, 'channel', `▤ ${channel.name ?? ''}`, e)
            : undefined
        }
        style={onDragStart ? { touchAction: 'pan-y' } : undefined}
        className={`w-full flex items-center gap-2 px-2 py-1 rounded text-[0.9375rem] text-left transition-colors ${
          active ? 'row-active' : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3/50'
        }`}
      >
        <span className="relative shrink-0">
          <Forum size={14} className="text-accent" />
          {channel.restricted && (
            <Lock
              size={8}
              strokeWidth={3}
              className="absolute -top-1 -right-1.5 text-ink-3"
              aria-label="Restricted forum"
            />
          )}
        </span>
        <span className="truncate flex-1">{channel.name ?? '(unnamed)'}</span>
      </button>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit();
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 hidden group-hover/row:flex [@media(hover:none)]:flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
        aria-label={`Edit forum ${channel.name ?? ''}`}
        title="Edit forum"
      >
        <Edit size={12} />
      </button>
    </li>
  );
}

/**
 * Link channel row — external URL bookmark. Distinct from regular
 * text channels in three ways:
 *
 *   - Renders with an ExternalLink icon (chain-link arrow), not Hash.
 *   - Clicking does NOT navigate to /channels/G/C; instead it opens
 *     a confirmation prompt asking the user if they want to leave.
 *     On confirm, the URL opens in a new tab with rel="noopener
 *     noreferrer" so the target page can't reach back into the
 *     opener window.
 *   - No active highlight (the row is never the "current" channel —
 *     there's no view associated with it), no unread badge.
 *
 * Edit button targets the same ChannelEditModal as other types so
 * the URL + name + permissions can be changed in place.
 */
function LinkChannelRow({
  channel,
  onEdit,
  dragState,
  onDragStart,
  wasJustDragging,
}: {
  channel: Channel;
  onEdit: () => void;
  dragState: DragState;
  onDragStart?: (channelId: string, kind: 'channel' | 'category', label: string, e: React.PointerEvent) => void;
  wasJustDragging?: () => boolean;
}) {
  const isDragging = dragState.draggingId === channel.id;
  const isDropBefore = dragState.targetId === channel.id && dragState.position === 'before';
  const isDropAfter = dragState.targetId === channel.id && dragState.position === 'after';
  const [confirming, setConfirming] = useState(false);

  // Derive a short host preview to show in the confirmation dialog.
  // Failsafe: if the stored URL is malformed (shouldn't happen — server
  // validates — but defensive) fall back to the raw string capped at
  // 60 chars.
  const url = channel.linkUrl ?? '';
  const hostLabel = (() => {
    try {
      const u = new URL(url);
      return u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '');
    } catch {
      return url.slice(0, 60);
    }
  })();

  function handleClick() {
    if (wasJustDragging?.()) return;
    if (!url) return;
    setConfirming(true);
  }

  function handleConfirm() {
    setConfirming(false);
    // rel="noopener noreferrer" prevents the destination from accessing
    // window.opener (which would be us) and from receiving a Referer
    // header that leaks the origin URL.
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <li
      className={`group/row relative ${
        isDragging ? 'opacity-40' : ''
      } ${
        isDropBefore ? 'before:absolute before:-top-0.5 before:left-2 before:right-2 before:h-1 before:bg-accent before:rounded-full before:shadow-[0_0_0_2px_rgba(88,101,242,0.35)]' : ''
      } ${
        isDropAfter ? 'after:absolute after:-bottom-0.5 after:left-2 after:right-2 after:h-1 after:bg-accent after:rounded-full after:shadow-[0_0_0_2px_rgba(88,101,242,0.35)]' : ''
      }`}
      {...(onDragStart
        ? {
            'data-zk-drag-id': channel.id,
            'data-zk-drag-kind': 'channel',
          }
        : {})}
    >
      <button
        type="button"
        onClick={handleClick}
        onPointerDown={
          onDragStart
            ? (e) => onDragStart(channel.id, 'channel', `🔗 ${channel.name ?? ''}`, e)
            : undefined
        }
        style={onDragStart ? { touchAction: 'pan-y' } : undefined}
        className="w-full flex items-center gap-2 px-2 py-1 rounded text-[0.9375rem] text-left text-ink-2 hover:text-ink-1 hover:bg-bg-3/50 transition-colors"
      >
        <span className="relative shrink-0">
          <ExternalLink size={14} className="text-accent" />
          {channel.restricted && (
            <Lock
              size={8}
              strokeWidth={3}
              className="absolute -top-1 -right-1.5 text-ink-3"
              aria-label="Restricted link"
            />
          )}
        </span>
        <span className="truncate flex-1">{channel.name ?? '(unnamed)'}</span>
      </button>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit();
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 hidden group-hover/row:flex [@media(hover:none)]:flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
        aria-label={`Edit link ${channel.name ?? ''}`}
        title="Edit link"
      >
        <Edit size={12} />
      </button>

      {/* Confirmation dialog. Plain centered modal rather than a full-
          screen confirm() because we want to show the destination
          URL (and an obvious cancel) — browser-native confirm() is
          spartan and easily dismissed by accident on mobile. */}
      {confirming && (
        <Portal>
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setConfirming(false)}
          >
            <div
              className="bg-bg-2 border border-line rounded-lg shadow-2xl max-w-sm w-full p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-base font-semibold text-ink-1 mb-1">
                Leave Zekktris?
              </h2>
              <p className="text-sm text-ink-2 mb-1">
                You're about to visit an external site:
              </p>
              <p className="text-xs text-ink-3 font-mono break-all bg-bg-3 px-2 py-1 rounded mb-4">
                {hostLabel}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="px-3 py-1.5 rounded text-sm text-ink-2 hover:text-ink-1 hover:bg-bg-3"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  className="px-3 py-1.5 rounded text-sm font-medium bg-accent text-white hover:opacity-90"
                >
                  Open in new tab
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </li>
  );
}

function VoiceChannelRow({
  channel,
  active,
  onEdit,
  dragState,
  onDragStart,
}: {
  channel: Channel;
  active: boolean;
  onEdit: () => void;
  dragState: DragState;
  onDragStart?: (channelId: string, kind: 'channel' | 'category', label: string, e: React.PointerEvent) => void;
}) {
  // Granular subscriptions (was `useAppState()`).
  const voiceStatesByUser = useAppStateSelector((v) => v.state.voiceStatesByUser);
  const supervision = useAppStateSelector((v) => v.state.supervision);
  const mergeChannelVoiceStates = useAppStateSelector((v) => v.mergeChannelVoiceStates);
  const restForChannel = useAppStateSelector((v) => v.restForChannel);
  const state = { voiceStatesByUser, supervision };
  const { user } = useAuth();
  const toasts = useToasts();
  const navigate = useNavigate();
  // Memoized participant list. This walks the entire voiceStatesByUser map
  // and allocates a fresh array; without memo every channel's row repeats
  // that walk on every render of the sidebar (e.g. when the user types in a
  // different channel). Gating on the underlying map ref means we recompute
  // only when a voice state actually changes. (Inlined the former
  // voiceStatesForChannel helper, which required the full State object.)
  const participants = useMemo(
    () => Object.values(state.voiceStatesByUser).filter((v) => v.channelId === channel.id),
    [state.voiceStatesByUser, channel.id],
  );
  const selfInThis = !!user && participants.some((v) => v.userId === user.id);

  const isDragging = dragState.draggingId === channel.id;
  const isDropBefore = dragState.targetId === channel.id && dragState.position === 'before';
  const isDropAfter = dragState.targetId === channel.id && dragState.position === 'after';

  // Click behavior: always navigate to the channel page (so the main
  // panel switches to VoiceView). If we're not already in voice on
  // this channel, ALSO join — Discord's pattern, less clicky than a
  // separate Join button. Re-clicking the channel you're already in
  // is a pure navigation.
  async function click() {
    navigate(`/channels/${channel.guildId}/${channel.id}`);
    if (selfInThis) return;
    // Parental controls: a supervised child barred from voice can't join.
    if (state.supervision?.restrictions && !state.supervision.restrictions.allowVoice) {
      toasts.push('Voice calls are restricted by your parent', 'error');
      return;
    }
    // Prime shared audio context inside the click event — see
    // lib/voice.prepareVoiceAudio for why.
    prepareVoiceAudio();
    try {
      const r = await (await restForChannel(channel.id)).joinVoice(channel.id);
      // Merge the channel's authoritative voice state snapshot into
      // our local view before connecting — defends against any
      // earlier missed VOICE_STATE_UPDATE events so the joining
      // user sees everyone already in the room.
      mergeChannelVoiceStates(channel.id, r.channelVoiceStates);
      if (r.token && r.wsUrl) {
        try {
          await connectToVoice({
            token: r.token,
            wsUrl: r.wsUrl,
            sessionId: r.voiceState.sessionId,
            // Thread the channel through so the self-move detector can
            // reconnect this device if a moderator drags us elsewhere.
            channelId: channel.id,
          });
        } catch (e) {
          // Roll back the server-side join: REST joinVoice already created a
          // voice_state everyone can see, so a failed media connect (mic
          // denied, no UDP, SFU down) would otherwise leave us as a silent
          // ghost in the channel forever (our gateway is healthy, so the 45s
          // grace never fires). Best-effort — the gateway echoes the leave.
          void (await restForChannel(channel.id)).leaveVoice(channel.id).catch(() => {});
          if (e instanceof VoiceError) {
            toasts.push(e.message, 'error');
          } else {
            toasts.push(
              e instanceof Error ? `Voice connect failed: ${e.message}` : 'Voice connect failed',
              'error',
            );
          }
        }
      } else {
        toasts.push('Voice isn’t set up on this server yet — you’ve joined the channel, but no audio will connect. Ask the server admin to enable voice.', 'info');
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to join voice', 'error');
    }
  }

  // Drag-over state for the move-user drop zone. true while a
  // VoiceParticipant drag is hovering over this channel's button.
  // Adds an accent ring + bg highlight so the user sees a clear
  // drop affordance. Reset on dragleave/drop/dragend.
  const [userDropHover, setUserDropHover] = useState(false);

  async function handleUserDrop(droppedUserId: string) {
    setUserDropHover(false);
    // Defensive: ignore drops back onto the same channel the user
    // is already in. The server is idempotent but we'd rather skip
    // the round-trip entirely.
    const targetState = state.voiceStatesByUser[droppedUserId];
    if (targetState && targetState.channelId === channel.id) return;
    // Dragging yourself is just switching channels — use the normal
    // join flow (which also connects to the SFU). No MOVE_MEMBERS
    // permission required for moving your own session.
    if (droppedUserId === user?.id) {
      await click();
      return;
    }
    try {
      await (await restForChannel(channel.id)).moveVoiceMember({
        userId: droppedUserId,
        channelId: channel.id,
      });
      // Don't merge locally — the gateway VOICE_STATE_UPDATE
      // dispatch handles the state propagation including the
      // moved user's own session.
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Could not move user',
        'error',
      );
    }
  }

  return (
    <li
      className={`relative transition-opacity ${isDragging ? 'opacity-40' : ''} ${
        isDropBefore ? 'before:absolute before:-top-px before:left-2 before:right-2 before:h-1 before:bg-accent before:rounded-full before:shadow-[0_0_0_2px_rgba(88,101,242,0.35)] before:z-10' : ''
      } ${
        isDropAfter ? 'after:absolute after:-bottom-px after:left-2 after:right-2 after:h-1 after:bg-accent after:rounded-full after:shadow-[0_0_0_2px_rgba(88,101,242,0.35)] after:z-10' : ''
      }`}
      {...(onDragStart
        ? {
            'data-zk-drag-id': channel.id,
            'data-zk-drag-kind': 'channel',
          }
        : {})}
    >
      {/* Row + edit button wrapped together so the edit button can
          position relative to the row alone, not the whole <li>
          (which expands when participants are listed below). Without
          this, top-1.5 would anchor the edit button to the top of an
          expanded <li> and visually drift away from the channel row
          text on the first line. The wrapper ALSO carries the
          drop handlers for the voice-user DnD — drags landing on
          either the button or the participant list count as a
          drop on this channel. */}
      <div
        className="relative group/row"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-zk-voice-user')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!userDropHover) setUserDropHover(true);
          }
        }}
        onDragLeave={(e) => {
          if (
            !e.relatedTarget ||
            !(e.currentTarget as HTMLElement).contains(
              e.relatedTarget as Node,
            )
          ) {
            setUserDropHover(false);
          }
        }}
        onDrop={(e) => {
          const droppedUserId = e.dataTransfer.getData(
            'application/x-zk-voice-user',
          );
          if (droppedUserId) {
            e.preventDefault();
            void handleUserDrop(droppedUserId);
          }
        }}
      >
        <button
          type="button"
          onClick={() => void click()}
          onPointerDown={
            onDragStart
              ? (e) => onDragStart(channel.id, 'channel', `🔊 ${channel.name ?? ''}`, e)
              : undefined
          }
          style={onDragStart ? { touchAction: 'pan-y' } : undefined}
          className={`w-full flex items-center gap-2 px-2 py-1 rounded text-[0.9375rem] text-left transition-colors ${
            userDropHover
              ? 'bg-accent/15 ring-1 ring-accent/60 text-ink-1'
              : active || selfInThis
                ? 'row-active'
                : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3/50'
          }`}
        >
          <span className="relative shrink-0">
            <Volume2 size={14} className="text-accent" />
            {channel.restricted && (
              <Lock
                size={8}
                strokeWidth={3}
                className="absolute -top-1 -right-1.5 text-ink-3"
                aria-label="Restricted channel"
              />
            )}
          </span>
          <span className="truncate flex-1">{channel.name ?? '(unnamed)'}</span>
          {participants.length > 0 && (
            <span className="text-[0.65rem] text-ink-3 shrink-0 group-hover/row:hidden">
              {participants.length}
            </span>
          )}
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit();
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 hidden group-hover/row:flex [@media(hover:none)]:flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
          aria-label={`Edit voice channel ${channel.name ?? ''}`}
          title="Edit channel"
        >
          <Edit size={12} />
        </button>
      </div>
      {participants.length > 0 && (
        <ul className="ml-6 mt-0.5 mb-1 space-y-0.5">
          {participants.map((v) => (
            <VoiceParticipant key={v.userId} userId={v.userId} muted={v.selfMute} deaf={v.selfDeaf} />
          ))}
        </ul>
      )}
    </li>
  );
}

function VoiceParticipant({ userId, muted, deaf }: { userId: string; muted: boolean; deaf: boolean }) {
  // Granular subscriptions (was `useAppState()`).
  const usersById = useAppStateSelector((v) => v.state.usersById);
  const voiceStatesByUser = useAppStateSelector((v) => v.state.voiceStatesByUser);
  const guildsById = useAppStateSelector((v) => v.state.guildsById);
  const membersByGuild = useAppStateSelector((v) => v.state.membersByGuild);
  const rolesByGuild = useAppStateSelector((v) => v.state.rolesByGuild);
  const channelsByGuild = useAppStateSelector((v) => v.state.channelsByGuild);
  const restForChannel = useAppStateSelector((v) => v.restForChannel);
  const state = { usersById, voiceStatesByUser, guildsById, membersByGuild, rolesByGuild, channelsByGuild };
  const { user } = useAuth();
  const toasts = useToasts();
  const u = state.usersById[userId];
  const label = u?.displayName ?? u?.username ?? userId.slice(-5);
  const speaking = useIsSpeaking(userId);
  const tone = avatarColor(userId);
  const initials = label.slice(0, 1).toUpperCase();
  const isSelf = user?.id === userId;
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  // ── Move-to-channel targets ──────────────────────────────────────────
  // The participant's current voice state tells us which guild + channel
  // they're in; move targets are the OTHER voice channels in that guild.
  // Admin/owner status is used as a client-side gate (a proxy for
  // MOVE_MEMBERS — the server enforces the exact permission, so a
  // non-admin mod with explicit MOVE_MEMBERS still works via drag on
  // desktop; this just decides whether to surface the touch menu).
  const vState = state.voiceStatesByUser[userId];
  const moveGuildId = vState?.guildId ?? null;
  const moveCurrentChannelId = vState?.channelId ?? null;
  const guild = moveGuildId ? state.guildsById[moveGuildId] : undefined;
  const isOwner = !!user && !!guild && guild.ownerId === user.id;
  const myMember =
    moveGuildId && user
      ? state.membersByGuild[moveGuildId]?.find((m) => m.userId === user.id)
      : undefined;
  const guildRoles = moveGuildId ? (state.rolesByGuild[moveGuildId] ?? null) : null;
  const canMove =
    !isSelf &&
    !!moveGuildId &&
    memberIsAdmin(guildRoles, moveGuildId, myMember?.roleIds ?? null, isOwner);
  const moveTargets = canMove
    ? (state.channelsByGuild[moveGuildId!] ?? [])
        .filter(
          (c) => c.type === 'guild_voice' && c.id !== moveCurrentChannelId,
        )
        .map((c) => ({ id: c.id, name: c.name ?? '(unnamed)' }))
    : [];

  async function moveTo(channelId: string) {
    try {
      await (await restForChannel(channelId)).moveVoiceMember({ userId, channelId });
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Could not move user',
        'error',
      );
    }
  }

  const { onAvatarClick, cardElement } = useProfileCard({
    guildId: moveGuildId ?? undefined,
  });

  function openPopover(e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) {
    if (isSelf) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    // Anchor at the row's right edge so the popover hangs cleanly
    // off the sidebar instead of overlapping the row label.
    setAnchor({ x: rect.right, y: rect.top });
  }

  return (
    <>
      <li
        className="flex items-center gap-2 px-2 py-1 text-sm text-ink-2 rounded cursor-pointer hover:bg-bg-3/50 active:cursor-grabbing"
        // Left-click opens the user's profile (unless this was the end
        // of a drag — native DnD suppresses the click in that case).
        onClick={(e) => {
          if (u) onAvatarClick(u, e);
        }}
        // Right-click (or long-press → contextmenu) opens the volume /
        // move-to-channel popover for other users.
        onContextMenu={openPopover}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && u) {
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onAvatarClick(u, {
              preventDefault() {},
              stopPropagation() {},
              clientX: r.right,
              clientY: r.top,
            } as unknown as React.MouseEvent);
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={`${label} — click for profile${isSelf ? '' : ', right-click for options'}, drag to move channels`}
        title={isSelf ? 'You — click for profile, drag to switch channels' : 'Click for profile · right-click for volume · drag to move channels'}
        // HTML5 drag-and-drop. Everyone (including yourself) is
        // draggable: dragging yourself switches your channel, dragging
        // others moves them (needs MOVE_MEMBERS, enforced server-side).
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-zk-voice-user', userId);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        {/* Avatar wrapper. When speaking, a conic-gradient ring in
            the Zekktris brand colors rotates slowly behind the avatar,
            peeking out from each edge. Wrapper is a fixed 24px so the
            row layout doesn't shift when speaking flips on. */}
        <div className="relative w-6 h-6 shrink-0">
          {speaking && <SpeakingRing inset={2} />}
          <div
            className={`relative w-6 h-6 rounded-full text-[0.7rem] flex items-center justify-center font-medium overflow-hidden ${tone}`}
          >
            <span className="absolute inset-0 flex items-center justify-center leading-none pointer-events-none">
              {initials}
            </span>
            <AvatarImage src={u?.avatarUrl} />
          </div>
        </div>
        <span className="flex-1 min-w-0 truncate leading-6">{label}</span>
        {(muted || deaf) &&
          (deaf ? (
            <HeadphonesOff size={13} className="text-ink-3 shrink-0" />
          ) : (
            <MicOff size={13} className="text-ink-3 shrink-0" />
          ))}
      </li>
      {cardElement}
      {anchor && (
        <UserVolumePopover
          userId={userId}
          label={label}
          anchor={anchor}
          onClose={() => setAnchor(null)}
          moveTargets={moveTargets}
          onMove={(channelId) => void moveTo(channelId)}
        />
      )}
    </>
  );
}

/**
 * Subscribe to the voice manager's "who's currently speaking" stream
 * and return a boolean for the given user. Used by VoiceParticipant
 * to drive the green ring. Re-renders only when membership flips for
 * THIS user (not on every speaker-set change) thanks to
 * useSyncExternalStore's snapshot semantics.
 */
function useIsSpeaking(userId: string): boolean {
  return useSyncExternalStore(
    subscribeSpeakers,
    () => getCurrentSpeakers().has(userId),
    () => false, // SSR / pre-mount fallback
  );
}
