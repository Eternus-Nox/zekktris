/**
 * ForwardModal
 * ------------
 * Pick a destination channel/DM and forward a message into it. Mirrors
 * Discord's behavior:
 *   - List of all channels the user can SEND_MESSAGES into, grouped
 *     by guild + DMs at the top
 *   - Search box to filter
 *   - Optional comment textarea — the forwarder's note attached to the
 *     forward (renders above the source-quote in the destination)
 *   - Send button posts the forward; modal closes
 *
 * The destination list is computed from AppState's existing guilds +
 * channels + DMs; we don't refetch. Server-side validation re-checks
 * permissions, so a stale local view that includes a now-restricted
 * channel will surface as a 403 toast.
 */

import { useMemo, useState } from 'react';
import { ApiError, type Channel, type Message } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Portal } from '../lib/Portal';
import { Hash, Search } from '../lib/icons';
import { ModalHeader } from '../lib/ModalHeader';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';

interface Props {
  message: Message;
  onClose: () => void;
}

export function ForwardModal({ message, onClose }: Props) {
  const { user } = useAuth();
  const { state, restForChannel } = useAppState();
  const toasts = useToasts();

  const [query, setQuery] = useState('');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [destId, setDestId] = useState<string | null>(null);

  // Build the list of forward destinations:
  //   - DMs (state.dmChannels)
  //   - Guild text channels in any of state.guildIds
  // We don't filter by SEND_MESSAGES client-side because that would
  // require role data we may not have loaded; the server's 403 covers
  // the bad-destination case. Less hidden state, simpler code.
  const destinations = useMemo(() => {
    const out: Array<{ channel: Channel; guildName: string | null }> = [];
    // DMs first
    for (const ch of state.dmChannels) {
      out.push({ channel: ch, guildName: null });
    }
    // Guild text channels — group later by guild for display
    for (const guildId of state.guildIds) {
      const guild = state.guildsById[guildId];
      if (!guild) continue;
      const channels = state.channelsByGuild[guildId] ?? [];
      for (const ch of channels) {
        if (ch.type === 'guild_text') {
          out.push({ channel: ch, guildName: guild.name });
        }
      }
    }
    if (!query.trim()) return out;
    const q = query.trim().toLowerCase();
    return out.filter((d) => {
      const name = d.channel.name?.toLowerCase() ?? '';
      // For DMs the "name" is the recipient's display name. We compute
      // a synthetic search target from recipients so a search for
      // "alice" matches a DM with Alice.
      const recipName = d.channel.recipients
        ?.map((r) => `${r.displayName} ${r.username}`.toLowerCase())
        .join(' ') ?? '';
      const guildPart = d.guildName?.toLowerCase() ?? '';
      return name.includes(q) || recipName.includes(q) || guildPart.includes(q);
    });
  }, [state, query]);

  // Group output: DMs in their own header, then by guild name.
  const grouped = useMemo(() => {
    const dms: typeof destinations = [];
    const byGuild = new Map<string, typeof destinations>();
    for (const d of destinations) {
      if (d.guildName === null) {
        dms.push(d);
      } else {
        const list = byGuild.get(d.guildName) ?? [];
        list.push(d);
        byGuild.set(d.guildName, list);
      }
    }
    return { dms, byGuild };
  }, [destinations]);

  async function send() {
    if (!destId || sending) return;
    setSending(true);
    try {
      const srcApi = await restForChannel(message.channelId);
      const destApi = await restForChannel(destId);
      if (srcApi === destApi) {
        // Same server: it can resolve the source message id, so use the
        // native forward (which renders a proper forwarded-message embed).
        await destApi.sendMessage(destId, {
          content: comment.trim(),
          forwardFromMessageId: message.id,
        });
      } else {
        // Cross-server (backbone ↔ node, or node ↔ node): the destination
        // can't resolve a message id that lives on another server, so copy
        // the content into a new message instead. Attachments aren't re-
        // uploaded across servers — text is carried; if there was only an
        // attachment, we note that.
        const original = (message.content ?? '').trim();
        const fallback = original || '(forwarded message — open the original to see its attachment)';
        const body = [comment.trim(), fallback].filter(Boolean).join('\n\n');
        await destApi.sendMessage(destId, { content: body });
      }
      toasts.push('Forwarded', 'success');
      onClose();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Forward failed', 'error');
    } finally {
      setSending(false);
    }
  }

  // Resolve a label for each destination row. DMs use the other
  // recipient's display name; group DMs use a comma-list; guild
  // channels show "#name".
  function destLabel(ch: Channel): string {
    if (ch.type === 'dm') {
      const other = ch.recipients?.find((r) => r.id !== user?.id);
      return other?.displayName ?? other?.username ?? '(unknown)';
    }
    if (ch.type === 'group_dm') {
      const others = (ch.recipients ?? []).filter((r) => r.id !== user?.id);
      return others.map((r) => r.displayName ?? r.username).join(', ') || '(group)';
    }
    return `#${ch.name ?? '(unnamed)'}`;
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onClose}
      >
        <div
          className="bg-bg-1 border border-line shadow-xl w-full overflow-hidden flex flex-col h-full sm:h-auto sm:rounded-lg sm:max-w-md sm:max-h-[85vh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0"
          onClick={(e) => e.stopPropagation()}
        >
          <ModalHeader title="Forward message" onClose={onClose} />

          {/* Source preview — small chip showing what's being forwarded */}
          <div className="px-5 pt-3 shrink-0">
            <div className="border-l-2 border-accent/60 pl-3 text-xs text-ink-3 max-h-20 overflow-hidden">
              <div className="font-medium text-ink-2 truncate">
                {message.author?.displayName ?? '(unknown)'}
              </div>
              <div className="line-clamp-2 break-words">
                {message.content || '(attachment)'}
              </div>
            </div>
          </div>

          {/* Search */}
          <div className="px-5 pt-3 shrink-0">
            <label className="flex items-center gap-2 px-2 py-1.5 bg-bg-2 border border-line rounded">
              <Search size={14} className="text-ink-3 shrink-0" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search channels and DMs"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-3"
              />
            </label>
          </div>

          {/* Destination list */}
          <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-2">
            {destinations.length === 0 ? (
              <p className="px-2 py-4 text-sm text-ink-3 text-center">No matches.</p>
            ) : (
              <>
                {grouped.dms.length > 0 && (
                  <DestSection title="Direct messages">
                    {grouped.dms.map((d) => (
                      <DestRow
                        key={d.channel.id}
                        channel={d.channel}
                        label={destLabel(d.channel)}
                        active={destId === d.channel.id}
                        onSelect={() => setDestId(d.channel.id)}
                      />
                    ))}
                  </DestSection>
                )}
                {Array.from(grouped.byGuild.entries())
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([gname, list]) => (
                    <DestSection key={gname} title={gname}>
                      {list.map((d) => (
                        <DestRow
                          key={d.channel.id}
                          channel={d.channel}
                          label={destLabel(d.channel)}
                          active={destId === d.channel.id}
                          onSelect={() => setDestId(d.channel.id)}
                        />
                      ))}
                    </DestSection>
                  ))}
              </>
            )}
          </div>

          {/* Optional comment + send */}
          <div className="px-5 py-3 border-t border-line shrink-0 space-y-2">
            <textarea
              value={comment}
              maxLength={2000}
              rows={2}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment (optional)"
              className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md bg-bg-3 hover:bg-bg-3/70 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => void send()}
                disabled={!destId || sending}
                className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function DestSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="px-2 py-1 text-[0.65rem] uppercase tracking-wider text-ink-3 font-semibold">
        {title}
      </h3>
      <ul>{children}</ul>
    </div>
  );
}

function DestRow({
  channel,
  label,
  active,
  onSelect,
}: {
  channel: Channel;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  // For DMs render the recipient's avatar; for guild channels render
  // a hash icon. Group DMs use the first recipient's avatar.
  const isDM = channel.type === 'dm' || channel.type === 'group_dm';
  const avatarUser = isDM
    ? channel.recipients?.[0]
    : null;
  const tone = avatarColor(avatarUser?.id ?? channel.id);
  const initials = avatarInitials(avatarUser?.displayName ?? label);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors ${
          active ? 'bg-accent/15 text-ink-1' : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3'
        }`}
      >
        {isDM ? (
          <span className={`relative w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 overflow-hidden ${tone}`}>
            <span aria-hidden className="zk-avatar-initials">{initials}</span>
            <AvatarImage src={avatarUser?.avatarUrl ?? null} />
          </span>
        ) : (
          <Hash size={14} className="text-ink-3 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}
