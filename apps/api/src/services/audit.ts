/**
 * Audit log
 * ---------
 * Writes one row to audit_log_entries per moderator-relevant action. Routes
 * import this and call it once per mutation. The set of `action` strings is
 * a string enum-by-convention, not a Postgres enum, so adding new actions
 * doesn't require a schema migration.
 *
 * Convention for action names: lower.dot.case noun.verb pairs:
 *   guild.update, channel.create, channel.delete, role.update,
 *   member.kick, member.role_add, member.role_remove,
 *   ban.add, ban.remove, invite.create, invite.delete
 */

import type { Database } from '@zekktris/db';
import { and, desc, eq, like, lt } from 'drizzle-orm';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';

type AuditTarget = 'guild' | 'channel' | 'role' | 'member' | 'message' | 'invite' | 'webhook' | 'emoji' | 'sticker' | 'automod_rule' | 'scheduled_event';

/**
 * Either the top-level db client or a transaction handle. The two have
 * compatible insert/select/update APIs but `Database` carries an extra
 * `$client` property from the postgres-js driver. Omit it so a transaction
 * handle (which doesn't have $client) is assignable here.
 */
type DbHandle = Omit<Database, '$client'>;

export interface WriteAuditInput {
  guildId: bigint;
  /** Null only when an action is system-driven (e.g. invite expiry). */
  actorId: bigint | null;
  action: string;
  targetType: AuditTarget;
  /** Snowflake of the affected entity, if applicable. */
  targetId?: bigint | null;
  /** Optional structured before/after diff. JSON-serialized as-is. */
  changes?: Record<string, unknown>;
  reason?: string | null;
  /** Optional drizzle transaction handle. Pass when calling inside a tx. */
  tx?: DbHandle;
}

/**
 * Make a `changes` payload safe for the jsonb column. The postgres driver
 * JSON.stringifies jsonb values at insert time, and JSON.stringify THROWS on
 * BigInt ("Do not know how to serialize a BigInt"). Callers routinely pass
 * snowflake ids as bigints (e.g. a guild patch with afkChannelId), so without
 * this the whole mutation 500s. We deep-convert BigInt → string and leave
 * everything else untouched.
 */
function toJsonSafe(changes: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(changes, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}

export async function writeAudit(input: WriteAuditInput): Promise<void> {
  const target = input.tx ?? db;
  await target.insert(schema.auditLogEntries).values({
    id: nextSnowflake(),
    guildId: input.guildId,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    changes: input.changes == null ? null : toJsonSafe(input.changes),
    reason: input.reason ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// List / pagination
// ─────────────────────────────────────────────────────────────────────────

/**
 * Audit log entry joined with the actor user row (when present). The
 * actor is LEFT-joined: when a moderator is deleted, the
 * auditLogEntries.actorId is SET NULL but the row itself survives,
 * so we still want to surface the entry — the client renders
 * "Unknown moderator" instead of dropping the row.
 */
export interface AuditEntryWithActor {
  entry: schema.AuditLogEntry;
  actor: schema.User | null;
}

export interface ListAuditOptions {
  /** Return entries with id < this cursor (older). For pagination. */
  before?: bigint;
  /** Cap on rows returned. Clamped to [1, 100]. */
  limit?: number;
  /** Optional action-prefix filter ("member.", "automod.", etc).
   *  Server-side filter using LIKE for index-friendliness. */
  actionPrefix?: string;
}

export async function listAuditEntries(
  guildId: bigint,
  opts: ListAuditOptions = {},
): Promise<AuditEntryWithActor[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));

  // Build the WHERE clause incrementally — drizzle's `and()` with
  // possibly-undefined entries doesn't compose cleanly, so we
  // collect the conditions and pass them all in one call.
  const conds: ReturnType<typeof eq>[] = [eq(schema.auditLogEntries.guildId, guildId)];
  if (opts.before !== undefined) {
    conds.push(lt(schema.auditLogEntries.id, opts.before));
  }
  if (opts.actionPrefix !== undefined && opts.actionPrefix.length > 0) {
    // LIKE 'prefix%' is index-friendly when there's a btree on `action`.
    // We don't currently have that index — could add one later if
    // filter-by-action becomes a common UX. For now the planner falls
    // back to the (guild_id, created_at) index and filters in-memory,
    // which is fine for the row counts an audit log accumulates.
    conds.push(like(schema.auditLogEntries.action, `${opts.actionPrefix}%`));
  }

  const rows = await db
    .select({
      entry: schema.auditLogEntries,
      actor: schema.users,
    })
    .from(schema.auditLogEntries)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLogEntries.actorId))
    .where(and(...conds))
    .orderBy(desc(schema.auditLogEntries.id))
    .limit(limit);

  return rows.map((r) => ({ entry: r.entry, actor: r.actor }));
}

/**
 * Fetch a guild's full audit log for download, oldest-first (chronological,
 * the natural order for a log file). Capped at `max` rows so an enormous
 * history can't blow up memory — the cap defaults high enough that almost
 * every real guild exports completely. The route surfaces the cap as a
 * "truncated" flag when it's hit so the operator knows to narrow the range.
 */
export async function listAuditEntriesForExport(
  guildId: bigint,
  max = 10_000,
): Promise<AuditEntryWithActor[]> {
  const limit = Math.max(1, Math.min(50_000, max));
  const rows = await db
    .select({ entry: schema.auditLogEntries, actor: schema.users })
    .from(schema.auditLogEntries)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLogEntries.actorId))
    .where(eq(schema.auditLogEntries.guildId, guildId))
    .orderBy(schema.auditLogEntries.id)
    .limit(limit);
  return rows.map((r) => ({ entry: r.entry, actor: r.actor }));
}
