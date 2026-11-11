/**
 * DMs router
 * ----------
 * Mounted at /api/v1/users/@me/channels. Two endpoints:
 *   POST /     create-or-fetch a DM with another user (idempotent)
 *   GET  /     list my DM channels
 * plus per-DM settings, the Zekk Pet (/:channelId/pet…) and E2EE below.
 *
 * Sending messages in a DM uses the regular /channels/:channelId/messages
 * route — it transparently handles DM channels via dm_recipients membership.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Channel } from '@zekktris/db';
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
import { errors, AppError } from '../errors';
import { assertNotInstanceMuted } from '../services/instanceMutes';
import { isBlockedEitherWay } from '../services/relationships';
import { RateLimiter } from '../lib/rateLimit';
import { DISAPPEARING_MAX_SECONDS, DISAPPEARING_MIN_SECONDS } from '../lib/disappearing';
import * as pets from '../services/pets';
import { normalizePetName } from '@zekktris/shared/pets';

export const dmsRouter = new Hono();
dmsRouter.use('*', requireAuth);

/**
 * Build a DM's channel DTO once per recipient, each from that recipient's own
 * point of view: `recipients` is everyone else in the DM. Every gateway
 * CHANNEL_CREATE / CHANNEL_UPDATE for a DM goes through this — one DTO built
 * for the caller and sent to the whole DM would hand the peer a DM whose
 * recipient is the peer themself.
 */
async function dmChannelDTOsByRecipient(channel: Channel) {
  const users = await dms.loadAllRecipientUsers(channel.id);
  // A supervised pair can't actually go E2EE — report it suppressed. The check
  // is symmetric in its two users, so one call covers both sides of a 1:1 DM.
  const suppressed =
    channel.type === 'dm' && users.length === 2
      ? !(await supervision.isE2eeAllowedBetween(users[0]!.id, users[1]!.id))
      : false;
  return users.map((u) => ({
    userId: u.id,
    channelDTO: toChannel(
      channel,
      null,
      users.filter((o) => o.id !== u.id),
      suppressed,
    ),
  }));
}

const createDMSchema = z.object({ recipientId: snowflakeSchema });

dmsRouter.post('/', validate('json', createDMSchema), async (c) => {
  const userId = requireUserId(c);
  const recipient = BigInt(c.req.valid('json').recipientId);
  const { channelId, created } = await dms.getOrCreateDM(userId, recipient);
  const channel = await channelsSvc.getChannel(channelId);
  if (!channel) throw errors.internal('DM channel disappeared');
  // Hydrate the recipient (just one for a 1:1 DM) so the client
  // can render the proper "DM with X" header without a follow-up
  // round-trip. Each recipient's DTO excludes that recipient.
  const dtos = await dmChannelDTOsByRecipient(channel);
  const mine = dtos.find((d) => d.userId === userId);
  if (!mine) throw errors.internal('DM channel disappeared');
  // Only dispatch on a *new* DM. Re-opening an existing one is a no-op
  // for the gateway: both recipients' connection snapshots already
  // include the channel from IDENTIFY-time loading.
  if (created) {
    dispatch.dmChannelCreated({ channelId, dtos });
  }
  return c.json({ channel: mine.channelDTO }, 201);
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
        // The initiator's held read marker, as dispatchSystemCallMessage
        // (routes/voice.ts) sends it.
        if (m.authorId !== null) {
          await dms.notifyHeldReadMarkerIfWaiting({
            userId: m.authorId,
            channelId: result.systemCallChannelId,
            belowId: m.id,
          });
        }
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

// ── DM disappearing-messages settings ─────────────────────────────────────
//
// Per-DM disappearing-messages timer (Signal-style; services/dms.ts has the
// model). Either recipient can read or change it; the change applies to both
// sides (it's a property of the conversation, not a per-user preference) but
// only to messages sent afterwards. The wire key stays `ttlSecondsAfterRead`
// for installed apps.

// A change posts a notice into the DM, so changing it is a way to put
// messages in front of the other party: throttle it per user. Generous for
// someone trying out values, useless for flooding. Fail-open on Redis.
const disappearingChangeLimiter = new RateLimiter(10, 60_000, 'dm-disappearing');

/** GET — current timer for this DM. null means disappearing messages are
    off. `maxTtlSeconds` marks a server with per-message timers (clients
    offer 1 s .. 4 weeks only when it's present). */
dmsRouter.get(
  '/:channelId/settings',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const settings = await dms.getDmSettings(channelId);
    // notificationShowContent is the CALLER's private preview choice (null =
    // not set → client applies the E2EE-aware default). It is not shared with
    // the other recipient, unlike the conversation-scoped TTL.
    const notificationShowContent = await dms.getDmNotificationPref(userId, channelId);
    return c.json({
      ttlSecondsAfterRead: settings.ttlSecondsAfterRead,
      notificationShowContent,
      maxTtlSeconds: DISAPPEARING_MAX_SECONDS,
    });
  },
);

/** PATCH — set THIS recipient's notification-preview choice for the DM.
    Private per-user (not broadcast to the other party). `showContent`:
    true = show sender/content, false = generic, null = revert to default. */
dmsRouter.patch(
  '/:channelId/notification-preview',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', z.object({ showContent: z.boolean().nullable() })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const { showContent } = c.req.valid('json');
    await dms.setDmNotificationPref(userId, channelId, showContent);
    return c.json({ notificationShowContent: showContent });
  },
);

