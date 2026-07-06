import type { CSSProperties } from 'react';
import type { PublicUser } from '@zekktris/client';
import { useHideClanTags } from './displayPrefs';

/**
 * Custom name tag ("clan tag") — a small label-only pill rendered IN FRONT of
 * a user's name (messages, member list, profile, DM list). Renders nothing
 * unless the user has set a label (≤4 chars). tagColor (a #rrggbb hex) tints
 * the text + border and a faint fill; it falls back to the theme accent when
 * unset. `self-center` keeps the pill vertically centered with the name even
 * inside baseline-aligned rows (e.g. the message header).
 *
 * When the viewer has turned on "Hide clan tags" in Settings, every tag is
 * suppressed here in one place — except the live editor preview, which passes
 * `ignoreHidePref` so you can still see the tag you're editing.
 */
export function UserTag({
  user,
  className = '',
  ignoreHidePref = false,
}: {
  user: Pick<PublicUser, 'tagLabel' | 'tagColor'>;
  className?: string;
  ignoreHidePref?: boolean;
}) {
  // Hook must run before any early return (Rules of Hooks).
  const hidden = useHideClanTags();
  const label = user.tagLabel?.trim();
  if (!label) return null;
  if (hidden && !ignoreHidePref) return null;
  const color = user.tagColor || 'var(--accent)';
  return (
    <span
      className={`zk-nametag inline-flex items-center justify-center self-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none border shrink-0 ${className}`}
      style={{
        color,
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
      title={label}
    >
      {/* No optical nudges — the flex centering on the pill keeps the label
          dead-center at every size (per user direction: always centered). */}
      {label}
    </span>
  );
}

/** The staff shimmer color for a user, or null when it shouldn't apply
    (not staff, or no color set). Shared gate so display + settings agree. */
export function staffShimmerColor(
  user: Pick<PublicUser, 'isAdmin' | 'isModerator' | 'staffColor'>,
): string | null {
  return (user.isAdmin || user.isModerator) && user.staffColor ? user.staffColor : null;
}

/**
 * Display name that marks instance staff not with a label, but with an animated
 * shimmer in their chosen `staffColor` — which OVERRIDES any guild role color.
 * Regular members (and staff who haven't turned it on) render normally: role
 * color when present, else the fallback color baked into `className`.
 *
 * `className` carries layout + the fallback text color (e.g. "truncate text-sm
 * text-ink-1"); the shimmer's `color`/background-clip and the role-color inline
 * style both override that fallback.
 */
export function StaffName({
  user,
  text,
  roleColor,
  className = '',
}: {
  user: Pick<PublicUser, 'isAdmin' | 'isModerator' | 'staffColor'>;
  text: string;
  roleColor?: string | null;
  className?: string;
}) {
  const shimmer = staffShimmerColor(user);
  return (
    <span
      className={shimmer ? `zk-staff-shimmer ${className}` : className}
      style={
        shimmer
          ? ({ ['--sc']: shimmer } as CSSProperties)
          : roleColor
            ? { color: roleColor }
            : undefined
      }
      title={shimmer ? (user.isAdmin ? 'Instance administrator' : 'Instance moderator') : undefined}
    >
      {text}
    </span>
  );
}
