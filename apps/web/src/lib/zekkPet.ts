/**
 * Zekk Pet
 * --------
 * Pure view-model helpers for the pet two people raise in a 1:1 DM: the mood
 * chip, today's care checklist, the level bar, the stage path, the adopt
 * banner and the in-chat notice text. The server is authoritative for every
 * number (points, level, status, mood); these only turn a PetDTO into words,
 * using the shared strings (PET_MOODS, PET_TASKS, PET_STAGES) so the web reads
 * exactly like the server and the native apps. No React, no DOM — the vitest
 * suite (test/zekkPet.test.ts) drives every function here directly.
 */

import {
  PET_MIN_STREAK,
  PET_MOODS,
  PET_STAGES,
  PET_TASKS,
  petStageLabel,
  type DmPetState,
  type Message,
  type MessageMetadata,
  type PetDTO,
  type PetMood,
  type PetNoticeEvent,
  type PetStage,
  type PetTaskKey,
} from '@zekktris/client';
import { maskProfanity } from './profanity';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday" for "2026-11-13" — the weekday of a UTC day (pets live on UTC
    days, so the viewer's own time zone must not shift it). null when the
    value isn't a YYYY-MM-DD day. */
export function utcWeekday(day: string | null | undefined): string | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return WEEKDAYS[new Date(t).getUTCDay()] ?? null;
}

