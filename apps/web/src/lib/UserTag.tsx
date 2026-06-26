import type { PublicUser } from '@zekktris/client';

/**
 * Custom name tag ("clan tag") — a small pill rendered IN FRONT of a
 * user's name (messages, member list, profile, DM list). Renders nothing
 * unless the user has set a label or an emoji. tagColor (a #rrggbb hex)
 * tints the text + border and a faint fill; it falls back to the theme
 * accent when unset.
 */
export function UserTag({
  user,
  className = '',
}: {
  user: Pick<PublicUser, 'tagLabel' | 'tagColor' | 'tagEmoji'>;
  className?: string;
}) {
  const label = user.tagLabel?.trim();
  const emoji = user.tagEmoji?.trim();
  if (!label && !emoji) return null;
  const color = user.tagColor || 'var(--accent)';
  return (
    <span
      className={`inline-flex items-center gap-0.5 align-middle rounded-[0.3rem] px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none border shrink-0 ${className}`}
      style={{
        color,
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
      title={[emoji, label].filter(Boolean).join(' ')}
    >
      {/* Each child gets the same 1em-tall box centered on its own content, so
          emoji and label sit at the same visual midline regardless of the
          differing metrics between emoji fonts and the body text font. */}
      {emoji && (
        <span
          className="not-italic inline-flex items-center justify-center shrink-0"
          style={{ height: '1em', lineHeight: 1, transform: 'translateY(-0.1em)' }}
        >
          {emoji}
        </span>
      )}
      {label && (
        <span
          className="inline-flex items-center"
          style={{ height: '1em', lineHeight: 1 }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
