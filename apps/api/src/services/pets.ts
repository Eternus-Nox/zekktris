/**
 * Zekk Pets
 * ---------
 * A shared virtual pet two people raise in their 1:1 DM by keeping their
 * messaging streak going. The rules — level curve, stages, daily tasks and
 * their points, the mood words and the name rules — live in
 * @zekktris/shared/pets so the server and the web client can't drift; this
 * module applies them to the `dm_pets` row and is its only writer.
 *
 *   - Adopt: once the DM's streak is alive (credited today or yesterday, UTC)
 *     and at least PET_MIN_STREAK days, either person invites; the other
 *     accepts and an egg appears. The inviter can cancel and the invitee can
 *     decline (no notice for either); unanswered invites lapse after
 *     PET_INVITE_TTL_DAYS.
 *   - Daily tasks: every 1:1 send and poke reports here (recordActivity, fire
 *     and forget from routes/messages.ts). Each task awards its points the
 *     first time it completes in a UTC day; `both_hi` feeds the pet.
 *   - Sleep / run away (sweepPets): a pet that missed a whole day falls
 *     asleep; feeding it wakes it with its points and level kept; still
 *     asleep after two more days, it runs away (the row is deleted).
 *   - Mood is never stored: petDTO derives it from the row and the clock.
 *
 * Only timestamps and attachment types are read — never content — so E2EE
 * conversations take part fully, as with streaks.
 *
 * Every write to a DM's pet runs in one transaction holding a per-channel
 * advisory lock (the recordDmMessage pattern), so the two people's first
 * messages of the day, an accept racing a decline, or the sweep racing a feed
 * can't each act on a stale row. Notices ('system_pet') are inserted in that
 * same transaction; the gateway events go out after it commits, with nothing
 * awaited in between (announce), so they leave in commit order.
 */

import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  PET_ALL_TASKS_MASK,
  PET_CHATTY_GOAL,
  PET_DEFAULT_NAME,
  PET_INVITE_TTL_DAYS,
  PET_MIN_STREAK,
  PET_TASKS,
  normalizePetName,
  petLevelFloor,
  petLevelForPoints,
  petStageForLevel,
  petStageLabel,
  type PetMood,
  type PetStage,
  type PetStatus,
  type PetTaskKey,
} from '@zekktris/shared/pets';
import type { PetNoticeEvent } from '@zekktris/db';
import { db, schema } from '../db';
import { errors } from '../errors';
import { createSystemMessage, type DbHandle } from './messages';
import { listAllRecipients, notifyHeldReadMarker } from './dms';
import * as supervision from './supervision';
import { toMessage } from '../lib/dto';
import * as dispatch from '../gateway/dispatch';
import { log } from '../log';

/** One of today's care tasks (wire shape of the client `PetTask`). */
export interface PetTaskDTO {
  key: PetTaskKey;
  done: boolean;
  points: number;
  progress?: {
    a?: { userId: string; count: number };
    b?: { userId: string; count: number };
    goal: number;
  };
}

/** A DM's pet as the clients see it (camelCase; the client `PetDTO`). */
export interface PetDTO {
  channelId: string;
  status: PetStatus;
  invitedBy: string | null;
  name: string;
  level: number;
  stage: PetStage;
  points: number;
  levelFloor: number;
  nextLevelAt: number;
  mood: PetMood;
  tasks: PetTaskDTO[];
  fedToday: boolean;
  lastFedDay: string | null;
  wakeBy: string | null;
  adoptedAt: string | null;
  today: string;
  dayEndsAt: string;
}

/** What a send or poke contributes. A send is 'message', plus 'voice' /
 *  'photo' when it carried one. */
export type PetActivity = 'message' | 'voice' | 'photo' | 'poke';

type PetRow = typeof schema.dmPets.$inferSelect;

/** UTC hour from which a pet fed only yesterday turns grumpy: the streak
 *  ends at the next midnight. */
const GRUMPY_FROM_HOUR_UTC = 18;
/** Same display cap as services/streaks.ts. */
const STREAK_CAP = 10_000;

const BOTH_HI = PET_TASKS.find((t) => t.key === 'both_hi')!;
const CHATTY = PET_TASKS.find((t) => t.key === 'chatty')!;
const ACTIVITY_BIT: Partial<Record<PetActivity, number>> = {
  voice: PET_TASKS.find((t) => t.key === 'voice')!.bit,
  photo: PET_TASKS.find((t) => t.key === 'photo')!.bit,
  poke: PET_TASKS.find((t) => t.key === 'poke')!.bit,
};

// ── Clock ───────────────────────────────────────────────────────────────────

let clock: () => Date = () => new Date();

/** Tests only: pin the time the pet rules see (null = the real clock). Also
 *  forgets the sweep's previous tick. */