/** The YYYY-MM-DD day `n` days after `day` (UTC). */
function addDays(day: string, n: number): string | null {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** The pet's name as this viewer sees it. Either person in the DM can rename
    it, so a supervised child whose guardian turned on the profanity mask sees
    swear words masked here, the same as in message bodies. */
export function petDisplayName(name: string, filterProfanity: boolean): string {
  return filterProfanity ? maskProfanity(name) : name;
}

// ── Mood ──────────────────────────────────────────────────────────────────

export interface PetMoodView {
  mood: PetMood;
  /** The adjective: "Happy", "Asleep" … */
  label: string;
  /** The line under it; asleep's names the weekday it can still be woken. */
  line: string;
}

/** The mood chip. The asleep line's `{day}` is the weekday of `wakeBy`
    (falling back to last fed day + 3, the same rule, if a server left it out). */
export function petMoodView(pet: Pick<PetDTO, 'mood' | 'wakeBy' | 'lastFedDay'>): PetMoodView {
  const mood: PetMood = pet.mood in PET_MOODS ? pet.mood : 'happy';
  const { label, line } = PET_MOODS[mood];
  if (mood !== 'asleep') return { mood, label, line };
  const wakeBy = pet.wakeBy ?? (pet.lastFedDay ? addDays(pet.lastFedDay, 3) : null);
  const day = utcWeekday(wakeBy) ?? 'tomorrow';
  return { mood, label, line: line.replace('{day}', day) };
}

// ── Today's care ──────────────────────────────────────────────────────────

export interface PetTaskRow {
  key: PetTaskKey;
  label: string;
  points: number;
  done: boolean;
  /** `chatty` only: "{me}/10 · {them}/10". */
  progress: string | null;
}

/** The checklist rows, in the shared display order. A task the DTO doesn't
    list (an invited pet has none) reads as not done. */
export function petTaskRows(pet: Pick<PetDTO, 'tasks'>, selfId: string | undefined): PetTaskRow[] {
  return PET_TASKS.map((t) => {
    const task = pet.tasks?.find((x) => x.key === t.key);
    let progress: string | null = null;
    if (t.key === 'chatty' && task?.progress) {
      const { a, b, goal } = task.progress;
      const mine = a && a.userId === selfId ? a : b && b.userId === selfId ? b : undefined;
      const theirs = mine === a ? b : a;
      progress = `${Math.min(mine?.count ?? 0, goal)}/${goal} · ${Math.min(theirs?.count ?? 0, goal)}/${goal}`;
    }
    return {
      key: t.key,
      label: t.label,
      points: task?.points ?? t.points,
      done: task?.done === true,
      progress,
    };
  });
}

// ── Level ─────────────────────────────────────────────────────────────────

export interface PetLevelProgress {
  /** Points earned since this level started. */
  have: number;
  /** Points this level takes. */
  need: number;
  /** have / need, 0–1. */
  fraction: number;
  /** "40/35 to level 3" → "{have}/{need} to level {L+1}". */
  label: string;
}

export function petLevelProgress(
  pet: Pick<PetDTO, 'points' | 'level' | 'levelFloor' | 'nextLevelAt'>,
): PetLevelProgress {
  const need = Math.max(0, pet.nextLevelAt - pet.levelFloor);
  const have = Math.min(Math.max(0, pet.points - pet.levelFloor), need);
  const fraction = need > 0 ? have / need : 0;
  return { have, need, fraction, label: `${have}/${need} to level ${pet.level + 1}` };
}

/** "Level 3 · Baby". */
export function petLevelLine(pet: Pick<PetDTO, 'level' | 'stage'>): string {
  return `Level ${pet.level} · ${petStageLabel(pet.stage)}`;
}

export interface PetStageStep {
  stage: PetStage;
  label: string;
  /** The pet's stage now. */
  current: boolean;
  /** Already grown through (or current). */
  reached: boolean;
}

/** Egg → Baby → Kid → Teen → Adult → Legendary, the current one marked. */
export function petStagePath(stage: PetStage): PetStageStep[] {
  const at = Math.max(
    0,
    PET_STAGES.findIndex((s) => s.stage === stage),
  );
  return PET_STAGES.map((s, i) => ({ stage: s.stage, label: s.label, current: i === at, reached: i <= at }));
}

// ── Adopt banner ──────────────────────────────────────────────────────────

export type PetBannerKind = 'adopt' | 'waiting' | 'invited';

export interface PetBanner {
  kind: PetBannerKind;
  text: string;
  /** 'invited' only: the streak broke or is under minStreak, so accepting
      would only fail. Accept hides until the streak is back (Not now stays). */
  locked?: true;
}

/**
 * The slim bar under the DM header:
 *   - no pet, and the DM may adopt → "🥚 5-day streak! Adopt a Zekk Pet with Sam." [Adopt]
 *   - our invite is waiting → "Waiting for Sam to accept your Zekk Pet." [Cancel]
 *   - their invite to us → "Sam wants to raise a Zekk Pet with you." [Accept] [Not now]
 *     (the streak is under minStreak → "… Keep a 3-day streak going to accept." [Not now])
 * null otherwise (not loaded, not eligible, or a pet that's hatched already).
 */
export function petBanner(
  state: DmPetState | undefined,
  selfId: string | undefined,
  peerName: string,
): PetBanner | null {
  if (!state || !selfId) return null;
  const pet = state.pet;
  if (!pet) {
    if (!state.eligible) return null;
    return { kind: 'adopt', text: `🥚 ${state.streak}-day streak! Adopt a Zekk Pet with ${peerName}.` };
  }
  if (pet.status !== 'invited') return null;
  if (pet.invitedBy === selfId) {
    return { kind: 'waiting', text: `Waiting for ${peerName} to accept your Zekk Pet.` };
  }
  const text = `${peerName} wants to raise a Zekk Pet with you.`;
  // The invite outlives a broken streak (it lapses after 7 days), but the
  // server only lets it be accepted on a live streak of minStreak or more.
  if (state.streak < state.minStreak) {
    return {
      kind: 'invited',
      text: `${text} Keep a ${state.minStreak}-day streak going to accept.`,
      locked: true,
    };
  }
  return { kind: 'invited', text };
}

/** Whether the viewer may invite, accept or rename right now. The server
    says no while either person blocks the other, the viewer is muted or
    supervision-restricted, or the other person left the DM: Accept and
    Rename would only fail, so they hide (Not now / Cancel stay). Older
    servers don't send it: treat as yes. */
export function petCanAct(state: DmPetState | undefined): boolean {
  return state?.canAct !== false;
}

// ── The in-chat notice ────────────────────────────────────────────────────

export type PetNoticeMeta = Extract<MessageMetadata, { kind: 'pet' }>;

/** A Zekk Pet notice row: type 'system_pet', or (defensively) any row
    carrying the 'pet' metadata. */
export function isPetNotice(m: { type: string; metadata?: { kind: string } | null }): boolean {
  return m.type === 'system_pet' || m.metadata?.kind === 'pet';
}

/** The notice's metadata, when the row has it. */
export function petNoticeMeta(m: Pick<Message, 'metadata'>): PetNoticeMeta | null {
  return m.metadata?.kind === 'pet' ? m.metadata : null;
}

/**
 * What rows that just landed at the bottom of the chat do to its scroll.
 * 'own': the viewer's, so the view follows them down. 'other': someone
 * else's, so a scrolled-up viewer gets the 'New messages' pill. 'quiet': only
 * pet notices the viewer didn't cause, which raise nothing (a quiet notice
 * never pings). A pet notice is its actor's, not its author's: the daily
 * check's 'asleep' / 'ran_away' carry user A as author and no actor.
 * The tail decides 'own'; every row after `prevLastId` counts for the pill,
 * so a message that lands with a notice in the same render still raises it.
 * When that row is gone (a confirmed local send) any real row does.
 */
export function appendScrollKind(
  rows: ReadonlyArray<Pick<Message, 'id' | 'type' | 'metadata' | 'author'>>,
  prevLastId: string | null,
  selfId: string | null | undefined,
): 'own' | 'other' | 'quiet' {
  const tail = rows[rows.length - 1];
  if (!tail) return 'quiet';
  const ownerId = isPetNotice(tail) ? (petNoticeMeta(tail)?.actorId ?? null) : (tail.author?.id ?? null);
  if (selfId && ownerId === selfId) return 'own';
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    if (m.id === prevLastId) break;
    if (!isPetNotice(m)) return 'other';
  }
  return 'quiet';
}

