/**
 * Emojis service
 * --------------
 * Custom guild emoji — uploaded as PNG/GIF/WebP files, referenced from
 * messages and reactions as :name: tokens. Storage:
 *
 *   guild_emojis row holds id, guildId, name, url, animated, uploadedBy
 *   The file lives at ${UPLOAD_DIR}/<emojiId>/<filename> just like
 *   message attachments and avatars. The CDN route fans out to the
 *   right storage class via progressive fall-through (attachment →
 *   avatar → emoji). Sharing the storage tree keeps disk layout
 *   simple and lets a single `rm -rf <UPLOAD_DIR>/<id>` cleanup
 *   uniformly across all kinds of uploads.
 *
 * Naming rules: lowercase letters, digits, underscores; 2–32 chars.
 * Names must be unique within a guild (enforced by a unique index).
 *
 * File rules: tighter than avatars — image/png, image/gif, image/webp
 * only (no JPEG since emoji benefit from transparency); cap at 512 KB
 * pre-resize because emoji are small at render time and big sources
 * waste disk + CDN bandwidth without visual benefit.
 */

import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { saveUploadedFile } from './uploads';
import { writeAudit } from './audit';

export const EMOJI_CONTENT_TYPES = new Set<string>([
  'image/png',
  'image/gif',
  'image/webp',
]);
/** Per-emoji size cap. 512 KB comfortably accommodates animated GIF
    while keeping a guild's emoji storage budget bounded. */
export const EMOJI_MAX_BYTES = 512 * 1024;
/** Per-guild emoji slot cap. Discord defaults to 50 for free servers;
    we mirror that as a sensible default — operators can raise via
    schema later if a guild needs more. */
export const EMOJI_PER_GUILD_LIMIT = 50;

export const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;

export async function listGuildEmojis(guildId: bigint) {
  return db
    .select()
    .from(schema.guildEmojis)
    .where(eq(schema.guildEmojis.guildId, guildId));
}

export async function getGuildEmoji(emojiId: bigint) {
  const r = await db
    .select()
    .from(schema.guildEmojis)
    .where(eq(schema.guildEmojis.id, emojiId))
    .limit(1);
  return r[0] ?? null;
}

/**
 * Look up an emoji by URL. Used by the CDN handler's fall-through
 * branch — when we get a `/cdn/<id>/<file>` request that doesn't
 * match a message attachment OR an avatar, this is the third place
 * we check. Lighter than scanning by guildId since the URL is
 * unique-by-id anyway.
 */
export async function getGuildEmojiByUrl(url: string) {
  const r = await db
    .select()
    .from(schema.guildEmojis)
    .where(eq(schema.guildEmojis.url, url))
    .limit(1);
  return r[0] ?? null;
}

interface CreateEmojiInput {
  guildId: bigint;
  name: string;
  file: File;
  uploaderId: bigint;
}

