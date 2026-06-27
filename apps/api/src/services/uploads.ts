/**
 * Uploads service
 * ---------------
 * Helpers for saving user-uploaded files to disk and producing the
 * NewAttachmentInput records the message-create flow expects.
 *
 * Storage layout: ${UPLOAD_DIR}/<attachmentId>/<sanitized-filename>
 *
 *   The per-attachment directory means filenames can repeat without
 *   collision, and lets us nuke an attachment + its file with one rm -rf.
 *
 * The URL stored on the attachment row is /cdn/<attachmentId>/<filename>.
 * In production Caddy serves /cdn/* directly off the volume; in dev the
 * routes/cdn.ts handler streams from disk.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../env';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';

export interface SavedFile {
  /** Snowflake id assigned to this attachment. Use as the row id. */
  attachmentId: bigint;
  /** Sanitized filename — what was actually written to disk. */
  filename: string;
  /** Absolute path on disk. Used internally; do NOT serialize to clients. */
  diskPath: string;
  contentType: string;
  size: number;
  /** Public URL to put in the attachment row. */
  url: string;
  /** Image dimensions, set if the file appears to be an image. v1 leaves these null. */
  width: number | null;
  height: number | null;
}

/**
 * Validate and write a single uploaded File to disk. Throws AppError on
 * validation failure (size, suspicious filename); throws Error otherwise.
 */
/**
 * Defense-in-depth at the upload boundary. The CDN serve path
 * (routes/cdn.ts) already gates inline serving on an allow-list and
 * forces attachment-disposition + octet-stream for anything outside
 * it, but ALSO normalizing the stored content-type here means any
 * future code path that reads `attachments.contentType` (e.g. a
 * webhook embed, a search-result thumbnail, a future "preview"
 * endpoint) can't be fooled by an attacker-declared text/html on a
 * .png. Belt and suspenders.
 *
 * Strategy: trust the file extension over the client-declared MIME.
 * Clients have no business uploading a .png with Content-Type
 * application/javascript, and the only legitimate reason to send a
 * surprising MIME is the rare correctly-typed-but-extension-less
 * upload — which gets octet-stream anyway. For known-safe extensions
 * we pin the content-type to the canonical one; for unknown
 * extensions we fall back to octet-stream regardless of what the
 * client claimed.
 */
function normalizeContentType(filename: string, claimed: string): string {
  const lower = filename.toLowerCase();
  // Image types
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  // Audio (voice messages are .webm or .ogg from MediaRecorder)
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.webm')) {
    // .webm covers both audio and video; trust the client's claim
    // here but only between the two valid types.
    return claimed === 'audio/webm' ? 'audio/webm' : 'video/webm';
  }
  // Video
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  // Documents the CDN can safely inline
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.md')) {
    return 'text/plain';
  }
  // Everything else — including the dangerous-to-render types — gets
  // octet-stream. The CDN's inline-safe allow-list excludes this so
  // browsers will download rather than execute, regardless of what
  // the upload client claimed.
  return 'application/octet-stream';
}

