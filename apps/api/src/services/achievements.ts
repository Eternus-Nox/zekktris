/**
 * Achievements
 * ------------
 * Computed on demand from existing data — no progress tables to keep in
 * sync. Each definition yields zero or more earned badges with a tier
 * value where applicable. Visibility: `users.achievements_public`
 * (default false) gates whether OTHER users may fetch them; the owner
 * always sees their own.
 *
 * Catalog:
 *   veteran           — one per full account year (year marker included)
 *   chatterbox        — messages sent: 100 / 1k / 10k / 100k
 *   social_circle     — friends: 5 / 10 / 25 / 50
 *   night_owl         — 500 messages sent between 01:00–05:00 (server time)
 *   regular           — sent messages on 30 / 100 / 365 different UTC days
 *   first_responder   — 100 replies sent within 10s of the original
 *   crowd_pleaser     — 3 / 5 DISTINCT people reacted to one of your messages
 *   pollster          — a poll you made got votes from 3 / 5 DISTINCT people
 *   inseparable       — DM streak: 7 / 30 / 100 days
 *   marathon          — a 365-day messaging streak (the capstone above those)
 *   kindred           — a 7-day DM streak with 2 / 3 / 5 DISTINCT people
 *   founder           — owns a server that reached 25 / 100 / 500 members
 *   voice_of_people   — 100 hours in 1:1 calls (sum of call durations)
 *   ring_ring         — 50 completed 1:1 calls (answered, not missed)
 *   founding_member   — signed up before FOUNDING_MEMBER_CUTOFF
 *   locked_in         — added a passkey
 *   double_locked     — passkey AND two-factor both enabled
 *   tagged            — wearing a name tag
 *   framed            — avatar frame equipped
 *   signature_look    — avatar + banner + bio + name tag all set
 *   welcome_committee — first to greet a newcomer: 1 / 10 / 50 times
 *   off_the_record    — in an end-to-end-encrypted DM
 *   vanishing_act     — turned on disappearing messages in a DM
 *   discovered        — joined a server through Discovery
 *   guardian_angel    — actively supervising a child account
 *   first_contact     — joined a voice channel (user_voice_stats)
 *   event_horizon     — total voice time: 1h / 10h (user_voice_stats)
 *   nudge_nudge       — poked 1 / 3 / 5 DISTINCT people (poke_tallies)
 *   poke_magnet       — 5 DISTINCT people have poked you (poke_tallies)
 *   pet_keeper        — a Zekk Pet hatched / grew into a Kid, Teen, Adult,
 *                       Legendary (dm_pets level, floored by the ledger)
 *   pet_perfect_day   — every Zekk Pet task done in one UTC day
 *
 * Tier convention (set by veteran / chatterbox / social; every ladder here
 * follows it): one entry per rung, id `family_<goal>`, the SAME `name` across
 * the family, and the rung's threshold as the `marker`. Clients derive the
 * roman numeral from the shared name ordered by goal (web AchievementsShelf
 * `tierNumerals`, iOS MainView), so "Founder II" is a CLIENT-side label —
 * never bake a numeral into `name`. And never change an existing rung's `id`:
 * it is the `user_achievements` ledger key, which is why the original rungs
 * keep their bare ids (`founder`, `welcome_committee`, `event_horizon`)
 * instead of being renamed to `founder_25` etc.
 *
 * Every badge below carries a comment on whether it is farmable. That is a
 * hard requirement of adding one — a badge nobody can trust is worse than no
 * badge, and the cheapest exploit (idle in an empty voice channel, greet your
 * own alt) is usually the one a threshold invites.
 */

import { and, count, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { PET_ALL_TASKS_MASK, petStageForLevel, petStageLabel } from '@zekktris/shared/pets';
import { db, schema } from '../db';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Marker shown in the badge (year number, tier threshold…). */
  marker: string;
  /** Current raw progress value behind the badge. */
  value: number;
  /** Whether the user has unlocked it. Locked entries carry progress. */
  earned: boolean;
  /** Threshold to unlock (absent for the open-ended veteran years). */
  goal?: number;
}

const CHATTERBOX_TIERS = [100, 1_000, 10_000, 100_000];
const SOCIAL_TIERS = [5, 10, 25, 50];
/** DM-streak ladder beneath the 365-day `marathon` capstone. */
const INSEPARABLE_TIERS = [7, 30, 100];
/** Owned-guild size ladder above the original 25-member `founder`. */
const FOUNDER_TIERS = [100, 500];
/** Newcomer-greeting ladder above the original single `welcome_committee`. */
const WELCOME_TIERS = [10, 50];

/**
 * Poke ladder (sent) — DISTINCT people, never poke volume.
 *
 * Sized to THIS instance (~10 accounts), not to round numbers. The metric is
 * hard-capped by headcount: pokes are 1:1-DM-only and self-pokes are rejected,
 * so the ceiling is (accounts − 1) ≈ 9. A 10/25/50 ladder copied from `social`
 * would be three tiles nobody here can ever reach — `social_50` already is one
 * — so the top rung is 5: a MAJORITY of everyone you could possibly poke, which
 * means most of the instance has an open DM with you. 3 is the mid rung (about
 * a third of the instance, a week of ordinary use), and 1 is the discovery rung
 * — the poke button is easy to never notice, and the catalog already leans on
 * goal-1 tiles for that job (first_contact, discovered, off_the_record).
 * Rungs may be APPENDED if the instance grows; ids never change (see above).
 */
const POKE_SENT_TIERS = [1, 3, 5];
/**
 * Poke badge (received) — deliberately ONE high bar, not a mirror ladder.
 *
 * Reciprocity here is a single tap (the poke popover's whole purpose is to
 * offer poke-back), so a 1/3/5 received ladder would track the sent ladder
 * almost exactly and park two families showing the SAME number side by side on
 * the shelf. And "someone poked you" asks nothing of the user, so there is no
 * goal-1 rung on this side. Five different people choosing to poke you is a
 * real signal at this headcount and is strictly harder than the sent top rung,
 * which you can reach unilaterally. Progress still renders (0/5), the same way
 * night_owl and marathon carry a single distant bar.
 */
const POKE_RECEIVED_GOAL = 5;
const POKE_RECEIVED_TIERS = [POKE_RECEIVED_GOAL];

/** Regular — UTC calendar days with at least one message sent: a month, a
 *  hundred days, a year. Days, not volume, so it is the one ladder here a
 *  quiet everyday user climbs as fast as a loud one. */
const REGULAR_TIERS = [30, 100, 365];

/**
 * Crowd Pleaser (reactions on ONE message) / The People Have Spoken (votes on
 * ONE poll) — DISTINCT people, never reaction or vote volume. Sized like the
 * poke ladder, to this ~10-account instance: 5 is half of everyone turning up
 * for one thing you posted, and 3 is a real crowd in a small server. No goal-1
 * rung — one reaction from a friend is everyday, not a milestone.
 */
const CROWD_PLEASER_TIERS = [3, 5];
const POLLSTER_TIERS = [3, 5];

/** Kindred Spirits — DISTINCT people you have kept a streak of at least
 *  KINDRED_STREAK_DAYS with (Inseparable's first rung). Headcount-capped like
 *  the pokes: 5 is about half the instance; there is no goal-1 rung because
 *  one such person is Inseparable already. */
const KINDRED_STREAK_DAYS = 7;
const KINDRED_TIERS = [2, 3, 5];

/** Zekk Keeper — one rung per stage after the egg, at the stage's first
 *  level (hatching is level 1). FROZEN here rather than read off PET_STAGES:
 *  ids are `pet_keeper_<level>` and the ledger floor names a rung by counting
 *  recorded ids, so every rung is a ledger key and must never move, whatever
 *  the pet rules do later. Read off the rules, retuning a stage's minLevel
 *  would quietly mint (and announce) a rung nobody reached; frozen, a test
 *  that pins it to PET_STAGES' minLevels fails instead. */
