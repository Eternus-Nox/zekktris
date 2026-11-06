/**
 * Stickers router
 * ---------------
 * Mounted at /api/v1/guilds/:guildId/stickers. CRUD over guild-scoped
 * stickers. Mirrors the emoji router's shape and conventions.
 *
 * Permissions:
 *   - LIST: any guild member (no extra bit). Members need to see the
 *     sticker catalogue to render messages that include stickers.
 *   - CREATE / PATCH / DELETE: MANAGE_EMOJIS bit on the caller (which
 *     covers stickers per Discord's combined MANAGE_EMOJIS_AND_STICKERS).
 *
 * Gateway: every mutation broadcasts a single GUILD_STICKERS_UPDATE
 * event with the current full list to the guild audience. Bulk-replace
 * over reconciliation — same approach as emojis.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { parseFormBody } from '../middleware/multipartCompat';
import { snowflakeSchema } from '../lib/validation';
import { toSticker } from '../lib/dto';
import * as stickers from '../services/stickers';
import {
  Permissions,
  ensureMember,
  assertGuildPermission,
} from '../services/permissions';
import * as dispatch from '../gateway/dispatch';

export const stickersRouter = new Hono();

stickersRouter.use('*', requireAuth);

async function broadcastList(guildId: bigint): Promise<void> {
  const list = await stickers.listGuildStickers(guildId);
  dispatch.guildStickersUpdate({
    guildId,
    stickers: list.map(toSticker),
  });
}

// ── LIST ───────────────────────────────────────────────────────────────────

stickersRouter.get(
  '/:guildId/stickers',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const list = await stickers.listGuildStickers(guildId);
    return c.json({ stickers: list.map(toSticker) });
  },
);

// ── CREATE (multipart) ─────────────────────────────────────────────────────

stickersRouter.post(
  '/:guildId/stickers',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EMOJIS);

    const form = await parseFormBody(c);
    const file = form.file;
    const name = typeof form.name === 'string' ? form.name : '';
    const description =
      typeof form.description === 'string' && form.description.length > 0
        ? form.description
        : null;
    if (!(file instanceof File)) {
      throw errors.badRequest('Missing file (expected multipart field "file")');
    }
    if (!name) {
      throw errors.badRequest('Missing sticker name (expected multipart field "name")');
    }

    const created = await stickers.createSticker({
      guildId,
      name,
      description,
      file,
      uploaderId: userId,
    });

    await broadcastList(guildId);
    return c.json({ sticker: toSticker(created) }, 201);
  },
);

// ── PATCH ──────────────────────────────────────────────────────────────────

const patchSchema = z
  .object({
    name: z.string().min(2).max(30).optional(),
    description: z.string().max(100).nullable().optional(),
  })
  .refine((d) => d.name !== undefined || d.description !== undefined, {
    message: 'At least one of name or description must be provided',
  });

stickersRouter.patch(
  '/:guildId/stickers/:stickerId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, stickerId: snowflakeSchema }),
  ),
  validate('json', patchSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, stickerId: sid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const stickerId = BigInt(sid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EMOJIS);

    const body = c.req.valid('json');
    const updated = await stickers.patchSticker({
      guildId,
      stickerId,
      name: body.name,
      description: body.description,
      actorId: userId,
    });

    await broadcastList(guildId);
    return c.json({ sticker: toSticker(updated) });
  },
);

// ── DELETE ─────────────────────────────────────────────────────────────────

stickersRouter.delete(
  '/:guildId/stickers/:stickerId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, stickerId: snowflakeSchema }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, stickerId: sid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const stickerId = BigInt(sid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EMOJIS);

    await stickers.deleteSticker({ guildId, stickerId, actorId: userId });

    await broadcastList(guildId);
    return c.json({ ok: true });
  },
);
