/**
 * Voice routes
 * ------------
 * Mounted under /api/v1 alongside channels.ts. Three endpoints:
 *
 *   POST /channels/:channelId/voice/join     join voice; returns SFU token
 *   POST /channels/:channelId/voice/state    update self-mute / self-deaf
 *   DELETE /channels/:channelId/voice         leave voice
 *
 * The SFU token returned by join is currently null — the voice service
 * is presence-only until the LiveKit integration round lands. Clients
 * surface "voice connection coming soon" when they see a null token but
 * still update their presence so other users can see the participant
 * count.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { snowflakeSchema } from '../lib/validation';
import { toVoiceState, leftVoiceStateDTO, toMessage } from '../lib/dto';
import * as voice from '../services/voice';
import * as dispatch from '../gateway/dispatch';
import { getChannel } from '../services/channels';
import { getOtherRecipient } from '../services/dms';
import * as dms from '../services/dms';
import { errors } from '../errors';
import {
  ensureMember,
  hasPermission,
  computeMemberChannelPermissions,
  Permissions,
} from '../services/permissions';
import { sendToUser } from '../services/push';
import { signCallDeclineToken } from '../auth/callDeclineToken';
import { db, schema } from '../db';

export const voiceRouter = new Hono();
voiceRouter.use('*', requireAuth);

/**
 * Dispatch a system_call message that voice.leaveVoice wrote when the
 * last participant left a 1:1 DM call. Looks up the author (the call
 * initiator) to populate the DTO, then fires MESSAGE_CREATE on the
 * gateway — same fan-out path createMessage uses, so the call record
 * appears in the DM transcript on both clients immediately.
 *
 * The DM channel is NOT in a guild so the dispatch's `guildId` field
 * is null; that routes the event to the DM recipient set instead of
 * a guild audience.
 */
async function dispatchSystemCallMessage(
  channelId: bigint,
  message: schema.Message,
): Promise<void> {
  let author: schema.User | null = null;
  if (message.authorId !== null) {
    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, message.authorId))
      .limit(1);
    author = row ?? null;
  }
  const messageDTO = toMessage({ message, author });
  dispatch.messageCreate({
    messageDTO,
    channelId,
    guildId: null,
  });
}

// ── Roster snapshot (read-only) ─────────────────────────────────────────────

/**
 * GET /channels/:channelId/voice/states — who is in this voice channel, now.
 *
 * The roster is otherwise EVENT-ONLY: clients build it from VOICE_STATE_UPDATE
 * frames plus the snapshot embedded in their own join response. That means a
 * single missed frame leaves a participant permanently invisible — you hear
 * them (LiveKit is a separate transport with its own reconnect) but never see
 * them, with nothing to heal it short of rejoining. Messages have three layers
 * of catch-up; voice states had none.
 *
 * This is that missing layer. Deliberately a plain GET with no side effects, so
 * it is safe to poll while in a call and safe to call from a reconcile path.
 *
 * PERMISSION: VIEW_CHANNEL only — NOT CONNECT. Seeing who is in a channel is
 * exactly what the channel list already shows; requiring CONNECT would hide the
 * roster from members who can look but not join. The join route keeps its
 * stricter gate (CONNECT + onboarding + timeout) because joining is an action.
 */
voiceRouter.get(
  '/:channelId/voice/states',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);

    const channel = await getChannel(channelId);
    if (!channel) throw errors.notFound('Voice channel');
    const isDmVoice = channel.type === 'dm' || channel.type === 'group_dm';
    if (!isDmVoice && channel.type !== 'guild_voice') throw errors.notFound('Voice channel');

    if (isDmVoice) {
      // Recipient-only, same as the join gate's first check. The richer
      // block/supervision/reachability policy joinVoice applies is about
      // STARTING or ANSWERING a call; reading the roster of a DM you are a
      // recipient of leaks nothing you cannot already see in the DM itself.
      await dms.ensureRecipient(channelId, userId);
    } else {
      if (!channel.guildId) throw errors.internal('Voice channel without guild');
      await ensureMember(channel.guildId, userId);
      const perms = await computeMemberChannelPermissions(channelId, userId);
      if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) throw errors.notFound('Voice channel');
    }

    const states = await voice.listChannelVoiceStates(channelId);
    return c.json({ voiceStates: states.map(toVoiceState) });
  },
);