export const PET_KEEPER_TIERS: readonly number[] = [1, 5, 10, 15, 25];

/**
 * Founding Member cutoff — accounts created strictly BEFORE this instant.
 *
 * Chosen as the end of the launch month: v1.0 shipped 2026-08-06 (desktop
 * v1.0.1), so this closes the founding window at the end of the first public
 * month rather than leaving it open indefinitely. It is a constant precisely
 * so it can be moved — but only FORWARD, and only while it is still in the
 * future. Moving it earlier after the fact un-earns a badge people already
 * have on their shelf (the `user_achievements` ledger keeps the row, but
 * achievementsForUser recomputes live, so the tile silently disappears).
 *
 * This is the only unforgeable badge in the catalog: `users.created_at` is
 * stamped server-side by the signup INSERT, is never read from the request
 * body, and no endpoint — admin included — updates it. Every other badge
 * measures behaviour, and behaviour can be ground out or staged with an alt.
 */
export const FOUNDING_MEMBER_CUTOFF = new Date('2026-09-01T00:00:00Z');

function num(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'string') return parseInt(x, 10) || 0;
  return 0;
}

/**
 * Progress FLOOR for a cumulative ladder, read off the sticky
 * `user_achievements` ledger: given how many rungs of a family are already
 * recorded there, the threshold of the highest one.
 *
 * Why a floor is needed at all — the cascade trap. `welcome_committee` has to
 * COALESCE around `messages.author_id` being ON DELETE SET NULL, because
 * COUNT(DISTINCT) skips NULLs and a greeted user closing their account walked
 * the greeter's progress BACKWARDS. `poke_tallies` has the same exposure
 * through a worse door: BOTH its FKs are ON DELETE CASCADE, so a departing
 * account does not blank a column, it DELETES the pair row outright. Nothing
 * survives to COALESCE, so unlike welcome_committee the fix cannot live in the
 * aggregate — it has to come from a record the delete doesn't reach, and the
 * ledger (rows are sticky, never deleted) already is one.
 *
 * The line this draws: un-earning because YOUR OWN state changed — you cleared
 * your avatar, your server shrank, you unfriended someone — is honest, and this
 * file accepts it everywhere by design. Un-earning because a THIRD PARTY
 * deleted their account is not: you really did poke five people, and at this
 * headcount one departure is a whole rung, plausibly for several users at once.
 *
 * Safe by construction. The ledger only ever receives ids that were computed as
 * earned, so a floor can never manufacture a badge nobody unlocked; it is
 * monotone, so it cannot oscillate; and it feeds back into a value that is
 * already ≥ it, so it changes no notification (the rung it restores is by
 * definition already in the ledger, and syncAndNotifyAchievements only
 * announces ids the INSERT ... ON CONFLICT DO NOTHING actually returns).
 *
 * Earned rungs are always a PREFIX of the ascending tier list — every rung of a
 * family reads the same `value` — which is what makes a plain count of recorded
 * rungs enough to name the highest one, with no id parsing. If a rung is ever
 * inserted MID-ladder, this under-reports for exactly one sync and then
 * self-heals: it fails low, never high.
 */
function ledgerFloor(tiers: readonly number[], rungsRecorded: number): number {
  if (rungsRecorded <= 0) return 0;
  return tiers[Math.min(rungsRecorded, tiers.length) - 1] ?? 0;
}