export function setPetClockForTests(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
  lastSweepAt = null;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

// ── Pure rules over a row ───────────────────────────────────────────────────

/** The row's counters for `today`; another day's read as nothing done. */
function todayCounters(row: PetRow, today: string) {
  return row.taskDay === today
    ? { countA: row.countA, countB: row.countB, tasksDone: row.tasksDone }
    : { countA: 0, countB: 0, tasksDone: 0 };
}

/** An invite nobody answered within PET_INVITE_TTL_DAYS: treated as gone
 *  everywhere, even before the sweep deletes it. */
function inviteLapsed(row: PetRow, now: Date): boolean {
  return (
    row.status === 'invited' &&
    row.createdAt.getTime() <= now.getTime() - PET_INVITE_TTL_DAYS * 86_400_000
  );
}

/** Unfed for the day it fell asleep plus two more: it runs away at the next
 *  sweep, and nothing (not even a feed) brings it back first. */
function dueToRunAway(row: PetRow, today: string): boolean {
  return row.status !== 'invited' && row.lastFedDay !== null && row.lastFedDay <= addDays(today, -4);
}

/** The adjective, in the spec's order: asleep; fed today (thriving when every
 *  task is done, else happy); lonely while only one person has messaged
 *  today; grumpy from 18:00 UTC when it was last fed yesterday; else hungry.
 *  An invite (no pet yet) reads 'happy'. */
export function petMood(row: PetRow, now: Date): PetMood {
  if (row.status === 'asleep') return 'asleep';
  if (row.status === 'invited') return 'happy';
  const today = utcDay(now);
  const { countA, countB, tasksDone } = todayCounters(row, today);
  if (row.lastFedDay === today) {
    return (tasksDone & PET_ALL_TASKS_MASK) === PET_ALL_TASKS_MASK ? 'thriving' : 'happy';
  }
  if (countA > 0 !== countB > 0) return 'lonely';
  if (row.lastFedDay === addDays(today, -1) && now.getUTCHours() >= GRUMPY_FROM_HOUR_UTC) {
    return 'grumpy';
  }
  return 'hungry';
}

export function petDTO(row: PetRow, now: Date = clock()): PetDTO {
  const today = utcDay(now);
  const head = {
    channelId: row.channelId.toString(),
    status: row.status,
    invitedBy: row.invitedBy?.toString() ?? null,
    name: row.name,
  };
  const tail = { today, dayEndsAt: nextUtcMidnight(now).toISOString() };
  if (row.status === 'invited') {
    // Not adopted yet: an egg with nothing to do.
    return {
      ...head,
      level: 0,
      stage: 'egg',
      points: 0,
      levelFloor: 0,
      nextLevelAt: petLevelFloor(1),
      mood: petMood(row, now),
      tasks: [],
      fedToday: false,
      lastFedDay: null,
      wakeBy: null,
      adoptedAt: null,
      ...tail,
    };
  }
  const { countA, countB, tasksDone } = todayCounters(row, today);
  return {
    ...head,
    level: row.level,
    stage: petStageForLevel(row.level),
    points: row.points,
    levelFloor: petLevelFloor(row.level),
    nextLevelAt: petLevelFloor(row.level + 1),
    mood: petMood(row, now),
    tasks: PET_TASKS.map((t) => ({
      key: t.key,
      done: (tasksDone & t.bit) !== 0,
      points: t.points,
      ...(t.key === CHATTY.key
        ? {
            progress: {
              a: { userId: row.userAId.toString(), count: Math.min(countA, PET_CHATTY_GOAL) },
              b: { userId: row.userBId.toString(), count: Math.min(countB, PET_CHATTY_GOAL) },
              goal: PET_CHATTY_GOAL,
            },
          }
        : {}),
    })),
    fedToday: row.lastFedDay === today,
    lastFedDay: row.lastFedDay,
    // The last day a feed still wakes it: it runs away on lastFedDay + 4.
    wakeBy: row.status === 'asleep' && row.lastFedDay ? addDays(row.lastFedDay, 3) : null,
    adoptedAt: row.adoptedAt?.toISOString() ?? null,
    ...tail,
  };
}

/** The counters, tasks, points and status after `kinds` from one side, and
 *  the notices that earns ('awake', then a stage change). `seeded`: the
 *  message is one the accept's seed already stands for (recordActivity), so
 *  it makes that side's count at least 1 instead of adding one. Pure. */
function applyActivity(
  row: PetRow,
  today: string,
  side: 'a' | 'b',
  kinds: readonly PetActivity[],
  seeded = false,
): { next: PetRow; events: PetNoticeEvent[] } {
  let { countA, countB, tasksDone } = todayCounters(row, today);
  const doneBefore = tasksDone;
  // Capped: past the chatty goal a count changes nothing anyone sees.
  const counted = (n: number) => Math.min(seeded ? Math.max(n, 1) : n + 1, PET_CHATTY_GOAL);
  for (const kind of kinds) {
    if (kind === 'message') {
      if (side === 'a') countA = counted(countA);
      else countB = counted(countB);
    } else {
      tasksDone |= ACTIVITY_BIT[kind] ?? 0;
    }
  }
  if (countA >= 1 && countB >= 1) tasksDone |= BOTH_HI.bit;
  if (countA >= PET_CHATTY_GOAL && countB >= PET_CHATTY_GOAL) tasksDone |= CHATTY.bit;

  const newly = tasksDone & ~doneBefore;
  const points = row.points + PET_TASKS.reduce((n, t) => n + (newly & t.bit ? t.points : 0), 0);
  const level = petLevelForPoints(points);
  const fed = (newly & BOTH_HI.bit) !== 0;
  const events: PetNoticeEvent[] = [];
  let status = row.status;
  if (fed && status === 'asleep') {
    status = 'active';
    events.push('awake');
  }
  const stageBefore = petStageForLevel(row.level);
  const stageAfter = petStageForLevel(level);
  if (stageAfter !== stageBefore) events.push(stageBefore === 'egg' ? 'hatched' : 'evolved');
  return {
    next: {
      ...row,
      status,
      points,
      level,
      lastFedDay: fed ? today : row.lastFedDay,
      taskDay: today,
      countA,
      countB,
      tasksDone,
    },
    events,
  };
}

function rowChanged(a: PetRow, b: PetRow): boolean {
  return (
    a.status !== b.status ||
    a.points !== b.points ||
    a.level !== b.level ||
    a.lastFedDay !== b.lastFedDay ||
    a.taskDay !== b.taskDay ||
    a.countA !== b.countA ||
    a.countB !== b.countB ||
    a.tasksDone !== b.tasksDone
  );
}

function sameDTO(a: PetDTO, b: PetDTO): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Notices ─────────────────────────────────────────────────────────────────

/**
 * Defuse a user-chosen name (the pet's, or a display name) for a notice's
 * fallback `content`. Installed apps that predate 'system_pet' render that
 * content as an ordinary message — a mention scan over the raw string, then
 * inline markdown (CommonMark on iOS) — in a bubble authored by one of the
 * two people, often carrying the name the other one chose. Left raw,
 * `[Claim](https://evil.io)` would show there as a masked link and `<@id>` as
 * someone's profile chip.
 *  - An invisible word joiner (U+2060, which normalizePetName strips from
 *    names) goes after every `]`, so no link, image, reference or
 *    `^[…](…)` attribute can form (each needs `(`, `[` or `:` right after
 *    the `]`), and after every `\`, so it is never an escape and prints once
 *    on every renderer. No backslash-escapes: Android and the web have none,
 *    so they would print them (`\[AFK\] Ari`).
 *  - The same joiner goes after every `<` and after the `@` of @everyone /
 *    @here, so no autolink, inline HTML or mention token (`<@id>`, `<@&id>`,
 *    `<#id>`) can form on either app.
 * Emphasis characters stay: at worst they style the name itself, and an
 * escape would print as a backslash on Android (`cool\_guy`). The metadata
 * keeps the raw name; new clients show it as plain text.
 */
export function escapeNoticeInline(s: string): string {
  return s
    .replace(/[\\\]]/g, '$&⁠')
    .replace(/</g, '<⁠')
    .replace(/@(everyone|here)/g, '@⁠$1');
}

