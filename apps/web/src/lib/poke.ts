/**
 * Poke / nudge variants — emoji + verbs.
 *
 * Mirror of the server `POKE_VARIANTS` (@zekktris/db) and the iOS
 * `PokeVariant` enum. Web deliberately duplicates rather than importing the
 * db package (which is server-only); keep all three in sync.
 */
export type PokeType = 'poke' | 'heart' | 'wave' | 'like' | 'fire';

export const POKE_TYPES: PokeType[] = ['poke', 'heart', 'wave', 'like', 'fire'];

export const POKE_VARIANTS: Record<
  PokeType,
  {
    /** Emoji shown in the notice + palette. */
    emoji: string;
    /** Phrasing shown to the RECIPIENT ("Alice 👉 poked you"). */
    verb: string;
    /** Phrasing shown to the SENDER on their own poke ("You 👉 poked them"). */
    sentVerb: string;
    /** Short palette label. */
    label: string;
  }
> = {
  poke: { emoji: '👉', verb: 'poked you', sentVerb: 'poked them', label: 'Poke' },
  heart: { emoji: '❤️', verb: 'sent you a heart', sentVerb: 'sent a heart', label: 'Heart' },
  wave: { emoji: '👋', verb: 'waved at you', sentVerb: 'waved', label: 'Wave' },
  like: { emoji: '👍', verb: 'liked you', sentVerb: 'liked them', label: 'Like' },
  fire: { emoji: '🔥', verb: 'sent you fire', sentVerb: 'sent fire', label: 'Fire' },
};