// ── Join ────────────────────────────────────────────────────────────────────

voiceRouter.post(
  '/:channelId/voice/join',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);

    const result = await voice.joinVoice(userId, channelId);
    const dto = toVoiceState(result.voiceState);

    // If the user came from a different channel, tell the OLD
    // channel's audience that they've left. Without this, viewers
    // of the previous channel see the user's voice state stuck
    // pointing at their previous channel until they refresh.
    if (result.priorVoiceState) {
      dispatch.voiceStateUpdate({
        guildId: result.priorVoiceState.guildId,
        channelId: result.priorVoiceState.channelId,
        voiceState: leftVoiceStateDTO({
          userId,
          guildId: result.priorVoiceState.guildId,
          channelId: result.priorVoiceState.channelId,
        }),
      });
    }
    // If moving here ended a 1:1 DM call the user was in, broadcast its
    // system_call (missed / duration) record to that DM.
    if (result.priorCallSystemMessage && result.priorCallSystemChannelId !== null) {
      await dispatchSystemCallMessage(
        result.priorCallSystemChannelId,
        result.priorCallSystemMessage,
      );
    }

    // Then announce the new state to the NEW channel's audience.
    dispatch.voiceStateUpdate({
      guildId: result.voiceState.guildId,
      channelId: result.voiceState.channelId,
      voiceState: dto,
    });

    // Ring push for 1-on-1 DM voice joins. When you start a DM call,
    // the other recipient gets a phone-ring-style notification with
    // Accept/Decline action buttons — the closest a PWA can get to a
    // native phone call (true CallKit/ConnectionService integration
    // requires a native app). Scoped to:
    //
    //   1. 1-on-1 DMs only (channel.type === 'dm'). Group DMs would
    //      pre-ring everyone every time anyone joins, which gets
    //      noisy when 3+ people are in a call rotating in and out.
    //   2. Only when the OTHER recipient isn't already in voice in
    //      this same channel — they're the one being rung, and if
    //      they're already on the call we'd be re-pinging the
    //      person who just joined.
    //
    // Fire-and-forget — push delivery doesn't gate the join response.
    // Failures inside sendToUser are swallowed and logged there.
    //
    // Performance: two-phase. First a cheap channel-type check so
    // guild-voice joins (the common case) bail immediately without
    // doing any extra work. Then if it's a DM, fire the three
    // remaining lookups in parallel via Promise.all — they're
    // independent so serializing them was strictly slower.
    void (async () => {
      try {
        const channel = await getChannel(channelId);
        if (!channel || channel.type !== 'dm') return;

        const [otherUserId, states, callerRow] = await Promise.all([
          getOtherRecipient(channelId, userId),
          voice.listChannelVoiceStates(channelId),
          db
            .select({
              displayName: schema.users.displayName,
              username: schema.users.username,
            })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1),
        ]);

        if (otherUserId === null) return;

        // Reliable presence delivery to the OTHER recipient, ALWAYS — both
        // when the caller dials (rings the callee) AND when the callee
        // answers (so the CALLER learns the callee joined and its "Calling…"
        // overlay dismisses). The DM channel-audience fan-out has indexing
        // gaps for voice (see dispatch.voiceStateUpdateToUser's note), so the
        // caller previously stayed stuck on "Calling…" — connected to LiveKit
        // but never told, in-app, that the callee picked up. The client
        // upserts by user id, so receiving this alongside the channel
        // broadcast is harmless. Must run BEFORE the ring short-circuit below.
        dispatch.voiceStateUpdateToUser(otherUserId, dto);

        // Skip only the RING (push notifications) if the other party is
        // already in voice here — they're not being "rung", they're joining
        // a call we both happen to be in. The presence delivery above still
        // happened, so a caller already in voice still learns of the answer.
        if (states.some((s) => s.userId === otherUserId)) return;

        const caller = callerRow[0];
        const callerName =
          caller?.displayName ?? caller?.username ?? 'Someone';

        // PushKit VoIP ring: full native CallKit screen even when the
        // app is closed/force-quit. The APNs alert leg below is SKIPPED
        // only when a VoIP push was ACTUALLY DELIVERED (APNs 200) — not
        // merely because a voip row exists. Deciding on row-existence
        // meant a dead-but-registered token produced total silence: the
        // voip send failed AND the alert leg had already been skipped.
        // Awaiting the send is safe — this whole ring block is a
        // fire-and-forget IIFE, so the join response isn't delayed.
        // Web Push always sends (it's the web client's ring).
        let calleeHasVoip = false;
        try {
          const apns = await import('../services/apns');
          if (await apns.hasVoipTokens(otherUserId)) {
            const delivered = await apns
              .sendVoipToUser(otherUserId, {
                channelId: channelId.toString(),
                callerName,
              })
              .catch(() => 0);
            calleeHasVoip = delivered > 0;
          }
        } catch {
          // best-effort — fall through to the alert ring
        }

        await sendToUser(otherUserId, {
          title: callerName,
          body: '📞 Calling…',
          kind: 'call',
          // Tag keyed by channel id so a hangup-and-redial replaces
          // the existing ring instead of stacking a second one.
          tag: `call-${channelId.toString()}`,
          // Phone-ring vibration: three short bursts.
          vibrate: [300, 150, 300, 150, 300, 150, 300],
          // Don't auto-dismiss the ring. The user needs time to
          // pick up their phone, see the notification, and react.
          requireInteraction: true,
          // Inline Answer / Decline buttons. The action strings
          // are matched in the SW's notificationclick handler.
          actions: [
            { action: 'accept-call', title: 'Answer' },
            { action: 'decline-call', title: 'Decline' },
          ],
          // Data forwarded to the SW. Carrying channelId lets the
          // SW build the correct deeplink URL when the user taps.
          data: {
            channelId: channelId.toString(),
            callerName,
            // Lets the SW's Decline button end THIS call without a bearer
            // token (POST /call-decline). See auth/callDeclineToken.ts.
            ...(channel.dmActiveCallStartedAt
              ? {
                  declineToken: signCallDeclineToken({
                    userId: otherUserId,
                    channelId,
                    callerId: userId,
                    callStartedAtMs: channel.dmActiveCallStartedAt.getTime(),
                  }),
                }
              : {}),
          },
          // The deeplink the SW falls back to when the user taps
          // the notification body (not one of the action buttons).
          // The autojoin=1 param is read by the Shell on mount in
          // a DM channel and triggers an automatic joinVoice call.
          url: `/channels/@me/${channelId.toString()}?autojoin=1`,
          icon: '/icon-192.png',
        }, { skipApns: calleeHasVoip });
      } catch (err) {
        // Push is best-effort; never let a notification failure
        // affect the call itself.
        // eslint-disable-next-line no-console
        console.warn('Call-ring push failed:', err);
      }
    })();

    // Full channel voice state snapshot so the joining client can
    // sync its local participant view. Defends against a stale local
    // map: if the joiner missed earlier VOICE_STATE_UPDATE events
    // (zombie WebSocket, app suspend, etc.), READY hydration may not
    // have caught it either, and they'd see only themselves until
    // the next event. Returning the full set here lets the client
    // replace its channel view atomically on join. Same query the
    // ring-push code uses, so a cache layer (if added) would dedup.
    const channelStates = await voice.listChannelVoiceStates(channelId);
    const channelStateDtos = channelStates.map(toVoiceState);
    // Defensive: ensure the joiner's own row is in the list. The
    // upsert above committed before this read, so it SHOULD be in
    // there, but rebuilding our own row from `dto` (which is what
    // we just committed) avoids any read-after-write surprise.
    const haveSelf = channelStateDtos.some((s) => s.userId === dto.userId);
    if (!haveSelf) channelStateDtos.push(dto);

    // Echo the token+wsUrl alongside the state — the client uses the
    // token to negotiate WebRTC and the state to render presence. Token
    // is null until the SFU lands; document that explicitly so callers
    // see the field exists and is intentional.
    return c.json({
      voiceState: dto,
      channelVoiceStates: channelStateDtos,
      token: result.token,
      wsUrl: result.wsUrl,
    });
  },
);

