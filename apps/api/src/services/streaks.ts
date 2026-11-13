/**
 * DM messaging streaks
 * --------------------
 * A streak day is credited when BOTH participants of a 1:1 DM message
 * within the same UTC calendar day; consecutive credited days build the
 * streak (display-capped at 10,000). Only timestamps are used — content is
 * never read, so E2EE conversations participate fully.
 */

import { and, eq, gt, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { notifyHeldReadMarkerIfWaiting } from './dms';
import { createSystemMessage } from './messages';
import { unreadBadgeCounts } from './readStates';
import { toMessage } from '../lib/dto';
import * as dispatch from '../gateway/dispatch';
import { log } from '../log';

const CAP = 10_000;

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function prevUtcDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDay(d);
}

/** Record a message from `authorId` in a 1:1 DM and update the streak. `at`
 *  (default now) fixes the UTC day it counts for: the send route passes the
 *  message's createdAt, and the same instant to the Zekk Pet, so a message
 *  sent a few ms before midnight is credited to one day by both. */
export async function recordDmMessage(args: {
  channelId: bigint;
  authorId: bigint;
  recipientId: bigint;
  at?: Date;
}): Promise<{ streak: number; changed: boolean }> {
  const today = utcDay(args.at);
  const [a, b] = args.authorId < args.recipientId
    ? [args.authorId, args.recipientId]
    : [args.recipientId, args.authorId];
  const authorIsA = args.authorId === a;

  // Serialize the read-modify-write per channel. Without this, two concurrent
  // first-of-day messages (one from each participant) both read the same
  // pre-commit snapshot and each writes only its own side's lastDay stamp;
  // whichever commits last clobbers the other back to null, so the
  // "both messaged today" credit condition never fires. A transaction-scoped
  // advisory lock keyed on channelId makes the second call block until the
  // first commits, so its SELECT reads the first side's committed stamp.
  // Cheap per-channel lock, auto-released at commit/rollback.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${args.channelId.toString()}, 0))`,
    );

    const [row] = await tx
      .select()
      .from(schema.dmStreaks)
      .where(eq(schema.dmStreaks.channelId, args.channelId))
      .limit(1);

    let lastDayA = row?.lastDayA ?? null;
    let lastDayB = row?.lastDayB ?? null;
    let prevDayA = row?.prevDayA ?? null;
    let prevDayB = row?.prevDayB ?? null;
    let lastCountedDay = row?.lastCountedDay ?? null;
    let streak = row?.streak ?? 0;
    let bestStreak = row?.bestStreak ?? 0;
    const prevStreak = streak;

    // Each side keeps its last message day and the one before it. With `at`,
    // a send from just before midnight can get here after a next-day send of
    // either person: the stamp never rewinds, and the late day is kept as
    // the side's previous day instead, so it can still be credited below.
    const stamp = (last: string | null, prev: string | null): [string, string | null] => {
      if (last === null || last < today) return [today, last];
      if (last === today) return [last, prev];
      return [last, prev !== null && prev > today ? prev : today];
    };
    if (authorIsA) [lastDayA, prevDayA] = stamp(lastDayA, prevDayA);
    else [lastDayB, prevDayB] = stamp(lastDayB, prevDayB);
    const messagedToday = (isAuthor: boolean, last: string | null, prev: string | null) =>
      isAuthor || last === today || prev === today;

    // Credit today once both sides have messaged on it — either side's
    // evidence may be its previous day, when a next-day send already moved
    // its stamp on. Never a day before the last credited one: the chain
    // only grows forward.
    if (
      messagedToday(authorIsA, lastDayA, prevDayA) &&
      messagedToday(!authorIsA, lastDayB, prevDayB) &&
      (lastCountedDay === null || lastCountedDay < today)
    ) {
      if (lastCountedDay === prevUtcDay(today)) {
        streak = Math.min(streak + 1, CAP);
      } else {
        streak = 1; // chain broken (or first ever day) — restart
      }
      lastCountedDay = today;
      bestStreak = Math.max(bestStreak, streak);
    }

    await tx
      .insert(schema.dmStreaks)
      .values({
        channelId: args.channelId,
        userAId: a,
        userBId: b,
        lastDayA,
        lastDayB,
        prevDayA,
        prevDayB,
        lastCountedDay,
        streak,
        bestStreak,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.dmStreaks.channelId,
        set: {
          lastDayA,
          lastDayB,
          prevDayA,
          prevDayB,
          lastCountedDay,
          streak,
          bestStreak,
          updatedAt: new Date(),
        },
      });

    // `streak` is the live display value (the chain is alive — someone just
    // messaged today). `changed` is true only when the credited count moved,
    // so the caller dispatches at most once per day per channel.
    return { streak, changed: streak !== prevStreak };
  });
}

