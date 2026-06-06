/**
 * useProfileCard
 * --------------
 * Tiny hook that gives any caller a "click target" + a rendered overlay
 * for opening the ProfileCard. Centralised so we don't repeat anchor
 * tracking, click coords, and conditional rendering across half a
 * dozen avatar render sites (MessageItem, MemberList, DMList,
 * GuildSettingsModal, etc).
 *
 * Returns:
 *   - `onAvatarClick(user, e)` — bind to the avatar's onClick
 *   - `cardElement` — JSX to render somewhere in the component tree;
 *      it's null when nothing is open, otherwise the card popover
 *      (which uses Portal internally so it doesn't matter where the
 *      element is rendered)
 *
 * The hook intentionally takes `PublicUser` rather than just an id so
 * the card can render immediately with whatever profile data the call
 * site already has, without waiting for a fetch. The card itself does
 * fetch the relationship status lazily.
 */
import { lazy, Suspense, useCallback, useState, type MouseEvent, type ReactElement } from 'react';
import type { PublicUser } from '@zekktris/client';
// Lazy-loaded: the profile popover is opened on avatar click. Centralising the
// lazy boundary here covers every avatar site (MessageItem, MemberList, etc.)
// in one place. fallback={null} → the popover appears a beat after first click,
// then its chunk is cached for the session.
const ProfileCard = lazy(() =>
  import('../app/ProfileCard').then((m) => ({ default: m.ProfileCard })),
);

interface ProfileCardController {
  /** Bind to any avatar/click target. Stops propagation so parent row
      handlers (e.g. ChannelList row navigation) don't fire. */
  onAvatarClick: (user: PublicUser, e: MouseEvent) => void;
  /** Render this somewhere in your JSX. Null when the card is closed. */
  cardElement: ReactElement | null;
}

/**
 * Build a controller for showing a ProfileCard.
 *
 * @param options.guildId — when set, the card renders guild-context
 *   actions (notably role assignment for owners). Pass the active
 *   guild id from MemberList; pass nothing from DM-side surfaces.
 */
export function useProfileCard(options?: { guildId?: string }): ProfileCardController {
  const guildId = options?.guildId;
  const [open, setOpen] = useState<{
    user: PublicUser;
    anchor: { x: number; y: number };
  } | null>(null);

  const onAvatarClick = useCallback((user: PublicUser, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Use the click point directly. ProfileCard handles flipping
    // up/down + horizontal clamping so this caller doesn't need to
    // care about viewport edges.
    setOpen({ user, anchor: { x: e.clientX, y: e.clientY } });
  }, []);

  const cardElement = open ? (
    <Suspense fallback={null}>
      <ProfileCard
        user={open.user}
        anchor={open.anchor}
        guildId={guildId}
        onClose={() => setOpen(null)}
      />
    </Suspense>
  ) : null;

  return { onAvatarClick, cardElement };
}