export async function saveUploadedFile(
  file: File,
  opts: { encryptedThumb?: File | null; makeServerThumbnail?: boolean } = {},
): Promise<SavedFile & { thumbnail: SavedFile | null }> {
  const maxBytes = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw errors.payloadTooLarge(`file "${file.name}" exceeds ${env.MAX_UPLOAD_SIZE_MB} MB limit`);
  }
  if (file.size === 0) {
    throw errors.badRequest(`file "${file.name}" is empty`);
  }

  let safeName = sanitizeFilename(file.name || 'untitled');
  const attachmentId = nextSnowflake();

  // Read the bytes up front. For files <100MB this is fine in one shot;
  // very large uploads would benefit from a real stream but Hono gives us
  // a Blob/File so we'd need to switch to a multipart streaming parser
  // in stage 6+ if files get bigger. We read BEFORE creating any on-disk
  // directory so the decompression-bomb guard below can reject without
  // leaving a stray dir behind (a flood of bombs would otherwise spray
  // empty directories / exhaust inodes).
  let buf: Buffer = Buffer.from(await file.arrayBuffer());
  let contentType = normalizeContentType(safeName, file.type || '');
  let width: number | null = null;
  let height: number | null = null;

  // Decompression-bomb guard: a tiny file can declare an enormous pixel
  // count that would OOM sharp on decode (and every client on view).
  // Reject abusive images from the HEADER, before we decode or store
  // anything. Only raster images are checked; non-images are opaque blobs
  // we never decode. See assertImageWithinPixelLimit for the cap rationale.
  if (/^image\//i.test(contentType)) {
    await assertImageWithinPixelLimit(buf);
  }

  const dir = path.join(env.UPLOAD_DIR, attachmentId.toString());
  await fs.mkdir(dir, { recursive: true });

  // Server-side WebP backstop. Clients are expected to compress + convert
  // to WebP before upload; this catches anything that didn't (a different
  // client, a direct API call, or a client whose compression was skipped).
  // We only touch NON-WebP raster images, so the common path — an already
  // client-compressed WebP — incurs ZERO server CPU here. Best-effort:
  // any failure (sharp missing, decode error, no size win) just stores
  // the original bytes unchanged.
  // Gate on the NORMALIZED contentType (extension-derived), not the raw
  // client-supplied file.type — so a PNG/JPEG uploaded with a wrong or empty
  // Content-Type still gets the 1920px downscale + WebP re-encode instead of
  // being stored at full resolution.
  if (/^image\/(jpeg|png)$/i.test(contentType)) {
    const webp = await encodeWebp(buf, { maxDim: 1920, quality: 80 });
    if (webp && webp.data.length < buf.length) {
      buf = webp.data;
      safeName = `${safeName.replace(/\.[^.]+$/, '')}.webp`;
      contentType = 'image/webp';
      width = webp.width;
      height = webp.height;
    }
  }

  const diskPath = path.join(dir, safeName);
  await fs.writeFile(diskPath, buf);

  // Inline thumbnail (its OWN attachment id/dir/row so the CDN can serve it +
  // GC keeps it referenced). Two sources:
  //  • E2EE: the client already made + encrypted a thumbnail (.zke) — save it
  //    verbatim (it's octet-stream, so the recursive save skips image work).
  //  • non-E2EE image: generate a ~480px webp from the bytes we already have.
  // Either way it's saved via a nested saveUploadedFile (no further nesting).
  let thumbnail: SavedFile | null = null;
  if (opts.encryptedThumb) {
    thumbnail = await saveUploadedFile(opts.encryptedThumb);
  } else if (opts.makeServerThumbnail && /^image\//i.test(contentType)) {
    const thumb = await encodeWebp(buf, { maxDim: 480, quality: 70 });
    if (thumb) {
      thumbnail = await saveUploadedFile(
        new File([thumb.data], 'thumb.webp', { type: 'image/webp' }),
      );
    }
  }

  return {
    attachmentId,
    filename: safeName,
    diskPath,
    contentType,
    size: buf.length,
    url: `/cdn/${attachmentId}/${encodeURIComponent(safeName)}`,
    width,
    height,
    thumbnail,
  };
}

/**
 * Replace path separators, control chars, and other dangerous bytes with
 * underscores. Also trims length so a pathological filename can't blow up
 * directory traversal protections.
 */
export function sanitizeFilename(input: string): string {
  // Drop any path components — even ones that look benign (".." / "/foo").
  const base = input.split(/[\\/]/).pop() ?? '';
  // Replace runs of disallowed characters with underscore.
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*\\/]+/g, '_')
    .replace(/^\.+/, '_') // no leading dot — refuse hidden files
    .trim();
  const final = cleaned.length === 0 ? 'untitled' : cleaned;
  // Cap at 255 (FAT32-style limit; any modern fs will accept this).
  return final.length > 255 ? final.slice(0, 255) : final;
}

/**
 * Open an attachment for streaming back to a client. Returns null if the
 * file is missing on disk (e.g. row exists but file was nuked manually).
 */
export async function openAttachmentForRead(
  attachmentId: bigint,
  filename: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
  const diskPath = path.join(env.UPLOAD_DIR, attachmentId.toString(), filename);
  // Defense-in-depth: filenames are sanitized at upload and callers validate
  // against DB-stored values, but refuse any resolved path that escapes the
  // upload root regardless — guards against a future unsanitized DB write.
  const root = path.resolve(env.UPLOAD_DIR);
  if (!path.resolve(diskPath).startsWith(root + path.sep)) return null;
  try {
    const stat = await fs.stat(diskPath);
    if (!stat.isFile()) return null;
    // Use a regular stream — no need to load the full file into memory.
    const { createReadStream } = await import('node:fs');
    return { stream: createReadStream(diskPath), size: stat.size };
  } catch {
    return null;
  }
}

/** Best-effort delete of an attachment's on-disk file. Doesn't throw on miss. */
export async function deleteAttachmentFile(attachmentId: bigint): Promise<void> {
  const dir = path.join(env.UPLOAD_DIR, attachmentId.toString());
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Already gone, or permission issue. Surfacing the error here would
    // poison every message-delete cleanup; just swallow.
  }
}

