/**
 * Channels router
 * ---------------
 * Mounted at /api/v1/channels. Channel-scoped operations live here:
 * read/update/delete a channel, manage its permission overrides, and
 * create invites that point at it.
 *
 * Channel *creation* is at /api/v1/guilds/:guildId/channels (since you
 * can't have a guild channel without first naming the guild). It's
 * registered separately at the bottom and re-exported.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import {
  snowflakeSchema,
  channelNameSchema,
  channelTopicSchema,
  slowmodeSchema,
  permissionsSchema,
  inviteTtlSchema,
  INVITE_DEFAULT_TTL,
} from '../lib/validation';
import { toChannel, toPermissionOverride, toInvite, leftVoiceStateDTO } from '../lib/dto';
import * as channels from '../services/channels';
import * as invites from '../services/invites';
import * as dms from '../services/dms';
import * as voice from '../services/voice';
import * as dispatch from '../gateway/dispatch';
import {
  Permissions,
  ensureMember,
  assertGuildPermission,
  assertChannelPermission,
  assertCanManageRole,
  assertCanManageMember,
  computeMemberGuildPermissions,
  hasPermission,
} from '../services/permissions';

export const channelsRouter = new Hono();
channelsRouter.use('*', requireAuth);

// ═══════════════════════════════════════════════════════════════════════════
// GET /:channelId  — single channel
// ═══════════════════════════════════════════════════════════════════════════

channelsRouter.get(
  '/:channelId',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await channels.getChannel(channelId);
    if (!channel) throw errors.notFound('Channel');

    if (channel.guildId) {
      await assertChannelPermission(channelId, userId, Permissions.VIEW_CHANNEL);
    } else {
      // DM channel — handled in stage 5; for now fall through to permission denial.
      throw errors.notFound('Channel');
    }

    return c.json({ channel: toChannel(channel) });
  },
);

channelsRouter.post(
  '/:channelId/typing',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await channels.getChannel(channelId);
    if (!channel) throw errors.notFound('Channel');

    // Permission gate: must be allowed to actually post here. Otherwise
    // someone could spam typing events into channels they can't see.
    if (channel.guildId) {
      await assertChannelPermission(channelId, userId, Permissions.SEND_MESSAGES);
    } else if (channel.type === 'dm' || channel.type === 'group_dm') {
      await dms.ensureRecipient(channelId, userId);
    } else {
      throw errors.notFound('Channel');
    }

    // Suppress for invisible users. Setting status='invisible' masks
    // presence broadcasts ("appears offline" to others), but without
    // also masking typing the user's activity still leaks — other
    // members see "User X is typing" which clearly signals "X is
    // online right now," contradicting the presence broadcast. The
    // lookup is one PK select and only suppresses the outbound
    // dispatch; the user can keep typing normally, only the
    // notification to others is dropped. Matches Discord's
    // semantic.
    const [me] = await db
      .select({ status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (me?.status === 'invisible') {
      return c.json({ ok: true });
    }

    dispatch.typingStart({
      channelId,
      guildId: channel.guildId,
      userId,
    });
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:channelId
// ═══════════════════════════════════════════════════════════════════════════

const patchChannelSchema = z
  .object({
    name: channelNameSchema.optional(),
    topic: channelTopicSchema.optional(),
    position: z.number().int().min(0).optional(),
    parentId: snowflakeSchema.nullable().optional(),
    nsfw: z.boolean().optional(),
    rateLimitPerUser: slowmodeSchema.optional(),
    /** Voice-channel only: disable voice in the channel (no one can talk).
        The route rejects this on non-voice channels. */
    voiceDisabled: z.boolean().optional(),
    /** Link-channel URL update. Same validation as create —
        http(s), ≤2048 chars, parseable. The route below rejects
        attempts to set this on non-link channels and attempts to
        clear it on link channels (would leave a click-target with
        no destination). */
    linkUrl: z
      .string()
      .trim()
      .max(2048)
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: 'Link URL must use http or https',
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

