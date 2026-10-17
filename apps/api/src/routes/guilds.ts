/**
 * Guilds router
 * -------------
 * Mounted at /api/v1/guilds. Includes the guild root + sub-resources for
 * members, roles, and bans (all guild-scoped). Channels live under their
 * own /channels root because they're addressable independently.
 *
 * Permission checks use services/permissions: the route handler is the
 * thin layer that translates request → permission assertion → service call.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import { errors, AppError } from '../errors';
import { log } from '../log';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { RateLimiter } from '../lib/rateLimit';
import {
  snowflakeSchema,
  guildNameSchema,
  guildDescriptionSchema,
  roleNameSchema,
  colorSchema,
  permissionsSchema,
  displayNameSchema,
  nicknameSchema,
  bioSchema,
  cdnPathOrNullSchema,
} from '../lib/validation';
import {
  toGuild,
  toRole,
  toGuildMember,
  toBan,
  toPublicUser,
  toReport,
  toMessage,
  toReadState,
} from '../lib/dto';
import * as guilds from '../services/guilds';
import * as supervision from '../services/supervision';
import * as roles from '../services/roles';
import * as members from '../services/members';
import * as bans from '../services/bans';
import * as reactionRolesSvc from '../services/reactionRoles';
import * as guildBackup from '../services/guildBackup';
import * as reports from '../services/reports';
import * as messageSearch from '../services/messageSearch';
import * as messages from '../services/messages';
import * as permissions from '../services/permissions';
import * as readStates from '../services/readStates';
import * as voice from '../services/voice';
import { writeAudit } from '../services/audit';
import { leftVoiceStateDTO, toVoiceState } from '../lib/dto';
import * as dispatch from '../gateway/dispatch';
import {
  Permissions,
  ensureMember,
  assertGuildPermission,
  assertAnyGuildPermission,
  assertCanManageRole,
  assertCanManageMember,
  computeMemberGuildPermissions,
  computeMemberChannelPermissions,
  hasPermission,
} from '../services/permissions';
import * as botsSvc from '../services/bots';
import { assertNotInstanceMuted } from '../services/instanceMutes';
import { enforceGuildSendGates } from '../services/messageGates';

export const guildsRouter = new Hono();

guildsRouter.use('*', requireAuth);

/**
 * Enforce the role-hierarchy ceiling on a set of TARGET positions. A
 * non-owner without the ADMINISTRATOR bit cannot move — or PATCH — any role
 * to a position at or above their own highest role: doing so would elevate
 * that role's members above the actor and everyone in between, a privilege-
 * escalation backdoor. Owners and admin-bit holders have no ceiling.
 * Shared by the role-reorder endpoint and the single-role PATCH handler
 * (which previously only checked a role's CURRENT position via
 * assertCanManageRole, letting a moderator raise a managed role above
 * themselves through body.position).
 */
async function assertTargetPositionsWithinCeiling(
  guildId: bigint,
  userId: bigint,
  targets: Array<{ id: bigint; position: number }>,
): Promise<void> {
  const guildRow = await db
    .select({ ownerId: schema.guilds.ownerId })
    .from(schema.guilds)
    .where(eq(schema.guilds.id, guildId))
    .limit(1);
  if (guildRow[0]?.ownerId === userId) return;

  const callerPerms = await computeMemberGuildPermissions(guildId, userId);
  if (hasPermission(callerPerms, Permissions.ADMINISTRATOR)) return;

  const callerMember = await members.getMemberDetailed(guildId, userId);
  const callerRoles = callerMember?.roleIds ?? [];
  let actorTop = 0;
  if (callerRoles.length > 0) {
    const roleRows = await db
      .select({ position: schema.roles.position })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.guildId, guildId),
          inArray(schema.roles.id, callerRoles),
        ),
      );
    for (const r of roleRows) {
      if (r.position > actorTop) actorTop = r.position;
    }
  }
  for (const { id, position } of targets) {
    if (id === guildId) continue;
    if (position >= actorTop) {
      throw errors.forbidden(
        'You cannot move a role to a position at or above your highest role',
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Guild CRUD
// ═══════════════════════════════════════════════════════════════════════════

const createGuildSchema = z.object({
  name: guildNameSchema,
  description: guildDescriptionSchema.optional(),
  /** Server-produced /cdn/ path or null. External URLs rejected — see
      cdnPathOrNullSchema for security rationale. */
  iconUrl: cdnPathOrNullSchema.optional(),
});

guildsRouter.post('/', validate('json', createGuildSchema), async (c) => {
  const userId = requireUserId(c);
  const body = c.req.valid('json');
  // Parental controls: a supervised child can be barred from creating
  // servers. Pure privilege toggle — no request flow (there's no
  // specific target for a parent to approve).
  const restr = await supervision.getEffectiveRestrictions(userId);
  if (restr && !restr.allowCreateGuild) {
    throw new AppError('FORBIDDEN', 'Creating servers is restricted by your parent', {
      supervisionRestricted: 'create_guild',
    });
  }
  const result = await guilds.createGuild({
    ownerId: userId,
    name: body.name,
    description: body.description ?? null,
    iconUrl: body.iconUrl ?? null,
  });
  const guild = await guilds.getGuild(result.guildId);
  if (!guild) throw errors.internal('Guild creation lost');

  // Wire the new guild into the creator's gateway connection — without
  // this, an open WS would not receive any events from the new guild
  // until reconnect (its guildIds snapshot wouldn't include the new id).
  // Owner has ADMINISTRATOR by definition so listViewableGuildChannelIds
  // returns every channel here.
  const memberDetailed = await members.getMemberDetailed(result.guildId, userId);
  const viewableChannelIds = await permissions.listViewableGuildChannelIds(
    result.guildId,
    userId,
  );
  if (memberDetailed) {
    dispatch.userJoinedGuild({
      userId,
      guildId: result.guildId,
      guildDTO: toGuild(guild),
      memberDTO: toGuildMember(memberDetailed.member, memberDetailed.user, memberDetailed.roleIds),
      viewableChannelIds,
    });
  }

  return c.json({ guild: toGuild(guild), defaultChannelId: result.defaultChannelId.toString() }, 201);
});

// ═══════════════════════════════════════════════════════════════════════════
// Backup / Restore
// ═══════════════════════════════════════════════════════════════════════════
//
// GET  /guilds/:guildId/export  → full config + images as a JSON backup
// POST /guilds/import           → rebuild a backup as a NEW guild (clone)
//
// Export needs MANAGE_GUILD on the source. Import is a guild *creation* —
// it mints a brand-new guild owned by the caller and never touches the
// source — so it's gated like create (incl. the supervision restriction)
// rather than against any existing guild.

guildsRouter.get(
  '/:guildId/export',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);
    const backup = await guildBackup.exportGuild(guildId);
    return c.json(backup);
  },
);

const backupImageSchema = z.object({
  // ~20 MB decoded ceiling; icons/banners are far smaller in practice.
  dataBase64: z.string().max(28_000_000),
  contentType: z.string().max(100),
  filename: z.string().max(300),
});
const numericBigintString = z.string().regex(/^\d+$/, 'expected a numeric string');
const keyString = z.string().min(1).max(40);

const guildBackupSchema = z.object({
  format: z.literal('zekktris.guild-backup'),
  version: z.literal(1),
  exportedAt: z.string().max(64).optional(),
  sourceGuildId: keyString.optional(),
  guild: z.object({
    name: guildNameSchema,
    description: z.string().max(4000).nullable(),
    afkTimeoutSeconds: z.number().int().min(0).max(86_400),
    welcomeMessageEnabled: z.boolean(),
    welcomeMessageTemplate: z.string().max(4000).nullable(),
    rulesContent: z.string().max(20_000).nullable(),
    systemChannelKey: keyString.nullable(),
    afkChannelKey: keyString.nullable(),
    welcomeChannelKey: keyString.nullable(),
  }),
  roles: z
    .array(
      z.object({
        key: keyString,
        isEveryone: z.boolean(),
        name: z.string().min(1).max(100),
        color: z.number().int(),
        position: z.number().int(),
        permissions: numericBigintString,
        hoist: z.boolean(),
        mentionable: z.boolean(),
        selfAssignable: z.boolean(),
        description: z.string().max(4000).nullable(),
      }),
    )
    .max(1000),
  channels: z
    .array(
      z.object({
        key: keyString,
        type: z.enum([
          'guild_text',
          'guild_category',
          'guild_voice',
          'guild_stage',
          'guild_forum',
          'guild_link',
        ]),
        name: z.string().max(200).nullable(),
        topic: z.string().max(4000).nullable(),
        position: z.number().int(),
        nsfw: z.boolean(),
        rateLimitPerUser: z.number().int().min(0).max(86_400),
        // Mirror the http(s)-scheme validation the normal channel
        // create/patch routes enforce (channels.ts) so an imported backup
        // can't persist an arbitrary-scheme linkUrl (e.g. javascript:/data:)
        // that later reaches the web client's window.open navigation sink.
        linkUrl: z
          .string()
          .trim()
          .max(2048)
          .url()
          .refine((u) => /^https?:\/\//i.test(u), {
            message: 'Link URL must use http or https',
          })
          .nullable(),
        parentKey: keyString.nullable(),
      }),
    )
    .max(2000),
  overrides: z
    .array(
      z.object({
        channelKey: keyString,
        roleKey: keyString,
        allow: numericBigintString,
        deny: numericBigintString,
      }),
    )
    .max(20_000),
  images: z.object({
    icon: backupImageSchema.nullable(),
    banner: backupImageSchema.nullable(),
  }),
});

guildsRouter.post('/import', validate('json', guildBackupSchema), async (c) => {
  const userId = requireUserId(c);
  const body = c.req.valid('json');

  // Same supervision gate as create — import produces a new server.
  const restr = await supervision.getEffectiveRestrictions(userId);
  if (restr && !restr.allowCreateGuild) {
    throw new AppError('FORBIDDEN', 'Creating servers is restricted by your parent', {
      supervisionRestricted: 'create_guild',
    });
  }

  // Optional name override (?name=). The create-server flow sends the name
  // the user typed so it wins over the template/backup file's stored name.
  const nameOverride = c.req.query('name')?.trim() || undefined;
  const { guildId, defaultChannelId } = await guildBackup.importGuild(
    userId,
    body as guildBackup.GuildBackup,
    nameOverride,
  );
  const guild = await guilds.getGuild(guildId);
  if (!guild) throw errors.internal('Guild restore lost');

  // Wire the new guild into the importer's live gateway connection, exactly
  // as the create path does — otherwise an open socket sees nothing from the
  // restored guild until reconnect.
  const memberDetailed = await members.getMemberDetailed(guildId, userId);
  const viewableChannelIds = await permissions.listViewableGuildChannelIds(guildId, userId);
  if (memberDetailed) {
    dispatch.userJoinedGuild({
      userId,
      guildId,
      guildDTO: toGuild(guild),
      memberDTO: toGuildMember(
        memberDetailed.member,
        memberDetailed.user,
        memberDetailed.roleIds,
      ),
      viewableChannelIds,
    });
  }

  return c.json(
    { guild: toGuild(guild), defaultChannelId: defaultChannelId?.toString() ?? null },
    201,
  );
});