/** PATCH — set the timer NEW messages get. Pass null to turn disappearing
    messages off; otherwise whole seconds in [1, 2419200] (4 weeks). The old
    [10, 86400] range is a subset, so installed apps keep working. Repeating
    the current value is a no-op (no write, no notice, no event). A change
    posts a 'system_disappearing' notice and fires DM_SETTINGS_UPDATE. */
const updateDmSettingsSchema = z.object({
  ttlSecondsAfterRead: z
    .number()
    .int()
    .min(DISAPPEARING_MIN_SECONDS)
    .max(DISAPPEARING_MAX_SECONDS)
    .nullable(),
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

    // Unchanged → nothing at all. Every installed client re-PATCHes the
    // current value when its row is tapped; that must not post a notice.
    const current = await dms.getDmSettings(channelId);
    if (current.ttlSecondsAfterRead === ttlSecondsAfterRead) {
      return c.json({ ttlSecondsAfterRead });
    }

    // A change posts a message into the DM, so it faces the send route's
    // gates (routes/messages.ts POST /:channelId/messages), in its order and
    // error style: instance mute, then — for a 1:1 DM — a block either way
    // (notFound, so the block direction doesn't leak) and the supervision DM
    // policy. Then the per-user throttle.
    await assertNotInstanceMuted(userId);
    const channel = await channelsSvc.getChannel(channelId);
    if (!channel) throw errors.notFound('Channel');
    if (channel.type === 'dm') {
      const other = await dms.getOtherRecipient(channelId, userId);
      if (other !== null) {
        if (await isBlockedEitherWay(userId, other)) {
          throw errors.notFound('Channel');
        }
        if (await supervision.dmBlockedBySupervision(userId, other)) {
          throw new AppError(
            'FORBIDDEN',
            'Direct messages are restricted — connect a guardian to continue',
            { supervisionRestricted: 'dm' },
          );
        }
      }
    }
    const rl = await disappearingChangeLimiter.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));

    const result = await dms.updateDmSettings({ channelId, ttlSecondsAfterRead, changedBy: userId });
    // A concurrent identical change got there first: it posts the notice.
    if (!result.changed) return c.json({ ttlSecondsAfterRead });

    // The notice, the way system rows reach the DM (cf. dispatchSystemCallMessage
    // in routes/voice.ts). Re-subscribe every recipient's live connections
    // first, as the send route does, so a drifted connection still gets it.
    // createSystemMessage sends no push, and the notice never has a timer.
    try {
      dispatch.dmSubscribeRecipients({
        channelId,
        recipientIds: await dms.listAllRecipients(channelId),
      });
    } catch {
      // Best-effort: the REST refetch still covers a stale connection.
    }
    const [author] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    dispatch.messageCreate({
      messageDTO: toMessage({ message: result.notice, author: author ?? null }),
      channelId,
      guildId: null,
    });
    // The notice moved the changer's read marker to itself (so it isn't
    // unread for them): start the clocks of what that covers, as a read ack
    // would — clients won't ack a marker that's already current.
    await dms.startDisappearingTimersAndNotify({
      channelId,
      channelType: channel.type,
      readerId: userId,
      upToMessageId: result.notice.id,
    });
    // Every recipient's settings UI / header indicator.
    dispatch.dmSettingsUpdated({
      channelId,
      ttlSecondsAfterRead,
    });
    return c.json({ ttlSecondsAfterRead });
  },
);

// ── Zekk Pet ──────────────────────────────────────────────────────────────
//
// The shared pet of a 1:1 DM (services/pets.ts has the rules). Either
// recipient reads it; the writes that post a notice (invite, accept, rename)
// face the same gates as the disappearing-timer PATCH above. Group DMs have
// no pet.

