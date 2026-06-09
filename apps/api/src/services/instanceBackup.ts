/**
 * Instance-level backup / restore
 * -------------------------------
 * Until now the only backup tooling was per-guild (export one guild's config
 * as a JSON file, restore it as a new guild). There was no way for an instance
 * admin to capture every guild at once. This bundles each non-deleted guild's
 * existing GuildBackup into one document, and restores it by rebuilding each
 * guild as a fresh guild owned by the restoring admin.
 *
 * Scope (honest): this is a *configuration* backup — guild settings, role tree,
 * channel structure, permission overrides, and (optionally) branding images —
 * exactly the same data the per-guild backup captures, for every guild. It is
 * NOT a data dump: users, memberships, and messages are out of scope and still
 * belong to a Postgres `pg_dump` (see the README / the deferred follow-up).
 *
 * We reuse exportGuild/importGuild verbatim — same format, same integrity
 * guarantees — and only add the instance envelope + iteration. Export is
 * sequential (bounded memory + IO) and capped at MAX_GUILDS with a `truncated`
 * flag; restore is per-guild best-effort so one bad guild can't abort the rest,
 * returning a per-guild result the admin can review.
 */

import { asc, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  exportGuild,
  importGuild,
  type GuildBackup,
} from './guildBackup';

export const INSTANCE_BACKUP_FORMAT = 'zekktris.instance-backup' as const;
export const INSTANCE_BACKUP_VERSION = 1 as const;

/** Hard cap on guilds per instance backup. A self-host has far fewer; the cap
 *  bounds memory + response size and is surfaced via `truncated`. */
const MAX_GUILDS = 1000;

export interface InstanceBackup {
  format: typeof INSTANCE_BACKUP_FORMAT;
  version: typeof INSTANCE_BACKUP_VERSION;
  exportedAt: string;
  /** Number of guild backups included. */
  guildCount: number;
  /** True when the instance has more guilds than MAX_GUILDS (older ones omitted). */
  truncated: boolean;
  /** Whether branding images were embedded. */
  includeImages: boolean;
  guilds: GuildBackup[];
}

export interface RestoreResult {
  sourceGuildId: string;
  name: string;
  ok: boolean;
  /** New guild id on success. */
  guildId?: string;
  /** Failure reason on error (so a partial restore is reviewable). */
  error?: string;
}

/** Build an instance-wide backup: every non-deleted guild's config backup,
 *  wrapped in an envelope. Caller must have checked instance-admin. */
export async function exportInstance(
  opts: { includeImages?: boolean } = {},
): Promise<InstanceBackup> {
  const includeImages = opts.includeImages ?? true;
  // Oldest-first, fetch one extra to detect truncation.
  const rows = await db
    .select({ id: schema.guilds.id })
    .from(schema.guilds)
    .where(isNull(schema.guilds.deletedAt))
    .orderBy(asc(schema.guilds.id))
    .limit(MAX_GUILDS + 1);
  const truncated = rows.length > MAX_GUILDS;
  const ids = rows.slice(0, MAX_GUILDS);

  // Sequential — bundling many guilds' images concurrently would spike memory
  // and disk IO; a backup is not latency-sensitive.
  const guilds: GuildBackup[] = [];
  for (const r of ids) {
    try {
      guilds.push(await exportGuild(r.id, { includeImages }));
    } catch {
      // A guild that was deleted mid-export (or is unreadable) is skipped
      // rather than failing the whole backup.
    }
  }

  return {
    format: INSTANCE_BACKUP_FORMAT,
    version: INSTANCE_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    guildCount: guilds.length,
    truncated,
    includeImages,
    guilds,
  };
}

/** Restore an instance backup by rebuilding each guild as a NEW guild owned by
 *  `ownerId` (the restoring admin). Never mutates existing guilds — same
 *  clone semantics as the single-guild import. Per-guild best-effort. */
export async function importInstance(
  ownerId: bigint,
  backup: unknown,
): Promise<{ created: RestoreResult[] }> {
  if (
    typeof backup !== 'object' ||
    backup === null ||
    (backup as { format?: unknown }).format !== INSTANCE_BACKUP_FORMAT
  ) {
    throw errors.badRequest('Unrecognized instance backup file');
  }
  const b = backup as Partial<InstanceBackup>;
  if (b.version !== INSTANCE_BACKUP_VERSION) {
    throw errors.badRequest(
      `Unsupported instance backup version ${String(b.version)} (expected ${INSTANCE_BACKUP_VERSION})`,
    );
  }
  if (!Array.isArray(b.guilds)) {
    throw errors.badRequest('Instance backup is missing its guilds array');
  }

  const created: RestoreResult[] = [];
  for (const g of b.guilds) {
    const guild = g as Partial<GuildBackup> | undefined;
    const sourceGuildId = guild?.sourceGuildId ?? '?';
    const name = guild?.guild?.name ?? '(unknown)';
    // Quick shape guard so importGuild gets something plausible; importGuild
    // itself does the deep validation (format/version/@everyone role).
    if (!guild || guild.format !== BACKUP_FORMAT || guild.version !== BACKUP_VERSION) {
      created.push({ sourceGuildId, name, ok: false, error: 'invalid or wrong-version guild backup' });
      continue;
    }
    try {
      const { guildId } = await importGuild(ownerId, guild as GuildBackup);
      created.push({ sourceGuildId, name, ok: true, guildId: guildId.toString() });
    } catch (e) {
      created.push({
        sourceGuildId,
        name,
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
    }
  }
  return { created };
}
