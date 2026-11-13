/**
 * Polls service
 * -------------
 * Polls attach 1:1 to a message. The message is created normally (with
 * empty content allowed when a poll is present), then a `polls` row +
 * `poll_options` rows are inserted in the same transaction. Vote
 * mutations go through dedicated routes; the gateway broadcasts a
 * MESSAGE_UPDATE on every vote so connected clients see live tallies.
 *
 * Lifecycle:
 *   - createPoll: caller needs SEND_MESSAGES on the channel (same gate
 *     as posting any message).
 *   - vote / removeVote: any guild member with VIEW_CHANNEL +
 *     SEND_MESSAGES — voting is a "writing" action so we keep it
 *     parallel to message-send permissions. Refused if the poll has
 *     already closed (closedAt set or expiresAt in the past).
 *   - endPoll: the poll's author (message authorId) OR anyone with
 *     MANAGE_MESSAGES on the channel can close early.
 *
 * The "current tally" view is computed on demand: SELECT option_id,
 * COUNT(*) FROM poll_votes GROUP BY option_id. With a few hundred
 * votes this is microseconds; for popular polls (10k+ votes) we'd
 * want to cache, but that's a future problem.
 */

import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { computeMemberChannelPermissions, Permissions, hasPermission } from './permissions';

const MAX_QUESTION_LEN = 300;
const MAX_OPTION_LEN = 80;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_DURATION_HOURS = 24 * 7; // 7 days, matches Discord's cap
const MIN_DURATION_HOURS = 1;

// ── Public API ─────────────────────────────────────────────────────────────

export interface CreatePollInput {
  /** The just-inserted message id this poll attaches to. */
  messageId: bigint;
  question: string;
  /** 2–10 option labels. */
  options: string[];
  multipleChoice?: boolean;
  /** Hours until the poll closes. Server clamps to [1, 168]. NULL is
      not currently exposed via the route; all polls have a finite end
      so they don't accumulate indefinitely. */
  durationHours: number;
}

export interface CreatedPoll {
  poll: schema.Poll;
  options: schema.PollOption[];
}

export async function createPoll(input: CreatePollInput): Promise<CreatedPoll> {
  const question = input.question.trim();
  if (question.length === 0 || question.length > MAX_QUESTION_LEN) {
    throw errors.badRequest(`Poll question must be 1-${MAX_QUESTION_LEN} chars`);
  }
  if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
    throw errors.badRequest(`Poll must have ${MIN_OPTIONS}-${MAX_OPTIONS} options`);
  }
  const cleanOptions = input.options.map((o) => o.trim());
  for (const o of cleanOptions) {
    if (o.length === 0 || o.length > MAX_OPTION_LEN) {
      throw errors.badRequest(`Each option must be 1-${MAX_OPTION_LEN} chars`);
    }
  }
  if (new Set(cleanOptions).size !== cleanOptions.length) {
    throw errors.badRequest('Poll options must be unique');
  }
  const hours = Math.max(MIN_DURATION_HOURS, Math.min(MAX_DURATION_HOURS, input.durationHours));
  const expiresAt = new Date(Date.now() + hours * 3600_000);

  const pollId = nextSnowflake();

  const result = await db.transaction(async (tx) => {
    const [pollRow] = await tx
      .insert(schema.polls)
      .values({
        id: pollId,
        messageId: input.messageId,
        question,
        multipleChoice: input.multipleChoice ?? false,
        expiresAt,
      })
      .returning();
    if (!pollRow) throw errors.internal('Poll insert returned no row');

    const optionRows = await tx
      .insert(schema.pollOptions)
      .values(
        cleanOptions.map((text, i) => ({
          id: nextSnowflake(),
          pollId,
          text,
          position: i,
        })),
      )
      .returning();

    return { poll: pollRow, options: optionRows };
  });

  return result;
}

// ── Read ───────────────────────────────────────────────────────────────────

export interface PollWithCounts {
  poll: schema.Poll;
  options: Array<schema.PollOption & { voteCount: number }>;
  /** Total distinct voters. Same as the sum of option voteCount in
      single-choice polls; lower or equal in multiple-choice polls. */
  totalVoters: number;
  /** Option ids the calling user has voted for. Empty array if anon. */
  myVotes: bigint[];
}

