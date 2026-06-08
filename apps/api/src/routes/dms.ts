/**
 * DMs router
 * ----------
 * Mounted at /api/v1/users/@me/channels. Two endpoints:
 *   POST /     create-or-fetch a DM with another user (idempotent)
 *   GET  /     list my DM channels
 *
 * Sending messages in a DM uses the regular /channels/:channelId/messages
 * route — it transparently handles DM channels via dm_recipients membership.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { snowflakeSchema } from '../lib/validation';
import { toChannel, leftVoiceStateDTO, toMessage } from '../lib/dto';
import * as dms from '../services/dms';
import * as channelsSvc from '../services/channels';
import * as supervision from '../services/supervision';
import * as voice from '../services/voice';
import * as dispatch from '../gateway/dispatch';
import { db, schema } from '../db';
import { errors } from '../errors';

export const dmsRouter = new Hono();
dmsRouter.use('*', requireAuth);

const createDMSchema = z.object({ recipientId: snowflakeSchema });

dmsRouter.post('/', validate('json', createDMSchema), async (c) => {
  const userId = requireUserId(c);
  const recipient = BigInt(c.req.valid('json').recipientId);
  const { channelId, created } = await dms.getOrCreateDM(userId, recipient);
  const channel = await channelsSvc.getChannel(channelId);
  if (!channel) throw errors.internal('DM channel disappeared');
  // Hydrate the recipient (just one for a 1:1 DM) so the client
  // can render the proper "DM with X" header without a follow-up
  // round-trip. Excludes self.
  const recipientUsers = await dms.loadOtherRecipients(channelId, userId);
  const suppressed =
    channel.type === 'dm' && recipientUsers[0]
      ? !(await supervision.isE2eeAllowedBetween(userId, recipientUsers[0].id))
      : false;
  const channelDTO = toChannel(channel, null, recipientUsers, suppressed);
  // Only dispatch on a *new* DM. Re-opening an existing one is a no-op
  // for the gateway: both recipients' connection snapshots already
  // include the channel from IDENTIFY-time loading.
  if (created) {
    dispatch.dmChannelCreated({
      channelDTO,
      channelId,
      recipientIds: [userId, recipient],
    });
  }
  return c.json({ channel: channelDTO }, 201);
});

dmsRouter.get('/', async (c) => {
  const userId = requireUserId(c);
  const list = await dms.listMyDMs(userId);
  // Bulk-load recipients in a single query (vs N+1). E2EE state is
  // now part of the channel row itself — no separate join needed.
  const channelIds = list.map((ch) => ch.id);
  const recipientsByChannel = await dms.loadRecipientsForChannels(channelIds, userId);
  // Build the supervision E2EE policy over self + every peer in one query.
  const involved: bigint[] = [userId];
  for (const recips of recipientsByChannel.values()) {
    for (const r of recips) involved.push(r.id);
  }
  const e2eeAllowed = await supervision.buildE2eePolicy(involved);
  // Live messaging streaks (1:1 only; 0/absent while broken). Decorative:
  // any failure (e.g. migration 0073 not applied yet) degrades to "no
  // streaks" instead of failing the whole DM list.
  let streaks = new Map<string, number>();
  try {
    const { streaksForChannels } = await import('../services/streaks');
    streaks = await streaksForChannels(channelIds);
  } catch {
    // table missing / transient DB error — DMs must still load.
  }
  return c.json({
    channels: list.map((ch) => {
      const recips = recipientsByChannel.get(ch.id.toString()) ?? [];
      const suppressed = ch.type === 'dm' && recips[0] ? !e2eeAllowed(userId, recips[0].id) : false;
      const dto = toChannel(ch, null, recips, suppressed) as unknown as Record<string, unknown>;
      const streak = streaks.get(ch.id.toString()) ?? 0;
      if (streak > 0) dto.streak = streak;
      return dto;
    }),
  });
});

/**
 * DELETE /users/@me/channels/:channelId — close a DM from the caller's
 * side. Doesn't affect the other recipient's view; their copy of the
 * conversation persists with all messages intact. If the caller
 * subsequently re-opens a DM with the same person, a fresh channel
 * is created (because getOrCreateDM looks for a channel where both
 * users are still recipients).
 *
 * For group DMs (deferred to v1.x), the same semantics apply per-user:
 * leaving a group DM removes you alone; the others keep their thread.
 */