/**
 * Display streak for a set of DM channels: the stored value while the
 * chain is alive (credited today or yesterday), else 0.
 */
export async function streaksForChannels(channelIds: bigint[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (channelIds.length === 0) return out;
  const { inArray } = await import('drizzle-orm');
  const rows = await db
    .select()
    .from(schema.dmStreaks)
    .where(inArray(schema.dmStreaks.channelId, channelIds));
  const today = utcDay();
  const yesterday = prevUtcDay(today);
  for (const r of rows) {
    const alive = r.lastCountedDay === today || r.lastCountedDay === yesterday;
    out.set(r.channelId.toString(), alive ? Math.min(r.streak, CAP) : 0);
  }
  return out;
}

/** Longest live-or-historical streak the user has ever held (achievements). */
export async function bestStreakForUser(userId: bigint): Promise<number> {
  const { or, eq: eqOp } = await import('drizzle-orm');
  const rows = await db
    .select({ best: schema.dmStreaks.bestStreak })
    .from(schema.dmStreaks)
    .where(or(eqOp(schema.dmStreaks.userAId, userId), eqOp(schema.dmStreaks.userBId, userId)));
  return rows.reduce((m, r) => Math.max(m, r.best), 0);
}

/**
 * Warn DMs whose streak is about to reset. A streak resets at the next UTC
 * midnight once it isn't credited "today" (see streaksForChannels: alive iff
 * lastCountedDay is today-or-yesterday). So ~6h before that — when the caller
 * runs this at/after 18:00 UTC — post a ONE-TIME notice into every DM whose
 * streak is alive but credited only YESTERDAY (i.e. not refreshed today).
 *
 * Multi-replica + repeat safe: the claim is a single atomic UPDATE that stamps
 * `streak_warned_for_day = today` AND excludes rows already stamped for today,
 * so only the instance whose UPDATE actually flips a row gets it back. The
 * watermark self-resets the next UTC day. Per-row posting is best-effort.
 * Returns the number of warnings sent.
 */
export async function sweepStreakWarnings(): Promise<number> {
  const today = utcDay();
  const yesterday = prevUtcDay(today);

  const claimed = await db
    .update(schema.dmStreaks)
    .set({ streakWarnedForDay: today })
    .where(
      and(
        gt(schema.dmStreaks.streak, 0),
        eq(schema.dmStreaks.lastCountedDay, yesterday),
        sql`${schema.dmStreaks.streakWarnedForDay} IS DISTINCT FROM ${today}`,
      ),
    )
    .returning({
      channelId: schema.dmStreaks.channelId,
      userAId: schema.dmStreaks.userAId,
      userBId: schema.dmStreaks.userBId,
      streak: schema.dmStreaks.streak,
    });

  let sent = 0;
  for (const row of claimed) {
    try {
      // Time-to-reset is (next UTC midnight − now), so derive it instead of a
      // fixed "6 hours" — the sweep can run anywhere in the window, and the
      // operator can retune STREAK_WARN_HOURS_BEFORE.
      const hoursLeft = Math.max(1, 24 - new Date().getUTCHours());
      const content =
        `🔥 Your ${row.streak}-day streak ends in about ${hoursLeft} ` +
        `hour${hoursLeft === 1 ? '' : 's'} — send a message to keep it alive!`;
      // type 'default' + a metadata marker the clients render as a quiet notice
      // (no message_type enum migration). Authored by one participant to satisfy
      // the author FK; clients render it from the metadata, not as that user's
      // bubble.
      const inserted = await createSystemMessage({
        channelId: row.channelId,
        guildId: null,
        authorId: row.userAId,
        content,
        type: 'default',
        mentionedUserIds: [],
        metadata: { kind: 'streak_warning', streak: row.streak },
      });
      // Make it the channel's newest message so the DM marks unread + sorts up
      // (the whole point of the warning is to draw the user back in).
      await db
        .update(schema.channels)
        .set({
          lastMessageId: sql`GREATEST(COALESCE(${schema.channels.lastMessageId}, 0), ${inserted.id})`,
        })
        .where(eq(schema.channels.id, row.channelId));
      const [author] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, row.userAId))
        .limit(1);
      const messageDTO = toMessage({
        message: inserted,
        author: author ?? null,
        attachments: [],
        reactions: [],
        mentionedUserIds: [],
        mentionedRoleIds: [],
        poll: null,
        sticker: null,
        forwardedFrom: null,
        selfId: row.userAId,
      });
      dispatch.messageCreate({ messageDTO, channelId: row.channelId, guildId: null });
      // The warning is userA's row (the FK author) but leaves userA's read
      // marker where it is, and their clients move their local marker to it
      // on this echo all the same (their own message). With a timed message
      // from userB still waiting above the marker, the DM then reads as read
      // on those devices, their next open acks nothing and it never
      // disappears — so send the stored marker back, after the echo (one
      // bus). Best-effort, like the push.
      await notifyHeldReadMarkerIfWaiting({
        userId: row.userAId,
        channelId: row.channelId,
        belowId: inserted.id,
      });

      // Push BOTH participants so the warning reaches a fully-closed app — the
      // in-chat message + unread only nudges someone who reopens. Unlike a
      // normal message we DON'T exclude the author: the streak needs both to
      // message, this is a system notice (not "from" anyone), and pushing the
      // author also covers the case where their own client self-clears the
      // unread. Each recipient still honors their own mute level. Best-effort.
      await pushStreakWarning(row.channelId, [row.userAId, row.userBId], content);
      sent++;
    } catch (err) {
      log.warn?.('streak warning failed', {
        channelId: row.channelId.toString(),
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return sent;
}

/**
 * Push a streak-expiry warning to the given DM participants (out-of-app
 * signal). Mirrors the DM push fan-out in routes/messages.ts — mute level via
 * resolveLevelsBulk ('nothing' = skip), app-icon badge via unreadBadgeCounts —
 * but as a system notice (custom title/body, not "from" the FK author) and
 * without excluding anyone. Dynamic imports avoid a service import cycle
 * (matching the route's `await import('./notifications')`). Best-effort.
 */
async function pushStreakWarning(
  channelId: bigint,
  recipients: bigint[],
  body: string,
): Promise<void> {
  try {
    const { resolveLevelsBulk } = await import('./notifications');
    const { sendToUser } = await import('./push');
    const levels = await resolveLevelsBulk(recipients, channelId, null);
    const allowed = recipients.filter(
      (id) => (levels.get(id.toString()) ?? 'all') !== 'nothing',
    );
    if (allowed.length === 0) return;
    const badges = await unreadBadgeCounts(allowed);
    const url = `/channels/@me/${channelId.toString()}`;
    await Promise.all(
      allowed.map((id) =>
        sendToUser(id, {
          // kind:'message' gives it the Reply action — replying refreshes the
          // streak. The body already carries the 🔥 + details.
          title: 'Streak about to expire',
          body,
          url,
          tag: channelId.toString(),
          kind: 'message',
          badge: badges.get(id.toString()) ?? 0,
          data: { channelId: channelId.toString(), isE2EE: false },
        }),
      ),
    );
  } catch (err) {
    log.warn?.('streak warning push failed', {
      channelId: channelId.toString(),
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