/**
 * The readable third-person `content` of a 'system_pet' notice — what
 * installed apps that don't know the type show as-is. New clients build their
 * own "You…" line from the metadata instead. Every name in it goes through
 * escapeNoticeInline.
 */
export function petNoticeText(
  event: PetNoticeEvent,
  p: { petName: string; stage: PetStage; actorName?: string; otherName?: string },
): string {
  const actor = escapeNoticeInline(p.actorName ?? 'Someone');
  const pet = escapeNoticeInline(p.petName);
  switch (event) {
    case 'invited':
      return `${actor} wants to raise a Zekk Pet together. 🥚`;
    case 'adopted':
      return `${actor} and ${escapeNoticeInline(p.otherName ?? 'Someone')} adopted a Zekk Pet! 🥚`;
    case 'hatched':
      return `${pet} hatched! 🐣`;
    case 'evolved': {
      const label = petStageLabel(p.stage);
      return `${pet} grew into ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}!`;
    }
    case 'asleep':
      return `${pet} fell asleep. 😴 Say hi to each other within 2 days to wake it up.`;
    case 'awake':
      return `${pet} woke up! 🎉`;
    case 'ran_away':
      return `${pet} ran away. Keep a ${PET_MIN_STREAK}-day streak to adopt a new one.`;
    case 'renamed':
      return `${actor} renamed the pet to ${pet}.`;
  }
}

