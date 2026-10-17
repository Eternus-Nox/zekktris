/**
 * Message search
 * --------------
 * Full-text search over guild messages, scoped to the channels whose
 * history the requesting user can actually read. Uses Postgres `websearch_to_tsquery`
 * (natural query syntax: quoted "phrases", OR, and -exclusion) against the
 * GIN-indexed English text-search vector of message content.
 */
import { db, schema } from '../db';
import { and, eq, desc, lt, gt, inArray, isNull, sql } from 'drizzle-orm';
import { Permissions, listViewableGuildChannelIds } from './permissions';

export interface SearchMessagesOptions {
  query: string;
  /** Restrict to a single channel (must be viewable). */
  channelId?: bigint;
  /** Restrict to a single author. */
  authorId?: bigint;
  /** Keyset pagination: messages with id < before (older results). */
  before?: bigint;
  /** Lower bound: messages with id > after (newer than a date cutoff). */
  after?: bigint;
  limit?: number;
}

export interface SearchResultRow {
  message: schema.Message;
  author: schema.User | null;
}

export async function searchGuildMessages(
  guildId: bigint,
  userId: bigint,
  opts: SearchMessagesOptions,
): Promise<SearchResultRow[]> {
  // Only ever search channels whose history the requester can read
  // (VIEW_CHANNEL + READ_MESSAGE_HISTORY, the same gate as per-channel
  // search and message listing) — this is the permission boundary for
  // search. An empty set means nothing to search.
  const viewable = await listViewableGuildChannelIds(guildId, userId, {
    alsoRequire: Permissions.READ_MESSAGE_HISTORY,
  });
  if (viewable.length === 0) return [];

  let channelScope = viewable;
  if (opts.channelId != null) {
    if (!viewable.some((id) => id === opts.channelId)) return [];
    channelScope = [opts.channelId];
  }

  const limit = Math.max(1, Math.min(50, opts.limit ?? 25));
  const conds = [
    inArray(schema.messages.channelId, channelScope),
    isNull(schema.messages.deletedAt),
    // Full-text match. Parameterized — websearch_to_tsquery safely parses
    // arbitrary user input (won't throw on stray operators the way
    // to_tsquery does).
    sql`to_tsvector('english', ${schema.messages.content}) @@ websearch_to_tsquery('english', ${opts.query})`,
  ];
  if (opts.authorId != null) conds.push(eq(schema.messages.authorId, opts.authorId));
  if (opts.before != null) conds.push(lt(schema.messages.id, opts.before));
  if (opts.after != null) conds.push(gt(schema.messages.id, opts.after));

  const rows = await db
    .select({ message: schema.messages, author: schema.users })
    .from(schema.messages)
    .leftJoin(schema.users, eq(schema.users.id, schema.messages.authorId))
    .where(and(...conds))
    .orderBy(desc(schema.messages.id))
    .limit(limit);

  return rows.map((r) => ({ message: r.message, author: r.author }));
}