/**
 * Extract the attachment id from a `/cdn/<id>/<filename>` URL. Returns
 * null if the URL doesn't match the expected shape. Used by replace-
 * style endpoints (avatar/banner/guild-icon/guild-banner) so the old
 * file on disk can be cleaned up after the row's URL column rotates
 * to a new attachment id.
 *
 * Without this cleanup every avatar change leaves the previous file
 * behind on disk forever. For a user who cycles through avatars
 * occasionally that's bounded waste, but a malicious user could
 * upload-replace in a loop and balloon the volume.
 */
export function parseCdnAttachmentId(url: string | null | undefined): bigint | null {
  if (!url) return null;
  // Shape: /cdn/<digits>/<anything>. We only need the leading digit
  // run after /cdn/.
  const m = /^\/cdn\/(\d+)\//.exec(url);
  if (!m) return null;
  try {
    return BigInt(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Periodic GC sweep that deletes on-disk attachment directories
 * that are unreferenced by any entity AND older than the grace
 * period. Source of orphans:
 *
 *   - Pre-create event image uploads where the user abandoned the
 *     form (the file was saved but no event was created to claim it).
 *   - Any future "upload-then-attach" flow where the attach step
 *     fails or is skipped.
 *
 * The on-disk layout is `${UPLOAD_DIR}/<snowflake>/<filename>`. Every
 * referenced URL is `/cdn/<snowflake>/<filename>`, so the snowflake
 * is the canonical id we cross-reference.
 *
 * Grace period (1 hour) protects in-flight uploads — a user might
 * upload, fill out a form for 10 minutes, then submit. Without the
 * grace window, the GC could race against their successful claim
 * and delete the just-uploaded file before the entity update commits.
 *
 * The referenced set comes from:
 *   - users.avatarUrl, users.bannerUrl
 *   - guilds.iconUrl, guilds.bannerUrl
 *   - guildMembers.avatarUrl  (per-guild override)
 *   - scheduledEvents.imageUrl
 *   - guildEmojis.url
 *   - stickers.url
 *   - webhooks.avatarUrl
 *   - channels.dmIconUrl
 *   - attachments.url  (message attachments — counted only while the owning
 *                       message AND its channel are live; a soft-deleted
 *                       channel/message releases its media for reclamation)
 *
 * Per-entry errors logged but don't poison the batch.
 */
/**
 * Storage category — what a stored file is used for. Mirrors the
 * URL-bearing columns we scan. "unused" = not referenced anywhere.
 */
export type StorageCategory =
  | 'attachment'
  | 'avatar'
  | 'banner'
  | 'emoji'
  | 'sticker'
  | 'other'
  | 'unused';

/**
 * Build a map of attachment id (string) -> category for every file
 * currently referenced anywhere in the DB. Shared by the GC sweep and
 * the admin storage listing so "unused" and the category labels are
 * computed identically. First reference wins if a file is somehow
 * referenced by more than one column.
 */
async function buildReferencedAttachmentMap(): Promise<Map<string, StorageCategory>> {
  const { db, schema } = await import('../db');
  const { and, eq, isNull } = await import('drizzle-orm');
  const map = new Map<string, StorageCategory>();
  const setIf = (id: string, cat: StorageCategory) => {
    if (!map.has(id)) map.set(id, cat);
  };

  // attachments table: each row references a chat-message file. A file counts
  // as referenced only while its message AND the message's channel are still
  // live (not soft-deleted). Deleting a channel soft-deletes it (and its
  // threads) but leaves the message + attachment rows intact for reply-chain
  // integrity; without this join those files would report "in use" forever and
  // never be reclaimable. Joining through messages→channels and filtering on
  // deletedAt makes deleted-channel (and deleted-message) media show as unused
  // and become GC-eligible.
  const attRows = await db
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.attachments.messageId))
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(and(isNull(schema.messages.deletedAt), isNull(schema.channels.deletedAt)));
  for (const r of attRows) setIf(r.id.toString(), 'attachment');

  // URL-bearing columns, each tagged with the category it represents.
  type Puller = {
    cat: StorageCategory;
    run: () => Promise<Array<{ url: string | null }>>;
  };
  const pullers: Puller[] = [
    { cat: 'avatar', run: () => db.select({ url: schema.users.avatarUrl }).from(schema.users) },
    { cat: 'banner', run: () => db.select({ url: schema.users.bannerUrl }).from(schema.users) },
    { cat: 'other', run: () => db.select({ url: schema.guilds.iconUrl }).from(schema.guilds) },
    { cat: 'banner', run: () => db.select({ url: schema.guilds.bannerUrl }).from(schema.guilds) },
    { cat: 'avatar', run: () => db.select({ url: schema.guildMembers.avatarUrl }).from(schema.guildMembers) },
    { cat: 'other', run: () => db.select({ url: schema.scheduledEvents.imageUrl }).from(schema.scheduledEvents) },
    { cat: 'emoji', run: () => db.select({ url: schema.guildEmojis.url }).from(schema.guildEmojis) },
    { cat: 'sticker', run: () => db.select({ url: schema.stickers.url }).from(schema.stickers) },
    { cat: 'avatar', run: () => db.select({ url: schema.webhooks.avatarUrl }).from(schema.webhooks) },
    { cat: 'other', run: () => db.select({ url: schema.channels.dmIconUrl }).from(schema.channels) },
  ];
  for (const p of pullers) {
    try {
      const rows = await p.run();
      for (const r of rows) {
        const id = parseCdnAttachmentId(r.url);
        if (id) setIf(id.toString(), p.cat);
      }
    } catch (err) {
      console.warn('attachment scan: URL puller failed', err);
    }
  }
  return map;
}

/** Set of referenced ids (used by the GC sweep). */
async function buildReferencedAttachmentSet(): Promise<Set<string>> {
  return new Set((await buildReferencedAttachmentMap()).keys());
}

/**
 * Map of attachment-id → owning guild-id, so the admin storage manager can
 * filter files by server. Covers message attachments (via channel→guild) and
 * guild-scoped assets (icon/banner/emoji/sticker/member-avatar/event image).
 * Global files (user avatars/banners, DM attachments, webhook avatars) have no
 * guild and are simply absent from this map.
 */
async function buildAttachmentGuildMap(): Promise<Map<string, string>> {
  const { db, schema } = await import('../db');
  const { eq } = await import('drizzle-orm');
  const m = new Map<string, string>();
  const set = (id: string, gid: bigint | null) => {
    if (gid != null && !m.has(id)) m.set(id, gid.toString());
  };

  // Message attachments → channel → guild (DM channels have a null guildId).
  const att = await db
    .select({ id: schema.attachments.id, guildId: schema.channels.guildId })
    .from(schema.attachments)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.attachments.messageId))
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId));
  for (const r of att) set(r.id.toString(), r.guildId);

  // Guild-scoped assets, by parsing the CDN id out of each URL column.
  type GP = { run: () => Promise<Array<{ url: string | null; guildId: bigint | null }>> };
  const pullers: GP[] = [
    { run: () => db.select({ url: schema.guilds.iconUrl, guildId: schema.guilds.id }).from(schema.guilds) },
    { run: () => db.select({ url: schema.guilds.bannerUrl, guildId: schema.guilds.id }).from(schema.guilds) },
    { run: () => db.select({ url: schema.guildEmojis.url, guildId: schema.guildEmojis.guildId }).from(schema.guildEmojis) },
    { run: () => db.select({ url: schema.stickers.url, guildId: schema.stickers.guildId }).from(schema.stickers) },
    { run: () => db.select({ url: schema.guildMembers.avatarUrl, guildId: schema.guildMembers.guildId }).from(schema.guildMembers) },
    { run: () => db.select({ url: schema.scheduledEvents.imageUrl, guildId: schema.scheduledEvents.guildId }).from(schema.scheduledEvents) },
  ];
  for (const p of pullers) {
    try {
      const rows = await p.run();
      for (const r of rows) {
        const id = parseCdnAttachmentId(r.url);
        if (id) set(id.toString(), r.guildId);
      }
    } catch (err) {
      console.warn('guild-map puller failed', err);
    }
  }
  return m;
}

