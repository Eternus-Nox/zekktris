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

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

// ── Admin-triggered maintenance ────────────────────────────────────────────

/**
 * The actions the host agent will run. This list is mirrored in
 * `scripts/agent.sh`, which is what actually executes them — and where the
 * real enforcement lives, since anything reaching this process could otherwise
 * ask for whatever it liked.
 *
 * Nothing but the action NAME crosses the boundary. The agent selects a branch
 * of a fixed `case` on it and never interpolates any part of the request into
 * a command, so this cannot become arbitrary execution on the host no matter
 * what an attacker puts in the file.
 */
export const MAINTENANCE_ACTIONS = [
  'backup',
  'backup-full',
  'verify',
  'restore',
  'update',
  'restart',
  'schedule-on',
  'schedule-off',
] as const;
export type MaintenanceAction = (typeof MAINTENANCE_ACTIONS)[number];

export interface MaintenanceResult {
  action: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  ok: boolean;
  output: string;
}

/**
 * Ask the host to run one action.
 *
 * This process cannot run it itself: taking a backup needs pg_dump against the
 * db container, and an update rebuilds the very container serving this
 * request. Doing either from here would need the Docker socket, which is a
 * root-equivalent handle on the host behind an HTTP endpoint. Writing a
 * request that a host-side agent picks up keeps the privilege where it already
 * is.
 *
 * Queued, not immediate — the agent polls once a minute. Returns false when a
 * request is already pending, so an impatient double-click cannot queue two
 * updates.
 */
export async function requestMaintenance(
  action: MaintenanceAction,
  requestedBy: bigint,
  file?: string,
): Promise<{ queued: boolean; reason?: string }> {
  // RESTORE is the one destructive action, and the only one that takes an
  // argument. Validate the filename here to the same exact shape the agent
  // re-validates it to — a bundle name and nothing else, so it cannot escape
  // the backups directory or carry anything a shell would interpret.
  if (action === 'restore') {
    if (!file || !/^zekktris-\d{8}-\d{6}\.tar\.gz$/.test(file)) {
      return { queued: false, reason: 'restore requires the exact bundle filename' };
    }
  }
  const dir = join(env.CONTROL_DIR, 'requests');
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return { queued: false, reason: 'control directory is not writable — is the agent set up?' };
  }
  try {
    const pending = (await readdir(dir)).filter((f) => f.endsWith('.json'));
    if (pending.length > 0) {
      return { queued: false, reason: 'a maintenance job is already queued' };
    }
  } catch {
    // Unreadable is handled by the write below failing.
  }
  const body = JSON.stringify({
    action,
    ...(action === 'restore' && file ? { file } : {}),
    requestedBy: requestedBy.toString(),
    at: new Date().toISOString(),
  });
  try {
    await writeFile(join(dir, `${Date.now()}-${randomUUID()}.json`), body, { mode: 0o600 });
    return { queued: true };
  } catch {
    return { queued: false, reason: 'could not write the request — is the agent set up?' };
  }
}

/** The last job the agent ran, or null if it has never run one. */
export async function readLastMaintenance(): Promise<MaintenanceResult | null> {
  try {
    const raw = await readFile(join(env.CONTROL_DIR, 'status', 'last.json'), 'utf8');
    return JSON.parse(raw) as MaintenanceResult;
  } catch {
    return null;
  }
}

/** Whether a request is sitting in the queue waiting for the agent's next tick. */
export async function isMaintenancePending(): Promise<boolean> {
  try {
    return (await readdir(join(env.CONTROL_DIR, 'requests'))).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Whether the host has automatic backups scheduled.
 *
 * Written by the agent on every tick from the real crontab, not from a
 * setting we store — so the toggle reflects the machine even if someone
 * edited cron by hand, rather than confidently showing a schedule that
 * isn't there.
 *
 * Null when the agent has never run, which is itself the answer: nothing is
 * scheduled, because nothing is running the schedule.
 */
export async function readScheduleStatus(): Promise<{
  enabled: boolean;
  nightly: string;
  weekly: string;
} | null> {
  try {
    const raw = await readFile(join(env.CONTROL_DIR, 'status', 'schedule.json'), 'utf8');
    return JSON.parse(raw) as { enabled: boolean; nightly: string; weekly: string };
  } catch {
    return null;
  }
}
