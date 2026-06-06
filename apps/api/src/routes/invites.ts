/**
 * Invites router
 * --------------
 * Mounted at /api/v1/invites. Preview is public; accept requires auth.
 * Per-guild listing and per-code deletion both require auth and the
 * MANAGE_INVITES permission.
 *
 * Per-channel invite *creation* lives in the channels router because the
 * channel context is what's authoritative.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { snowflakeSchema } from '../lib/validation';
import { toInvite, toInvitePreview, toGuild, toGuildMember } from '../lib/dto';
import * as invites from '../services/invites';
import * as guilds from '../services/guilds';
import * as members from '../services/members';
import * as welcome from '../services/welcome';
import * as permissions from '../services/permissions';
import * as dispatch from '../gateway/dispatch';
import {
  Permissions,
  assertGuildPermission,
} from '../services/permissions';
import { db, schema } from '../db';
import { eq, sql } from 'drizzle-orm';

export const invitesRouter = new Hono();

const codeSchema = z.string().min(1).max(64);

// ── PUBLIC: preview ────────────────────────────────────────────────────────

invitesRouter.get(
  '/:code',
  validate('param', z.object({ code: codeSchema })),
  async (c) => {
    const { code } = c.req.valid('param');
    const result = await invites.previewInvite(code);
    // Cheap COUNT(*) — the invite landing page wants to show
    // "X members" so visitors get a sense of community size before
    // committing to join. For huge servers this could be cached or
    // denormalized; at v1 scale a count per preview-load is fine.
    const countRow = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.guildId, result.guild.id));
    const memberCount = countRow[0]?.n ?? 0;
    return c.json({ invite: toInvitePreview(result.invite, result.guild, memberCount) });
  },
);

// ── AUTH'D: accept ─────────────────────────────────────────────────────────

invitesRouter.post(
  '/:code',
  requireAuth,
  validate('param', z.object({ code: codeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { code } = c.req.valid('param');
    const result = await invites.acceptInvite(code, userId);

    // Look up the freshly-joined guild + member for the dispatch payloads.
    // acceptInvite is idempotent (re-accepting from an existing membership
    // returns the same guild without inserting), so this lookup is harmless
    // either way.
    const [guild, memberDetailed] = await Promise.all([
      guilds.getGuild(result.guildId),
      members.getMemberDetailed(result.guildId, userId),
    ]);
    if (guild && memberDetailed && !result.alreadyMember) {
      // Compute the new member's viewable channels in this guild so the
      // gateway can seed their connection's cache atomically with the
      // guild-add. Without this, the user would join but receive no
      // channel events until they reconnect.
      const viewableChannelIds = await permissions.listViewableGuildChannelIds(
        result.guildId,
        userId,
      );
      dispatch.userJoinedGuild({
        userId,
        guildId: result.guildId,
        guildDTO: toGuild(guild),
        memberDTO: toGuildMember(memberDetailed.member, memberDetailed.user, memberDetailed.roleIds),
        viewableChannelIds,
      });
      // Post the welcome message AFTER userJoinedGuild — the
      // joiner needs the gateway subscription to this guild's
      // channels in place before we dispatch the MESSAGE_CREATE
      // for their greeting, or they won't see their own welcome.
      // Best-effort; failure here doesn't roll back the join.
      void welcome.postWelcomeMessage(result.guildId, userId);
    }

    return c.json({
      guildId: result.guildId.toString(),
      channelId: result.channelId.toString(),
    });
  },
);

// ── AUTH'D: delete ─────────────────────────────────────────────────────────

invitesRouter.delete(
  '/:code',
  requireAuth,
  validate('param', z.object({ code: codeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { code } = c.req.valid('param');

    // Resolve the guild id directly rather than via previewInvite() —
    // preview filters out expired and max-used codes (correctly, since
    // joining via them shouldn't work), but the owner should still be
    // able to clean those up from their server settings. A direct
    // select keeps the lookup permissive while still 404'ing on
    // genuinely non-existent codes.
    const row = await db
      .select({ guildId: schema.invites.guildId })
      .from(schema.invites)
      .where(eq(schema.invites.code, code))
      .limit(1);
    if (!row[0]) throw errors.notFound('Invite');
    await assertGuildPermission(row[0].guildId, userId, Permissions.MANAGE_INVITES);
    await invites.deleteInvite(code, userId);
    return c.json({ ok: true });
  },
);

// ── AUTH'D: list per guild ─────────────────────────────────────────────────
//
// Lives under /api/v1/guilds/:guildId/invites — exposed as its own router so
// server.ts can mount it within the guilds prefix.

export const guildInvitesRouter = new Hono();
guildInvitesRouter.use('*', requireAuth);

guildInvitesRouter.get(
  '/:guildId/invites',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_INVITES);

    const list = await invites.listGuildInvites(guildId);
    return c.json({ invites: list.map(toInvite) });
  },
);

// shim
void errors;