channelsRouter.patch(
  '/:channelId',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', patchChannelSchema),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const existing = await channels.getChannel(channelId);
    if (!existing || !existing.guildId) throw errors.notFound('Channel');
    await assertChannelPermission(channelId, userId, Permissions.MANAGE_CHANNELS);

    const body = c.req.valid('json');
    // Type-specific validation. linkUrl only valid on guild_link
    // channels; rejecting it on others both keeps the row clean and
    // avoids users accidentally setting a URL on a regular text
    // channel and being confused when nothing renders it.
    if (body.linkUrl !== undefined && existing.type !== 'guild_link') {
      throw errors.badRequest('linkUrl is only valid for link channels');
    }
    // voiceDisabled only applies to voice channels.
    if (body.voiceDisabled !== undefined && existing.type !== 'guild_voice') {
      throw errors.badRequest('voiceDisabled is only valid for voice channels');
    }

    const updated = await channels.updateChannel({
      channelId,
      actorId: userId,
      name: body.name,
      topic: body.topic,
      position: body.position,
      parentId:
        body.parentId === undefined ? undefined : body.parentId === null ? null : BigInt(body.parentId),
      nsfw: body.nsfw,
      rateLimitPerUser: body.rateLimitPerUser,
      voiceDisabled: body.voiceDisabled,
      linkUrl: body.linkUrl,
    });
    const channelDTO = toChannel(updated);
    if (existing.guildId) {
      dispatch.channelUpdate({ channelDTO, channelId, guildId: existing.guildId });
    }
    return c.json({ channel: channelDTO });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /:channelId
// ═══════════════════════════════════════════════════════════════════════════

channelsRouter.delete(
  '/:channelId',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const existing = await channels.getChannel(channelId);
    if (!existing || !existing.guildId) throw errors.notFound('Channel');
    // Channel-level MANAGE_CHANNELS. Without this, a moderator
    // denied VIEW_CHANNEL on a hidden channel can DELETE it —
    // catastrophic data loss on a channel they can't see. Same
    // family as #104.
    await assertChannelPermission(channelId, userId, Permissions.MANAGE_CHANNELS);
    const { cascadedChildIds } = await channels.deleteChannel(channelId, userId);

    // Voice / stage eviction. Without this, anyone currently in the
    // channel's LiveKit session keeps their token (valid up to ~1
    // hour) and continues to publish + subscribe in a channel that's
    // been soft-deleted out of every client's sidebar. Symmetric
    // with #112 (permission-change eviction) but triggered by the
    // delete path. Cheap when no one is in the channel — the
    // voice_states delete matches zero rows.
    const evictedVoice = await voice.evictAllVoiceInChannel(channelId);

    // Snapshot the existing row for the dispatch payload — by the time the
    // event fires the row is soft-deleted, so we use the pre-delete state.
    dispatch.channelDelete({
      channelDTO: toChannel(existing),
      channelId,
      guildId: existing.guildId,
    });

    // Cascade CHANNEL_DELETE for each child thread soft-deleted by
    // the service's cascade. Without this, clients keep the threads
    // in their local channel list until the next permission refresh —
    // ghost rows under a now-empty parent. The DTO only needs the
    // id (clients use it to drop from local state); we synthesize a
    // minimal channel shape rather than re-fetching each one.
    for (const childId of cascadedChildIds) {
      dispatch.channelDelete({
        channelDTO: {
          id: childId.toString(),
          guild_id: existing.guildId.toString(),
          // Type doesn't matter for the delete event — clients just
          // look up the id and remove it. Use 'public_thread' to
          // accurately reflect what was deleted in case any client
          // logs the event.
          type: 'public_thread',
        },
        channelId: childId,
        guildId: existing.guildId,
      });
    }

    // Broadcast the voice disconnects so remaining guild members'
    // UIs update (member sidebar's "in voice" badge, channel
    // sidebar's participant list). One event per evicted user;
    // each shows them as no longer in voice.
    for (const row of evictedVoice) {
      dispatch.voiceStateUpdate({
        guildId: existing.guildId,
        channelId: row.channelId,
        voiceState: leftVoiceStateDTO({
          userId: row.userId,
          guildId: existing.guildId,
          channelId: row.channelId,
        }),
      });
    }

    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Permission overrides
// ═══════════════════════════════════════════════════════════════════════════

channelsRouter.get(
  '/:channelId/permissions',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await channels.getChannel(channelId);
    if (!channel || !channel.guildId) throw errors.notFound('Channel');
    // Channel-level (not guild-level) MANAGE_ROLES. The override
    // routes ALL use the same gate to prevent a moderator who is
    // denied VIEW_CHANNEL on a hidden channel from listing its
    // overrides — which would leak the channel's existence and
    // ACL structure even when they can't see the channel itself.
    // See PUT/DELETE below for the deeper bypass these guards
    // close (deleting the @everyone-deny that hid the channel).
    await assertChannelPermission(channelId, userId, Permissions.MANAGE_ROLES);

    const list = await channels.listOverrides(channelId);
    return c.json({ overrides: list.map(toPermissionOverride) });
  },
);

const overrideSchema = z.object({
  type: z.enum(['role', 'member']),
  allow: permissionsSchema.optional(),
  deny: permissionsSchema.optional(),
});

channelsRouter.put(
  '/:channelId/permissions/:targetId',
  validate(
    'param',
    z.object({ channelId: snowflakeSchema, targetId: snowflakeSchema }),
  ),
  validate('json', overrideSchema),
  async (c) => {
    const userId = requireUserId(c);
    const { channelId: cid, targetId: tid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const channel = await channels.getChannel(channelId);
    if (!channel || !channel.guildId) throw errors.notFound('Channel');
    // Channel-level MANAGE_ROLES (not guild-level). Without this,
    // a moderator with guild-wide MANAGE_ROLES who is denied
    // VIEW_CHANNEL on a hidden channel could still manipulate
    // its overrides — including granting themselves a member
    // override allowing VIEW_CHANNEL. The grant-what-you-have
    // check below would technically catch that specific case
    // (they don't have VIEW_CHANNEL on the channel) but the
    // channel-level gate is the cleaner primary defense and
    // matches Discord's semantics.
    await assertChannelPermission(channelId, userId, Permissions.MANAGE_ROLES);

    const body = c.req.valid('json');
    const targetId = BigInt(tid);

    // Three additional authz checks beyond the MANAGE_ROLES gate
    // above. Without these, MANAGE_ROLES is a backdoor to:
    //
    //   1. Hiding channels from higher-ranked roles. A role-type
    //      override targeting a role HIGHER than the actor's top
    //      role with deny:VIEW_CHANNEL would suppress that role
    //      from this channel. Admins (who hold the higher role)
    //      can't see the channel anymore.
    //   2. Self-grant escalation. A member-type override on the
    //      actor themselves granting SEND_MESSAGES (or any other
    //      channel-scoped permission they normally wouldn't have)
    //      bypasses the guild-level role-based access control.
    //   3. Grant-what-you-don't-have. The role-edit path at
    //      routes/guilds.ts checks "you cannot grant permissions
    //      you do not have yourself" but the channel-override path
    //      didn't; an actor with MANAGE_ROLES but not MENTION_EVERYONE
    //      could allow MENTION_EVERYONE in a channel by overriding it.
    //
    // The hierarchy / member-management checks match the patterns
    // used elsewhere (role-edit, direct member-role assignment).
    // The grant-what-you-don't-have check only applies to ALLOW
    // bits — DENY bits are monotonic-downward (taking away a
    // permission can't escalate the target), so unrestricted.
    if (body.type === 'role') {
      await assertCanManageRole(channel.guildId, userId, targetId);
    } else {
      await assertCanManageMember(channel.guildId, userId, targetId);
    }
    if (body.allow !== undefined && body.allow !== 0n) {
      const callerPerms = await computeMemberGuildPermissions(channel.guildId, userId);
      if (!hasPermission(callerPerms, body.allow)) {
        throw errors.forbidden('You cannot grant permissions you do not have yourself');
      }
    }

    const result = await channels.upsertOverride({
      channelId,
      actorId: userId,
      targetType: body.type,
      targetId,
      allow: body.allow ?? 0n,
      deny: body.deny ?? 0n,
    });
    // The override change can flip VIEW_CHANNEL on this channel for any
    // connected member of the guild — refresh their caches and dispatch
    // the appropriate CHANNEL_CREATE/CHANNEL_DELETE transitions. We
    // refresh on BOTH the upsert and the delete branches; the helper is
    // a no-op when nothing actually changed visibility for a given user.
    await dispatch.applyGuildPermissionChange({ guildId: channel.guildId });
    if (!result) return c.json({ ok: true, deleted: true });
    return c.json({
      override: toPermissionOverride({
        channelId,
        targetType: result.targetType,
        targetId: result.targetId,
        allow: result.allow,
        deny: result.deny,
      }),
    });
  },
);

channelsRouter.delete(
  '/:channelId/permissions/:targetId',
  validate(
    'param',
    z.object({ channelId: snowflakeSchema, targetId: snowflakeSchema }),
  ),
  validate('query', z.object({ type: z.enum(['role', 'member']) })),
  async (c) => {
    const userId = requireUserId(c);
    const { channelId: cid, targetId: tid } = c.req.valid('param');
    const { type } = c.req.valid('query');
    const channelId = BigInt(cid);
    const channel = await channels.getChannel(channelId);
    if (!channel || !channel.guildId) throw errors.notFound('Channel');
    // Channel-level MANAGE_ROLES — see GET/PUT for the rationale.
    // Without this, a moderator denied VIEW_CHANNEL could delete
    // the @everyone-deny override that's the only thing hiding
    // the channel, unhiding it for themselves AND everyone else
    // simultaneously.
    await assertChannelPermission(channelId, userId, Permissions.MANAGE_ROLES);

    const targetId = BigInt(tid);
    // Same hierarchy / member-management guards as PUT. Removing
    // an override for a role HIGHER than the actor's top would
    // unsuppress that role from the channel — equivalent to
    // granting them access. Removing a member-override on someone
    // outranking the actor is similarly out of their lane.
    if (type === 'role') {
      await assertCanManageRole(channel.guildId, userId, targetId);
    } else {
      await assertCanManageMember(channel.guildId, userId, targetId);
    }

    await channels.deleteOverride({
      channelId,
      actorId: userId,
      targetType: type,
      targetId,
    });
    await dispatch.applyGuildPermissionChange({ guildId: channel.guildId });
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Per-channel invite creation
// ═══════════════════════════════════════════════════════════════════════════

const createInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
  ttlSeconds: inviteTtlSchema.nullable().optional(),
});

channelsRouter.post(
  '/:channelId/invites',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', createInviteSchema.optional()),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await channels.getChannel(channelId);
    if (!channel || !channel.guildId) throw errors.notFound('Channel');
    await assertChannelPermission(channelId, userId, Permissions.CREATE_INVITE);

    const body =
      (c.req.valid('json') as { maxUses?: number | null; ttlSeconds?: number | null } | undefined) ?? {};
    const ttl = body.ttlSeconds === undefined ? INVITE_DEFAULT_TTL : body.ttlSeconds;
    const invite = await invites.createInvite({
      guildId: channel.guildId,
      channelId,
      inviterId: userId,
      maxUses: body.maxUses ?? null,
      ttlSeconds: ttl,
    });
    return c.json({ invite: toInvite(invite) }, 201);
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Channel CREATION lives under /api/v1/guilds/:guildId/channels
// — exported as its own mini-router so server.ts can mount it inside the
// guildsRouter prefix without re-declaring the parent path here.
// ═══════════════════════════════════════════════════════════════════════════

export const guildChannelsRouter = new Hono();
guildChannelsRouter.use('*', requireAuth);

const createChannelSchema = z.object({
  type: z.enum(['guild_text', 'guild_category', 'guild_voice', 'guild_stage', 'guild_forum', 'guild_link']),
  name: channelNameSchema,
  topic: channelTopicSchema.optional(),
  parentId: snowflakeSchema.nullable().optional(),
  nsfw: z.boolean().optional(),
  rateLimitPerUser: slowmodeSchema.optional(),
  /** Required when type='guild_link'. http(s) URL, ≤2048 chars to
      match common URL-length norms. The service layer rejects URL
      values on non-link types. */
  linkUrl: z
    .string()
    .trim()
    .max(2048)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), {
      message: 'Link URL must use http or https',
    })
    .optional(),
});

guildChannelsRouter.post(
  '/:guildId/channels',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', createChannelSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_CHANNELS);

    const body = c.req.valid('json');
    const channel = await channels.createChannel({
      guildId,
      actorId: userId,
      type: body.type,
      name: body.name,
      topic: body.topic ?? null,
      parentId: body.parentId === undefined || body.parentId === null ? null : BigInt(body.parentId),
      nsfw: body.nsfw,
      rateLimitPerUser: body.rateLimitPerUser,
      linkUrl: body.linkUrl ?? null,
    });
    const channelDTO = toChannel(channel);
    // Channel-create no longer broadcasts CHANNEL_CREATE to the whole guild
    // audience. Instead, applyGuildPermissionChange diffs each connected
    // member's viewable-channel cache and dispatches a per-user CHANNEL_CREATE
    // (with full DTO) only to those who actually gained visibility. That
    // path is more correct (it respects per-channel overrides at create
    // time, when those become a feature) and avoids the duplicate frame
    // every member previously received. Awaited so the response only
    // returns once the gateway is in a coherent state.
    await dispatch.applyGuildPermissionChange({ guildId });
    return c.json({ channel: channelDTO }, 201);
  },
);

