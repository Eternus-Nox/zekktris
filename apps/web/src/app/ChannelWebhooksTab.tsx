/**
 * ChannelWebhooksTab
 * ------------------
 * UI for managing incoming webhooks on a text channel. Drives the four
 * admin REST endpoints:
 *
 *   GET    /channels/:channelId/webhooks   — list
 *   POST   /channels/:channelId/webhooks   — create
 *   PATCH  /webhooks/:id                   — rename / re-avatar
 *   DELETE /webhooks/:id                   — remove
 *
 * The list shows each webhook's name + a copy-URL button. The URL
 * format is `${origin}/api/webhooks/${id}/${token}` — the same shape
 * Discord uses, so any tool that posts to a Discord webhook URL works
 * unchanged against ours (subject to body schema parity, which we do
 * for the common case: content + optional username/avatar_url).
 *
 * The token is always included in the response (mirroring Discord's
 * own choice — the perm gate is the only protection). We surface it
 * as part of the URL only; we don't show the bare token, both because
 * it's not a thing users type by hand and because hiding it slightly
 * reduces the chance of someone copy-pasting it without the surrounding
 * URL into a public place.
 */

import { useEffect, useRef, useState } from 'react';
import { ApiError, type Channel, type Webhook } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { copyText } from '../lib/clipboard';
import { Plus, Trash, Copy, Edit } from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';

interface Props {
  channel: Channel;
}

export function ChannelWebhooksTab({ channel }: Props) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await rest.listChannelWebhooks(channel.id);
      setWebhooks(r.webhooks);
    } catch (e) {
      // 403 here means the viewer lacks MANAGE_WEBHOOKS. We surface
      // a clear message rather than a silent empty list.
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError('Could not load webhooks');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  async function create() {
    setCreating(true);
    try {
      const r = await rest.createWebhook(channel.id, { name: 'New webhook' });
      // Optimistic-ish: prepend the new row instead of re-fetching the
      // whole list. The server's response carries the row in canonical
      // shape (token + all fields) so we don't lose any info.
      setWebhooks((prev) => [r.webhook, ...(prev ?? [])]);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to create webhook', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function deleteOne(webhookId: string) {
    if (!confirm('Delete this webhook? The URL will stop working immediately.')) return;
    try {
      await rest.deleteWebhook(webhookId);
      setWebhooks((prev) => (prev ?? []).filter((w) => w.id !== webhookId));
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to delete', 'error');
    }
  }

  if (loading && webhooks === null) {
    return <div className="text-sm text-ink-3">Loading webhooks…</div>;
  }
  if (error) {
    return <div className="text-sm text-red-400">{error}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-ink-3 leading-relaxed flex-1">
          Webhooks let external services post messages to this channel without a user account.
          Each webhook has a unique URL — keep it secret. Compatible with the standard Discord
          webhook payload (content / username / avatar_url).
        </p>
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating}
          className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm flex items-center gap-1.5 shrink-0 disabled:opacity-60"
        >
          <Plus size={14} />
          New webhook
        </button>
      </div>

      {webhooks && webhooks.length === 0 ? (
        <div className="text-sm text-ink-3 italic py-6 text-center">
          No webhooks yet. Create one to get a posting URL.
        </div>
      ) : (
        <ul className="space-y-3">
          {webhooks?.map((w) => (
            <WebhookRow
              key={w.id}
              webhook={w}
              onDelete={() => void deleteOne(w.id)}
              onUpdate={(updated) => {
                setWebhooks((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function WebhookRow({
  webhook,
  onDelete,
  onUpdate,
}: {
  webhook: Webhook;
  onDelete: () => void;
  onUpdate: (w: Webhook) => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(webhook.name);
  const [avatarUrl, setAvatarUrl] = useState(webhook.avatarUrl ?? '');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  async function onAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const r = await rest.uploadWebhookAvatar(webhook.id, file);
      onUpdate(r.webhook);
      setAvatarUrl(r.webhook.avatarUrl ?? '');
      toasts.push('Webhook avatar updated', 'success');
    } catch (err) {
      toasts.push(err instanceof ApiError ? err.message : 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  }

  // Build the public URL. Origin is read from the current location so
  // the URL points to whichever host the user opened the app on (works
  // whether they're on localhost during dev or zekktris.com in prod).
  // The /api/webhooks prefix matches the server mount.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = `${origin}/api/webhooks/${webhook.id}/${webhook.token}`;

  async function copyUrl() {
    try {
      await copyText(url);
      toasts.push('Webhook URL copied', 'success');
    } catch {
      // Clipboard can fail on iOS Safari without a user gesture or in
      // contexts where the clipboard API is blocked. Fall back to a
      // toast prompting the user to copy manually — they can long-press
      // the URL displayed in the row.
      toasts.push('Could not copy. Tap the URL to select it.', 'error');
    }
  }

  async function save() {
    if (!editing) return;
    setSaving(true);
    try {
      const patch: { name?: string; avatarUrl?: string | null } = {};
      if (name !== webhook.name) patch.name = name.trim();
      const trimmedAvatar = avatarUrl.trim();
      if (trimmedAvatar !== (webhook.avatarUrl ?? '')) {
        patch.avatarUrl = trimmedAvatar === '' ? null : trimmedAvatar;
      }
      if (Object.keys(patch).length === 0) {
        setEditing(false);
        return;
      }
      const r = await rest.patchWebhook(webhook.id, patch);
      onUpdate(r.webhook);
      setEditing(false);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  const tone = avatarColor(webhook.id);
  const initials = avatarInitials(webhook.name);

  return (
    <li className="bg-bg-2 border border-line rounded-lg p-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className={`relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 overflow-hidden ${tone}`}>
          <span aria-hidden="true" className="zk-avatar-initials">{initials}</span>
          <AvatarImage src={webhook.avatarUrl} />
        </div>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Webhook name"
                maxLength={80}
                className="w-full px-2 py-1 bg-bg-1 border border-line rounded text-sm"
              />
              <div className="flex gap-2">
                <input
                  type="url"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="Avatar image URL (optional)"
                  maxLength={1024}
                  className="flex-1 min-w-0 px-2 py-1 bg-bg-1 border border-line rounded text-sm"
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading || saving}
                  className="px-3 py-1 rounded text-sm bg-bg-3 hover:bg-bg-3/70 disabled:opacity-60 shrink-0"
                >
                  {uploading ? 'Uploading…' : 'Upload'}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  onChange={onAvatarFile}
                  className="hidden"
                />
              </div>
              <p className="text-[0.7rem] text-ink-3 leading-relaxed">
                Upload an image or paste a URL — this is the webhook’s own picture. Webhook messages
                show this avatar and name, never your profile.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setName(webhook.name);
                    setAvatarUrl(webhook.avatarUrl ?? '');
                    setEditing(false);
                  }}
                  disabled={saving}
                  className="px-3 py-1 rounded text-sm bg-bg-3 hover:bg-bg-3/70"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="px-3 py-1 rounded text-sm bg-accent text-white hover:bg-accent/90 disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="font-medium text-ink-1 truncate">{webhook.name}</div>
              <div className="text-xs text-ink-3 mt-0.5 break-all leading-relaxed">{url}</div>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex gap-1 shrink-0">
            <button
              type="button"
              onClick={() => void copyUrl()}
              className="w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
              title="Copy URL"
              aria-label="Copy URL"
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
              title="Edit"
              aria-label="Edit"
            >
              <Edit size={14} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-red-400 hover:bg-bg-3"
              title="Delete"
              aria-label="Delete"
            >
              <Trash size={14} />
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
