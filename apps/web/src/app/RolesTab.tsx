/**
 * RolesTab
 * --------
 * Two-pane layout: roles list on the left, editor on the right. Click
 * a role to edit; the editor lets you change name, color, hoist,
 * mentionable, and the 30-bit permission grid.
 *
 * Display order is highest-position first (= "highest in hierarchy"),
 * with @everyone always pinned to the bottom. Role moves use up/down
 * arrows that swap adjacent positions — simpler than drag-and-drop
 * but accessible and keyboard-friendly. Bigger reorder UX (drag
 * handles, multi-select) is deferred polish.
 *
 * Two safety nets in the editor:
 *   1. The @everyone role can't be renamed, hoisted, or made
 *      mentionable. Its only editable field is its permissions.
 *   2. ADMINISTRATOR is shown but flagged with a warning banner — its
 *      semantics ("bypass every other check") are dangerous enough to
 *      surface explicitly so users don't grant it casually.
 */
import { useEffect, useState } from 'react';
import { ApiError, type Guild, type Role } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Plus, Trash, AlertTriangle, GripVertical } from '../lib/icons';
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  hasBit,
  parsePerms,
  permsToString,
  withBit,
} from '../lib/permissions';

// Default color shown when a role has no custom color (server returns 0).
// We use a neutral gray; named roles get their custom hex applied.
const DEFAULT_ROLE_COLOR = '#99aab5';