export async function achievementsForUser(userId: bigint): Promise<Achievement[]> {
  const out: Achievement[] = [];

  // ── Account age (veteran, one per year) ────────────────────────────────
  // The same row also feeds the profile/security achievements below (tagged,
  // framed, signature_look, double_locked) — one PK read for all of them.
  const [userRow] = await db
    .select({
      createdAt: schema.users.createdAt,
      totpEnabled: schema.users.totpEnabled,
      tagLabel: schema.users.tagLabel,
      avatarDecoration: schema.users.avatarDecoration,
      avatarUrl: schema.users.avatarUrl,
      bannerUrl: schema.users.bannerUrl,
      bio: schema.users.bio,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (userRow) {
    const years = Math.floor(
      (Date.now() - userRow.createdAt.getTime()) / (365.25 * 24 * 3600 * 1000),
    );
    for (let y = 1; y <= years; y++) {
      out.push({
        id: `veteran_${y}`,
        name: y === 1 ? 'One Year Strong' : `${y} Years Strong`,
        description: `Member for ${y} year${y > 1 ? 's' : ''}.`,
        marker: `${y}`,
        value: y,
        earned: true,
        goal: y,
      });
    }
    // The next year is always visible as the upcoming locked badge.
    const nextY = years + 1;
    out.push({
      id: `veteran_${nextY}`,
      name: nextY === 1 ? 'One Year Strong' : `${nextY} Years Strong`,
      description: `Member for ${nextY} year${nextY > 1 ? 's' : ''}.`,
      marker: `${nextY}`,
      value: years,
      earned: false,
      goal: nextY,
    });

    // Founding Member — same `userRow` read, no extra query. NOT farmable and
    // in fact not forgeable at all: see FOUNDING_MEMBER_CUTOFF above.
    // Earned-only: a locked 0/1 tile is NEVER emitted, not even while the
    // window is open. Nobody can be inside the window and not already founding
    // — createdAt <= now, so `now < CUTOFF` implies `createdAt < CUTOFF` — and
    // once the window closes it can never be earned, so a permanently-0/1
    // badge on every later signup's shelf would be noise, not a goal.
    const founding = userRow.createdAt.getTime() < FOUNDING_MEMBER_CUTOFF.getTime();
    if (founding) {
      out.push({
        id: 'founding_member',
        name: 'Founding Member',
        description: 'Signed up before the public launch.',
        marker: '🌱',
        value: 1,
        earned: true,
        goal: 1,
      });
    }
  }

  // ── One combined read for the newer families ───────────────────────────
  // Scalar subqueries anchored on the user's own row: passkeys, E2EE DMs,
  // discovery joins, guardian links, welcome-committee firsts, the voice
  // participation counters, pokes, Zekk Pets, streak partners, reactions,
  // poll votes and the disappearing timer, plus the ledger rungs behind every
  // floored family. Single round trip instead of one per family. Read this
  // early because some of what it feeds sits early on the shelf (Regular,
  // Crowd Pleaser, Kindred Spirits) and push order IS the shelf order.
  const [extra] = await db
    .select({
      passkeys: sql<number>`(
        SELECT COUNT(*) FROM ${schema.webauthnCredentials}
        WHERE ${schema.webauthnCredentials.userId} = ${userId}
      )`,
      e2eeDms: sql<number>`(
        SELECT COUNT(*) FROM ${schema.channels} c
        JOIN ${schema.dmRecipients} dr ON dr.channel_id = c.id
        WHERE dr.user_id = ${userId} AND c.e2ee_enabled = true
      )`,
      discovered: sql<number>`(
        SELECT COUNT(*) FROM ${schema.auditLogEntries}
        WHERE ${schema.auditLogEntries.actorId} = ${userId}
          AND ${schema.auditLogEntries.action} = 'member.join'
          AND ${schema.auditLogEntries.changes} ->> 'via' = 'discovery'
      )`,
      guardianOf: sql<number>`(
        SELECT COUNT(*) FROM ${schema.parentChildLinks}
        WHERE ${schema.parentChildLinks.parentId} = ${userId}
          AND ${schema.parentChildLinks.status} = 'active'
      )`,
      // "First to greet a newcomer": the user authored the first regular
      // message following someone ELSE's welcome (system_join rows are rare —
      // one per member join — so the LATERAL-ish correlated scan is bounded).
      // COUNT(DISTINCT author) — one credit per NEWCOMER greeted, not per join
      // EVENT, so a single alt cycling in and out is worth exactly one. See
      // the farmability note on the WELCOME_TIERS ladder below.
      //
      // The COALESCE is for hard-deleted newcomers: `messages.author_id` is
      // ON DELETE SET NULL, and COUNT(DISTINCT) skips NULLs — so a plain
      // DISTINCT on the column would collapse EVERY tombstoned greeting into
      // nothing and make a user's progress go BACKWARDS as people they
      // legitimately greeted close their accounts. Falling back to the row id
      // keeps each of those worth one, and cannot be farmed: earning a rung
      // that way would mean deleting a whole account per join, which is far
      // more expensive than the rejoin loop this DISTINCT exists to stop.
      welcomes: sql<number>`(
        SELECT COUNT(DISTINCT COALESCE(sj.author_id::text, 'gone:' || sj.id::text))
        FROM ${schema.messages} sj
        WHERE sj.type = 'system_join'
          AND sj.deleted_at IS NULL
          AND sj.author_id IS DISTINCT FROM ${userId}
          AND (
            SELECT m.author_id FROM ${schema.messages} m
            WHERE m.channel_id = sj.channel_id AND m.id > sj.id
              AND m.deleted_at IS NULL AND m.type IN ('default', 'reply')
            ORDER BY m.id ASC LIMIT 1
          ) = ${userId}
      )`,
      voiceJoins: sql<number>`COALESCE((
        SELECT ${schema.userVoiceStats.joins} FROM ${schema.userVoiceStats}
        WHERE ${schema.userVoiceStats.userId} = ${userId}
      ), 0)`,
      voiceSeconds: sql<number>`COALESCE((
        SELECT ${schema.userVoiceStats.totalSeconds} FROM ${schema.userVoiceStats}
        WHERE ${schema.userVoiceStats.userId} = ${userId}
      ), 0)`,
      // Pokes, both directions. COUNT(*) over `poke_tallies`, whose PK is
      // (initiator_id, recipient_id): one row per PERSON, so these are
      // distinct-people counts BY CONSTRUCTION rather than by a DISTINCT clause
      // — poking the same person a thousand times only bumps that row's
      // poke_count, which nothing here reads. Both sides are index-only (the PK
      // covers "people I poked", idx_poke_tallies_recipient covers "people who
      // poked me").
      //
      // The `pokes` table itself cannot answer either question: it is a display
      // buffer pruned to the newest 6 rows per (channel, RECIPIENT) on every
      // insert — and pruned on the RECIPIENT key, so one person poking
      // repeatedly deletes an earlier poker's rows. Anything lifetime-scoped
      // read from it would both under-count and regress when a third party
      // pokes. That is exactly why poke_tallies exists.
      pokedDistinct: sql<number>`(
        SELECT COUNT(*) FROM ${schema.pokeTallies}
        WHERE ${schema.pokeTallies.initiatorId} = ${userId}
      )`,
      pokedByDistinct: sql<number>`(
        SELECT COUNT(*) FROM ${schema.pokeTallies}
        WHERE ${schema.pokeTallies.recipientId} = ${userId}
      )`,
      // Rungs already recorded for each poke family — the anti-regression floor
      // (see ledgerFloor). Both FKs on poke_tallies cascade on user delete, so
      // the raw counts above walk backwards when someone else closes their
      // account; these two lookups are what make that not un-earn a badge.
      // `starts_with` rather than LIKE on purpose: '_' is a LIKE wildcard, and
      // these prefixes are full of them.
      pokeSentRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'poke_sent_')
      )`,
      pokeRecvRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'poke_received_')
      )`,
      // Zekk Pets: the highest level of any CURRENT pet of the user's
      // (adopted: active or asleep; an invite is no pet yet), and how many of
      // them have every task done on their task day. Bots are free alts
      // (bots.ts: up to 25 per owner, full users that can DM and accept an
      // invite), so a pet raised with one counts for nothing. dm_pets has no
      // per-user index — at most one row per 1:1 DM, scanned the way
      // dropPetsForUser does.
      //
      // No "task_day = today" test: tasks_done is only ever written together
      // with its own task_day, so a full mask is a perfect day ON that day,
      // whenever this reads it. A today-only test lost the day whose last task
      // landed just before midnight UTC (the send credits its createdAt day,
      // but the pet hook's sync runs after the commit, already on the next
      // day) — and every later sync too, until the next activity reset it.
      petLevel: sql<number>`COALESCE((
        SELECT MAX(p.level) FROM ${schema.dmPets} p
        JOIN ${schema.users} o
          ON o.id = CASE WHEN p.user_a_id = ${userId} THEN p.user_b_id ELSE p.user_a_id END
        WHERE (p.user_a_id = ${userId} OR p.user_b_id = ${userId})
          AND p.status IN ('active', 'asleep')
          AND o.is_bot = false
      ), 0)`,
      petPerfectDays: sql<number>`(
        SELECT COUNT(*) FROM ${schema.dmPets} p
        JOIN ${schema.users} o
          ON o.id = CASE WHEN p.user_a_id = ${userId} THEN p.user_b_id ELSE p.user_a_id END
        WHERE (p.user_a_id = ${userId} OR p.user_b_id = ${userId})
          AND p.status IN ('active', 'asleep')
          AND o.is_bot = false
          AND (p.tasks_done & ${PET_ALL_TASKS_MASK}::int) = ${PET_ALL_TASKS_MASK}::int
      )`,
      // Kindred Spirits: DISTINCT people the user has kept a streak of
      // KINDRED_STREAK_DAYS+ with. Distinct, not rows: a closed and reopened
      // DM is a new channel, with its own dm_streaks row for the same pair.
      // The INNER join is deliberate: dm_streaks has no FKs, so a partner the
      // inactivity sweep hard-deleted leaves an id that can no longer prove it
      // wasn't a bot (the ledger floor keeps any rung that one helped earn).
      kindred: sql<number>`(
        SELECT COUNT(DISTINCT o.id) FROM ${schema.dmStreaks} s
        JOIN ${schema.users} o
          ON o.id = CASE WHEN s.user_a_id = ${userId} THEN s.user_b_id ELSE s.user_a_id END
        WHERE (s.user_a_id = ${userId} OR s.user_b_id = ${userId})
          AND s.best_streak >= ${KINDRED_STREAK_DAYS}::int
          AND o.id <> ${userId}
          AND o.is_bot = false
      )`,
      // Now You See Me: did the user ever turn a DM's disappearing timer ON?
      // Read from the timer notices, which the changer authors and whose
      // metadata names them (initiatorId) with the new timer (0 = off). The
      // notice can't be deleted by its author, and DM history survives
      // account deletion, so turning the timer off again takes nothing back.
      vanishing: sql<number>`(EXISTS (
        SELECT 1 FROM ${schema.messages} m
        WHERE m.author_id = ${userId}
          AND m.type = 'system_disappearing'
          AND m.metadata ->> 'initiatorId' = ${userId.toString()}
          AND (m.metadata ->> 'timerSeconds')::int > 0
      ))::int`,
      // Crowd Pleaser: the most DISTINCT people who reacted to any one of the
      // user's (not deleted) POSTS, not counting the user or bots. A post is
      // a message the user wrote to an audience: author_id alone also names
      // rows they never posted — a system_join welcome is authored by the
      // joiner (and shown as the server's), a webhook's post by the webhook's
      // creator (shown under the webhook's name), a streak warning by the
      // DM's user A, and a poke is a nudge, not a post — and a reaction-roles
      // message exists to collect one reaction from every member. None of
      // those reactions is applause for something the user said.
      // Cost: the planner may read reactions whole (a hash join) for an
      // author with a long history rather than walk messages_author_idx and
      // the reactions PK per message; at this instance's size that is a few
      // ms. If it grows, keep a per-author maximum updated from the reaction
      // hook instead of rescanning here on every sync.
      crowd: sql<number>`COALESCE((
        SELECT MAX(per.n) FROM (
          SELECT COUNT(DISTINCT r.user_id) AS n
          FROM ${schema.messages} m
          JOIN ${schema.reactions} r ON r.message_id = m.id
          JOIN ${schema.users} ru ON ru.id = r.user_id
          WHERE m.author_id = ${userId}
            AND m.deleted_at IS NULL
            AND m.type IN ('default', 'reply')
            AND m.webhook_id IS NULL
            AND COALESCE(m.metadata ->> 'kind', '') NOT IN ('streak_warning', 'poke')
            AND NOT EXISTS (
              SELECT 1 FROM ${schema.reactionRoles} rr WHERE rr.message_id = m.id
            )
            AND r.user_id <> ${userId}
            AND ru.is_bot = false
          GROUP BY m.id
        ) per
      ), 0)`,
      // The People Have Spoken: the most DISTINCT people who voted in any
      // one of the user's polls (the poll's message is theirs and not
      // deleted: a deleted message's poll is closed to votes, as
      // polls.vote has it), not counting the user or bots.
      pollVoters: sql<number>`COALESCE((
        SELECT MAX(per.n) FROM (
          SELECT COUNT(DISTINCT v.user_id) AS n
          FROM ${schema.polls} pl
          JOIN ${schema.messages} m ON m.id = pl.message_id
          JOIN ${schema.pollVotes} v ON v.poll_id = pl.id
          JOIN ${schema.users} vu ON vu.id = v.user_id
          WHERE m.author_id = ${userId}
            AND m.deleted_at IS NULL
            AND v.user_id <> ${userId}
            AND vu.is_bot = false
          GROUP BY pl.id
        ) per
      ), 0)`,
      // Rungs already recorded for the newer floored families (see
      // ledgerFloor and each family's note below for who can take its source
      // away). Each prefix is its family's alone: no other id starts with it.
      regularRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'regular_')
      )`,
      crowdRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'crowd_pleaser_')
      )`,
      pollsterRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'pollster_')
      )`,
      kindredRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'kindred_')
      )`,
      petKeeperRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'pet_keeper_')
      )`,
      perfectDayRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'pet_perfect_day')
      )`,
      vanishingRungs: sql<number>`(
        SELECT COUNT(*) FROM ${schema.userAchievements}
        WHERE ${schema.userAchievements.userId} = ${userId}
          AND starts_with(${schema.userAchievements.achievementId}, 'vanishing_act')
      )`,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  // ── Messages sent (chatterbox tiers + night owl + regular + first responder)
  // One scan of the user's own rows. Chatterbox and Night Owl count the ones
  // still there; Regular counts every day something was sent, deleted since
  // or not (see Regular below) — so `deleted_at` is a per-aggregate FILTER
  // here rather than part of the WHERE.
  const [msgCounts] = await db
    .select({
      total: sql<number>`COUNT(*) FILTER (WHERE ${schema.messages.deletedAt} IS NULL)`,
      nightOwl: sql<number>`COUNT(*) FILTER (WHERE ${schema.messages.deletedAt} IS NULL AND EXTRACT(HOUR FROM ${schema.messages.createdAt}) BETWEEN 1 AND 4)`,
      // Regular rides along on the same scan: the distinct UTC calendar days
      // the user SENT something on — their own posts only. Not a streak
      // warning (type 'default', but the sweep posts it under the DM's user
      // A, on exactly the days nobody has messaged yet), not a webhook's post
      // (authored by the webhook's creator, who needn't turn up at all), and
      // no system row (a server join, a pin, a call summary).
      days: sql<number>`COUNT(DISTINCT (${schema.messages.createdAt} AT TIME ZONE 'UTC')::date) FILTER (
        WHERE ${schema.messages.type} IN ('default', 'reply')
          AND ${schema.messages.webhookId} IS NULL
          AND ${schema.messages.metadata} ->> 'kind' IS DISTINCT FROM 'streak_warning'
      )`,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.authorId, userId),
        // The disappearing-timer notice is authored by whoever changed the
        // setting, and Zekk Pet notices by whoever caused them (or user A for
        // the sweep's): toggling, renaming or re-inviting must not farm
        // Chatterbox / Night Owl.
        notInArray(schema.messages.type, ['system_disappearing', 'system_pet']),
      ),
    );
  const totalMsgs = num(msgCounts?.total);
  const nightMsgs = num(msgCounts?.nightOwl);
  for (const tier of CHATTERBOX_TIERS) {
    out.push({
      id: `chatterbox_${tier}`,
      name: 'Chatterbox',
      description: `Sent ${tier.toLocaleString('en-US')} messages.`,
      marker: tier >= 1000 ? `${tier / 1000}k` : `${tier}`,
      value: totalMsgs,
      earned: totalMsgs >= tier,
      goal: tier,
    });
  }
  out.push({
    id: 'night_owl',
    name: 'Night Owl',
    description: 'Sent 500 messages between 1–5 AM.',
    marker: '🌙',
    value: nightMsgs,
    earned: nightMsgs >= 500,
    goal: 500,
  });

  // Regular — the same scan's `days`: UTC calendar days with at least one of
  // your own posts. Not compressible: one credit per day however much you
  // post, so 365 takes a year whatever you do, and it is solo by design (only
  // your own sends; no alt helps). A bot posting once a day for its owner
  // earns the BOT the badge, not the owner, and a webhook's daily post earns
  // nobody. A SCHEDULED send does count, on the day it goes out: a year of
  // them queued in one sitting is a year of waiting all the same.
  // Soft-deleted posts still count — deleting a message doesn't un-send it,
  // and can't create a day — so a disappearing-message timer expiring them
  // or a moderator deleting them takes nothing away (without that, two
  // friends on a 1-week timer would sit near 8 days forever). Hard deletes
  // do take days away — a server owner deleting the server (the guild purge
  // hard-deletes its messages), or either person turning a DM's E2EE off
  // (its ciphertext is purged) — mostly by someone else's hand: the ledger
  // floor keeps the rungs already recorded.
  const activeDays = Math.max(
    num(msgCounts?.days),
    ledgerFloor(REGULAR_TIERS, num(extra?.regularRungs)),
  );
  for (const tier of REGULAR_TIERS) {
    out.push({
      id: `regular_${tier}`,
      name: 'Regular',
      description: `Sent messages on ${tier} different days.`,
      marker: `${tier}`,
      value: activeDays,
      earned: activeDays >= tier,
      goal: tier,
    });
  }

  // First responder: replies within 10s of the message they answer.
  const [fr] = await db
    .select({
      n: sql<number>`COUNT(*)`,
    })
    .from(schema.messages)
    .innerJoin(
      sql`${schema.messages} AS parent`,
      sql`parent.id = ${schema.messages.replyToId}`,
    )
    .where(
      and(
        eq(schema.messages.authorId, userId),
        isNull(schema.messages.deletedAt),
        // The badge is for fast replies to OTHER people. Exclude self-replies
        // (author replying to their own message) so it can't be self-farmed by
        // posting then quick-replying to yourself. Also ignore replies to a
        // since-deleted parent.
        sql`parent.author_id IS DISTINCT FROM ${schema.messages.authorId}`,
        sql`parent.deleted_at IS NULL`,
        sql`${schema.messages.createdAt} - parent.created_at <= interval '10 seconds'`,
      ),
    );
  const fastReplies = num(fr?.n);
  out.push({
    id: 'first_responder',
    name: 'First Responder',
    description: 'Replied within 10 seconds, 100 times.',
    marker: '⚡',
    value: fastReplies,
    earned: fastReplies >= 100,
    goal: 100,
  });

  // Crowd Pleaser — the combined read's `crowd`: the most DISTINCT people on
  // ONE of your posts (your own default/reply messages: not a welcome row, a
  // webhook's post, a notice or a reaction-roles message — see `crowd`).
  // Farmability: one account per point and no more.
  // Reaction VOLUME is worth nothing (one person's twenty emoji are one
  // person), your own reactions don't count, and neither do bots' — bots are
  // free alts, up to 25 per owner, that can react anywhere their owner can
  // add them. So the top rung costs five other real accounts (a signup each:
  // DOB gate + email) reacting to the same message, the cost model the poke
  // ladder accepts: worth a tile, not a reputation signal.
  // Floored by the ledger: a reactor's account deletion purges their server
  // reactions, a moderator can clear a message's reactions or delete it, and
  // a guild purge cascades all of them — none of it the author's doing.
  const crowd = Math.max(num(extra?.crowd), ledgerFloor(CROWD_PLEASER_TIERS, num(extra?.crowdRungs)));
  for (const tier of CROWD_PLEASER_TIERS) {
    out.push({
      id: `crowd_pleaser_${tier}`,
      name: 'Crowd Pleaser',
      description: `${tier} different people reacted to one of your messages.`,
      marker: `${tier}`,
      value: crowd,
      earned: crowd >= tier,
      goal: tier,
    });
  }

  // The People Have Spoken — the combined read's `pollVoters`: the most
  // DISTINCT people who voted in ONE of your polls. Farmability: as Crowd
  // Pleaser — one account per point; re-voting, changing a vote or a
  // multiple-choice poll's several picks are still one person; your own vote
  // and bots' votes don't count.
  // Floored by the ledger: account deletion purges ALL of a leaver's votes,
  // deleting the poll's message (by a moderator, or a disappearing timer
  // expiring it) cascades or hides them, and so does a guild purge.
  const pollVoters = Math.max(
    num(extra?.pollVoters),
    ledgerFloor(POLLSTER_TIERS, num(extra?.pollsterRungs)),
  );
  for (const tier of POLLSTER_TIERS) {
    out.push({
      id: `pollster_${tier}`,
      name: 'The People Have Spoken',
      description: `A poll you made got votes from ${tier} different people.`,
      marker: `${tier}`,
      value: pollVoters,
      earned: pollVoters >= tier,
      goal: tier,
    });
  }

  // ── Friends (social circle tiers) ──────────────────────────────────────
  const [fc] = await db
    .select({ n: count() })
    .from(schema.relationships)
    .where(
      and(
        eq(schema.relationships.userId, userId),
        eq(schema.relationships.type, 'friend'),
      ),
    );
  const friends = num(fc?.n);
  for (const tier of SOCIAL_TIERS) {
    out.push({
      id: `social_${tier}`,
      name: 'Social Circle',
      description: `Made ${tier} friends.`,
      marker: `${tier}`,
      value: friends,
      earned: friends >= tier,
      goal: tier,
    });
  }

  // ── Marathon (365-day streak, live or historical best) ─────────────────
  const { bestStreakForUser } = await import('./streaks');
  const best = await bestStreakForUser(userId);
  out.push({
    id: 'marathon',
    name: 'Marathon',
    description: 'Kept a 365-day messaging streak.',
    marker: '🔥',
    value: best,
    earned: best >= 365,
    goal: 365,
  });

  // Inseparable — the rungs beneath Marathon, off the SAME `best` value (no
  // extra query). Not self-farmable: a streak day is credited only when BOTH
  // participants of the DM message within the same UTC day (streaks.ts), and
  // the goal is measured in calendar days — an alt account still has to be
  // tended on 7 / 30 / 100 separate real days, which no amount of grinding
  // compresses. Kept as its own family name rather than folded into
  // 'Marathon': sharing the name would relabel the existing badge as
  // "Marathon IV" on everyone's shelf.
  for (const tier of INSEPARABLE_TIERS) {
    out.push({
      id: `inseparable_${tier}`,
      name: 'Inseparable',
      description: `Kept a ${tier}-day DM streak.`,
      marker: `${tier}`,
      value: best,
      earned: best >= tier,
      goal: tier,
    });
  }

  // Kindred Spirits — the combined read's `kindred`: DISTINCT people you've
  // kept a KINDRED_STREAK_DAYS-day streak with (live or historical best).
  // Farmability: calendar-gated exactly like Inseparable — each person costs
  // seven real UTC days on which BOTH of you messaged, which no grinding
  // compresses; parallel streaks with alts cost a real signup each, and bot
  // partners (free alts) don't count. A reopened DM is the same person.
  // Floored by the ledger: dm_streaks rows are never deleted, but a partner
  // removed by the inactivity sweep stops counting (see `kindred`), and that
  // is not the user's doing.
  const kindred = Math.max(num(extra?.kindred), ledgerFloor(KINDRED_TIERS, num(extra?.kindredRungs)));
  for (const tier of KINDRED_TIERS) {
    out.push({
      id: `kindred_${tier}`,
      name: 'Kindred Spirits',
      // "DM streak", as its base badge Inseparable says it.
      description: `Kept a ${KINDRED_STREAK_DAYS}-day DM streak with ${tier} different people.`,
      marker: `${tier}`,
      value: kindred,
      earned: kindred >= tier,
      goal: tier,
    });
  }

  // ── Founder (owns a guild that reached 25 members) ─────────────────────
  const [biggest] = await db
    .select({
      members: sql<number>`(
        SELECT COUNT(*) FROM ${schema.guildMembers}
        WHERE ${schema.guildMembers.guildId} = ${schema.guilds.id}
      )`,
    })
    .from(schema.guilds)
    .where(and(eq(schema.guilds.ownerId, userId), isNull(schema.guilds.deletedAt)))
    .orderBy(sql`1 DESC`)
    .limit(1);
  const biggestGuild = num(biggest?.members);
  out.push({
    id: 'founder',
    name: 'Founder',
    description: 'Created a server that reached 25 members.',
    marker: '🏛️',
    value: biggestGuild,
    earned: biggestGuild >= 25,
    goal: 25,
  });
  // Founder II / III — same `biggest` row, no extra query. Not farmable at
  // this scale: every member is a distinct account that had to clear signup
  // (DOB gate + email) and then actually join, and the value is CURRENT
  // membership rather than a cumulative total, so it goes back down when
  // people leave. Whoever fakes 500 of those has earned something.
  for (const tier of FOUNDER_TIERS) {
    out.push({
      id: `founder_${tier}`,
      name: 'Founder',
      description: `Created a server that reached ${tier} members.`,
      marker: `${tier}`,
      value: biggestGuild,
      earned: biggestGuild >= tier,
      goal: tier,
    });
  }

  // ── Voice of the People (100h in 1:1 calls) ────────────────────────────
  // Summed from system_call summaries in DMs the user participates in.
  const [vh] = await db
    .select({
      ms: sql<number>`COALESCE(SUM((${schema.messages.metadata} ->> 'durationMs')::bigint), 0)`,
      // Ring Ring rides along on the SAME scan — one more aggregate, zero extra
      // round trips. `missed = false` means the callee really joined: voice.ts
      // stamps dm_active_call_answered_at only when a SECOND, different user
      // enters the DM voice channel, so ring-outs and declines don't count.
      // No channel-type or participant predicate is needed here, and that is
      // load-bearing, not an oversight: BOTH writers of these rows hard-gate on
      // `channel.type === 'dm'` (voice.ts joinVoice + endDmCallBookkeeping), so
      // a `kind:'call'` summary can only exist in a 1:1 DM — where
      // dm_recipients is exactly the two people on the call, and `missed=false`
      // means both of them joined. If group-DM calls ever start writing these
      // summaries, that invariant breaks and this query needs the predicate.
      calls: sql<number>`COUNT(*) FILTER (WHERE ${schema.messages.metadata} ->> 'missed' = 'false')`,
    })
    .from(schema.messages)
    .innerJoin(
      schema.dmRecipients,
      eq(schema.dmRecipients.channelId, schema.messages.channelId),
    )
    .where(
      and(
        eq(schema.messages.type, 'system_call'),
        eq(schema.dmRecipients.userId, userId),
        sql`${schema.messages.metadata} ->> 'kind' = 'call'`,
      ),
    );
  const callHours = Math.floor(num(vh?.ms) / 3_600_000);
  out.push({
    id: 'voice_of_people',
    name: 'Voice of the People',
    description: 'Spent 100 hours in calls.',
    marker: '🎙️',
    value: callHours,
    earned: callHours >= 100,
    goal: 100,
  });

  // Ring Ring — mildly farmable (a pair of accounts could answer each other 50
  // times) but each cycle costs two real voice joins and it unlocks nothing but
  // the tile, so the effort/reward never favours it. Deliberately COUNT-based
  // rather than duration-based: a "longest single call" badge would pay people
  // to leave a line open and walk away, which is not a thing worth rewarding.
  const completedCalls = num(vh?.calls);
  out.push({
    id: 'ring_ring',
    name: 'Ring Ring',
    description: 'Completed 50 calls.',
    marker: '📞',
    value: completedCalls,
    earned: completedCalls >= 50,
    goal: 50,
  });

  const passkeys = num(extra?.passkeys);
  const hasTotp = userRow?.totpEnabled === true;
  out.push({
    id: 'locked_in',
    name: 'Locked In',
    description: 'Added a passkey to your account.',
    marker: '🔑',
    value: passkeys,
    earned: passkeys >= 1,
    goal: 1,
  });
  out.push({
    id: 'double_locked',
    name: 'Double Locked',
    description: 'Passkey and two-factor authentication both enabled.',
    marker: '🛡️',
    value: (passkeys >= 1 ? 1 : 0) + (hasTotp ? 1 : 0),
    earned: passkeys >= 1 && hasTotp,
    goal: 2,
  });

  // Profile cosmetics — current-state achievements (clearing un-earns them,
  // matching the compute-on-demand model).
  const hasTag = !!userRow?.tagLabel;
  const hasFrame = !!userRow?.avatarDecoration;
  const lookParts =
    (userRow?.avatarUrl ? 1 : 0) +
    (userRow?.bannerUrl ? 1 : 0) +
    (userRow?.bio ? 1 : 0) +
    (hasTag ? 1 : 0);
  out.push({
    id: 'tagged',
    name: 'Tagged',
    description: 'Wearing a name tag.',
    marker: '🏷️',
    value: hasTag ? 1 : 0,
    earned: hasTag,
    goal: 1,
  });
  out.push({
    id: 'framed',
    name: 'Framed',
    description: 'Avatar frame equipped.',
    marker: '🖼️',
    value: hasFrame ? 1 : 0,
    earned: hasFrame,
    goal: 1,
  });
  out.push({
    id: 'signature_look',
    name: 'Signature Look',
    description: 'Avatar, banner, bio, and name tag all set.',
    marker: '✨',
    value: lookParts,
    earned: lookParts >= 4,
    goal: 4,
  });

  const welcomes = num(extra?.welcomes);
  out.push({
    id: 'welcome_committee',
    name: 'Welcome Committee',
    description: 'First to greet a newcomer after their welcome.',
    marker: '👋',
    value: welcomes,
    earned: welcomes >= 1,
    goal: 1,
  });
  // Welcome Committee II / III — same `welcomes` value, no extra query.
  // Farmability: skipping the user's own system_join rows (`sj.author_id IS
  // DISTINCT FROM userId`) only stops you scoring off your own rejoins — on its
  // own it is NOT enough at these thresholds. `postWelcomeMessage` fires on
  // every non-idempotent join and the join route has no rate limit, so counting
  // join EVENTS would let one alt join/leave 50 times and hand over the top rung
  // in minutes. Hence the DISTINCT-on-author subquery: 50 requires
  // 50 DIFFERENT newcomers, which is what the badge actually claims. It cannot
  // weaken the goal-1 rung — the first greeting still counts as one.
  for (const tier of WELCOME_TIERS) {
    out.push({
      id: `welcome_committee_${tier}`,
      name: 'Welcome Committee',
      description: `First to greet ${tier} newcomers.`,
      marker: `${tier}`,
      value: welcomes,
      earned: welcomes >= tier,
      goal: tier,
    });
  }

  // ── Pokes (Nudge Nudge sent / Poke Magnet received) ────────────────────
  // Farmability. Both directions cost ONE SIGNUP PER POINT and no more. The
  // tally PK is (initiator_id, recipient_id), so someone you poke a thousand
  // times is one row — repeat pokes bump poke_count, which nothing here reads.
  // That is the `welcome_committee` lesson applied up front rather than after
  // shipping: counting poke EVENTS would let a single alt and the 10s
  // per-target timer hand over the top rung before lunch. Fan-out is closed
  // too — the route is 1:1-DM-only (`ctx.channel.type !== 'dm'` rejects group
  // DMs) and refuses self-pokes, so one poke can only ever create one pair row.
  //
  // What that does NOT buy is immunity, and the ladder is priced accordingly.
  // At this headcount the top rung is 5, so faking it honestly costs 5 alts
  // (self-pokes are refused, so all five are other accounts),
  // each needing a real signup (DOB gate + email) AND a DM path to you (friend
  // accept, or a shared server with allowDmsFromServerMembers). Same cost model
  // `founder` accepts, minus the prohibitive scale — cheap enough that these are
  // worth a tile and not worth trusting as a reputation signal, which is the
  // right ceiling for a poke badge.
  //
  // Both values are clamped up to what the ledger already recorded: the tally's
  // FKs cascade on user delete, so the raw counts fall when a THIRD PARTY closes
  // their account. See ledgerFloor for why that is the one regression this file
  // does not accept.
  const poked = Math.max(
    num(extra?.pokedDistinct),
    ledgerFloor(POKE_SENT_TIERS, num(extra?.pokeSentRungs)),
  );
  const pokedBy = Math.max(
    num(extra?.pokedByDistinct),
    ledgerFloor(POKE_RECEIVED_TIERS, num(extra?.pokeRecvRungs)),
  );
  for (const tier of POKE_SENT_TIERS) {
    out.push({
      id: `poke_sent_${tier}`,
      name: 'Nudge Nudge',
      description: tier === 1 ? 'Poked someone.' : `Poked ${tier} different people.`,
      marker: tier === 1 ? '👉' : `${tier}`,
      value: poked,
      earned: poked >= tier,
      goal: tier,
    });
  }
  out.push({
    id: `poke_received_${POKE_RECEIVED_GOAL}`,
    name: 'Poke Magnet',
    description: `Poked by ${POKE_RECEIVED_GOAL} different people.`,
    marker: '🧲',
    value: pokedBy,
    earned: pokedBy >= POKE_RECEIVED_GOAL,
    goal: POKE_RECEIVED_GOAL,
  });

  // ── Zekk Pets (Zekk Keeper / Perfect Day) ──────────────────────────────
  // Zekk Keeper — the combined read's `petLevel`: the highest level any of
  // your current pets has reached, one rung per stage. Calendar-gated, not
  // compressible: points come only from once-a-day tasks, at most 35 a UTC
  // day, and only after a live 3-day streak with someone who accepts — so the
  // rungs take at least 1 / 5 / 14 / 26 / 61 real days. An alt partner (a
  // real signup; a bot counts for nothing) can raise one alone, but not
  // faster. MAX over pets, never a sum, so raising several at once doesn't
  // stack. The pet is shared, so both people earn each rung — hence
  // "Helped", whoever's message tipped it over.
  // Floored by the ledger: the pet row is DELETED when it runs away, when
  // EITHER person closes the DM, or when the partner deletes their account —
  // losing the pet doesn't un-raise it. The floor only keeps what a sync
  // recorded, so pets.recordActivity syncs both people the moment a stage
  // changes.
  const petLevel = Math.max(
    num(extra?.petLevel),
    ledgerFloor(PET_KEEPER_TIERS, num(extra?.petKeeperRungs)),
  );
  for (const tier of PET_KEEPER_TIERS) {
    const stage = petStageForLevel(tier);
    const label = petStageLabel(stage);
    out.push({
      id: `pet_keeper_${tier}`,
      name: 'Zekk Keeper',
      // The pet notice's own a/an rule ("Zekk grew into an Adult!").
      description:
        stage === 'baby'
          ? 'Helped hatch a Zekk Pet.'
          : `Helped a Zekk Pet grow into ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}.`,
      marker: stage === 'baby' ? '🐣' : `${tier}`,
      value: petLevel,
      earned: petLevel >= tier,
      goal: tier,
    });
  }

  // Perfect Day — every Zekk Pet task done in one UTC day (the pet's
  // 'thriving' mood). Mildly farmable — about two dozen actions in a day (ten
  // messages each, a voice message, a photo, a poke) — but only once a pet
  // exists, which takes a live 3-day streak with someone who accepts, and not
  // with a bot. It reads a snapshot (tasks_done belongs to its task_day, and
  // the next day's first activity resets it), so pets.recordActivity syncs
  // both people the moment the last task lands, any sync before that next
  // activity records it too, and the ledger floor keeps the badge afterwards
  // (and after the pet is gone). Its own marker: Android draws the marker as
  // the badge, and '✨' is Signature Look's.
  const perfectDay = Math.max(
    num(extra?.petPerfectDays) > 0 ? 1 : 0,
    ledgerFloor([1], num(extra?.perfectDayRungs)),
  );
  out.push({
    id: 'pet_perfect_day',
    name: 'Perfect Day',
    description: 'Every Zekk Pet task done in one day.',
    marker: '☀️',
    value: perfectDay,
    earned: perfectDay >= 1,
    goal: 1,
  });

  const e2eeDms = num(extra?.e2eeDms);
  out.push({
    id: 'off_the_record',
    name: 'Off the Record',
    description: 'In an end-to-end encrypted DM.',
    marker: '🔒',
    value: e2eeDms,
    earned: e2eeDms >= 1,
    goal: 1,
  });

  // Now You See Me — the combined read's `vanishing`. Free by design, like
  // Off the Record: one switch in a DM's settings, a tile that shows people
  // the feature exists. Repeating it earns nothing more (goal 1), and the
  // settings change is rate-limited anyway. Turning the timer off again
  // doesn't take it back: the "turned on" notice stays in the DM.
  // Floored by the ledger all the same: the notice is the one record, and
  // turning E2EE off purges any row whose text reads like ciphertext — which
  // a notice's fallback text can, from the changer's display name — so the
  // other person can delete it.
  const vanishing = Math.max(num(extra?.vanishing), ledgerFloor([1], num(extra?.vanishingRungs)));
  out.push({
    id: 'vanishing_act',
    name: 'Now You See Me',
    description: 'Turned on disappearing messages.',
    marker: '👻',
    value: vanishing,
    earned: vanishing >= 1,
    goal: 1,
  });

  const discovered = num(extra?.discovered);
  out.push({
    id: 'discovered',
    name: 'Discovered',
    description: 'Joined a server through Discovery.',
    marker: '🧭',
    value: discovered,
    earned: discovered >= 1,
    goal: 1,
  });

  const guardianOf = num(extra?.guardianOf);
  out.push({
    id: 'guardian_angel',
    name: 'Guardian Angel',
    description: 'Supervising a child account to keep them safe.',
    marker: '👼',
    value: guardianOf,
    earned: guardianOf >= 1,
    goal: 1,
  });

  const voiceJoins = num(extra?.voiceJoins);
  const voiceMinutes = Math.floor(num(extra?.voiceSeconds) / 60);
  out.push({
    id: 'first_contact',
    name: 'First Contact',
    description: 'Joined a voice channel.',
    marker: '📡',
    value: voiceJoins,
    earned: voiceJoins >= 1,
    goal: 1,
  });
  out.push({
    id: 'event_horizon',
    name: 'Event Horizon',
    description: 'Spent an hour in voice channels.',
    marker: '⚫',
    value: voiceMinutes,
    earned: voiceMinutes >= 60,
    goal: 60,
  });
  // Event Horizon II — same `voiceSeconds`, no extra query.
  //
  // FARMABLE BY DOING NOTHING, and that is the whole design constraint here:
  // user_voice_stats.total_seconds accrues while you sit alone in an empty
  // channel, so this measures presence, not participation. 10h is the ceiling
  // on purpose — ordinary use reaches it, and idling to it isn't worth
  // automating.
  //
  // DO NOT ADD A 100h RUNG. At that size, parking a client in a channel
  // overnight becomes the cheapest path by an order of magnitude and the
  // dominant strategy is AFK, which makes the badge mean the opposite of what
  // it says. If a bigger voice badge is ever wanted, it has to be built on
  // time spent with OTHER people present, not raw session seconds — and that
  // is a new aggregate, not a free rung on this one.
  out.push({
    id: 'event_horizon_600',
    name: 'Event Horizon',
    description: 'Spent 10 hours in voice channels.',
    marker: '10h',
    value: voiceMinutes,
    earned: voiceMinutes >= 600,
    goal: 600,
  });

  // Earned first (newest families intermixed is fine), then locked by
  // how close they are to unlocking.
  out.sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    if (a.earned) return 0;
    const pa = a.goal ? a.value / a.goal : 0;
    const pb = b.goal ? b.value / b.goal : 0;
    return pb - pa;
  });
  return out;
}