// ── Add a bot to this guild ───────────────────────────────────────────────
//
// POST /guilds/:guildId/bots  body: { botId }
//
// Adds an existing bot account as a member of the guild. The actor
// must have MANAGE_GUILD (enforced in the service). The bot gains
// guild permissions through roles assigned to it afterward, exactly
// like a human member. Idempotent — re-adding a present bot is a no-op
// success.
guildsRouter.post(
  '/:guildId/bots',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', z.object({ botId: snowflakeSchema })),
  async (c) => {
    const actorId = requireUserId(c);
    const { guildId } = c.req.valid('param');
    const { botId } = c.req.valid('json');
    const bots = await import('../services/bots');
    await bots.addBotToGuild({
      botId: BigInt(botId),
      guildId: BigInt(guildId),
      actorId,
    });

    // Surface the bot to connected clients + wire its own gateway
    // (if connected) into the guild, mirroring invite-accept.
    const memberDetailed = await members.getMemberDetailed(
      BigInt(guildId),
      BigInt(botId),
    );
    const guild = await guilds.getGuild(BigInt(guildId));
    if (memberDetailed && guild) {
      const viewableChannelIds = await permissions.listViewableGuildChannelIds(
        BigInt(guildId),
        BigInt(botId),
      );
      dispatch.userJoinedGuild({
        userId: BigInt(botId),
        guildId: BigInt(guildId),
        guildDTO: toGuild(guild),
        memberDTO: toGuildMember(
          memberDetailed.member,
          memberDetailed.user,
          memberDetailed.roleIds,
        ),
        viewableChannelIds,
      });
    }
    return c.json({ ok: true });
  },
);

guildsRouter.get('/', async (c) => {
  const userId = requireUserId(c);
  const list = await guilds.listGuildsForUser(userId);
  return c.json({ guilds: list.map(toGuild) });
});

guildsRouter.get(
  '/:guildId',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const guild = await guilds.getGuild(guildId);
    if (!guild) throw errors.notFound('Guild');
    return c.json({ guild: toGuild(guild) });
  },
);

const patchGuildSchema = z
  .object({
    name: guildNameSchema.optional(),
    description: guildDescriptionSchema.optional(),
    /** Server-produced /cdn/ path or null. See cdnPathOrNullSchema. */
    iconUrl: cdnPathOrNullSchema.optional(),
    bannerUrl: cdnPathOrNullSchema.optional(),
    systemChannelId: snowflakeSchema.nullable().optional(),
    /** AFK voice channel id. Server validates it's a real voice
        channel in this guild before persisting. Null clears. */
    afkChannelId: snowflakeSchema.nullable().optional(),
    /** Idle threshold for the (v1.x) AFK auto-move. Bounded to a
        sensible 60s–3600s range so misconfigurations can't park
        a value that disables the feature or thrashes the sweep. */
    afkTimeoutSeconds: z.number().int().min(60).max(3600).optional(),
    /** Welcome message channel. Distinct from systemChannelId —
        servers commonly route join messages and other system
        messages to different rooms. Server validates it's a text
        channel in this guild. Null clears (welcome falls back to
        systemChannelId, then the first text channel). */
    welcomeChannelId: snowflakeSchema.nullable().optional(),
    welcomeMessageEnabled: z.boolean().optional(),
    /** Plain-text template. {user} substitutes to an @mention of
        the joining user. 1000-char cap matches the regular message
        content limit. Passed through the same stripUnsafeChars
        hygiene as other guild text fields (display names etc.). */
    welcomeMessageTemplate: z
      .string()
      .max(1000)
      .transform((s) =>
        // Same hygiene as displayName/nickname/etc. — strip C0/C1
        // control chars (except \n + \t), zero-width chars, bidi
        // overrides. The template renders verbatim into a synthetic
        // message; without this an attacker with MANAGE_GUILD could
        // hide RTL-override or zero-width chars in the welcome
        // banner.
        // eslint-disable-next-line no-control-regex
        s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
          .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
          .replace(/[\u202A-\u202E\u2066-\u2069]/g, ''),
      )
      .nullable()
      .optional(),
    /** Markdown rules content for the onboarding flow. Null/empty
        clears (removes the onboarding gate for new joiners). Same
        hygiene as the welcome template. 10 KB cap — plenty for the
        longest reasonable rules document. */
    rulesContent: z
      .string()
      .max(10_000)
      .transform((s) =>
        // eslint-disable-next-line no-control-regex
        s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
          .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
          .replace(/[\u202A-\u202E\u2066-\u2069]/g, ''),
      )
      .nullable()
      .optional(),
    // ── Raid protection ──
    /** Minimum account age (minutes) to join. 0 = no requirement.
        Capped at ~1 year. */
    minAccountAgeMinutes: z.number().int().min(0).max(525_600).optional(),
    /** Require a verified email to join. */
    requireVerifiedEmail: z.boolean().optional(),
    /** Hard lockdown — refuse all new joins. */
    raidModeEnabled: z.boolean().optional(),
    /** Join-rate auto-trigger: more than <count> joins within <seconds>
        flips raid mode on. Null on either disables the trigger. */
    joinRateLimitCount: z.number().int().min(0).max(1000).nullable().optional(),
    joinRateLimitSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

guildsRouter.patch(
  '/:guildId',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', patchGuildSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);

    const body = c.req.valid('json');

    // Validate channel references. Each (afkChannelId, systemChannelId,
    // welcomeChannelId) needs to point at a real, non-deleted channel
    // in THIS guild with the right type. Doing this up front gives the
    // user a clean 400 with the offending field rather than committing
    // a dangling id.
    const channelIdsToValidate: Array<{
      id: bigint;
      field: string;
      expectedType: 'guild_voice' | 'guild_text';
    }> = [];
    if (body.afkChannelId !== undefined && body.afkChannelId !== null) {
      channelIdsToValidate.push({
        id: BigInt(body.afkChannelId),
        field: 'afkChannelId',
        expectedType: 'guild_voice',
      });
    }
    if (body.systemChannelId !== undefined && body.systemChannelId !== null) {
      channelIdsToValidate.push({
        id: BigInt(body.systemChannelId),
        field: 'systemChannelId',
        expectedType: 'guild_text',
      });
    }
    if (body.welcomeChannelId !== undefined && body.welcomeChannelId !== null) {
      channelIdsToValidate.push({
        id: BigInt(body.welcomeChannelId),
        field: 'welcomeChannelId',
        expectedType: 'guild_text',
      });
    }
    if (channelIdsToValidate.length > 0) {
      const rows = await db
        .select({
          id: schema.channels.id,
          type: schema.channels.type,
          guildId: schema.channels.guildId,
        })
        .from(schema.channels)
        .where(
          and(
            inArray(
              schema.channels.id,
              channelIdsToValidate.map((c) => c.id),
            ),
            isNull(schema.channels.deletedAt),
          ),
        );
      const byId = new Map(rows.map((r) => [r.id.toString(), r]));
      for (const cv of channelIdsToValidate) {
        const found = byId.get(cv.id.toString());
        if (!found || found.guildId !== guildId || found.type !== cv.expectedType) {
          throw errors.badRequest(
            `${cv.field} must reference a ${cv.expectedType === 'guild_voice' ? 'voice' : 'text'} channel in this guild`,
          );
        }
      }
    }

    const patch = {
      name: body.name,
      description: body.description,
      iconUrl: body.iconUrl,
      bannerUrl: body.bannerUrl,
      systemChannelId:
        body.systemChannelId === undefined
          ? undefined
          : body.systemChannelId === null
            ? null
            : BigInt(body.systemChannelId),
      afkChannelId:
        body.afkChannelId === undefined
          ? undefined
          : body.afkChannelId === null
            ? null
            : BigInt(body.afkChannelId),
      afkTimeoutSeconds: body.afkTimeoutSeconds,
      welcomeChannelId:
        body.welcomeChannelId === undefined
          ? undefined
          : body.welcomeChannelId === null
            ? null
            : BigInt(body.welcomeChannelId),
      welcomeMessageEnabled: body.welcomeMessageEnabled,
      welcomeMessageTemplate: body.welcomeMessageTemplate,
      rulesContent: body.rulesContent,
      minAccountAgeMinutes: body.minAccountAgeMinutes,
      requireVerifiedEmail: body.requireVerifiedEmail,
      raidModeEnabled: body.raidModeEnabled,
      joinRateLimitCount: body.joinRateLimitCount,
      joinRateLimitSeconds: body.joinRateLimitSeconds,
    };
    const updated = await guilds.updateGuild(guildId, patch, userId);
    return c.json({ guild: toGuild(updated) });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /guilds/:guildId/voice/states — everyone in voice in this server, now.
//
// The per-channel GET /channels/:id/voice/states already exists to heal a
// missed VOICE_STATE_UPDATE, but clients only ever called it for the channel
// they were IN. Every other voice channel in the sidebar was built from events
// alone, so a single dropped frame — a reconnect gap, or a connection whose
// cached viewable-channel set was computed before that channel existed — left
// people invisible to everyone outside the call until someone joined, at which
// point the join's snapshot made them "magically" appear.
//
// This is the whole-server version of that heal: one read for the sidebar the
// user is looking at, instead of one per voice channel.
//
// VISIBILITY: exactly the READY snapshot's rule — voice presence only in
// channels the caller can VIEW_CHANNEL, computed by the same resolver, so a
// private channel's occupants never leak through here either.
// ─────────────────────────────────────────────────────────────────────────────
guildsRouter.get(
  '/:guildId/voice/states',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await permissions.ensureMember(guildId, userId);
    const viewable = await permissions.listViewableGuildChannelIdsByGuild([guildId], userId);
    const channelIds = [...(viewable.get(guildId) ?? [])];
    const rows = await voice.listVoiceStatesForReady({
      viewableChannelIds: channelIds,
      dmChannelIds: [],
    });
    return c.json({ voiceStates: rows.map(toVoiceState) });
  },
);

guildsRouter.delete(
  '/:guildId',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    const guild = await guilds.getGuild(guildId);
    if (!guild) throw errors.notFound('Guild');
    if (guild.ownerId !== userId) {
      throw errors.forbidden('Only the owner can delete a guild');
    }

    // Capture the member list BEFORE the delete so we can broadcast
    // GUILD_DELETE to everyone who was a member. Without this,
    // connected members keep seeing the deleted guild in their
    // sidebar until they refresh or reconnect — the latent bug I
    // flagged in round 7's admin-delete work. The admin force-delete
    // path in routes/admin.ts already does this correctly; the
    // owner path was missing it.
    //
    // We read the rows here rather than inside deleteGuild() so the
    // service stays purely about the DB state change and the
    // gateway-broadcast concern lives in the route layer (matches
    // the rest of this codebase — services don't dispatch).
    const memberRows = await db
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.guildId, guildId));

    // Evict every user currently in voice within this guild. Without
    // this, LiveKit tokens stay valid up to ~1 hour and participants
    // keep streaming audio in rooms that belong to a guild that no
    // longer exists. Per-user dispatches let each client tear down
    // its local voice UI. Run BEFORE deleteGuild so the voice_states
    // FK to guilds is still intact at delete time (although ON DELETE
    // CASCADE on the FK would handle this, the LiveKit-side removeParticipant
    // needs the channel ids which we wouldn't have post-cascade).
    const evicted = await voice.evictAllVoiceInGuild(guildId);
    for (const vs of evicted) {
      dispatch.voiceStateUpdate({
        guildId,
        channelId: vs.channelId,
        voiceState: leftVoiceStateDTO({ userId: vs.userId, guildId, channelId: vs.channelId }),
      });
    }

    // Recorded BEFORE the purge: security_events.guild_id references guilds.id,
    // so this insert would fail once the row is gone — and purgeGuild stamps the
    // server's name onto exactly these rows on its way past, so the record still
    // reads properly afterwards. Deleting a server must not erase the fact that
    // it existed.
    try {
      const { logEvent } = await import('../services/security');
      await logEvent({
        kind: 'guild_self_delete',
        userId: null,
        actorId: userId,
        guildId,
        channelId: null,
        detail: `Server "${guild.name}" (${guildId}) deleted by its owner`,
      });
    } catch (err) {
      // Never block the deletion on the audit write.
      log.error('guild self-delete audit log failed', { err });
    }

    await guilds.deleteGuild(guildId, userId);

    const { guildDeletedBroadcast } = await import('../gateway/dispatch');
    guildDeletedBroadcast({
      guildId,
      memberIds: memberRows.map((r) => r.userId),
    });

    return c.json({ ok: true });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Icon / banner uploads. Same shape as POST /users/@me/avatar — multipart
// file upload to /uploads, then update the guild row, then broadcast
// GUILD_UPDATE so connected members see the change live. Two endpoints
// because each writes to a different column; sharing a single endpoint
// with a 'kind' field would mean parsing form fields ambiguously.
// ─────────────────────────────────────────────────────────────────────────────
const GUILD_IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

guildsRouter.post(
  '/:guildId/icon',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);

    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) {
      throw errors.badRequest('Missing file (expected multipart field "file")');
    }
    if (!GUILD_IMAGE_CONTENT_TYPES.has(file.type)) {
      throw errors.badRequest('Icon must be a PNG, JPEG, GIF, or WebP image');
    }

    const { saveUploadedFile, deleteAttachmentFile, parseCdnAttachmentId } =
      await import('../services/uploads');

    // Save outside the transaction (slow IO), then atomic swap
    // with SELECT FOR UPDATE so two concurrent icon uploads on
    // the same guild can't both capture the same prior id and
    // leak the loser's file on disk. See the avatar-upload
    // comment in routes/users.ts for the full trace; same race,
    // same fix.
    const saved = await saveUploadedFile(file);

    const { updated, priorIconId } = await db.transaction(async (tx) => {
      const [prior] = await tx
        .select({ iconUrl: schema.guilds.iconUrl })
        .from(schema.guilds)
        .where(eq(schema.guilds.id, guildId))
        .for('update')
        .limit(1);
      if (!prior) throw errors.notFound('Guild');
      const [u] = await tx
        .update(schema.guilds)
        .set({ iconUrl: saved.url, updatedAt: new Date() })
        .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
        .returning();
      if (!u) throw errors.notFound('Guild');
      // Audit inside the same tx so the trail commits with the
      // swap — if the audit insert fails, the URL swap rolls back
      // too, keeping the file pointer consistent with the audit.
      await writeAudit({
        tx,
        guildId,
        actorId: userId,
        action: 'guild.update',
        targetType: 'guild',
        targetId: guildId,
        changes: { iconUrl: saved.url },
      });
      return { updated: u, priorIconId: parseCdnAttachmentId(prior.iconUrl) };
    });

    if (priorIconId !== null && priorIconId !== saved.attachmentId) {
      void deleteAttachmentFile(priorIconId);
    }

    const dto = toGuild(updated);
    dispatch.guildUpdate(dto, guildId);
    return c.json({ guild: dto });
  },
);

