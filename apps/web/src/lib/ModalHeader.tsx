/**
 * ModalHeader
 * -----------
 * Standardized header bar for full-screen-on-mobile / floating-on-desktop
 * modals and side panels (Settings, ChannelCreate, GuildSettings,
 * MentionsPanel, etc).
 *
 * Why this exists. We had four or five hand-rolled header bars with
 * subtly different padding, dismiss-button positions, and icon
 * sizes. The user reported that the modals didn't feel like
 * "navigation pages" on mobile — the X buttons in the top-right
 * felt like dismissing an overlay rather than backing out of a
 * page. The fix is to swap the dismiss affordance by viewport:
 *
 *   < sm (mobile):  ChevronLeft "back" button on the LEFT
 *                   (matches how channels and DMs are backed
 *                   out of — same icon, same position, same
 *                   visual weight).
 *
 *   ≥ sm (desktop): X "close" button on the RIGHT (matches
 *                   the floating-overlay aesthetic where the
 *                   user dismisses rather than navigates).
 *
 * Same dismiss callback wires both — the semantic difference is
 * purely visual. From the calling code's perspective the user is
 * "leaving" the modal; how that's presented is this component's
 * job.
 *
 * The header also pins height (h-12) and padding-x so all modal
 * tops line up at the same vertical position regardless of
 * content — addresses the "headers are at inconsistent heights"
 * complaint without forcing each callsite to hand-tune its own
 * padding.
 *
 * Use as:
 *
 *   <ModalHeader title="Settings" onClose={onClose} icon={<Settings />} />
 *
 * The `icon` slot is optional — used by panels like Admin and
 * Mentions that have a leading glyph next to the title. On mobile
 * the leading icon is hidden when present, since the back arrow
 * already occupies the left zone.
 *
 * `mobileDismiss="x"` swaps the mobile back arrow for an X — for an
 * edit screen whose dismiss means "cancel" next to its own confirm
 * button in `rightSlot` (the Disappearing Messages screen: ✕ … ✓).
 */

import { ChevronLeft, X } from './icons';

export function ModalHeader({
  title,
  subtitle,
  icon,
  onClose,
  rightSlot,
  mobileDismiss = 'back',
  dismissLabel,
}: {
  title: string;
  /** Optional secondary text shown next to the title on desktop. */
  subtitle?: React.ReactNode;
  /** Leading icon (e.g. Shield for admin). Hidden on mobile since
      the back arrow occupies the left slot. */
  icon?: React.ReactNode;
  onClose: () => void;
  /** Optional element rendered to the right of the title on
      desktop (e.g. a primary action button). On mobile this slot
      sits to the LEFT of where the close button would be. */
  rightSlot?: React.ReactNode;
  /** Mobile dismiss glyph: 'back' (ChevronLeft, the default) or 'x'. */
  mobileDismiss?: 'back' | 'x';
  /** Accessible name for the dismiss buttons (default "Back" on mobile,
      "Close" on desktop). */
  dismissLabel?: string;
}) {
  return (
    <div className="px-3 sm:px-4 h-12 border-b border-line bg-bg-2 flex items-center gap-2 sm:gap-3 shrink-0">
      {/* Mobile back button — sm:hidden. Sits to the left of the
          title, mirroring how channels and DMs back out. */}
      <button
        type="button"
        onClick={onClose}
        className="sm:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded-md text-ink-2 hover:text-ink-1 hover:bg-bg-3 active:bg-bg-3 transition-colors"
        aria-label={dismissLabel ?? (mobileDismiss === 'x' ? 'Close' : 'Back')}
      >
        {mobileDismiss === 'x' ? <X size={20} /> : <ChevronLeft size={20} />}
      </button>

      {/* Leading icon — hidden on mobile since the back arrow
          owns the left slot. */}
      {icon && <span className="hidden sm:flex items-center text-accent shrink-0">{icon}</span>}

      <h2 className="text-base sm:text-lg font-semibold text-ink-1 truncate flex-1 sm:flex-initial">
        {title}
      </h2>

      {subtitle && (
        <span className="hidden sm:inline-flex text-xs text-ink-3 truncate">{subtitle}</span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {rightSlot}
        {/* Desktop X close — hidden on mobile where the back
            arrow handles dismissal. */}
        <button
          type="button"
          onClick={onClose}
          className="hidden sm:flex w-8 h-8 items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 transition-colors"
          aria-label={dismissLabel ?? 'Close'}
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
