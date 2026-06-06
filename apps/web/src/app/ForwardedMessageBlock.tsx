/**
 * ForwardedMessageBlock
 * ---------------------
 * Renders a snapshot of a forwarded message — author, source channel
 * attribution, content preview, and any source-side attachments.
 * Sits above the forwarder's own content (and reactions, polls, etc.)
 * inside a MessageItem; the visual treatment is a left-bordered
 * quote block that's clearly distinct from the host message.
 *
 * "Jump to original" affordance: when the source is still accessible
 * (channel known + not deleted), the attribution line is a Link to
 * the source channel + message anchor. We don't try to scroll to the
 * exact message — channel-link navigation is enough for v1.
 *
 * Soft-deleted source: render `[deleted]` placeholder with the same
 * structure (author + attribution) so the layout doesn't jump and
 * users can still see "this was a forward of <author>'s message that
 * has since been deleted." Hard-deleted source (row gone): the DTO's
 * `author` is null and `content` is empty — we render "[unavailable]".
 */

import { Link } from 'react-router-dom';
import type { ForwardSource } from '@zekktris/client';
import { Forward } from '../lib/icons';
import { Attachments } from './Attachments';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';

interface Props {
  source: ForwardSource;
}

export function ForwardedMessageBlock({ source }: Props) {
  const author = source.author;
  // The channel may be null (deleted), in which case we omit the
  // navigate-to-channel link and just show plain text attribution.
  // The "channel name" for DMs gets a different prefix; for guild
  // channels we use #name. Group DMs use a generic "(group DM)" since
  // we don't load recipient names for forward sources.
  const channel = source.channel;
  const channelLabel =
    channel === null
      ? '(unknown)'
      : channel.type === 'guild_text'
        ? `#${channel.name ?? 'channel'}`
        : channel.type === 'dm'
          ? 'a DM'
          : channel.type === 'group_dm'
            ? 'a group DM'
            : (channel.name ?? 'channel');

  // Tombstones: hard-deleted source has `author === null` and empty
  // content. Soft-deleted has `deleted === true`. Both render with a
  // greyed treatment, but the hard-tombstone shows generic copy.
  const isHardTombstone = author === null && source.content.length === 0 && source.attachments.length === 0;
  const isSoftDeleted = source.deleted;

  const tone = avatarColor(author?.id);
  const initials = avatarInitials(author?.displayName);

  return (
    <div className="mt-2 max-w-2xl">
      {/* Attribution header — sits above the quoted block, with a
          small forward icon as a visual cue. Click navigates to the
          source channel when available. */}
      <div className="flex items-center gap-1.5 text-xs text-ink-3 mb-0.5">
        <Forward size={11} className="shrink-0 opacity-70" />
        <span>Forwarded from</span>
        {channel && channel.type === 'guild_text' ? (
          <Link
            to={`/channels/${channel.id}`}
            className="font-medium text-ink-2 hover:underline truncate"
          >
            {channelLabel}
          </Link>
        ) : (
          <span className="font-medium text-ink-2 truncate">{channelLabel}</span>
        )}
      </div>

      {/* Quoted block — left border in accent for forwards (vs. the
          plain border used for replies, so the two are distinguishable
          at a glance). */}
      <div
        className={`border-l-2 pl-3 ${
          isHardTombstone || isSoftDeleted
            ? 'border-line/60 opacity-60'
            : 'border-accent/60'
        }`}
      >
        {isHardTombstone ? (
          <p className="text-sm text-ink-3 italic">Original message no longer available.</p>
        ) : (
          <>
            {/* Source author — same shape as the host message header,
                in miniature. The avatar sits in a 5x5 round so the
                quoted block visually nests inside the host bubble
                without dominating it. */}
            <div className="flex items-center gap-2 text-xs">
              <span className={`relative w-5 h-5 rounded-full flex items-center justify-center text-[0.6rem] font-semibold shrink-0 overflow-hidden ${tone}`}>
                <span aria-hidden>{initials}</span>
                <AvatarImage src={author?.avatarUrl ?? null} />
              </span>
              <span className="font-medium text-ink-2 truncate">
                {author?.displayName ?? 'Unknown'}
              </span>
              <span className="text-ink-3 shrink-0">
                · {formatRelativePast(source.createdAt)}
              </span>
            </div>

            {/* Source content. Preserve newlines and whitespace, like
                the host message. We don't run mention/emoji rendering
                here for v1 — the source content is shown verbatim,
                which is correct for plain-text forwards but doesn't
                resolve role pings or :emoji: tokens. The host message
                renderer does that for the forwarder's comment, which
                is the right place. */}
            {source.content.length > 0 && (
              <p className={`mt-1 text-sm whitespace-pre-wrap break-words ${
                isSoftDeleted ? 'italic text-ink-3' : 'text-ink-1'
              }`}>
                {isSoftDeleted ? '[deleted]' : source.content}
              </p>
            )}

            {/* Source attachments. Reuse the host Attachments
                component so images/videos/files all render the same
                way they would in the source channel. */}
            {!isSoftDeleted && source.attachments.length > 0 && (
              <div className="mt-1.5 max-w-md">
                <Attachments attachments={source.attachments} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Format a past timestamp as "just now", "5m ago", "3h ago", "2d ago",
 * or a date for older. Used for forward-source attribution where
 * absolute time is less useful than relative recency.
 */
function formatRelativePast(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