// ── Update self-mute / self-deaf ────────────────────────────────────────────
//
// We accept partial flags so a client can change one independently. The
// server applies the deafen-implies-mute coupling in the service.

const stateSchema = z.object({
  selfMute: z.boolean().optional(),
  selfDeaf: z.boolean().optional(),
});

voiceRouter.post(
  '/:channelId/voice/state',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', stateSchema),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const body = c.req.valid('json');
    const updated = await voice.setMuteFlags(userId, body);
    if (!updated) return c.json({ ok: false, reason: 'not in voice' }, 409);
    // Validate the URL channelId matches the user's actual voice
    // state. Without this guard, a client could POST to a stale
    // channel id (or a channel they were never in) and the mute
    // toggle silently applies to whatever channel they're actually
    // in — confusing for debugging and obscures real client bugs.
    if (updated.channelId !== channelId) {
      return c.json({ ok: false, reason: 'not in this channel' }, 409);
    }
    const dto = toVoiceState(updated);
    dispatch.voiceStateUpdate({
      guildId: updated.guildId,
      channelId: updated.channelId,
      voiceState: dto,
    });
    return c.json({ voiceState: dto });
  },
);

// ── Leave ───────────────────────────────────────────────────────────────────

voiceRouter.delete(
  '/:channelId/voice',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    // Only the call in THIS channel. A user's voice row is per user, not per
    // device: unscoped, a leave from a device whose call already ended or moved
    // (a late hang-up, a stale reconcile, the previous channel of a switch)
    // deleted the row the user's OTHER device had just joined — ending that
    // call. A leave for a channel the user isn't in is a no-op.
    const result = await voice.leaveVoice(userId, {
      expectedChannelId: BigInt(c.req.valid('param').channelId),
    });
    if (result.priorState) {
      const leftDto = leftVoiceStateDTO({
        userId,
        guildId: result.priorState.guildId,
        channelId: result.priorState.channelId,
      });
      dispatch.voiceStateUpdate({
        guildId: result.priorState.guildId,
        channelId: result.priorState.channelId,
        voiceState: leftDto,
      });
      // 1:1 DM hang-up: also clear the ring directly on the other
      // recipient's connections, mirroring the user-targeted ring on
      // join. Without this, a caller who rings then hangs up before the
      // callee answers could leave the callee's incoming-call modal
      // stuck ringing if the channel fan-out didn't reach them.
      if (result.priorState.guildId === null) {
        const other = await getOtherRecipient(result.priorState.channelId, userId);
        if (other !== null) dispatch.voiceStateUpdateToUser(other, leftDto);
      }
    }
    if (result.systemCallMessage && result.systemCallChannelId !== null) {
      await dispatchSystemCallMessage(
        result.systemCallChannelId,
        result.systemCallMessage,
      );
    }
    return c.json({ ok: true });
  },
);