// ── Unlock detection + notification ──────────────────────────────────────────
//
// Achievements are computed live (above), so there is no natural "unlock"
// event. `user_achievements` is the ledger of what's already earned; syncing
// diffs the live-earned set against it and the newly-inserted rows ARE the
// just-unlocked achievements. We then notify (in-app gateway toast + push).
//
// Rollout safety: a user's FIRST sync is a SILENT backfill — we record their
// existing backlog without notifying (else everyone gets spammed at launch).
// `users.achievements_seeded` gates this; new users are seeded at signup so
// they get notified from their very first earn. On its own that gate is
// per-user and one-shot, so it does nothing for badges added AFTER a user is
// seeded. A release whose new families count PAST data re-arms it by bumping
// ACHIEVEMENT_CATALOG (below): every account still at an older catalog gets
// one more silent backfill, which records exactly the backlog the code
// computes. NEVER_NOTIFY_IDS is the separate, permanent silence for the one
// badge that must never announce at all.

/**
 * The catalog version the silent backfill is keyed on, against
 * `users.achievements_catalog` (migration 0137; 0 = from before it). BUMP IT
 * in a release that adds a family counting PAST data — an account's history
 * would otherwise unlock all at once on its first sync after the deploy, one
 * toast and one push per rung (this catalog's families are worth 5–10 for an
 * active account). Raise it only for such families: the backfill's one cost
 * is that a rung genuinely first crossed in that same sync (any family's) is
 * recorded silently too. Signup stamps new accounts with it (they have no
 * backlog).
 * Its own column rather than resetting achievements_seeded in a migration: a
 * build from before it (a rollback) never reads or writes this column, so a
 * rollback and roll-forward can't hand the backlog back as a burst.
 *
 *   1 — Regular, Crowd Pleaser, The People Have Spoken, Kindred Spirits,
 *       Now You See Me, Zekk Keeper, Perfect Day.
 */
