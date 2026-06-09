/**
 * Reports service
 * ---------------
 * Create + manage the per-guild moderation queue. Filing is open to any
 * member; listing and resolving is gated (in the route) to moderators.
 */
import { db, schema } from '../db';
import { and, eq, desc, lt, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';

export type ReportReason = 'spam' | 'harassment' | 'nsfw' | 'violence' | 'other';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export interface CreateReportInput {
  guildId: bigint;
  reporterId: bigint;
  targetType: 'message' | 'user';
  /** Reported user, or the author of the reported message. */
  targetUserId: bigint | null;
  messageId?: bigint | null;
  channelId?: bigint | null;
  messageContent?: string | null;
  reason: ReportReason;
  details?: string | null;
}

/**
 * File a report. Deduped: an existing OPEN report by the same reporter
 * against the same target is returned as-is rather than creating a new row,
 * so spamming the report button doesn't flood the queue.
 */
export async function createReport(input: CreateReportInput) {
  const dupConds = [
    eq(schema.reports.guildId, input.guildId),
    eq(schema.reports.reporterId, input.reporterId),
    eq(schema.reports.status, 'open'),
    eq(schema.reports.targetType, input.targetType),
  ];
  if (input.targetType === 'message' && input.messageId != null) {
    dupConds.push(eq(schema.reports.messageId, input.messageId));
  } else if (input.targetType === 'user' && input.targetUserId != null) {
    // A user-report has no messageId — distinguish it from message-reports
    // about that same user so the two don't collapse together.
    dupConds.push(eq(schema.reports.targetUserId, input.targetUserId));
    dupConds.push(isNull(schema.reports.messageId));
  }
  const [dup] = await db
    .select()
    .from(schema.reports)
    .where(and(...dupConds))
    .limit(1);
  if (dup) return dup;

  const [row] = await db
    .insert(schema.reports)
    .values({
      id: nextSnowflake(),
      guildId: input.guildId,
      reporterId: input.reporterId,
      targetType: input.targetType,
      targetUserId: input.targetUserId,
      messageId: input.messageId ?? null,
      channelId: input.channelId ?? null,
      messageContent: input.messageContent ?? null,
      reason: input.reason,
      details: input.details ?? null,
    })
    .returning();
  if (!row) throw errors.internal('Report creation failed');
  return row;
}

export interface ListReportsOptions {
  status?: ReportStatus | 'all';
  /** Filter to message-reports or user-reports. Omit for both. */
  targetType?: 'message' | 'user';
  before?: bigint;
  limit?: number;
}

export interface ReportRow {
  report: schema.Report;
  reporter: schema.User | null;
  target: schema.User | null;
}

export async function listReports(
  guildId: bigint,
  opts: ListReportsOptions = {},
): Promise<ReportRow[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const conds = [eq(schema.reports.guildId, guildId)];
  if (opts.status && opts.status !== 'all') {
    conds.push(eq(schema.reports.status, opts.status));
  }
  if (opts.targetType !== undefined) {
    conds.push(eq(schema.reports.targetType, opts.targetType));
  }
  if (opts.before !== undefined) {
    conds.push(lt(schema.reports.id, opts.before));
  }
  // Two joins back to users (reporter + reported), so alias both.
  const reporter = alias(schema.users, 'report_reporter');
  const target = alias(schema.users, 'report_target');
  const rows = await db
    .select({ report: schema.reports, reporter, target })
    .from(schema.reports)
    .leftJoin(reporter, eq(reporter.id, schema.reports.reporterId))
    .leftJoin(target, eq(target.id, schema.reports.targetUserId))
    .where(and(...conds))
    .orderBy(desc(schema.reports.id))
    .limit(limit);
  return rows.map((r) => ({ report: r.report, reporter: r.reporter, target: r.target }));
}

export async function countOpenReports(guildId: bigint): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(schema.reports)
    .where(and(eq(schema.reports.guildId, guildId), eq(schema.reports.status, 'open')));
  return Number(r?.c ?? 0);
}

/** Resolve or dismiss a report. Returns the updated row (throws if the
 *  report doesn't belong to this guild / doesn't exist). */
export async function handleReport(
  guildId: bigint,
  reportId: bigint,
  handlerId: bigint,
  action: 'resolve' | 'dismiss',
  note?: string | null,
): Promise<schema.Report> {
  const status: ReportStatus = action === 'resolve' ? 'resolved' : 'dismissed';
  const [row] = await db
    .update(schema.reports)
    .set({
      status,
      handledById: handlerId,
      handledAt: new Date(),
      resolutionNote: note ?? null,
    })
    .where(and(eq(schema.reports.guildId, guildId), eq(schema.reports.id, reportId)))
    .returning();
  if (!row) throw errors.notFound('Report');
  return row;
}