guildsRouter.post(
  '/:guildId/banner',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);

    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) {
      throw errors.badRequest('Missing file (expected multipart field "file")');
    }
    if (!GUILD_IMAGE_CONTENT_TYPES.has(file.type)) {
      throw errors.badRequest('Banner must be a PNG, JPEG, GIF, or WebP image');
    }

    const { saveUploadedFile, deleteAttachmentFile, parseCdnAttachmentId } =
      await import('../services/uploads');

    // Same atomic-swap pattern as the icon path above.
    const saved = await saveUploadedFile(file);

    const { updated, priorBannerId } = await db.transaction(async (tx) => {
      const [prior] = await tx
        .select({ bannerUrl: schema.guilds.bannerUrl })
        .from(schema.guilds)
        .where(eq(schema.guilds.id, guildId))
        .for('update')
        .limit(1);
      if (!prior) throw errors.notFound('Guild');
      const [u] = await tx
        .update(schema.guilds)
        .set({ bannerUrl: saved.url, updatedAt: new Date() })
        .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
        .returning();
      if (!u) throw errors.notFound('Guild');
      await writeAudit({
        tx,
        guildId,
        actorId: userId,
        action: 'guild.update',
        targetType: 'guild',
        targetId: guildId,
        changes: { bannerUrl: saved.url },
      });
      return { updated: u, priorBannerId: parseCdnAttachmentId(prior.bannerUrl) };
    });

    if (priorBannerId !== null && priorBannerId !== saved.attachmentId) {
      void deleteAttachmentFile(priorBannerId);
    }

    const dto = toGuild(updated);
    dispatch.guildUpdate(dto, guildId);
    return c.json({ guild: dto });
  },
);

const transferSchema = z.object({ newOwnerId: snowflakeSchema });
guildsRouter.post(
  '/:guildId/transfer',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', transferSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await guilds.transferGuildOwnership(
      guildId,
      userId,
      BigInt(c.req.valid('json').newOwnerId),
    );
    // Refresh permission caches. Old owner loses ADMINISTRATOR (derived
    // from ownerId); new owner gains it. Both their cached viewable-
    // channel sets are stale until the gateway refreshes them. The
    // bulk helper is the conservative choice — it's a no-op per-user
    // when nothing actually changed for them.
    await dispatch.applyGuildPermissionChange({ guildId });
    return c.json({ ok: true });
  },
);

guildsRouter.post(
  '/:guildId/leave',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await guilds.leaveGuild(guildId, userId);

    // Symmetric voice eviction with kick/ban. Without this, a user
    // who's mid-voice-call and then leaves the guild keeps their
    // LiveKit token (valid up to 1 hour) and continues to talk and
    // listen in a guild they're no longer a member of. The helper
    // also calls LiveKit's RoomServiceClient.removeParticipant on
    // a best-effort basis so their audio stream actually stops.
    const priorVS = await voice.evictFromVoiceInGuild(userId, guildId);
    if (priorVS) {
      dispatch.voiceStateUpdate({
        guildId,
        channelId: priorVS.channelId,
        voiceState: leftVoiceStateDTO({ userId, guildId, channelId: priorVS.channelId }),
      });
    }

    dispatch.userLeftGuild({ userId, guildId });
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /guilds/:guildId/read  → mark every channel in the guild read
// ═══════════════════════════════════════════════════════════════════════════
//
// Backs the rail's long-press "Mark as Read". Advances the caller's read
// marker to each viewable channel's latest message and zeroes its mention
// count, in one round-trip. Dispatches a CHANNEL_ACK per touched channel so
// the user's OTHER devices reconcile their badges live; the JSON response
// lets the calling device update without a refetch. listViewableGuildChannelIds
// returns [] for a non-member, so that doubles as the membership gate.
guildsRouter.post(
  '/:guildId/read',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    const viewable = await permissions.listViewableGuildChannelIds(guildId, userId);
    const updated = await readStates.markGuildRead(userId, viewable);
    for (const r of updated) {
      dispatch.channelAck({
        userId,
        readState: toReadState({
          channelId: r.channelId,
          lastMessageId: r.lastMessageId,
          mentionCount: r.mentionCount,
        }),
      });
    }
    return c.json({
      readStates: updated.map((r) =>
        toReadState({
          channelId: r.channelId,
          lastMessageId: r.lastMessageId,
          mentionCount: r.mentionCount,
        }),
      ),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Members
// ═══════════════════════════════════════════════════════════════════════════

const listMembersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  after: snowflakeSchema.optional(),
});

guildsRouter.get(
  '/:guildId/members',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('query', listMembersQuery),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);

    const q = c.req.valid('query');
    const list = await members.listMembers(guildId, {
      limit: q.limit,
      after: q.after ? BigInt(q.after) : undefined,
    });
    return c.json({
      members: list.map((m) => toGuildMember(m.member, m.user, m.roleIds)),
    });
  },
);

