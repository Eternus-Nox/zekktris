/**
 * PinPanel
 * --------
 * Right-side overlay listing every pinned message in a channel. Opens
 * from the Pin button in the channel header; closes on the X button or
 * by clicking the header button again.
 *
 * Live updates: subscribes to `state.channelPinUpdateAt[channelId]` so a
 * pin/unpin from any client re-fetches the panel within a render. We
 * don't bake pinned messages into AppState because the panel is
 * usually closed; a per-channel cache would mean every guild keeps an
 * extra Map<channelId, Message[]> warm even when no one is looking.
 *
 * Click a pin → scroll the main message stream to that message and
 * close the panel. Implemented via `data-message-id` lookup on the
 * Scroller's DOM. If the message isn't currently in the visible
 * scroll-back window (older than the last 200 messages), we open the
 * panel-side rendering and don't try to scroll — a future polish round
 * could load messages around that ID and jump to it.
 */
import { useEffect, useState } from 'react';
import { ApiError, type Channel, type Message } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Pin } from '../lib/icons';
import { ModalHeader } from '../lib/ModalHeader';
import { MessageItem } from './MessageItem';

export function PinPanel({
  channel,
  onClose,
}: {
  channel: Channel;
  onClose: () => void;
}) {
  const { rest, user } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();
  const [pinned, setPinned] = useState<Message[] | null>(null);

  // Re-fetch on mount + whenever the bump timestamp changes (pin/unpin
  // event delivered via gateway). The dep is a number, so re-renders
  // without a real change don't trigger refetches.
  const bumpAt = state.channelPinUpdateAt[channel.id] ?? 0;
  useEffect(() => {
    let cancelled = false;
    rest
      .listPinnedMessages(channel.id)
      .then((r) => {
        if (!cancelled) setPinned(r.messages);
      })
      .catch((e) => {
        if (cancelled) return;
        toasts.push(
          e instanceof ApiError ? e.message : 'Failed to load pinned messages',
          'error',
        );
        setPinned([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, bumpAt]);

  function jumpTo(messageId: string) {
    // The main message stream lives outside this panel; we use the
    // shared `data-message-id` DOM attribute to find the bubble, scroll
    // it into view, and briefly highlight it. If the message isn't in
    // the DOM (older than the loaded window), the lookup is a no-op
    // and we leave the panel open so the user can still see the pin.
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!el) {
      toasts.push('Pinned message is older than the loaded scroll-back', 'info');
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Flash highlight: add a class for a few hundred ms, then clear.
    el.classList.add('jump-highlight');
    setTimeout(() => el.classList.remove('jump-highlight'), 1500);
    onClose();
  }

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-full sm:w-96 max-w-full bg-bg-1 border-l border-line elevation-pop z-10 flex flex-col">
      <ModalHeader title="Pinned messages" icon={<Pin size={16} className="text-amber-400" />} onClose={onClose} />

      <div className="flex-1 overflow-y-auto scrollbar-thin py-2">
        {pinned === null ? (
          <p className="text-sm text-ink-3 text-center py-8">Loading…</p>
        ) : pinned.length === 0 ? (
          <div className="text-center py-12 px-6 space-y-2">
            <Pin size={28} className="mx-auto text-ink-3" />
            <p className="text-sm text-ink-2 font-medium">No pins yet</p>
            <p className="text-xs text-ink-3">
              This channel has no pinned messages. Hover any message and click the pin icon to pin it here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line/50">
            {pinned.map((m) => (
              <li
                key={m.id}
                className="px-2 py-2 hover:bg-bg-2/40 cursor-pointer"
                onClick={() => jumpTo(m.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    jumpTo(m.id);
                  }
                }}
              >
                <MessageItem
                  message={m}
                  continuation={false}
                  selfId={user?.id}
                  channel={channel}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