dmsRouter.delete(
  '/:channelId',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    // Load the channel BEFORE closing so we can synthesize a delete
    // payload for the gateway. After closeDMForUser the dm_recipient
    // row is gone but the channel row itself persists for the other
    // party — so reading channel state here remains valid.
    const channel = await channelsSvc.getChannel(channelId);
    if (!channel) throw errors.notFound('DM channel');

    // If the caller is in a voice call inside THIS DM specifically,
    // evict them. Other voice calls (e.g. a guild voice channel)
    // are left alone — closing a DM shouldn't disturb unrelated
    // calls. Read first, evict only on match.
    const myVS = await voice.getMyVoiceState(userId);
    if (myVS && myVS.channelId === channelId) {
      const result = await voice.leaveVoice(userId);
      if (result.priorState) {
        dispatch.voiceStateUpdate({
          guildId: result.priorState.guildId,
          channelId: result.priorState.channelId,
          voiceState: leftVoiceStateDTO({
            userId,
            guildId: result.priorState.guildId,
            channelId: result.priorState.channelId,
          }),
        });
      }
      // If leaving voice also ended a 1:1 DM call, the system_call
      // message arrived via leaveVoice. The DM is about to be closed
      // for this user, but the message belongs to the channel and is
      // visible to whoever else is still in it. Dispatch via the
      // shared messageCreate path (the helper is on the voice route
      // file).
      if (result.systemCallMessage && result.systemCallChannelId !== null) {
        // Inline the dispatch — pulling in the helper from the voice
        // routes file would mean a cross-route import; the snippet
        // is short enough to duplicate here.
        const m = result.systemCallMessage;
        const author = m.authorId
          ? (await db
              .select()
              .from(schema.users)
              .where(eq(schema.users.id, m.authorId))
              .limit(1))[0] ?? null
          : null;
        dispatch.messageCreate({
          messageDTO: toMessage({ message: m, author }),
          channelId: result.systemCallChannelId,
          guildId: null,
        });
      }
    }

    await dms.closeDMForUser({ channelId, userId });
    // Tell the caller's connections so the DM disappears from their
    // sidebar live (across multiple tabs). The other recipient's
    // connections receive nothing — their channel still exists.
    const channelDTO = toChannel(channel, null, []);
    dispatch.dmChannelClosedForUser({ userId, channelId, channelDTO });
    return c.json({ ok: true });
  },
);

// ── DM auto-delete settings ───────────────────────────────────────────────
//
// Per-DM auto-delete TTL. Either recipient can read or change the
// setting; the change applies to both sides (it's a property of the
// conversation, not a per-user preference). When the TTL is set,
// messages get a `viewed_at` stamp the first time the OTHER recipient
// fetches them, and the periodic sweep deletes any whose viewed_at
// age exceeds the TTL.

/** GET — current TTL for this DM. null means auto-delete is off. */
dmsRouter.get(
  '/:channelId/settings',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const settings = await dms.getDmSettings(channelId);
    return c.json({ ttlSecondsAfterRead: settings.ttlSecondsAfterRead });
  },
);

/** PATCH — update the TTL. Pass null to disable auto-delete; otherwise
    a positive integer in [10, 86400] seconds. The service enforces the
    bounds and 400s on out-of-range values. */
const updateDmSettingsSchema = z.object({
  ttlSecondsAfterRead: z.number().int().min(10).max(86_400).nullable(),
});

dmsRouter.patch(
  '/:channelId/settings',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', updateDmSettingsSchema),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const { ttlSecondsAfterRead } = c.req.valid('json');
    await dms.updateDmSettings({ channelId, ttlSecondsAfterRead });
    // Notify the other party. We reuse the generic dmChannelClosedForUser
    // pathway intentionally NOT here — that's a leave event. Instead,
    // emit a lightweight DM_SETTINGS_UPDATE event keyed on the channel
    // so connected recipients refetch their settings panel.
    dispatch.dmSettingsUpdated({
      channelId,
      ttlSecondsAfterRead,
    });
    return c.json({ ttlSecondsAfterRead });
  },
);