guildsRouter.get(
  '/:guildId/members/:userId',
  validate(
    'param',
    z.object({
      guildId: snowflakeSchema,
      userId: snowflakeSchema,
    }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const { guildId: gid, userId: uid } = c.req.valid('param');
    const guildId = BigInt(gid);
    await ensureMember(guildId, callerId);

    const detailed = await members.getMemberDetailed(guildId, BigInt(uid));
    if (!detailed) throw errors.notFound('Member');
    return c.json({
      member: toGuildMember(detailed.member, detailed.user, detailed.roleIds),
    });
  },
);

const patchMemberSchema = z
  .object({
    roleIds: z.array(snowflakeSchema).optional(),
    /**
     * ISO-8601 timestamp for the member's communication disable. null
     * clears any existing timeout. Maximum 28 days in the future,
     * matching Discord's policy — long enough for cool-down periods
     * but short enough that an admin doesn't accidentally permanently
     * mute someone (use BAN for that).
     */
    communicationDisabledUntil: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

guildsRouter.patch(
  '/:guildId/members/:userId',
  validate(
    'param',
    z.object({
      guildId: snowflakeSchema,
      userId: snowflakeSchema,
    }),
  ),
  validate('json', patchMemberSchema),
  async (c) => {
    const callerId = requireUserId(c);
    const { guildId: gid, userId: uid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const targetId = uid === '@me' ? callerId : BigInt(uid);
    const body = c.req.valid('json');

    // ── Roles (replace whole set) ──
    if (body.roleIds !== undefined) {
      await assertGuildPermission(guildId, callerId, Permissions.MANAGE_ROLES);
      await assertCanManageMember(guildId, callerId, targetId);

      const desired = new Set(body.roleIds.map((s) => BigInt(s)).filter((id) => id !== guildId));
      const current = new Set(
        (await members.getMemberDetailed(guildId, targetId))?.roleIds ?? [],
      );

      // Diff: roles to add and to remove. Each modification's role-hierarchy
      // guard runs independently (you must outrank every role you touch).
      const toAdd = [...desired].filter((id) => !current.has(id));
      const toRemove = [...current].filter((id) => !desired.has(id));

      // Self-actions get a softer rule on REMOVE: a member is always
      // allowed to step down from any role they currently hold, even
      // their highest one. Without this exemption the strict hierarchy
      // check (target.position >= actorTop) blocks you from ever
      // dropping your top role — Discord allows the demotion, since
      // the user's already at-or-above that ceiling and can't escalate
      // by giving up a role. ADDs still go through the full check, so
      // a member can't grant themselves a role at or above their
      // current top (no escalation path).
      const isSelfChange = targetId === callerId;
      const rolesToCheck = isSelfChange ? toAdd : [...toAdd, ...toRemove];
      // Hierarchy checks are independent — each one just reads the
      // target role's position and compares against the actor's top
      // role. Running them sequentially with `await` per role meant a
      // 10-role change paid 10 sequential round-trips (each
      // assertCanManageRole loads the member's roles + the target
      // role row). Run in parallel; Promise.all surfaces the first
      // rejection just like the sequential loop did via its first
      // throw. Note we explicitly do NOT parallelize the
      // add/removeMemberRole calls below — those each write an audit
      // row (so order matters for ordering-by-time) and they touch the
      // same (guildId, userId) row in member_roles, so concurrent
      // INSERTs/DELETEs would serialize on the index anyway.
      await Promise.all(
        rolesToCheck.map((roleId) => assertCanManageRole(guildId, callerId, roleId)),
      );
      for (const roleId of toAdd) {
        await members.addMemberRole({ guildId, userId: targetId, roleId, actorId: callerId });
      }
      for (const roleId of toRemove) {
        await members.removeMemberRole({ guildId, userId: targetId, roleId, actorId: callerId });
      }

      // If the role set actually changed, refresh the target's gateway
      // visibility cache. Channel-permission overrides keyed on these
      // roles can flip VIEW_CHANNEL up or down, and the cache (computed
      // at IDENTIFY) would otherwise be stale until reconnect. The helper
      // is a no-op when the diff is empty per-connection, so calling it
      // unconditionally on any role-set submission is fine.
      if (toAdd.length > 0 || toRemove.length > 0) {
        await dispatch.applyMemberRoleChange({ userId: targetId, guildId });
      }
    }

    // ── Timeout (communication disabled) ──
    // Discord-style: while the column is set to a future timestamp,
    // sends/reactions/voice-joins from this user are rejected with a
    // TIMED_OUT error. Permission: MODERATE_MEMBERS. Hierarchy: same
    // as role/kick — you must outrank the target. Self-timeout is
    // rejected (locks the admin out of their own server, common
    // footgun). Max future is 28 days; past timestamps coerce to
    // null (clear) so an admin pasting an old date doesn't end up
    // with a nominally-set-but-already-expired row that looks active
    // in the UI.
    if (body.communicationDisabledUntil !== undefined) {
      if (targetId === callerId) {
        throw errors.badRequest('Cannot time yourself out');
      }
      await assertGuildPermission(guildId, callerId, Permissions.MODERATE_MEMBERS);
      await assertCanManageMember(guildId, callerId, targetId);

      let until: Date | null = null;
      if (body.communicationDisabledUntil !== null) {
        const parsed = new Date(body.communicationDisabledUntil);
        if (Number.isNaN(parsed.getTime())) {
          throw errors.badRequest('Invalid timeout timestamp');
        }
        const now = Date.now();
        const max = now + 28 * 24 * 60 * 60 * 1000;
        if (parsed.getTime() > max) {
          throw errors.badRequest('Timeout cannot be more than 28 days in the future');
        }
        // Past timestamps → null (clear). An admin pasting an old date
        // probably meant to clear, and rejecting feels pedantic.
        until = parsed.getTime() > now ? parsed : null;
      }

      await members.setMemberTimeout({
        guildId,
        userId: targetId,
        actorId: callerId,
        until,
      });
    }

    const updated = await members.getMemberDetailed(guildId, targetId);
    if (!updated) throw errors.notFound('Member');
    // Fanout the member update so all clients see the new timeout
    // state (or cleared state) in real time. Without this, the UI
    // wouldn't reflect the timeout until the next member-list refresh
    // or page reload.
    const memberDTO = toGuildMember(updated.member, updated.user, updated.roleIds);
    dispatch.guildMemberUpdate(memberDTO, guildId);
    return c.json({ member: memberDTO });
  },
);

guildsRouter.delete(
  '/:guildId/members/:userId',
  validate(
    'param',
    z.object({
      guildId: snowflakeSchema,
      userId: snowflakeSchema,
    }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const { guildId: gid, userId: uid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const targetId = BigInt(uid);

    await assertGuildPermission(guildId, callerId, Permissions.KICK_MEMBERS);
    await assertCanManageMember(guildId, callerId, targetId);
    await members.kickMember({ guildId, userId: targetId, actorId: callerId });

    // If the kicked user is currently in a voice channel within this
    // guild, evict them. Without this, the user keeps their LiveKit
    // token (valid up to 1 hour) and can keep talking + listening in
    // a guild they're no longer a member of. The helper also calls
    // LiveKit's RoomServiceClient.removeParticipant to drop them at
    // the SFU level — best-effort, so a LiveKit outage doesn't
    // prevent the kick.
    const priorVS = await voice.evictFromVoiceInGuild(targetId, guildId);
    if (priorVS) {
      dispatch.voiceStateUpdate({
        guildId,
        channelId: priorVS.channelId,
        voiceState: leftVoiceStateDTO({ userId: targetId, guildId, channelId: priorVS.channelId }),
      });
    }

    dispatch.userLeftGuild({ userId: targetId, guildId });
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Roles
// ═══════════════════════════════════════════════════════════════════════════

guildsRouter.get(
  '/:guildId/roles',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const list = await roles.listRoles(guildId);
    return c.json({ roles: list.map(toRole) });
  },
);

const createRoleSchema = z.object({
  name: roleNameSchema,
  color: colorSchema.optional(),
  permissions: permissionsSchema.optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});

guildsRouter.post(
  '/:guildId/roles',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', createRoleSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_ROLES);

    // You can never grant a role with permissions you don't have yourself
    // (otherwise an admin-but-not-owner could escalate via roles).
    const body = c.req.valid('json');
    if (body.permissions !== undefined) {
      const callerPerms = await computeMemberGuildPermissions(guildId, userId);
      if (!hasPermission(callerPerms, body.permissions)) {
        throw errors.forbidden('You cannot grant permissions you do not have yourself');
      }
    }

    const role = await roles.createRole({
      guildId,
      actorId: userId,
      name: body.name,
      color: body.color,
      permissions: body.permissions,
      hoist: body.hoist,
      mentionable: body.mentionable,
    });
    return c.json({ role: toRole(role) }, 201);
  },
);

const patchRoleSchema = z
  .object({
    name: roleNameSchema.optional(),
    color: colorSchema.optional(),
    permissions: permissionsSchema.optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    position: z.number().int().min(1).optional(),
    /** Toggle whether members can grant/revoke this role themselves
     *  via the self-assign endpoint. @everyone and managed roles are
     *  blocked at the service layer. */
    selfAssignable: z.boolean().optional(),
    /** Admin-set blurb for the Browse Roles UI. Empty/null clears.
     *  Same control-char hygiene as the welcome template and rules. */
    description: z
      .string()
      .max(200)
      .transform((s) =>
        // eslint-disable-next-line no-control-regex
        s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
          .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
          .replace(/[\u202A-\u202E\u2066-\u2069]/g, ''),
      )
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

guildsRouter.patch(
  '/:guildId/roles/:roleId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, roleId: snowflakeSchema }),
  ),
  validate('json', patchRoleSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, roleId: rid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const roleId = BigInt(rid);

    await assertCanManageRole(guildId, userId, roleId);
    const body = c.req.valid('json');

    // Hierarchy ceiling on the TARGET position. assertCanManageRole above
    // only proves the caller outranks the role at its CURRENT position; it
    // does not stop a moderator from raising a managed role to (or above)
    // their own top via body.position. Mirror the reorder-endpoint guard.
    if (body.position !== undefined) {
      await assertTargetPositionsWithinCeiling(guildId, userId, [
        { id: roleId, position: body.position },
      ]);
    }

    if (body.permissions !== undefined) {
      const callerPerms = await computeMemberGuildPermissions(guildId, userId);
      if (!hasPermission(callerPerms, body.permissions)) {
        throw errors.forbidden('You cannot grant permissions you do not have yourself');
      }
    }

    const updated = await roles.updateRole({
      guildId,
      actorId: userId,
      roleId,
      name: body.name,
      color: body.color,
      permissions: body.permissions,
      hoist: body.hoist,
      mentionable: body.mentionable,
      position: body.position,
      selfAssignable: body.selfAssignable,
      description: body.description,
    });
    const roleDTO = toRole(updated);
    dispatch.guildRoleUpdate(roleDTO, guildId);
    // If the role's permission bits changed, every connected member of
    // this guild who holds the role could see their channel visibility
    // shift (the role's allow/deny bits feed into computeChannelPermissions
    // alongside any per-channel overrides keyed on the role). The cheap
    // safe thing is to refresh every connected guild member; the helper
    // is a no-op when a user's diff is empty so it's harmless when the
    // change was just a name/color/hoist tweak that can't affect VIEW_CHANNEL.
    if (body.permissions !== undefined) {
      await dispatch.applyGuildPermissionChange({ guildId });
    }
    return c.json({ role: roleDTO });
  },
);

guildsRouter.delete(
  '/:guildId/roles/:roleId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, roleId: snowflakeSchema }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, roleId: rid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const roleId = BigInt(rid);

    await assertCanManageRole(guildId, userId, roleId);
    await roles.deleteRole(guildId, roleId, userId);
    // Refresh viewable channels for everyone in the guild — the deleted
    // role may have unlocked channels via VIEW_CHANNEL overrides;
    // members who had the role have lost it (member_roles cascade)
    // and their connection cache must be updated or they'll keep
    // seeing channels they can no longer access until reconnect.
    await dispatch.applyGuildPermissionChange({ guildId });
    return c.json({ ok: true });
  },
);

const reorderRolesSchema = z.object({
  positions: z
    .array(z.object({ id: snowflakeSchema, position: z.number().int().min(1) }))
    .min(1),
});

guildsRouter.patch(
  '/:guildId/roles',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', reorderRolesSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_ROLES);

    const positions = c.req.valid('json').positions.map((p) => ({
      id: BigInt(p.id),
      position: p.position,
    }));
    // Caller must outrank every role being moved. This is the
    // existing hierarchy guard ("you can't manage roles at or
    // above your top"). It checks each role's CURRENT position.
    for (const { id } of positions) {
      if (id === guildId) continue;
      await assertCanManageRole(guildId, userId, id);
    }
    // Caller must ALSO not be able to move any role to a TARGET
    // position at or above their own top. Without this, a
    // moderator at position 5 could reorder role X (currently at
    // position 3 — manageable) to position 7, elevating X above
    // themselves. After the reorder, members of X outrank the
    // moderator and every role between 5 and 7, gaining ability
    // to act on them. Effectively the moderator has promoted X's
    // members above their own peers via the reorder backdoor.
    // Owners and ADMINISTRATOR-bit holders have no hierarchy ceiling.
    await assertTargetPositionsWithinCeiling(guildId, userId, positions);
    await roles.reorderRoles(guildId, userId, positions);
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bans
// ═══════════════════════════════════════════════════════════════════════════

guildsRouter.get(
  '/:guildId/bans',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.BAN_MEMBERS);

    const list = await bans.listBans(guildId);
    return c.json({ bans: list.map((b) => toBan(b.ban, b.user)) });
  },
);

const banSchema = z.object({ reason: z.string().max(512).nullable().optional() });

guildsRouter.put(
  '/:guildId/bans/:userId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, userId: snowflakeSchema }),
  ),
  validate('json', banSchema.optional()),
  async (c) => {
    const callerId = requireUserId(c);
    const { guildId: gid, userId: uid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const targetId = BigInt(uid);
    if (targetId === callerId) throw errors.badRequest('You cannot ban yourself');

    await assertGuildPermission(guildId, callerId, Permissions.BAN_MEMBERS);
    await assertCanManageMember(guildId, callerId, targetId);

    const body = (c.req.valid('json') as { reason?: string | null } | undefined) ?? {};
    await bans.banMember({
      guildId,
      userId: targetId,
      actorId: callerId,
      reason: body.reason ?? null,
    });

    // Same voice eviction as kick — see comment on the DELETE
    // /members/:userId path above. Banning a member should at minimum
    // be at least as restrictive as kicking, so the audio stream gets
    // shut down here too.
    const priorVS = await voice.evictFromVoiceInGuild(targetId, guildId);
    if (priorVS) {
      dispatch.voiceStateUpdate({
        guildId,
        channelId: priorVS.channelId,
        voiceState: leftVoiceStateDTO({ userId: targetId, guildId, channelId: priorVS.channelId }),
      });
    }

    // Banning is a stricter kick — same membership-side effects.
    dispatch.userLeftGuild({ userId: targetId, guildId });
    return c.json({ ok: true });
  },
);

guildsRouter.delete(
  '/:guildId/bans/:userId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, userId: snowflakeSchema }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const { guildId: gid, userId: uid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const targetId = BigInt(uid);

    await assertGuildPermission(guildId, callerId, Permissions.BAN_MEMBERS);
    await bans.unbanMember({ guildId, userId: targetId, actorId: callerId });
    return c.json({ ok: true });
  },
);

// ─────────────────────────────────────────────────────────────────
// Reaction-role mappings
// ─────────────────────────────────────────────────────────────────
//
// CRUD for the (message, emoji) → role mappings. Listing requires
// MANAGE_ROLES because the mappings reveal which roles auto-assign;
// create/delete require MANAGE_ROLES for the same reason — adding a
// mapping lets you indirectly grant a role to anyone who clicks an
// emoji, which is functionally equivalent to having the grant
// permission.

guildsRouter.get(
  '/:guildId/reaction-roles',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid } = c.req.valid('param');
    const guildId = BigInt(gid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_ROLES);
    const items = await reactionRolesSvc.listForGuild(guildId);
    return c.json({ items });
  },
);

guildsRouter.put(
  '/:guildId/reaction-roles',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate(
    'json',
    z.object({
      messageId: snowflakeSchema,
      channelId: snowflakeSchema,
      emoji: z.string().min(1).max(64),
      roleId: snowflakeSchema,
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid } = c.req.valid('param');
    const body = c.req.valid('json');
    const guildId = BigInt(gid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_ROLES);
    // Sanity check: role belongs to this guild, channel belongs to
    // this guild, message belongs to that channel. Skipping these
    // checks would let an admin create dangling mappings (e.g.
    // pointing to a role in another guild) which the gateway hook
    // would silently no-op on but the management UI would show.
    const channelId = BigInt(body.channelId);
    const messageId = BigInt(body.messageId);
    const roleId = BigInt(body.roleId);
    const channelRow = await db
      .select({ id: schema.channels.id, guildId: schema.channels.guildId })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1);
    if (!channelRow[0] || channelRow[0].guildId !== guildId) {
      throw errors.notFound('Channel');
    }
    const roleRow = await db
      .select({ id: schema.roles.id, guildId: schema.roles.guildId })
      .from(schema.roles)
      .where(eq(schema.roles.id, roleId))
      .limit(1);
    if (!roleRow[0] || roleRow[0].guildId !== guildId) {
      throw errors.notFound('Role');
    }
    // Role-hierarchy check. MANAGE_ROLES alone isn't enough — without
    // this, an admin with MANAGE_ROLES could attach a reaction-role
    // mapping for a role HIGHER than any role they hold themselves,
    // then anyone clicking the emoji would get that higher role.
    // Net effect: MANAGE_ROLES becomes "grant ANY role" via the
    // reaction-role indirection, bypassing the hierarchy that's
    // enforced on direct role-assign + role-edit. The reaction-add
    // hook deliberately doesn't check hierarchy at click time (that
    // would defeat the feature), so this is the chokepoint.
    await assertCanManageRole(guildId, userId, roleId);
    const messageRow = await db
      .select({ id: schema.messages.id, channelId: schema.messages.channelId })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    if (!messageRow[0] || messageRow[0].channelId !== channelId) {
      throw errors.notFound('Message');
    }
    await reactionRolesSvc.createMapping({
      messageId,
      emoji: body.emoji,
      guildId,
      channelId,
      roleId,
      createdBy: userId,
    });
    return c.json({ ok: true });
  },
);

guildsRouter.delete(
  '/:guildId/reaction-roles',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate(
    'query',
    z.object({ messageId: snowflakeSchema, emoji: z.string().min(1).max(64) }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid } = c.req.valid('param');
    const { messageId: mid, emoji } = c.req.valid('query');
    const guildId = BigInt(gid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_ROLES);
    const removed = await reactionRolesSvc.deleteMapping(BigInt(mid), emoji);
    if (!removed) throw errors.notFound('Reaction role mapping');
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Automod rules
// ═══════════════════════════════════════════════════════════════════════════
//
// All endpoints require MANAGE_GUILD — automod is a server-admin
// concern, not a per-channel moderation concern. Rules are scoped
// strictly to one guild (no cross-guild sharing in v1; templates
// can be added later if there's demand).

const PATTERN_MAX_LEN = 200;
const PATTERNS_MAX_COUNT = 100;
const TIMEOUT_MAX_SECONDS = 28 * 24 * 60 * 60; // 28 days, matches manual

const patternsSchema = z.array(z.string().min(1).max(PATTERN_MAX_LEN)).max(PATTERNS_MAX_COUNT);
const ruleTypeSchema = z.enum([
  'word_blocklist',
  'regex_pattern',
  'link_filter',
  'repeat_message',
  'mention_spam',
]);
const actionSchema = z.enum(['block', 'block_and_timeout', 'log_only']);

const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  ruleType: ruleTypeSchema,
  patterns: patternsSchema.optional(),
  threshold: z.number().int().positive().optional(),
  windowSeconds: z.number().int().positive().optional(),
  action: actionSchema.optional(),
  timeoutSeconds: z.number().int().positive().max(TIMEOUT_MAX_SECONDS).optional(),
  exemptRoleIds: z.array(snowflakeSchema).max(50).optional(),
  exemptChannelIds: z.array(snowflakeSchema).max(50).optional(),
});

const updateRuleSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    patterns: patternsSchema.optional(),
    threshold: z.number().int().positive().nullable().optional(),
    windowSeconds: z.number().int().positive().nullable().optional(),
    action: actionSchema.optional(),
    timeoutSeconds: z.number().int().positive().max(TIMEOUT_MAX_SECONDS).nullable().optional(),
    exemptRoleIds: z.array(snowflakeSchema).max(50).optional(),
    exemptChannelIds: z.array(snowflakeSchema).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

guildsRouter.get(
  '/:guildId/automod-rules',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);
    const { listGuildRules } = await import('../services/automod');
    const { toAutomodRule } = await import('../lib/dto');
    const rows = await listGuildRules(guildId);
    return c.json({ rules: rows.map(toAutomodRule) });
  },
);

