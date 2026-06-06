/**
 * guildFolders
 * ------------
 * Client-side helpers for working with the user's rail folders. The
 * authoritative state lives on the server (`SelfUser.guildFolders`)
 * and is written via `rest.updateGuildFolders`. This module gives
 * components a small API to:
 *
 *   - render the rail in correct interleaved order (top-level guilds
 *     and folders, with folders positioned by their first member)
 *   - mutate the folder list (add guild, remove guild, rename, color,
 *     create, delete)
 *   - persist folder collapse state in localStorage (purely local —
 *     "is this folder expanded right now" doesn't need to sync across
 *     devices and would be annoying if it did)
 */

import type { Guild, GuildFolder } from '@zekktris/client';

/** localStorage key for the user's collapsed-folder set. Stored as a
    JSON array of folder ids that are currently collapsed. */
const COLLAPSED_STORAGE_KEY = 'zekktris.rail.collapsedFolders.v1';

/** Generate a stable, URL-safe folder id. Client-generated so the
    user can interact with a freshly-created folder before the server
    write round-trips. Matches the server's FOLDER_ID_RE regex. */
export function newFolderId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  // Base64url without padding — every byte produces 4/3 chars on
  // average; 12 bytes → 16 chars, well within the 4-40 server cap.
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `fldr_${b64}`;
}

/** Index a folder list by guild id for O(1) lookup of "what folder
    is this guild in?" — returns undefined for top-level guilds. */
export function buildGuildToFolderMap(folders: GuildFolder[]): Map<string, GuildFolder> {
  const m = new Map<string, GuildFolder>();
  for (const f of folders) {
    for (const gid of f.guildIds) m.set(gid, f);
  }
  return m;
}

/** A flat rail entry — either a single guild rendered at top level,
    or a folder. The rail iterates this list and renders each entry
    in order. Folders carry their resolved Guild objects (rather than
    just ids) so the rail doesn't have to re-look-up in a map. */
export type RailEntry =
  | { kind: 'guild'; guild: Guild }
  | { kind: 'folder'; folder: GuildFolder; guilds: Guild[] };

/**
 * Build the rail's flat entry list from the user's ordered guild list
 * and folder definitions. Behavior:
 *
 *   - Iterate the ordered guild list in order.
 *   - If a guild belongs to a folder we haven't emitted yet: emit
 *     the folder entry (carrying ALL its guilds in their stored
 *     order, not their position in the ordered list).
 *   - If a guild belongs to a folder we already emitted: skip (its
 *     position in the folder already determined where it appears).
 *   - Otherwise: emit the guild as a top-level entry.
 *
 * Guilds whose folder reference points to a deleted folder, or that
 * appear in a folder's guildIds but aren't in the user's guild list
 * anymore (left the server) are silently filtered. This matches the
 * server's sanitization pass — the client renders what's valid right
 * now and the server cleans up persistently on next write.
 */
export function buildRailEntries(
  orderedGuilds: Guild[],
  folders: GuildFolder[],
): RailEntry[] {
  const guildById = new Map(orderedGuilds.map((g) => [g.id, g]));
  const folderByGuild = buildGuildToFolderMap(folders);
  const emittedFolders = new Set<string>();
  const entries: RailEntry[] = [];

  for (const g of orderedGuilds) {
    const folder = folderByGuild.get(g.id);
    if (folder) {
      if (emittedFolders.has(folder.id)) continue;
      emittedFolders.add(folder.id);
      // Resolve folder.guildIds to Guilds in stored order. Filter
      // out any that the user is no longer a member of.
      const guilds: Guild[] = [];
      for (const gid of folder.guildIds) {
        const fg = guildById.get(gid);
        if (fg) guilds.push(fg);
      }
      // Don't emit an empty folder — server should have cleaned
      // these up, but be defensive at the rendering boundary.
      if (guilds.length === 0) continue;
      entries.push({ kind: 'folder', folder, guilds });
    } else {
      entries.push({ kind: 'guild', guild: g });
    }
  }
  return entries;
}

// ── Mutations (return new folder lists; callers persist) ──────────────

/** Add a guild to a folder. If the guild was previously in another
    folder, it's removed from that one first (a guild can belong to
    only one folder). Returns a new folder list; the caller is
    responsible for persisting via `rest.updateGuildFolders`. */
export function addGuildToFolder(
  folders: GuildFolder[],
  folderId: string,
  guildId: string,
): GuildFolder[] {
  return folders.map((f) => {
    if (f.id === folderId) {
      if (f.guildIds.includes(guildId)) return f;
      return { ...f, guildIds: [...f.guildIds, guildId] };
    }
    if (f.guildIds.includes(guildId)) {
      return { ...f, guildIds: f.guildIds.filter((g) => g !== guildId) };
    }
    return f;
  });
}

/** Remove a guild from every folder it's in. */
export function removeGuildFromAllFolders(
  folders: GuildFolder[],
  guildId: string,
): GuildFolder[] {
  return folders
    .map((f) =>
      f.guildIds.includes(guildId)
        ? { ...f, guildIds: f.guildIds.filter((g) => g !== guildId) }
        : f,
    )
    // Empty folders get dropped on the server too — clean up here so
    // the UI doesn't briefly show a ghost folder.
    .filter((f) => f.guildIds.length > 0);
}

/** Append a brand-new folder containing one initial guild. The id is
    generated client-side; the server accepts it as long as it matches
    the FOLDER_ID_RE format. */
export function createFolder(
  folders: GuildFolder[],
  name: string,
  initialGuildId: string,
): GuildFolder[] {
  // Pull this guild from any existing folder first.
  const withoutGuild = removeGuildFromAllFolders(folders, initialGuildId);
  return [
    ...withoutGuild,
    { id: newFolderId(), name, color: null, guildIds: [initialGuildId] },
  ];
}

/** Replace a folder's name and color. */
export function editFolder(
  folders: GuildFolder[],
  folderId: string,
  patch: { name?: string; color?: string | null },
): GuildFolder[] {
  return folders.map((f) =>
    f.id === folderId
      ? {
          ...f,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
        }
      : f,
  );
}

/** Delete a folder, releasing its guilds back to top-level. */
export function deleteFolder(
  folders: GuildFolder[],
  folderId: string,
): GuildFolder[] {
  return folders.filter((f) => f.id !== folderId);
}

// ── Collapse state (localStorage) ─────────────────────────────────────

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function writeCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // localStorage may be disabled; degrade silently.
  }
}

export function isFolderCollapsed(folderId: string): boolean {
  return readCollapsed().has(folderId);
}

export function setFolderCollapsed(folderId: string, collapsed: boolean): void {
  const s = readCollapsed();
  if (collapsed) s.add(folderId);
  else s.delete(folderId);
  writeCollapsed(s);
}