export function RolesTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const { loadRoles } = useAppState();
  const toasts = useToasts();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      // loadRoles fetches from REST and dispatches ROLES_SET — this
      // gives us a single source of truth: AppState's rolesByGuild.
      // Other views (member list color, message author color, settings
      // gating) read from there and stay in sync without their own
      // listRoles call.
      // loadRoles fetches + dispatches ROLES_SET (single source of truth
      // other views read) AND returns the roles, so we sort that payload
      // directly — no second listRoles round-trip.
      const fetched = await loadRoles(guild.id);
      const sorted = [...fetched].sort((a, b) => {
        if (a.id === guild.id) return 1;
        if (b.id === guild.id) return -1;
        return b.position - a.position;
      });
      setRoles(sorted);
      if (selectedId === null) {
        const first = sorted.find((r) => r.id !== guild.id);
        if (first) setSelectedId(first.id);
        else if (sorted.length > 0) setSelectedId(sorted[0]!.id);
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to load roles', 'error');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  async function createRole() {
    setCreating(true);
    try {
      const r = await rest.createRole(guild.id, { name: 'new role' });
      await refresh();
      setSelectedId(r.role.id);
      toasts.push('Role created', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to create role', 'error');
    } finally {
      setCreating(false);
    }
  }

  /**
   * Drop role `dragId` at the position currently occupied by `targetId`,
   * shifting other roles to make room. Sends the recomputed positions
   * for every moved role in a single `reorderRoles` call so the change
   * is atomic — no intermediate states where the order is inconsistent.
   *
   * @everyone is filtered out of both source and target lists; trying
   * to reorder it would be a server-side reject anyway.
   */
  async function dropRole(dragId: string, targetId: string) {
    if (!roles || dragId === targetId) return;
    const moveable = roles.filter((r) => r.id !== guild.id);
    // Sort by position desc so visual top = highest position. We rebuild
    // the array with dragId moved to targetId's slot, then reassign
    // positions in descending steps starting from the original max.
    const sorted = [...moveable].sort((a, b) => b.position - a.position);
    const fromIdx = sorted.findIndex((r) => r.id === dragId);
    const toIdx = sorted.findIndex((r) => r.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [picked] = sorted.splice(fromIdx, 1);
    sorted.splice(toIdx, 0, picked!);
    // Reassign positions: top role gets the original highest position,
    // each next gets one less. Only emit positions for roles whose new
    // position differs from their old position — keeps the request small.
    const positions: Array<{ id: string; position: number }> = [];
    const maxPos = Math.max(...moveable.map((r) => r.position));
    sorted.forEach((r, i) => {
      const newPos = maxPos - i;
      if (r.position !== newPos) {
        positions.push({ id: r.id, position: newPos });
      }
    });
    if (positions.length === 0) return;
    try {
      await rest.reorderRoles(guild.id, positions);
      await refresh();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Reorder failed', 'error');
    }
  }

  if (!roles) return <p className="text-sm text-ink-3">Loading roles…</p>;

  const selected = roles.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-col sm:flex-row gap-4 -mx-1 -my-1 min-h-[400px]">
      {/* List pane — full width on mobile (with capped height so it
          doesn't shove the editor offscreen), fixed-width sidebar
          on tablet+ */}
      <div className="w-full sm:w-56 shrink-0 max-h-48 sm:max-h-none border border-line rounded-md bg-bg-2 overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b border-line flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Roles</span>
          <button
            onClick={() => void createRole()}
            disabled={creating}
            className="w-6 h-6 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40"
            aria-label="Create role"
            title="Create role"
          >
            <Plus size={14} />
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto scrollbar-thin">
          {roles.map((role, i) => (
            <DraggableRoleRow
              key={role.id}
              role={role}
              isLast={i === roles.length - 1}
              isEveryone={role.id === guild.id}
              selected={selectedId === role.id}
              onSelect={() => setSelectedId(role.id)}
              onDropOnto={(dragId) => void dropRole(dragId, role.id)}
            />
          ))}
        </ul>
      </div>

      {/* Editor pane */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <RoleEditor
            key={selected.id}
            role={selected}
            isEveryone={selected.id === guild.id}
            onChanged={(updated) => {
              setRoles((prev) =>
                prev
                  ? prev.map((r) => (r.id === updated.id ? updated : r))
                  : prev,
              );
            }}
            onDeleted={(id) => {
              setRoles((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
              setSelectedId(null);
            }}
          />
        ) : (
          <p className="text-sm text-ink-3">Select a role to edit, or create a new one.</p>
        )}
      </div>
    </div>
  );
}

// ── Role editor ────────────────────────────────────────────────────────────

function RoleEditor({
  role,
  isEveryone,
  onChanged,
  onDeleted,
}: {
  role: Role;
  isEveryone: boolean;
  onChanged: (next: Role) => void;
  onDeleted: (id: string) => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  // Local form state. Reset on role-id change via the `key` prop in the
  // parent, so we don't need useEffect to mirror prop → state on
  // selection switch.
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<number>(role.color);
  const [hoist, setHoist] = useState(role.hoist);
  const [mentionable, setMentionable] = useState(role.mentionable);
  const [perms, setPerms] = useState<bigint>(parsePerms(role.permissions));
  const [selfAssignable, setSelfAssignable] = useState<boolean>(role.selfAssignable ?? false);
  const [description, setDescription] = useState<string>(role.description ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  // The user's current values vs. the server's last-known. We compare
  // directly so the Save button only enables when something actually
  // changed; reduces chance of accidental no-op writes.
  const dirty =
    name !== role.name ||
    color !== role.color ||
    hoist !== role.hoist ||
    mentionable !== role.mentionable ||
    perms !== parsePerms(role.permissions) ||
    selfAssignable !== (role.selfAssignable ?? false) ||
    description !== (role.description ?? '');

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      // Send only changed fields. The PATCH route requires at least one
      // field, and unchanged fields might trip the no-op detector or
      // (worse) accidentally roll back a value another admin just set.
      const patch: Parameters<typeof rest.patchRole>[2] = {};
      if (name !== role.name && !isEveryone) patch.name = name;
      if (color !== role.color) patch.color = color;
      if (hoist !== role.hoist && !isEveryone) patch.hoist = hoist;
      if (mentionable !== role.mentionable && !isEveryone) patch.mentionable = mentionable;
      if (perms !== parsePerms(role.permissions)) patch.permissions = permsToString(perms);
      if (selfAssignable !== (role.selfAssignable ?? false) && !isEveryone) {
        patch.selfAssignable = selfAssignable;
      }
      if (description !== (role.description ?? '')) {
        // Empty string clears server-side; the service normalizes
        // whitespace to null.
        patch.description = description.trim().length > 0 ? description : null;
      }
      const r = await rest.patchRole(role.guildId, role.id, patch);
      onChanged(r.role);
      toasts.push('Role saved', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    setSaving(true);
    try {
      await rest.deleteRole(role.guildId, role.id);
      onDeleted(role.id);
      toasts.push('Role deleted', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  const adminGranted = hasBit(perms, 0); // bit 0 = ADMINISTRATOR

  return (
    <div className="space-y-4">
      {/* Header — name + color side by side. @everyone has its name
          field replaced with a hard-coded label since it's not editable. */}
      <div className="flex items-end gap-3">
        {isEveryone ? (
          <div className="flex-1">
            <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Role</span>
            <div className="mt-1 px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-2">
              @everyone (default permissions for all members)
            </div>
          </div>
        ) : (
          <label className="flex-1 block">
            <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Role name</span>
            <input
              type="text"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
            />
          </label>
        )}
        <label className="block w-24 shrink-0">
          <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Color</span>
          <input
            type="color"
            value={'#' + color.toString(16).padStart(6, '0')}
            onChange={(e) => setColor(parseInt(e.target.value.slice(1), 16))}
            className="mt-1 w-full h-9 bg-bg-2 border border-line rounded-md cursor-pointer"
          />
        </label>
      </div>

      {/* Hoist + Mentionable. Hidden for @everyone — both are no-ops there.
          Single column on mobile so the descriptive copy doesn't wrap to
          one word per line; 2-column on tablet+ where the cards fit
          comfortably side-by-side. The text span uses flex-1 + min-w-0
          so the descriptive copy wraps inside the card rather than
          spilling out of the right edge. */}
      {!isEveryone && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex items-start gap-2 px-3 py-2 bg-bg-2 border border-line rounded-md cursor-pointer">
            <input
              type="checkbox"
              checked={hoist}
              onChange={(e) => setHoist(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span className="text-sm flex-1 min-w-0">
              <span className="block font-medium">Display separately</span>
              <span className="block text-xs text-ink-3 mt-0.5 leading-snug">
                Members with this role appear in their own group in the member list.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 px-3 py-2 bg-bg-2 border border-line rounded-md cursor-pointer">
            <input
              type="checkbox"
              checked={mentionable}
              onChange={(e) => setMentionable(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span className="text-sm flex-1 min-w-0">
              <span className="block font-medium">Allow mention</span>
              <span className="block text-xs text-ink-3 mt-0.5 leading-snug">
                Anyone can @-mention this role to notify everyone in it.
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Self-assignable opt-in. Members can grant/revoke this role
          for themselves from the Browse Roles modal when this is on.
          The description input appears only when self-assign is
          enabled — keeps the form compact for the common
          admin-only-role case. Disabled for managed roles (system-
          controlled membership semantics). */}
      {!isEveryone && (
        <div className="space-y-2">
          <label className={`flex items-start gap-2 px-3 py-2 border rounded-md ${
            role.managed
              ? 'bg-bg-2/50 border-line opacity-60 cursor-not-allowed'
              : 'bg-bg-2 border-line cursor-pointer'
          }`}>
            <input
              type="checkbox"
              checked={selfAssignable}
              disabled={role.managed}
              onChange={(e) => setSelfAssignable(e.target.checked)}
              className="mt-0.5 shrink-0"
            />
            <span className="text-sm flex-1 min-w-0">
              <span className="block font-medium">Members can self-assign</span>
              <span className="block text-xs text-ink-3 mt-0.5 leading-snug">
                {role.managed
                  ? 'Managed roles are controlled by the system and cannot be self-assigned.'
                  : 'Members can grant or revoke this role for themselves from the Browse Roles menu. Useful for interest groups (e.g. "Movie Night Pings") and opt-in name colors.'}
              </span>
            </span>
          </label>
          {selfAssignable && (
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                Description <span className="text-ink-3 normal-case font-normal">(optional, ≤ 200 chars)</span>
              </span>
              <input
                type="text"
                value={description}
                maxLength={200}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Gets pinged when we host movie night"
                className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1 outline-none focus:border-accent"
              />
              <span className="block text-xs text-ink-3 mt-1">
                Shown to members in the Browse Roles menu so they know what they're opting in to.
              </span>
            </label>
          )}
        </div>
      )}

      {/* Admin warning — surfaces the "this overrides everything" semantics
          since it's the most common foot-gun in a permission system. */}
      {adminGranted && (
        <div className="flex items-start gap-2 px-3 py-2 border border-amber-500/40 bg-amber-500/5 rounded-md text-amber-200 text-xs">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            <strong className="text-amber-300">Administrator</strong> bypasses every other permission
            check. Members with this role can do anything regardless of channel overrides. Grant carefully.
          </div>
        </div>
      )}

      {/* Permission grid */}
      <div className="space-y-3">
        <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Permissions</span>
        {PERMISSION_GROUPS.map((group) => {
          const items = PERMISSIONS.filter((p) => p.group === group.id);
          if (items.length === 0) return null;
          return (
            <div key={group.id} className="border border-line rounded-md bg-bg-2 overflow-hidden">
              <div className="px-3 py-1.5 text-xs font-semibold text-ink-2 bg-bg-3 border-b border-line">
                {group.label}
              </div>
              <ul className="divide-y divide-line/50">
                {items.map((p) => {
                  const on = hasBit(perms, p.bit);
                  return (
                    <li key={p.bit} className="flex items-start gap-3 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-ink-1">{p.label}</div>
                        <div className="text-xs text-ink-3">{p.description}</div>
                      </div>
                      <Toggle
                        checked={on}
                        onChange={(next) => setPerms((prev) => withBit(prev, p.bit, next))}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Footer: delete + save */}
      <div className="flex items-center pt-3 border-t border-line">
        {!isEveryone && (
          <div className="flex-1">
            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm"
              >
                <Trash size={14} />
                <span>Delete role</span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void destroy()}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
                >
                  Confirm delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1.5 rounded-md text-ink-2 hover:bg-bg-3 text-sm"
                >
                  Cancel
                </button>
              </span>
            )}
          </div>
        )}
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

// ── Toggle switch ──────────────────────────────────────────────────────────
//
// Visual toggle for permission bits. We use a styled checkbox rather
// than a native one because the standard checkbox UX doesn't read as
// "permission allow/deny" at a glance. This is purely cosmetic — the
// underlying input is still a real checkbox so screen readers and
// keyboard navigation work correctly.

function Toggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <div
        className={`w-9 h-5 rounded-full transition-colors ${
          checked ? 'bg-emerald-500' : 'bg-bg-3'
        }`}
      />
      <div
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </label>
  );
}

// ── Draggable role row ─────────────────────────────────────────────────────
//
// HTML5 drag-and-drop is fiddly but plenty for a vertical list. The
// API surface we use:
//   - draggable: true on the row makes it pick-up-able
//   - dragstart: stash the role id in dataTransfer so drop can read it
//   - dragover: must preventDefault to allow a drop, also used to draw
//     the "you can drop here" indicator line above the target row
//   - dragleave: clear the indicator
//   - drop: actually trigger the reorder, clear indicator
//
// We don't support touch — HTML5 DnD is mouse-only on every browser.
// Touch users still see the row but can't drag. A future polish round
// could add long-press-to-pick-up via pointer events; not worth the
// complexity for v1.

function DraggableRoleRow({
  role,
  isLast,
  isEveryone,
  selected,
  onSelect,
  onDropOnto,
}: {
  role: import('@zekktris/client').Role;
  isLast: boolean;
  isEveryone: boolean;
  selected: boolean;
  onSelect: () => void;
  onDropOnto: (dragId: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);
  const color = role.color
    ? '#' + role.color.toString(16).padStart(6, '0')
    : DEFAULT_ROLE_COLOR;

  // The @everyone row is rendered but disabled for drag — it's always
  // pinned to the bottom server-side, and dragging it would just
  // produce a confusing 403.
  const draggable = !isEveryone;

  return (
    <li
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return;
        e.dataTransfer.setData('text/plain', role.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => {
        if (isEveryone) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const dragId = e.dataTransfer.getData('text/plain');
        if (dragId && dragId !== role.id) onDropOnto(dragId);
      }}
      onClick={onSelect}
      className={`group flex items-center gap-2 px-2 py-1.5 cursor-pointer text-sm relative ${
        selected ? 'bg-bg-3' : 'hover:bg-bg-3/50'
      } ${isLast ? '' : 'border-b border-line/50'} ${
        dragging ? 'opacity-50' : ''
      } ${dragOver ? 'ring-2 ring-accent ring-inset' : ''}`}
    >
      {/* Grip handle: visual only, but cursor-grab signals the row is
          moveable. Hidden for @everyone since it can't be dragged. */}
      {!isEveryone ? (
        <span
          className="text-ink-3 hover:text-ink-1 shrink-0 cursor-grab active:cursor-grabbing"
          aria-hidden
        >
          <GripVertical size={14} />
        </span>
      ) : (
        <span className="w-3.5 shrink-0" aria-hidden />
      )}
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="flex-1 truncate">
        {isEveryone ? '@everyone' : role.name}
      </span>
    </li>
  );
}
