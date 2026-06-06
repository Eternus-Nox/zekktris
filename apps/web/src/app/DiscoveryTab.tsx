/**
 * DiscoveryTab
 * ------------
 * Server-settings tab for the public-discovery feature. Owners and
 * MANAGE_GUILD-holders can:
 *   - Toggle the guild's `discoverable` flag on/off
 *   - Edit the long-form pitch (`discoveryDescription`) shown next
 *     to the guild card on /discover. Capped at 500 chars.
 *
 * On save we PATCH /guilds/:id/discovery; the server fans out a
 * GUILD_UPDATE event so every member's local state stays in sync
 * (the toggle reflects across multiple settings tabs open in
 * different sessions).
 */

import { useEffect, useState } from 'react';
import type { Guild } from '@zekktris/client';
import { ApiError, DISCOVERY_CATEGORIES } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { Compass } from '../lib/icons';

const MAX_DESCRIPTION_LEN = 500;

export function DiscoveryTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const toasts = useToasts();

  // Local edit buffer. We seed from the current guild and keep our
  // own copy until Save — that way toggling the switch back and
  // forth doesn't fire a request per click.
  const [discoverable, setDiscoverable] = useState<boolean>(!!guild.discoverable);
  const [description, setDescription] = useState<string>(guild.discoveryDescription ?? '');
  const [category, setCategory] = useState<string>(guild.discoveryCategory ?? '');
  const [saving, setSaving] = useState(false);

  // Re-sync from props when the underlying guild changes (e.g. another
  // client mutated it; the GUILD_UPDATE event runs through AppState
  // and re-renders us with a new `guild` prop).
  useEffect(() => {
    setDiscoverable(!!guild.discoverable);
    setDescription(guild.discoveryDescription ?? '');
    setCategory(guild.discoveryCategory ?? '');
  }, [guild.discoverable, guild.discoveryDescription, guild.discoveryCategory]);

  const dirty =
    discoverable !== !!guild.discoverable ||
    (description.trim() || null) !== (guild.discoveryDescription ?? null) ||
    (category || null) !== (guild.discoveryCategory ?? null);

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const trimmed = description.trim();
      await rest.setGuildDiscovery(guild.id, {
        discoverable,
        discoveryDescription: trimmed.length === 0 ? null : trimmed,
        discoveryCategory: category === '' ? null : category,
      });
      toasts.push(discoverable ? 'Discovery enabled' : 'Discovery saved', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header explainer — discovery is opt-in, so this section
          frames the choice for owners. */}
      <div className="flex gap-3 items-start">
        <span className="w-10 h-10 rounded-md bg-bg-3 flex items-center justify-center text-ink-2 shrink-0">
          <Compass size={18} />
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold text-ink-1">Server Discovery</h3>
          <p className="text-sm text-ink-2 mt-1 leading-relaxed">
            Listing your server in the public directory lets anyone find and
            join it without an invite code. You can turn this off at any time.
          </p>
        </div>
      </div>

      {/* Toggle + label. The switch is a checkbox styled to look like
          a toggle (no third-party UI library — keeps the bundle lean). */}
      <label className="flex items-center justify-between gap-4 px-4 py-3 bg-bg-2 border border-line rounded-md cursor-pointer">
        <div className="min-w-0">
          <div className="font-medium text-ink-1">Enable discovery</div>
          <div className="text-xs text-ink-3 mt-0.5">
            {discoverable
              ? 'Visible on the public /discover page.'
              : 'Hidden from the public directory.'}
          </div>
        </div>
        <span
          className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
            discoverable ? 'bg-accent' : 'bg-bg-3'
          }`}
          aria-hidden
        >
          <span
            className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${
              discoverable ? 'left-[1.125rem]' : 'left-0.5'
            }`}
          />
        </span>
        <input
          type="checkbox"
          className="sr-only"
          checked={discoverable}
          onChange={(e) => setDiscoverable(e.target.checked)}
          aria-label="Enable discovery"
        />
      </label>

      {/* Category. The discovery sidebar groups guilds by these tags
          and renders the badge inline on the card. Optional — leave
          unset to default into "Other". */}
      <div>
        <label className="block">
          <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            Category
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={!discoverable}
            className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">— None —</option>
            {DISCOVERY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-ink-3 mt-1">
          People filtering the discovery page by category will only see your
          server under the one you pick here.
        </p>
      </div>

      {/* Description editor. Disabled when discovery is off — there's
          no point editing the pitch for a hidden guild. */}
      <div>
        <label className="block">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
              Description
            </span>
            <span className="text-xs text-ink-3 tabular-nums">
              {description.length}/{MAX_DESCRIPTION_LEN}
            </span>
          </div>
          <textarea
            value={description}
            onChange={(e) => {
              if (e.target.value.length <= MAX_DESCRIPTION_LEN) {
                setDescription(e.target.value);
              }
            }}
            disabled={!discoverable}
            rows={4}
            placeholder="Tell people what your server is about — what topics, who it's for, what makes it different."
            className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm resize-y disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </label>
        <p className="text-xs text-ink-3 mt-1">
          Shown beneath your server name on the discovery page. Falls back to
          the regular server description if empty.
        </p>
      </div>

      {/* Save bar. The button is disabled when the local buffer matches
          the live guild state — saves are gated to actual changes. */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() => {
            setDiscoverable(!!guild.discoverable);
            setDescription(guild.discoveryDescription ?? '');
            setCategory(guild.discoveryCategory ?? '');
          }}
          disabled={!dirty || saving}
          className="px-3 py-1.5 rounded-md text-sm text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="px-4 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