export async function createGuildEmoji(input: CreateEmojiInput) {
  // ── Validation ──────────────────────────────────────────────────
  // We do all front-loaded checks before touching disk so the only
  // way to get a partial state is a crash mid-insert (which the
  // transactional insert below makes recoverable on the next try
  // since the file is keyed by snowflake — duplicate uploads under
  // the same id can't happen because ids are unique-per-call).
  if (!EMOJI_NAME_RE.test(input.name)) {
    throw errors.badRequest(
      'Emoji name must be 2–32 characters: lowercase letters, digits, and underscores only',
    );
  }
  if (!EMOJI_CONTENT_TYPES.has(input.file.type)) {
    throw errors.badRequest('Emoji must be a PNG, GIF, or WebP image');
  }
  if (input.file.size > EMOJI_MAX_BYTES) {
    throw errors.payloadTooLarge(
      `Emoji file exceeds ${Math.round(EMOJI_MAX_BYTES / 1024)} KB limit`,
    );
  }

  // Slot limit. We enforce in-app rather than via DB constraint so the
  // error message can carry the limit number. Race-condition window
  // (two parallel uploads both seeing N-1 of N) is acceptable; worst
  // case the guild ends up with 51 emojis temporarily until someone
  // notices and deletes one.
  const existing = await listGuildEmojis(input.guildId);
  if (existing.length >= EMOJI_PER_GUILD_LIMIT) {
    throw errors.badRequest(
      `Guild has reached the emoji limit (${EMOJI_PER_GUILD_LIMIT}). Delete one to add another.`,
    );
  }
  if (existing.some((e) => e.name === input.name)) {
    throw errors.conflict(`An emoji named ":${input.name}:" already exists in this guild`);
  }

  // Save the file to disk; saved.url has the public /cdn/<id>/<name>
  // shape we want. We then write the row referencing that URL.
  const saved = await saveUploadedFile(input.file);
  const animated = input.file.type === 'image/gif';

  const [row] = await db
    .insert(schema.guildEmojis)
    .values({
      id: saved.attachmentId,
      guildId: input.guildId,
      name: input.name,
      url: saved.url,
      animated,
      uploadedBy: input.uploaderId,
    })
    .returning();
  if (!row) throw errors.internal('Emoji insert returned no row');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.uploaderId,
    action: 'emoji.create',
    targetType: 'emoji',
    targetId: row.id,
    changes: { name: row.name },
  });

  return row;
}

interface RenameEmojiInput {
  guildId: bigint;
  emojiId: bigint;
  newName: string;
  actorId: bigint;
}

export async function renameGuildEmoji(input: RenameEmojiInput) {
  if (!EMOJI_NAME_RE.test(input.newName)) {
    throw errors.badRequest(
      'Emoji name must be 2–32 characters: lowercase letters, digits, and underscores only',
    );
  }

  // Read first so we can audit-log the old name and confirm scope.
  const existing = await db
    .select()
    .from(schema.guildEmojis)
    .where(
      and(
        eq(schema.guildEmojis.id, input.emojiId),
        eq(schema.guildEmojis.guildId, input.guildId),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) throw errors.notFound('Emoji');

  if (row.name === input.newName) return row;

  // Unique-violation translation: drizzle bubbles up the Postgres
  // error code `23505`; we catch and rethrow as a friendlier 409.
  try {
    const [updated] = await db
      .update(schema.guildEmojis)
      .set({ name: input.newName })
      .where(eq(schema.guildEmojis.id, input.emojiId))
      .returning();
    if (!updated) throw errors.notFound('Emoji');

    await writeAudit({
      guildId: input.guildId,
      actorId: input.actorId,
      action: 'emoji.rename',
      targetType: 'emoji',
      targetId: input.emojiId,
      changes: { from: row.name, to: input.newName },
    });

    return updated;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw errors.conflict(`An emoji named ":${input.newName}:" already exists in this guild`);
    }
    throw err;
  }
}

interface DeleteEmojiInput {
  guildId: bigint;
  emojiId: bigint;
  actorId: bigint;
}

export async function deleteGuildEmoji(input: DeleteEmojiInput) {
  // Read for audit attribution before delete.
  const existing = await db
    .select()
    .from(schema.guildEmojis)
    .where(
      and(
        eq(schema.guildEmojis.id, input.emojiId),
        eq(schema.guildEmojis.guildId, input.guildId),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) throw errors.notFound('Emoji');

  await db
    .delete(schema.guildEmojis)
    .where(eq(schema.guildEmojis.id, input.emojiId));

  // We DON'T currently rm the file from disk. Reactions that referenced
  // this emoji could still want to render it as a tombstone (Discord
  // lets you see "X reacted with :deleted_emoji:" in a faded state),
  // and an orphan file is cheaper than a foreign-key cascade across a
  // potentially-large reactions table. Garbage collection of orphan
  // files is a future op task.

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: 'emoji.delete',
    targetType: 'emoji',
    targetId: input.emojiId,
    changes: { name: row.name },
  });

  return row;
}