async function dirSizeBytes(dirPath: string): Promise<number> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  let total = 0;
  let names: string[];
  try {
    names = await fs.readdir(dirPath);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dirPath, name));
      if (st.isFile()) total += st.size;
    } catch {
      // skip
    }
  }
  return total;
}

/**
 * Heuristic: is this file already in a space-efficient (lossy-
 * compressed) image format? true = jpg/webp/avif, false = png/gif/bmp/
 * tiff (lossless or uncompressed — candidates for compression), null =
 * not an image we reason about.
 */
function compressionState(format: string | null): boolean | null {
  if (!format) return null;
  const f = format.toLowerCase();
  if (['jpg', 'jpeg', 'webp', 'avif'].includes(f)) return true;
  if (['png', 'gif', 'bmp', 'tiff', 'tif'].includes(f)) return false;
  return null;
}

const PAGE_SIZE = 50;

export interface StorageItem {
  /** Attachment snowflake id (string — may exceed JS safe int). */
  id: string;
  /** First filename inside the attachment dir, for display. */
  filename: string | null;
  /** Lowercased file extension (no dot), or null. */
  format: string | null;
  /** Format-based compression heuristic (see compressionState). */
  compressed: boolean | null;
  /** What the file is used for. */
  category: StorageCategory;
  /** On-disk size of the attachment directory, in bytes. */
  sizeBytes: number;
  /** Last-modified time (ms epoch) — approx upload / last-written time. */
  mtimeMs: number;
  /** True if still referenced somewhere in the DB. */
  referenced: boolean;
  /** Owning guild id (message attachments via channel, or guild assets), or
   *  null for global files (user avatars/banners, DM attachments, webhooks). */
  guildId: string | null;
}