guildsRouter.post(
  '/:guildId/automod-rules',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', createRuleSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);
    const body = c.req.valid('json');
    // If action requires a timeout duration, enforce that timeoutSeconds
    // is present. Failing at create time is much more discoverable than
    // silently producing a rule that triggers no timeout.
    if (body.action === 'block_and_timeout' && body.timeoutSeconds == null) {
      throw errors.badRequest('timeoutSeconds is required when action is block_and_timeout');
    }
    const { createRule } = await import('../services/automod');
    const { toAutomodRule } = await import('../lib/dto');
    const row = await createRule({
      guildId,
      actorId: userId,
      name: body.name,
      ruleType: body.ruleType,
      patterns: body.patterns,
      threshold: body.threshold ?? null,
      windowSeconds: body.windowSeconds ?? null,
      action: body.action,
      timeoutSeconds: body.timeoutSeconds ?? null,
      exemptRoleIds: body.exemptRoleIds,
    });
    return c.json({ rule: toAutomodRule(row) }, 201);
  },
);

guildsRouter.patch(
  '/:guildId/automod-rules/:ruleId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, ruleId: snowflakeSchema }),
  ),
  validate('json', updateRuleSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, ruleId: rid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const ruleId = BigInt(rid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);
    const body = c.req.valid('json');
    const { updateRule } = await import('../services/automod');
    const { toAutomodRule } = await import('../lib/dto');
    const row = await updateRule(ruleId, guildId, {
      actorId: userId,
      name: body.name,
      enabled: body.enabled,
      patterns: body.patterns,
      threshold: body.threshold,
      windowSeconds: body.windowSeconds,
      action: body.action,
      timeoutSeconds: body.timeoutSeconds,
      exemptRoleIds: body.exemptRoleIds,
    });
    return c.json({ rule: toAutomodRule(row) });
  },
);

