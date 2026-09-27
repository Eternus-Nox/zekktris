/**
 * Stage channel routes
 * --------------------
 * Mounted at /api/v1/channels/:channelId/stage. Endpoints:
 *
 *   POST /join          — join the stage; server returns a LiveKit token
 *                         (publish=true if speaker, false if audience).
 *                         Idempotent.
 *   POST /leave         — leave the stage. Idempotent.
 *   POST /hand          — raise hand (request to speak). Audience-only;
 *                         no-op for speakers.
 *   DELETE /hand        — lower hand. Idempotent.
 *   POST /speakers      — moderator promote/demote. Body: { userId, isSpeaker }
 *   PATCH /topic        — moderator set the stage topic banner. Body: { topic }
 *   GET ./              — list current participants (any guild member).
 *
 * Token handling: when a user is promoted / demoted, the route fans
 * out a STAGE_PARTICIPANTS_UPDATE event AND a private one-shot
 * RECONNECT signal to the affected user. The client reconnects to
 * LiveKit with a freshly-minted token that has the new permissions.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { snowflakeSchema } from '../lib/validation';
import { toChannel, toStageParticipant } from '../lib/dto';
import * as stage from '../services/stage';
import * as voice from '../services/voice';
import { db, schema } from '../db';
import { eq } from 'drizzle-orm';
import * as dispatch from '../gateway/dispatch';

export const stageRouter = new Hono();
stageRouter.use('*', requireAuth);

// ── Helper: load and verify the channel is a stage ───────────────────────

async function requireStageChannel(channelId: bigint): Promise<schema.Channel> {
  const rows = await db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  const ch = rows[0];
  if (!ch) throw errors.notFound('Channel');
  if (ch.type !== 'guild_stage') {
    throw errors.badRequest('Not a stage channel');
  }
  if (!ch.guildId) {
    throw errors.internal('Stage channel without guild');
  }
  return ch;
}

async function broadcastParticipants(channel: schema.Channel) {
  if (!channel.guildId) return;
  const list = await stage.listParticipants(channel.id);
  dispatch.stageParticipantsUpdate({
    guildId: channel.guildId,
    channelId: channel.id,
    participants: list.map(toStageParticipant),
  });
}

// ── List participants ────────────────────────────────────────────────────

stageRouter.get(
  '/:channelId/stage',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await requireStageChannel(channelId);
    // Membership check via permission resolver — non-members get a
    // 404, not an empty list.
    const { computeMemberChannelPermissions, hasPermission, Permissions } = await import(
      '../services/permissions'
    );
    const perms = await computeMemberChannelPermissions(channelId, userId);
    if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) {
      throw errors.notFound('Channel');
    }
    const list = await stage.listParticipants(channelId);
    return c.json({
      channel: toChannel(channel),
      participants: list.map(toStageParticipant),
    });
  },
);

// ── Join ─────────────────────────────────────────────────────────────────

stageRouter.post(
  '/:channelId/stage/join',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await requireStageChannel(channelId);
    const { participant, publishSources } = await stage.joinStage({
      channelId,
      userId,
      guildId: channel.guildId!,
    });

    // Mint LiveKit token with publish gated on speaker status, and
    // sources gated on parental controls (audio-only children must not
    // get camera/screen-share grants just because they were promoted).
    // An instance-muted account never gets a publishing grant, even if it
    // is (still) a speaker — the stage equivalent of joinVoice's clamp.
    const { getInstanceMute } = await import('../services/instanceMutes');
    const muted = (await getInstanceMute(userId)) !== null;
    const token = await voice.mintLivekitToken(
      userId,
      channelId,
      channel.guildId!,
      participant.isSpeaker && !muted,
      publishSources,
    );

    await broadcastParticipants(channel);

    return c.json({
      participant: toStageParticipant(participant),
      token: token.token,
      wsUrl: token.wsUrl,
    });
  },
);

// ── Leave ────────────────────────────────────────────────────────────────

stageRouter.post(
  '/:channelId/stage/leave',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await requireStageChannel(channelId);
    await stage.leaveStage({ channelId, userId });
    await broadcastParticipants(channel);
    return c.body(null, 204);
  },
);

// ── Raise / lower hand ───────────────────────────────────────────────────

stageRouter.post(
  '/:channelId/stage/hand',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await requireStageChannel(channelId);
    await stage.setHandRaised({ channelId, userId, raised: true });
    await broadcastParticipants(channel);
    return c.body(null, 204);
  },
);

stageRouter.delete(
  '/:channelId/stage/hand',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const channel = await requireStageChannel(channelId);
    await stage.setHandRaised({ channelId, userId, raised: false });
    await broadcastParticipants(channel);
    return c.body(null, 204);
  },
);

// ── Promote / demote (moderator) ─────────────────────────────────────────

const speakerBodySchema = z.object({
  userId: snowflakeSchema,
  isSpeaker: z.boolean(),
});

stageRouter.post(
  '/:channelId/stage/speakers',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', speakerBodySchema),
  async (c) => {
    const actorId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const body = c.req.valid('json');
    const channel = await requireStageChannel(channelId);

    const updated = await stage.setSpeaker({
      channelId,
      targetUserId: BigInt(body.userId),
      actorId,
      isSpeaker: body.isSpeaker,
    });

    // Re-mint a token for the affected user — they need new publish
    // permissions on the LiveKit side. The client receives the
    // STAGE_PARTICIPANTS_UPDATE event, sees their own row changed,
    // and calls join again to refresh. That's a small round-trip
    // cost (token re-fetch + LiveKit reconnect ~500ms), acceptable
    // for what is a low-frequency action. We DON'T proactively
    // tear down their session here — that would race with the
    // client's reconnect.

    await broadcastParticipants(channel);

    return c.json({ participant: toStageParticipant(updated) });
  },
);

// ── Topic (moderator) ────────────────────────────────────────────────────

const topicBodySchema = z.object({
  topic: z.string().max(1024).nullable(),
});

stageRouter.patch(
  '/:channelId/stage/topic',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', topicBodySchema),
  async (c) => {
    const actorId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const body = c.req.valid('json');
    await requireStageChannel(channelId);

    const updated = await stage.setStageTopic({ channelId, actorId, topic: body.topic });

    // Topic update goes out via the existing channel-update event so
    // the client's channel-list reducer picks it up alongside other
    // channel mutations. No bespoke event needed.
    if (updated.guildId) {
      dispatch.channelUpdate({
        channelDTO: toChannel(updated),
        channelId: updated.id,
        guildId: updated.guildId,
      });
    }
    return c.json({ channel: toChannel(updated) });
  },
);
