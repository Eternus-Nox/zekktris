/**
 * guildOrder
 * ----------
 * Per-user preferred ordering of the guild rail. Persisted in
 * localStorage under `zekktris.guildOrder` as a JSON array of guild
 * id strings — a custom-defined ordering the user has dragged into
 * place. Server-side persistence is intentionally deferred to a
 * future cycle: a `users.guild_order jsonb` column is the obvious
 * upgrade path, but for v1 the localStorage approach lets users
 * personalise their rail without a migration.
 *
 * Sort semantics: guilds present in the saved order render in that
 * order at the top; any guild not in the saved list (e.g. one the
 * user just joined) appends afterwards in the natural order returned
 * by the API. Removing yourself from a guild silently drops it from
 * the saved order on next read; we don't garbage-collect eagerly.
 *
 * The value is stored as a JSON-stringified array of strings rather
 * than a comma-joined list so future revisions can extend the
 * structure (per-server collapsed-state, folders, etc) without a
 * format collision.
 */

const KEY = 'zekktris.guildOrder';

/** Read the saved order. Returns [] if storage is empty / corrupt. */
export function readGuildOrder(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/** Persist the order. No-throw — storage failures (quota, private
    mode) are silent; the in-memory state still drives the UI for the
    rest of the session. */
export function writeGuildOrder(ids: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
}

/**
 * Apply the saved order to a list of guild ids. Items in the saved
 * order render first (in that order), filtered to ids actually
 * present in the input. Items not in the saved order append at the
 * tail in their original position-relative order. Stable: equal
 * ordering decisions don't reshuffle.
 */
export function applyGuildOrder(allIds: string[], saved: string[]): string[] {
  if (saved.length === 0) return allIds;
  const present = new Set(allIds);
  const head = saved.filter((id) => present.has(id));
  const headSet = new Set(head);
  const tail = allIds.filter((id) => !headSet.has(id));
  return [...head, ...tail];
}