guildsRouter.delete(
  '/:guildId/automod-rules/:ruleId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, ruleId: snowflakeSchema }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, ruleId: rid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const ruleId = BigInt(rid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);
    const { deleteRule } = await import('../services/automod');
    await deleteRule(ruleId, guildId, userId);
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Audit log
// ═══════════════════════════════════════════════════════════════════════════
//
// Read-only view of audit_log_entries. Distinct permission from
// MANAGE_GUILD: VIEW_AUDIT_LOG (bit 19) is the specific gate so admins
// can grant "trusted observer" access (see the log, can't change
// anything) without escalating to full server-management privileges.

guildsRouter.get(
  '/:guildId/audit-log',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate(
    'query',
    z.object({
      before: snowflakeSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      actionPrefix: z.string().max(50).optional(),
      /** Filter to a single moderator's actions. */
      actorId: snowflakeSchema.optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.VIEW_AUDIT_LOG);
    const q = c.req.valid('query');
    const { listAuditEntries } = await import('../services/audit');
    const { toAuditLogEntry } = await import('../lib/dto');
    const rows = await listAuditEntries(guildId, {
      before: q.before ? BigInt(q.before) : undefined,
      limit: q.limit,
      actionPrefix: q.actionPrefix,
      actorId: q.actorId ? BigInt(q.actorId) : undefined,
    });
    return c.json({
      entries: rows.map((r) => toAuditLogEntry(r.entry, r.actor)),
    });
  },
);

// Audit-log export — the whole log (chronological, up to a cap) for an
// offline record. Same VIEW_AUDIT_LOG gate as the live view. Returns JSON;
// the client offers both JSON and CSV downloads, building the CSV from this
// payload so escaping stays in one place. `truncated` warns when the cap
// was hit.
guildsRouter.get(
  '/:guildId/audit-log/export',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.VIEW_AUDIT_LOG);
    const cap = 10_000;
    const { listAuditEntriesForExport } = await import('../services/audit');
    const { toAuditLogEntry } = await import('../lib/dto');
    const rows = await listAuditEntriesForExport(guildId, cap);
    return c.json({
      exportedAt: new Date().toISOString(),
      guildId: guildId.toString(),
      truncated: rows.length >= cap,
      entries: rows.map((r) => toAuditLogEntry(r.entry, r.actor)),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Bot slash-commands (per guild)
// ═══════════════════════════════════════════════════════════════════════════
//
// GET  /:guildId/commands         → commands available in this guild (every
//   command whose bot is a member, guild-scoped OR global). Members only — it
//   feeds the composer's slash picker.
// POST /:guildId/commands/invoke  → run `/<name> <args>`. Member-gated; the
//   invoker must be able to VIEW_CHANNEL on the target channel and pass the
//   gates a live send there faces (see the handler). The service then
//   delivers an interaction.create event to the bot's callback (the bot
//   replies via REST). 404 if no such command resolves; 400 if the bot has no
//   callback configured.

guildsRouter.get(
  '/:guildId/commands',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const commands = await botsSvc.listCommandsForGuild(guildId);
    return c.json({ commands });
  },
);

guildsRouter.post(
  '/:guildId/commands/invoke',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate(
    'json',
    z.object({
      channelId: snowflakeSchema,
      name: z.string().trim().min(1).max(32),
      argText: z.string().max(2000).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    const body = c.req.valid('json');
    const channelId = BigInt(body.channelId);
    await ensureMember(guildId, userId);
    await assertNotInstanceMuted(userId);

    // The channel must belong to this guild, and the invoker must be able to
    // see it — you can't fire a command into a channel you can't view.
    const [ch] = await db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.id, channelId), isNull(schema.channels.deletedAt)))
      .limit(1);
    if (!ch || ch.guildId !== guildId) throw errors.notFound('Channel');
    const perms = await computeMemberChannelPermissions(channelId, userId, ch);
    if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) {
      throw errors.missingPermissions(['VIEW_CHANNEL']);
    }
    // A command makes the bot post into the channel on the invoker's behalf,
    // often echoing argText, so it faces a live send's gates: SEND_MESSAGES,
    // onboarding, timeout, supervision, spam, and banned words + automod over
    // argText (as extraText: it is not stored as the invoker's message). No
    // slowmode: it measures the invoker's own messages, and an invoke posts
    // none of theirs.
    await enforceGuildSendGates({
      channel: ch,
      channelPerms: perms,
      userId,
      content: '',
      extraText: body.argText,
      enforceSlowmode: false,
    });

    const result = await botsSvc.invokeBotCommand({
      invokerId: userId,
      guildId,
      channelId,
      name: body.name,
      argText: body.argText ?? '',
    });
    return c.json(result);
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Reports (member reporting + moderation queue)
// ═══════════════════════════════════════════════════════════════════════════
//
// Filing is open to any member. Viewing/handling the queue is gated to
// moderators — anyone holding ANY of the moderation permissions below.

const MOD_PERMS = [
  Permissions.MANAGE_MESSAGES,
  Permissions.KICK_MEMBERS,
  Permissions.BAN_MEMBERS,
  Permissions.MODERATE_MEMBERS,
  Permissions.MANAGE_GUILD,
] as const;

const createReportSchema = z.object({
  targetType: z.enum(['message', 'user']),
  targetUserId: snowflakeSchema.optional(),
  messageId: snowflakeSchema.optional(),
  reason: z.enum(['spam', 'harassment', 'nsfw', 'violence', 'other']),
  details: z.string().max(1000).optional(),
});

// Per-reporter limit. createReport's dedup only stops repeat reports
// against the SAME target — without this, a member can iterate a
// channel's history and file one report per message, flooding the
// moderation queue and the open-count badge. Same shape and rationale
// as friendRequestRl in routes/users.ts.
const reportRl = new RateLimiter(10, 10 * 60_000, 'report-create');

guildsRouter.post(
  '/:guildId/reports',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', createReportSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const rl = await reportRl.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const body = c.req.valid('json');

    let targetUserId: bigint | null = null;
    let messageId: bigint | null = null;
    let channelId: bigint | null = null;
    let messageContent: string | null = null;

    if (body.targetType === 'message') {
      if (!body.messageId) throw errors.badRequest('messageId is required to report a message');
      messageId = BigInt(body.messageId);
      const [msg] = await db
        .select({
          authorId: schema.messages.authorId,
          channelId: schema.messages.channelId,
          content: schema.messages.content,
        })
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId))
        .limit(1);
      if (!msg) throw errors.notFound('Message');
      // The reported message must live in this guild — otherwise a member
      // could file a report in guild A about a message in guild B.
      const [ch] = await db
        .select({ guildId: schema.channels.guildId })
        .from(schema.channels)
        .where(eq(schema.channels.id, msg.channelId))
        .limit(1);
      if (!ch || ch.guildId !== guildId) throw errors.notFound('Message');
      targetUserId = msg.authorId;
      channelId = msg.channelId;
      messageContent = msg.content;
    } else {
      if (!body.targetUserId) throw errors.badRequest('targetUserId is required to report a user');
      targetUserId = BigInt(body.targetUserId);
    }

    if (targetUserId !== null && targetUserId === userId) {
      throw errors.badRequest('You can’t report yourself');
    }

    const row = await reports.createReport({
      guildId,
      reporterId: userId,
      targetType: body.targetType,
      targetUserId,
      messageId,
      channelId,
      messageContent,
      reason: body.reason,
      details: body.details ?? null,
    });
    // The reporter only gets an acknowledgment — the report's contents are
    // for moderators, not echoed back.
    return c.json({ ok: true, reportId: row.id.toString() }, 201);
  },
);

