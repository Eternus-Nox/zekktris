// Zekk Pet — the shared virtual pet two people raise in a 1:1 DM by keeping
// their messaging streak going. The server is authoritative for points,
// levels, status and mood; this module holds the pure rules both the server
// and the web client use, so their numbers and words can't drift. The iOS and
// Android apps mirror these same constants and strings.

/** Streak days a 1:1 DM needs (while the streak is alive) before either
 *  person can invite the other to adopt a pet. */
export const PET_MIN_STREAK = 3;

/** Longest pet name, after trimming and collapsing whitespace. */
export const PET_NAME_MAX_LENGTH = 24;

/** Name a new pet gets until someone renames it. */
export const PET_DEFAULT_NAME = 'Zekk';

/** Days an unanswered invite stays open. */
export const PET_INVITE_TTL_DAYS = 7;

/** Messages each person must send in a UTC day for the `chatty` task. */
export const PET_CHATTY_GOAL = 10;

export type PetStatus = 'invited' | 'active' | 'asleep';

export type PetStage = 'egg' | 'baby' | 'kid' | 'teen' | 'adult' | 'legendary';

export type PetMood = 'thriving' | 'happy' | 'lonely' | 'hungry' | 'grumpy' | 'asleep';

export type PetTaskKey = 'both_hi' | 'chatty' | 'voice' | 'photo' | 'poke';

/** Daily tasks in display order. `bit` is the task's bit in the server's
 *  `tasks_done` mask; `points` are awarded once per UTC day when it completes. */
export const PET_TASKS: ReadonlyArray<{ key: PetTaskKey; bit: number; points: number; label: string }> = [
  { key: 'both_hi', bit: 1, points: 10, label: 'Both say hi' },
  { key: 'chatty', bit: 2, points: 10, label: '10 messages each' },
  { key: 'voice', bit: 4, points: 5, label: 'Send a voice message' },
  { key: 'photo', bit: 8, points: 5, label: 'Send a photo' },
  { key: 'poke', bit: 16, points: 5, label: 'Poke each other' },
];

/** Mask with every task's bit set (a `thriving` day). */
export const PET_ALL_TASKS_MASK = PET_TASKS.reduce((m, t) => m | t.bit, 0);

/** Stages in growth order with the first level of each. */
export const PET_STAGES: ReadonlyArray<{ stage: PetStage; minLevel: number; label: string }> = [
  { stage: 'egg', minLevel: 0, label: 'Egg' },
  { stage: 'baby', minLevel: 1, label: 'Baby' },
  { stage: 'kid', minLevel: 5, label: 'Kid' },
  { stage: 'teen', minLevel: 10, label: 'Teen' },
  { stage: 'adult', minLevel: 15, label: 'Adult' },
  { stage: 'legendary', minLevel: 25, label: 'Legendary' },
];

/** The mood words (the pet's adjectives) and the line shown under each.
 *  `asleep`'s line has a `{day}` slot for the weekday of `wakeBy`. */
export const PET_MOODS: Readonly<Record<PetMood, { label: string; line: string }>> = {
  thriving: { label: 'Thriving', line: "Every task done today. It's glowing!" },
  happy: { label: 'Happy', line: 'Fed for today. Keep chatting to earn more points.' },
  lonely: { label: 'Lonely', line: 'Only one of you has said hi today.' },
  hungry: { label: 'Hungry', line: 'Say hi to each other to feed it.' },
  grumpy: { label: 'Grumpy', line: 'Your streak ends at midnight UTC. Say hi to each other!' },
  asleep: {
    label: 'Asleep',
    line: 'Your streak broke. Both say hi by {day} to wake it up, or it runs away.',
  },
};

/** Points needed to go from `level` to `level + 1`. */
export function petPointsForNextLevel(level: number): number {
  return 25 + 5 * level;
}

/** Total points needed to reach `level` from an egg:
 *  T(L) = 25·L + 5·L·(L−1)/2 (T(1)=25, T(5)=175, T(10)=475, T(15)=900, T(25)=2125). */
export function petLevelFloor(level: number): number {
  if (level <= 0) return 0;
  return 25 * level + (5 * level * (level - 1)) / 2;
}

/** The level a pet with `points` total points has reached. */
export function petLevelForPoints(points: number): number {
  let level = 0;
  while (petLevelFloor(level + 1) <= points) level++;
  return level;
}

export function petStageForLevel(level: number): PetStage {
  let stage: PetStage = 'egg';
  for (const s of PET_STAGES) if (level >= s.minLevel) stage = s.stage;
  return stage;
}

export function petStageLabel(stage: PetStage): string {
  return PET_STAGES.find((s) => s.stage === stage)?.label ?? 'Egg';
}

/**
 * Normalise a proposed pet name: drop invisible and bidi-formatting
 * characters (zero-width space U+200B, word joiner and invisible operators
 * U+2060–U+2064, BOM U+FEFF, the marks U+200E/U+200F/U+061C, and the
 * embeddings, overrides and isolates U+202A–U+202E / U+2066–U+2069, much as
 * the server strips them from display names; they would hide the name or
 * reorder the notice text around it), then trim and collapse runs of
 * whitespace to one space. ZWNJ/ZWJ (U+200C/U+200D) stay so emoji sequences
 * and scripts that need them keep working, but a name of nothing else is
 * empty. Returns null when the result is empty, longer than
 * PET_NAME_MAX_LENGTH (counted in code points), or contains a control
 * character.
 */
export function normalizePetName(raw: string): string | null {
  const name = raw
    .replace(/[\u200B\u2060-\u2064\uFEFF\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.replace(/[\u200C\u200D]/g, '').trim().length === 0) return null;
  if ([...name].length > PET_NAME_MAX_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  return name;
}
