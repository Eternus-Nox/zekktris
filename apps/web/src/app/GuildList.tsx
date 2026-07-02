/**
 * GuildList
 * ---------
 * The leftmost rail. One circular tile per guild the user is in, plus a +
 * tile at the bottom for creating a new server. Also shows a logout button
 * — for v1 there's no proper user menu, this is the simplest path.
 *
 * Visual state: the active guild gets a tall accent bar at its left edge.
 * Hover state pops the tile slightly via background color change.
 */

import { Link, useLocation } from 'react-router-dom';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector } from '../state/AppState';
import type { Guild, GuildFolder } from '@zekktris/client';
import { Plus, UserPlus, Settings, LogOut, MessageSquare, Compass, Folder, Trash, AtSign, Shield, Users } from '../lib/icons';
import { useParentalControlsEnabled } from '../lib/familyPrefs';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { Portal } from '../lib/Portal';
import { GuildInfoCard } from './GuildInfoCard';
// Lazy-loaded — see ChannelList; same on-demand server-settings modal.
const GuildSettingsModal = lazy(() =>
  import('./GuildSettingsModal').then((m) => ({ default: m.GuildSettingsModal })),
);
import { applyGuildOrder, readGuildOrder, writeGuildOrder } from '../lib/guildOrder';
import {
  buildRailEntries,
  addGuildToFolder,
  removeGuildFromAllFolders,
  createFolder,
  editFolder,
  deleteFolder,
  isFolderCollapsed,
  setFolderCollapsed,
} from '../lib/guildFolders';
import { useGuildDragReorder } from '../lib/useGuildDragReorder';