guildsRouter.get(
  '/:guildId/reports',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate(
    'query',
    z.object({
      status: z.enum(['open', 'resolved', 'dismissed', 'all']).optional(),
      targetType: z.enum(['message', 'user']).optional(),
      before: snowflakeSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertAnyGuildPermission(guildId, userId, ...MOD_PERMS);
    const q = c.req.valid('query');
    const rows = await reports.listReports(guildId, {
      status: q.status ?? 'open',
      targetType: q.targetType,
      before: q.before ? BigInt(q.before) : undefined,
      limit: q.limit,
    });
    const openCount = await reports.countOpenReports(guildId);
    return c.json({
      reports: rows.map((r) => toReport(r.report, r.reporter, r.target)),
      openCount,
    });
  },
);

// Resolve/dismiss a report, optionally taking a moderation action against the
// reported entity in the same step ("resolve and ban", "resolve and delete").
// The action reuses the existing ban / message-delete paths (same side effects
// + their own audit entries); we additionally record a report.<action> audit
// entry so the moderation trail shows the report that triggered it. Each
// optional action requires its OWN specific permission on top of the base
// MOD_PERMS gate (you can't ban via a report with only MANAGE_MESSAGES).
guildsRouter.patch(
  '/:guildId/reports/:reportId',
  validate('param', z.object({ guildId: snowflakeSchema, reportId: snowflakeSchema })),
  validate(
    'json',
    z.object({
      action: z.enum(['resolve', 'dismiss']),
      note: z.string().max(1000).optional(),
      /** Optional moderation action applied to the reported entity. Only
       *  honored on `resolve`. 'ban' needs BAN_MEMBERS + hierarchy;
       *  'delete_message' needs MANAGE_MESSAGES and a message report. */
      moderation: z.enum(['none', 'ban', 'delete_message']).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: g, reportId: rid } = c.req.valid('param');
    const guildId = BigInt(g);
    const reportId = BigInt(rid);
    await assertAnyGuildPermission(guildId, userId, ...MOD_PERMS);
    const body = c.req.valid('json');
    const moderation = body.action === 'resolve' ? body.moderation ?? 'none' : 'none';

    // Load the report first so the moderation action targets the right
    // entity, and 404s cleanly for a wrong guild / missing report.
    const [report] = await db
      .select()
      .from(schema.reports)
      .where(and(eq(schema.reports.guildId, guildId), eq(schema.reports.id, reportId)))
      .limit(1);
    if (!report) throw errors.notFound('Report');

    if (moderation === 'ban') {
      const targetId = report.targetUserId;
      if (targetId === null) throw errors.badRequest('This report has no user to ban');
      if (targetId === userId) throw errors.badRequest('You cannot ban yourself');
      await assertGuildPermission(guildId, userId, Permissions.BAN_MEMBERS);
      await assertCanManageMember(guildId, userId, targetId);
      await bans.banMember({
        guildId,
        userId: targetId,
        actorId: userId,
        reason: body.note ?? `Report ${reportId.toString()}`,
      });
      // Mirror the ban route's voice + membership side effects.
      const priorVS = await voice.evictFromVoiceInGuild(targetId, guildId);
      if (priorVS) {
        dispatch.voiceStateUpdate({
          guildId,
          channelId: priorVS.channelId,
          voiceState: leftVoiceStateDTO({ userId: targetId, guildId, channelId: priorVS.channelId }),
        });
      }
      dispatch.userLeftGuild({ userId: targetId, guildId });
    } else if (moderation === 'delete_message') {
      if (report.targetType !== 'message' || report.messageId === null) {
        throw errors.badRequest('This report is not about a message');
      }
      await assertGuildPermission(guildId, userId, Permissions.MANAGE_MESSAGES);
      // The message may already be gone (reported-then-deleted) — deleteMessage
      // is idempotent and the snapshot in the report preserves the content.
      await messages.deleteMessage(report.messageId);
      dispatch.messageDelete({
        messageId: report.messageId,
        channelId: report.channelId ?? 0n,
        guildId,
      });
    }

    const row = await reports.handleReport(guildId, reportId, userId, body.action, body.note ?? null);

    // Audit trail for the report decision. Point the entry at the affected
    // entity (member or message) so it threads with other moderation entries.
    await writeAudit({
      guildId,
      actorId: userId,
      action: `report.${body.action}`,
      targetType: report.targetType === 'message' ? 'message' : 'member',
      targetId: report.targetType === 'message' ? report.messageId : report.targetUserId,
      changes: {
        reportId: reportId.toString(),
        reason: report.reason,
        moderation,
      },
      reason: body.note ?? null,
    });

    return c.json({ report: toReport(row, null, null) });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Message search
// ═══════════════════════════════════════════════════════════════════════════
//
// Full-text search across the channels the requester can view in this guild.
// Members-only; the per-channel permissions are enforced inside the
// service (results are restricted to channels with VIEW_CHANNEL +
// READ_MESSAGE_HISTORY).

guildsRouter.get(
  '/:guildId/messages/search',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate(
    'query',
    z.object({
      q: z.string().min(1).max(200),
      channelId: snowflakeSchema.optional(),
      authorId: snowflakeSchema.optional(),
      before: snowflakeSchema.optional(),
      after: snowflakeSchema.optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const q = c.req.valid('query');
    const rows = await messageSearch.searchGuildMessages(guildId, userId, {
      query: q.q,
      channelId: q.channelId ? BigInt(q.channelId) : undefined,
      authorId: q.authorId ? BigInt(q.authorId) : undefined,
      before: q.before ? BigInt(q.before) : undefined,
      after: q.after ? BigInt(q.after) : undefined,
      limit: q.limit,
    });
    return c.json({
      messages: rows.map((r) =>
        toMessage({ message: r.message, author: r.author, selfId: userId }),
      ),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Onboarding
// ═══════════════════════════════════════════════════════════════════════════
//
// Acknowledge the guild's rules, flipping the member from 'pending'
// to 'active'. Idempotent — already-active members get a no-op
// response. After a successful flip we broadcast guildMemberUpdate
// so other clients (and the acknowledging user's other tabs) see the
// new state without polling.

guildsRouter.post(
  '/:guildId/onboarding/acknowledge',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const { acknowledgeRules, getMemberDetailed } = await import('../services/members');
    const flipped = await acknowledgeRules(guildId, userId);
    if (flipped) {
      // Broadcast the updated member state so the client UIs
      // refresh. Other tabs in the same session also dismiss the
      // onboarding modal on receiving this.
      const updated = await getMemberDetailed(guildId, userId);
      if (updated) {
        const { toGuildMember } = await import('../lib/dto');
        const dispatch = await import('../gateway/dispatch');
        dispatch.guildMemberUpdate(
          toGuildMember(updated.member, updated.user, updated.roleIds),
          guildId,
        );
      }
    }
    return c.json({ ok: true, alreadyActive: !flipped });
  },
);

// ── Onboarding stats ────────────────────────────────────────────────────
//
// Pending/active member counts for the Rules tab in guild settings.
// Two COUNT queries — the pending side is bounded by the partial
// pending-state index so it's essentially free for guilds where most
// members are active.
//
// Requires MANAGE_GUILD because the count is admin-facing info; we
// don't want to surface "this server has N stuck-pending members" to
// arbitrary members.
guildsRouter.get(
  '/:guildId/onboarding/stats',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_GUILD);

    // Parallel COUNTs. ::int casts the bigint count down on the DB
    // side — member counts fit comfortably in a 32-bit int and this
    // avoids the JS string-bigint round-trip for the response.
    const [pendingRow, activeRow] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.guildMembers)
        .where(
          and(
            eq(schema.guildMembers.guildId, guildId),
            eq(schema.guildMembers.membershipState, 'pending'),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.guildMembers)
        .where(
          and(
            eq(schema.guildMembers.guildId, guildId),
            eq(schema.guildMembers.membershipState, 'active'),
          ),
        ),
    ]);
    return c.json({
      pending: pendingRow[0]?.n ?? 0,
      active: activeRow[0]?.n ?? 0,
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Self-assignable roles
// ═══════════════════════════════════════════════════════════════════════════
//
// Members can grant/revoke roles for themselves IFF the role's
// `self_assignable` flag is set by an admin. The endpoints use the
// `@me` literal in the path so there's no possibility of cross-user
// grants through this surface — the user can only modify their own
// role set, regardless of what userId they try to put in the URL.
//
// Pending-onboarding members are blocked from self-assigning. Getting
// roles before acknowledging the rules would defeat the onboarding
// gate (admins might use role-based read access to certain channels;
// granting those roles to a pending member would let them participate
// in those spaces before they've agreed).

guildsRouter.get(
  '/:guildId/self-assignable-roles',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const list = await roles.listSelfAssignableRoles(guildId);
    return c.json({ roles: list.map(toRole) });
  },
);

guildsRouter.put(
  '/:guildId/members/@me/roles/:roleId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, roleId: snowflakeSchema }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, roleId: rid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const roleId = BigInt(rid);
    await ensureMember(guildId, userId);
    // Pending-onboarding members can't pick up roles before
    // acknowledging the rules. Same dynamic-import pattern as the
    // send-message gate.
    const { getMemberState, getMemberDetailed } = await import('../services/members');
    const memberState = await getMemberState(guildId, userId);
    if (memberState === 'pending') throw errors.pendingAcknowledgment();
    await roles.selfAssignRole({ guildId, userId, roleId });
    // A self-assignable role can carry channel VIEW_CHANNEL overrides —
    // refresh this user's gateway viewable-channel cache (emits
    // CHANNEL_CREATE for newly visible channels) or their connections
    // miss events for the unlocked channels until reconnect.
    await dispatch.applyMemberRoleChange({ userId, guildId });
    // Broadcast the member update so the change appears in every
    // connected client's member list immediately.
    const updated = await getMemberDetailed(guildId, userId);
    if (updated) {
      dispatch.guildMemberUpdate(
        toGuildMember(updated.member, updated.user, updated.roleIds),
        guildId,
      );
    }
    return c.json({ ok: true });
  },
);

guildsRouter.delete(
  '/:guildId/members/@me/roles/:roleId',
  validate(
    'param',
    z.object({ guildId: snowflakeSchema, roleId: snowflakeSchema }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, roleId: rid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const roleId = BigInt(rid);
    await ensureMember(guildId, userId);
    const { getMemberState, getMemberDetailed } = await import('../services/members');
    const memberState = await getMemberState(guildId, userId);
    if (memberState === 'pending') throw errors.pendingAcknowledgment();
    await roles.selfRevokeRole({ guildId, userId, roleId });
    // Mirror of the self-assign path: dropping the role may hide channels
    // — refresh the cache so events stop flowing (and CHANNEL_DELETE is
    // emitted) immediately rather than on reconnect.
    await dispatch.applyMemberRoleChange({ userId, guildId });
    const updated = await getMemberDetailed(guildId, userId);
    if (updated) {
      dispatch.guildMemberUpdate(
        toGuildMember(updated.member, updated.user, updated.roleIds),
        guildId,
      );
    }
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Scheduled events
// ═══════════════════════════════════════════════════════════════════════════
//
// Read endpoints (list + detail) are open to all guild members —
// upcoming events are community info, not moderator-private.
//
// Write endpoints (create / update / delete) require MANAGE_EVENTS.
// In v1 we don't gate RSVPing on a separate permission: any member
// who can VIEW the guild can RSVP. The location channel's own
// VIEW_CHANNEL permission still gates whether they can actually
// reach the event (voice-channel-located events require CONNECT on
// the target channel).
//
// In v1, mutations don't dispatch realtime gateway broadcasts —
// connected clients pick up changes on next list-refresh. A future
// polish can add scheduledEvent{Create,Update,Delete} gateway events
// for live attendee-list updates and "event starting now" push
// notifications.

const eventNameSchema = z.string().min(1).max(100);
const eventDescriptionSchema = z
  .string()
  .max(2000)
  .transform((s) =>
    // eslint-disable-next-line no-control-regex
    s.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, ''),
  );
const locationKindSchema = z.enum(['voice_channel', 'external']);
const eventStatusSchema = z.enum(['scheduled', 'active', 'completed', 'canceled']);
const rsvpStatusSchema = z.enum(['going', 'maybe', 'declined']);
// Coerce ISO strings to Date; reject malformed.
const isoDateSchema = z.string().datetime().transform((s) => new Date(s));

const createEventSchema = z.object({
  name: eventNameSchema,
  description: eventDescriptionSchema.nullable().optional(),
  startAt: isoDateSchema,
  endAt: isoDateSchema.nullable().optional(),
  locationKind: locationKindSchema,
  locationChannelId: snowflakeSchema.nullable().optional(),
  locationText: z.string().max(500).nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
});

const updateEventSchema = z
  .object({
    name: eventNameSchema.optional(),
    description: eventDescriptionSchema.nullable().optional(),
    startAt: isoDateSchema.optional(),
    endAt: isoDateSchema.nullable().optional(),
    locationKind: locationKindSchema.optional(),
    locationChannelId: snowflakeSchema.nullable().optional(),
    locationText: z.string().max(500).nullable().optional(),
    status: eventStatusSchema.optional(),
    imageUrl: z.string().url().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

guildsRouter.get(
  '/:guildId/events',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate(
    'query',
    z.object({
      status: eventStatusSchema.optional(),
      includeArchived: z
        .union([z.literal('true'), z.literal('false')])
        .optional()
        .transform((v) => v === 'true'),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const q = c.req.valid('query');
    const events = await import('../services/events');
    const { toScheduledEvent } = await import('../lib/dto');
    const rows = await events.listGuildEvents(guildId, {
      status: q.status,
      includeArchived: q.includeArchived ?? false,
      limit: q.limit,
    });
    // Batch creators + RSVP aggregates + caller's own RSVPs into a CONSTANT
    // number of queries (was 3 per event, an N+1 that scales with events/page).
    // event_rsvps PK is (eventId, userId) so both IN-queries use its eventId
    // prefix; users.id is PK. Order of `rows` preserved by mapping in memory.
    const eventIds = rows.map((ev) => ev.id);
    const creatorIds = [
      ...new Set(rows.map((ev) => ev.creatorId).filter((x): x is bigint => x != null)),
    ];
    const [creators, rsvpRows, myRsvpRows] = await Promise.all([
      creatorIds.length
        ? db.select().from(schema.users).where(inArray(schema.users.id, creatorIds))
        : Promise.resolve([] as (typeof schema.users.$inferSelect)[]),
      eventIds.length
        ? db
            .select({
              eventId: schema.eventRsvps.eventId,
              status: schema.eventRsvps.status,
              count: sql<number>`count(*)::int`,
            })
            .from(schema.eventRsvps)
            .where(inArray(schema.eventRsvps.eventId, eventIds))
            .groupBy(schema.eventRsvps.eventId, schema.eventRsvps.status)
        : Promise.resolve(
            [] as { eventId: bigint; status: 'going' | 'maybe' | 'declined'; count: number }[],
          ),
      eventIds.length
        ? db
            .select({ eventId: schema.eventRsvps.eventId, status: schema.eventRsvps.status })
            .from(schema.eventRsvps)
            .where(
              and(inArray(schema.eventRsvps.eventId, eventIds), eq(schema.eventRsvps.userId, userId)),
            )
        : Promise.resolve([] as { eventId: bigint; status: 'going' | 'maybe' | 'declined' }[]),
    ]);
    const creatorById = new Map(creators.map((u) => [u.id, u]));
    const countsByEvent = new Map<bigint, { going: number; maybe: number; declined: number }>();
    for (const r of rsvpRows) {
      let c2 = countsByEvent.get(r.eventId);
      if (!c2) {
        c2 = { going: 0, maybe: 0, declined: 0 };
        countsByEvent.set(r.eventId, c2);
      }
      c2[r.status] = r.count;
    }
    const myRsvpByEvent = new Map(myRsvpRows.map((r) => [r.eventId, r.status]));
    const enriched = rows.map((ev) =>
      toScheduledEvent(ev, ev.creatorId ? creatorById.get(ev.creatorId) ?? null : null, {
        rsvpCounts: countsByEvent.get(ev.id) ?? { going: 0, maybe: 0, declined: 0 },
        myRsvp: myRsvpByEvent.get(ev.id) ?? null,
      }),
    );
    return c.json({ events: enriched });
  },
);

guildsRouter.get(
  '/:guildId/events/:eventId',
  validate('param', z.object({ guildId: snowflakeSchema, eventId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, eventId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const eventId = BigInt(eid);
    await ensureMember(guildId, userId);
    const events = await import('../services/events');
    const { toScheduledEvent } = await import('../lib/dto');
    const ev = await events.getEvent(eventId);
    if (!ev || ev.guildId !== guildId) throw errors.notFound('Event');
    const [creator, rsvpCounts, myRsvp] = await Promise.all([
      ev.creatorId
        ? db
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, ev.creatorId))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      events.countRsvpsByStatus(eventId),
      events.getUserRsvp(eventId, userId),
    ]);
    return c.json({ event: toScheduledEvent(ev, creator, { rsvpCounts, myRsvp }) });
  },
);

guildsRouter.post(
  '/:guildId/events',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', createEventSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EVENTS);
    const body = c.req.valid('json');
    const events = await import('../services/events');
    const { toScheduledEvent } = await import('../lib/dto');
    const ev = await events.createEvent({
      guildId,
      creatorId: userId,
      name: body.name,
      description: body.description,
      startAt: body.startAt,
      endAt: body.endAt,
      locationKind: body.locationKind,
      locationChannelId: body.locationChannelId ? BigInt(body.locationChannelId) : null,
      locationText: body.locationText,
      imageUrl: body.imageUrl,
    });
    const [creator, rsvpCounts] = await Promise.all([
      db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1)
        .then((r) => r[0] ?? null),
      events.countRsvpsByStatus(ev.id),
    ]);
    const dto = toScheduledEvent(ev, creator, { rsvpCounts, myRsvp: null });
    // Broadcast to all guild members. The DTO carries rsvpCounts
    // (all zeros for a fresh event) but client reducers preserve
    // their own myRsvp on broadcast apply.
    dispatch.scheduledEventCreate(dto, guildId);
    return c.json({ event: dto }, 201);
  },
);

guildsRouter.patch(
  '/:guildId/events/:eventId',
  validate('param', z.object({ guildId: snowflakeSchema, eventId: snowflakeSchema })),
  validate('json', updateEventSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, eventId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const eventId = BigInt(eid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EVENTS);
    const body = c.req.valid('json');
    const events = await import('../services/events');
    const { toScheduledEvent } = await import('../lib/dto');
    const updated = await events.updateEvent({
      eventId,
      guildId,
      actorId: userId,
      name: body.name,
      description: body.description,
      startAt: body.startAt,
      endAt: body.endAt,
      locationKind: body.locationKind,
      locationChannelId:
        body.locationChannelId !== undefined
          ? body.locationChannelId
            ? BigInt(body.locationChannelId)
            : null
          : undefined,
      locationText: body.locationText,
      status: body.status,
      imageUrl: body.imageUrl,
    });
    const [creator, rsvpCounts, myRsvp] = await Promise.all([
      updated.creatorId
        ? db
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, updated.creatorId))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      events.countRsvpsByStatus(eventId),
      events.getUserRsvp(eventId, userId),
    ]);
    const dto = toScheduledEvent(updated, creator, { rsvpCounts, myRsvp });
    // Broadcast to all members. The reducer on each client side
    // applies the event shape but preserves their own rsvpCounts/
    // myRsvp (which the broadcast can't speak to per-recipient).
    dispatch.scheduledEventUpdate(dto, guildId);
    return c.json({ event: dto });
  },
);

guildsRouter.delete(
  '/:guildId/events/:eventId',
  validate('param', z.object({ guildId: snowflakeSchema, eventId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, eventId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const eventId = BigInt(eid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EVENTS);
    const events = await import('../services/events');
    await events.deleteEvent(eventId, guildId, userId);
    dispatch.scheduledEventDelete({ eventId, guildId });
    return c.json({ ok: true });
  },
);

guildsRouter.put(
  '/:guildId/events/:eventId/rsvp',
  validate('param', z.object({ guildId: snowflakeSchema, eventId: snowflakeSchema })),
  validate('json', z.object({ status: rsvpStatusSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, eventId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const eventId = BigInt(eid);
    await ensureMember(guildId, userId);
    // Pending-onboarding members can't RSVP for the same reason
    // they can't self-assign roles: getting RSVP'd before
    // acknowledging the rules sidesteps the gate.
    const { getMemberState } = await import('../services/members');
    const memberState = await getMemberState(guildId, userId);
    if (memberState === 'pending') throw errors.pendingAcknowledgment();
    const body = c.req.valid('json');
    const events = await import('../services/events');
    // The service validates the event exists in this guild and
    // isn't terminal.
    const ev = await events.getEvent(eventId);
    if (!ev || ev.guildId !== guildId) throw errors.notFound('Event');
    await events.setRsvp({ eventId, userId, status: body.status });
    return c.json({ ok: true });
  },
);

guildsRouter.delete(
  '/:guildId/events/:eventId/rsvp',
  validate('param', z.object({ guildId: snowflakeSchema, eventId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, eventId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const eventId = BigInt(eid);
    await ensureMember(guildId, userId);
    const events = await import('../services/events');
    const ev = await events.getEvent(eventId);
    if (!ev || ev.guildId !== guildId) throw errors.notFound('Event');
    await events.removeRsvp({ eventId, userId });
    return c.json({ ok: true });
  },
);

// GET attendees — joined RSVP + user list for the event.
// Open to any guild member: knowing who's coming is part of the
// event's community value. Optional ?status=going filter narrows
// the list to just the going/maybe/declined subset, which the UI
// uses for the tab-split rendering ("12 going · 3 maybe").
guildsRouter.get(
  '/:guildId/events/:eventId/attendees',
  validate('param', z.object({ guildId: snowflakeSchema, eventId: snowflakeSchema })),
  validate(
    'query',
    z.object({
      status: rsvpStatusSchema.optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, eventId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const eventId = BigInt(eid);
    await ensureMember(guildId, userId);
    const q = c.req.valid('query');
    const events = await import('../services/events');
    const { toEventRsvp } = await import('../lib/dto');
    // Validate event belongs to this guild before exposing its
    // attendee list (defense in depth — service returns null for
    // missing events but we want the early-return + 404 mapping).
    const ev = await events.getEvent(eventId);
    if (!ev || ev.guildId !== guildId) throw errors.notFound('Event');
    const rows = await events.listRsvps(eventId, {
      status: q.status,
      limit: q.limit,
    });
    return c.json({ attendees: rows.map((r) => toEventRsvp(r.rsvp, r.user)) });
  },
);

// ── Event image upload ────────────────────────────────────────────────────
//
// Multipart upload that sets the event's banner image. Same shape as
// POST /:guildId/icon — save the file outside the transaction (slow
// IO), then SELECT FOR UPDATE + atomic swap + best-effort delete of
// the prior file. Permission: MANAGE_EVENTS.
//
// New events are created without an image (POST /events accepts
// imageUrl in the body but typically clients pass null and use this
// endpoint afterwards from the edit flow). Setting an image here
// broadcasts scheduledEventUpdate so other clients see the banner
// appear live.
const EVENT_IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

// Pre-create image upload. The per-event POST below requires an
// existing eventId; this endpoint exists for the create flow where
// there's no event yet to attach to. The file is saved to the same
// CDN store and the caller embeds the returned URL in their
// subsequent createEvent body's imageUrl field.
//
// Orphan-file concern: if the user uploads then abandons the create
// form, the file sits on disk unreferenced. v1 accepts this — the
// image compression sweep can be extended in a follow-up to GC any
// CDN attachment not referenced by any entity (avatars, banners,
// guild icons, event imageUrls, message attachments).
guildsRouter.post(
  '/:guildId/event-image-uploads',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EVENTS);

    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) {
      throw errors.badRequest('Missing file (expected multipart field "file")');
    }
    if (!EVENT_IMAGE_CONTENT_TYPES.has(file.type)) {
      throw errors.badRequest('Image must be a PNG, JPEG, GIF, or WebP');
    }

    const { saveUploadedFile } = await import('../services/uploads');
    const saved = await saveUploadedFile(file);
    // Return just the URL. The caller embeds this in createEvent;
    // no DB row to update here since there's no event yet.
    return c.json({ url: saved.url });
  },
);

guildsRouter.post(
  '/:guildId/events/:eventId/image',
  validate('param', z.object({ guildId: snowflakeSchema, eventId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { guildId: gid, eventId: eid } = c.req.valid('param');
    const guildId = BigInt(gid);
    const eventId = BigInt(eid);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_EVENTS);

    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) {
      throw errors.badRequest('Missing file (expected multipart field "file")');
    }
    if (!EVENT_IMAGE_CONTENT_TYPES.has(file.type)) {
      throw errors.badRequest('Image must be a PNG, JPEG, GIF, or WebP');
    }

    // Verify the event belongs to this guild before paying for the
    // file save. The full atomic swap also re-checks inside the
    // transaction, but failing fast on the obvious 404 path saves
    // wasted disk IO.
    const eventsService = await import('../services/events');
    const existing = await eventsService.getEvent(eventId);
    if (!existing || existing.guildId !== guildId) throw errors.notFound('Event');

    const { saveUploadedFile, deleteAttachmentFile, parseCdnAttachmentId } =
      await import('../services/uploads');

    // Save outside the transaction (slow IO). Atomic swap inside.
    const saved = await saveUploadedFile(file);

    const { updated, priorImageId } = await db.transaction(async (tx) => {
      const [prior] = await tx
        .select({ imageUrl: schema.scheduledEvents.imageUrl })
        .from(schema.scheduledEvents)
        .where(eq(schema.scheduledEvents.id, eventId))
        .for('update')
        .limit(1);
      if (!prior) throw errors.notFound('Event');
      const [u] = await tx
        .update(schema.scheduledEvents)
        .set({ imageUrl: saved.url, updatedAt: new Date() })
        .where(eq(schema.scheduledEvents.id, eventId))
        .returning();
      if (!u) throw errors.notFound('Event');
      // Audit inside the same tx so the trail commits with the swap.
      await writeAudit({
        tx,
        guildId,
        actorId: userId,
        action: 'event.image_set',
        targetType: 'scheduled_event',
        targetId: eventId,
        changes: { imageUrl: saved.url },
      });
      return { updated: u, priorImageId: parseCdnAttachmentId(prior.imageUrl) };
    });

    // Best-effort cleanup of the prior file.
    if (priorImageId !== null && priorImageId !== saved.attachmentId) {
      void deleteAttachmentFile(priorImageId);
    }

    // Broadcast + compose response DTO with enriched creator data.
    const { toScheduledEvent: toScheduledEventDTO } = await import('../lib/dto');
    const [creator, rsvpCounts, myRsvp] = await Promise.all([
      updated.creatorId
        ? db
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, updated.creatorId))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
      eventsService.countRsvpsByStatus(eventId),
      eventsService.getUserRsvp(eventId, userId),
    ]);
    const dto = toScheduledEventDTO(updated, creator, { rsvpCounts, myRsvp });
    dispatch.scheduledEventUpdate(dto, guildId);
    return c.json({ event: dto });
  },
);

// shim for unused-import lint when we expand later
void db;
void schema;
void eq;
void and;
void isNull;
void displayNameSchema;
void bioSchema;
void toPublicUser;
