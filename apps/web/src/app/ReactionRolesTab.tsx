/**
 * ReactionRolesTab
 * ----------------
 * Manages reaction-role mappings for a guild — "react with X on
 * message Y to receive role Z". The data model is a flat list of
 * (messageId, emoji, roleId, channelId) tuples; this tab lists
 * them in a single table, lets you add a new one, and lets you
 * delete existing entries.
 *
 * Why no message picker? Picking a message means scrolling channels
 * and tapping on the right post, which is a non-trivial flow on its
 * own. For v1 we ask the user to paste a message id (right-click →
 * "Copy message ID" once we add that menu item; meanwhile they can
 * paste a numeric id directly from the URL when we add deep-linking).
 * Channel id similarly. The friction is real but the alternative is
 * a much bigger UI; this lets the feature ship and get used.
 *
 * Permission gating is server-side (MANAGE_ROLES), but we only show
 * this tab in the settings modal when the user is admin anyway.
 */
import { useEffect, useMemo, useState } from 'react';
import { ApiError, type Guild, type ReactionRoleMapping, type Role } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Plus, Trash, AlertTriangle } from '../lib/icons';

export function ReactionRolesTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const { state, loadRoles, loadChannels } = useAppState();
  const toasts = useToasts();
  const [items, setItems] = useState<ReactionRoleMapping[] | null>(null);

  // Form state for the "Add mapping" inline form. Stays controlled
  // here rather than in a separate component because the form is
  // small enough that splitting buys nothing.
  const [draftMessageId, setDraftMessageId] = useState('');
  const [draftChannelId, setDraftChannelId] = useState('');
  const [draftEmoji, setDraftEmoji] = useState('');
  const [draftRoleId, setDraftRoleId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const channels = state.channelsByGuild[guild.id] ?? [];
  const roles = state.rolesByGuild[guild.id] ?? [];
  // @everyone can't be assigned via reactions — server would
  // happily store the mapping but the role-add side rejects it,
  // and exposing it in the picker creates dead options. Strip it.
  const assignableRoles = useMemo(() => roles.filter((r) => r.name !== '@everyone'), [roles]);
  const channelById = useMemo(() => {
    const m = new Map<string, (typeof channels)[number]>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);
  const roleById = useMemo(() => {
    const m = new Map<string, Role>();
    for (const r of roles) m.set(r.id, r);
    return m;
  }, [roles]);

  // Hydrate channels + roles on mount so the picker dropdowns have
  // data even on a fresh open. Both loaders are no-ops when the
  // slices are already populated.
  useEffect(() => {
    loadChannels(guild.id);
    loadRoles(guild.id);
  }, [guild.id, loadChannels, loadRoles]);

  // Initial fetch + refresh after mutations. We don't subscribe to
  // a gateway event because mapping CRUD is rare and admin-only;
  // refetching after each write is plenty.
  async function refresh() {
    try {
      const r = await rest.listReactionRoles(guild.id);
      setItems(r.items);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to load reaction roles', 'error');
      setItems([]);
    }
  }
  useEffect(() => {
    refresh();
    // We intentionally omit `refresh` from deps — recreating the
    // function each render would loop the effect. The reference is
    // stable for the tab's lifetime since it closes over rest/guild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  async function addMapping() {
    if (submitting) return;
    const messageId = draftMessageId.trim();
    const channelId = draftChannelId.trim();
    const emoji = draftEmoji.trim();
    const roleId = draftRoleId.trim();
    if (!messageId || !channelId || !emoji || !roleId) {
      toasts.push('All fields required', 'error');
      return;
    }
    // Quick client-side guard: ids must look numeric (snowflakes).
    // Server will re-validate but failing fast here avoids a
    // round-trip on obvious paste errors.
    if (!/^\d+$/.test(messageId) || !/^\d+$/.test(channelId) || !/^\d+$/.test(roleId)) {
      toasts.push('IDs must be numeric snowflakes', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await rest.upsertReactionRole(guild.id, { messageId, channelId, emoji, roleId });
      toasts.push('Mapping saved', 'success');
      setDraftMessageId('');
      setDraftChannelId('');
      setDraftEmoji('');
      setDraftRoleId('');
      setShowForm(false);
      refresh();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to save mapping', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function removeMapping(m: ReactionRoleMapping) {
    try {
      await rest.deleteReactionRole(guild.id, m.messageId, m.emoji);
      toasts.push('Mapping removed', 'success');
      refresh();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to remove', 'error');
    }
  }

  if (items === null) {
    return <div className="p-6 text-sm text-ink-3">Loading reaction roles…</div>;
  }

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-ink-1">Reaction roles</h3>
        <p className="text-xs text-ink-3 mt-1 leading-relaxed">
          Map an emoji on a specific message to a role. When someone reacts with that emoji,
          they receive the role automatically; un-reacting removes it.
        </p>
      </div>

      {/* Existing mappings list */}
      {items.length === 0 ? (
        <div className="text-sm text-ink-3 px-3 py-6 border border-dashed border-line rounded-md text-center">
          No reaction roles configured yet.
        </div>
      ) : (
        <ul className="border border-line rounded-md overflow-hidden divide-y divide-line">
          {items.map((m) => {
            const channel = channelById.get(m.channelId);
            const role = roleById.get(m.roleId);
            return (
              <li
                key={`${m.messageId}:${m.emoji}`}
                className="flex items-center gap-3 px-3 py-2 bg-bg-2 text-sm"
              >
                <span className="text-lg leading-none shrink-0">{m.emoji}</span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate">
                    <span className="text-ink-3">in </span>
                    <span className="text-ink-1">#{channel?.name ?? '(deleted channel)'}</span>
                    <span className="text-ink-3"> → </span>
                    <span
                      className="text-ink-1"
                      style={role?.color ? { color: hexFromInt(role.color) } : undefined}
                    >
                      @{role?.name ?? '(deleted role)'}
                    </span>
                  </span>
                  <span className="block text-[0.65rem] text-ink-3 mt-0.5 font-mono truncate">
                    msg {m.messageId}
                  </span>
                </span>
                <button
                  onClick={() => removeMapping(m)}
                  className="p-1.5 rounded hover:bg-bg-3 text-ink-3 hover:text-red-400 shrink-0"
                  aria-label="Remove mapping"
                  title="Remove"
                >
                  <Trash size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add form — collapsed by default to keep the list focused */}
      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-line text-sm text-ink-2 hover:text-ink-1 hover:bg-bg-3"
        >
          <Plus size={14} />
          <span>Add mapping</span>
        </button>
      ) : (
        <div className="border border-line rounded-md p-3 bg-bg-2 space-y-2">
          <div className="flex items-start gap-2 text-[0.7rem] text-ink-3 leading-snug">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>
              Paste the message ID + channel ID from the message you want to react on. (Right-click
              the message → Copy ID; or use the URL once message-links are enabled.)
            </span>
          </div>
          <label className="block">
            <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Channel
            </span>
            <select
              value={draftChannelId}
              onChange={(e) => setDraftChannelId(e.target.value)}
              className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1"
            >
              <option value="">Select a channel…</option>
              {channels
                .filter((c) => c.type === 'guild_text')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Message ID
            </span>
            <input
              value={draftMessageId}
              onChange={(e) => setDraftMessageId(e.target.value)}
              placeholder="e.g. 311873660908470272"
              className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1 font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                Emoji
              </span>
              <input
                value={draftEmoji}
                onChange={(e) => setDraftEmoji(e.target.value)}
                placeholder="🟢"
                className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1"
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                Role
              </span>
              <select
                value={draftRoleId}
                onChange={(e) => setDraftRoleId(e.target.value)}
                className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1"
              >
                <option value="">Select a role…</option>
                {assignableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    @{r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => {
                setShowForm(false);
                setDraftMessageId('');
                setDraftChannelId('');
                setDraftEmoji('');
                setDraftRoleId('');
              }}
              className="px-3 py-1.5 rounded-md text-sm text-ink-2 hover:bg-bg-3"
            >
              Cancel
            </button>
            <button
              onClick={addMapping}
              disabled={submitting}
              className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save mapping'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Roles store color as a 24-bit int. Convert to `#rrggbb`. */
function hexFromInt(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}