/** Load polls for a batch of message ids. Returns a map keyed by messageId. */
export async function loadPollsForMessages(
  messageIds: bigint[],
  selfId: bigint | null,
): Promise<Map<bigint, PollWithCounts>> {
  const out = new Map<bigint, PollWithCounts>();
  if (messageIds.length === 0) return out;

  const polls = await db
    .select()
    .from(schema.polls)
    .where(inArray(schema.polls.messageId, messageIds));
  if (polls.length === 0) return out;

  const pollIds = polls.map((p) => p.id);

  // The four follow-up queries are mutually independent — none reads
  // the result of another. Running them sequentially was paying 4
  // round-trips when one parallel batch suffices. Hot path: this runs
  // on every message hydration that includes polls (channel list,
  // pin panel, search, every poll-vote MESSAGE_UPDATE broadcast).
  const [options, tallies, voterCounts, myVoteRows] = await Promise.all([
    db
      .select()
      .from(schema.pollOptions)
      .where(inArray(schema.pollOptions.pollId, pollIds))
      .orderBy(schema.pollOptions.position),
    // Tallies: one query, grouped.
    db
      .select({
        pollId: schema.pollVotes.pollId,
        optionId: schema.pollVotes.optionId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(schema.pollVotes)
      .where(inArray(schema.pollVotes.pollId, pollIds))
      .groupBy(schema.pollVotes.pollId, schema.pollVotes.optionId),
    // Distinct-voter counts per poll. SUM of option counts overcounts
    // multipleChoice polls (a voter who picks 2 options would be counted
    // twice), so we use COUNT DISTINCT user_id grouped by poll_id.
    db
      .select({
        pollId: schema.pollVotes.pollId,
        voters: sql<number>`COUNT(DISTINCT ${schema.pollVotes.userId})::int`,
      })
      .from(schema.pollVotes)
      .where(inArray(schema.pollVotes.pollId, pollIds))
      .groupBy(schema.pollVotes.pollId),
    // The caller's own votes — only fetched when selfId is present
    // (the gateway dispatch path passes null for system-context
    // broadcasts; the REST DTO path passes the requester's id).
    selfId !== null
      ? db
          .select()
          .from(schema.pollVotes)
          .where(
            and(
              eq(schema.pollVotes.userId, selfId),
              inArray(schema.pollVotes.pollId, pollIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const myVotesByPoll = new Map<bigint, bigint[]>();
  for (const r of myVoteRows) {
    const list = myVotesByPoll.get(r.pollId) ?? [];
    list.push(r.optionId);
    myVotesByPoll.set(r.pollId, list);
  }

  // Index tallies for fast lookup.
  const tallyByOption = new Map<string, number>();
  for (const t of tallies) {
    tallyByOption.set(`${t.pollId}/${t.optionId}`, t.count);
  }
  const voterCountByPoll = new Map<bigint, number>();
  for (const v of voterCounts) voterCountByPoll.set(v.pollId, v.voters);

  // Bucket options per poll.
  const optionsByPoll = new Map<bigint, schema.PollOption[]>();
  for (const o of options) {
    const list = optionsByPoll.get(o.pollId) ?? [];
    list.push(o);
    optionsByPoll.set(o.pollId, list);
  }

  for (const p of polls) {
    const opts = optionsByPoll.get(p.id) ?? [];
    out.set(p.messageId, {
      poll: p,
      options: opts.map((o) => ({
        ...o,
        voteCount: tallyByOption.get(`${p.id}/${o.id}`) ?? 0,
      })),
      totalVoters: voterCountByPoll.get(p.id) ?? 0,
      myVotes: myVotesByPoll.get(p.id) ?? [],
    });
  }
  return out;
}

// ── Vote / unvote ──────────────────────────────────────────────────────────

export interface VoteInput {
  pollId: bigint;
  optionId: bigint;
  userId: bigint;
}

/**
 * Cast a vote. For single-choice polls, this clears any prior vote by
 * the same user on this poll first. For multipleChoice polls, it's an
 * idempotent INSERT — re-voting the same option is a no-op (the
 * composite PK collides, we swallow the conflict).
 *
 * Returns the channelId so the caller can broadcast a MESSAGE_UPDATE
 * with refreshed tallies, and the poll's author (its message's), whose
 * achievements a vote can move.
 */
export async function vote(
  input: VoteInput,
): Promise<{ channelId: bigint; messageId: bigint; authorId: bigint | null }> {
  return db.transaction(async (tx) => {
    // Serialize concurrent votes by the SAME user on the SAME poll. Without
    // this, a single-choice poll's clear-then-insert races under READ
    // COMMITTED: two near-simultaneous votes for different options both run
    // the DELETE (each sees no committed row, deletes nothing) then INSERT
    // different (poll,option,user) PKs — leaving TWO votes from one user and
    // corrupting the tallies. A transaction-scoped advisory lock keyed on
    // (poll,user) makes the second vote wait until the first commits, so its
    // DELETE then sees the committed row. Cheap: it's per-(poll,user), not
    // a table lock, and released automatically at commit/rollback.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.pollId.toString() + ':' + input.userId.toString()}, 0))`,
    );
    // Load the poll + verify the option belongs to it. A single query
    // because Postgres can join.
    const rows = await tx
      .select({
        poll: schema.polls,
        message: schema.messages,
        option: schema.pollOptions,
      })
      .from(schema.polls)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.polls.messageId))
      .innerJoin(schema.pollOptions, eq(schema.pollOptions.id, input.optionId))
      .where(and(
        eq(schema.polls.id, input.pollId),
        eq(schema.pollOptions.pollId, input.pollId),
        // Reject votes on polls whose parent message was deleted.
        // The poll row isn't cascade-deleted on soft-delete (FK
        // cascades only on hard-delete), so without this filter a
        // client with a cached pollId can keep voting on a poll
        // that's no longer rendered anywhere. Clients normally
        // don't show the poll once the message is gone, but the
        // server state should match: deleted message = inactive poll.
        isNull(schema.messages.deletedAt),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) throw errors.notFound('Poll option');

    if (row.poll.closedAt) throw errors.badRequest('Poll is closed');
    if (row.poll.expiresAt && row.poll.expiresAt.getTime() <= Date.now()) {
      throw errors.badRequest('Poll has expired');
    }

    // Permission gate — voter needs SEND_MESSAGES on the channel. We
    // don't separately gate VIEW_CHANNEL because SEND_MESSAGES requires
    // VIEW_CHANNEL to be useful; the channel-permission resolver
    // returns 0 for any user who can't see the channel anyway.
    //
    // For DM channels, the permission resolver returns broad
    // permissions UNCONDITIONALLY (it doesn't check dm_recipients
    // membership) — the contract puts that check on the caller.
    // We do it here so a stranger with a leaked pollId can't vote
    // in a DM they're not part of.
    const channelRow = await tx
      .select({ guildId: schema.channels.guildId })
      .from(schema.channels)
      .where(eq(schema.channels.id, row.message.channelId))
      .limit(1);
    const isDm = channelRow[0] && channelRow[0].guildId === null;
    if (isDm) {
      const rec = await tx
        .select({ userId: schema.dmRecipients.userId })
        .from(schema.dmRecipients)
        .where(
          and(
            eq(schema.dmRecipients.channelId, row.message.channelId),
            eq(schema.dmRecipients.userId, input.userId),
          ),
        )
        .limit(1);
      if (!rec[0]) throw errors.notFound('Poll option');
    }
    const perms = await computeMemberChannelPermissions(row.message.channelId, input.userId);
    if (!hasPermission(perms, Permissions.SEND_MESSAGES)) {
      throw errors.missingPermissions(['SEND_MESSAGES']);
    }

    if (!row.poll.multipleChoice) {
      // Single-choice: clear any prior vote on this poll by this user.
      await tx
        .delete(schema.pollVotes)
        .where(and(eq(schema.pollVotes.pollId, input.pollId), eq(schema.pollVotes.userId, input.userId)));
    }

    // Insert. ON CONFLICT DO NOTHING so re-voting the same option in
    // multipleChoice mode is a no-op (idempotent), not an error.
    await tx
      .insert(schema.pollVotes)
      .values({
        pollId: input.pollId,
        optionId: input.optionId,
        userId: input.userId,
      })
      .onConflictDoNothing();

    return { channelId: row.message.channelId, messageId: row.message.id, authorId: row.message.authorId };
  });
}

/** Remove a single vote. No-op if the row doesn't exist. */
export async function removeVote(input: VoteInput): Promise<{ channelId: bigint; messageId: bigint }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ message: schema.messages })
      .from(schema.polls)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.polls.messageId))
      .where(and(
        eq(schema.polls.id, input.pollId),
        // Same deleted-message filter as vote() — see comment there.
        isNull(schema.messages.deletedAt),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) throw errors.notFound('Poll');

    await tx
      .delete(schema.pollVotes)
      .where(
        and(
          eq(schema.pollVotes.pollId, input.pollId),
          eq(schema.pollVotes.optionId, input.optionId),
          eq(schema.pollVotes.userId, input.userId),
        ),
      );
    return { channelId: row.message.channelId, messageId: row.message.id };
  });
}

