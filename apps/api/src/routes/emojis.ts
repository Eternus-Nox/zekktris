/**
 * Emojis router
 * -------------
 * Mounted at /api/v1/guilds/:guildId/emojis. CRUD over guild-scoped
 * custom emoji.
 *
 * Permissions:
 *   - LIST: any guild member (no extra bit). Members need to see the
 *     emoji list to render :name: tokens in messages, even if they
 *     can't manage them.
 *   - CREATE / RENAME / DELETE: MANAGE_EMOJIS bit on the caller.
 *
 * Storage: file uploads land in the same /uploads tree as message
 * attachments and avatars (keyed by snowflake). The CDN handler's
 * fall-through resolves emoji URLs separately so we can scope access
 * to guild members only.
 *
 * Gateway: every mutation broadcasts a single GUILD_EMOJIS_UPDATE
 * event with the current full list to the guild audience. Bulk
 * payload simplifies client state — replace, don't reconcile.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { parseFormBody } from '../middleware/multipartCompat';
import { snowflakeSchema } from '../lib/validation';
import { toEmoji } from '../lib/dto';
import * as emojis from '../services/emojis';
import {
  Permissions,
  ensureMember,
  assertGuildPermission,
} from '../services/permissions';
import * as dispatch from '../gateway/dispatch';

export const emojisRouter = new Hono();

emojisRouter.use('*', requireAuth);

// ── helper ──────────────────────────────────────────────────────────────────
// Re-list and broadcast after every mutation. The bulk payload is the
// post-mutation truth, so consumers don't need to reconcile add/remove
// events; they just replace their local list.
async function broadcastList(guildId: bigint): Promise<void> {
  const list = await emojis.listGuildEmojis(guildId);
  dispatch.guildEmojisUpdate({
    guildId,
    emojis: list.map(toEmoji),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// LIST
// ───────────────────────────────────────────────────────────────────────────

emojisRouter.get(
  '/:guildId/emojis',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    // Membership check — non-members shouldn't even know what emojis
    // exist in a guild they can't see.
    await ensureMember(guildId, userId);
    const list = await emojis.listGuildEmojis(guildId);
    return c.json({ emojis: list.map(toEmoji) });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// CREATE
// ───────────────────────────────────────────────────────────────────────────
//
// Multipart form upload — `file` part holds the image, `name` part
// holds the :name: token. We deliberately don't accept JSON+url here
// (no "ingest from a remote URL" path) because that would expose us
// to SSRF and arbitrary download sizes.

emojisRouter.post(
  '/:guildId/emojis',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EMOJIS);

    const form = await parseFormBody(c);
    const file = form.file;
    const name = typeof form.name === 'string' ? form.name : '';
    if (!(file instanceof File)) {
      throw errors.badRequest('Missing file (expected multipart field "file")');
    }
    if (!name) {
      throw errors.badRequest('Missing emoji name (expected multipart field "name")');
    }

    const created = await emojis.createGuildEmoji({
      guildId,
      name,
      file,
      uploaderId: userId,
    });

    await broadcastList(guildId);
    return c.json({ emoji: toEmoji(created) }, 201);
  },
);

// ───────────────────────────────────────────────────────────────────────────
// RENAME
// ───────────────────────────────────────────────────────────────────────────

const renameSchema = z.object({
  name: z.string().min(2).max(32),
});

emojisRouter.patch(
  '/:guildId/emojis/:emojiId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, emojiId: snowflakeSchema }),
  ),
  validate('json', renameSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, emojiId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const emojiId = BigInt(eid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EMOJIS);

    const { name } = c.req.valid('json');
    const updated = await emojis.renameGuildEmoji({
      guildId,
      emojiId,
      newName: name,
      actorId: userId,
    });

    await broadcastList(guildId);
    return c.json({ emoji: toEmoji(updated) });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// DELETE
// ───────────────────────────────────────────────────────────────────────────

emojisRouter.delete(
  '/:guildId/emojis/:emojiId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, emojiId: snowflakeSchema }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, emojiId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const emojiId = BigInt(eid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EMOJIS);

    await emojis.deleteGuildEmoji({ guildId, emojiId, actorId: userId });

    await broadcastList(guildId);
    return c.json({ ok: true });
  },
);
