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
      {/* No optical nudges — the flex centering on the pill keeps the label
          dead-center at every size (per user direction: always centered). */}
      {label}
    </span>
  );
}

/**
 * Subtle instance-staff badge — a small uppercase pill next to a user's name
 * marking an ADMINISTRATOR or MODERATOR. Renders nothing for regular members.
 * Reuses the admin panel's role colors (accent for admin, sky for moderator)
 * so the visual language is consistent app-wide. Admin takes precedence when
 * both flags are somehow set; a user is at most one. Sized to sit as a peer
 * beside the BOT pill.
 */
export function StaffBadge({
  user,
  className = '',
}: {
  user: Pick<PublicUser, 'isAdmin' | 'isModerator'>;
  className?: string;
}) {
  if (!user.isAdmin && !user.isModerator) return null;
  const admin = !!user.isAdmin;
  return (
    <span
      className={`shrink-0 inline-flex items-center self-center rounded px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider leading-none ${
        admin ? 'bg-accent/20 text-accent' : 'bg-sky-500/20 text-sky-400'
      } ${className}`}
      title={admin ? 'Instance administrator' : 'Instance moderator'}
    >
      {admin ? 'Admin' : 'Mod'}
    </span>
  );
}