export const ACHIEVEMENT_CATALOG = 1;

/**
 * Badges that are recorded and displayed but NEVER announced — no toast, no
 * push, permanently.
 *
 * `founding_member` is not an unlock EVENT. It is true from the instant of
 * signup (`users.created_at` is stamped by the signup INSERT and never
 * changes), so there is no moment at which the user does something to earn it.
 * Announcing it is therefore always wrong, not merely wrong at rollout:
 * shipping it as notifiable would push "Achievement unlocked — Founding
 * Member" once to EVERY account that has ever existed (all of them predate the
 * cutoff) inside a single 60s throttle window, and would then greet each
 * brand-new signup with the same toast seconds after registration, because
 * signup marks them seeded.
 *
 * The ledger insert and the shelf tile are untouched — only the notification
 * is suppressed. Do NOT generalise this into a time-windowed silence for the
 * other new badges: those are genuine unlocks people really earned. A new
 * family's BACKLOG at rollout is the catalog backfill's job (one silent sync
 * per account, see ACHIEVEMENT_CATALOG), never this list's: every unlock after
 * it is announced as usual.
 *
 * The poke badges (nudge_nudge / poke_magnet) are NOT listed here and must not
 * be: each one marks a real act at a real moment. They also need no suppression
 * to roll out quietly, which is a property of the data rather than a policy.
 * `poke_tallies` shipped empty and migration 0120 backfilled nothing — the old
 * `pokes` buffer was pruned to 6 rows per channel+recipient, so there was no
 * history left to reconstruct from. Every account therefore computes 0/0 on
 * deploy, the lowest rung has goal 1, and nothing is earned, so nothing reaches
 * the ledger and no push is sent to anybody. The first person to poke someone
 * after deploy earns Nudge Nudge for actually poking someone.
 */