// ── Decline (1:1 DM only) ───────────────────────────────────────────────────
//
// Recipient ends an incoming 1:1 DM call by removing the caller from
// voice. Without this endpoint, the recipient's only options were to
// accept the call or locally dismiss the notification — the caller's
// ring-out state would persist on their end until they manually
// canceled, which is a confusing UX (they hear nothing back and
// don't know whether they're being ignored or whether the call is
// still pending).
//
// Server-side flow:
//   1. Look up channel; must be type='dm' (1:1).
//   2. The user must be a recipient of this DM (404 otherwise, so we
//      don't leak channel existence); then find the OTHER recipient
//      via getOtherRecipient.
//   3. Check the other recipient is currently in voice in THIS
//      channel. If they're not, the call has already ended (idempotent
//      no-op, return 200).
//   4. Call leaveVoice for the other user — this is the same
//      operation they'd do themselves to hang up, just initiated by
//      the recipient. Dispatch voiceStateUpdate so both clients see
//      the call end.
//
// The same flow backs POST /call-decline (routes/callDecline.ts), the
// token-authenticated variant a push notification's Decline button uses;
// that one passes `expectedCall` so the token only ever ends the call it
// was issued for.
voiceRouter.post(
  '/:channelId/voice/decline',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const result = await declineDmCall(userId, channelId);
    if (result === 'not_found') {
      return c.json({ error: 'channel_not_found' }, 404);
    }
    return c.json({ ok: true });
  },
);

/**
 * Decline (end) the 1:1 DM call ringing `userId` in `channelId` by removing
 * the other recipient from voice. 'not_found' when the channel isn't a 1:1
 * DM this user is in; 'ok' otherwise (including the idempotent "no call to
 * decline" case). With `expectedCall`, only acts when the caller and the
 * call's start time still match — a later call is left alone.
 */