// Each invite and rename posts a notice into the DM: throttle them per user,
// like the timer change. Fail-open on Redis.
const petInviteLimiter = new RateLimiter(10, 60 * 60_000, 'dm-pet-invite');
const petRenameLimiter = new RateLimiter(10, 60 * 60_000, 'dm-pet-rename');

/** The caller's 1:1 DM: 404 for a non-recipient, 400 for a group DM. */
async function petDm(channelId: bigint, userId: bigint): Promise<Channel> {
  await dms.ensureRecipient(channelId, userId);
  const channel = await channelsSvc.getChannel(channelId);
  if (!channel) throw errors.notFound('Channel');
  if (channel.type !== 'dm') {
    throw errors.badRequest('Zekk Pets are only available in 1:1 direct messages');
  }
  return channel;
}

/** The send route's gates for a write that posts a notice, in its order and
 *  error style (as the timer PATCH applies them): instance mute, then a block
 *  either way (notFound, so the direction doesn't leak) and the supervision
 *  DM policy. Returns the other recipient (null if they closed the DM). */
async function assertPetWriteAllowed(channelId: bigint, userId: bigint): Promise<bigint | null> {
  await assertNotInstanceMuted(userId);
  const other = await dms.getOtherRecipient(channelId, userId);
  if (other !== null) {
    if (await isBlockedEitherWay(userId, other)) throw errors.notFound('Channel');
    if (await supervision.dmBlockedBySupervision(userId, other)) {
      throw new AppError(
        'FORBIDDEN',
        'Direct messages are restricted — connect a guardian to continue',
        { supervisionRestricted: 'dm' },
      );
    }
  }
  return other;
}

/** GET — `{ pet, eligible, streak, minStreak }`. */
dmsRouter.get(
  '/:channelId/pet',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await petDm(channelId, userId);
    return c.json(await pets.getPetState(channelId));
  },
);

/** POST /invite — ask the other person to adopt a pet together. 409 when the
    streak isn't alive and 3+ days, or a pet / invite already exists. */
dmsRouter.post(
  '/:channelId/pet/invite',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await petDm(channelId, userId);
    const other = await assertPetWriteAllowed(channelId, userId);
    if (other === null) throw errors.conflict('The other person has left this conversation');
    const rl = await petInviteLimiter.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const pet = await pets.invitePet({ channelId, inviterId: userId, otherId: other });
    return c.json({ pet });
  },
);

/** POST /accept — the invitee accepts; the egg appears. */
dmsRouter.post(
  '/:channelId/pet/accept',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await petDm(channelId, userId);
    await assertPetWriteAllowed(channelId, userId);
    const pet = await pets.acceptPet({ channelId, userId });
    return c.json({ pet });
  },
);

/** POST /decline — the invitee declines, or the inviter cancels. Posts
    nothing, so no send gates: either side can always withdraw. */
dmsRouter.post(
  '/:channelId/pet/decline',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await petDm(channelId, userId);
    await pets.declinePet({ channelId, userId });
    return c.json({ pet: null });
  },
);

/** PATCH — rename: `{ name }`, 1–24 characters once trimmed and collapsed.
    The current name again is a no-op (no notice, no event, not counted). */
dmsRouter.patch(
  '/:channelId/pet',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', z.object({ name: z.string().max(200) })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await petDm(channelId, userId);
    const name = normalizePetName(c.req.valid('json').name);
    if (name === null) {
      throw errors.badRequest('Pet names are 1 to 24 characters, with no control characters');
    }
    const current = await pets.getPet(channelId);
    if (!current || current.status === 'invited') {
      throw errors.conflict('There is no Zekk Pet to rename');
    }
    if (current.name === name) return c.json({ pet: current });
    await assertPetWriteAllowed(channelId, userId);
    const rl = await petRenameLimiter.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const { pet } = await pets.renamePet({ channelId, userId, name });
    return c.json({ pet });
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
  /** base64 SHA-256(key || "zkE2EE/purge-v1"), same shape as the verifier.
      Stored only as a hash and never returned, so it proves a later purge
      comes from a key holder. Optional: old clients don't send it. */
  purgeProof: verifierSchema.optional(),
});

/** Disabling E2EE purges all encrypted history, so we require proof the
    caller holds the conversation key. The verifier alone proves nothing (it
    is public: every participant receives it in the channel DTO), so the
    caller also sends the purgeProof derived from their LOCAL key, which the
    service checks against the hash stored at enable time. Without it, any
    DM recipient could echo the verifier back and wipe the history. */
const disableE2eeSchema = z.object({
  verifier: verifierSchema,
  purgeProof: verifierSchema.optional(),
});

/** Register the purge proof on a DM that has none yet (see
    dms.registerE2eePurgeProof). */