async function displayNameOf(exec: DbHandle, userId: bigint | null): Promise<string> {
  if (userId === null) return 'Someone';
  const [u] = await exec
    .select({ displayName: schema.users.displayName, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return u?.displayName || u?.username || 'Someone';
}

/**
 * Insert a 'system_pet' notice in the caller's transaction. Authored by the
 * actor, or user A for the sweep's events (the author FK needs someone; the
 * metadata's actorId stays null). It leaves every read marker and the DM's
 * last_message_id alone, as call records do: a notice never makes the DM
 * unread, never moves a marker past what someone hasn't read, and sends no
 * push. Pet notices never disappear (createSystemMessage sets no timer).
 */
async function insertNotice(
  tx: DbHandle,
  input: {
    pet: PetRow;
    event: PetNoticeEvent;
    actorId: bigint | null;
    otherId?: bigint | null;
  },
): Promise<schema.Message> {
  const stage = petStageForLevel(input.pet.status === 'invited' ? 0 : input.pet.level);
  const needsNames = input.event === 'invited' || input.event === 'adopted' || input.event === 'renamed';
  const content = petNoticeText(input.event, {
    petName: input.pet.name,
    stage,
    ...(needsNames ? { actorName: await displayNameOf(tx, input.actorId) } : {}),
    ...(input.event === 'adopted' ? { otherName: await displayNameOf(tx, input.otherId ?? null) } : {}),
  });
  return createSystemMessage(
    {
      channelId: input.pet.channelId,
      guildId: null,
      authorId: input.actorId ?? input.pet.userAId,
      content,
      type: 'system_pet',
      mentionedUserIds: [],
      metadata: {
        kind: 'pet',
        event: input.event,
        petName: input.pet.name,
        stage,
        actorId: input.actorId?.toString() ?? null,
      },
    },
    tx,
  );
}

/** Does anything from someone other than `userId` (not deleted) sit between
 *  their stored read marker and `belowId`? Other pet notices don't count:
 *  they never make the DM unread, so a client marker past them hides
 *  nothing. */
async function unreadMessageBelow(input: {
  userId: bigint;
  channelId: bigint;
  belowId: bigint;
}): Promise<boolean> {
  const [rs] = await db
    .select({ last: schema.readStates.lastMessageId })
    .from(schema.readStates)
    .where(
      and(eq(schema.readStates.userId, input.userId), eq(schema.readStates.channelId, input.channelId)),
    )
    .limit(1);
  const [hit] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, input.channelId),
        lt(schema.messages.id, input.belowId),
        gt(schema.messages.id, rs?.last ?? 0n),
        isNull(schema.messages.deletedAt),
        sql`${schema.messages.authorId} IS DISTINCT FROM ${input.userId}`,
        sql`${schema.messages.type} <> 'system_pet'`,
      ),
    )
    .limit(1);
  return !!hit;
}

/**
 * After the commit: DM_PET_UPDATE to the DM's recipients (when `pet` is
 * given; null = gone), then each notice the way system rows reach a DM —
 * re-subscribe the recipients' connections, MESSAGE_CREATE, and the author's
 * held read marker. The author's clients move their local marker to their
 * own row on its echo, but a notice never moves the stored one, and its
 * author hasn't necessarily read what came before it: a poke or a widget
 * action reads nothing, a sweep notice ('asleep', 'ran_away', actorId null)
 * is only nominally user A's, and the other person's message can land
 * between a send and the notice it causes. So whenever anything from the
 * other person waits between the author's stored marker and the notice, that
 * marker goes back to their devices (a CHANNEL_ACK, after the echo). This
 * covers the timed message the call-record pattern
 * (notifyHeldReadMarkerIfWaiting) looks for, and any other unread one.
 *
 * Call it straight after the commit, with `recipientIds` read inside the
 * locked transaction: nothing is awaited between the commit and the
 * DM_PET_UPDATE, so a DM's events leave in commit order. Clients take the
 * latest one as the truth and no later event need come (a capped chatty
 * count, a rename); were the lookup made here, a writer waiting for a pool
 * connection could have the next writer, which only takes the lock as this
 * one commits, publish first and leave the clients on the older pet.
 */
