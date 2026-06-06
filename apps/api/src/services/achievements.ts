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
 *   veteran          — one per full account year (year marker included)
 *   chatterbox       — messages sent: 100 / 1k / 10k / 100k
 *   social_circle    — friends: 5 / 10 / 25 / 50
 *   night_owl        — 500 messages sent between 01:00–05:00 (server time)
 *   first_responder  — 100 replies sent within 10s of the original
 *   marathon         — a 365-day messaging streak
 *   founder          — owns a server that reached 25 members
 *   voice_of_people  — 100 hours in 1:1 calls (sum of call durations)
 */

import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Marker shown in the badge (year number, tier threshold…). */
  marker: string;
  /** Current raw progress value behind the badge. */
  value: number;
}

const CHATTERBOX_TIERS = [100, 1_000, 10_000, 100_000];
const SOCIAL_TIERS = [5, 10, 25, 50];

function num(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'string') return parseInt(x, 10) || 0;
  return 0;
}

export async function achievementsForUser(userId: bigint): Promise<Achievement[]> {
  const out: Achievement[] = [];

  // ── Account age (veteran, one per year) ────────────────────────────────
  const [userRow] = await db
    .select({ createdAt: schema.users.createdAt })
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
    .where(and(eq(schema.messages.authorId, userId), isNull(schema.messages.deletedAt)));
  const totalMsgs = num(msgCounts?.total);
  const nightMsgs = num(msgCounts?.nightOwl);
  for (const tier of CHATTERBOX_TIERS) {
    if (totalMsgs >= tier) {
      out.push({
        id: `chatterbox_${tier}`,
        name: 'Chatterbox',
        description: `Sent ${tier.toLocaleString('en-US')} messages.`,
        marker: tier >= 1000 ? `${tier / 1000}k` : `${tier}`,
        value: totalMsgs,
      });
    }
  }
  if (nightMsgs >= 500) {
    out.push({
      id: 'night_owl',
      name: 'Night Owl',
      description: 'Sent 500 messages between 1–5 AM.',
      marker: '🌙',
      value: nightMsgs,
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
        sql`${schema.messages.createdAt} - parent.created_at <= interval '10 seconds'`,
      ),
    );
  const fastReplies = num(fr?.n);
  if (fastReplies >= 100) {
    out.push({
      id: 'first_responder',
      name: 'First Responder',
      description: 'Replied within 10 seconds, 100 times.',
      marker: '⚡',
      value: fastReplies,
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
    if (friends >= tier) {
      out.push({
        id: `social_${tier}`,
        name: 'Social Circle',
        description: `Made ${tier} friends.`,
        marker: `${tier}`,
        value: friends,
      });
    }
  }

  // ── Marathon (365-day streak, live or historical best) ─────────────────
  const { bestStreakForUser } = await import('./streaks');
  const best = await bestStreakForUser(userId);
  if (best >= 365) {
    out.push({
      id: 'marathon',
      name: 'Marathon',
      description: 'Kept a 365-day messaging streak.',
      marker: '🔥',
      value: best,
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
  if (biggestGuild >= 25) {
    out.push({
      id: 'founder',
      name: 'Founder',
      description: 'Created a server that reached 25 members.',
      marker: '🏛️',
      value: biggestGuild,
    });
  }

  // ── Voice of the People (100h in 1:1 calls) ────────────────────────────
  // Summed from system_call summaries in DMs the user participates in.
  const [vh] = await db
    .select({
      ms: sql<number>`COALESCE(SUM((${schema.messages.metadata} ->> 'durationMs')::bigint), 0)`,
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
  if (callHours >= 100) {
    out.push({
      id: 'voice_of_people',
      name: 'Voice of the People',
      description: 'Spent 100 hours in calls.',
      marker: '🎙️',
      value: callHours,
    });
  }

  return out;
}
