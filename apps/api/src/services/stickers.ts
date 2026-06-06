/**
 * Stickers service
 * ----------------
 * Custom guild stickers — uploaded PNG/GIF/WebP/APNG files rendered as
 * standalone message bodies at ~160px. Like emoji but bigger and
 * picker-only (no `:name:` shorthand).
 *
 * Storage shares the existing `${UPLOAD_DIR}/<id>/<filename>` tree with
 * attachments + emojis + avatars. The CDN handler's progressive
 * fall-through resolves a sticker URL by id when no attachment, avatar,
 * or emoji match it.
 *
 * Permission gate: MANAGE_EMOJIS — Discord uses one combined
 * MANAGE_EMOJIS_AND_STICKERS bit and we do the same. The bit's name in
 * our enum stays MANAGE_EMOJIS for backwards compat, but it covers
 * stickers too.
 *
 * Validation:
 *   - Name 2-30 chars, free-form (no charset restriction beyond
 *     trimming and the unique-per-guild constraint)
 *   - Description optional, ≤100 chars
 *   - File: PNG, APNG, GIF, or WebP only; cap at 512 KB pre-resize
 *   - Slot cap: 50 per guild (mirrors Discord's free-tier cap)
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { saveUploadedFile, deleteAttachmentFile } from './uploads';
import { writeAudit } from './audit';

export const STICKER_CONTENT_TYPES = new Set<string>([
  'image/png',
  'image/apng',
  'image/gif',
  'image/webp',
]);
/** 512 KB. Matches the emoji cap; stickers are rendered at ~160px so
    bigger source files would mostly waste disk + CDN bandwidth. */
export const STICKER_MAX_BYTES = 512 * 1024;
/** Per-guild slot cap. Operators can lift this server-side later if a
    guild really needs more — for v1 we mirror Discord's defaults. */
export const STICKER_PER_GUILD_LIMIT = 50;

const NAME_MIN = 2;
const NAME_MAX = 30;
const DESC_MAX = 100;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
    throw errors.badRequest(`Sticker name must be ${NAME_MIN}-${NAME_MAX} characters`);
  }
  return trimmed;
}

function validateDescription(desc: string | null | undefined): string | null {
  if (desc === null || desc === undefined) return null;
  const trimmed = desc.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > DESC_MAX) {
    throw errors.badRequest(`Sticker description must be ${DESC_MAX} chars or fewer`);
  }
  return trimmed;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function listGuildStickers(guildId: bigint) {
  return db
    .select()
    .from(schema.stickers)
    .where(eq(schema.stickers.guildId, guildId));
}

export async function getSticker(stickerId: bigint) {
  const r = await db
    .select()
    .from(schema.stickers)
    .where(eq(schema.stickers.id, stickerId))
    .limit(1);
  return r[0] ?? null;
}

/** Look up by URL — used by the CDN handler's fall-through (4th branch
    after attachment / avatar / emoji). Lighter than scanning by id
    because the URL itself is unique-by-id (snowflake-keyed path). */
export async function getStickerByUrl(url: string) {
  const r = await db
    .select()
    .from(schema.stickers)
    .where(eq(schema.stickers.url, url))
    .limit(1);
  return r[0] ?? null;
}

// ── Create ───────────────────────────────────────────────────────────────

interface CreateStickerInput {
  guildId: bigint;
  name: string;
  description: string | null;
  file: File;
  uploaderId: bigint;
}