export interface StorageListing {
  items: StorageItem[];
  page: number;
  pageSize: number;
  /** Count of items matching the current category filter. */
  total: number;
  /** On-disk bytes of the items matching the current filters (incl. guild). */
  filteredBytes: number;
  /** Overall totals across ALL categories (for the summary line). */
  totalBytes: number;
  totalCount: number;
  unusedBytes: number;
  unusedCount: number;
  /** Item count per category (across everything, unfiltered). */
  categoryCounts: Record<StorageCategory, number>;
}

/**
 * Enumerate on-disk attachment directories with size, category, and
 * compression state. Supports category filtering, sort, and 50-per-page
 * pagination. Powers the admin storage manager.
 */
interface StorageScan {
  all: StorageItem[];
  totalBytes: number;
  totalCount: number;
  unusedBytes: number;
  unusedCount: number;
  categoryCounts: Record<StorageCategory, number>;
}

// Short-lived cache of the full disk scan. The scan walks every upload
// directory (stat + readdir each) AND queries every URL-bearing table
// to build the referenced-map — expensive with many files. The admin
// UI hits this repeatedly while paging/filtering/sorting, all of which
// operate on the SAME underlying snapshot, so we cache the snapshot for
// a few seconds and serve those interactions from memory. Mutations
// (delete/compress/gc) call invalidateStorageScan() to force a refresh.
let storageScanCache: { at: number; data: StorageScan } | null = null;
const STORAGE_SCAN_TTL_MS = 20_000;

export function invalidateStorageScan(): void {
  storageScanCache = null;
}

