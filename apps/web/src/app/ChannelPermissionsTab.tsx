/**
 * ChannelPermissionsTab
 * ---------------------
 * Per-channel permission overrides editor. An override targets either
 * a role or an individual member; each override is a pair of bitfields
 * (allow, deny) layered on top of the user's effective base permissions
 * computed from their guild roles.
 *
 * Tri-state per bit:
 *   - allow set, deny clear  → green check  ("explicitly granted here")
 *   - allow clear, deny clear → gray dash   ("inherit from roles")
 *   - allow clear, deny set  → red cross    ("explicitly revoked here")
 *   - both set is undefined behavior; the resolver treats it as "deny
 *     wins" but we never produce that state through this UI.
 *
 * The editor only shows bits whose `scope` is 'channel' or 'voice' —
 * guild-scoped bits (KICK_MEMBERS, MANAGE_GUILD, etc.) aren't
 * meaningful as channel overrides. Voice-scoped bits are filtered
 * out for non-voice channels.
 */
import { useEffect, useState } from 'react';
import { ApiError, type Channel, type GuildMember, type PermissionOverride, type Role } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { Plus, Trash, Search, X } from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { Portal } from '../lib/Portal';
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  channelOverridePermissions,
  hasBit,
  parsePerms,
  permsToString,
  withBit,
} from '../lib/permissions';

type TriState = 'allow' | 'inherit' | 'deny';

function bitTriState(allow: bigint, deny: bigint, bit: number): TriState {
  if (hasBit(allow, bit)) return 'allow';
  if (hasBit(deny, bit)) return 'deny';
  return 'inherit';
}

function applyTriState(
  allow: bigint,
  deny: bigint,
  bit: number,
  next: TriState,
): { allow: bigint; deny: bigint } {
  if (next === 'allow') {
    return { allow: withBit(allow, bit, true), deny: withBit(deny, bit, false) };
  }
  if (next === 'deny') {
    return { allow: withBit(allow, bit, false), deny: withBit(deny, bit, true) };
  }
  return { allow: withBit(allow, bit, false), deny: withBit(deny, bit, false) };
}

type MemberWithUser = GuildMember;