/** End a poll early. Caller must be the message author or have MANAGE_MESSAGES. */
export async function endPoll(
  pollId: bigint,
  actorId: bigint,
): Promise<{ channelId: bigint; messageId: bigint }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ poll: schema.polls, message: schema.messages })
      .from(schema.polls)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.polls.messageId))
      .where(and(
        eq(schema.polls.id, pollId),
        // Same deleted-message filter as vote() — see comment there.
        isNull(schema.messages.deletedAt),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) throw errors.notFound('Poll');
    if (row.poll.closedAt) {
      // Already closed — return the original close timestamp without
      // bumping it. Idempotent close calls are a quality-of-life win
      // for clients that may double-fire end-poll on rapid taps.
      return { channelId: row.message.channelId, messageId: row.message.id };
    }

    // DM recipient check — computeMemberChannelPermissions returns
    // broad perms for DM channels regardless of recipient status,
    // so a stranger with the pollId would otherwise pass the
    // MANAGE_MESSAGES gate below. See the vote() comment for the
    // full rationale.
    const channelRow = await tx
      .select({ guildId: schema.channels.guildId })
      .from(schema.channels)
      .where(eq(schema.channels.id, row.message.channelId))
      .limit(1);
    const isDm = channelRow[0] && channelRow[0].guildId === null;
    if (isDm) {
      const rec = await tx
        .select({ userId: schema.dmRecipients.userId })
        .from(schema.dmRecipients)
        .where(
          and(
            eq(schema.dmRecipients.channelId, row.message.channelId),
            eq(schema.dmRecipients.userId, actorId),
          ),
        )
        .limit(1);
      if (!rec[0]) throw errors.notFound('Poll');
    }

    const isAuthor = row.message.authorId === actorId;
    if (!isAuthor) {
      const perms = await computeMemberChannelPermissions(row.message.channelId, actorId);
      if (!hasPermission(perms, Permissions.MANAGE_MESSAGES)) {
        throw errors.missingPermissions(['MANAGE_MESSAGES']);
      }
    }

    await tx
      .update(schema.polls)
      .set({ closedAt: new Date() })
      .where(eq(schema.polls.id, pollId));
    return { channelId: row.message.channelId, messageId: row.message.id };
  });
}