async function scanStorage(): Promise<StorageScan> {
  const now = Date.now();
  if (storageScanCache && now - storageScanCache.at < STORAGE_SCAN_TTL_MS) {
    return storageScanCache.data;
  }
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const emptyCounts: Record<StorageCategory, number> = {
    attachment: 0, avatar: 0, banner: 0, emoji: 0, sticker: 0, other: 0, unused: 0,
  };

  let entries: string[];
  try {
    entries = await fs.readdir(env.UPLOAD_DIR);
  } catch {
    const empty: StorageScan = {
      all: [], totalBytes: 0, totalCount: 0, unusedBytes: 0, unusedCount: 0,
      categoryCounts: emptyCounts,
    };
    storageScanCache = { at: now, data: empty };
    return empty;
  }

  const refMap = await buildReferencedAttachmentMap();
  const guildMap = await buildAttachmentGuildMap();
  const all: StorageItem[] = [];
  let totalBytes = 0;
  let unusedBytes = 0;
  let unusedCount = 0;
  const categoryCounts = { ...emptyCounts };

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue; // skip stray non-snowflake names
    const dirPath = path.join(env.UPLOAD_DIR, entry);
    let stat;
    try {
      stat = await fs.stat(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const sizeBytes = await dirSizeBytes(dirPath);
    let filename: string | null = null;
    try {
      const inner = await fs.readdir(dirPath);
      filename = inner[0] ?? null;
    } catch {
      // leave null
    }
    const cat: StorageCategory = refMap.get(entry) ?? 'unused';
    const isReferenced = cat !== 'unused';
    const dot = filename ? filename.lastIndexOf('.') : -1;
    const format = dot > -1 ? filename!.slice(dot + 1).toLowerCase() : null;

    totalBytes += sizeBytes;
    categoryCounts[cat] += 1;
    if (!isReferenced) {
      unusedBytes += sizeBytes;
      unusedCount += 1;
    }
    all.push({
      id: entry,
      filename,
      format,
      compressed: compressionState(format),
      category: cat,
      sizeBytes,
      mtimeMs: stat.mtime.getTime(),
      referenced: isReferenced,
      guildId: guildMap.get(entry) ?? null,
    });
  }

  const data: StorageScan = {
    all, totalBytes, totalCount: all.length, unusedBytes, unusedCount, categoryCounts,
  };
  storageScanCache = { at: now, data };
  return data;
}

export async function listStorageItems(opts?: {
  page?: number;
  category?: StorageCategory | 'all';
  sort?: 'size' | 'recent';
  q?: string;
  /** Restrict to files belonging to one guild (server). */
  guildId?: string;
}): Promise<StorageListing> {
  const page = Math.max(1, Math.floor(opts?.page ?? 1));
  const category = opts?.category ?? 'all';
  const sort = opts?.sort ?? 'size';
  const query = (opts?.q ?? '').trim().toLowerCase();
  const guildId = opts?.guildId?.trim() || undefined;

  const scan = await scanStorage();

  const filtered = scan.all.filter((i) => {
    if (guildId && i.guildId !== guildId) return false;
    if (category !== 'all' && i.category !== category) return false;
    if (query) {
      const hay = (i.filename ?? i.id).toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  filtered.sort((a, b) =>
    sort === 'recent' ? b.mtimeMs - a.mtimeMs : b.sizeBytes - a.sizeBytes,
  );

  const total = filtered.length;
  const filteredBytes = filtered.reduce((n, i) => n + i.sizeBytes, 0);
  const startIdx = (page - 1) * PAGE_SIZE;
  const items = filtered.slice(startIdx, startIdx + PAGE_SIZE);

  return {
    items,
    page,
    pageSize: PAGE_SIZE,
    total,
    filteredBytes,
    totalBytes: scan.totalBytes,
    totalCount: scan.totalCount,
    unusedBytes: scan.unusedBytes,
    unusedCount: scan.unusedCount,
    categoryCounts: scan.categoryCounts,
  };
}

/**
 * Delete a single stored attachment directory by id (admin action).
 * Returns whether a directory was actually present. Does not touch the
 * DB — if the id is still referenced, the caller has chosen to remove
 * the underlying bytes regardless (the URL will then 404).
 */
export async function deleteStorageItem(attachmentId: bigint): Promise<boolean> {
  invalidateStorageScan();
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dirPath = path.join(env.UPLOAD_DIR, attachmentId.toString());
  try {
    await fs.stat(dirPath);
  } catch {
    return false;
  }
  await fs.rm(dirPath, { recursive: true, force: true });
  return true;
}

/**
 * Optional sharp loader (mirrors services/imageCompression.ts). The
 * `'sharp' as string` specifier stops the bundler/compiler from trying
 * to resolve the module at build time, so the codebase compiles and the
 * API boots even when sharp isn't installed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSharp(): Promise<any | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ ('sharp' as string));
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

/**
 * Maximum input pixels (width × height × animation frames) we'll let sharp
 * decode, and the ceiling the upload boundary rejects above. 100 megapixels.
 *
 * Rationale: far above any real avatar/banner/photo — flagship phone and pro
 * camera sensors top out around 48–61 MP, so this leaves generous headroom —
 * yet it blocks gigapixel "decompression bombs" (a few-KB file whose header
 * declares tens of thousands of pixels per side) and caps a single decode at
 * ~400 MB (100 MP × 4 bytes RGBA), well under sharp's ~268 MP / ~1 GB default
 * limitInputPixels. Passed to every sharp() entry point (this file's
 * encodeWebp + the periodic sweep in imageCompression.ts) so decode never
 * allocates beyond the cap; also enforced up-front at the upload boundary.
 */
export const MAX_INPUT_PIXELS = 100_000_000;

/**
 * Total pixels a decoder must allocate for an image of these header
 * dimensions. Animation frames (GIF / APNG / animated WebP) multiply,
 * since each frame is decoded — so a small frame size with a huge frame
 * count is still a bomb.
 */
export function imageTotalPixels(
  width: number,
  height: number,
  pages?: number,
): number {
  const w = width > 0 ? width : 0;
  const h = height > 0 ? height : 0;
  const frames = pages && pages > 0 ? pages : 1;
  return w * h * frames;
}

/**
 * Whether an image of these header dimensions exceeds the pixel cap — i.e.
 * is an abusive decompression bomb we must refuse to decode or store.
 */
export function exceedsPixelLimit(
  width: number,
  height: number,
  pages?: number,
): boolean {
  return imageTotalPixels(width, height, pages) > MAX_INPUT_PIXELS;
}

/**
 * Decompression-bomb guard for the upload boundary. Reads the image HEADER
 * only (sharp.metadata() does not decode pixels) and throws a clear 400 if
 * the declared total pixel count — width × height × animation frames —
 * exceeds MAX_INPUT_PIXELS. The frame multiply also catches many-frame GIF/
 * APNG/animated-WebP bombs, where each frame is modest but the sum is not.
 *
 * Best-effort: if sharp isn't installed we skip — without a decoder there's
 * nothing to exhaust server-side, and we have no way to read dimensions. A
 * header sharp can't parse (corrupt/non-image) is left to the rest of the
 * pipeline, which stores it as an opaque, never-decoded blob.
 */
async function assertImageWithinPixelLimit(buf: Buffer): Promise<void> {
  const sharp = await loadSharp();
  if (!sharp) return;
  let meta: { width?: number; height?: number; pages?: number };
  try {
    // limitInputPixels:false so metadata() can READ the declared dimensions
    // even when they're abusive — metadata is header-only (no pixel decode,
    // no large allocation; ~1ms even on a gigapixel header), so disabling
    // the limit here is safe. We then enforce the cap ourselves below. The
    // numeric cap stays on the actual DECODE paths (encodeWebp, the sweep),
    // where it prevents sharp from ever allocating beyond it. (With the cap
    // set HERE, metadata() would itself throw on a bomb, and the catch would
    // silently treat it as an opaque file instead of rejecting it.)
    meta = await sharp(buf, {
      failOn: 'none',
      limitInputPixels: false,
    }).metadata();
  } catch {
    return; // not a decodable image header — treat as an opaque file
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const frames = meta.pages && meta.pages > 0 ? meta.pages : 1;
  if (exceedsPixelLimit(w, h, frames)) {
    const mp = Math.round(MAX_INPUT_PIXELS / 1_000_000);
    throw errors.badRequest(
      `image is too large to process (${w}×${h}` +
        `${frames > 1 ? ` × ${frames} frames` : ''} exceeds the ${mp} megapixel limit)`,
    );
  }
}

/**
 * Downscale + re-encode an image (path or buffer) to WebP. Returns null
 * if sharp is unavailable, the source is animated, or anything fails —
 * callers treat null as "leave the original alone". WebP keeps PNG
 * transparency and is dramatically smaller than PNG/JPEG at equivalent
 * quality, so it's our canonical "compressed" target on both the upload
 * backstop and the admin re-compress action.
 */
async function encodeWebp(
  input: string | Buffer,
  opts: { maxDim: number; quality: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharpFn?: any,
): Promise<{ data: Buffer; width: number | null; height: number | null } | null> {
  const sharp = sharpFn ?? (await loadSharp());
  if (!sharp) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let img: any = sharp(input, {
      failOn: 'none',
      limitInputPixels: MAX_INPUT_PIXELS,
    }).rotate();
    const meta = await img.metadata();
    if ((meta.pages ?? 1) > 1) return null; // animated — don't flatten
    if (meta.width && meta.height && Math.max(meta.width, meta.height) > opts.maxDim) {
      img = img.resize({ width: opts.maxDim, height: opts.maxDim, fit: 'inside', withoutEnlargement: true });
    }
    const out = await img.webp({ quality: opts.quality }).toBuffer({ resolveWithObject: true });
    return { data: out.data, width: out.info?.width ?? null, height: out.info?.height ?? null };
  } catch {
    return null;
  }
}

/**
 * After converting a stored file to a new (WebP) filename, repoint every
 * DB reference from the old CDN URL to the new one. Matched by the file's
 * unique `/cdn/<id>/` directory prefix, so it's correct regardless of how
 * the filename was encoded. Covers the attachments row (chat files, where
 * we also fix filename/content-type/size) plus every URL-bearing column.
 */
async function rewriteFileReferences(
  id: bigint,
  newName: string,
  newSize: number,
  width: number | null,
  height: number | null,
): Promise<void> {
  const { db, schema } = await import('../db');
  const { eq, like } = await import('drizzle-orm');
  const idStr = id.toString();
  const newUrl = `/cdn/${idStr}/${encodeURIComponent(newName)}`;
  const prefix = `/cdn/${idStr}/%`;

  // Chat attachment row — fix the descriptive columns too, and stamp
  // compressed_at so the periodic same-format sweep skips it.
  await db
    .update(schema.attachments)
    .set({
      url: newUrl,
      filename: newName,
      contentType: 'image/webp',
      size: newSize,
      width: width ?? undefined,
      height: height ?? undefined,
      compressedAt: new Date(),
    })
    .where(eq(schema.attachments.id, id));

  // URL-bearing columns — same set the referenced-map scanner reads.
  await db.update(schema.users).set({ avatarUrl: newUrl }).where(like(schema.users.avatarUrl, prefix));
  await db.update(schema.users).set({ bannerUrl: newUrl }).where(like(schema.users.bannerUrl, prefix));
  await db.update(schema.guilds).set({ iconUrl: newUrl }).where(like(schema.guilds.iconUrl, prefix));
  await db.update(schema.guilds).set({ bannerUrl: newUrl }).where(like(schema.guilds.bannerUrl, prefix));
  await db.update(schema.guildMembers).set({ avatarUrl: newUrl }).where(like(schema.guildMembers.avatarUrl, prefix));
  await db.update(schema.scheduledEvents).set({ imageUrl: newUrl }).where(like(schema.scheduledEvents.imageUrl, prefix));
  await db.update(schema.guildEmojis).set({ url: newUrl }).where(like(schema.guildEmojis.url, prefix));
  await db.update(schema.stickers).set({ url: newUrl }).where(like(schema.stickers.url, prefix));
  await db.update(schema.webhooks).set({ avatarUrl: newUrl }).where(like(schema.webhooks.avatarUrl, prefix));
  await db.update(schema.channels).set({ dmIconUrl: newUrl }).where(like(schema.channels.dmIconUrl, prefix));
}

/**
 * Admin "Compress" action: convert a stored image to WebP to reclaim
 * space, then repoint all references so URLs stay valid and the file's
 * "compressed" badge flips. This is the explicit, on-demand counterpart
 * to the periodic same-format sweep — and the backstop for any image
 * that bypassed client-side compression. `sharp` is loaded lazily; if
 * it's missing the action fails with a clear message and nothing else is
 * affected. Writes atomically (tmp + rename) and only commits if smaller.
 */
export async function compressStorageItem(
  attachmentId: bigint,
  opts?: { maxDimension?: number; quality?: number },
): Promise<{ changed: boolean; beforeBytes: number; afterBytes: number }> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = path.join(env.UPLOAD_DIR, attachmentId.toString());

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    throw new Error('File not found');
  }
  const name = names[0];
  if (!name) throw new Error('File not found');

  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const SUPPORTED = ['png', 'jpg', 'jpeg', 'webp', 'tiff', 'tif'];
  if (!SUPPORTED.includes(ext)) {
    throw new Error('Only PNG, JPEG, WebP, and TIFF images can be compressed');
  }

  const filePath = path.join(dir, name);
  const before = (await fs.stat(filePath)).size;

  const sharp = await loadSharp();
  if (!sharp) {
    throw new Error('Image compression is unavailable on this server (sharp not installed)');
  }

  const webp = await encodeWebp(
    filePath,
    { maxDim: opts?.maxDimension ?? 1920, quality: opts?.quality ?? 80 },
    sharp,
  );
  // null = animated or a decode failure → leave it untouched.
  if (!webp) return { changed: false, beforeBytes: before, afterBytes: before };
  // No size win (already-optimal webp) → keep the original bytes.
  if (webp.data.length >= before) {
    return { changed: false, beforeBytes: before, afterBytes: before };
  }

  const newName = `${name.replace(/\.[^.]+$/, '')}.webp`;
  const newPath = path.join(dir, newName);
  const tmpPath = path.join(dir, `.${newName}.compress.tmp`);
  await fs.writeFile(tmpPath, webp.data);
  await fs.rename(tmpPath, newPath);
  // Remove the old file if the extension changed (png→webp etc.).
  if (newName !== name) {
    await fs.unlink(filePath).catch(() => {});
  }

  await rewriteFileReferences(attachmentId, newName, webp.data.length, webp.width, webp.height);
  invalidateStorageScan();

  return { changed: true, beforeBytes: before, afterBytes: webp.data.length };
}

export async function runAttachmentGcSweep(): Promise<{
  scanned: number;
  deleted: number;
}> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  // 1 hour grace — protects in-flight uploads from being raced by
  // the GC during a long form-fill or slow claim path.
  const graceMs = 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - graceMs);

  let entries: string[];
  try {
    entries = await fs.readdir(env.UPLOAD_DIR);
  } catch {
    // Directory doesn't exist yet (fresh deployment, no uploads).
    return { scanned: 0, deleted: 0 };
  }

  const referenced = await buildReferencedAttachmentSet();

  // Walk the disk entries, delete any that are unreferenced AND old
  // enough. Skip names that aren't snowflake-shaped (defensive against
  // stray files in the upload root).
  let deleted = 0;
  for (const entry of entries) {
    if (referenced.has(entry)) continue;
    if (!/^\d+$/.test(entry)) continue;
    const dirPath = path.join(env.UPLOAD_DIR, entry);
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;
      if (stat.mtime.getTime() > cutoff.getTime()) continue;
      await fs.rm(dirPath, { recursive: true, force: true });
      deleted++;
    } catch (err) {
      console.warn(`attachment GC: failed to process ${entry}`, err);
    }
  }

  if (deleted > 0) invalidateStorageScan();
  return { scanned: entries.length, deleted };
}