export function GuildList({ activeGuildId }: { activeGuildId: string | undefined }) {
  // Granular subscriptions (was `useAppState()`): the guild rail re-renders
  // only when the guild set or guild metadata changes, not on every dispatch.
  const guildIds = useAppStateSelector((v) => v.state.guildIds);
  const guildsById = useAppStateSelector((v) => v.state.guildsById);
  const { logout, user, rest } = useAuth();
  const location = useLocation();
  const isDiscoverActive = location.pathname.startsWith('/discover');
  // The new pseudo-areas (mentions, settings, create-server, join-server,
  // accept-invite, admin) all render inside Shell with the guild rail
  // visible alongside their content. The rail tiles below take an
  // `active` flag derived from these paths so the accent pill shows
  // when the user is on that surface.
  const isMentionsActive = location.pathname.startsWith('/mentions');
  const isSettingsActive = location.pathname.startsWith('/settings');
  const isCreateServerActive = location.pathname.startsWith('/create-server');
  const isJoinServerActive = location.pathname.startsWith('/join-server');
  const isAdminActive = location.pathname.startsWith('/admin');
  const isFamilyActive = location.pathname.startsWith('/family');
  const familyEnabled = useParentalControlsEnabled();
  // Minors always get the Family entry (regardless of the opt-in toggle) so
  // they can reach the "connect a guardian" flow; an unlinked/locked minor
  // gets a red attention dot nudging them to do it.
  const isMinor = useAppStateSelector((v) => v.state.supervision?.isMinor ?? false);
  const needsGuardian = useAppStateSelector(
    (v) => v.state.supervision?.restrictedHeavily ?? false,
  );
  const showFamilyEntry = familyEnabled || isMinor;
  // Right-click on a guild tile opens GuildInfoCard anchored to the click.
  // We hoist the state here because the cards are owned by GuildList (one
  // can be open at a time across all tiles). The chosen guild is found
  // via guildsById.
  const [guildInfo, setGuildInfo] = useState<{ guildId: string; x: number; y: number } | null>(null);
  const [guildSettings, setGuildSettings] = useState<{ guildId: string; tab: 'overview' | 'roles' | 'invites' | 'members' | 'danger' } | null>(null);

  // Per-user rail order. Authoritative source is the server's
  // users.guild_order column, populated into auth.user.guildOrder on
  // login / token refresh. localStorage is kept as an offline cache
  // — primarily for the very first paint after page load before the
  // auth context resolves, and as a fallback for the rare case where
  // the user is using an older session that pre-dates the field.
  //
  // Behavior:
  //   - On mount: prefer auth.user.guildOrder if present, else
  //     localStorage. Mirror the server's value into localStorage so
  //     subsequent cold loads start from the right place.
  //   - On reorder: write to the server (fire-and-forget — error
  //     toasts are noisy for a setting), AND mirror to localStorage
  //     as an offline cache so the next reload looks right even if
  //     the auth refresh round-trips slowly.
  //   - On auth.user.guildOrder change (e.g. a different device
  //     wrote a new order, the server pushed it via the next
  //     refresh): adopt it and update localStorage.
  const serverOrder = user?.guildOrder ?? null;
  const [savedOrder, setSavedOrder] = useState<string[]>(() =>
    serverOrder && serverOrder.length > 0 ? serverOrder : readGuildOrder(),
  );
  // Keep client state in sync with the server when auth refreshes
  // pull a different order (cross-device sync). Comparison is cheap;
  // arrays of guild ids stay short. If the server says null/empty we
  // don't clobber an offline-cached order.
  useEffect(() => {
    if (!serverOrder) return;
    const same =
      serverOrder.length === savedOrder.length &&
      serverOrder.every((id, i) => savedOrder[i] === id);
    if (!same) {
      setSavedOrder(serverOrder);
      writeGuildOrder(serverOrder);
    }
    // savedOrder is intentionally NOT in deps — including it would
    // re-fire after our own setSavedOrder above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOrder]);
  const orderedGuildIds = useMemo(
    () => applyGuildOrder(guildIds, savedOrder),
    [guildIds, savedOrder],
  );

  // Resolve guild ids → Guild objects in the same order, used to feed
  // both the raw tile list and the rail entry builder below.
  const orderedGuilds = useMemo(
    () =>
      orderedGuildIds
        .map((id) => guildsById[id])
        .filter((g): g is Guild => Boolean(g)),
    [orderedGuildIds, guildsById],
  );

  // ── Rail folders ────────────────────────────────────────────────────
  // Authoritative source is `user.guildFolders` from auth (server-
  // synced). Local state lets us mutate optimistically without waiting
  // for the round-trip — the PATCH call is fire-and-forget; the next
  // auth refresh will reconcile if anything fails. Pattern mirrors the
  // existing guildOrder handling above.
  const serverFolders = user?.guildFolders ?? null;
  const [savedFolders, setSavedFolders] = useState<GuildFolder[]>(
    () => serverFolders ?? [],
  );
  useEffect(() => {
    if (!serverFolders) return;
    setSavedFolders(serverFolders);
  }, [serverFolders]);

  // Local force-render counter for collapse state — the collapsed set
  // lives in localStorage and is read on every render. Toggling it
  // bumps this counter so the rail re-renders with the new state.
  const [collapseTick, setCollapseTick] = useState(0);

  function commitFolders(next: GuildFolder[]): void {
    setSavedFolders(next);
    void rest.updateGuildFolders(next).catch(() => {
      // Same noisy-toast suppression rationale as guildOrder above:
      // folder writes are preferences, not user-facing operations.
      // Next refresh will sync.
    });
  }

  // Folder context menu — opened by right-click on a folder tile.
  // Holds the folder id + click coordinates so the FolderMenu can
  // position itself at the click point.
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);

  const railEntries = useMemo(
    () => buildRailEntries(orderedGuilds, savedFolders),
    [orderedGuilds, savedFolders],
  );
  // collapseTick is consumed below to ensure FolderTile re-evaluates
  // isFolderCollapsed; not used directly here.
  void collapseTick;

  // Garbage-collect: if a guild the user left is still in the saved
  // order we'll silently filter it out, but ALSO trim it from
  // storage so the localStorage payload doesn't grow unboundedly
  // over months of churn. Cheap idempotent write keyed on the
  // current guild set.
  useEffect(() => {
    if (savedOrder.length === 0) return;
    const present = new Set(guildIds);
    const trimmed = savedOrder.filter((id) => present.has(id));
    if (trimmed.length !== savedOrder.length) {
      writeGuildOrder(trimmed);
      setSavedOrder(trimmed);
    }
  }, [guildIds, savedOrder]);

  const { state: dragState, startDrag, wasJustDragging } = useGuildDragReorder({
    guildIds: orderedGuildIds,
    enabled: true,
    onReorder: (next) => {
      // Optimistic: update local state + offline cache immediately so
      // the rail snaps to the new order without waiting for the round
      // trip. The server call is fire-and-forget — if it fails the
      // next refresh will sync us back to the server's view.
      writeGuildOrder(next);
      setSavedOrder(next);
      void rest.setGuildOrder(next).catch(() => {
        // Swallow — surfacing a toast on every transient network blip
        // for a "preference" setting is noisy. The next /auth/refresh
        // cycle will pull whatever the server has and reconcile.
      });
    },
  });

  return (
    <div className="flex flex-col items-center py-3 gap-2 h-full">
      {/* Home / DMs tile — always at the top, always present. Active when
          the user is in DMs view (Shell passes "@me" as the active id). */}
      <HomeTile active={activeGuildId === '@me'} />

      {/* Mentions inbox — second slot. Sits right under DMs because
          both are "your stuff": private surfaces where the content
          is specifically addressed to you. The brain pairs them
          naturally — checking DMs and checking @-pings are the same
          mental move. */}
      <MentionsTile active={isMentionsActive} />

      {/* Subtle separator between the home/mentions area and the user's guilds. */}
      <div className="w-8 h-px bg-line my-1" aria-hidden />

      {railEntries.map((entry) => {
        if (entry.kind === 'guild') {
          const g = entry.guild;
          const isDragging = dragState.draggingId === g.id;
          const isDropTarget = dragState.targetId === g.id;
          const dropPosition = isDropTarget ? dragState.position : null;
          return (
            <GuildTile
              key={g.id}
              guild={g}
              active={g.id === activeGuildId}
              isDragging={isDragging}
              dropIndicator={dropPosition}
              onPointerDown={(e) => startDrag(g.id, e)}
              wasJustDragging={wasJustDragging}
              onContextMenu={(e) => {
                e.preventDefault();
                setGuildInfo({ guildId: g.id, x: e.clientX, y: e.clientY });
              }}
            />
          );
        }
        // Folder entry: render the folder header tile, then if not
        // collapsed, render the contained guild tiles indented below
        // with a vertical line connecting them. Click on the folder
        // header toggles its collapse state (purely local).
        const folder = entry.folder;
        const collapsed = isFolderCollapsed(folder.id);
        return (
          <div key={folder.id} className="flex flex-col items-center gap-2">
            <FolderTile
              folder={folder}
              guilds={entry.guilds}
              collapsed={collapsed}
              activeGuildId={activeGuildId}
              onToggle={() => {
                setFolderCollapsed(folder.id, !collapsed);
                setCollapseTick((n) => n + 1);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setFolderMenu({ folderId: folder.id, x: e.clientX, y: e.clientY });
              }}
            />
            {!collapsed && (
              <div className="flex flex-col items-center gap-2 relative">
                {/* Connecting accent rail along the left side of the
                    expanded folder children. Subtle visual cue that
                    these tiles belong to the folder above. */}
                <span
                  aria-hidden
                  className="absolute -left-3 top-0 bottom-0 w-px bg-line"
                />
                {entry.guilds.map((g) => {
                  const isDragging = dragState.draggingId === g.id;
                  const isDropTarget = dragState.targetId === g.id;
                  const dropPosition = isDropTarget ? dragState.position : null;
                  return (
                    <GuildTile
                      key={g.id}
                      guild={g}
                      active={g.id === activeGuildId}
                      isDragging={isDragging}
                      dropIndicator={dropPosition}
                      onPointerDown={(e) => startDrag(g.id, e)}
                      wasJustDragging={wasJustDragging}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setGuildInfo({ guildId: g.id, x: e.clientX, y: e.clientY });
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Separator + Discover tile — sits between the user's servers
          and the create-server button. Discover is the "find more
          servers" bridge, so it reads naturally right before "make a
          new one". */}
      <div className="w-8 h-px bg-line my-1" aria-hidden />
      <DiscoverTile active={isDiscoverActive} />

      <Link
        to="/create-server"
        title="Create a server"
        aria-label="Create a server"
        className={`w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
          isCreateServerActive
            ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
            : 'bg-bg-2 hover:bg-bg-3 text-ink-2 hover:text-ink-1 hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
        }`}
      >
        <Plus size={20} />
      </Link>

      <Link
        to="/join-server"
        title="Join with invite"
        aria-label="Join with invite"
        className={`w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
          isJoinServerActive
            ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
            : 'bg-bg-2 hover:bg-bg-3 text-ink-2 hover:text-ink-1 hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
        }`}
      >
        <UserPlus size={18} />
      </Link>

      <div className="flex-1" />

      {user && (
        <div className="flex flex-col items-center gap-2 zk-rail-actions">
          {/* Instance-admin entry point — first in the bottom group
              for users who have it. Sits above Settings because it's
              the highest-context tool (cross-instance reach); only
              rendered when the authenticated user has isAdmin=true.
              Lands on /admin which renders inside Shell so the side
              rails stay visible. Gated again at the page level so a
              direct nav can't sneak past the UI check. */}
          {(user.isAdmin || user.isModerator) && (
            <Link
              to="/admin"
              title="Instance admin"
              aria-label="Instance admin"
              className={`w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
                isAdminActive
                  ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
                  : 'bg-bg-2 hover:bg-accent/20 text-ink-2 hover:text-accent hover:shadow-[inset_0_0_0_1px_var(--accent-glow)]'
              }`}
            >
              <Shield size={18} />
            </Link>
          )}
          {/* Family / parental controls — between Admin and Settings. Opt-in
              for adults (Settings toggle, default off), but ALWAYS shown to a
              minor so they can reach the "connect a guardian" flow. A locked
              (unlinked) minor gets a red attention dot. */}
          {showFamilyEntry && (
            <Link
              to="/family"
              title={needsGuardian ? 'Connect a guardian' : 'Family'}
              aria-label={needsGuardian ? 'Connect a guardian' : 'Family'}
              className={`relative w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
                isFamilyActive
                  ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
                  : 'bg-bg-2 hover:bg-accent/20 text-ink-2 hover:text-accent hover:shadow-[inset_0_0_0_1px_var(--accent-glow)]'
              }`}
            >
              <Users size={18} />
              {needsGuardian && !isFamilyActive && (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500 ring-2 ring-bg-1"
                />
              )}
            </Link>
          )}
          <Link
            to="/settings"
            title="Settings"
            aria-label="Account settings"
            className={`w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
              isSettingsActive
                ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
                : 'bg-bg-2 hover:bg-bg-3 text-ink-2 hover:text-ink-1 hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
            }`}
          >
            <Settings size={18} />
          </Link>
          <button
            onClick={() => void logout()}
            title={`Sign out (${user.username})`}
            aria-label="Sign out"
            className="w-12 h-12 zk-squircle bg-bg-2 hover:bg-red-900/40 text-ink-2 hover:text-red-300 flex items-center justify-center transition-all hover:shadow-[inset_0_0_0_1px_rgba(239,68,68,0.4)]"
          >
            <LogOut size={18} />
          </button>
        </div>
      )}

      {/* Right-click → GuildInfoCard popover. Mounts only while open. */}
      {guildInfo && guildsById[guildInfo.guildId] && (
        <GuildInfoCard
          guild={guildsById[guildInfo.guildId]!}
          anchor={{ x: guildInfo.x, y: guildInfo.y }}
          onClose={() => setGuildInfo(null)}
          onOpenSettings={() => {
            setGuildSettings({ guildId: guildInfo.guildId, tab: 'overview' });
            setGuildInfo(null);
          }}
          onOpenSettingsTab={(tab) => {
            setGuildSettings({ guildId: guildInfo.guildId, tab });
            setGuildInfo(null);
          }}
          folders={savedFolders}
          onMoveToFolder={(folderId) => {
            // null = remove from any folder, send to top-level
            if (folderId === null) {
              commitFolders(removeGuildFromAllFolders(savedFolders, guildInfo.guildId));
            } else {
              commitFolders(addGuildToFolder(savedFolders, folderId, guildInfo.guildId));
            }
          }}
          onCreateFolderWithGuild={(name) => {
            commitFolders(createFolder(savedFolders, name, guildInfo.guildId));
          }}
        />
      )}

      {/* Folder context menu — opens on right-click of a folder tile.
          Same z-layer as the info card, mutually exclusive in
          practice since opening one closes the other via Portal-level
          backdrop dismissal. */}
      {folderMenu && savedFolders.find((f) => f.id === folderMenu.folderId) && (
        <FolderMenu
          folder={savedFolders.find((f) => f.id === folderMenu.folderId)!}
          anchor={{ x: folderMenu.x, y: folderMenu.y }}
          onClose={() => setFolderMenu(null)}
          onRename={(name) => {
            commitFolders(editFolder(savedFolders, folderMenu.folderId, { name }));
          }}
          onColor={(color) => {
            commitFolders(editFolder(savedFolders, folderMenu.folderId, { color }));
          }}
          onDelete={() => {
            commitFolders(deleteFolder(savedFolders, folderMenu.folderId));
            setFolderMenu(null);
          }}
        />
      )}

      {/* GuildSettingsModal opened from the info card. ChannelList already
          renders one for the active guild's gear button; this duplicate is
          for the right-click flow, where the active guild may not match
          the right-clicked one. The two never render simultaneously
          because settingsOpen ≠ guildSettings. */}
      {guildSettings && guildsById[guildSettings.guildId] && (
        <Suspense fallback={null}>
          <GuildSettingsModal
            guild={guildsById[guildSettings.guildId]!}
            initialTab={guildSettings.tab}
            onClose={() => setGuildSettings(null)}
          />
        </Suspense>
      )}

    </div>
  );
}

/** Home / DMs tile. Same shape as GuildTile but routes to /channels/@me. */
function HomeTile({ active }: { active: boolean }) {
  return (
    <Link to="/channels/@me" title="Direct messages" className="relative group">
      {/* Active rail-pin. Sits in the left gutter; cyan with accent
          glow when active, dim white nub on hover when not. The
          box-shadow uses the accent-glow CSS var so it picks up
          whatever palette the user has selected. */}
      <span
        className={`absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 rounded-r transition-all ${
          active
            ? 'h-8 bg-accent shadow-[0_0_12px_var(--accent-glow)]'
            : 'h-2 bg-ink-2 opacity-0 group-hover:opacity-100'
        }`}
        aria-hidden
      />
      <span
        className={`block w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
          active
            ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
            : 'bg-bg-2 text-ink-2 group-hover:bg-bg-3 group-hover:text-ink-1 group-hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
        }`}
      >
        <MessageSquare size={20} />
      </span>
    </Link>
  );
}

/**
 * Discover-servers entry point. Visually identical to HomeTile —
 * same dimensions, same active treatment (gradient fill + glow + tall
 * rail-pin on the left) — to keep the top-of-rail grouping consistent.
 */
function DiscoverTile({ active }: { active: boolean }) {
  return (
    <Link to="/discover" title="Discover servers" className="relative group">
      <span
        className={`absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 rounded-r transition-all ${
          active
            ? 'h-8 bg-accent shadow-[0_0_12px_var(--accent-glow)]'
            : 'h-2 bg-ink-2 opacity-0 group-hover:opacity-100'
        }`}
        aria-hidden
      />
      <span
        className={`block w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
          active
            ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
            : 'bg-bg-2 text-ink-2 group-hover:bg-bg-3 group-hover:text-ink-1 group-hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
        }`}
      >
        <Compass size={20} />
      </span>
    </Link>
  );
}

/**
 * Mentions inbox tile. Routes to /mentions; renders the inbox in the
 * main pane (matching Discover/Admin layout). Same visual shape as
 * HomeTile/DiscoverTile so the top of the rail stays coherent.
 */
function MentionsTile({ active }: { active: boolean }) {
  return (
    <Link to="/mentions" title="Inbox" aria-label="Open mentions inbox" className="relative group">
      <span
        className={`absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 rounded-r transition-all ${
          active
            ? 'h-8 bg-accent shadow-[0_0_12px_var(--accent-glow)]'
            : 'h-2 bg-ink-2 opacity-0 group-hover:opacity-100'
        }`}
        aria-hidden
      />
      <span
        className={`block w-12 h-12 zk-squircle flex items-center justify-center transition-all ${
          active
            ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
            : 'bg-bg-2 text-ink-2 group-hover:bg-bg-3 group-hover:text-ink-1 group-hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
        }`}
      >
        <AtSign size={18} />
      </span>
    </Link>
  );
}

function GuildTile({
  guild,
  active,
  onContextMenu,
  isDragging,
  dropIndicator,
  onPointerDown,
  wasJustDragging,
}: {
  guild: Guild;
  active: boolean;
  /** Right-click handler — used by GuildList to open the GuildInfoCard
      popover at the click point. Preventing default in the handler stops
      the browser's native menu from showing. */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** True while this tile is the source of an active drag (dims it). */
  isDragging?: boolean;
  /** When non-null this tile is the drop target — render an accent
      bar above (`before`) or below (`after`). */
  dropIndicator?: 'before' | 'after' | null;
  /** Wired to the drag hook — captures the source on press and arms
      the long-press / movement-threshold gates. */
  onPointerDown?: (e: React.PointerEvent) => void;
  /** Returns true if a drag JUST completed (within ~250ms). The
      tile's onClick reads this and swallows the synthetic click so
      completing a drag doesn't ALSO navigate the user to the
      dragged server. */
  wasJustDragging?: () => boolean;
}) {
  const initials = avatarInitials(guild.name);
  const tone = avatarColor(guild.id);
  return (
    <Link
      to={`/channels/${guild.id}`}
      title={guild.name}
      className={`relative group transition-opacity ${isDragging ? 'opacity-40' : ''}`}
      // <a> elements are draggable by default — the browser starts
      // its own native HTML5 drag of the link URL on mousedown,
      // hijacking the pointer gesture so our reorder hook never
      // sees pointermove/pointerup. Disabling that returns control
      // to our hook.
      draggable={false}
      onClick={(e) => {
        if (wasJustDragging?.()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      data-zk-guild-drag-id={guild.id}
      // touchAction:none lets the long-press drag fire on iOS Safari;
      // without it the browser claims the gesture as a scroll. The
      // rail is short enough that losing scroll-on-tile isn't a
      // problem — the page itself still scrolls from gaps between
      // tiles.
      style={{ touchAction: 'none' }}
    >
      {/* Drop-indicator bars: rendered above or below the tile when
          another tile is being dragged onto this one. Sits in the
          gap between tiles (the parent flex column has gap-2). */}
      {dropIndicator === 'before' && (
        <span
          aria-hidden
          className="absolute -top-1.5 left-0 right-0 h-1 bg-accent rounded-full shadow-[0_0_6px_rgba(88,101,242,0.6)] pointer-events-none"
        />
      )}
      {dropIndicator === 'after' && (
        <span
          aria-hidden
          className="absolute -bottom-1.5 left-0 right-0 h-1 bg-accent rounded-full shadow-[0_0_6px_rgba(88,101,242,0.6)] pointer-events-none"
        />
      )}
      <span
        className={`absolute -left-3 top-1/2 -translate-y-1/2 w-1.5 rounded-r transition-all ${
          active
            ? 'h-8 bg-accent shadow-[0_0_12px_var(--accent-glow)]'
            : 'h-2 bg-ink-2 opacity-0 group-hover:opacity-100'
        }`}
        aria-hidden
      />
      <span
        className={`block w-12 h-12 zk-squircle transition-all flex items-center justify-center font-semibold overflow-hidden ${
          guild.iconUrl
            ? active
              ? 'shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
              : 'bg-bg-2 group-hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
            : active
              ? 'bg-gradient-to-br from-accent to-accent-2 text-bg-0 shadow-[0_0_0_1px_var(--accent-glow),0_8px_28px_var(--accent-glow)]'
              : tone + ' opacity-90 group-hover:opacity-100 group-hover:shadow-[inset_0_0_0_1px_var(--zk-line-glow)]'
        }`}
      >
        {guild.iconUrl ? (
          <img src={guild.iconUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          initials
        )}
      </span>
    </Link>
  );
}

// ── FolderTile ────────────────────────────────────────────────────────────
//
// A rail tile representing a folder of guilds. Two visual states:
//   - Collapsed: 2x2 grid of mini guild icons inside a tinted square.
//     Compact form that takes one rail slot, same w/h as a GuildTile.
//   - Expanded: same square but with a Folder glyph instead of mini
//     icons (the actual guild tiles render in a separate column
//     below, handled by the parent renderer).
//
// Click toggles collapse. Right-click opens the FolderMenu. Hover
// shows the folder name as a tooltip via the `title` attribute.

const DEFAULT_FOLDER_BG = '#5865f2'; // accent — same as default rail tint

function FolderTile({
  folder,
  guilds,
  collapsed,
  activeGuildId,
  onToggle,
  onContextMenu,
}: {
  folder: GuildFolder;
  guilds: Guild[];
  collapsed: boolean;
  /** When a guild inside this folder is active, the tile borders glow
      so the user knows their current location is "inside" this folder
      even when it's collapsed. */
  activeGuildId: string | undefined;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const containsActive = activeGuildId
    ? guilds.some((g) => g.id === activeGuildId)
    : false;
  // Folder color is applied as a low-alpha background overlay so the
  // mini guild icons inside remain visible at their own colors. When
  // no color is set we fall back to the default accent tint.
  const bg = folder.color ?? DEFAULT_FOLDER_BG;
  const miniGuilds = guilds.slice(0, 4);

  return (
    <button
      type="button"
      onClick={onToggle}
      onContextMenu={onContextMenu}
      title={folder.name}
      aria-label={`${folder.name} folder, ${collapsed ? 'collapsed' : 'expanded'}`}
      className={`relative group w-12 h-12 rounded-2xl hover:rounded-xl transition-all flex items-center justify-center overflow-hidden ${
        containsActive ? 'ring-2 ring-accent' : ''
      }`}
      style={{
        // Low-alpha tint over bg-2 so the folder reads as a "container"
        // and not as a solid colored block. The hex+'33' suffix is a
        // 20% alpha — enough to distinguish, not enough to overpower
        // the contained icons.
        backgroundColor: `${bg}33`,
      }}
    >
      {collapsed ? (
        // 2x2 mini grid. Each cell holds a tiny version of the
        // contained guild icon or initials. Filled top-left first;
        // empty cells stay blank (don't render placeholders — the
        // tinted background reads as "this is a folder" by itself).
        <span className="grid grid-cols-2 grid-rows-2 gap-px w-9 h-9">
          {miniGuilds.map((g) => (
            <span
              key={g.id}
              className={`w-full h-full rounded-sm overflow-hidden flex items-center justify-center text-[0.5rem] font-bold ${
                g.iconUrl ? 'bg-bg-3' : avatarColor(g.id)
              }`}
            >
              {g.iconUrl ? (
                <img src={g.iconUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                avatarInitials(g.name).slice(0, 1)
              )}
            </span>
          ))}
        </span>
      ) : (
        // Expanded: prominent folder glyph since the contained tiles
        // render below. Acts as a "header" for the group.
        <span style={{ color: bg }}>
          <Folder size={22} />
        </span>
      )}
    </button>
  );
}

// ── FolderMenu ────────────────────────────────────────────────────────────
//
// Compact popover anchored to a right-click on a folder tile. Three
// actions: rename (inline input), change color (preset swatches), and
// delete (confirms by requiring a second click within 2s).

const FOLDER_COLOR_PRESETS = [
  null, // default tint
  '#5865f2', // blurple
  '#3ba55d', // green
  '#faa61a', // yellow
  '#ed4245', // red
  '#eb459e', // pink
  '#9b59b6', // purple
  '#2dd4bf', // teal
];

function FolderMenu({
  folder,
  anchor,
  onClose,
  onRename,
  onColor,
  onDelete,
}: {
  folder: GuildFolder;
  anchor: { x: number; y: number };
  onClose: () => void;
  onRename: (name: string) => void;
  onColor: (color: string | null) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Re-confirm delete window: the second click within 2s actually
  // deletes; otherwise the affordance resets so a stray click can't
  // wipe a folder.
  useEffect(() => {
    if (!confirmingDelete) return;
    const t = setTimeout(() => setConfirmingDelete(false), 2000);
    return () => clearTimeout(t);
  }, [confirmingDelete]);

  // Position the menu so it doesn't fall off the right edge. The
  // popover is approximately 220px wide; we clamp to viewport - 16px.
  const left = Math.min(anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 240);
  const top = anchor.y;

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={(e) => {
          // Right-click outside the menu also closes it (matches
          // native context-menu behavior on web).
          e.preventDefault();
          onClose();
        }}
      >
        <div
          className="absolute bg-bg-1 border border-line rounded-md shadow-2xl p-2 w-56 space-y-2"
          style={{ left, top }}
          onClick={(e) => e.stopPropagation()}
        >
          <label className="block">
            <span className="text-[0.65rem] uppercase tracking-wider text-ink-3 font-semibold">
              Folder name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                const trimmed = name.trim();
                if (trimmed && trimmed !== folder.name) onRename(trimmed);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = name.trim();
                  if (trimmed && trimmed !== folder.name) onRename(trimmed);
                  onClose();
                }
                if (e.key === 'Escape') onClose();
              }}
              maxLength={40}
              className="mt-1 w-full bg-bg-2 border border-line rounded px-2 py-1 text-sm text-ink-1 focus:outline-none focus:border-accent"
            />
          </label>
          <div>
            <span className="text-[0.65rem] uppercase tracking-wider text-ink-3 font-semibold">
              Color
            </span>
            <div className="mt-1 grid grid-cols-8 gap-1">
              {FOLDER_COLOR_PRESETS.map((c, i) => (
                <button
                  key={i}
                  onClick={() => onColor(c)}
                  className={`w-6 h-6 rounded-full transition-all ${
                    folder.color === c ? 'ring-2 ring-ink-1 scale-110' : ''
                  }`}
                  style={{
                    backgroundColor: c ?? DEFAULT_FOLDER_BG,
                    opacity: c === null ? 0.5 : 1,
                  }}
                  title={c === null ? 'Default' : c}
                  aria-label={c === null ? 'Default color' : `Color ${c}`}
                />
              ))}
            </div>
          </div>
          <button
            onClick={() => {
              if (confirmingDelete) onDelete();
              else setConfirmingDelete(true);
            }}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-sm text-red-400 hover:bg-red-950/40 transition-colors"
          >
            <Trash size={14} />
            <span>{confirmingDelete ? 'Click again to confirm' : 'Delete folder'}</span>
          </button>
          <p className="text-[0.65rem] text-ink-3 leading-snug">
            Deleting a folder releases its servers back to the rail.
          </p>
        </div>
      </div>
    </Portal>
  );
}
