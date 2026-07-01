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
      className={`inline-flex items-center justify-center self-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none border shrink-0 ${className}`}
      style={{
        color,
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
      title={label}
    >
      {/* Optical nudge: shift the glyphs 1px right + 1px down inside the pill
          so the short label reads visually centered. translate keeps the
          pill's box unchanged (no layout shift). */}
      <span style={{ display: 'inline-block', transform: 'translate(1px, 1px)' }}>{label}</span>
    </span>
  );
}