export async function createSticker(input: CreateStickerInput) {
  const name = validateName(input.name);
  const description = validateDescription(input.description);

  if (!STICKER_CONTENT_TYPES.has(input.file.type)) {
    throw errors.badRequest('Sticker must be a PNG, APNG, GIF, or WebP image');
  }
  if (input.file.size > STICKER_MAX_BYTES) {
    throw errors.payloadTooLarge(
      `Sticker file exceeds ${Math.round(STICKER_MAX_BYTES / 1024)} KB limit`,
    );
  }

  // Slot + duplicate-name check. Same race-condition stance as emojis:
  // two parallel uploads can both see N-1 of N and both succeed; we
  // accept the rare "51 stickers" outcome rather than wrap with a
  // lock.
  const existing = await listGuildStickers(input.guildId);
  if (existing.length >= STICKER_PER_GUILD_LIMIT) {
    throw errors.badRequest(
      `Guild has reached the sticker limit (${STICKER_PER_GUILD_LIMIT}). Delete one to add another.`,
    );
  }
  if (existing.some((s) => s.name === name)) {
    throw errors.conflict(`A sticker named "${name}" already exists in this guild`);
  }

  const saved = await saveUploadedFile(input.file);
  const animated = input.file.type === 'image/gif' || input.file.type === 'image/apng';

  let row;
  try {
    [row] = await db
      .insert(schema.stickers)
      .values({
        id: saved.attachmentId,
        guildId: input.guildId,
        name,
        description,
        url: saved.url,
        animated,
        uploadedBy: input.uploaderId,
      })
      .returning();
  } catch (e) {
    // Roll back the on-disk file if the row insert fails. Without
    // this we'd accumulate orphan blobs every time someone hit the
    // unique-name constraint.
    await deleteAttachmentFile(saved.attachmentId);
    throw e;
  }
  if (!row) {
    await deleteAttachmentFile(saved.attachmentId);
    throw errors.internal('Sticker insert returned no row');
  }

  await writeAudit({
    guildId: input.guildId,
    actorId: input.uploaderId,
    action: 'sticker.create',
    targetType: 'sticker',
    targetId: row.id,
    changes: { name: row.name },
  });

  return row;
}

// ── Patch (rename / re-describe) ─────────────────────────────────────────

interface PatchStickerInput {
  guildId: bigint;
  stickerId: bigint;
  name?: string;
  description?: string | null;
  actorId: bigint;
}

export async function patchSticker(input: PatchStickerInput) {
  const existing = await getSticker(input.stickerId);
  if (!existing || existing.guildId !== input.guildId) {
    throw errors.notFound('Sticker');
  }

  const updates: Partial<schema.NewSticker> = {};
  const changes: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const newName = validateName(input.name);
    if (newName !== existing.name) {
      // Check guild-scoped uniqueness against the new name.
      const list = await listGuildStickers(input.guildId);
      if (list.some((s) => s.id !== existing.id && s.name === newName)) {
        throw errors.conflict(`A sticker named "${newName}" already exists in this guild`);
      }
      updates.name = newName;
      changes.name = { from: existing.name, to: newName };
    }
  }
  if (input.description !== undefined) {
    const newDesc = validateDescription(input.description);
    if (newDesc !== existing.description) {
      updates.description = newDesc;
      changes.description = { from: existing.description, to: newDesc };
    }
  }

  if (Object.keys(updates).length === 0) return existing;

  const [row] = await db
    .update(schema.stickers)
    .set(updates)
    .where(eq(schema.stickers.id, input.stickerId))
    .returning();
  if (!row) throw errors.internal('Sticker update returned no row');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: 'sticker.update',
    targetType: 'sticker',
    targetId: row.id,
    changes,
  });

  return row;
}

// ── Delete ───────────────────────────────────────────────────────────────

export async function deleteSticker(args: { guildId: bigint; stickerId: bigint; actorId: bigint }) {
  const existing = await getSticker(args.stickerId);
  if (!existing || existing.guildId !== args.guildId) {
    throw errors.notFound('Sticker');
  }

  // Drop the row first; the on-disk file goes second. If the file
  // delete fails, the row is gone and the file becomes garbage to be
  // collected by a future janitor. The reverse ordering would risk a
  // missing-file but DB-still-present sticker that returns 404s when
  // anyone tries to render it.
  await db.delete(schema.stickers).where(eq(schema.stickers.id, args.stickerId));
  await deleteAttachmentFile(args.stickerId).catch(() => {
    // Swallow; the row is gone, the next CDN request just 404s.
  });

  await writeAudit({
    guildId: args.guildId,
    actorId: args.actorId,
    action: 'sticker.delete',
    targetType: 'sticker',
    targetId: existing.id,
    changes: { name: existing.name },
  });

  return existing;
}
