/**
 * GuildInfoCard
 * -------------
 * Floating quick-action card for a guild. Opens from clicking the guild
 * name in the channel-list header or right-clicking the guild tile in
 * the left rail. Mirrors the `ProfileCard` pattern — Portal-rendered,
 * anchored to a click point, flips up/down based on viewport.
 *
 * Actions:
 *   - Copy invite (jumps to the Invites tab in Server Settings — actual
 *     invite-URL copy lives there, not here)
 *   - Mark all as read (per-guild client-side bulk ack of every channel
 *     with unread state)
 *   - Server settings (any member; tabs gate by ownership server-side)
 *   - Leave server (members only — owner can't leave their own server,
 *     they delete it from the Danger tab)
 *
 * "Member since" / member count would belong here too but our current
 * GuildMember rows only carry per-guild member data once the user opens
 * the MemberList; baking a count into the Guild DTO is a separate,
 * cheap improvement we can do later.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Guild, type GuildFolder } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState, isChannelMuted } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Portal } from '../lib/Portal';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { Plus, UserPlus, Settings, LogOut, Shield, Calendar } from '../lib/icons';

interface AnchorPoint {
  x: number;
  y: number;
}

const CARD_WIDTH = 280;
const CARD_HEIGHT_ESTIMATE = 280;
const VIEWPORT_PADDING = 8;

export function GuildInfoCard({
  guild,
  anchor,
  onClose,
  onOpenSettings,
  onOpenSettingsTab,
  onCreateChannel,
  canCreateChannel,
  onBrowseRoles,
  onOpenEvents,
  folders,
  onMoveToFolder,
  onCreateFolderWithGuild,
}: {
  guild: Guild;
  anchor: AnchorPoint;
  onClose: () => void;
  /** Open Server Settings (caller decides which tab — defaults to Overview). */
  onOpenSettings: () => void;
  /** Open Server Settings on a specific tab — used by Invite People to land
      directly on the Invites tab. Optional; if not supplied the regular
      onOpenSettings is used. */
  onOpenSettingsTab?: (tab: 'overview' | 'roles' | 'invites' | 'members' | 'danger') => void;
  /** Open the Create Channel modal. Optional — wiring is provided by
      ChannelList; the right-click flow from GuildList doesn't pass it. */
  onCreateChannel?: () => void;
  /** Whether the viewer is allowed to create channels in this guild.
      When false the menu hides the Create-channel button entirely. */
  canCreateChannel?: boolean;
  /** Open the Browse Roles modal — lets members opt into/out of
      self-assignable roles. Optional, same back-compat pattern as
      onCreateChannel. The button renders only when this is supplied. */
  onBrowseRoles?: () => void;
  /** Open the Events modal — list of upcoming events with RSVP +
      admin-create. Optional; the button renders only when supplied. */
  onOpenEvents?: () => void;
  /** The user's current rail folders. When supplied the card renders
      a "Move to folder" affordance. Optional because some call sites
      (ChannelList header) don't manage rail folders. */
  folders?: GuildFolder[];
  /** Move this guild to the given folder id, OR to top-level when
      null. */
  onMoveToFolder?: (folderId: string | null) => void;
  /** Create a new folder containing this guild as its first member. */
  onCreateFolderWithGuild?: (name: string) => void;
}) {
  const { rest, user } = useAuth();
  const { state, ackChannel, setNotificationOverride } = useAppState();
  const toasts = useToasts();
  const nav = useNavigate();
  const [pending, setPending] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const isOwner = user?.id === guild.ownerId;

  // Position math — same flip-up/clamp logic as ProfileCard.
  const x = Math.min(
    Math.max(anchor.x, VIEWPORT_PADDING),
    window.innerWidth - CARD_WIDTH - VIEWPORT_PADDING,
  );
  const flipUp = anchor.y + CARD_HEIGHT_ESTIMATE > window.innerHeight - VIEWPORT_PADDING;
  const positionStyle = flipUp
    ? { left: x, bottom: window.innerHeight - anchor.y + 8 }
    : { left: x, top: anchor.y + 8 };

  // Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Mark every channel in this guild as read. We do this client-side by
   * walking the channel list, finding the most-recent message id per
   * channel, and acking them. Channels with zero messages, no unread
   * state, or no lastMessageId are skipped.
   *
   * Could be a single server endpoint for efficiency, but the per-guild
   * channel count is bounded (most guilds < 50 channels) and acks are
   * tiny payloads — round-tripping each is well within budget. If guilds
   * grow, we'll add a `/guilds/:id/ack` bulk route.
   */
  async function markAllRead() {
    if (pending) return;
    setPending(true);
    const channels = state.channelsByGuild[guild.id] ?? [];
    let acked = 0;
    try {
      const work = channels
        .filter((c) => {
          if (!c.lastMessageId) return false;
          // Only ack channels that are actually unread, otherwise we
          // generate write traffic for nothing. lastMessageId differs
          // from the read state's lastMessageId means there's something
          // newer to ack.
          const rs = state.readStateByChannel[c.id];
          return !rs || rs.lastMessageId !== c.lastMessageId;
        })
        .map(async (c) => {
          await ackChannel(c.id, c.lastMessageId!);
          acked++;
        });
      await Promise.all(work);
      toasts.push(
        acked === 0 ? 'Already up to date' : `Marked ${acked} channel${acked === 1 ? '' : 's'} as read`,
        'success',
      );
      onClose();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Mark-as-read failed', 'error');
    } finally {
      setPending(false);
    }
  }

  /**
   * Leave the guild. Two-step: first click prompts confirmation in-card,
   * second click executes. Owners can't leave (the server rejects with
   * 403 telling them to delete instead) — we hide the action for owners
   * client-side as a courtesy.
   */
  async function leave() {
    if (!confirmingLeave) {
      setConfirmingLeave(true);
      return;
    }
    if (pending) return;
    setPending(true);
    try {
      await rest.leaveGuild(guild.id);
      toasts.push(`Left ${guild.name}`, 'success');
      onClose();
      // Server will dispatch GUILD_DELETE for this user; the AppState
      // reducer drops the guild from local state. We navigate to the
      // home (DM) view so the user isn't stranded on a guild URL that
      // no longer resolves.
      nav('/channels/@me');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Leave failed', 'error');
      setConfirmingLeave(false);
    } finally {
      setPending(false);
    }
  }

  function openInvites() {
    if (onOpenSettingsTab) onOpenSettingsTab('invites');
    else onOpenSettings();
    onClose();
  }

  return (
    <Portal>
      {/* Click-outside dismiss layer. */}
      <div
        className="fixed inset-0 z-[80]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-[81] bg-bg-1 border border-line rounded-lg elevation-modal overflow-hidden"
        style={{ ...positionStyle, width: CARD_WIDTH }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — icon + name side by side on the card's own
            background (no distinct banner band, so the top matches
            the colour of the content below). */}
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center gap-3">
            <div
              className={`w-16 h-16 rounded-2xl flex items-center justify-center text-lg font-semibold shrink-0 overflow-hidden ${avatarColor(guild.id)}`}
            >
              {guild.iconUrl ? (
                <img
                  src={guild.iconUrl}
                  alt=""
                  className="w-full h-full rounded-2xl object-cover"
                />
              ) : (
                avatarInitials(guild.name)
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-base text-ink-1 truncate">{guild.name}</div>
              {guild.description && (
                <div className="mt-0.5 text-xs text-ink-2 line-clamp-2">{guild.description}</div>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-1.5">
            {canCreateChannel && onCreateChannel && (
              <button
                onClick={() => {
                  onCreateChannel();
                  onClose();
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
              >
                <Plus size={14} />
                <span>Create channel</span>
              </button>
            )}
            <button
              onClick={openInvites}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
            >
              <UserPlus size={14} />
              <span>Invite people</span>
            </button>

            {onBrowseRoles && (
              <button
                onClick={() => {
                  onBrowseRoles();
                  onClose();
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
              >
                <Shield size={14} />
                <span>Browse roles</span>
              </button>
            )}

            {onOpenEvents && (
              <button
                onClick={() => {
                  onOpenEvents();
                  onClose();
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
              >
                <Calendar size={14} />
                <span>Events</span>
              </button>
            )}

            <button
              disabled={pending}
              onClick={() => void markAllRead()}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors disabled:opacity-60"
            >
              {/* Reusing settings icon is wrong here; using a plain check
                  glyph would be ideal. We use a small inline SVG to avoid
                  adding another lucide import for one button. */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>Mark all as read</span>
            </button>

            {/* Mute / Unmute server. Reading the AppState selector
                directly each render is fine — overrides is a small map.
                The action is optimistic via setNotificationOverride;
                the GuildInfoCard's local pending state isn't toggled
                here because the change feels instant from the user's
                POV (state mutation → next render → updated label). */}
            <button
              onClick={() => {
                const muted = isChannelMuted(state.notificationOverrides, '', guild.id);
                void setNotificationOverride(
                  'guild',
                  guild.id,
                  muted ? null : 'nothing',
                );
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
            >
              {/* Bell glyph (or bell-off when muted). Inline SVG to avoid
                  expanding the icons module for two states. */}
              {state.notificationOverrides[`guild:${guild.id}`] === 'nothing' ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
                    <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
                    <path d="M18 8a6 6 0 0 0-9.33-5" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                  <span>Unmute server</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <span>Mute server</span>
                </>
              )}
            </button>

            <button
              onClick={() => {
                onOpenSettings();
                onClose();
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
            >
              <Settings size={14} />
              <span>Server settings</span>
            </button>

            {/* Folder management. Only renders when the caller wired
                folder state (GuildList passes it; ChannelList does
                not). The flyout below the button is gated by local
                state — keeps the card flat when not active so the
                main actions stay reachable. */}
            {folders && onMoveToFolder && onCreateFolderWithGuild && (
              <FolderPicker
                guildId={guild.id}
                folders={folders}
                onMoveToFolder={(fid) => {
                  onMoveToFolder(fid);
                  onClose();
                }}
                onCreateFolderWithGuild={(name) => {
                  onCreateFolderWithGuild(name);
                  onClose();
                }}
              />
            )}

            {!isOwner && (
              <button
                disabled={pending}
                onClick={() => void leave()}
                className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-red-950/40 text-sm font-medium text-red-400 transition-colors disabled:opacity-60"
              >
                <LogOut size={14} />
                <span>
                  {confirmingLeave ? `Click again to leave ${guild.name}` : 'Leave server'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ── FolderPicker ──────────────────────────────────────────────────────────
//
// A compact, expandable list of folder targets used inline in the
// GuildInfoCard. Three modes:
//   - Default: a single button "Move to folder ▸" that expands the
//     full list inline (no nested popovers — they're a hit-target
//     pain on mobile).
//   - Expanded: each existing folder as a clickable row, plus a
//     "Top-level" row to remove from folders, plus an inline
//     create-folder input.
//
// Click any folder row → onMoveToFolder fires. Submit the create
// input → onCreateFolderWithGuild fires.

function FolderPicker({
  guildId,
  folders,
  onMoveToFolder,
  onCreateFolderWithGuild,
}: {
  guildId: string;
  folders: GuildFolder[];
  onMoveToFolder: (folderId: string | null) => void;
  onCreateFolderWithGuild: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const currentFolder = folders.find((f) => f.guildIds.includes(guildId)) ?? null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
      >
        <span className="flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>
            {currentFolder ? `In: ${currentFolder.name}` : 'Move to folder'}
          </span>
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-ink-3"
          aria-hidden
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1 bg-bg-3/40 rounded-md p-1">
      <button
        onClick={() => onMoveToFolder(null)}
        className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors hover:bg-bg-1 ${
          !currentFolder ? 'text-ink-3' : 'text-ink-1'
        }`}
      >
        <span className="w-3 h-3 rounded-full border border-ink-3" aria-hidden />
        <span>Top-level (no folder){!currentFolder ? ' · current' : ''}</span>
      </button>
      {folders.map((f) => (
        <button
          key={f.id}
          onClick={() => onMoveToFolder(f.id)}
          className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors hover:bg-bg-1 ${
            currentFolder?.id === f.id ? 'text-ink-3' : 'text-ink-1'
          }`}
        >
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: f.color ?? '#5865f2' }}
            aria-hidden
          />
          <span className="truncate">{f.name}</span>
          {currentFolder?.id === f.id && <span className="ml-auto text-[0.65rem]">· current</span>}
        </button>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = newName.trim();
          if (!n) return;
          onCreateFolderWithGuild(n);
          setNewName('');
        }}
        className="flex items-center gap-1 mt-1 px-2"
      >
        <span className="w-3 h-3 flex-shrink-0" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-full h-full text-ink-3">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </span>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New folder name"
          maxLength={40}
          className="flex-1 bg-bg-1 border border-line rounded px-2 py-1 text-xs text-ink-1 focus:outline-none focus:border-accent"
        />
      </form>
    </div>
  );
}
