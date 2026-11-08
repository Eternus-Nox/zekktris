/**
 * useGoneMessages
 * ---------------
 * Messages gone from a view that holds its own snapshot of them outside
 * AppState — search results, the saved list, the media gallery — so it
 * follows the chat: a message deleted (MESSAGE_DELETE / _BULK, the
 * disappearing-messages sweep included) or reaching its disappearing
 * deadline (the same deadline map and server clock AppState hides the chat
 * row with) leaves the view at the moment it leaves the chat.
 *
 * Sticky: once gone, a message stays gone for the view's lifetime — after
 * AppState forgets a deadline long past, and when a later page or a request
 * already in flight brings it back (filter fresh results with `has`).
 * Search and saved DTOs carry no expiresAt, so the deadline comes from
 * AppState's map (MESSAGE_EXPIRY fills it in for the reader); the sweep's
 * MESSAGE_DELETE is the backstop.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { GatewayEvent, type GatewayClient } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppStateSelector } from '../state/AppState';
import { effectiveOffset, passedDeadlines, scheduleExpiry, serverNow } from './disappearing';

/** Record `ids` as gone; true when any of them is new. */
export function addGone(gone: Set<string>, ids: readonly string[]): boolean {
  let added = false;
  for (const id of ids) {
    if (gone.has(id)) continue;
    gone.add(id);
    added = true;
  }
  return added;
}

/** `items` without the ones whose message is gone; the SAME array when none
    is (no re-render). */
export function withoutGone<T>(
  items: T[],
  gone: ReadonlySet<string>,
  messageIdOf: (item: T) => string,
): T[] {
  return items.some((i) => gone.has(messageIdOf(i))) ? items.filter((i) => !gone.has(messageIdOf(i))) : items;
}

/** Report the ids MESSAGE_DELETE / _BULK remove from `channelId` (any
    channel when null). Returns the unsubscribe. */
export function onMessagesDeleted(
  gateway: Pick<GatewayClient, 'on'>,
  channelId: string | null,
  drop: (ids: readonly string[]) => void,
): () => void {
  const unsubs = [
    gateway.on<{ id: string; channel_id: string }>(GatewayEvent.MESSAGE_DELETE, (d) => {
      if (channelId === null || d.channel_id === channelId) drop([d.id]);
    }),
    gateway.on<{ ids: string[]; channel_id: string }>(GatewayEvent.MESSAGE_DELETE_BULK, (d) => {
      if (channelId === null || d.channel_id === channelId) drop(d.ids);
    }),
  ];
  return () => {
    for (const u of unsubs) u();
  };
}

/**
 * The view's gone set, for messages in `channelId` (null: any channel, e.g.
 * search across DMs). `onGone` runs with it whenever it grows; drop the
 * affected items there. The set is the same object for the view's lifetime.
 */
export function useGoneMessages(
  channelId: string | null,
  onGone: (gone: ReadonlySet<string>) => void,
): ReadonlySet<string> {
  const { gateway } = useAuth();
  const [gone] = useState(() => new Set<string>());
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const drop = useCallback(
    (ids: readonly string[]) => {
      if (addGone(gone, ids)) onGoneRef.current(gone);
    },
    [gone],
  );

  // Deleted messages, the disappearing-messages sweep included.
  useEffect(() => onMessagesDeleted(gateway, channelId, drop), [gateway, channelId, drop]);

  // Disappearing messages reaching their deadline: at the moment the chat
  // row goes, before the sweep's MESSAGE_DELETE — and for a reader whose
  // deadline is known it's the only signal while the view is open. One
  // timer for the earliest deadline, re-checked when the tab comes back
  // (background tabs throttle timers).
  const expiryDeadlines = useAppStateSelector((v) => v.state.expiryDeadlines);
  const clockOffsetMs = useAppStateSelector((v) =>
    effectiveOffset(v.state.serverClockOffsetMs, v.state.dateClockOffsetMs),
  );
  useEffect(() => {
    if (Object.keys(expiryDeadlines).length === 0) return;
    const scheduler = scheduleExpiry({
      deadlines: expiryDeadlines,
      offsetMs: clockOffsetMs,
      expire: () => drop(passedDeadlines(expiryDeadlines, serverNow(clockOffsetMs))),
    });
    const onWake = () => {
      if (document.visibilityState === 'visible') scheduler.recheck();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      scheduler.cancel();
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [expiryDeadlines, clockOffsetMs, drop]);

  return gone;
}
