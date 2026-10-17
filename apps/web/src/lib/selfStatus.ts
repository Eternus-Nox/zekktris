import { useSyncExternalStore } from 'react';
import type { SelfUser } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import {
  SelfStatusStore,
  effectiveStatusOf,
  resolveSelfStatus,
  type ChosenStatus,
  type EffectiveStatus,
} from './presenceActivity';

/**
 * Our own status as the server last reported it to this device (see
 * SelfStatusStore for why it lives here and not in the auth user). Written by
 * the PRESENCE_UPDATE handler in AppState and by a status pick.
 */
export const selfStatusStore = new SelfStatusStore();

type SelfStatusView = { status: EffectiveStatus; chosenStatus: ChosenStatus };

/** Our effective status (own avatar dot) and chosen status (the picker). */
export function useSelfStatus(): SelfStatusView {
  const { user } = useAuth();
  const live = useSyncExternalStore(selfStatusStore.subscribe, selfStatusStore.get);
  if (!user) return { status: 'offline', chosenStatus: 'online' };
  return resolveSelfStatus(user, live);
}

/** The same, read once (event handlers, timers) without subscribing. */
export function currentSelfStatus(user: SelfUser): SelfStatusView {
  return resolveSelfStatus(user, selfStatusStore.get());
}

/** Record our status from a PATCH /users/@me reply — as fresh as a frame, and
 *  the store outranks the auth user once a frame has arrived. A server
 *  without multi-device presence sends no chosenStatus: nothing to record. */
export function recordSelfUser(user: SelfUser): void {
  if (!user.chosenStatus) return;
  selfStatusStore.set({
    userId: user.id,
    // Not `user.status`: on a current server that is the pick (an Online
    // pick while every device is idle would light the dot green until the
    // next frame).
    status: effectiveStatusOf(user),
    chosenStatus: user.chosenStatus,
  });
}
