/**
 * Stage channels service
 * ----------------------
 * Stage channels are voice rooms with a speaker/audience model: only
 * speakers publish audio, audience members listen. A stage moderator
 * (anyone with MANAGE_CHANNELS on the channel) can promote audience
 * members to speakers and demote them back. Audience members can
 * "raise hand" to ask for promotion; the raised-hand list is visible
 * to mods.
 *
 * Storage: `stage_participants` is a (channelId, userId) table that
 * carries `isSpeaker` and `handRaised`. Rows are created on join and
 * deleted on leave. The room's "current state" is computed by
 * SELECT * WHERE channel_id = ? — no caching layer.
 *
 * LiveKit integration: this service owns the publish/subscribe
 * permission model. The voice service's `getJoinToken` is called
 * with a flag derived from `isSpeaker`. Promote/demote calls also
 * use LiveKit's UpdateParticipant API to forcibly change the
 * live participant's `canPublish` bit at the SFU level. Token
 * re-issue alone is a cooperative-client model — a demoted
 * speaker who refuses to disconnect/reconnect could keep
 * publishing for up to the token TTL (~1 hour). UpdateParticipant
 * makes the change authoritative regardless of whether the
 * client cooperates, and best-effort so a SFU outage doesn't
 * break the DB-side state change.
 */

import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { env } from '../env';
import { log } from '../log';
import { RoomServiceClient } from 'livekit-server-sdk';
import {
  Permissions,
  computeMemberChannelPermissions,
  hasPermission,
} from './permissions';

// ── Reads ────────────────────────────────────────────────────────────────

/** Return all participants (speakers + audience) in a stage channel. */
export async function listParticipants(channelId: bigint) {
  return db
    .select()
    .from(schema.stageParticipants)
    .where(eq(schema.stageParticipants.channelId, channelId));
}

export async function getParticipant(channelId: bigint, userId: bigint) {
  const r = await db
    .select()
    .from(schema.stageParticipants)
    .where(
      and(
        eq(schema.stageParticipants.channelId, channelId),
        eq(schema.stageParticipants.userId, userId),
      ),
    )
    .limit(1);
  return r[0] ?? null;
}

// ── Join ─────────────────────────────────────────────────────────────────

/**
 * Join a stage channel.
 *
 * Behavior:
 *   - First user to join (empty room) becomes the speaker if they
 *     have MANAGE_CHANNELS — this lets a moderator host without
 *     needing a second mod to promote them. Otherwise audience.
 *   - Returns the updated participant row + a flag indicating whether
 *     the user is a speaker (so the caller can decide what kind of
 *     LiveKit token to issue).
 *   - Idempotent: if the user is already in the room, returns the
 *     existing row without changes.
 */
export async function joinStage(args: {
  channelId: bigint;
  userId: bigint;
}): Promise<{ participant: schema.StageParticipant; isFirstJoiner: boolean }> {
  const existing = await getParticipant(args.channelId, args.userId);
  if (existing) return { participant: existing, isFirstJoiner: false };

  // Check membership and permissions on the channel. Audience-side
  // join needs VIEW_CHANNEL + CONNECT (we reuse the voice CONNECT
  // permission for stage too); moderators need MANAGE_CHANNELS for
  // the host-as-speaker bootstrap.
  const perms = await computeMemberChannelPermissions(args.channelId, args.userId);
  if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) {
    throw errors.notFound('Channel');
  }
  if (!hasPermission(perms, Permissions.CONNECT)) {
    throw errors.missingPermissions(['CONNECT']);
  }
  const isMod = hasPermission(perms, Permissions.MANAGE_CHANNELS);

  // Empty-room check: the first user with MANAGE_CHANNELS becomes
  // the speaker. This avoids the "host stuck as audience" deadlock
  // that would otherwise require a second moderator to promote them.
  const occupants = await listParticipants(args.channelId);
  const isFirstJoiner = occupants.length === 0;
  const startAsSpeaker = isFirstJoiner && isMod;

  const [row] = await db
    .insert(schema.stageParticipants)
    .values({
      channelId: args.channelId,
      userId: args.userId,
      isSpeaker: startAsSpeaker,
      handRaised: false,
    })
    .returning();
  if (!row) throw errors.internal('Stage participant insert returned no row');
  return { participant: row, isFirstJoiner };
}

// ── Leave ────────────────────────────────────────────────────────────────

/** Leave a stage channel. Idempotent — leaving when not present is a no-op. */
export async function leaveStage(args: {
  channelId: bigint;
  userId: bigint;
}): Promise<schema.StageParticipant | null> {
  const [row] = await db
    .delete(schema.stageParticipants)
    .where(
      and(
        eq(schema.stageParticipants.channelId, args.channelId),
        eq(schema.stageParticipants.userId, args.userId),
      ),
    )
    .returning();
  return row ?? null;
}

// ── Promote / demote (moderator action) ──────────────────────────────────

