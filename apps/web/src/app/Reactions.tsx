/**
 * Reactions
 * ---------
 * Renders the row of `<emoji> <count>` pills under a message and lets the
 * user click one to toggle their own reaction. A small "+" pill opens
 * the unified EmojiPicker — same picker the composer uses, so users can
 * react with both standard unicode AND custom guild emoji.
 *
 * Storage: server stores `emoji` as text. For unicode reactions that's
 * the literal glyph; for custom emoji it's the `:name:` token. We
 * detect the format on render and resolve `:name:` against the guild's
 * emoji index — hits render as inline images, misses fall through as
 * plain text (graceful degradation when an emoji was deleted).
 *
 * Toggling: PUT to add own, DELETE to remove own. The gateway echoes back
 * the reaction event and the reducer updates `reactions[]`. We don't do
 * optimistic updates — round-trip on a local network is sub-100ms, which
 * is fine for the click-feedback budget.
 */

import { useState } from 'react';
import type { Message } from '@zekktris/client';
import { ApiError } from '@zekktris/client';
import { useAppStateSelector } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Plus } from '../lib/icons';
import { EmojiPicker } from './EmojiPicker';

const EMOJI_NAME_RE = /^:([a-z0-9_]{2,32}):$/;

export function Reactions({ message, guildId }: { message: Message; guildId?: string }) {
  // Granular subscriptions (was `useAppState()`): a reaction row should not
  // re-render on unrelated dispatches (typing, presence, other channels'
  // messages).
  const emojisByGuild = useAppStateSelector((v) => v.state.emojisByGuild);
  const rest = useAppStateSelector((v) => v.rest);
  const toasts = useToasts();
  const [pickerOpen, setPickerOpen] = useState(false);

  // guildId is passed by the parent (MessageItem already knows the channel's
  // guild) so we can show custom emoji in the picker AND render `:name:`
  // reactions as images — without re-scanning every guild's channel list on
  // each reaction-row render (and without subscribing to channelsByGuild, whose
  // reference churns on every channel event). DMs pass undefined.
  const guildEmojis = guildId ? emojisByGuild[guildId] ?? [] : [];

  async function toggle(emoji: string, currentlyMine: boolean) {
    try {
      if (currentlyMine) {
        await rest.removeReaction(message.channelId, message.id, emoji);
      } else {
        await rest.addReaction(message.channelId, message.id, emoji);
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Reaction failed', 'error');
    }
  }

  function pick(emoji: string) {
    setPickerOpen(false);
    void toggle(emoji, false);
  }

  if (message.reactions.length === 0 && !pickerOpen) {
    // No reactions yet: render nothing here. The "add reaction"
    // affordance lives in the message-row hover action strip (next
    // to Reply) — see MessageItem. This keeps the message stream
    // visually quiet on rows with zero reactions, instead of
    // padding every row with an empty pill placeholder. The picker
    // can still be opened externally via the `openPicker` ref passed
    // into Reactions, which the hover Reply/React strip wires up.
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1 relative">
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          onClick={() => void toggle(r.emoji, r.me)}
          className={`px-1.5 py-0.5 rounded-md text-sm flex items-center gap-1 border transition-colors ${
            r.me
              ? 'bg-accent/20 border-accent/60 hover:bg-accent/30'
              : 'bg-bg-2 border-line hover:bg-bg-3'
          }`}
        >
          <ReactionGlyph emoji={r.emoji} guildEmojis={guildEmojis} />
          <span className="text-xs text-ink-2">{r.count}</span>
        </button>
      ))}
      <button
        onClick={() => setPickerOpen((v) => !v)}
        className="w-7 h-6 flex items-center justify-center rounded-md bg-bg-2 border border-line hover:bg-bg-3 text-ink-3 hover:text-ink-1"
        title="Add reaction"
        aria-label="Add reaction"
      >
        <Plus size={12} />
      </button>

      {pickerOpen && (
        <div className="absolute bottom-full left-0 mb-2 z-20">
          <EmojiPicker
            guildId={guildId}
            onSelect={pick}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Renders a reaction's emoji glyph. For unicode reactions it's the
 * literal text; for `:name:` reactions we resolve against the guild's
 * emoji index and render an `<img>`. Unknown `:name:` (deleted or
 * never-existed) falls back to the literal text.
 */
function ReactionGlyph({
  emoji,
  guildEmojis,
}: {
  emoji: string;
  guildEmojis: { name: string; url: string }[];
}) {
  const named = EMOJI_NAME_RE.exec(emoji);
  if (named) {
    const found = guildEmojis.find((e) => e.name === named[1]);
    if (found) {
      return (
        <img
          src={found.url}
          alt={emoji}
          title={emoji}
          className="w-[18px] h-[18px] object-contain"
          loading="lazy"
          draggable={false}
        />
      );
    }
  }
  return (
    <span className="inline-flex items-center justify-center w-[18px] h-[18px] leading-none text-base">
      {emoji}
    </span>
  );
}