async function announce(
  channelId: bigint,
  recipientIds: bigint[],
  notices: schema.Message[],
  pet: PetDTO | null | undefined,
): Promise<void> {
  if (pet !== undefined) dispatch.dmPetUpdate({ channelId, recipientIds, pet });
  if (notices.length === 0) return;
  try {
    dispatch.dmSubscribeRecipients({ channelId, recipientIds });
  } catch {
    // Best-effort: the REST refetch still covers a stale connection.
  }
  for (const notice of notices) {
    const [author] = notice.authorId
      ? await db.select().from(schema.users).where(eq(schema.users.id, notice.authorId)).limit(1)
      : [];
    dispatch.messageCreate({
      messageDTO: toMessage({ message: notice, author: author ?? null }),
      channelId,
      guildId: null,
    });
    if (
      notice.authorId !== null &&
      (await unreadMessageBelow({ userId: notice.authorId, channelId, belowId: notice.id }).catch(
        () => false,
      ))
    ) {
      await notifyHeldReadMarker({ userId: notice.authorId, channelId });
    }
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function lockPet(tx: DbHandle, channelId: bigint): Promise<void> {
  // Its own key space, so a pet write never queues behind the DM's streak
  // update (recordDmMessage locks the bare channel id).
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${'pet:' + channelId.toString()}, 0))`,
  );
}

async function loadRow(exec: DbHandle, channelId: bigint): Promise<PetRow | null> {
  const [row] = await exec
    .select()
    .from(schema.dmPets)
    .where(eq(schema.dmPets.channelId, channelId))
    .limit(1);
  return row ?? null;
}

/** The DM's streak row with its live value: the stored count while the
 *  chain is alive (credited today or yesterday), else 0. */
async function liveStreak(exec: DbHandle, channelId: bigint, today: string) {
  const [row] = await exec
    .select()
    .from(schema.dmStreaks)
    .where(eq(schema.dmStreaks.channelId, channelId))
    .limit(1);
  const alive = !!row && (row.lastCountedDay === today || row.lastCountedDay === addDays(today, -1));
  return { row: row ?? null, streak: alive ? Math.min(row!.streak, STREAK_CAP) : 0 };
}

/** The DM's pet, or null (none, or an invite that lapsed). */
export async function getPet(channelId: bigint): Promise<PetDTO | null> {
  const now = clock();
  const row = await loadRow(db, channelId);
  return row && !inviteLapsed(row, now) ? petDTO(row, now) : null;
}

/** GET /users/@me/channels/:id/pet. */
export async function getPetState(channelId: bigint): Promise<{
  pet: PetDTO | null;
  eligible: boolean;
  streak: number;
  minStreak: number;
}> {
  const now = clock();
  const pet = await getPet(channelId);
  const { streak } = await liveStreak(db, channelId, utcDay(now));
  return { pet, eligible: pet === null && streak >= PET_MIN_STREAK, streak, minStreak: PET_MIN_STREAK };
}

// ── Adopt ───────────────────────────────────────────────────────────────────

/** Invite the other person of a 1:1 DM to adopt a pet. 409 when the streak
 *  isn't alive and PET_MIN_STREAK days, or a pet / open invite exists. Posts
 *  the 'invited' notice. */
export async function invitePet(input: {
  channelId: bigint;
  inviterId: bigint;
  otherId: bigint;
}): Promise<PetDTO> {
  const now = clock();
  const today = utcDay(now);
  const [a, b] =
    input.inviterId < input.otherId ? [input.inviterId, input.otherId] : [input.otherId, input.inviterId];
  const out = await db.transaction(async (tx) => {
    await lockPet(tx, input.channelId);
    // The route checked both people are still here, but a close or an account
    // deletion can land before this lock, and its drop (dropPet,
    // dropPetsForUser) would then have run already and found nothing: check
    // again under the lock. The users rows are read FOR SHARE so a tombstone
    // not seen here waits for this commit, and dropPetsForUser's later read
    // finds the invite. A close commits before its drop takes the lock, so it
    // is either seen here or its drop waits for this commit.
    const people = await tx
      .select({ deletedAt: schema.users.deletedAt })
      .from(schema.users)
      .where(inArray(schema.users.id, [a, b]))
      .for('share');
    const here = await listAllRecipients(input.channelId, tx);
    if (
      people.length !== 2 ||
      people.some((u) => u.deletedAt !== null) ||
      !here.includes(a) ||
      !here.includes(b)
    ) {
      throw errors.conflict('The other person has left this conversation');
    }
    const existing = await loadRow(tx, input.channelId);
    if (existing) {
      if (!inviteLapsed(existing, now)) {
        throw errors.conflict('This conversation already has a Zekk Pet or an open invite');
      }
      // A lapsed invite the sweep hasn't cleared yet.
      await tx.delete(schema.dmPets).where(eq(schema.dmPets.channelId, input.channelId));
    }
    const { streak } = await liveStreak(tx, input.channelId, today);
    if (streak < PET_MIN_STREAK) {
      throw errors.conflict(`Keep a ${PET_MIN_STREAK}-day streak going to adopt a Zekk Pet`, {
        streak,
        minStreak: PET_MIN_STREAK,
      });
    }
    const [row] = await tx
      .insert(schema.dmPets)
      .values({
        channelId: input.channelId,
        userAId: a,
        userBId: b,
        status: 'invited',
        invitedBy: input.inviterId,
        name: PET_DEFAULT_NAME,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const notice = await insertNotice(tx, { pet: row!, event: 'invited', actorId: input.inviterId });
    return { row: row!, notice, recipientIds: await listAllRecipients(input.channelId, tx) };
  });
  const pet = petDTO(out.row, now);
  await announce(input.channelId, out.recipientIds, [out.notice], pet);
  return pet;
}

/**
 * Accept the other person's invite: the egg appears. The invitee only (403
 * for the inviter); 409 when there's no open invite or the streak broke
 * meanwhile. Today's tasks start from what the streak already knows — each
 * side that messaged today counts one message, so a day on which both
 * already said hi feeds the egg (and earns `both_hi`) at once. Posts the
 * 'adopted' notice.
 */
export async function acceptPet(input: { channelId: bigint; userId: bigint }): Promise<PetDTO> {
  const now = clock();
  const today = utcDay(now);
  const out = await db.transaction(async (tx) => {
    await lockPet(tx, input.channelId);
    const row = await loadRow(tx, input.channelId);
    if (!row || row.status !== 'invited' || inviteLapsed(row, now)) {
      throw errors.conflict('There is no Zekk Pet invite to accept');
    }
    if (row.invitedBy === input.userId) {
      throw errors.forbidden('Only the person you invited can accept');
    }
    if (input.userId !== row.userAId && input.userId !== row.userBId) {
      throw errors.conflict('There is no Zekk Pet invite to accept');
    }
    const { row: s, streak } = await liveStreak(tx, input.channelId, today);
    if (!s || streak < PET_MIN_STREAK) {
      throw errors.conflict(`Keep a ${PET_MIN_STREAK}-day streak going to adopt a Zekk Pet`, {
        streak,
        minStreak: PET_MIN_STREAK,
      });
    }
    const countA = s.lastDayA === today ? 1 : 0;
    const countB = s.lastDayB === today ? 1 : 0;
    const fed = countA > 0 && countB > 0;
    const points = fed ? BOTH_HI.points : 0;
    const [saved] = await tx
      .update(schema.dmPets)
      .set({
        status: 'active',
        adoptedAt: now,
        lastFedDay: fed ? today : s.lastCountedDay,
        taskDay: today,
        countA,
        countB,
        tasksDone: fed ? BOTH_HI.bit : 0,
        points,
        level: petLevelForPoints(points),
        updatedAt: now,
      })
      .where(eq(schema.dmPets.channelId, input.channelId))
      .returning();
    const notice = await insertNotice(tx, {
      pet: saved!,
      event: 'adopted',
      actorId: input.userId,
      otherId: row.invitedBy ?? (input.userId === row.userAId ? row.userBId : row.userAId),
    });
    return { row: saved!, notice, recipientIds: await listAllRecipients(input.channelId, tx) };
  });
  const pet = petDTO(out.row, now);
  await announce(input.channelId, out.recipientIds, [out.notice], pet);
  return pet;
}

/** Decline (invitee) or cancel (inviter) an open invite. No notice. A no-op
 *  when there's nothing to decline; 409 once the pet is adopted. */
export async function declinePet(input: { channelId: bigint; userId: bigint }): Promise<void> {
  const recipientIds = await db.transaction(async (tx) => {
    await lockPet(tx, input.channelId);
    const row = await loadRow(tx, input.channelId);
    if (!row) return null;
    if (row.status !== 'invited') throw errors.conflict('Only an open invite can be declined');
    await tx.delete(schema.dmPets).where(eq(schema.dmPets.channelId, input.channelId));
    return listAllRecipients(input.channelId, tx);
  });
  if (recipientIds) await announce(input.channelId, recipientIds, [], null);
}

/**
 * Remove a DM's pet or invite, whatever its state, under its lock (a feed,
 * accept or sweep that already holds it finishes first and the next one
 * finds no row), and tell the DM's remaining recipients (DM_PET_UPDATE
 * null). No notice. For a DM one person closed (routes/dms.ts DELETE): that
 * channel stays one-sided for good — reopening creates a new one — so its
 * pet could never be fed or adopted again.
 */
export async function dropPet(channelId: bigint): Promise<boolean> {
  const recipientIds = await db.transaction(async (tx) => {
    await lockPet(tx, channelId);
    const gone = await tx
      .delete(schema.dmPets)
      .where(eq(schema.dmPets.channelId, channelId))
      .returning({ channelId: schema.dmPets.channelId });
    return gone.length > 0 ? listAllRecipients(channelId, tx) : null;
  });
  if (recipientIds) await announce(channelId, recipientIds, [], null);
  return recipientIds !== null;
}

/**
 * Account deletion (services/purge.ts): the user row stays as a tombstone, so
 * dm_pets' ON DELETE CASCADE never fires. Drop every pet and invite the user
 * is part of (dropPet) and tell the other person. Per-pet failures are
 * logged and skipped.
 */
export async function dropPetsForUser(userId: bigint): Promise<void> {
  const rows = await db
    .select({ channelId: schema.dmPets.channelId })
    .from(schema.dmPets)
    .where(or(eq(schema.dmPets.userAId, userId), eq(schema.dmPets.userBId, userId)));
  for (const { channelId } of rows) {
    try {
      await dropPet(channelId);
    } catch (err) {
      log.warn?.('pet drop on account deletion failed', {
        channelId: channelId.toString(),
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Rename the pet. `changed: false` (no write, no notice, no event) when the
 *  normalised name is the current one. 400 for an invalid name; 409 while
 *  it's only an invite. Posts the 'renamed' notice, and runs the new name
 *  through the parental watch-word scan as a send would be. */
export async function renamePet(input: {
  channelId: bigint;
  userId: bigint;
  name: string;
}): Promise<{ pet: PetDTO; changed: boolean }> {
  const name = normalizePetName(input.name);
  if (name === null) throw errors.badRequest('Pet names are 1 to 24 characters, with no control characters');
  const now = clock();
  const out = await db.transaction(async (tx) => {
    await lockPet(tx, input.channelId);
    const row = await loadRow(tx, input.channelId);
    if (!row || row.status === 'invited') throw errors.conflict('There is no Zekk Pet to rename');
    if (row.name === name) return { row, notice: null, recipientIds: [] };
    const [saved] = await tx
      .update(schema.dmPets)
      .set({ name, updatedAt: now })
      .where(eq(schema.dmPets.channelId, input.channelId))
      .returning();
    const notice = await insertNotice(tx, { pet: saved!, event: 'renamed', actorId: input.userId });
    return {
      row: saved!,
      notice,
      recipientIds: await listAllRecipients(input.channelId, tx),
    };
  });
  const pet = petDTO(out.row, now);
  if (!out.notice) return { pet, changed: false };
  await announce(input.channelId, out.recipientIds, [out.notice], pet);
  // Parental controls: the name is free text that reaches the DM (this notice
  // and every later one repeats it), so it gets the send path's watch-word
  // scan, flagged against the 'renamed' notice. Only the new name is scanned
  // (the notice also carries the renamer's display name, which no path
  // scans). Each rename posts a new notice, so it's scanned as a fresh send,
  // not as an edit of the old name: a word the old name already had is
  // flagged again, since that earlier flag's notice doesn't show what this
  // rename added (and may be from the other person). Fire-and-forget: it
  // never fails the rename.
  void supervision
    .scanMessageForFlags({
      messageId: out.notice.id,
      channelId: input.channelId,
      channelType: 'dm',
      authorId: input.userId,
      content: name,
    })
    .catch(() => undefined);
  return { pet, changed: true };
}

// ── Care ────────────────────────────────────────────────────────────────────

/**
 * Record a 1:1 send or poke from `authorId` against the DM's pet: roll the
 * counters over on a new UTC day, count the message, tick tasks, award each
 * newly completed task's points, level up, wake a sleeping pet that was just
 * fed, and post 'awake' / 'hatched' / 'evolved' notices. At most one
 * DM_PET_UPDATE, and only when the DTO changed. No pet (or only an invite) =
 * nothing happens. Called fire-and-forget after the send / poke; the caller
 * catches and logs.
 *
 * `at` fixes the UTC day the activity counts for: a send passes its message's
 * createdAt (and gives the streak the same instant), a poke the time it was
 * handled, so a message a few ms before midnight is credited to the same day
 * by the streak and the pet however long this call waits. It also tells a
 * send from before the adoption (already in the accept's seed) from one
 * after it. Defaults to now.
 */
export async function recordActivity(args: {
  channelId: bigint;
  authorId: bigint;
  kind: PetActivity | readonly PetActivity[];
  at?: Date;
}): Promise<void> {
  const now = clock();
  const today = utcDay(args.at ?? now);
  const kinds: readonly PetActivity[] = typeof args.kind === 'string' ? [args.kind] : args.kind;
  // Most DMs have no pet: one indexed read, no transaction, for those. An
  // invite still takes the lock below: an accept in flight may be about to
  // turn it into a pet whose seed (read from dm_streaks) missed this send.
  const peek = await loadRow(db, args.channelId);
  if (!peek) return;
  const out = await db.transaction(async (tx) => {
    await lockPet(tx, args.channelId);
    const row = await loadRow(tx, args.channelId);
    if (!row || row.status === 'invited' || dueToRunAway(row, today)) return null;
    // A later day already started on the row (an activity of that day got the
    // lock first): never rewind it, or todayCounters would zero that day and
    // its tasks would pay out twice. A late activity is dropped; no per-day
    // history is kept.
    if (row.taskDay !== null && row.taskDay > today) return null;
    const side = args.authorId === row.userAId ? 'a' : args.authorId === row.userBId ? 'b' : null;
    if (side === null) return null;
    // A send from before the adoption, on the adoption day, that only gets
    // here now (it raced the accept): the accept seeded that side's count
    // with one for "said hi today" from dm_streaks, which may or may not have
    // seen this send's streak commit. Either way it is that one message, so
    // it counts at most once.
    const seeded =
      args.at !== undefined &&
      row.adoptedAt !== null &&
      args.at < row.adoptedAt &&
      utcDay(row.adoptedAt) === today;
    const { next, events } = applyActivity(row, today, side, kinds, seeded);
    if (!rowChanged(row, next)) return null;
    const [saved] = await tx
      .update(schema.dmPets)
      .set({
        status: next.status,
        points: next.points,
        level: next.level,
        lastFedDay: next.lastFedDay,
        taskDay: next.taskDay,
        countA: next.countA,
        countB: next.countB,
        tasksDone: next.tasksDone,
        updatedAt: now,
      })
      .where(eq(schema.dmPets.channelId, args.channelId))
      .returning();
    const notices: schema.Message[] = [];
    for (const event of events) {
      notices.push(await insertNotice(tx, { pet: saved!, event, actorId: args.authorId }));
    }
    const pet = petDTO(saved!, now);
    const visible = !sameDTO(petDTO(row, now), pet);
    if (!visible && notices.length === 0) return null;
    return {
      pet: visible ? pet : undefined,
      notices,
      recipientIds: await listAllRecipients(args.channelId, tx),
    };
  });
  if (out) await announce(args.channelId, out.recipientIds, out.notices, out.pet);
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/** When the previous sweep on this process ran (clock-only mood changes). */
let lastSweepAt: Date | null = null;

/** Did a time a pet's mood can change on by the clock alone — midnight UTC
 *  (a new day) or GRUMPY_FROM_HOUR_UTC — pass between the two ticks? */
function crossedMoodBoundary(prev: Date, now: Date): boolean {
  if (now.getTime() - prev.getTime() >= 86_400_000) return true;
  const part = (d: Date) => utcDay(d) + (d.getUTCHours() >= GRUMPY_FROM_HOUR_UTC ? 'pm' : 'am');
  return part(prev) !== part(now);
}

/** Today / dayEndsAt aside, does the DTO read differently at the two times? */
function changedWithClock(row: PetRow, prev: Date, now: Date): boolean {
  const strip = (d: PetDTO) => ({ ...d, today: '', dayEndsAt: '' });
  return JSON.stringify(strip(petDTO(row, prev))) !== JSON.stringify(strip(petDTO(row, now)));
}

/**
 * Periodic sweep (leader, every 10 minutes):
 *   1. lapsed invites are deleted (no notice; DM_PET_UPDATE null);
 *   2. pets unfed for 4+ days run away — deleted, 'ran_away' notice. That is
 *      a pet still asleep two days after it fell asleep, or (after downtime)
 *      an active one the sweep never got to put to sleep;
 *   3. active pets not fed since before yesterday fall asleep — 'asleep'
 *      notice;
 *   4. when midnight or 18:00 UTC passed since the previous tick, every other
 *      pet whose DTO reads differently now (tasks reset, hungry → grumpy…)
 *      gets a fresh DM_PET_UPDATE, so an open pet card doesn't go stale.
 * Each row is re-checked under its lock, so a feed racing the sweep, an
 * overlapping tick or a second replica can't double-post. Per-row failures
 * are logged and skipped. Sweep notices are authored by user A with a null
 * actorId.
 */
export async function sweepPets(): Promise<{
  expired: number;
  asleep: number;
  ranAway: number;
  refreshed: number;
}> {
  const now = clock();
  const today = utcDay(now);
  const yesterday = addDays(today, -1);
  const out = { expired: 0, asleep: 0, ranAway: 0, refreshed: 0 };
  const touched = new Set<string>();

  const eachLocked = async (
    channelIds: bigint[],
    step: (tx: DbHandle, row: PetRow) => Promise<{ notice?: schema.Message; pet: PetDTO | null } | null>,
    counted: keyof typeof out,
  ) => {
    for (const channelId of channelIds) {
      try {
        const done = await db.transaction(async (tx) => {
          await lockPet(tx, channelId);
          const row = await loadRow(tx, channelId);
          const stepped = row ? await step(tx, row) : null;
          return stepped && { ...stepped, recipientIds: await listAllRecipients(channelId, tx) };
        });
        if (!done) continue;
        touched.add(channelId.toString());
        out[counted]++;
        await announce(channelId, done.recipientIds, done.notice ? [done.notice] : [], done.pet);
      } catch (err) {
        log.warn?.('pet sweep step failed', {
          channelId: channelId.toString(),
          step: counted,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const ids = (rows: Array<{ channelId: bigint }>) => rows.map((r) => r.channelId);

  // 1. Lapsed invites.
  const lapsed = await db
    .select({ channelId: schema.dmPets.channelId })
    .from(schema.dmPets)
    .where(
      and(
        eq(schema.dmPets.status, 'invited'),
        lte(schema.dmPets.createdAt, new Date(now.getTime() - PET_INVITE_TTL_DAYS * 86_400_000)),
      ),
    );
  await eachLocked(
    ids(lapsed),
    async (tx, row) => {
      if (!inviteLapsed(row, now)) return null;
      await tx.delete(schema.dmPets).where(eq(schema.dmPets.channelId, row.channelId));
      return { pet: null };
    },
    'expired',
  );

  // 2. Run away.
  const runaways = await db
    .select({ channelId: schema.dmPets.channelId })
    .from(schema.dmPets)
    .where(
      and(
        inArray(schema.dmPets.status, ['active', 'asleep']),
        lte(schema.dmPets.lastFedDay, addDays(today, -4)),
      ),
    );
  await eachLocked(
    ids(runaways),
    async (tx, row) => {
      if (!dueToRunAway(row, today)) return null;
      await tx.delete(schema.dmPets).where(eq(schema.dmPets.channelId, row.channelId));
      return { notice: await insertNotice(tx, { pet: row, event: 'ran_away', actorId: null }), pet: null };
    },
    'ranAway',
  );

  // 3. Fall asleep.
  const sleepy = await db
    .select({ channelId: schema.dmPets.channelId })
    .from(schema.dmPets)
    .where(and(eq(schema.dmPets.status, 'active'), lt(schema.dmPets.lastFedDay, yesterday)));
  await eachLocked(
    ids(sleepy),
    async (tx, row) => {
      if (row.status !== 'active' || row.lastFedDay === null || row.lastFedDay >= yesterday) return null;
      if (dueToRunAway(row, today)) return null;
      const [saved] = await tx
        .update(schema.dmPets)
        .set({ status: 'asleep', updatedAt: now })
        .where(eq(schema.dmPets.channelId, row.channelId))
        .returning();
      return {
        notice: await insertNotice(tx, { pet: saved!, event: 'asleep', actorId: null }),
        pet: petDTO(saved!, now),
      };
    },
    'asleep',
  );

  // 4. Clock-only changes. Best-effort: a missed one heals on the client's
  // next GET (every DM open), and a duplicate is harmless. The unlocked read
  // only picks candidates; each DTO is built from the row re-read under its
  // lock, so a rename, feed or wake that commits meanwhile isn't followed by
  // an older snapshot.
  const prev = lastSweepAt;
  lastSweepAt = now;
  if (prev && prev < now && crossedMoodBoundary(prev, now)) {
    const candidates = await db
      .select({ channelId: schema.dmPets.channelId })
      .from(schema.dmPets)
      .where(inArray(schema.dmPets.status, ['active', 'asleep']));
    await eachLocked(
      ids(candidates.filter((r) => !touched.has(r.channelId.toString()))),
      async (_tx, row) =>
        (row.status === 'active' || row.status === 'asleep') &&
        !dueToRunAway(row, today) &&
        changedWithClock(row, prev, now)
          ? { pet: petDTO(row, now) }
          : null,
      'refreshed',
    );
  }
  return out;
}
