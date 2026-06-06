/**
 * ChannelEditModal
 * ----------------
 * Edit a channel's name, topic, and slowmode interval; or delete it
 * outright. Triggered from the gear icon that appears on hover over a
 * channel row in ChannelList.
 *
 * Slowmode (rateLimitPerUser) is the per-user cooldown between messages.
 * The picker offers Discord's canonical step set rather than a free-form
 * number input — most users don't have an intuition for "what does 47
 * seconds of slowmode feel like?" but they do recognize "slow / medium /
 * very slow" buckets.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Hash, Trash, MicOff } from '../lib/icons';
import { ModalHeader } from '../lib/ModalHeader';
import { Portal } from '../lib/Portal';
import { ChannelPermissionsTab } from './ChannelPermissionsTab';
import { ChannelWebhooksTab } from './ChannelWebhooksTab';

const SLOWMODE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5 sec' },
  { value: 10, label: '10 sec' },
  { value: 30, label: '30 sec' },
  { value: 60, label: '1 min' },
  { value: 300, label: '5 min' },
  { value: 900, label: '15 min' },
  { value: 3600, label: '1 hour' },
];

export function ChannelEditModal({
  channel,
  onClose,
}: {
  channel: Channel;
  onClose: () => void;
}) {
  const { rest } = useAuth();
  const { loadChannels } = useAppState();
  const toasts = useToasts();
  const navigate = useNavigate();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [slowmode, setSlowmode] = useState(channel.rateLimitPerUser);
  // Only used when channel.type === 'guild_link'. Initialized from the
  // current row; the input renders below the topic field for link
  // channels and is the only field that's actually meaningful for them
  // (topic + slowmode don't apply, but we keep the fields visible for
  // the legacy migration case where a link channel inherited a topic).
  const [linkUrl, setLinkUrl] = useState(channel.linkUrl ?? '');
  // Voice channels only — whether voice (talking) is disabled in the channel.
  const [voiceDisabled, setVoiceDisabled] = useState(channel.voiceDisabled === true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [purging, setPurging] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Latest-onClose ref. ChannelList recreates its inline onClose on
  // every render (voice presence, drag state, mentions, etc.), so
  // depending on onClose in an effect makes that effect re-run
  // constantly — the original code re-stole focus to the name input
  // and even re-selected the text on every parent re-render, making
  // it impossible to type in any other field.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus + select the name once on mount. Empty deps so it does NOT
  // re-fire when the parent re-renders.
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  // Escape closes the modal. Listener registered once; reads the
  // latest onClose through the ref.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function normalize(raw: string): string {
    // Categories, voice, and stage channels are spoken/social names —
    // allow caps and spaces ("Movie Night", "Main Stage"). Text,
    // forum, and link channels are referenced as URL-like mentions
    // and stay in the lowercase-hyphenated form.
    if (
      channel.type === 'guild_category' ||
      channel.type === 'guild_voice' ||
      channel.type === 'guild_stage'
    ) {
      return raw.slice(0, 100);
    }
    return raw
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-_]/g, '')
      .slice(0, 100);
  }

  // For link channels, the URL must remain a valid http(s) string for
  // Save to be enabled. Mirrors the create-modal client validation;
  // server validates regardless.
  const linkUrlOk = (() => {
    if (channel.type !== 'guild_link') return true;
    if (!linkUrl.trim()) return false;
    try {
      const u = new URL(linkUrl.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  })();
  const dirty =
    name !== (channel.name ?? '') ||
    topic !== (channel.topic ?? '') ||
    slowmode !== channel.rateLimitPerUser ||
    (channel.type === 'guild_voice' && voiceDisabled !== (channel.voiceDisabled === true)) ||
    (channel.type === 'guild_link' && linkUrl.trim() !== (channel.linkUrl ?? ''));

  async function save() {
    if (!dirty || submitting || !linkUrlOk) return;
    setSubmitting(true);
    try {
      // Only send fields that actually changed — avoids noop database writes
      // and reduces the chance the server's validation rejects an unmodified
      // value (e.g. a topic that's currently null shouldn't be re-set to '').
      await rest.patchChannel(channel.id, {
        name: name !== (channel.name ?? '') ? name : undefined,
        topic: topic !== (channel.topic ?? '') ? topic || null : undefined,
        rateLimitPerUser: slowmode !== channel.rateLimitPerUser ? slowmode : undefined,
        // voiceDisabled only carried on voice channels — server rejects on
        // other types.
        ...(channel.type === 'guild_voice' && voiceDisabled !== (channel.voiceDisabled === true)
          ? { voiceDisabled }
          : {}),
        // linkUrl only carried on link channels — server rejects on
        // other types.
        ...(channel.type === 'guild_link' && linkUrl.trim() !== (channel.linkUrl ?? '')
          ? { linkUrl: linkUrl.trim() }
          : {}),
      });
      if (channel.guildId) await loadChannels(channel.guildId);
      toasts.push('Channel updated', 'success');
      onClose();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Update failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function purge() {
    if (purging) return;
    setPurging(true);
    try {
      // Loop the API until the server reports done. Each call is
      // capped at 1000 messages server-side; this keeps a single
      // press able to fully clear large channels without blocking
      // the API process for minutes on one giant transaction.
      let total = 0;
      // Cap the loop iterations at a sane number (1M messages
      // would be 1000 batches; 50 is very generous and prevents a
      // server bug from spinning the client forever).
      for (let i = 0; i < 50; i++) {
        const r = await rest.purgeChannel(channel.id);
        total += r.deleted;
        if (r.done) break;
      }
      toasts.push(
        total === 0
          ? 'Channel was already empty'
          : `Purged ${total.toLocaleString()} ${total === 1 ? 'message' : 'messages'}`,
        'success',
      );
      onClose();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Purge failed', 'error');
    } finally {
      setPurging(false);
    }
  }

  async function destroy() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await rest.deleteChannel(channel.id);
      if (channel.guildId) await loadChannels(channel.guildId);
      toasts.push('Channel deleted', 'success');
      onClose();
      // Navigate away from the now-deleted channel — back to the guild's
      // first surviving text channel, or the home view if none.
      if (channel.guildId) {
        navigate(`/channels/${channel.guildId}`);
      } else {
        navigate('/channels/@me');
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // Tabs — Settings (existing form), Permissions (overrides), Webhooks
  // (incoming webhook integrations). Permissions and Webhooks tabs are
  // hidden for non-guild channels and for non-text-bearing channel
  // types (categories don't have message streams; voice channels
  // don't either; webhooks therefore don't apply).
  type Tab = 'settings' | 'permissions' | 'webhooks';
  const [tab, setTab] = useState<Tab>('settings');
  const isGuildChannel = channel.type !== 'dm' && channel.type !== 'group_dm' && !!channel.guildId;
  const showPermissions = isGuildChannel;
  const showWebhooks = isGuildChannel && channel.type === 'guild_text';

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onClose}
      >
      <div
        className={`bg-bg-1 border border-line shadow-xl w-full overflow-hidden flex flex-col h-full sm:h-auto sm:rounded-lg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0 ${
          tab === 'permissions' || tab === 'webhooks' ? 'sm:max-w-3xl' : 'sm:max-w-md'
        } sm:max-h-[85vh]`}
        onClick={(e) => e.stopPropagation()}
      >
        <ModalHeader
          title={channel.name ?? '(unnamed)'}
          icon={<Hash size={16} className="text-ink-3" />}
          onClose={onClose}
        />

        {(showPermissions || showWebhooks) && (
          <div className="px-5 pt-3 border-b border-line shrink-0">
            <div className="flex gap-1">
              <button
                onClick={() => setTab('settings')}
                className={`px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors ${
                  tab === 'settings'
                    ? 'border-accent text-ink-1'
                    : 'border-transparent text-ink-3 hover:text-ink-2'
                }`}
              >
                Settings
              </button>
              {showPermissions && (
                <button
                  onClick={() => setTab('permissions')}
                  className={`px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors ${
                    tab === 'permissions'
                      ? 'border-accent text-ink-1'
                      : 'border-transparent text-ink-3 hover:text-ink-2'
                  }`}
                >
                  Permissions
                </button>
              )}
              {showWebhooks && (
                <button
                  onClick={() => setTab('webhooks')}
                  className={`px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors ${
                    tab === 'webhooks'
                      ? 'border-accent text-ink-1'
                      : 'border-transparent text-ink-3 hover:text-ink-2'
                  }`}
                >
                  Webhooks
                </button>
              )}
            </div>
          </div>
        )}

        {tab === 'permissions' ? (
          <div className="px-5 py-4 overflow-y-auto scrollbar-thin">
            <ChannelPermissionsTab channel={channel} />
          </div>
        ) : tab === 'webhooks' ? (
          <div className="px-5 py-4 overflow-y-auto scrollbar-thin">
            <ChannelWebhooksTab channel={channel} />
          </div>
        ) : (
          <>
        <div className="px-5 py-4 space-y-4 overflow-y-auto scrollbar-thin">
          {/* Name */}
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
              {channel.type === 'guild_category' ? 'Category name' : 'Channel name'}
            </span>
            <input
              ref={nameRef}
              type="text"
              value={name}
              maxLength={100}
              onChange={(e) => setName(normalize(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
            />
          </label>

          {/* URL — link channels only. The bookmark target. Member
              clicks on this channel in the sidebar will be asked to
              confirm before being opened in a new tab. */}
          {channel.type === 'guild_link' && (
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">URL</span>
              <input
                type="url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://example.com/docs"
                maxLength={2048}
                className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
              />
              <span className="block text-xs text-ink-3 mt-1">
                Must be a full http or https URL. Members will be asked to
                confirm before being sent here.
              </span>
            </label>
          )}

          {/* Topic — text channels only */}
          {channel.type === 'guild_text' && (
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Topic</span>
              <textarea
                value={topic}
                placeholder="What's this channel about?"
                maxLength={1024}
                rows={2}
                onChange={(e) => setTopic(e.target.value)}
                className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1 resize-none"
              />
              <span className="block text-xs text-ink-3 mt-1">
                Shown at the top of the channel — quick context for newcomers.
              </span>
            </label>
          )}

          {/* Slowmode — text channels only */}
          {channel.type === 'guild_text' && (
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Slow mode</span>
              <select
                value={slowmode}
                onChange={(e) => setSlowmode(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
              >
                {SLOWMODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-ink-3 mt-1">
                Members can send one message per interval. Useful in busy channels.
              </span>
            </label>
          )}

          {/* Disable voice — voice channels only. When on, participants can
              join (and see who's there) but no one can talk; mics are
              disabled at the server. Same effect as the AFK channel. */}
          {channel.type === 'guild_voice' && (
            <div className="block">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold inline-flex items-center gap-1.5">
                  <MicOff size={13} className="shrink-0" />
                  Disable voice
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={voiceDisabled}
                  onClick={() => setVoiceDisabled((v) => !v)}
                  className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
                    voiceDisabled ? 'bg-accent' : 'bg-bg-3'
                  }`}
                  title={voiceDisabled ? 'Allow talking in this channel' : 'Disable talking in this channel'}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                      voiceDisabled ? 'left-[18px]' : 'left-0.5'
                    }`}
                    aria-hidden
                  />
                </button>
              </div>
              <span className="block text-xs text-ink-3 mt-1">
                When on, people can join the channel but no one can talk — mics
                are disabled at the server.
              </span>
            </div>
          )}

          {/* Purge messages — clears the channel without deleting it.
              Two-step confirmation matches the delete flow. The
              backend caps each call at 1000 rows so we loop until
              the server returns done=true; large channels get a
              progress count via the toast.
              Gated to channel types that actually hold messages —
              text channels and threads. Voice / stage / category
              don't surface a message list, so the affordance there
              would be meaningless and confusing. */}
          {(channel.type === 'guild_text' || channel.type === 'public_thread') && (
            <div className="pt-3 border-t border-line">
              {!confirmingPurge ? (
                <button
                  onClick={() => setConfirmingPurge(true)}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 text-amber-300 hover:bg-amber-500/10 text-sm"
                >
                  <Trash size={14} />
                  <span>Purge all messages</span>
                </button>
              ) : (
                <div className="border border-amber-500/30 bg-amber-500/5 rounded-md p-3">
                  <p className="text-xs text-ink-2 mb-3">
                    Soft-deletes every message in this channel. The channel itself stays. Cannot be undone.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setConfirmingPurge(false)}
                      className="px-3 py-1.5 rounded-md text-ink-2 hover:bg-bg-3 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={purge}
                      disabled={purging}
                      className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium disabled:opacity-50"
                    >
                      {purging ? 'Purging…' : 'Yes, purge'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Delete — moved to its own row, two-step confirmation */}
          <div className="pt-3 border-t border-line">
            {!confirmingDelete ? (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm"
              >
                <Trash size={14} />
                <span>Delete channel</span>
              </button>
            ) : (
              <div className="border border-red-500/30 bg-red-500/5 rounded-md p-3">
                <p className="text-xs text-ink-2 mb-3">
                  Permanently deletes the channel and all of its messages. This cannot be undone.
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    className="px-3 py-1.5 rounded-md text-ink-2 hover:bg-bg-3 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={destroy}
                    disabled={submitting}
                    className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
                  >
                    {submitting ? 'Deleting…' : 'Yes, delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line bg-bg-2 flex justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-ink-2 hover:bg-bg-3 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!dirty || submitting || !linkUrlOk}
            className="px-4 py-1.5 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
        </>
        )}
      </div>
      </div>
    </Portal>
  );
}