/**
 * Set a user's speaker bit. Moderator-only — the caller must have
 * MANAGE_CHANNELS on the channel. Setting to true also clears the
 * raised-hand flag if the user had one set.
 */
export async function setSpeaker(args: {
  channelId: bigint;
  targetUserId: bigint;
  actorId: bigint;
  isSpeaker: boolean;
}): Promise<schema.StageParticipant> {
  const perms = await computeMemberChannelPermissions(args.channelId, args.actorId);
  if (!hasPermission(perms, Permissions.MANAGE_CHANNELS)) {
    throw errors.missingPermissions(['MANAGE_CHANNELS']);
  }
  const target = await getParticipant(args.channelId, args.targetUserId);
  if (!target) throw errors.notFound('Stage participant');

  const [row] = await db
    .update(schema.stageParticipants)
    .set({
      isSpeaker: args.isSpeaker,
      // Clear hand on promotion — they got what they asked for. Don't
      // touch on demotion since a raised hand is meaningful only from
      // an audience member.
      handRaised: args.isSpeaker ? false : target.handRaised,
    })
    .where(
      and(
        eq(schema.stageParticipants.channelId, args.channelId),
        eq(schema.stageParticipants.userId, args.targetUserId),
      ),
    )
    .returning();
  if (!row) throw errors.internal('Stage promote update returned no row');

  // Force the live participant's permissions at the SFU. Without
  // this call, a demoted speaker can keep publishing audio for up
  // to the token TTL (~1h) even though our DB says they're now
  // audience — LiveKit tokens are validated at join, not refreshed.
  // We need the channel's guild id to construct the room name; the
  // stage_participants row carries the channelId, the channels
  // table the guildId. One small SELECT here on a low-frequency
  // op (mod-issued promote/demote) is fine.
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const httpUrl =
    env.LIVEKIT_HTTP_URL ??
    env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
      m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
    );
  if (apiKey && apiSecret && httpUrl) {
    const [chRow] = await db
      .select({ guildId: schema.channels.guildId })
      .from(schema.channels)
      .where(eq(schema.channels.id, args.channelId))
      .limit(1);
    if (chRow?.guildId) {
      const roomName = `g${chRow.guildId.toString()}-c${args.channelId.toString()}`;
      const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
      try {
        await svc.updateParticipant(
          roomName,
          args.targetUserId.toString(),
          undefined,
          {
            canPublish: args.isSpeaker,
            canSubscribe: true,
            canPublishData: false,
          },
        );
      } catch (err) {
        // Participant likely not currently connected (token issued
        // but not yet redeemed, or they've left the room). Best-
        // effort — the DB row and gateway broadcast still convey
        // the new state; if they reconnect they'll get a fresh
        // token with the correct grants from joinStage's mint
        // path.
        log.warn?.(
          'livekit updateParticipant failed during stage promote/demote (best-effort)',
          {
            userId: args.targetUserId.toString(),
            channelId: args.channelId.toString(),
            isSpeaker: args.isSpeaker,
            err: (err as Error).message,
          },
        );
      }
    }
  }

  return row;
}

// ── Raise / lower hand ───────────────────────────────────────────────────

/**
 * The audience-side "request to speak" toggle. Self-service — any
 * audience member can call this on themselves. No-op for speakers
 * (the field is meaningless when isSpeaker=true) and for users not
 * currently in the room.
 */
export async function setHandRaised(args: {
  channelId: bigint;
  userId: bigint;
  raised: boolean;
}): Promise<schema.StageParticipant> {
  const target = await getParticipant(args.channelId, args.userId);
  if (!target) throw errors.notFound('Stage participant');
  // No-op for current speakers — they already have the floor.
  if (target.isSpeaker) return target;

  const [row] = await db
    .update(schema.stageParticipants)
    .set({ handRaised: args.raised })
    .where(
      and(
        eq(schema.stageParticipants.channelId, args.channelId),
        eq(schema.stageParticipants.userId, args.userId),
      ),
    )
    .returning();
  if (!row) throw errors.internal('Stage hand update returned no row');
  return row;
}

// ── Topic update (moderator action) ──────────────────────────────────────

/**
 * Set the stage's topic banner. Stored on the channel itself (the
 * `topic` column already exists). Moderator-only.
 */
export async function setStageTopic(args: {
  channelId: bigint;
  actorId: bigint;
  topic: string | null;
}): Promise<schema.Channel> {
  const perms = await computeMemberChannelPermissions(args.channelId, args.actorId);
  if (!hasPermission(perms, Permissions.MANAGE_CHANNELS)) {
    throw errors.missingPermissions(['MANAGE_CHANNELS']);
  }
  const trimmed = args.topic?.trim() ?? null;
  if (trimmed && trimmed.length > 1024) {
    throw errors.badRequest('Stage topic must be 1024 chars or fewer');
  }
  const [row] = await db
    .update(schema.channels)
    .set({ topic: trimmed })
    .where(eq(schema.channels.id, args.channelId))
    .returning();
  if (!row) throw errors.notFound('Channel');
  return row;
}
