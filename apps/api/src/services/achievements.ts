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
 *   marathon          — a 365-day messaging streak
 *   founder           — owns a server that reached 25 members
 *   voice_of_people   — 100 hours in 1:1 calls (sum of call durations)
 *   locked_in         — added a passkey
 *   double_locked     — passkey AND two-factor both enabled
 *   tagged            — wearing a name tag
 *   framed            — avatar frame equipped
 *   signature_look    — avatar + banner + bio + name tag all set
 *   welcome_committee — first to greet a newcomer after their welcome message
 *   off_the_record    — in an end-to-end-encrypted DM
 *   discovered        — joined a server through Discovery
 *   guardian_angel    — actively supervising a child account
 *   first_contact     — joined a voice channel (user_voice_stats)
 *   event_horizon     — an hour of total voice time (user_voice_stats)
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
  /** Whether the user has unlocked it. Locked entries carry progress. */
  earned: boolean;
  /** Threshold to unlock (absent for the open-ended veteran years). */
  goal?: number;
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
  out.push({
    id: 'voice_of_people',
    name: 'Voice of the People',
    description: 'Spent 100 hours in calls.',
    marker: '🎙️',
    value: callHours,
    earned: callHours >= 100,
    goal: 100,
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
      welcomes: sql<number>`(
        SELECT COUNT(*) FROM ${schema.messages} sj
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
// they get notified from their very first earn.

/**
 * Recompute a user's achievements, record any newly-earned ones in the ledger,
 * and — unless this is the silent first-sync backfill or the user has turned
 * achievement notifications off — fire an in-app gateway toast + a push for
 * each. Fully best-effort: never throws (callers fire-and-forget it).
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
  const fresh = shelf.filter((a) => a.earned && newIds.has(a.id));
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
