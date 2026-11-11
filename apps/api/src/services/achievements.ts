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
 *   first_responder   — 100 replies sent within 10s of the original
 *   inseparable       — DM streak: 7 / 30 / 100 days
 *   marathon          — a 365-day messaging streak (the capstone above those)
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
 *   discovered        — joined a server through Discovery
 *   guardian_angel    — actively supervising a child account
 *   first_contact     — joined a voice channel (user_voice_stats)
 *   event_horizon     — total voice time: 1h / 10h (user_voice_stats)
 *   nudge_nudge       — poked 1 / 3 / 5 DISTINCT people (poke_tallies)
 *   poke_magnet       — 5 DISTINCT people have poked you (poke_tallies)
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

  // ── Messages sent (chatterbox tiers + night owl + first responder) ─────
  const [msgCounts] = await db
    .select({
      total: count(),
      nightOwl: sql<number>`COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM ${schema.messages.createdAt}) BETWEEN 1 AND 4)`,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.authorId, userId),
        isNull(schema.messages.deletedAt),
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

  // ── One combined read for the newer families ───────────────────────────
  // Scalar subqueries anchored on the user's own row: passkeys, E2EE DMs,
  // discovery joins, guardian links, welcome-committee firsts, and the voice
  // participation counters. Single round trip instead of six.
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
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

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
  // At this headcount the top rung is 5, so faking it honestly costs ~4 alts,
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
// they get notified from their very first earn. That gate is per-user and
// one-shot, so it does nothing for badges added AFTER a user is seeded — see
// NEVER_NOTIFY_IDS for the one badge that must never announce at all.

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
 * other new badges: those are genuine unlocks people really earned, and their
 * rollout burst is accepted deliberately.
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
 * and — unless this is the silent first-sync backfill, the user has turned
 * achievement notifications off, or the badge is in NEVER_NOTIFY_IDS — fire an
 * in-app gateway toast + a push for each. Fully best-effort: never throws
 * (callers fire-and-forget it).
 */
export async function syncAndNotifyAchievements(userId: bigint): Promise<void> {
  const [u] = await db
    .select({
      seeded: schema.users.achievementsSeeded,
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

  // First sync ever for this user → silent backfill: the backlog is now
  // recorded, but we don't announce years-old achievements. Mark seeded so the
  // NEXT earn is a real, notifiable unlock.
  if (!u.seeded) {
    await db
      .update(schema.users)
      .set({ achievementsSeeded: true })
      .where(eq(schema.users.id, userId));
    return;
  }

  if (inserted.length === 0 || !u.notify) return;

  const newIds = new Set(inserted.map((r) => r.id));
  const fresh = shelf.filter(
    (a) => a.earned && newIds.has(a.id) && !NEVER_NOTIFY_IDS.has(a.id),
  );
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
  // achievements gallery. Fired in parallel — each sendToUser is independent,
  // so serializing them (and re-querying this user's token tables N times
  // back-to-back on a multi-unlock) only added latency.
  await Promise.all(
    fresh.map((a) =>
      sendToUser(userId, {
        title: 'Achievement unlocked 🏆',
        body: `${a.name} — ${a.description}`,
        tag: `achv-${a.id}`,
        url: '/',
        data: { kind: 'achievement', achievementId: a.id },
      }).catch((err) => console.error('[achievements] unlock push failed:', err)),
    ),
  );
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
