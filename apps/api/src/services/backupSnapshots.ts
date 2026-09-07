/**
 * Read-only view of the on-disk backup bundles written by `scripts/backup.sh`.
 *
 * NOT a backup implementation. Taking one needs the host — pg_dump against the
 * db container, and the uploads directory — and giving this container the
 * Docker socket to reach them would put a root-equivalent handle on the host
 * behind an HTTP endpoint, for a convenience button. So backups are taken by
 * cron on the host, and this only reports what is there.
 *
 * The point is visibility. Nobody noticed for months that `instanceBackup`
 * captures configuration and not data, so there was no real backup at all and
 * nothing anywhere said so. An admin screen that shows the age of the newest
 * bundle makes that kind of gap obvious instead of silent.
 *
 * The directory is mounted READ-ONLY (see docker-compose.yml), so this cannot
 * delete or alter a bundle even if something above it goes wrong. Rotation
 * belongs to the script that understands what it is pruning.
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../env';

export interface BackupSnapshot {
  filename: string;
  bytes: number;
  /** File mtime — when the bundle finished being written. */
  takenAt: string;
  ageHours: number;
}

export interface BackupStatus {
  /** False when the directory is absent or unreadable — which usually means
   *  no backup has ever been taken, the case most worth surfacing. */
  configured: boolean;
  directory: string;
  count: number;
  totalBytes: number;
  newest: BackupSnapshot | null;
  /** Newest bundle older than this many hours, or none at all. The admin UI
   *  uses it to decide whether to shout. 36h tolerates a nightly job that
   *  slipped or a machine that was off overnight, without going quiet on a
   *  backup that genuinely stopped running days ago. */
  stale: boolean;
  snapshots: BackupSnapshot[];
}

const STALE_AFTER_HOURS = 36;

export async function readBackupStatus(): Promise<BackupStatus> {
  const directory = env.BACKUP_DIR;
  const empty: BackupStatus = {
    configured: false,
    directory,
    count: 0,
    totalBytes: 0,
    newest: null,
    stale: true,
    snapshots: [],
  };

  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return empty;
  }

  const now = Date.now();
  const snapshots: BackupSnapshot[] = [];
  for (const name of names) {
    // Only the script's own bundles. Anything else in the directory is
    // somebody's business, not ours to report on.
    if (!name.startsWith('zekktris-') || !name.endsWith('.tar.gz')) continue;
    try {
      const s = await stat(join(directory, name));
      if (!s.isFile()) continue;
      snapshots.push({
        filename: name,
        bytes: s.size,
        takenAt: new Date(s.mtimeMs).toISOString(),
        ageHours: Math.round(((now - s.mtimeMs) / 3_600_000) * 10) / 10,
      });
    } catch {
      // A bundle being written right now can vanish between readdir and stat.
      // Skipping it is correct; the next poll will see it.
    }
  }

  snapshots.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  const newest = snapshots[0] ?? null;
  return {
    configured: true,
    directory,
    count: snapshots.length,
    totalBytes: snapshots.reduce((n, s) => n + s.bytes, 0),
    newest,
    stale: newest === null || newest.ageHours > STALE_AFTER_HOURS,
    snapshots: snapshots.slice(0, 20),
  };
}