export function ChannelPermissionsTab({ channel }: { channel: Channel }) {
  const { rest } = useAuth();
  const toasts = useToasts();

  const [overrides, setOverrides] = useState<PermissionOverride[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<MemberWithUser[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<{
    type: 'role' | 'member';
    id: string;
  } | null>(null);
  const [picking, setPicking] = useState(false);
  // Tracks the in-flight "sync to category" loop. Disables the button
  // while the per-override DELETE calls are still pending so the user
  // can't fire it twice.
  const [syncing, setSyncing] = useState(false);

  const guildId = channel.guildId;

  async function refresh() {
    if (!guildId) return;
    try {
      const [overR, rolesR, membersR] = await Promise.all([
        rest.listChannelOverrides(channel.id),
        rest.listRoles(guildId),
        rest.listMembers(guildId, { limit: 100 }),
      ]);
      setOverrides(overR.overrides);
      setRoles(rolesR.roles);
      setMembers(membersR.members);
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Failed to load overrides',
        'error',
      );
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  if (!guildId) {
    return <p className="text-sm text-ink-3">Permissions are only available on guild channels.</p>;
  }
  if (overrides === null) {
    return <p className="text-sm text-ink-3">Loading permissions…</p>;
  }

  const rolesById = new Map<string, Role>(roles.map((r) => [r.id, r]));
  const membersByUserId = new Map<string, MemberWithUser>(members.map((m) => [m.userId, m]));

  function targetLabel(o: PermissionOverride): string {
    if (o.targetType === 'role') {
      const r = rolesById.get(o.targetId);
      return r ? r.name : '(deleted role)';
    }
    const m = membersByUserId.get(o.targetId);
    return m?.user?.displayName ?? m?.user?.username ?? `User ${o.targetId.slice(-5)}`;
  }

  // Identify the selected override (or null if just-added with no row yet)
  const selected = selectedTarget
    ? overrides.find(
        (o) => o.targetType === selectedTarget.type && o.targetId === selectedTarget.id,
      ) ?? {
        // Optimistic placeholder — empty allow+deny so the editor renders
        // entirely "inherit." Actual row creates server-side on first
        // tri-state click.
        channelId: channel.id,
        targetType: selectedTarget.type,
        targetId: selectedTarget.id,
        allow: '0',
        deny: '0',
      }
    : null;

  async function addOverride(target: { type: 'role' | 'member'; id: string }) {
    setSelectedTarget(target);
    setPicking(false);
    // Don't immediately PUT — let the user pick at least one bit first
    // so we don't create a no-op override that just deletes itself.
  }

  async function deleteOverride(o: PermissionOverride) {
    try {
      await rest.deleteChannelOverride(channel.id, o.targetId, o.targetType);
      setOverrides((prev) => (prev ?? []).filter((x) => x !== o));
      if (
        selectedTarget?.type === o.targetType &&
        selectedTarget?.id === o.targetId
      ) {
        setSelectedTarget(null);
      }
      toasts.push('Override deleted', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    }
  }

  async function syncToCategory() {
    if (!overrides || overrides.length === 0) return;
    if (!window.confirm(
      `Sync this channel's permissions to its category? This will clear all ${overrides.length} ` +
      `override${overrides.length === 1 ? '' : 's'} on this channel. The channel will then inherit ` +
      `its permissions directly from the category.`,
    )) return;
    setSyncing(true);
    let failed = 0;
    // Snapshot before mutating so concurrent additions during the
    // loop don't cause us to delete fresh ones.
    const snapshot = [...overrides];
    for (const o of snapshot) {
      try {
        await rest.deleteChannelOverride(channel.id, o.targetId, o.targetType);
      } catch {
        failed += 1;
      }
    }
    setSyncing(false);
    if (failed > 0) {
      toasts.push(
        `Synced with ${failed} override${failed === 1 ? '' : 's'} that couldn't be removed`,
        'error',
      );
    } else {
      toasts.push('Synced to category', 'success');
    }
    void refresh();
  }

  // Filter the editable bits to channel + (voice if voice channel) scope.
  const editableBits = channelOverridePermissions(channel.type);

  // Whether the "Sync to category" affordance is shown. Hide for:
  //   - DM channels (no guildId — already handled above)
  //   - Categories themselves (a category can't sync to its own parent;
  //     they live at the top level of the permission hierarchy)
  //   - Channels with no parent (nothing to sync to)
  //   - Channels with no current overrides (the sync would be a no-op)
  const canSync =
    channel.type !== 'guild_category' &&
    channel.parentId != null &&
    overrides.length > 0;

  return (
    <div className="flex gap-4 min-h-[400px]">
      {/* Left: list of existing overrides + add */}
      <div className="w-56 shrink-0 border border-line rounded-md bg-bg-2 overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b border-line flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Overrides</span>
          <button
            onClick={() => setPicking(true)}
            className="w-6 h-6 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
            aria-label="Add override"
            title="Add override"
          >
            <Plus size={14} />
          </button>
        </div>
        {canSync && (
          /* Sync-to-category. Bulk-clears this channel's overrides
             so the resolver falls through to the parent category's
             overrides — the channel "inherits" the category's
             permissions wholesale. Shown only when this channel
             has both a parent AND existing overrides; otherwise
             the affordance would be a no-op. */
          <div className="px-3 py-2 border-b border-line bg-amber-500/5">
            <button
              type="button"
              onClick={() => void syncToCategory()}
              disabled={syncing}
              className="w-full text-xs text-amber-300 hover:text-amber-200 text-left disabled:opacity-50 flex items-center gap-1.5"
              title="Reset to category permissions"
            >
              <span>↻</span>
              <span>{syncing ? 'Syncing…' : 'Sync to category'}</span>
            </button>
            <p className="text-[0.65rem] text-ink-3 mt-0.5 leading-snug">
              Clear this channel's overrides and inherit from the category.
            </p>
          </div>
        )}
        <ul className="flex-1 overflow-y-auto scrollbar-thin">
          {overrides.length === 0 && !selectedTarget ? (
            <li className="p-3 text-xs text-ink-3">
              No overrides. Click + to add a role or member exception.
            </li>
          ) : (
            overrides.map((o) => {
              const isSelected =
                selectedTarget?.type === o.targetType && selectedTarget?.id === o.targetId;
              return (
                <li
                  key={`${o.targetType}-${o.targetId}`}
                  className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer text-sm ${
                    isSelected ? 'bg-bg-3' : 'hover:bg-bg-3/50'
                  }`}
                  onClick={() =>
                    setSelectedTarget({ type: o.targetType, id: o.targetId })
                  }
                >
                  <span
                    className={`text-[0.6rem] uppercase font-semibold tracking-wider px-1 py-0.5 rounded ${
                      o.targetType === 'role' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'
                    }`}
                  >
                    {o.targetType === 'role' ? 'Role' : 'User'}
                  </span>
                  <span className="flex-1 truncate">{targetLabel(o)}</span>
                </li>
              );
            })
          )}
          {/* Show a row for the just-added (optimistic) selected target if
              it doesn't exist on the server yet. */}
          {selectedTarget &&
            !overrides.some(
              (o) =>
                o.targetType === selectedTarget.type && o.targetId === selectedTarget.id,
            ) && (
              <li className="flex items-center gap-2 px-2 py-1.5 bg-bg-3 text-sm">
                <span
                  className={`text-[0.6rem] uppercase font-semibold tracking-wider px-1 py-0.5 rounded ${
                    selectedTarget.type === 'role' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'
                  }`}
                >
                  {selectedTarget.type === 'role' ? 'Role' : 'User'}
                </span>
                <span className="flex-1 truncate text-ink-3">
                  {selectedTarget.type === 'role'
                    ? rolesById.get(selectedTarget.id)?.name ?? selectedTarget.id
                    : membersByUserId.get(selectedTarget.id)?.user?.displayName ??
                      membersByUserId.get(selectedTarget.id)?.user?.username ??
                      selectedTarget.id}{' '}
                  (new)
                </span>
              </li>
            )}
        </ul>
      </div>

      {/* Right: editor for selected, or empty state */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <OverrideEditor
            key={`${selected.targetType}-${selected.targetId}`}
            channelId={channel.id}
            override={selected}
            label={
              selected.targetType === 'role'
                ? rolesById.get(selected.targetId)?.name ?? selected.targetId
                : membersByUserId.get(selected.targetId)?.user?.displayName ??
                  membersByUserId.get(selected.targetId)?.user?.username ??
                  selected.targetId
            }
            editableBits={editableBits}
            onSaved={async () => {
              await refresh();
            }}
            onDelete={() => void deleteOverride(selected)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-ink-3 text-sm space-y-2">
            <p>Select an override to edit, or add a new one.</p>
          </div>
        )}
      </div>

      {/* Modal: target picker */}
      {picking && (
        <TargetPicker
          roles={roles.filter((r) => !overrides.some((o) => o.targetType === 'role' && o.targetId === r.id))}
          members={members.filter(
            (m) => !overrides.some((o) => o.targetType === 'member' && o.targetId === m.userId),
          )}
          onPick={addOverride}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  );
}

// ── Override editor (tri-state per bit) ─────────────────────────────────────

function OverrideEditor({
  channelId,
  override,
  label,
  editableBits,
  onSaved,
  onDelete,
}: {
  channelId: string;
  override: PermissionOverride;
  label: string;
  editableBits: typeof PERMISSIONS;
  onSaved: () => Promise<void>;
  onDelete: () => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [allow, setAllow] = useState<bigint>(parsePerms(override.allow));
  const [deny, setDeny] = useState<bigint>(parsePerms(override.deny));
  const [saving, setSaving] = useState(false);

  const dirty = allow !== parsePerms(override.allow) || deny !== parsePerms(override.deny);

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      // Server deletes the row when both allow & deny are 0n; that
      // matches our "user reset everything to inherit" semantics.
      await rest.putChannelOverride(channelId, override.targetId, {
        type: override.targetType,
        allow: permsToString(allow),
        deny: permsToString(deny),
      });
      toasts.push('Override saved', 'success');
      await onSaved();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  // Group the editable bits by category, same as the role editor for
  // visual consistency.
  const groups = PERMISSION_GROUPS.map((g) => ({
    ...g,
    items: editableBits.filter((p) => p.group === g.id),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4">
      <div>
        <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
          {override.targetType === 'role' ? 'Role override' : 'Member override'}
        </span>
        <div className="mt-1 px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1">
          {label}
        </div>
      </div>

      <p className="text-xs text-ink-3">
        Choose <span className="text-emerald-400">Allow</span> to grant a permission here even if
        the role doesn't have it; <span className="text-red-400">Deny</span> to revoke it; or
        <span className="text-ink-2"> Inherit</span> to leave whatever the role already says.
      </p>

      {groups.map((g) => (
        <div key={g.id} className="border border-line rounded-md bg-bg-2 overflow-hidden">
          <div className="px-3 py-1.5 text-xs font-semibold text-ink-2 bg-bg-3 border-b border-line">
            {g.label}
          </div>
          <ul className="divide-y divide-line/50">
            {g.items.map((p) => {
              const tri = bitTriState(allow, deny, p.bit);
              return (
                <li key={p.bit} className="flex items-center gap-3 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink-1">{p.label}</div>
                    <div className="text-xs text-ink-3">{p.description}</div>
                  </div>
                  <TriToggle
                    value={tri}
                    onChange={(next) => {
                      const r = applyTriState(allow, deny, p.bit, next);
                      setAllow(r.allow);
                      setDeny(r.deny);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="flex items-center pt-3 border-t border-line">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm"
        >
          <Trash size={14} />
          <span>Remove override</span>
        </button>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Tri-state segmented toggle: ✗ — ✓
function TriToggle({
  value,
  onChange,
}: {
  value: TriState;
  onChange: (v: TriState) => void;
}) {
  const buttons: Array<{ v: TriState; label: string; cls: string }> = [
    {
      v: 'deny',
      label: '\u2715', // ✕
      cls:
        value === 'deny'
          ? 'bg-red-500/30 text-red-300 ring-1 ring-red-400/50'
          : 'text-ink-3 hover:text-red-300 hover:bg-red-500/10',
    },
    {
      v: 'inherit',
      label: '—', // —
      cls:
        value === 'inherit'
          ? 'bg-bg-3 text-ink-1 ring-1 ring-line'
          : 'text-ink-3 hover:text-ink-1 hover:bg-bg-3',
    },
    {
      v: 'allow',
      label: '\u2713', // ✓
      cls:
        value === 'allow'
          ? 'bg-emerald-500/30 text-emerald-300 ring-1 ring-emerald-400/50'
          : 'text-ink-3 hover:text-emerald-300 hover:bg-emerald-500/10',
    },
  ];
  return (
    <div className="inline-flex shrink-0 bg-bg-1 border border-line rounded-md overflow-hidden">
      {buttons.map((b) => (
        <button
          key={b.v}
          type="button"
          onClick={() => onChange(b.v)}
          className={`w-8 h-7 flex items-center justify-center text-sm font-semibold transition-colors ${b.cls}`}
          aria-label={b.v}
          title={b.v[0]!.toUpperCase() + b.v.slice(1)}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

// ── Target picker (modal-within-modal) ──────────────────────────────────────

function TargetPicker({
  roles,
  members,
  onPick,
  onCancel,
}: {
  roles: Role[];
  members: MemberWithUser[];
  onPick: (target: { type: 'role' | 'member'; id: string }) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'role' | 'member'>('role');

  const filteredRoles = roles.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));
  const filteredMembers = members.filter((m) => {
    const text = `${m.user?.username ?? ''} ${m.user?.displayName ?? ''}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4"
        onClick={onCancel}
      >
      <div
        className="bg-bg-1 border border-line rounded-lg shadow-xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-base font-semibold">Add override for…</h2>
          <button
            onClick={onCancel}
            className="w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-line space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setTab('role')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === 'role'
                  ? 'bg-accent text-white'
                  : 'bg-bg-2 text-ink-2 hover:bg-bg-3'
              }`}
            >
              Role
            </button>
            <button
              onClick={() => setTab('member')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                tab === 'member'
                  ? 'bg-accent text-white'
                  : 'bg-bg-2 text-ink-2 hover:bg-bg-3'
              }`}
            >
              Member
            </button>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === 'role' ? 'Search roles…' : 'Search members…'}
              className="w-full pl-9 pr-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
              autoFocus
            />
          </div>
        </div>
        <ul className="max-h-72 overflow-y-auto scrollbar-thin">
          {tab === 'role'
            ? filteredRoles.length === 0
              ? <li className="px-5 py-6 text-sm text-ink-3 text-center">
                  No matching roles. (Roles already overridden are hidden.)
                </li>
              : filteredRoles.map((r) => {
                  const color = r.color
                    ? '#' + r.color.toString(16).padStart(6, '0')
                    : '#99aab5';
                  return (
                    <li key={r.id}>
                      <button
                        onClick={() => onPick({ type: 'role', id: r.id })}
                        className="w-full text-left px-5 py-2.5 hover:bg-bg-3 text-sm flex items-center gap-2"
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                          aria-hidden
                        />
                        <span>{r.name}</span>
                      </button>
                    </li>
                  );
                })
            : filteredMembers.length === 0
              ? <li className="px-5 py-6 text-sm text-ink-3 text-center">
                  No matching members.
                </li>
              : filteredMembers.map((m) => (
                  <li key={m.userId}>
                    <button
                      onClick={() => onPick({ type: 'member', id: m.userId })}
                      className="w-full text-left px-5 py-2.5 hover:bg-bg-3 text-sm flex items-center gap-2"
                    >
                      <div className={`relative w-6 h-6 rounded-full text-[0.65rem] flex items-center justify-center font-semibold shrink-0 overflow-hidden ${avatarColor(m.userId)}`}>
                        <span aria-hidden="true" className="zk-avatar-initials">{avatarInitials(m.user?.displayName ?? m.user?.username)}</span>
                        <AvatarImage src={m.user?.avatarUrl} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{m.user?.displayName ?? m.user?.username ?? m.userId}</div>
                        <div className="text-xs text-ink-3 truncate">@{m.user?.username ?? '—'}</div>
                      </div>
                    </button>
                  </li>
                ))}
        </ul>
      </div>
      </div>
    </Portal>
  );
}