/** "a Kid", "an Adult". */
function withArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/**
 * The notice line, built from metadata: "You" for the viewer, the other
 * person's (nicknamed) name otherwise. `peerName` is the other person in the
 * DM — the adoption names both. null for an event this client doesn't know
 * (or an actor event without its actor): show the row's fallback `content`.
 */
export function petNoticeText({
  event,
  petName,
  stage,
  actorIsSelf,
  actorName,
  peerName,
}: {
  event: PetNoticeEvent | string;
  petName: string;
  stage: PetStage;
  /** The actor is the viewer. */
  actorIsSelf: boolean;
  /** The actor's name when it isn't the viewer; null when there's no actor. */
  actorName: string | null;
  peerName: string;
}): string | null {
  const who = actorIsSelf ? 'You' : actorName;
  switch (event) {
    case 'invited':
      return who ? `${who} ${actorIsSelf ? 'want' : 'wants'} to raise a Zekk Pet together. 🥚` : null;
    case 'adopted':
      // The viewer is always one of the two, so they read first.
      return `You and ${actorIsSelf || !actorName ? peerName : actorName} adopted a Zekk Pet! 🥚`;
    case 'hatched':
      return `${petName} hatched! 🐣`;
    case 'evolved':
      return `${petName} grew into ${withArticle(petStageLabel(stage))}!`;
    case 'asleep':
      return `${petName} fell asleep. 😴 Say hi to each other within 2 days to wake it up.`;
    case 'awake':
      return `${petName} woke up! 🎉`;
    case 'ran_away':
      return `${petName} ran away. Keep a ${PET_MIN_STREAK}-day streak to adopt a new one.`;
    case 'renamed':
      return who ? `${who} renamed the pet to ${petName}.` : null;
    default:
      return null;
  }
}

/** The small pet drawn beside a notice: the stage it reached, asleep for the
    asleep notice, lonely when it ran away, happy otherwise. */
export function petNoticeArt(meta: Pick<PetNoticeMeta, 'event' | 'stage'>): { stage: PetStage; mood: PetMood } {
  const stage: PetStage = PET_STAGES.some((s) => s.stage === meta.stage) ? meta.stage : 'egg';
  const mood: PetMood = meta.event === 'asleep' ? 'asleep' : meta.event === 'ran_away' ? 'lonely' : 'happy';
  return { stage, mood };
}

/** Progress towards the next level for the art (the egg cracks near the end). */
export function petArtProgress(pet: Pick<PetDTO, 'points' | 'level' | 'levelFloor' | 'nextLevelAt'>): number {
  return petLevelProgress(pet).fraction;
}

/** Slack after a boundary, so the refetch lands on the far side of it. */
const REFRESH_SLACK_MS = 5_000;

/**
 * When the open DM should refetch its pet even if no event comes: the mood
 * is worked out when the server answers, and two of its rules turn on the
 * clock alone — 18:00 UTC (a pet fed yesterday turns grumpy) and the end of
 * the UTC day (today's tasks reset). Returns the next of those (epoch ms, a
 * few seconds past it) that is still ahead of `now`, or null when the DTO
 * has neither. A boundary counts until its slack is over too, so a re-render
 * inside those seconds returns the same time and the pending timer stands.
 */
export function petNextRefreshAt(pet: Pick<PetDTO, 'today' | 'dayEndsAt'>, now: number): number | null {
  const candidates: number[] = [];
  const evening = Date.parse(`${pet.today}T18:00:00Z`);
  if (!Number.isNaN(evening)) candidates.push(evening);
  const dayEnd = Date.parse(pet.dayEndsAt);
  if (!Number.isNaN(dayEnd)) candidates.push(dayEnd);
  const next = candidates.filter((t) => t + REFRESH_SLACK_MS > now).sort((a, b) => a - b)[0];
  return next === undefined ? null : next + REFRESH_SLACK_MS;
}

/**
 * When the open DM should refetch because its streak may break: at the next
 * midnight UTC (epoch ms, a few seconds past it). Adopt and Accept are only
 * offered on a live streak, and no event says when one ends. Like
 * petNextRefreshAt, a midnight counts until its slack is over, so a re-render
 * in those seconds returns the same time and the pending timer stands.
 */
export function nextUtcMidnightRefreshAt(now: number): number {
  const d = new Date(now - REFRESH_SLACK_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + REFRESH_SLACK_MS;
}
