import type { PublicUser } from '@zekktris/client';

/**
 * Custom name tag ("clan tag") — a small label-only pill rendered IN FRONT of
 * a user's name (messages, member list, profile, DM list). Renders nothing
 * unless the user has set a label (≤4 chars). tagColor (a #rrggbb hex) tints
 * the text + border and a faint fill; it falls back to the theme accent when
 * unset. `self-center` keeps the pill vertically centered with the name even
 * inside baseline-aligned rows (e.g. the message header).
 */
export function UserTag({
  user,
  className = '',
}: {
  user: Pick<PublicUser, 'tagLabel' | 'tagColor'>;
  className?: string;
}) {
  const label = user.tagLabel?.trim();
  if (!label) return null;
  const color = user.tagColor || 'var(--accent)';
  return (
    <span
      className={`inline-flex items-center self-center rounded-md px-1.5 pt-[3px] pb-[1px] text-[10px] font-semibold leading-none border shrink-0 ${className}`}
      style={{
        color,
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
      title={label}
    >
      {label}
    </span>
  );
}