// ── Per-DM E2EE keys ──────────────────────────────────────────────────────
//
// ── Per-DM E2EE (shared-key model) ────────────────────────────────────────
//
// Both users of a 1:1 DM share a single symmetric key, derived
// client-side from a passphrase one of them picks and tells the
// other out-of-band. Server stores ONLY:
//
//   salt:     16-byte base64. PBKDF2 input alongside the password.
//   verifier: SHA-256 of the derived key (base64). Lets the second
//             user check they typed the right password without the
//             server ever seeing the password or key.
//
// PUT enables (or rotates) the shared key. The user who first enables
// is responsible for sending the password to their counterpart through
// any out-of-band channel (text message, in person, etc).
//
// DELETE disables AND PURGES every encrypted message in the
// conversation — per the user's stated intent: "If disabled chat is
// purged." Re-enabling requires a fresh password (the old verifier
// is gone, so the old password can't be checked anymore even if
// someone still has it on disk).

/** SHA-256 of the derived key, base64-encoded → ~44 chars. Lets a
    client prove their typed password produces the same key without
    exposing the key itself. */
const verifierSchema = z
  .string()
  .min(40)
  .max(48)
  .regex(/^[A-Za-z0-9+/=]+$/);

const enableE2eeSchema = z.object({
  /** PBKDF2 salt, 16 random bytes base64-encoded → ~24 chars. */
  salt: z
    .string()
    .min(20)
    .max(28)
    .regex(/^[A-Za-z0-9+/=]+$/),
  verifier: verifierSchema,
});

/** Disabling E2EE purges all encrypted history, so we require proof the
    caller knows the conversation passphrase: they send the verifier they
    derive from their LOCAL key, and the service checks it against the stored
    one. Without this, any DM recipient could disable + purge without ever
    knowing the password. */
const disableE2eeSchema = z.object({
  verifier: verifierSchema,
});

/** PUT — enable E2EE on this DM. The caller has already derived the
    key locally from a passphrase they picked; they send us the salt
    (so the other party can rederive the same key from the same
    passphrase) and the verifier (so the other party can check they
    typed the right thing). */
dmsRouter.put(
  '/:channelId/e2ee-enable',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', enableE2eeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const { salt, verifier } = c.req.valid('json');
    await dms.enableE2ee(channelId, salt, verifier);
    // Push a fresh CHANNEL_UPDATE so the other recipient's client
    // sees E2EE was enabled and prompts them for the password.
    const channel = await channelsSvc.getChannel(channelId);
    if (channel) {
      const recipientUsers = await dms.loadOtherRecipients(channelId, userId);
      // A supervised pair can't actually go E2EE — report it suppressed.
      const suppressed =
        channel.type === 'dm' && recipientUsers[0]
          ? !(await supervision.isE2eeAllowedBetween(userId, recipientUsers[0].id))
          : false;
      const channelDTO = toChannel(channel, null, recipientUsers, suppressed);
      dispatch.dmChannelUpdated({ channelId, channelDTO });
    }
    return c.json({ ok: true });
  },
);

/** DELETE — disable E2EE on this DM AND purge all encrypted messages
    in the conversation. Either recipient can disable, but ONLY if they
    prove they know the passphrase: the body must carry a `verifier`
    matching the one stored at enable time. This stops a recipient who
    never knew the password from wiping the encrypted history. */
dmsRouter.delete(
  '/:channelId/e2ee-disable',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', disableE2eeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const { verifier } = c.req.valid('json');

    // Service verifies the submitted verifier against the stored one (proof
    // the caller knows the passphrase) and only then purges — all in one tx.
    const result = await dms.disableE2eeAndPurge(channelId, verifier);
    if (result.status === 'verifier_mismatch') {
      throw errors.forbidden(
        'Unlock this conversation (enter the password) before turning off encryption.',
      );
    }
    if (result.status === 'not_enabled') {
      // Already off — idempotent success, nothing to broadcast.
      return c.json({ ok: true, purgedCount: 0 });
    }
    // Disabled. Dispatch CHANNEL_UPDATE so both clients see e2eeEnabled=false
    // and clear their local cached key. Re-fetch the post-disable row.
    const updated = await channelsSvc.getChannel(channelId);
    if (updated) {
      const recipientUsers = await dms.loadOtherRecipients(channelId, userId);
      const channelDTO = toChannel(updated, null, recipientUsers);
      dispatch.dmChannelUpdated({ channelId, channelDTO });
    }
    // Fan out delete events for each purged message so both clients
    // remove them from their local state immediately. Without this,
    // the messages would stay on screen until a hard refresh.
    for (const msgId of result.purgedMessageIds) {
      dispatch.messageDelete({
        messageId: msgId,
        channelId,
        guildId: null,
      });
    }
    return c.json({ ok: true, purgedCount: result.purgedMessageIds.length });
  },
);