guildChannelsRouter.get(
  '/:guildId/channels',
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await ensureMember(guildId, userId);
    const all = await channels.listGuildChannels(guildId);

    // Filter to channels the caller can actually view. Previously this
    // route returned every channel in the guild regardless of the
    // user's permissions — a data leak: clients received (and would
    // render) channels the user lacks VIEW_CHANNEL on. Now we run
    // the same resolver the gateway uses for READY, which also
    // handles empty-category prune and orphan-child rescue via the
    // shared reconcileCategoryVisibility post-processor. Admins
    // (owner / ADMINISTRATOR) still see everything via the
    // resolver's short-circuit branch.
    const { listViewableGuildChannelIds } = await import(
      '../services/permissions'
    );
    const viewableIds = await listViewableGuildChannelIds(guildId, userId);
    const viewable = new Set(viewableIds.map((id) => id.toString()));
    const list = all.filter((ch) => viewable.has(ch.id.toString()));

    // Look up which channels in the viewable set have any permission
    // overrides — used purely as a UI hint so the client can render
    // a lock glyph next to restricted channels. We grab the distinct
    // channel ids from permission_overrides and join in memory; this
    // saves a per-channel query at the cost of one extra round-trip.
    //
    // A child channel is also considered restricted when its PARENT
    // category has overrides — the parent's permissions cascade to
    // children, so the lock icon should bubble down accordingly.
    // Categories are themselves channels (type 'guild_category') so
    // they're already in channelIds; the same selectDistinct catches
    // both channel-level and category-level overrides, and we just
    // need to look up each child's parentId in the resulting set.
    const { db, schema } = await import('../db');
    const { sql, inArray } = await import('drizzle-orm');
    const channelIds = list.map((ch) => ch.id);
    const restrictedSet = new Set<string>();
    if (channelIds.length > 0) {
      const rows = await db
        .selectDistinct({ channelId: schema.permissionOverrides.channelId })
        .from(schema.permissionOverrides)
        .where(inArray(schema.permissionOverrides.channelId, channelIds));
      for (const r of rows) restrictedSet.add(r.channelId.toString());
    }
    void sql; // silence unused if drizzle reshapes the helper api
    return c.json({
      channels: list.map((ch) => {
        const dto = toChannel(ch);
        // Self-overrides → restricted
        if (restrictedSet.has(ch.id.toString())) {
          dto.restricted = true;
        } else if (ch.parentId !== null && restrictedSet.has(ch.parentId.toString())) {
          // Parent category has overrides → child inherits the lock
          dto.restricted = true;
        }
        return dto;
      }),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:guildId/channels/positions — bulk reorder
// ═══════════════════════════════════════════════════════════════════════════
//
// Drag-and-drop reordering sends the entire desired order as a single
// payload. The server overwrites positions atomically, dispatches
// CHANNEL_UPDATE for each row whose position or parent actually
// changed, and returns the updated list.
//
// Why bulk: doing one PATCH per channel would require N round trips
// AND would leave the client showing intermediate inconsistent states
// during the drag (e.g., two channels at position 3 simultaneously
// after the first response but before the second). Atomic bulk fixes
// both — the wire stays consistent and the UI just sends the final
// state once.

const reorderSchema = z.object({
  channels: z
    .array(
      z.object({
        id: snowflakeSchema,
        position: z.number().int().min(0).max(10_000),
        // null = root (no parent). Undefined = "leave parent alone".
        // Sending null explicitly is how you drag a channel OUT of a
        // category back to the top level.
        parentId: snowflakeSchema.nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

guildChannelsRouter.patch(
  '/:guildId/channels/positions',
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', reorderSchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    await assertGuildPermission(guildId, userId, Permissions.MANAGE_CHANNELS);

    const body = c.req.valid('json');
    const updates = body.channels.map((row) => ({
      channelId: BigInt(row.id),
      position: row.position,
      parentId:
        row.parentId === undefined ? undefined : row.parentId === null ? null : BigInt(row.parentId),
    }));

    const changed = await channels.reorderChannels({
      guildId,
      actorId: userId,
      updates,
    });

    // Dispatch a CHANNEL_UPDATE for each row that actually changed —
    // skip no-ops to avoid spurious wire chatter on a drag that ended
    // where it started.
    for (const ch of changed) {
      dispatch.channelUpdate({
        channelDTO: toChannel(ch),
        channelId: ch.id,
        guildId,
      });
    }

    // Moving a channel into (or out of) a category changes its
    // effective permissions because the category's overrides apply
    // first in the resolver. If any reorder row changed `parentId`,
    // a connected member's viewable-channel cache could go stale,
    // so refresh per-user caches and dispatch CHANNEL_CREATE/DELETE
    // for any visibility transitions that result. We only fire this
    // when a parent actually changed — pure position swaps within
    // the same parent don't affect permissions and the bulk-refresh
    // helper is non-trivial (one query plus a per-connected-user
    // diff), so skipping it on the common drag-within-category case
    // matters.
    const anyReparented = changed.some((ch) => {
      const original = body.channels.find((u) => BigInt(u.id) === ch.id);
      return original?.parentId !== undefined;
    });
    if (anyReparented) {
      await dispatch.applyGuildPermissionChange({ guildId });
    }

    return c.json({ channels: changed.map((ch) => toChannel(ch)) });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Thread archive / unarchive
// ───────────────────────────────────────────────────────────────────────────
//
// POST /channels/:id/archive   → archive a thread (mark archived_at = now)
// POST /channels/:id/unarchive → clear archived_at + refresh activity stamp
//
// Authorization:
//   - MANAGE_THREADS on the guild lets you archive/unarchive any thread
//   - Without MANAGE_THREADS, the post creator can still archive their
//     own post (tidy-up affordance). Creator = author of the anchor
//     message for message-rooted threads, OR author of the first
//     message in the thread for forum posts.
//
// 404 for non-threads — the endpoint only exists for type='public_thread'
// channels. Guild-text/voice/category/forum get a not-found rather than
// a 400 so the surface doesn't leak structural info to non-members.

async function resolveThreadCreator(thread: typeof schema.channels.$inferSelect): Promise<bigint | null> {
  // Anchor-rooted thread: creator = author of the anchor message.
  if (thread.parentMessageId !== null) {
    const [m] = await db
      .select({ authorId: schema.messages.authorId })
      .from(schema.messages)
      .where(eq(schema.messages.id, thread.parentMessageId))
      .limit(1);
    return m?.authorId ?? null;
  }
  // Forum post (no anchor): creator = author of the first message in
  // the thread. ORDER BY id ASC because snowflake ids are
  // monotonically time-ordered, so the smallest id wins.
  const [first] = await db
    .select({ authorId: schema.messages.authorId })
    .from(schema.messages)
    .where(eq(schema.messages.channelId, thread.id))
    .orderBy(schema.messages.id)
    .limit(1);
  return first?.authorId ?? null;
}

async function handleArchiveTransition(
  c: import('hono').Context,
  archived: boolean,
) {
  const userId = requireUserId(c);
  const threadId = BigInt(c.req.param('channelId')!);

  const [thread] = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, threadId))
    .limit(1);
  if (!thread || thread.deletedAt) throw errors.notFound('Channel');
  if (thread.type !== 'public_thread') {
    // Archive lifecycle only applies to threads. Other channel types
    // get a 404 to avoid leaking structural info.
    throw errors.notFound('Channel');
  }
  if (!thread.guildId) {
    throw errors.forbidden('Threads only exist in guild channels');
  }

  // Idempotent: if state already matches request, return success
  // without writing. Avoids spamming broadcasts on rage-clicked
  // archive buttons.
  const isAlreadyArchived = thread.threadArchivedAt !== null;
  if (isAlreadyArchived === archived) {
    return c.json({ channel: toChannel(thread) });
  }

  // Authorization: MANAGE_THREADS lets you archive any thread.
  // Without it, only the post creator can archive their own.
  const perms = await computeMemberGuildPermissions(thread.guildId, userId);
  if (!hasPermission(perms, Permissions.MANAGE_THREADS)) {
    const creatorId = await resolveThreadCreator(thread);
    if (creatorId !== userId) {
      throw errors.missingPermissions(['MANAGE_THREADS']);
    }
  }

  const updated = await import('../services/threads').then((m) =>
    m.archiveThread(threadId, archived),
  );
  if (!updated) throw errors.notFound('Channel');

  // Broadcast the state change. CHANNEL_UPDATE carries the full
  // refreshed DTO; client reducers patch the channel row in place.
  dispatch.channelUpdate({
    channelDTO: toChannel(updated),
    channelId: updated.id,
    guildId: thread.guildId,
  });

  return c.json({ channel: toChannel(updated) });
}

channelsRouter.post(
  '/:channelId/archive',
  validate('param', z.object({ channelId: snowflakeSchema })),
  (c) => handleArchiveTransition(c, true),
);

channelsRouter.post(
  '/:channelId/unarchive',
  validate('param', z.object({ channelId: snowflakeSchema })),
  (c) => handleArchiveTransition(c, false),
);

// ── Thread resolved-state ──────────────────────────────────────────────
//
// POST /channels/:id/resolve   → mark thread resolved (sets thread_resolved_at = now)
// POST /channels/:id/unresolve → clear resolved state
//
// Authorization mirrors archive:
//   - MANAGE_THREADS lets you toggle any thread's resolved state
//   - Without MANAGE_THREADS, the thread creator can toggle their own
// Idempotent: posting the same state twice is a no-op success.

async function handleResolveTransition(
  c: import('hono').Context,
  resolved: boolean,
) {
  const userId = requireUserId(c);
  const threadId = BigInt(c.req.param('channelId')!);

  const [thread] = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, threadId))
    .limit(1);
  if (!thread || thread.deletedAt) throw errors.notFound('Channel');
  if (thread.type !== 'public_thread') {
    throw errors.notFound('Channel');
  }
  if (!thread.guildId) {
    throw errors.forbidden('Threads only exist in guild channels');
  }

  // Idempotent.
  const isAlreadyResolved = thread.threadResolvedAt !== null;
  if (isAlreadyResolved === resolved) {
    return c.json({ channel: toChannel(thread) });
  }

  const perms = await computeMemberGuildPermissions(thread.guildId, userId);
  if (!hasPermission(perms, Permissions.MANAGE_THREADS)) {
    const creatorId = await resolveThreadCreator(thread);
    if (creatorId !== userId) {
      throw errors.missingPermissions(['MANAGE_THREADS']);
    }
  }

  const updated = await import('../services/threads').then((m) =>
    m.setThreadResolved(threadId, resolved),
  );
  if (!updated) throw errors.notFound('Channel');

  dispatch.channelUpdate({
    channelDTO: toChannel(updated),
    channelId: updated.id,
    guildId: thread.guildId,
  });

  return c.json({ channel: toChannel(updated) });
}

channelsRouter.post(
  '/:channelId/resolve',
  validate('param', z.object({ channelId: snowflakeSchema })),
  (c) => handleResolveTransition(c, true),
);

channelsRouter.post(
  '/:channelId/unresolve',
  validate('param', z.object({ channelId: snowflakeSchema })),
  (c) => handleResolveTransition(c, false),
);