export async function declineDmCall(
  userId: bigint,
  channelId: bigint,
  expectedCall?: { callerId: bigint; callStartedAtMs: number },
): Promise<'ok' | 'not_found'> {
  const channel = await getChannel(channelId);
  if (!channel || channel.type !== 'dm') {
    return 'not_found';
  }
  // getOtherRecipient only EXCLUDES the caller; it doesn't require them to
  // be in the DM, so membership is checked explicitly — otherwise any user
  // could hang up a stranger's ringing call.
  try {
    await dms.ensureRecipient(channelId, userId);
  } catch {
    return 'not_found';
  }
  const otherUserId = await getOtherRecipient(channelId, userId);
  if (otherUserId === null) {
    // No other recipient in DB (shouldn't happen for a valid 1:1 DM,
    // but defensive). Same 404 as channel-not-found so the response
    // doesn't leak which side failed the check.
    return 'not_found';
  }
  if (
    expectedCall &&
    (expectedCall.callerId !== otherUserId ||
      channel.dmActiveCallStartedAt?.getTime() !== expectedCall.callStartedAtMs ||
      channel.dmActiveCallAnsweredAt !== null)
  ) {
    // Not the call this decline was issued for (it ended, or a new one
    // started), or it was already answered (e.g. on another device) — a
    // stale ring notification must not hang up a live call.
    return 'ok';
  }
  // Verify the other user is currently in voice IN THIS CHANNEL.
  // If they're not, the "call" they were on already ended — return
  // success without acting so retries from a buggy client don't
  // start kicking them out of unrelated voice channels.
  const otherVoiceState = await db
    .select()
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.userId, otherUserId))
    .limit(1);
  const otherVoice = otherVoiceState[0];
  if (!otherVoice || otherVoice.channelId !== channelId) {
    return 'ok';
  }
  // Declining is a FORCED removal of the caller — evict them from the SFU
  // too, or a declined caller whose client doesn't process the leave event
  // (suspended socket) keeps streaming and ringing into a dead call.
  const result = await voice.leaveVoice(otherUserId, {
    evictFromSfu: true,
    // Only evict from the channel we verified above — not one they may have
    // raced into since.
    expectedChannelId: channelId,
  });
  if (result.priorState) {
    dispatch.voiceStateUpdate({
      guildId: result.priorState.guildId,
      channelId: result.priorState.channelId,
      voiceState: leftVoiceStateDTO({
        userId: otherUserId,
        guildId: result.priorState.guildId,
        channelId: result.priorState.channelId,
      }),
    });
  }
  if (result.systemCallMessage && result.systemCallChannelId !== null) {
    await dispatchSystemCallMessage(
      result.systemCallChannelId,
      result.systemCallMessage,
    );
  }
  return 'ok';
}

// ── Move a user between voice channels ─────────────────────────────────
//
// POST /voice/move
// Body: { userId, channelId }
//
// Moves the target user from their current voice channel to the given
// target voice channel in the same guild. Caller must have
// MOVE_MEMBERS on the SOURCE channel (the channel the target is in).
//
// Flow:
//   1. Service validates permissions + targets + updates DB + evicts
//      from old LiveKit room.
//   2. We dispatch VOICE_STATE_UPDATE so the target's client (and
//      everyone watching either channel) sees the move.
//   3. The target's client detects "my voice state's channelId
//      changed but I'm not connected to that room" and auto-reconnects
//      via the existing joinVoice flow.

const moveVoiceMemberBody = z.object({
  userId: snowflakeSchema,
  channelId: snowflakeSchema,
});

voiceRouter.post(
  '/move',
  validate('json', moveVoiceMemberBody),
  async (c) => {
    const callerId = requireUserId(c);
    const body = c.req.valid('json');
    const updated = await voice.moveVoiceMember({
      callerId,
      targetUserId: BigInt(body.userId),
      targetChannelId: BigInt(body.channelId),
    });
    dispatch.voiceStateUpdate({
      guildId: updated.guildId,
      channelId: updated.channelId,
      voiceState: { ...toVoiceState(updated), moved: true },
    });
    return c.json({ voiceState: toVoiceState(updated) });
  },
);