/**
 * Periodic sweep: auto-close polls whose `expires_at` has passed.
 *
 * Single bulk UPDATE bounded by the partial polls_active_expiring_idx
 * (which only indexes open polls with a non-null expires_at), so a
 * server with thousands of historical closed polls pays no per-tick
 * scan cost — most ticks find zero rows.
 *
 * Returns the affected rows joined with their parent message rows so
 * the caller (scheduler in apps/api/src/index.ts) can dispatch a
 * messageUpdate broadcast per affected message — connected clients
 * see the poll flip to "Final results" without needing to re-fetch.
 *
 * We don't dispatch from the service itself — keeps polls.ts free of
 * gateway-layer coupling and lets the scheduler decide if/how to
 * broadcast (e.g. it could throttle or batch on busy servers).
 *
 * Vote-attempt rejection on expired polls is already handled by
 * vote(); this sweep is about data hygiene (and the broadcast it
 * triggers) rather than enforcement.
 */
export async function runPollExpirySweep(): Promise<
  Array<{ pollId: bigint; channelId: bigint; messageId: bigint }>
> {
  const now = new Date();
  // Bulk UPDATE returning all the columns we need to compose
  // broadcast targets. Joining the messages table via the FK is
  // efficient because the polls→messages relationship is 1:1 via
  // message_id and indexed by the messages PK.
  const updated = await db
    .update(schema.polls)
    .set({ closedAt: now })
    .where(
      and(
        isNull(schema.polls.closedAt),
        sql`${schema.polls.expiresAt} IS NOT NULL`,
        lte(schema.polls.expiresAt, now),
      ),
    )
    .returning({
      pollId: schema.polls.id,
      messageId: schema.polls.messageId,
    });

  if (updated.length === 0) return [];

  // Resolve channel ids for the affected messages. Single IN-clause
  // SELECT — N round-trip avoided.
  const messageIds = updated.map((u) => u.messageId);
  const messageRows = await db
    .select({
      id: schema.messages.id,
      channelId: schema.messages.channelId,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .where(inArray(schema.messages.id, messageIds));
  const messageChannelById = new Map(
    messageRows.map((m) => [m.id, { channelId: m.channelId, deletedAt: m.deletedAt }]),
  );

  // Filter out polls whose parent message has been soft-deleted —
  // we still flipped the closed_at column (cheap, consistent with
  // hard-cascade) but skipping the broadcast saves wire traffic for
  // a message no client is rendering.
  const out: Array<{ pollId: bigint; channelId: bigint; messageId: bigint }> = [];
  for (const u of updated) {
    const m = messageChannelById.get(u.messageId);
    if (!m || m.deletedAt) continue;
    out.push({ pollId: u.pollId, channelId: m.channelId, messageId: u.messageId });
  }
  return out;
}