const registerPurgeProofSchema = z.object({
  verifier: verifierSchema,
  purgeProof: verifierSchema,
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
    const { salt, verifier, purgeProof } = c.req.valid('json');
    // SERVER-SIDE supervision enforcement — a supervised minor's 1:1 DMs must
    // stay plaintext so the guardian can review them. The "suppressed" flag on
    // the channel DTO is only a client advisory; a modified/older client (or a
    // direct API call) could otherwise persist real salt/verifier and start
    // sending ciphertext the server can't scan or the parent can't read. Reject
    // the enable outright for a supervised pair so it never persists.
    const channelForCheck = await channelsSvc.getChannel(channelId);
    if (channelForCheck?.type === 'dm') {
      const others = await dms.loadOtherRecipients(channelId, userId);
      if (others[0] && !(await supervision.isE2eeAllowedBetween(userId, others[0].id))) {
        throw errors.forbidden(
          'End-to-end encryption is unavailable for this conversation while it is supervised.',
        );
      }
    }
    // First-writer-wins: a racing second enable can't clobber the first
    // party's salt/verifier (which would break their handshake).
    const result = await dms.enableE2ee(channelId, salt, verifier, purgeProof);
    if (result.status === 'already_enabled') {
      throw errors.conflict(
        'This conversation is already encrypted (the other participant just turned it on). Enter their password to unlock it instead.',
      );
    }
    // Only broadcast when WE actually flipped it on. An idempotent retry
    // ('unchanged') means the other recipient already got the update.
    if (result.status === 'enabled') {
      // Push a fresh CHANNEL_UPDATE so the other recipient's client
      // sees E2EE was enabled and prompts them for the password.
      const channel = await channelsSvc.getChannel(channelId);
      if (channel) {
        dispatch.dmChannelUpdated({ channelId, dtos: await dmChannelDTOsByRecipient(channel) });
      }
    }
    return c.json({ ok: true });
  },
);

/** PUT — register the purge proof on an encrypted DM that has none (enabled
    before the proof existed, or by an old client). First registration wins;
    a different proof is refused with 409. Clients call this once they hold
    the key, when the DTO reports `e2eePurgeProofSet: false`. */
dmsRouter.put(
  '/:channelId/e2ee-purge-proof',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', registerPurgeProofSchema),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const { verifier, purgeProof } = c.req.valid('json');
    const result = await dms.registerE2eePurgeProof(channelId, verifier, purgeProof);
    if (result.status === 'not_enabled') {
      throw errors.conflict('This conversation is not encrypted.');
    }
    if (result.status === 'verifier_mismatch') {
      throw errors.forbidden(
        'Unlock this conversation (enter the password) before registering its key.',
      );
    }
    if (result.status === 'already_registered') {
      throw errors.conflict('A different key is already registered for this conversation.');
    }
    if (result.status === 'registered') {
      // Flip e2eePurgeProofSet on both clients so neither re-registers.
      // (Same suppression as enable, via the helper: a supervised pair must
      // keep seeing the DM as plaintext.)
      const channel = await channelsSvc.getChannel(channelId);
      if (channel) {
        dispatch.dmChannelUpdated({ channelId, dtos: await dmChannelDTOsByRecipient(channel) });
      }
    }
    return c.json({ ok: true });
  },
);

/** DELETE — disable E2EE on this DM AND purge all encrypted messages
    in the conversation. Either recipient can disable, but ONLY if they
    prove they hold the key: the body carries the `verifier` and, for any
    DM with a registered proof, the `purgeProof` whose hash was stored at
    enable time. The verifier is public, so the proof is what stops a
    recipient who never knew the password from wiping the history. */
dmsRouter.delete(
  '/:channelId/e2ee-disable',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', disableE2eeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    await dms.ensureRecipient(channelId, userId);
    const { verifier, purgeProof } = c.req.valid('json');

    // Service verifies the submitted verifier + purge proof against the
    // stored ones (proof the caller holds the key) and only then purges —
    // all in one tx.
    const result = await dms.disableE2eeAndPurge(channelId, verifier, purgeProof);
    if (result.status === 'verifier_mismatch') {
      throw errors.forbidden(
        'Unlock this conversation (enter the password) before turning off encryption.',
      );
    }
    if (result.status === 'purge_proof_mismatch') {
      throw errors.forbidden(
        purgeProof
          ? "This device's key couldn't be confirmed for this conversation, so nothing was deleted."
          : 'Update Zekktris to turn off encryption in this conversation.',
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
      dispatch.dmChannelUpdated({ channelId, dtos: await dmChannelDTOsByRecipient(updated) });
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