const NEVER_NOTIFY_IDS = new Set<string>(['founding_member']);

/**
 * Recompute a user's achievements, record any newly-earned ones in the ledger,
 * and — unless this is a silent backfill (the first sync, or the first at a
 * new ACHIEVEMENT_CATALOG), the user has turned achievement notifications off,
 * or the badge is in NEVER_NOTIFY_IDS — announce them: an in-app gateway toast
 * per family (its highest new rung) and one push. Fully best-effort: never
 * throws (callers fire-and-forget it).
 */
export async function syncAndNotifyAchievements(userId: bigint): Promise<void> {
  const [u] = await db
    .select({
      seeded: schema.users.achievementsSeeded,
      catalog: schema.users.achievementsCatalog,
      notify: schema.users.notifyAchievements,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!u) return;

  const shelf = await achievementsForUser(userId);
  const earnedIds = shelf.filter((a) => a.earned).map((a) => a.id);

  // Insert the currently-earned set; the composite PK rejects already-recorded
  // ones, so RETURNING gives exactly the ids new to the ledger this call.
  const inserted =
    earnedIds.length > 0
      ? await db
          .insert(schema.userAchievements)
          .values(earnedIds.map((achievementId) => ({ userId, achievementId })))
          .onConflictDoNothing()
          .returning({ id: schema.userAchievements.achievementId })
      : [];

  // First sync ever for this user, or the first since the catalog grew →
  // silent backfill: the backlog is now recorded, but we don't announce
  // years-old achievements. Mark seeded (and at this catalog) so the NEXT earn
  // is a real, notifiable unlock. GREATEST: never move an account back to an
  // older catalog.
  if (!u.seeded || u.catalog < ACHIEVEMENT_CATALOG) {
    await db
      .update(schema.users)
      .set({
        achievementsSeeded: true,
        achievementsCatalog: sql`GREATEST(${schema.users.achievementsCatalog}, ${ACHIEVEMENT_CATALOG}::int)`,
      })
      .where(eq(schema.users.id, userId));
    return;
  }

  if (inserted.length === 0 || !u.notify) return;

  const newIds = new Set(inserted.map((r) => r.id));
  const recorded = shelf.filter(
    (a) => a.earned && newIds.has(a.id) && !NEVER_NOTIFY_IDS.has(a.id),
  );
  // One announcement per family: when a sync crosses several rungs at once
  // (Regular I and II on one recompute), only the highest is news — the
  // clients name a badge by its family, so the rest would read as the same
  // unlock twice. The ledger above still holds every rung.
  const top = new Map<string, Achievement>();
  for (const a of recorded) {
    const prev = top.get(a.name);
    if (!prev || (a.goal ?? 0) > (prev.goal ?? 0)) top.set(a.name, a);
  }
  const fresh = recorded.filter((a) => top.get(a.name) === a);
  if (fresh.length === 0) return;

  const dispatch = await import('../gateway/dispatch');
  const { sendToUser } = await import('./push');
  // Live in-app celebration (only reaches this user's own connections).
  for (const a of fresh) {
    try {
      dispatch.achievementUnlock({
        userId,
        id: a.id,
        name: a.name,
        description: a.description,
        marker: a.marker,
      });
    } catch (err) {
      console.error('[achievements] live unlock dispatch failed:', err);
    }
  }
  // Closed-app push (Web Push / APNs / FCM). data.kind routes the tap to the
  // achievements gallery. ONE push per sync: several families unlocking
  // together (a pet evolving on the day's last task: Zekk Keeper and Perfect
  // Day) are one notification naming them all, under a tag of its own, not a
  // stack of alerts that each buzz the phone.
  const first = fresh[0]!;
  const push =
    fresh.length === 1
      ? {
          title: 'Achievement unlocked 🏆',
          body: `${first.name} — ${first.description}`,
          tag: `achv-${first.id}`,
        }
      : {
          title: `${fresh.length} achievements unlocked 🏆`,
          body: fresh.map((a) => a.name).join(', '),
          tag: 'achv-unlocks',
        };
  await sendToUser(userId, {
    ...push,
    url: '/',
    data: { kind: 'achievement', achievementId: first.id },
  }).catch((err) => console.error('[achievements] unlock push failed:', err));
}

// Per-process throttle for the VERY-hot hook (every message send): at most one
// full recompute per user per window. Bounded + self-pruning. Multi-node just
// means one sync per node per window — harmless (sync is idempotent).
const lastSyncAt = new Map<string, number>();
const SYNC_THROTTLE_MS = 60_000;

/**
 * Throttled fire-and-forget sync for hot paths (message send). Skips if the
 * user was synced within the last minute; otherwise runs in the background.
 */
export function syncAndNotifyAchievementsThrottled(userId: bigint): void {
  const key = userId.toString();
  const now = Date.now();
  const prev = lastSyncAt.get(key);
  if (prev !== undefined && now - prev < SYNC_THROTTLE_MS) return;
  lastSyncAt.set(key, now);
  if (lastSyncAt.size > 5000) {
    for (const [k, t] of lastSyncAt) {
      if (now - t > SYNC_THROTTLE_MS) lastSyncAt.delete(k);
    }
  }
  void syncAndNotifyAchievements(userId).catch((err) => {
    console.error('[achievements] throttled sync failed:', err);
  });
}
