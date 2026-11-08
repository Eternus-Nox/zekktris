/**
 * Messages router
 * ---------------
 * Mounted at /api/v1/channels alongside the channels router. The endpoints
 * here are message-scoped operations (send, list, edit, delete, react).
 *
 * Multipart upload: POST /channels/:id/messages accepts either:
 *   - application/json with { content, replyToId? }
 *   - multipart/form-data with field `payload_json` (the same JSON body) and
 *     N file fields named `files[0]`, `files[1]`, ... (or all keyed `files`).
 *
 * The two paths share the same business logic; only the request parsing
 * differs at the start.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { errors, AppError } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { parseFormBody } from '../middleware/multipartCompat';
import {
  snowflakeSchema,
  messageContentSchema,
  messagePageLimitSchema,
  emojiSchema,
} from '../lib/validation';
import { toMessage, toPublicUser, toReadState, toChannel, toPoll, toForwardSource, toSticker, toAttachment, type PollDTO, type ForwardSourceDTO, type StickerDTO } from '../lib/dto';
import * as messages from '../services/messages';
import * as polls from '../services/polls';
import * as embeds from '../services/embeds';
import * as supervision from '../services/supervision';
import { assertNotInstanceMuted } from '../services/instanceMutes';
import {
  E2EE_CIPHERTEXT_RE,
  assertChannelAcceptsMessages,
  enforceGuildContentModeration,
  enforceGuildParticipationGates,
  enforceGuildSendGates,
} from '../services/messageGates';
import * as stickers from '../services/stickers';
import * as reactions from '../services/reactions';
import * as reactionRolesSvc from '../services/reactionRoles';
import * as membersSvc from '../services/members';
import * as channelsSvc from '../services/channels';
import * as dms from '../services/dms';
import * as uploads from '../services/uploads';
import * as readStates from '../services/readStates';
import * as threads from '../services/threads';
import * as dispatch from '../gateway/dispatch';
import { registry } from '../gateway/registry';
import { writeAudit } from '../services/audit';
import { log } from '../log';
import {
  Permissions,
  computeMemberChannelPermissions,
  hasPermission,
  listChannelViewerIds,
  assertChannelPermission,
} from '../services/permissions';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { env } from '../env';
import type { User } from '@zekktris/db';
import { POKE_VARIANTS } from '@zekktris/db';
import { RateLimiter } from '../lib/rateLimit';
import { sendToUser, sendToUsers, type PushPayload } from '../services/push';
import { MESSAGE_CONTENT_MAX_LENGTH } from '@zekktris/shared/constants';

// Per-poker throttle for the nudge/poke endpoint — pokes are lightweight, so
// a generous 10/min keeps it playful without enabling buzz-spam.
const pokeLimiter = new RateLimiter(10, 60_000, 'poke-user');
// Per-(poker → target) throttle: at most one poke to a GIVEN person every 10s,
// so a poke can nudge but never spam. Composite key makes it independent per
// direction and per target, unlike the coarse global limiter above (which caps
// a poker's total poke rate regardless of who they're poking).
const pokeTargetLimiter = new RateLimiter(1, 10_000, 'poke-target');
// Per-(author → message) throttle for reaction notifications: at most one push
// to the author about a GIVEN message every 15s, so a burst of reactions on one
// message pings them once, not once per reactor.
const reactionNotifyLimiter = new RateLimiter(1, 15_000, 'reaction-notify');
// DM send throttle. Guild sends go through security.checkSpam; DMs had NO
// server-side rate limit, so a scripted client could flood a 1:1/group DM.
// Per author+channel, generous enough for real chat (~2/s); fail-open on Redis.
const dmSendLimiter = new RateLimiter(20, 10_000, 'dm-send');

export const messagesRouter = new Hono();
messagesRouter.use('*', requireAuth);

// How long after posting an author may still edit or delete their own message.
// A moderator with MANAGE_MESSAGES can delete past this window; edits stay
// author-only either way.
const MESSAGE_MUTATE_WINDOW_MS = 60_000;

// ── Internal helper: load an authorized channel context ────────────────────
//
// Returns the channel + the caller's effective channel permissions (or the
// DM-recipient flag). Throws NOT_FOUND if the channel is missing or the
// caller can't see it.

interface ChannelContext {
  channel: schema.Channel;
  /** null for DMs (no permission system there). */
  channelPerms: bigint | null;
  isDM: boolean;
}

async function loadChannelContext(channelId: bigint, userId: bigint): Promise<ChannelContext> {
  const channel = await channelsSvc.getChannel(channelId);
  if (!channel) throw errors.notFound('Channel');

  if (channel.guildId) {
    // Pass the already-fetched channel row so the resolver skips a redundant
    // SELECT of the same row on this hot guild-message path.
    const perms = await computeMemberChannelPermissions(channelId, userId, channel);
    if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) throw errors.notFound('Channel');
    return { channel, channelPerms: perms, isDM: false };
  }

  // DM / group_dm — verify recipient.
  if (channel.type === 'dm' || channel.type === 'group_dm') {
    await dms.ensureRecipient(channelId, userId);
    return { channel, channelPerms: null, isDM: true };
  }

  throw errors.notFound('Channel');
}

/**
 * Whether the server should unfurl link previews for the caller's message in
 * this channel: EMBED_LINKS in a guild channel; always in DMs (no permission
 * system there). Webhooks don't come through here — they post channel-owned
 * rich embeds, which Discord likewise never gates on EMBED_LINKS.
 */
function canEmbedLinks(ctx: ChannelContext): boolean {
  return ctx.channelPerms === null || hasPermission(ctx.channelPerms, Permissions.EMBED_LINKS);
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /:channelId/messages
// ═══════════════════════════════════════════════════════════════════════════

const pollInputSchema = z.object({
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(80)).min(2).max(10),
  multipleChoice: z.boolean().optional(),
  /** Hours until close. Server clamps to [1, 168]. */
  durationHours: z.number().min(1).max(168),
});

const voiceMessageInputSchema = z.object({
  /** Audio length in whole seconds. Server clamps to a sane range. */
  durationSeconds: z.number().int().min(1).max(300),
  /** Base64-encoded waveform bytes (typically 32-64 samples). */
  waveform: z.string().min(1).max(2048),
});

const sendMessageSchema = z.object({
  content: messageContentSchema.optional().default(''),
  replyToId: snowflakeSchema.nullable().optional(),
  /** Optional poll attachment. When present, the message can have
      empty content (the poll IS the message). */
  poll: pollInputSchema.optional(),
  /** When set, this message is a forward of the referenced source.
      The route validates the caller can VIEW + READ_HISTORY on the
      source's channel before letting the forward through. */
  forwardFromMessageId: snowflakeSchema.optional(),
  /** When set, this message attaches the referenced sticker. The
      sticker must belong to the destination channel's guild. Empty
      content is fine — the sticker is the body. */
  stickerId: snowflakeSchema.optional(),
  /** When set, the FIRST attached audio file is treated as a voice
      message: rendered with a custom playback control. Requires
      exactly one audio file in the attachments and no text content
      (the audio is the body). */
  voiceMessage: voiceMessageInputSchema.optional(),
  /** Client-generated echo token. Echoed back ONLY in the MESSAGE_CREATE
      gateway event (not persisted) so the sender can match the gateway
      echo to its optimistic placeholder and replace it in place —
      eliminating the brief duplicate "ghost" bubble when the echo beats
      the REST 201 response. */
  nonce: z.string().max(64).optional(),
  /** Per-attachment client metadata, POSITIONAL to the uploaded files (entry
      k describes files[k]; may be null for files with no meta). Used so E2EE
      (.zke) images — which the server can't measure, since it only sees
      ciphertext — can still store width/height and have the recipient reserve
      the exact slot before decrypt (no reflow). Dims aren't sensitive (same as
      the already-plaintext voice durationSeconds/waveform). Server-measured
      dims (non-E2EE, via sharp) take precedence. (`hasThumbnail` is reserved
      for the upcoming encrypted-thumbnail upload.) */
  attachments: z
    .array(
      z
        .object({
          width: z.number().int().min(1).max(100000).optional(),
          height: z.number().int().min(1).max(100000).optional(),
          hasThumbnail: z.boolean().optional(),
        })
        .nullable(),
    )
    .max(50)
    .optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /:channelId/poke — nudge the other party in a 1:1 DM
// ═══════════════════════════════════════════════════════════════════════════
//
// A poke is a lightweight nudge — a way to notify someone. It creates NO
// message and does NOT bump lastMessageId (it must not clutter the DM), riding
// a dedicated POKE gateway event + a big-emoji push. Connected clients surface
// it transiently (phone/web toast, watch big-emoji flash + haptic); a closed
// app is reached by the push (body = the emoji, no text). A small bounded
// history (newest 6 per recipient) IS kept so the poke button can show recent
// pokes and offer a poke-back — read via GET /:channelId/pokes below.
// DM-1:1 only; throttled to one poke per target per 10s.
const pokeSchema = z.object({
  pokeType: z.enum(['poke', 'heart', 'wave', 'like', 'fire']),
});

messagesRouter.post(
  '/:channelId/poke',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', pokeSchema),
  async (c) => {
    const userId = requireUserId(c);
    // Instance mute (staff action): no poke while muted. See services/instanceMutes.
    await assertNotInstanceMuted(userId);
    const channelId = BigInt(c.req.valid('param').channelId);
    const { pokeType } = c.req.valid('json');

    // loadChannelContext throws NOT_FOUND for channels the caller can't see
    // (incl. non-recipient DMs). Restrict to 1:1 DMs — poking a group/guild
    // channel isn't a thing.
    const ctx = await loadChannelContext(channelId, userId);
    if (!ctx.isDM || ctx.channel.type !== 'dm') {
      throw errors.badRequest('Pokes are only available in direct messages');
    }

    const rl = await pokeLimiter.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));

    const recipients = await dms.listAllRecipients(channelId);
    const others = recipients.filter((r) => r !== userId);
    if (others.length === 0) throw errors.badRequest("You can't poke yourself");

    // Per-target 10s throttle: at most one poke to a GIVEN person every 10s so
    // it stays a nudge, never spam. A throttled poke neither notifies nor
    // records. (A 1:1 DM has exactly one other party; the loop generalizes.)
    for (const target of others) {
      const trl = await pokeTargetLimiter.consume(`${userId}:${target}`);
      if (!trl.ok) throw errors.rateLimited(Math.ceil(trl.retryAfterMs / 1000));
    }

    const variant = POKE_VARIANTS[pokeType];
    const [poker] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const pokerName = poker?.displayName ?? poker?.username ?? 'Someone';

    // A poke rides a live gateway event + a push (below); the sender is skipped
    // client-side via initiator_id. It creates NO message and does NOT bump
    // lastMessageId (it must not clutter the DM), but we DO keep a small bounded
    // history (newest 6 per recipient) so the poke button can show recent pokes
    // and offer a poke-back.
    dispatch.poke({
      channelId,
      pokeType,
      emoji: variant.emoji,
      initiatorId: userId,
      initiatorName: pokerName,
    });

    // Persist the poke: the bounded display buffer (insert + prune to the
    // newest 6 for this channel+recipient) AND the durable pair tally, in ONE
    // transaction. They must agree — the buffer is pruned and can never be
    // re-derived, so a crash between the two would silently lose a poke from
    // the lifetime count (or, worse, count one that was never shown).
    //
    // Still best-effort AS A WHOLE: a DB hiccup must never block the live
    // nudge, which has already fired above. Order/prune by the snowflake id
    // (monotonic) to avoid the timestamptz µs/ms comparison foot-gun.
    try {
      await db.transaction(async (tx) => {
        for (const target of others) {
          await tx.insert(schema.pokes).values({
            id: nextSnowflake(),
            channelId,
            initiatorId: userId,
            recipientId: target,
            pokeType,
          });
          await tx.execute(sql`
            DELETE FROM pokes
             WHERE channel_id = ${channelId} AND recipient_id = ${target}
               AND id NOT IN (
                 SELECT id FROM pokes
                  WHERE channel_id = ${channelId} AND recipient_id = ${target}
                  ORDER BY id DESC LIMIT 6
               )
          `);
          // Durable tally. The buffer above is keyed by channel+RECIPIENT and
          // pruned to 6, so it can never answer "how many people have I poked"
          // — that lives here, keyed by the ordered pair, never pruned. Repeat
          // pokes to the same person only bump poke_count, so the row count
          // tracks DISTINCT people (the metric an alt-farm can't inflate)
          // rather than poke volume.
          await tx
            .insert(schema.pokeTallies)
            .values({ initiatorId: userId, recipientId: target, pokeCount: 1 })
            .onConflictDoUpdate({
              target: [schema.pokeTallies.initiatorId, schema.pokeTallies.recipientId],
              set: {
                pokeCount: sql`${schema.pokeTallies.pokeCount} + 1`,
                lastAt: new Date(),
              },
            });
        }
      });
    } catch {
      // History + tally are best-effort — the live poke already fired.
    }

    // Push the OTHER party (best-effort, mute-aware). The live POKE event
    // already reaches a connected client; this covers a closed app. A muted DM
    // ('nothing') is skipped, same as a normal message.
    try {
      const { resolveLevelsBulk } = await import('../services/notifications');
      const levels = await resolveLevelsBulk(others, channelId, null);
      await Promise.all(
        others.map(async (target) => {
          if (levels.get(target.toString()) === 'nothing') return;
          await sendToUser(target, {
            // The nudge IS the emoji. On iOS, mutable-content lets the
            // Notification Service Extension render the emoji as a big centered
            // image and drop the text (pokeEmoji rides in data); the watch shows
            // that same enriched notification. Web/fallback shows the emoji as
            // the body. The sender's name is the title; tag replaces a prior poke
            // from the same DM rather than stacking.
            title: pokerName,
            body: variant.emoji,
            url: `/channels/@me/${channelId.toString()}`,
            tag: `poke-${channelId.toString()}`,
            mutableContent: true,
            data: { pokeEmoji: variant.emoji },
          }).catch(() => undefined);
        }),
      );
    } catch {
      // Push is best-effort — the gateway delivery already happened.
    }

    return c.json({ ok: true }, 200);
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /:channelId/pokes — recent pokes RECEIVED by the caller on this DM
// ═══════════════════════════════════════════════════════════════════════════
//
// Feeds the poke button's history popover: up to 6 pokes this user received on
// this 1:1 DM, newest first, each with the poker's display name. DM-1:1 only.
//
// This request IS the "poke button was opened" signal (clients fetch it on
// popover open), so it doubles as the unread ACK: `unread` reports the badge
// count as it was BEFORE this call, and the caller's unseen rows are flipped
// to seen. The flag lives on `pokes` rather than read_states because ack()
// advances that cursor with GREATEST — it never moves backwards, so a later
// poke could never re-arm the badge.
messagesRouter.get(
  '/:channelId/pokes',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);

    const ctx = await loadChannelContext(channelId, userId);
    if (!ctx.isDM || ctx.channel.type !== 'dm') {
      throw errors.badRequest('Pokes are only available in direct messages');
    }

    const rows = await db
      .select({
        id: schema.pokes.id,
        pokeType: schema.pokes.pokeType,
        initiatorId: schema.pokes.initiatorId,
        recipientId: schema.pokes.recipientId,
        createdAt: schema.pokes.createdAt,
        seen: schema.pokes.seen,
        displayName: schema.users.displayName,
        username: schema.users.username,
      })
      .from(schema.pokes)
      .innerJoin(schema.users, eq(schema.users.id, schema.pokes.initiatorId))
      .where(and(eq(schema.pokes.channelId, channelId), eq(schema.pokes.recipientId, userId)))
      .orderBy(desc(schema.pokes.id))
      .limit(6);

    const unread = rows.reduce((n, r) => (r.seen ? n : n + 1), 0);
    if (unread > 0) {
      // Clearing the badge is best-effort — the history itself already
      // rendered, and the next open re-acks whatever is still unseen.
      await db
        .update(schema.pokes)
        .set({ seen: true })
        .where(
          and(
            eq(schema.pokes.channelId, channelId),
            eq(schema.pokes.recipientId, userId),
            eq(schema.pokes.seen, false),
          ),
        )
        .catch(() => undefined);
    }

    return c.json({
      unread,
      pokes: rows.map((r) => ({
        id: r.id.toString(),
        pokeType: r.pokeType,
        initiatorId: r.initiatorId.toString(),
        recipientId: r.recipientId.toString(),
        createdAt: r.createdAt.toISOString(),
        seen: r.seen,
        initiatorName: r.displayName ?? r.username ?? 'Someone',
      })),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /:channelId/attachments — the "all media / documents" gallery
// ═══════════════════════════════════════════════════════════════════════════
//
// Lists a channel's attachments newest-first, paginated by attachment id
// (`before` cursor). `kind=media|files` filters server-side by content type;
// E2EE channels omit it (the real type is hidden in the encrypted blob) and the
// client buckets by the inner filename. Access is gated exactly like reading
// the channel's messages (loadChannelContext throws otherwise).
messagesRouter.get(
  '/:channelId/attachments',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate(
    'query',
    z.object({
      before: snowflakeSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
      kind: z.enum(['media', 'files']).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const ctx = await loadChannelContext(channelId, userId);

    // READ_MESSAGE_HISTORY, same gate as list-messages (:1509-1513). This route
    // returns attachments from the channel's ENTIRE history, so without it a
    // member who can see the channel but is denied history could page the whole
    // media archive — strictly more than the messages endpoint would give them.
    // The context was already being loaded here and then thrown away.
    if (!ctx.isDM && ctx.channelPerms !== null) {
      if (!hasPermission(ctx.channelPerms, Permissions.READ_MESSAGE_HISTORY)) {
        throw errors.missingPermissions(['READ_MESSAGE_HISTORY']);
      }
    }

    const q = c.req.valid('query');
    const rows = await messages.listChannelAttachments(channelId, {
      before: q.before ? BigInt(q.before) : undefined,
      limit: q.limit,
      kind: q.kind,
    });
    return c.json({
      attachments: rows.map((r) => ({
        ...toAttachment(r.attachment),
        messageId: r.messageId.toString(),
        authorId: r.authorId !== null ? r.authorId.toString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);

messagesRouter.post(
  '/:channelId/messages',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    // Instance mute (staff action): no send while muted. See services/instanceMutes.
    await assertNotInstanceMuted(userId);
    const channelId = BigInt(c.req.valid('param').channelId);
    const ctx = await loadChannelContext(channelId, userId);

    // ── Parse body: JSON or multipart ────────────────────────────────────
    const contentType = c.req.header('content-type') ?? '';
    let payload: z.infer<typeof sendMessageSchema>;
    let files: File[] = [];
    // Parallel to `files` (by position): the encrypted thumbnail for files[i]
    // (E2EE images only; null otherwise), and the client metadata for files[i].
    let thumbFiles: (File | null)[] = [];
    let attMeta: ({ width?: number; height?: number; hasThumbnail?: boolean } | null)[] = [];

    if (contentType.startsWith('multipart/form-data')) {
      const body = await parseFormBody(c, { all: true });
      const rawJson = body['payload_json'];
      const jsonStr = Array.isArray(rawJson) ? rawJson[0] : rawJson;
      let parsed: unknown = {};
      if (typeof jsonStr === 'string' && jsonStr.length > 0) {
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          throw errors.badRequest('payload_json is not valid JSON');
        }
      }
      payload = sendMessageSchema.parse(parsed);
      // Reconstruct ordered MAIN files + a parallel encrypted-thumbnail array by
      // parsing the indexed field names: files[i] (main) and thumbs[i] (the
      // encrypted thumb for main i, E2EE images only, sparse). A legacy bare
      // "files" key is appended in encounter order. Explicit index ordering
      // keeps files / thumbs / the positional `attachments` meta aligned even
      // for sparse slots (e.g. image + pdf + image).
      const mainByIdx = new Map<number, File>();
      const thumbByIdx = new Map<number, File>();
      for (const [key, value] of Object.entries(body)) {
        if (key === 'payload_json') continue;
        const list = Array.isArray(value) ? value : [value];
        const mMain = /^files\[(\d+)\]$/.exec(key);
        const mThumb = /^thumbs\[(\d+)\]$/.exec(key);
        for (const v of list) {
          if (!(v instanceof File)) continue;
          if (mMain) mainByIdx.set(Number(mMain[1]), v);
          else if (mThumb) thumbByIdx.set(Number(mThumb[1]), v);
          else if (key === 'files') mainByIdx.set(mainByIdx.size, v); // legacy bare
        }
      }
      const idxs = [...mainByIdx.keys()].sort((a, b) => a - b);
      files = idxs.map((i) => mainByIdx.get(i)!);
      thumbFiles = idxs.map((i) => thumbByIdx.get(i) ?? null);
      attMeta = idxs.map((i) => payload.attachments?.[i] ?? null);
      if (files.length > env.MAX_FILES_PER_MESSAGE) {
        throw errors.badRequest(`At most ${env.MAX_FILES_PER_MESSAGE} attachments per message`);
      }
      // A thumbnail part with no matching main file is malformed.
      if ([...thumbByIdx.keys()].some((i) => !mainByIdx.has(i))) {
        throw errors.badRequest('thumbnail without a matching attachment');
      }
    } else {
      const json = (await c.req.json().catch(() => ({}))) as unknown;
      payload = sendMessageSchema.parse(json);
    }

    // ── Permission gating (guild channels only) ──────────────────────────
    if (!ctx.isDM && ctx.channelPerms !== null) {
      // Forums are post containers — they hold public_thread children
      // (posts), not direct messages. The ForumView surface doesn't
      // render a message stream for the forum itself; messages sent
      // directly to a forum channel would be invisible to viewers
      // while still consuming DB rows. The proper path is the
      // forum-post route which creates a new thread + its first
      // message. Link channels carry no messages at all. Shared with
      // the scheduled-message create route and fire gates.
      assertChannelAcceptsMessages(ctx.channel);
      // Archived-thread lock, SEND_MESSAGES / ATTACH_FILES, onboarding,
      // timeout, supervision, slowmode, spam, banned words + automod. One
      // shared helper so the scheduled-message worker applies the exact same
      // gates at fire time. A poll's question and answers are shown like the
      // body, so they face the same banned-words + automod check.
      await enforceGuildSendGates({
        channel: ctx.channel,
        channelPerms: ctx.channelPerms,
        userId,
        content: payload.content,
        extraText: payload.poll
          ? [payload.poll.question, ...payload.poll.options].join('\n')
          : undefined,
        hasFiles: files.length > 0,
        enforceSlowmode: true,
      });
    }

    // DM send throttle — guild sends go through security.checkSpam above; DMs
    // had no spam gate. Per author+channel, fail-open. Covers 1:1 + group DMs.
    if (ctx.isDM) {
      const rl = await dmSendLimiter.consume(`${userId}:${channelId}`);
      if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    }

    // Block check on 1:1 DM sends. Without this, blocking the other
    // party in a pre-existing DM is purely cosmetic — they can keep
    // sending messages that arrive in the blocker's UI. Group DMs
    // intentionally NOT covered here: multiple-recipient block
    // semantics are ambiguous (suppress-for-blocker only? evict the
    // blocked user? evict-on-block?) and we defer the policy choice
    // rather than picking one arbitrarily. The 1:1 case has a clear
    // semantic and is the common surface. Returns notFound rather
    // than forbidden so the response doesn't leak the block
    // direction.
    if (ctx.isDM && ctx.channel.type === 'dm') {
      const other = await dms.getOtherRecipient(channelId, userId);
      if (other !== null) {
        const { isBlockedEitherWay } = await import('../services/relationships');
        if (await isBlockedEitherWay(userId, other)) {
          throw errors.notFound('Channel');
        }
        // Supervision DM policy (symmetric — protects a minor on either end).
        // Unlike DM *creation*, this re-checks on every send so a minor who
        // loses a friend, or whose guardian tightens the policy, can't keep
        // messaging in a DM opened earlier.
        if (await supervision.dmBlockedBySupervision(userId, other)) {
          throw new AppError(
            'FORBIDDEN',
            'Direct messages are restricted — connect a guardian to continue',
            { supervisionRestricted: 'dm' },
          );
        }
        // Supervision E2EE enforcement: a supervised minor's DMs must stay
        // plaintext (scannable + parent-readable). The channel "suppressed"
        // flag is a client advisory only, so a modified/older client could
        // send ciphertext directly. Reject any E2EE-shaped payload for a
        // supervised pair server-side so the design invariant actually holds.
        // Reject encrypted CONTENT *or* encrypted ATTACHMENTS for a supervised
        // pair — the invariant is that a supervised minor's DMs stay plaintext
        // + server-scannable. Testing only payload.content let an
        // attachment-only encrypted message (empty content) slip through.
        const hasEncryptedAttachment =
          files.some((f) => f.name.toLowerCase().endsWith('.zke')) ||
          thumbFiles.some((t) => t !== null);
        if (
          (E2EE_CIPHERTEXT_RE.test(payload.content) || hasEncryptedAttachment) &&
          !(await supervision.isE2eeAllowedBetween(userId, other))
        ) {
          throw new AppError(
            'FORBIDDEN',
            'Encrypted messages are unavailable while this conversation is supervised.',
            { supervisionRestricted: 'e2ee' },
          );
        }
      }
    }

    const allowEveryone = ctx.isDM
      ? true
      : ctx.channelPerms !== null && hasPermission(ctx.channelPerms, Permissions.MENTION_EVERYONE);

    // ── Forward validation ──────────────────────────────────────────────
    //
    // When a forwardFromMessageId is supplied, verify the caller has
    // VIEW_CHANNEL + READ_MESSAGE_HISTORY on the SOURCE channel. We
    // refuse to forward content the caller couldn't read — otherwise
    // a leaked message id from a private channel could be re-shared
    // to a public channel by anyone who knows the id.
    let forwardedFromMessageId: bigint | null = null;
    let forwardSnapshot: messages.ForwardSnapshot | null = null;
    if (payload.forwardFromMessageId) {
      const sourceId = BigInt(payload.forwardFromMessageId);
      const sourceRows = await db
        .select({
          id: schema.messages.id,
          channelId: schema.messages.channelId,
          deletedAt: schema.messages.deletedAt,
          // A disappearing message past its deadline is gone for everyone,
          // even before the sweep marks it deleted.
          expired: sql<boolean>`NOT ${messages.notExpired()}`,
        })
        .from(schema.messages)
        .where(eq(schema.messages.id, sourceId))
        .limit(1);
      const source = sourceRows[0];
      if (!source) throw errors.notFound('Source message');
      if (source.deletedAt || source.expired) {
        throw errors.badRequest('Cannot forward a deleted message');
      }
      // Forward chains: forwarding a forward should snapshot the
      // ORIGINAL source, not the intermediate. We don't currently
      // chase chains — clients can do that visually if they want
      // (showing nested forwards). For v1 we just permit forwarding
      // anything the caller can read.
      const sourceCtx = await loadChannelContext(source.channelId, userId);
      if (!sourceCtx.isDM && sourceCtx.channelPerms !== null) {
        if (!hasPermission(sourceCtx.channelPerms, Permissions.VIEW_CHANNEL)) {
          throw errors.notFound('Source message');
        }
        if (!hasPermission(sourceCtx.channelPerms, Permissions.READ_MESSAGE_HISTORY)) {
          throw errors.missingPermissions(['READ_MESSAGE_HISTORY']);
        }
      }
      // For DM sources: only forward if the caller is a recipient
      // (loadChannelContext throws notFound otherwise, so reaching here
      // means they're authorized).
      forwardedFromMessageId = sourceId;

      // SNAPSHOT THE SOURCE, right here — the one moment access to it has
      // actually been verified, by the checks immediately above.
      //
      // Storing only the pointer meant every later render dereferenced the
      // live source with no re-check of the CURRENT viewer's access, so a
      // recipient who could see the forward but not the source channel read
      // its content anyway, and kept reading it after access was revoked.
      // Freezing it also stops edits to the source rewriting history inside
      // every forward of it, which is what WhatsApp and Slack do.
      forwardSnapshot = await messages.snapshotForwardSource(sourceId);
      // The snapshot is re-posted here under the caller's name, so in a guild
      // it faces this guild's banned words + automod like text they typed:
      // otherwise a forward could carry text in from a server (or a time)
      // whose rules allowed it. There is NO exemption for E2EE-looking
      // content: the `zkE2EE/<v>:` prefix is just text any DM can carry
      // (plaintext DMs are never moderated), so skipping on it let blocked
      // words ride into a guild behind the prefix. Real ciphertext is base64
      // noise and doesn't realistically trip word or link rules.
      if (ctx.channel.guildId !== null && forwardSnapshot) {
        // repeat_message is skipped: the snapshot is not stored as this
        // message's content, and forwarding your own recent message
        // elsewhere is not a flood.
        await enforceGuildContentModeration({
          guildId: ctx.channel.guildId,
          channelId,
          userId,
          content: forwardSnapshot.content,
          skipRepeatMessage: true,
        });
      }
    }

    // ── Sticker validation ──────────────────────────────────────────────
    //
    // Sticker must belong to the SAME guild as the destination channel.
    // Cross-guild sticker use is intentionally not supported — Discord
    // does the same; Nitro-tier cross-guild stickers can be a v2
    // feature if there's demand. Sticker + attachments + poll are
    // mutually exclusive (a message has one body shape).
    let stickerId: bigint | null = null;
    // Hoisted so the DTO build below reuses this validated row instead of
    // re-fetching the identical sticker within the same request.
    let stickerRow: Awaited<ReturnType<typeof stickers.getSticker>> = null;
    if (payload.stickerId) {
      if (files.length > 0) throw errors.badRequest('Cannot combine sticker with attachments');
      if (payload.poll) throw errors.badRequest('Cannot combine sticker with a poll');
      if (forwardedFromMessageId) throw errors.badRequest('Cannot combine sticker with a forward');
      const sid = BigInt(payload.stickerId);
      stickerRow = await stickers.getSticker(sid);
      if (!stickerRow) throw errors.notFound('Sticker');
      if (!ctx.channel.guildId || stickerRow.guildId !== ctx.channel.guildId) {
        throw errors.badRequest('Sticker not available in this channel');
      }
      stickerId = sid;
    }

    // ── Voice message validation ────────────────────────────────────────
    //
    // A voice message must have exactly one audio attachment, no text
    // content, and no other body shape (poll / sticker / forward). The
    // route flags the first attachment row as voice and writes the
    // duration + waveform onto it.
    if (payload.voiceMessage) {
      if (files.length !== 1) {
        throw errors.badRequest('Voice messages require exactly one attached audio file');
      }
      const f = files[0]!;
      if (!f.type.startsWith('audio/')) {
        throw errors.badRequest('Voice message attachment must be an audio file');
      }
      if (payload.content && payload.content.trim().length > 0) {
        throw errors.badRequest('Voice messages cannot have text content');
      }
      if (payload.poll) throw errors.badRequest('Cannot combine voice message with a poll');
      if (stickerId) throw errors.badRequest('Cannot combine voice message with a sticker');
      if (forwardedFromMessageId) {
        throw errors.badRequest('Cannot combine voice message with a forward');
      }
    }

    // ── Save uploaded files to disk first; on any later failure we don't
    //    leak orphan files (a janitor cron is acceptable for v1; the message
    //    transaction failing is rare and recoverable). ────────────────────
    // Resolve the per-tier upload cap ONCE for this request (the tier is
    // invariant for its duration): a 10-photo post would otherwise fan out to
    // 10 identical subscription reads. Same fail-open-to-env-cap semantics as
    // saveUploadedFile's own lookup — any read hiccup degrades to the env cap,
    // never blocks the upload.
    let capMb = env.MAX_UPLOAD_SIZE_MB;
    if (files.length > 0) {
      try {
        const monetization = await import('../services/monetization');
        const subs = await import('../services/subscriptions');
        const sub = await subs.getEffectiveSubscription(userId);
        capMb = await monetization.uploadCapMbForTier(sub?.tier ?? 'free');
      } catch {
        capMb = env.MAX_UPLOAD_SIZE_MB;
      }
    }
    // Save mains; each call may ALSO produce a thumbnail (its own file/row):
    // the client's encrypted thumb for E2EE images, or a server-generated webp
    // for non-E2EE images (saveUploadedFile only thumbnails actual images).
    const saved =
      files.length > 0
        ? await Promise.all(
            files.map((f, i) =>
              uploads.saveUploadedFile(f, {
                encryptedThumb: thumbFiles[i] ?? null,
                makeServerThumbnail: !thumbFiles[i],
                capMbOverride: capMb, // per-tier size cap, resolved once above
              }),
            ),
          )
        : [];

    let result;
    try {
      result = await messages.createMessage({
        channelId,
        authorId: userId,
        content: payload.content,
        replyToId: payload.replyToId ? BigInt(payload.replyToId) : null,
        guildId: ctx.channel.guildId ?? null,
        // Atomic slowmode re-check inside the create tx (0 = bypass). Only
        // guild channels (channelPerms != null) where the caller isn't a mod;
        // DMs have no slowmode. The enforceSlowmode pre-check above stays for
        // the fast early reject.
        slowmodeSeconds:
          ctx.channelPerms !== null &&
          !hasPermission(ctx.channelPerms, Permissions.MANAGE_MESSAGES)
            ? ctx.channel.rateLimitPerUser
            : 0,
        allowEveryoneMention: allowEveryone,
        hasAttachedPoll: !!payload.poll,
        forwardedFromMessageId,
        forwardSnapshot,
        stickerId,
        attachments: saved.flatMap((s, i) => {
          // Tag the first (and only) attachment with voice metadata when the
          // request came in with a `voiceMessage` field (files.length === 1 is
          // guaranteed above, so index 0 is unambiguous).
          const voice = i === 0 && payload.voiceMessage ? payload.voiceMessage : null;
          // Client-supplied dims fill in for E2EE (.zke) images the server
          // can't measure; server-measured dims (non-E2EE, sharp) win.
          const meta = attMeta[i] ?? null;
          const rows = [
            {
              id: s.attachmentId,
              filename: s.filename,
              contentType: s.contentType,
              size: s.size,
              url: s.url,
              width: s.width ?? meta?.width ?? null,
              height: s.height ?? meta?.height ?? null,
              isVoiceMessage: !!voice,
              durationSeconds: voice ? voice.durationSeconds : null,
              waveform: voice ? voice.waveform : null,
              thumbnailUrl: s.thumbnail?.url ?? null,
              isThumbnail: false,
            },
          ];
          // The thumbnail is its OWN attachment row (so the CDN serves it + GC
          // keeps it); excluded from listings via isThumbnail.
          if (s.thumbnail) {
            const t = s.thumbnail;
            rows.push({
              id: t.attachmentId,
              filename: t.filename,
              contentType: t.contentType,
              size: t.size,
              url: t.url,
              width: t.width ?? null,
              height: t.height ?? null,
              isVoiceMessage: false,
              durationSeconds: null,
              waveform: null,
              thumbnailUrl: null,
              isThumbnail: true,
            });
          }
          return rows;
        }),
      });
    } catch (err) {
      // Roll back the on-disk files (main + thumbnail) if the tx failed.
      for (const s of saved) {
        await uploads.deleteAttachmentFile(s.attachmentId);
        if (s.thumbnail) await uploads.deleteAttachmentFile(s.thumbnail.attachmentId);
      }
      throw err;
    }

    // Bump thread activity if this message landed in a thread. Resets
    // the auto-archive countdown — every new message in the thread
    // pushes the archive deadline forward. Fire-and-forget: we don't
    // block the response on this cheap UPDATE, and a lost bump just
    // means the thread archives at most one sweep-tick (60s) too
    // early. Archived-thread sends are already blocked above, so the
    // unarchive side-effect of bumpThreadActivity is dormant here.
    if (ctx.channel.type === 'public_thread') {
      void threads.bumpThreadActivity(channelId).catch((err) => {
        log.warn?.('thread activity bump failed', {
          channelId: channelId.toString(),
          err,
        });
      });
    }

    // Attach poll if one was supplied. We do this after the message
    // create rather than inside the same transaction to keep the
    // critical path simple — if poll insert fails the message is
    // already broadcast, but the user-visible result is just "no
    // poll" which the user can resend. A future cleanup pass might
    // tx-wrap both, but today the convenience is worth the tiny
    // chance of a no-poll-message slipping through on a DB hiccup.
    let pollDTO: PollDTO | null = null;
    if (payload.poll) {
      try {
        const created = await polls.createPoll({
          messageId: result.message.id,
          question: payload.poll.question,
          options: payload.poll.options,
          multipleChoice: payload.poll.multipleChoice ?? false,
          durationHours: payload.poll.durationHours,
        });
        pollDTO = toPoll({
          poll: created.poll,
          options: created.options.map((o) => ({ ...o, voteCount: 0 })),
          totalVoters: 0,
          myVotes: [],
        });
      } catch (e) {
        // Poll create failed — surface the error rather than silently
        // shipping a poll-less message. The route handler will roll
        // back nothing further; the message itself is already saved
        // and broadcast above. Caller sees the error and can retry
        // creating a fresh poll-bearing message.
        throw e;
      }
    }

    // Build DTO with author + attachments (we just inserted them — re-load).
    const author = await loadUser(userId);
    const attachmentRows = await messages.loadAttachments([result.message.id]);

    // Resolve attached sticker for the DTO. The single-create path
    // doesn't need a batched loader — we already have the sticker
    // id from validation above. Skip if it's null.
    // Reuse the row validated above (non-null iff stickerId is set) — no
    // second fetch of the same immutable sticker.
    let stickerDTO: StickerDTO | null = null;
    if (stickerRow) stickerDTO = toSticker(stickerRow);

    // Load the forward source if this message is a forward. Same lookup
    // shape as the list-messages path uses; we batch with a single id
    // here since this is a single send.
    let forwardSourceDTO: ForwardSourceDTO | null = null;
    if (forwardedFromMessageId) {
      const sources = await messages.loadForwardSources([forwardedFromMessageId]);
      const sm = sources.messages.get(forwardedFromMessageId) ?? null;
      forwardSourceDTO = toForwardSource({
        sourceMessageId: forwardedFromMessageId,
        sourceMessage: sm,
        sourceAuthor: sm?.authorId ? sources.authors.get(sm.authorId) ?? null : null,
        sourceChannel: sm ? sources.channels.get(sm.channelId) ?? null : null,
        sourceAttachments: sources.attachments.get(forwardedFromMessageId) ?? [],
        // The frozen copy on THIS forward's own row. Present for every forward
        // from 0123 onward (the migration backfilled the existing ones), so
        // the live source below is consulted only for attribution and the
        // deleted flag — never for content the reader may not be entitled to.
        snapshot: {
          content: result.message.forwardedContent,
          authorName: result.message.forwardedAuthorName,
          authorAvatar: result.message.forwardedAuthorAvatar,
          channelName: result.message.forwardedChannelName,
          createdAt: result.message.forwardedCreatedAt,
          attachments: result.message.forwardedAttachments,
        },
      });
    }

    const messageDTO = toMessage({
      message: result.message,
      author,
      attachments: attachmentRows.get(result.message.id) ?? [],
      reactions: [],
      mentionedUserIds: result.mentionedUserIds,
      mentionedRoleIds: result.mentionedRoleIds,
      poll: pollDTO,
      sticker: stickerDTO,
      forwardedFrom: forwardSourceDTO,
      selfId: userId,
    });

    // Before fanning out a DM message, (re)subscribe every recipient's LIVE
    // gateway connections to this channel. A connection's dmChannelIds set can
    // drift out of sync with reality — RESUME inherits the prior (possibly
    // stale) snapshot instead of reloading it, and a closed-then-reopened DM
    // isn't re-registered — which silently drops the live MESSAGE_CREATE for an
    // OPEN conversation (the recipient fails conn.dmChannelIds.has(channelId) in
    // the gateway's channel-audience filter) even though the push still fires.
    // dmSubscribeRecipients only touches currently-connected sockets (on every
    // replica, via one small internal bus signal) and is idempotent (Set.add +
    // index guard), so this is a cheap no-op once a connection is correctly
    // registered — but it guarantees live delivery to anyone with the DM open. Guild channels don't need this (membership/viewability is fixed
    // at IDENTIFY and on join). Must run BEFORE the dispatch so THIS message is
    // delivered, not just future ones.
    // Snapshot the DM recipient set ONCE for this request — reused by both the
    // live re-subscribe loop (here) and the push fan-out IIFE below. Recipients
    // don't change within a send, so one query is equivalent to the two
    // identical ones we used to run.
    let dmRecipients: bigint[] | null = null;
    if (ctx.isDM) {
      try {
        dmRecipients = await dms.listAllRecipients(channelId);
        dispatch.dmSubscribeRecipients({ channelId, recipientIds: dmRecipients });
      } catch {
        // Best-effort: a failed re-subscribe just falls back to whatever the
        // connection already had; the push + REST refetch still cover it.
      }
    }

    // Fan out over the gateway. The sender's nonce rides along ONLY on
    // this broadcast so their client can replace its optimistic
    // placeholder in place; other recipients just ignore it.
    dispatch.messageCreate({
      messageDTO: payload.nonce ? { ...messageDTO, nonce: payload.nonce } : messageDTO,
      channelId,
      guildId: ctx.channel.guildId ?? null,
    });

    // Disappearing messages: createMessage just moved the sender's read
    // marker to this message (sending is a full ack), so start the clocks it
    // now covers, as the ack route does. Installed apps' notification quick
    // replies only POST the message, and every client skips the ack while
    // the marker is current — without this, what the sender answered would
    // never disappear. After the commit and the fan-out; no-op outside DMs.
    await dms.startDisappearingTimersAndNotify({
      channelId,
      channelType: ctx.channel.type,
      readerId: userId,
      upToMessageId: result.message.id,
    });

    // Parental controls: scan against any supervised child's watch words
    // (the author, and the other party in a 1:1 DM). Fire-and-forget so
    // it never blocks or fails the send.
    void supervision
      .scanMessageForFlags({
        messageId: result.message.id,
        channelId,
        channelType: ctx.channel.type,
        authorId: userId,
        content: payload.content ?? '',
      })
      .catch(() => undefined);

    // Achievement unlocks driven by messaging (chatterbox tiers, night_owl,
    // first_responder, welcome_committee). Throttled per-user + fire-and-forget
    // so a burst of sends does at most one recompute a minute and never blocks.
    void import('../services/achievements')
      .then((m) => m.syncAndNotifyAchievementsThrottled(userId))
      .catch(() => {});

    // DM read-receipt: delivered-at stamping. Only relevant on 1:1
    // DMs (group DMs and guild messages don't carry receipts). If
    // the recipient is currently connected to the gateway, the
    // message just landed on their device — stamp delivered_at
    // and dispatch MESSAGE_DELIVERED to the author. If they're
    // offline, leave delivered_at NULL; the IDENTIFY-time backfill
    // will pick it up when they next connect. Fire-and-forget so
    // the REST response isn't blocked on the second DB write.
    if (ctx.isDM && ctx.channel.type === 'dm') {
      void (async () => {
        try {
          const other = await dms.getOtherRecipient(channelId, userId);
          if (other === null) return;
          // Only stamp if the recipient has a LIVE connection. byUserId
          // also returns detached resume-window ghosts (sockets that
          // closed up to 60s ago) — stamping against a ghost would flip
          // the sender's UI to Delivered for a message the recipient may
          // never receive (frame buffered, then discarded at eviction).
          // Offline recipients are handled by the IDENTIFY-time backfill,
          // which stamps only when they actually reconnect. Their
          // dmReadReceiptsEnabled toggle is also re-checked inside
          // markMessageDelivered so the gate is honored either way.
          if (!registry.hasLiveConnection(other)) return;
          const { stamped, recipientReceiptsEnabled } =
            await dms.markMessageDelivered(result.message.id, other);
          if (!stamped) return;
          // Stamp landed (column flipped from NULL to now()). Dispatch
          // only if the recipient has receipts enabled — the stamp
          // stays in the DB either way for any future use, but the
          // sender's UI flip Sent → Delivered is gated.
          if (!recipientReceiptsEnabled) return;
          dispatch.messageDelivered({
            authorId: userId,
            channelId,
            messageIds: [result.message.id],
            deliveredAt: new Date(),
          });
        } catch {
          // Best-effort. A failed stamp leaves delivered_at NULL;
          // the recipient's next IDENTIFY backfill catches up.
        }
      })();
    }

    // Resolve link previews asynchronously. Fire-and-forget — the
    // REST response is already on the wire. The embed service writes
    // the resolved embeds onto the message row and broadcasts a
    // MESSAGE_UPDATE so connected clients see the cards appear inline
    // 100-2000ms later. Skip when there's no content to scan
    // (attachment-only messages, polls without text, etc.), and when the
    // author lacks EMBED_LINKS in this channel (DMs always have it).
    if (
      payload.content &&
      payload.content.trim().length > 0 &&
      canEmbedLinks(ctx)
    ) {
      void embeds.resolveAndPersistEmbeds({
        messageId: result.message.id,
        channelId,
        guildId: ctx.channel.guildId ?? null,
        content: payload.content,
      });
    }

    // Bot event delivery — fire-and-forget. POSTs a signed
    // message.create event to every bot in the guild that can view
    // this channel and has an event callback URL configured. Bot-
    // authored messages are not fanned out (loop guard, enforced in
    // the service). Mirrors the embed pipeline's fire-and-forget shape.
    {
      const botsSvc = await import('../services/bots');
      // .catch: the service swallows per-bot delivery errors but its
      // initial DB query can still reject; an unhandled rejection here
      // is fatal (see the process-level handler in index.ts).
      void botsSvc.deliverMessageEventToBots({
        guildId: ctx.channel.guildId ?? null,
        channelId,
        authorId: userId,
        authorIsBot: !!author?.isBot,
        event: {
          type: 'message.create',
          message: messageDTO,
        },
      }).catch((err) => {
        log.warn?.('bot event delivery failed', {
          channelId: channelId.toString(),
          err: (err as Error).message,
        });
      });
    }

    // Push notifications — best-effort, fire-and-forget. Mentions in
    // guild channels go to mentioned users (excluding the author);
    // every message in a DM goes to non-author recipients. We don't
    // await this — the REST response shouldn't be blocked on outbound
    // push, which can take 100+ms per device.
    void (async () => {
      try {
        const { sendToUser } = await import('../services/push');
        const isDM = ctx.isDM;

        // Notification format: title is always the brand ("Zekktris")
        // and the body carries the actual signal as "name: message".
        // Rationale: users browse notification trays where the title
        // doubles as the "which app pinged me" cue; making it the
        // sender name buries the brand. The body line is where the
        // content goes, which is also what every modern messaging
        // app does (Slack, Discord, Signal, iMessage all put their
        // brand or thread name on top and the actual message text
        // on the bottom line).
        //
        // Truncation budget is bumped from 200 → 230 chars to leave
        // room for the "name: " prefix (~12-25 chars depending on
        // display name length) without crowding the message preview.
        // Web Push payload total stays well under the ~4KB gateway
        // limit.
        // E2EE detection. When the content is wrapped in the per-DM
        // E2EE wire format (`zkE2EE/<v>:<base64>`), the server can't
        // decrypt it — and surfacing the ciphertext as the body would
        // produce a useless "zkE2EE/1:AbCd…" preview on the lock
        // screen. We also hide the sender's name: the user opted into
        // E2EE for privacy, so leaking metadata (who's messaging
        // whom) on the lock screen defeats half the point. Generic
        // title + generic body keep the notification useful (the
        // user knows SOMETHING happened in Zekktris) without leaking
        // anything about the conversation.
        const isE2EEContent = /^zkE2EE\/\d+:/.test(payload.content);
        const authorName = author?.displayName ?? author?.username ?? 'Someone';
        const channelName = ctx.channel.name ?? 'a channel';
        // Budget for the body. APNs caps push body around 240 chars
        // in practice. The body now contains just the message (and
        // an optional "  ·  #channelName" suffix for guild mentions),
        // not "name: message", so we have more room than before. We
        // subtract the channel marker length for guild messages so
        // the marker isn't itself truncated.
        const channelSuffixLen = isDM ? 0 : `  ·  #${channelName}`.length;
        const remaining = Math.max(40, 230 - channelSuffixLen);
        const truncatedBody =
          payload.content.length > remaining
            ? payload.content.slice(0, remaining - 1) + '…'
            : payload.content;
        // For an image attachment, the iOS NSE attaches the actual image, so
        // give the body a friendly label instead of "(attachment)".
        const firstImage = saved.find((s) => (s.contentType ?? '').startsWith('image/'));
        const attachmentLabel = firstImage ? '📷 Photo' : saved.length > 0 ? '📎 Attachment' : '';
        const messagePart = truncatedBody || attachmentLabel;
        // Absolute URL the NSE downloads to show the image inline. Non-E2EE only
        // (E2EE bytes are encrypted and never previewed); prefer the smaller
        // thumbnail when one exists.
        const imageUrl =
          firstImage && !ctx.channel.e2eeEnabled
            ? `${env.PUBLIC_URL}${firstImage.thumbnail?.url ?? firstImage.url}`
            : undefined;
        // Sender's avatar for the iOS communication-notification styling (the
        // face on the lock screen, and the voice Siri announces through
        // AirPods). `avatarUrl` is validated `/cdn/...` on write, so the same
        // PUBLIC_URL join imageUrl uses is safe here — this can never be an
        // attacker-supplied absolute URL.
        const senderAvatar = author?.avatarUrl ? `${env.PUBLIC_URL}${author.avatarUrl}` : undefined;
        // Push notification layout: title is the author's name; body
        // is just the message text. iOS auto-inserts a "from Zekktris"
        // subtitle between them for PWA notifications (unremovable —
        // it's how iOS identifies which installed PWA fired the
        // push), so the resulting tray entry reads:
        //
        //   alice                  ← title (bold)
        //   from Zekktris          ← iOS-injected, identifies the app
        //   hey are you free?      ← body (message)
        //
        // The author name belongs in the title slot because that's
        // what the user actually wants to glance-identify. Brand-
        // first titling ("Zekktris" as headline) reads worse because
        // iOS already attributes the notification to the app via the
        // injected subtitle.
        //
        // For guild mentions, the channel hint stays in the body
        // after the message so the user knows which channel they
        // were @mentioned in.
        //
        // E2EE override: when the content is encrypted, we can't show
        // it. Both title AND body are replaced with privacy-preserving
        // generic strings so the lock-screen preview doesn't leak
        // the sender's name OR a useless ciphertext snippet.
        //
        // Title: "New message" instead of the brand name. iOS auto-
        // injects "from Zekktris" as a subtitle for every PWA push
        // (unremovable — it's how iOS identifies which app fired the
        // notification), so the layered reading becomes:
        //
        //   New message              ← title (this)
        //   from Zekktris            ← iOS-injected subtitle
        //   Open app to see message  ← body
        //
        // Using "Zekktris" as the title duplicated with the iOS
        // subtitle and read weirdly ("Zekktris / from Zekktris").
        // "New message" describes the actual event in a way that
        // composes well with the iOS-injected line.
        // Generic (privacy-preserving) vs content-bearing strings. Which a
        // recipient gets depends on E2EE state and — for DMs — their personal
        // notification-preview preference (resolved per-recipient below).
        const genericTitle = 'New message';
        const genericBody = 'Open app to see message.';
        const contentTitle = authorName;
        const contentBody = isDM ? messagePart : `${messagePart}  ·  #${channelName}`;
        // Guild messages (never E2EE) keep today's behavior.
        const title = isE2EEContent ? genericTitle : contentTitle;
        const body = isE2EEContent ? genericBody : contentBody;

        // URL the click should open. For guild channels:
        // /channels/<guildId>/<channelId>; for DMs: /channels/@me/<channelId>.
        const url = isDM
          ? `/channels/@me/${channelId.toString()}`
          : `/channels/${(ctx.channel.guildId ?? 0n).toString()}/${channelId.toString()}`;

        // Recipients (opt-out model). DMs: every other participant. Guild
        // channels (text, forums, threads, announcements): EVERY member who can
        // VIEW the channel — private/mod channels stay private. Each viewer's
        // resolved level then decides whether the push actually goes out (below).
        // Author is always excluded.
        let targetUserIds: bigint[] = [];
        // Three or more participants — a GROUP DM. Only used to give the iOS
        // notification a group name, so it reads as the group conversation it
        // is instead of looking like a 1:1 from whoever happened to speak.
        let isGroupDM = false;
        const mentioned = new Set<string>(); // who this message actually @mentions
        if (isDM) {
          // Reuse the recipient snapshot from the sync path; only re-query if
          // the re-subscribe block threw before populating it.
          const recipients = dmRecipients ?? (await dms.listAllRecipients(channelId));
          targetUserIds = recipients.filter((id) => id !== userId);
          isGroupDM = recipients.length > 2;
        } else if (ctx.channel.guildId) {
          // NOTE: this is a full channel-viewer computation per message
          // (O(members) permission math). Acceptable for typical guilds; if a
          // very large/active guild ever makes this hot, cache the viewer set.
          const viewers = (await listChannelViewerIds(ctx.channel.guildId, channelId)).filter(
            (id) => id !== userId,
          );
          targetUserIds = viewers;
          if (result.mentionsEveryone) {
            for (const id of viewers) mentioned.add(id.toString());
            // @everyone bumps the mention badge for every viewer (direct
            // @mentions are badged inline in createMessage).
            await readStates.bumpMentions(channelId, viewers);
          } else {
            for (const id of result.mentionedUserIds) mentioned.add(id.toString());
          }
        }

        // Apply each target's resolved level (channel override → guild override
        // → default 'all'):
        //   'all'      → push every message (the default — so members get every
        //                text/forum message unless they change it)
        //   'mentions' → push only when this message mentions them
        //   'nothing'  → never push (channel muted, OR the whole server muted
        //                via a guild-level override)
        // DMs keep their semantics: 'mentions' still pushes (every DM message is
        // implicitly a mention); only 'nothing' mutes a DM.
        const { resolveLevelsBulk } = await import('../services/notifications');
        const levels = await resolveLevelsBulk(
          targetUserIds,
          channelId,
          ctx.channel.guildId ?? null,
        );
        const allowed = new Map<string, bigint>();
        for (const id of targetUserIds) {
          const level = levels.get(id.toString()) ?? 'all';
          if (level === 'nothing') continue;
          if (level === 'mentions' && !isDM && !mentioned.has(id.toString())) continue;
          allowed.set(id.toString(), id);
        }

        const allowedTargets = [...allowed.values()];
        if (allowedTargets.length === 0) return;

        // Routing data every message push carries so a tap can deep-link to the
        // EXACT message (jump/scroll to it) and, in a guild, prefill a reply to
        // the author. channelId is already in url/tag; messageId + author add a
        // few small strings and leak nothing new (the recipient can already see
        // the message + who sent it).
        const routeData = {
          channelId: channelId.toString(),
          messageId: result.message.id.toString(),
          authorId: userId.toString(),
          authorName,
        };

        if (isDM) {
          // Per-recipient preview preference. No explicit row → default:
          // E2EE generic, plaintext shows content (today's behavior). For an
          // E2EE DM where the recipient opted into content previews, the
          // server can't render the body (it holds ciphertext, not plaintext),
          // so it ships the ciphertext + channel id with `mutable-content`: the
          // iOS Notification Service Extension decrypts on-device and rewrites
          // the body. Clients without the extension (web, or iOS before the
          // key is available) fall back to the "Encrypted message" body. The
          // ciphertext is only attached when it fits APNs' ~4 KB payload budget
          // with headroom; larger messages just show the fallback.
          // APNs rejects a payload over ~4 KB outright — no notification at
          // all — and nothing downstream checks the size, so this cap is the
          // only guard. Trimmed from 3500 to make room for the
          // communication-notification fields (`senderAvatar` is a ~90-char
          // absolute CDN URL, plus a group name); the headroom pays for the
          // title, body, routing data and badge that ride alongside.
          const E2EE_PUSH_MAX = 3300;
          // Per-recipient preview prefs + app-icon badge counts are independent
          // bulk reads — run them in parallel instead of serially. (Guild
          // branch keeps its single badge await; nothing to parallelize there.)
          const [prefs, badges] = await Promise.all([
            dms.getDmNotificationPrefsForChannel(channelId, allowedTargets),
            readStates.unreadBadgeCounts(allowedTargets),
          ]);
          // Common fields so every DM notification carries an inline Reply
          // action: `kind: 'message'` → the Reply category on the client, and
          // `data` with the channel id + whether the conversation is encrypted
          // (so the reply handler knows to encrypt on-device before sending).
          // The channel id is already in `url`/`tag`, so adding it to `data`
          // leaks nothing new.
          const replyData = { ...routeData, isE2EE: isE2EEContent };
          // iOS COMMUNICATION NOTIFICATIONS. The Notification Service Extension
          // rebuilds these as an INSendMessageIntent, which is what gets the
          // sender's face onto the lock screen and lets Siri announce the
          // message through AirPods and take a spoken reply.
          //
          // Attached ONLY to payloads that already put the sender's NAME in the
          // title. The preview-off payload deliberately hides who the message
          // is from, so it must carry nothing the extension could dress it up
          // with. The NSE enforces the same rule independently rather than
          // trusting this — see NotificationService.swift.
          const commData = {
            ...(senderAvatar ? { senderAvatar } : {}),
            ...(isGroupDM ? { groupName: ctx.channel.name ?? 'Group' } : {}),
          };
          const common = { url, tag: channelId.toString(), kind: 'message' as const };
          // Bulk fan-out: one token query per transport + bounded send burst,
          // with each recipient's own preview-pref / E2EE / badge payload.
          await sendToUsers(allowedTargets, (target): PushPayload => {
            const showContent = prefs.get(target) ?? !isE2EEContent;
            const fits = payload.content.length <= E2EE_PUSH_MAX;
            const badge = badges.get(target.toString()) ?? 0;
            return showContent && isE2EEContent
              ? {
                  title: contentTitle,
                  body: 'Encrypted message',
                  ...common,
                  badge,
                  // NSE decrypt payload (e2ee = ciphertext) only when it
                  // fits; either way the reply data rides along.
                  // mutable-content unconditionally now: even when the
                  // ciphertext is too big to ship, the extension still has the
                  // communication styling to apply.
                  mutableContent: true,
                  ...(fits
                    ? { data: { ...replyData, ...commData, e2ee: payload.content } }
                    : { data: { ...replyData, ...commData } }),
                }
              : showContent
                ? imageUrl
                  ? {
                      title: contentTitle,
                      body: contentBody,
                      ...common,
                      badge,
                      mutableContent: true,
                      data: { ...replyData, ...commData, imageUrl },
                    }
                  : {
                      title: contentTitle,
                      body: contentBody,
                      ...common,
                      badge,
                      // Runs the extension for a plain text DM too — without
                      // it there is no communication styling on the ordinary
                      // message, which is most of them.
                      mutableContent: true,
                      data: { ...replyData, ...commData },
                    }
                : { title: genericTitle, body: genericBody, ...common, badge, data: replyData };
          });
        } else {
          // Guild mentions / @everyone: each recipient gets their own app-icon
          // badge count (the per-DM preview pref doesn't apply, and guild
          // messages are never E2EE). Inline reply is offered here too. Bulk
          // fan-out is the scale win — an @everyone in a big guild is now 3
          // token queries + a bounded send burst, not 3×N + an unbounded one.
          const badges = await readStates.unreadBadgeCounts(allowedTargets);
          await sendToUsers(allowedTargets, (target): PushPayload => ({
            title,
            body,
            url,
            tag: channelId.toString(),
            kind: 'message' as const,
            badge: badges.get(target.toString()) ?? 0,
            // Always, not just for images: the extension also applies the
            // communication styling (sender's face + Siri announcement).
            mutableContent: true,
            data: {
              ...routeData,
              isE2EE: false,
              ...(senderAvatar ? { senderAvatar } : {}),
              // A guild channel IS the group conversation, so it names itself.
              groupName: `#${channelName}`,
              ...(imageUrl ? { imageUrl } : {}),
            },
          }));
        }
      } catch (err) {
        // Push is non-critical: a failure here must never surface to the
        // sender or fail the send. But swallowing it SILENTLY made a whole
        // class of bug undiagnosable — "I don't get notifications for photos"
        // looks identical to "no notification was ever attempted", with
        // nothing in the logs either way. Log it (no message content, no
        // recipient ids beyond the count) so the next occurrence is
        // debuggable. Still never rethrown.
        log.warn('message push fan-out failed', {
          channelId: channelId.toString(),
          isDM: ctx.isDM,
          e2ee: ctx.channel.e2eeEnabled ?? false,
          attachments: saved.length,
          hasContent: payload.content.length > 0,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    // Messaging streaks: count the day once both 1:1 participants have
    // messaged (timestamps only — E2EE content is never read).
    if (ctx.isDM && ctx.channel.type === 'dm') {
      void (async () => {
        try {
          const recipients = await dms.listAllRecipients(channelId);
          const other = recipients.find((id) => id !== userId);
          if (other) {
            const streaks = await import('../services/streaks');
            const { streak, changed } = await streaks.recordDmMessage({
              channelId,
              authorId: userId,
              recipientId: other,
            });
            // Push the new streak live to both sides so the chip updates
            // mid-session instead of only after the next DM-list fetch.
            if (changed) {
              dispatch.dmStreakUpdate({ channelId, recipientIds: [userId, other], streak });
            }
          }
        } catch {
          // Streaks are decorative; never fail a send over them.
        }
      })();
    }

    // Echo the nonce on the REST response too (not just the gateway
    // broadcast) so the sender's client can replace its optimistic
    // placeholder from EITHER path. Relying on the gateway echo alone
    // left the bubble stuck on "Sending" whenever the socket was
    // mid-reconnect, even though the 201 landed in ~100ms.
    return c.json(
      { message: payload.nonce ? { ...messageDTO, nonce: payload.nonce } : messageDTO },
      201,
    );
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /:channelId/messages
// ═══════════════════════════════════════════════════════════════════════════

const listMessagesQuery = z
  .object({
    before: snowflakeSchema.optional(),
    after: snowflakeSchema.optional(),
    /** Fetch ~limit/2 messages older than `around` plus ~limit/2
        newer than `around`. Mutually exclusive with before/after —
        the client picks one paginator at a time. */
    around: snowflakeSchema.optional(),
    limit: messagePageLimitSchema.optional(),
  })
  .refine(
    (v) => {
      // around is mutually exclusive with before/after
      const aroundSet = v.around !== undefined;
      const cursorSet = v.before !== undefined || v.after !== undefined;
      return !(aroundSet && cursorSet);
    },
    { message: 'around is mutually exclusive with before/after' },
  );

messagesRouter.get(
  '/:channelId/messages',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('query', listMessagesQuery),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const ctx = await loadChannelContext(channelId, userId);

    if (!ctx.isDM && ctx.channelPerms !== null) {
      if (!hasPermission(ctx.channelPerms, Permissions.READ_MESSAGE_HISTORY)) {
        throw errors.missingPermissions(['READ_MESSAGE_HISTORY']);
      }
    }

    const q = c.req.valid('query');
    // New members see the FULL channel history (no join-floor clamp) — the same
    // as pins/search/threads/jump-to always did. Instead of hiding pre-join
    // content, joining seeds read-states (services/readStates.seedGuildReadOnJoin)
    // so a newcomer starts with a clean/read slate rather than a wall of unread
    // badges, and can still scroll up to the beginning. Each page is bounded by
    // LIMIT, so the default latest-N load stays a cheap top-of-index scan.
    const rows = await messages.listMessages(channelId, {
      before: q.before ? BigInt(q.before) : undefined,
      after: q.after ? BigInt(q.after) : undefined,
      around: q.around ? BigInt(q.around) : undefined,
      limit: q.limit ?? 50,
    });

    // DM viewed-at stamping. Stamps `viewed_at` on each non-self
    // message in the page that's still NULL, then dispatches
    // MESSAGE_VIEWED to the message author so their UI flips
    // "Delivered" → "Read" (1:1 DMs only; group DMs skip). It does
    // NOT start disappearing-message timers: a page fetch isn't a
    // read (background sync, scroll-back) — only the read ack is.
    //
    // Constraints:
    //   - Channel must be a DM (guild messages never carry these
    //     receipts).
    //   - For receipts, the channel type must be 'dm' specifically;
    //     'group_dm' is excluded since "read by whom" is ambiguous
    //     with > 2 recipients.
    //   - The viewer's dmReadReceiptsEnabled toggle gates the
    //     MESSAGE_VIEWED dispatch (not the stamp itself).
    //
    // Fire-and-forget: a failed stamp doesn't block the list
    // response. The next list call retries whatever's still NULL.
    if (ctx.isDM && rows.length > 0) {
      void (async () => {
        try {
          const idsForCallerNotAuthor = rows
            .filter((m) => m.authorId !== userId && m.viewedAt === null)
            .map((m) => m.id);
          if (idsForCallerNotAuthor.length === 0) return;
          const { stamped, viewedAt, viewerReceiptsEnabled } = await dms.markMessagesViewed(
            channelId,
            userId,
            idsForCallerNotAuthor,
          );
          if (stamped.length === 0) return;
          // Dispatch MESSAGE_VIEWED only if the viewer has receipts
          // on. The stamp on viewed_at always lands but the
          // visible-to-sender effect is gated. Group DMs are skipped
          // entirely — the receipt model only makes sense for 1:1.
          if (viewerReceiptsEnabled && ctx.channel.type === 'dm') {
            const byAuthor = new Map<bigint, bigint[]>();
            for (const s of stamped) {
              const list = byAuthor.get(s.authorId);
              if (list) list.push(s.messageId);
              else byAuthor.set(s.authorId, [s.messageId]);
            }
            for (const [authorId, messageIds] of byAuthor) {
              dispatch.messageViewed({
                authorId,
                channelId,
                messageIds,
                viewedAt,
              });
            }
          }
        } catch {
          // Best-effort. A failed viewed_at stamp doesn't break the
          // user's read of the messages; the next list call will
          // retry the stamp on whatever is still NULL.
        }
      })();
    }

    if (rows.length === 0) {
      return c.json({ messages: [] });
    }

    // Bulk hydrate authors, attachments, mentions, reactions, forwards.
    const authorIds = Array.from(new Set(rows.map((m) => m.authorId).filter((x): x is bigint => x !== null)));
    const messageIds = rows.map((m) => m.id);
    // Source ids for any forwarded messages in this page. Distinct so
    // we don't refetch the same source twice if it was forwarded into
    // the same channel multiple times.
    const forwardSourceIds = Array.from(
      new Set(
        rows
          .map((m) => m.forwardedFromMessageId)
          .filter((x): x is bigint => x !== null),
      ),
    );
    // Distinct sticker ids referenced by this page.
    const stickerIds = Array.from(
      new Set(rows.map((m) => m.stickerId).filter((x): x is bigint => x !== null)),
    );

    const [authors, attachmentMap, userMentionRows, roleMentionRows, reactionRows, pollMap, forwardSources, stickerMap] = await Promise.all([
      authorIds.length === 0
        ? Promise.resolve<User[]>([])
        : db.select().from(schema.users).where(inArray(schema.users.id, authorIds)),
      messages.loadAttachments(messageIds),
      db
        .select()
        .from(schema.messageUserMentions)
        .where(inArray(schema.messageUserMentions.messageId, messageIds)),
      db
        .select()
        .from(schema.messageRoleMentions)
        .where(inArray(schema.messageRoleMentions.messageId, messageIds)),
      db
        .select()
        .from(schema.reactions)
        .where(inArray(schema.reactions.messageId, messageIds)),
      polls.loadPollsForMessages(messageIds, userId),
      messages.loadForwardSources(forwardSourceIds),
      messages.loadStickersForMessages(stickerIds),
    ]);

    const authorMap = new Map(authors.map((u) => [u.id, u]));
    const userMentionMap = groupBy(userMentionRows, (r) => r.messageId, (r) => r.userId);
    const roleMentionMap = groupBy(roleMentionRows, (r) => r.messageId, (r) => r.roleId);

    // Aggregate reactions by message → emoji → users.
    const reactionsByMessage = new Map<bigint, Array<{ emoji: string; count: number; userIds: bigint[] }>>();
    for (const r of reactionRows) {
      let perMessage = reactionsByMessage.get(r.messageId);
      if (!perMessage) {
        perMessage = [];
        reactionsByMessage.set(r.messageId, perMessage);
      }
      const existing = perMessage.find((x) => x.emoji === r.emoji);
      if (existing) {
        existing.count++;
        existing.userIds.push(r.userId);
      } else {
        perMessage.push({ emoji: r.emoji, count: 1, userIds: [r.userId] });
      }
    }

    // For 1:1 DMs, load both recipients' receipt toggles so we can
    // gate the DTO surface per-message. The timestamps stay in the
    // DB regardless but a viewer who has receipts off has their reads
    // stripped from outgoing responses. For each message in the page,
    // the gating user is the non-author (whose view the timestamp
    // represents).
    let receiptsByUser: Map<bigint, boolean> | null = null;
    if (ctx.isDM && ctx.channel.type === 'dm') {
      const recipients = await dms.listAllRecipients(channelId);
      if (recipients.length > 0) {
        const toggleRows = await db
          .select({
            id: schema.users.id,
            enabled: schema.users.dmReadReceiptsEnabled,
          })
          .from(schema.users)
          .where(inArray(schema.users.id, recipients));
        receiptsByUser = new Map(toggleRows.map((r) => [r.id, r.enabled]));
      }
    }

    // Disappearing messages: may the requester see expiresAt on their OWN
    // messages? Only in a 1:1 DM whose other recipient has read receipts on —
    // expiresAt minus the timer is that recipient's read time. (Separate from
    // the viewedAt strip below: that one also blanks the reader's own reads,
    // and the reader needs expiresAt to hide what they read on time.)
    let ownExpiryVisible = false;
    if (receiptsByUser) {
      const other = Array.from(receiptsByUser.keys()).find((uid) => uid !== userId);
      ownExpiryVisible = other !== undefined && receiptsByUser.get(other) === true;
    }

    return c.json({
      messages: rows.map((m) => {
        const pollEntry = pollMap.get(m.id);
        // Build the forward snapshot if this message is a forward. The
        // batched loader has the source row + author + channel +
        // attachments already; we just thread them into the DTO helper.
        let forwardedFrom = null as ForwardSourceDTO | null;
        if (m.forwardedFromMessageId) {
          const sm = forwardSources.messages.get(m.forwardedFromMessageId) ?? null;
          forwardedFrom = toForwardSource({
            sourceMessageId: m.forwardedFromMessageId,
            sourceMessage: sm,
            sourceAuthor: sm?.authorId ? forwardSources.authors.get(sm.authorId) ?? null : null,
            sourceChannel: sm ? forwardSources.channels.get(sm.channelId) ?? null : null,
            sourceAttachments: forwardSources.attachments.get(m.forwardedFromMessageId) ?? [],
          });
        }
        // Per-message receipt gate. The "viewer" for receipt purposes
        // is the non-author of this message — their toggle controls
        // whether their read activity is surfaced. If they have
        // receipts off, blank out both timestamps in the DTO.
        let messageRow = m;
        if (receiptsByUser && m.authorId !== null) {
          const viewerCandidates = Array.from(receiptsByUser.keys()).filter(
            (uid) => uid !== m.authorId,
          );
          // 1:1 DM: exactly one non-author. If they have receipts off,
          // strip the stamps before serialization.
          const viewer = viewerCandidates[0];
          if (viewer !== undefined && receiptsByUser.get(viewer) === false) {
            messageRow = { ...m, deliveredAt: null, viewedAt: null };
          }
        }
        return withExpiresAt(
          toMessage({
            message: messageRow,
            author: m.authorId ? authorMap.get(m.authorId) ?? null : null,
            attachments: attachmentMap.get(m.id) ?? [],
            reactions: reactionsByMessage.get(m.id) ?? [],
            mentionedUserIds: userMentionMap.get(m.id) ?? [],
            mentionedRoleIds: roleMentionMap.get(m.id) ?? [],
            poll: pollEntry ? toPoll(pollEntry) : null,
            sticker: m.stickerId ? (() => {
              const sr = stickerMap.get(m.stickerId);
              return sr ? toSticker(sr) : null;
            })() : null,
            forwardedFrom,
            selfId: userId,
          }),
          m,
          userId,
          ownExpiryVisible,
        );
      }),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /:channelId/messages/search
// ═══════════════════════════════════════════════════════════════════════════
//
// MUST be registered BEFORE `GET /:channelId/messages/:messageId`. Hono's
// router matches in registration order when paths overlap with a parameter
// segment: declaring `/:messageId` first makes Hono try it first, and the
// `snowflakeSchema` validator rejects the literal string "search" with a
// 400, leaving this route unreachable. Keeping the static-segment route
// above the param-segment route is the fix; do not reorder.

/**
 * Full-text search messages within a channel. Anyone with VIEW_CHANNEL +
 * READ_MESSAGE_HISTORY can search; same gate as listing the message history.
 *
 * Query params:
 *   q       - search string (websearch syntax: bare keywords + "quoted")
 *   limit   - 1..100, default 50
 *
 * Returns the same Message shape as `GET /channels/:cid/messages` so the
 * client can reuse its message-rendering code without a separate
 * SearchResult type.
 */
messagesRouter.get(
  '/:channelId/messages/search',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate(
    'query',
    z.object({
      // q allowed empty when filters are present (e.g. "every message
      // from @alice"). Server enforces the "must have at least
      // SOMETHING" rule by returning [] for the no-keyword no-filter
      // case via searchMessages itself.
      q: z.string().max(200).optional().default(''),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      author_id: snowflakeSchema.optional(),
      before: snowflakeSchema.optional(),
      after: snowflakeSchema.optional(),
    }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const { q, limit, author_id, before, after } = c.req.valid('query');
    const ctx = await loadChannelContext(channelId, callerId);
    if (!ctx.isDM && ctx.channelPerms !== null) {
      if (!hasPermission(ctx.channelPerms, Permissions.VIEW_CHANNEL)) {
        throw errors.notFound('Channel');
      }
      if (!hasPermission(ctx.channelPerms, Permissions.READ_MESSAGE_HISTORY)) {
        throw errors.missingPermissions(['READ_MESSAGE_HISTORY']);
      }
    }
    const rows = await messages.searchMessages(channelId, q, limit, {
      authorId: author_id ? BigInt(author_id) : undefined,
      before: before ? BigInt(before) : undefined,
      after: after ? BigInt(after) : undefined,
    });
    const hydrated = await messages.hydrateMessages(rows, callerId);
    return c.json({ messages: hydrated });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// GET /:channelId/messages/:messageId
// ═══════════════════════════════════════════════════════════════════════════

messagesRouter.get(
  '/:channelId/messages/:messageId',
  validate('param', z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);

    const ctx = await loadChannelContext(channelId, userId);
    if (!ctx.isDM && ctx.channelPerms !== null) {
      if (!hasPermission(ctx.channelPerms, Permissions.READ_MESSAGE_HISTORY)) {
        throw errors.missingPermissions(['READ_MESSAGE_HISTORY']);
      }
    }

    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');

    // These three hydration queries are independent — run them in parallel
    // instead of serially (3 round-trips → 1).
    const [author, attachmentMap, reactionAgg, ownExpiryVisible] = await Promise.all([
      m.authorId ? loadUser(m.authorId) : Promise.resolve(null),
      messages.loadAttachments([m.id]),
      reactions.aggregateReactions(m.id),
      // Only consulted for the requester's own message (see withExpiresAt).
      m.authorId === userId ? ownExpiryVisibleInDm(ctx, userId) : Promise.resolve(false),
    ]);

    return c.json({
      message: withExpiresAt(
        toMessage({
          message: m,
          author,
          attachments: attachmentMap.get(m.id) ?? [],
          reactions: reactionAgg,
          selfId: userId,
        }),
        m,
        userId,
        ownExpiryVisible,
      ),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:channelId/messages/:messageId
// ═══════════════════════════════════════════════════════════════════════════

const editMessageSchema = z.object({ content: messageContentSchema });

messagesRouter.patch(
  '/:channelId/messages/:messageId',
  validate('param', z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema })),
  validate('json', editMessageSchema),
  async (c) => {
    const userId = requireUserId(c);
    // Instance mute (staff action): no edit while muted. See services/instanceMutes.
    await assertNotInstanceMuted(userId);
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);

    const ctx = await loadChannelContext(channelId, userId);

    const existing = await messages.getMessage(channelId, messageId);
    if (!existing) throw errors.notFound('Message');
    // Editing is author-only — even MANAGE_MESSAGES doesn't let you put words
    // in someone else's mouth. Mods can delete others' messages, not edit them.
    if (existing.authorId !== userId) {
      throw errors.forbidden('You can only edit your own messages');
    }
    // System rows (call records, the disappearing-timer notice…) carry their
    // author for attribution only — they're not the author's words. Installed
    // apps still offer Edit on any row you authored.
    if (existing.type.startsWith('system_')) {
      throw errors.forbidden("System messages can't be edited");
    }
    // Edits are normally only allowed within a short grace window after posting.
    // A moderator (MANAGE_MESSAGES) may edit their OWN message at any time — the
    // author-only check above still stands, so this only lifts the clock for the
    // mod's own posts and never lets them rewrite another user's message.
    const canManageMessages =
      !ctx.isDM &&
      ctx.channelPerms !== null &&
      hasPermission(ctx.channelPerms, Permissions.MANAGE_MESSAGES);
    if (
      !canManageMessages &&
      Date.now() - existing.createdAt.getTime() > MESSAGE_MUTATE_WINDOW_MS
    ) {
      throw errors.forbidden('Messages can only be edited within a minute of posting');
    }
    // Participation gates (onboarding, timeout, supervision) — a timed-out
    // or messaging-restricted user could otherwise edit an old message into
    // new content, bypassing the send-message gate. Same check as
    // send/react. Bypassed for DMs (no guild context).
    if (ctx.channel.guildId) {
      await enforceGuildParticipationGates(ctx.channel.guildId, userId);
      // Content moderation — same banned-words + automod gate as send, so an
      // edit can't slip banned/blocked content past the filter within the
      // mutate window. (Guild plaintext only; DMs/E2EE are never inspected.)
      await enforceGuildContentModeration({
        guildId: ctx.channel.guildId,
        channelId,
        userId,
        content: c.req.valid('json').content,
      });
    }
    // Supervised-pair plaintext invariant, same as send: without this a
    // supervised minor (or their peer) could post plaintext and edit it into
    // ciphertext the guardian can't read within the mutate window.
    if (
      ctx.isDM &&
      ctx.channel.type === 'dm' &&
      E2EE_CIPHERTEXT_RE.test(c.req.valid('json').content)
    ) {
      const other = await dms.getOtherRecipient(channelId, userId);
      if (other !== null && !(await supervision.isE2eeAllowedBetween(userId, other))) {
        throw new AppError(
          'FORBIDDEN',
          'Encrypted messages are unavailable while this conversation is supervised.',
          { supervisionRestricted: 'e2ee' },
        );
      }
    }

    const allowEveryone = ctx.isDM
      ? true
      : ctx.channelPerms !== null && hasPermission(ctx.channelPerms, Permissions.MENTION_EVERYONE);

    const result = await messages.editMessage({
      messageId,
      content: c.req.valid('json').content,
      guildId: ctx.channel.guildId ?? null,
      channelId,
      allowEveryoneMention: allowEveryone,
    });

    const author = await loadUser(userId);
    const attachmentMap = await messages.loadAttachments([result.message.id]);
    // Re-resolve any attached sticker so the edit broadcast carries
    // the same sticker the original create did. The author can edit
    // text without affecting the sticker; the DTO needs to keep it
    // visible. (Edits don't currently allow swapping stickers — the
    // route enforces content-only edits.)
    let editStickerDTO: StickerDTO | null = null;
    if (result.message.stickerId) {
      const sr = await stickers.getSticker(result.message.stickerId);
      if (sr) editStickerDTO = toSticker(sr);
    }

    // Same story for poll + forward-source: edits are content-only,
    // so the poll attached to this message (if any) and the forward
    // source it points at don't change. But the MESSAGE_UPDATE wire
    // shape REPLACES the whole bubble on the client side, so omitting
    // these fields would null them out in the client's state and
    // erase the poll / forward UI. Re-hydrate both for the broadcast.
    let editPollDTO: PollDTO | null = null;
    const pollMap = await polls.loadPollsForMessages([result.message.id], userId);
    const pollEntry = pollMap.get(result.message.id);
    if (pollEntry) editPollDTO = toPoll(pollEntry);

    let editForwardDTO: ForwardSourceDTO | null = null;
    if (result.message.forwardedFromMessageId) {
      const sources = await messages.loadForwardSources([
        result.message.forwardedFromMessageId,
      ]);
      const sm = sources.messages.get(result.message.forwardedFromMessageId) ?? null;
      editForwardDTO = toForwardSource({
        sourceMessageId: result.message.forwardedFromMessageId,
        sourceMessage: sm,
        sourceAuthor: sm?.authorId ? sources.authors.get(sm.authorId) ?? null : null,
        sourceChannel: sm ? sources.channels.get(sm.channelId) ?? null : null,
        sourceAttachments:
          sources.attachments.get(result.message.forwardedFromMessageId) ?? [],
      });
    }

    const editReactionAgg = await reactions.aggregateReactions(result.message.id);
    const editBaseArgs = {
      message: result.message,
      author,
      attachments: attachmentMap.get(result.message.id) ?? [],
      reactions: editReactionAgg,
      mentionedUserIds: result.mentionedUserIds,
      mentionedRoleIds: result.mentionedRoleIds,
      sticker: editStickerDTO,
      forwardedFrom: editForwardDTO,
    };
    // The HTTP response is for the EDITOR, so it carries their own
    // myVotes / reactions[].me. The gateway broadcast goes to every
    // channel member and must carry NO per-recipient state — sending
    // the editor's ballot/highlights as everyone's would both corrupt
    // each recipient's UI and reveal the editor's poll votes.
    const messageDTO = toMessage({ ...editBaseArgs, poll: editPollDTO, selfId: userId });
    const broadcastDTO = toMessage({
      ...editBaseArgs,
      poll: editPollDTO ? { ...editPollDTO, myVotes: [] } : null,
    });

    dispatch.messageUpdate({
      messageDTO: broadcastDTO,
      channelId,
      guildId: ctx.channel.guildId ?? null,
    });

    // Parental controls: the same watch-word scan as send, so a flagged word
    // edited in after posting still raises a flag. previousContent keeps a
    // word that was already flagged on the original from being flagged twice.
    void supervision
      .scanMessageForFlags({
        messageId: result.message.id,
        channelId,
        channelType: ctx.channel.type,
        authorId: userId,
        content: c.req.valid('json').content,
        previousContent: existing.content ?? '',
      })
      .catch(() => undefined);

    // Re-resolve embeds for the new content. Without this the
    // message keeps the embeds resolved at original-send time —
    // editing "look at https://old.com" to "look at https://new.com"
    // would leave the old preview attached, and removing the URL
    // entirely would leave a stale preview pointing nowhere. The
    // resolver handles the no-URLs case (writes []) so removing
    // links correctly clears the previews too. Fire-and-forget;
    // a follow-up MESSAGE_UPDATE goes out 100-2000ms later with
    // the new embeds. We resolve even on empty content because
    // the user may have just deleted the only URL, in which case
    // we need to publish the cleared list. Without EMBED_LINKS the
    // resolver gets no content, which just clears any previews.
    void embeds.resolveAndPersistEmbeds({
      messageId: result.message.id,
      channelId,
      guildId: ctx.channel.guildId ?? null,
      content: canEmbedLinks(ctx) ? c.req.valid('json').content : '',
    });

    return c.json({ message: messageDTO });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /:channelId/messages/:messageId
// ═══════════════════════════════════════════════════════════════════════════

messagesRouter.delete(
  '/:channelId/messages/:messageId',
  validate('param', z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);

    const ctx = await loadChannelContext(channelId, userId);

    const existing = await messages.getMessage(channelId, messageId);
    if (!existing) throw errors.notFound('Message');
    // The disappearing-timer notice is how the other person learns the timer
    // changed — on installed apps that predate the header badge it is the
    // only sign. Its author (the changer) can't take it back: those apps
    // offer Delete on any row you authored, within the minute. Other system
    // rows keep today's rule (a caller may delete their own call record).
    if (existing.type === 'system_disappearing') {
      throw errors.forbidden("The disappearing-messages notice can't be deleted");
    }

    const isOwn = existing.authorId === userId;
    if (!isOwn) {
      // Need MANAGE_MESSAGES to delete someone else's message.
      if (ctx.isDM || ctx.channelPerms === null) {
        throw errors.forbidden('You can only delete your own messages in a DM');
      }
      if (!hasPermission(ctx.channelPerms, Permissions.MANAGE_MESSAGES)) {
        throw errors.missingPermissions(['MANAGE_MESSAGES']);
      }
    }
    // Authors can only delete their OWN message within a short grace window;
    // a moderator (MANAGE_MESSAGES, handled above) can still delete anytime.
    if (isOwn && Date.now() - existing.createdAt.getTime() > MESSAGE_MUTATE_WINDOW_MS) {
      throw errors.forbidden('Messages can only be deleted within a minute of posting');
    }

    await messages.deleteMessage(messageId);
    dispatch.messageDelete({
      messageId,
      channelId,
      guildId: ctx.channel.guildId ?? null,
    });
    return c.json({ ok: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// POST /:channelId/messages/purge
// ───────────────────────────────────────────────────────────────────────────
// Soft-delete every message in a channel. Restricted to MANAGE_MESSAGES
// (which already covers "delete someone else's message"). DM channels
// reject — purge is a moderation tool, not a UX shortcut, and DMs have
// no moderator concept.
//
// The service caps each call to 1000 messages; the response includes
// `done: boolean` so the client can loop until completion. Each batch
// dispatches MESSAGE_DELETE_BULK for connected clients to clear the
// purged ids from local state without a full refetch.

messagesRouter.post(
  '/:channelId/messages/purge',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { channelId: cid } = c.req.valid('param');
    const channelId = BigInt(cid);

    const ctx = await loadChannelContext(channelId, userId);
    if (ctx.isDM || ctx.channelPerms === null) {
      throw errors.forbidden('Purge is unavailable in this channel');
    }
    if (!hasPermission(ctx.channelPerms, Permissions.MANAGE_MESSAGES)) {
      throw errors.missingPermissions(['MANAGE_MESSAGES']);
    }

    const ids = await messages.purgeChannel(channelId);
    if (ids.length > 0) {
      dispatch.messageDeleteBulk({
        messageIds: ids,
        channelId,
        guildId: ctx.channel.guildId ?? null,
      });
      // Audit-log the action so server admins can see who nuked
      // the channel. Body carries the count, not individual ids,
      // because storing 1k+ ids per audit row is wasteful and the
      // UI never needs them — "purged 847 messages" is enough.
      try {
        await writeAudit({
          guildId: ctx.channel.guildId ?? 0n,
          actorId: userId,
          action: 'channel.purge',
          targetType: 'channel',
          targetId: channelId,
          changes: { count: ids.length },
        });
      } catch {
        // Audit failure shouldn't fail the purge.
      }

      // Refresh the channel row on every client so the sidebar's
      // last-message preview and the unread dot reconcile with the
      // last_message_id the purge just recomputed (rolled back to the
      // newest surviving message, or NULL for a now-empty channel).
      // Without this the unread indicator keeps chasing a purged id that
      // can never be marked read — the channel reads as "not purged"
      // even though the messages are gone. Guild channels only (DMs are
      // rejected above), so guildId is always set here.
      if (ctx.channel.guildId) {
        const refreshed = await channelsSvc.getChannel(channelId);
        if (refreshed) {
          dispatch.channelUpdate({
            channelDTO: toChannel(refreshed),
            channelId,
            guildId: ctx.channel.guildId,
          });
        }
      }
    }
    return c.json({ deleted: ids.length, done: ids.length < 1000 });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Reactions
// ═══════════════════════════════════════════════════════════════════════════
//
// PUT /:channelId/messages/:messageId/reactions/:emoji/@me  — add own
// DELETE same path                                          — remove own
// DELETE /...:emoji/:userId                                 — remove someone else's (mod)
// DELETE /...:emoji                                         — clear emoji (mod)
// DELETE /.../reactions                                     — clear all (mod)
// GET    /...:emoji                                         — list reactors

messagesRouter.put(
  '/:channelId/messages/:messageId/reactions/:emoji/@me',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      messageId: snowflakeSchema,
      emoji: emojiSchema,
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    // Instance mute (staff action): no react while muted. See services/instanceMutes.
    await assertNotInstanceMuted(userId);
    const { channelId: cid, messageId: mid, emoji } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, userId);

    if (!ctx.isDM && ctx.channelPerms !== null) {
      if (!hasPermission(ctx.channelPerms, Permissions.ADD_REACTIONS)) {
        throw errors.missingPermissions(['ADD_REACTIONS']);
      }
      // Reactions are participation too — apply the SAME pending/timeout/
      // supervision(allowMessaging) gate as sending + poll-voting. Previously
      // this inlined only pending + timeout, so a supervised child with
      // messaging turned off could still react. Guild-only (DMs have no
      // membership/timeout/supervision-messaging state).
      if (ctx.channel.guildId) {
        await enforceGuildParticipationGates(ctx.channel.guildId, userId);
      }
    }
    // Verify the message belongs to this channel — prevents reaction-on-other-channel attacks.
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');

    const added = await reactions.addReaction(messageId, userId, decodeURIComponent(emoji));
    if (added) {
      dispatch.reactionAdd({
        messageId,
        channelId,
        guildId: ctx.channel.guildId ?? null,
        userId,
        emoji: decodeURIComponent(emoji),
      });

      // Notify the message author that someone reacted (best-effort, fire and
      // forget). PUSH ONLY — the service worker / iOS willPresent suppress it
      // when the author is focused on this channel, so it never doubles the
      // reaction they can already see live. Skips your own reactions, respects
      // the author's `notifyReactions` toggle and channel/guild mute level, and
      // is throttled per (author, message) so a burst of reactions pings once.
      if (m.authorId !== null && m.authorId !== userId) {
        const author = m.authorId;
        void (async () => {
          try {
            if (!(await reactionNotifyLimiter.consume(`${author}:${messageId}`)).ok) return;
            const [reactorRow, authorRow] = await Promise.all([
              db
                .select({ displayName: schema.users.displayName, username: schema.users.username })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .limit(1),
              db
                .select({ notifyReactions: schema.users.notifyReactions })
                .from(schema.users)
                .where(eq(schema.users.id, author))
                .limit(1),
            ]);
            if (!authorRow[0]?.notifyReactions) return;
            const { resolveLevelsBulk } = await import('../services/notifications');
            const levels = await resolveLevelsBulk([author], channelId, ctx.channel.guildId ?? null);
            if (levels.get(author.toString()) === 'nothing') return;
            const reactorName =
              reactorRow[0]?.displayName ?? reactorRow[0]?.username ?? 'Someone';
            const emojiStr = decodeURIComponent(emoji);
            const url = ctx.channel.guildId
              ? `/channels/${ctx.channel.guildId.toString()}/${channelId.toString()}`
              : `/channels/@me/${channelId.toString()}`;
            await sendToUser(author, {
              title: reactorName,
              body: `reacted ${emojiStr} to your message`,
              url,
              // Replace a prior reaction ping for the same message rather than
              // stacking a new banner per reactor.
              tag: `reaction-${messageId.toString()}`,
              data: {
                kind: 'reaction',
                channelId: channelId.toString(),
                messageId: messageId.toString(),
                emoji: emojiStr,
              },
            }).catch(() => undefined);
          } catch {
            /* best-effort: never let a notification failure break the reaction */
          }
        })();
      }
      // Reaction-role hook. If this (message, emoji) is mapped to
      // a role in the reaction_roles table, grant that role to the
      // reacting user. Soft-fails on every error path — a bad
      // mapping or already-assigned role shouldn't break the
      // reaction itself.
      if (ctx.channel.guildId) {
        try {
          const roleId = await reactionRolesSvc.lookupReactionRole(
            messageId,
            decodeURIComponent(emoji),
          );
          if (roleId) {
            await membersSvc.addMemberRole({
              guildId: ctx.channel.guildId,
              userId,
              roleId,
              actorId: userId,
            });
            // Refresh the user's gateway viewable-channel cache so
            // any channels unlocked by the new role appear in their
            // sidebar without requiring a reconnect. The explicit
            // PATCH /guilds/:guildId/members/:userId route does
            // the same after a role change; reaction-role grants
            // need it too.
            await dispatch.applyMemberRoleChange({
              userId,
              guildId: ctx.channel.guildId,
            });
          }
        } catch {
          // ignored — see service comment for rationale
        }
      }
    }
    return c.json({ ok: true });
  },
);

messagesRouter.delete(
  '/:channelId/messages/:messageId/reactions/:emoji/@me',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      messageId: snowflakeSchema,
      emoji: emojiSchema,
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { channelId: cid, messageId: mid, emoji } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, userId);
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');
    const removed = await reactions.removeOwnReaction(messageId, userId, decodeURIComponent(emoji));
    if (removed) {
      dispatch.reactionRemove({
        messageId,
        channelId,
        guildId: ctx.channel.guildId ?? null,
        userId,
        emoji: decodeURIComponent(emoji),
      });
      // Reaction-role unwind: if the emoji was role-mapped, revoke
      // the role. Same soft-fail posture as the add path.
      if (ctx.channel.guildId) {
        try {
          const roleId = await reactionRolesSvc.lookupReactionRole(
            messageId,
            decodeURIComponent(emoji),
          );
          if (roleId) {
            await membersSvc.removeMemberRole({
              guildId: ctx.channel.guildId,
              userId,
              roleId,
              actorId: userId,
            });
            // Refresh the user's gateway viewable-channel cache so
            // any channels the revoked role had unlocked drop out
            // of their sidebar without requiring a reconnect.
            // Without this, the user keeps seeing channels they
            // can no longer post in until they refresh.
            await dispatch.applyMemberRoleChange({
              userId,
              guildId: ctx.channel.guildId,
            });
          }
        } catch {
          // ignored
        }
      }
    }
    return c.json({ ok: true });
  },
);

messagesRouter.delete(
  '/:channelId/messages/:messageId/reactions/:emoji/:userId',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      messageId: snowflakeSchema,
      emoji: emojiSchema,
      userId: snowflakeSchema,
    }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const { channelId: cid, messageId: mid, emoji, userId: uid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null) {
      throw errors.forbidden('Cannot moderate reactions in a DM');
    }
    await assertChannelPermission(channelId, callerId, [Permissions.MANAGE_MESSAGES]);
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');
    await reactions.removeUserReaction(messageId, BigInt(uid), decodeURIComponent(emoji));
    dispatch.reactionRemove({
      messageId,
      channelId,
      guildId: ctx.channel.guildId ?? null,
      userId: BigInt(uid),
      emoji: decodeURIComponent(emoji),
    });
    return c.json({ ok: true });
  },
);

messagesRouter.delete(
  '/:channelId/messages/:messageId/reactions/:emoji',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      messageId: snowflakeSchema,
      emoji: emojiSchema,
    }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const { channelId: cid, messageId: mid, emoji } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null) {
      throw errors.forbidden('Cannot moderate reactions in a DM');
    }
    await assertChannelPermission(channelId, callerId, [Permissions.MANAGE_MESSAGES]);
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');
    await reactions.clearEmoji(messageId, decodeURIComponent(emoji));
    dispatch.reactionRemoveAll({
      messageId,
      channelId,
      guildId: ctx.channel.guildId ?? null,
      emoji: decodeURIComponent(emoji),
    });
    return c.json({ ok: true });
  },
);

messagesRouter.delete(
  '/:channelId/messages/:messageId/reactions',
  validate('param', z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema })),
  async (c) => {
    const callerId = requireUserId(c);
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null) {
      throw errors.forbidden('Cannot moderate reactions in a DM');
    }
    await assertChannelPermission(channelId, callerId, [Permissions.MANAGE_MESSAGES]);
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');
    await reactions.clearAll(messageId);
    dispatch.reactionRemoveAll({
      messageId,
      channelId,
      guildId: ctx.channel.guildId ?? null,
    });
    return c.json({ ok: true });
  },
);

messagesRouter.get(
  '/:channelId/messages/:messageId/reactions/:emoji',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      messageId: snowflakeSchema,
      emoji: emojiSchema,
    }),
  ),
  validate('query', z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), after: snowflakeSchema.optional() })),
  async (c) => {
    const callerId = requireUserId(c);
    const { channelId: cid, messageId: mid, emoji } = c.req.valid('param');
    const q = c.req.valid('query');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    await loadChannelContext(channelId, callerId);
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');

    const userIds = await reactions.listReactingUsers(messageId, decodeURIComponent(emoji), {
      limit: q.limit ?? 25,
      after: q.after ? BigInt(q.after) : undefined,
    });
    if (userIds.length === 0) return c.json({ users: [] });

    // Project only the columns toPublicUser reads — avoid SELECT *'ing the wide
    // users row (incl. secret columns) for up to 100 reactors per call.
    const userRows = await db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        bannerUrl: schema.users.bannerUrl,
        bio: schema.users.bio,
        avatarDecoration: schema.users.avatarDecoration,
        status: schema.users.status,
        customStatus: schema.users.customStatus,
        customStatusEmoji: schema.users.customStatusEmoji,
        customStatusExpiresAt: schema.users.customStatusExpiresAt,
        publicKey: schema.users.publicKey,
        createdAt: schema.users.createdAt,
        isBot: schema.users.isBot,
        tagLabel: schema.users.tagLabel,
        tagColor: schema.users.tagColor,
        isAdmin: schema.users.isAdmin,
        isModerator: schema.users.isModerator,
        staffColor: schema.users.staffColor,
        staffGlow: schema.users.staffGlow,
      })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds));
    return c.json({
      users: userRows.map((u) => toPublicUser(u as typeof schema.users.$inferSelect)),
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// POST /:channelId/messages/:messageId/ack
// ═══════════════════════════════════════════════════════════════════════════
//
// Mark a message as the user's read marker for the channel. The service
// rejects backwards moves (older message id than the current marker is a
// no-op for last_message_id, but always resets mention_count).
//
// We dispatch MESSAGE_ACK to the user's audience so other tabs / devices
// of the same user reconcile their unread badges in real time.

messagesRouter.post(
  '/:channelId/messages/:messageId/ack',
  // Param validation — without it, a malformed id makes the raw
  // BigInt() below throw and the request 500s instead of 400ing
  // like every sibling route.
  validate('param', z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema })),
  async (c) => {
  const userId = requireUserId(c);
  const channelId = BigInt(c.req.param('channelId'));
  const messageId = BigInt(c.req.param('messageId'));

  // loadChannelContext throws NOT_FOUND for channels the caller can't see,
  // including non-recipient DMs — same auth gate as message read/send.
  const ctx = await loadChannelContext(channelId, userId);

  const result = await readStates.ack(userId, channelId, messageId);
  const dto = toReadState({
    channelId,
    lastMessageId: result.lastMessageId,
    mentionCount: result.mentionCount,
  });
  dispatch.channelAck({ userId, readState: dto });

  // Disappearing messages: reading starts the clock. Every message up to the
  // acked one that was sent with a timer, isn't counting down yet and isn't
  // the reader's own gets expires_at = now() + its timer — in 1:1 AND group
  // DMs (the first reader starts the one shared clock), whatever the reader's
  // receipts toggle; MESSAGE_EXPIRY goes to whoever may know (see the
  // helper). Awaited so a refetch right after the ack already carries
  // expiresAt; a failure is logged and never fails the ack.
  await dms.startDisappearingTimersAndNotify({
    channelId,
    channelType: ctx.channel.type,
    readerId: userId,
    upToMessageId: messageId,
  });

  // 1:1 DM read-receipt advance. Acking through a message implicitly
  // means the user viewed it — without this stamp the receipt would
  // stick at "Delivered" until the next listMessages call (page
  // refresh), which is exactly the staleness the user reported.
  // The bulk variant covers ALL unviewed messages up through the
  // acked id in a single UPDATE; group dispatched MESSAGE_VIEWED
  // events per author so each sender's UI flips Delivered → Read.
  // Fired as fire-and-forget — a stamp failure doesn't roll back
  // the ack response, which is what the read-state UI actually
  // depends on.
  if (ctx.channel.type === 'dm') {
    void (async () => {
      try {
        const { stamped, viewedAt, viewerReceiptsEnabled } =
          await dms.markMessagesViewedUpTo(channelId, userId, messageId);
        if (stamped.length === 0 || !viewerReceiptsEnabled) return;
        const byAuthor = new Map<bigint, bigint[]>();
        for (const s of stamped) {
          const list = byAuthor.get(s.authorId);
          if (list) list.push(s.messageId);
          else byAuthor.set(s.authorId, [s.messageId]);
        }
        for (const [authorId, messageIds] of byAuthor) {
          dispatch.messageViewed({
            authorId,
            channelId,
            messageIds,
            viewedAt,
          });
        }
      } catch {
        // Best-effort. The next listMessages call from this user
        // will retry any leftover unstamped messages.
      }
    })();
  }

  return c.json({ readState: dto });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /users/@me/read-states  (registered separately in users router; this
// stub is documentation: the actual handler is in routes/users.ts)
// ═══════════════════════════════════════════════════════════════════════════

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Disappearing messages: add `expiresAt` to a per-requester REST DTO (message
 * list, single GET — never a broadcast; toMessage leaves it out). Present for
 * anyone but the author; for the author only when `ownExpiryVisible` — a 1:1
 * DM whose other recipient has read receipts on — because expiresAt minus
 * the timer is the reader's read time. Hidden means the key is absent, never
 * a null that would itself say "not read yet".
 */
function withExpiresAt<T extends object>(
  dto: T,
  m: Pick<schema.Message, 'authorId' | 'expiresAt'>,
  requesterId: bigint,
  ownExpiryVisible: boolean,
): T | (T & { expiresAt: string | null }) {
  if (m.authorId === requesterId && !ownExpiryVisible) return dto;
  return { ...dto, expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null };
}

/** ownExpiryVisible for a single message: the requester's 1:1 DM peer has
 *  read receipts on. Group DMs never show the author the deadline. */
async function ownExpiryVisibleInDm(ctx: ChannelContext, requesterId: bigint): Promise<boolean> {
  if (ctx.channel.type !== 'dm') return false;
  const other = await dms.getOtherRecipient(ctx.channel.id, requesterId);
  if (other === null) return false;
  const [row] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, other))
    .limit(1);
  return row?.enabled === true;
}

async function loadUser(userId: bigint): Promise<User | null> {
  const r = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .limit(1);
  return r[0] ?? null;
}

function groupBy<T, V>(rows: T[], key: (r: T) => bigint, value: (r: T) => V): Map<bigint, V[]> {
  const map = new Map<bigint, V[]>();
  for (const r of rows) {
    const k = key(r);
    const v = value(r);
    const list = map.get(k);
    if (list) list.push(v);
    else map.set(k, [v]);
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pinned messages
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List all pinned messages in a channel. Anyone who can VIEW_CHANNEL can
 * read the pin set — pinning is a public moderator action, not a hidden
 * one. Capped at 50 (the underlying service caps at the same number).
 */
messagesRouter.get(
  '/:channelId/pins',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const callerId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const ctx = await loadChannelContext(channelId, callerId);
    if (!ctx.isDM && ctx.channelPerms !== null) {
      if (!hasPermission(ctx.channelPerms, Permissions.VIEW_CHANNEL)) {
        throw errors.notFound('Channel');
      }
    }
    const rows = await messages.listPinned(channelId);
    const hydrated = await messages.hydrateMessages(rows, callerId);
    return c.json({ messages: hydrated });
  },
);

/**
 * Pin a message. Requires MANAGE_MESSAGES on the channel — same gate as
 * deleting other people's messages, since pinning is a moderation action.
 * Idempotent on already-pinned messages.
 */
messagesRouter.put(
  '/:channelId/pins/:messageId',
  validate(
    'param',
    z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null) {
      // DMs don't have permissions — pinning would need a separate model.
      // Out of scope for v1; reject cleanly.
      throw errors.forbidden('Cannot pin messages in a DM');
    }
    await assertChannelPermission(channelId, callerId, [Permissions.MANAGE_MESSAGES]);

    const fresh = await messages.setPinned(channelId, messageId, true);
    // The HTTP response is for the CALLER (their own reactions[].me / poll
    // myVotes). The gateway broadcast goes to the whole channel and MUST carry
    // no per-recipient self-state, or every recipient would see the pinner's
    // ballot + reaction highlights as their own. selfId=0n (a snowflake no user
    // holds) yields a clean no-self DTO — same split the edit path makes.
    const [messageDTO] = await messages.hydrateMessages([fresh], callerId);
    const [broadcastDTO] = await messages.hydrateMessages([fresh], 0n);
    dispatch.messageUpdate({
      messageDTO: broadcastDTO,
      channelId,
      guildId: ctx.channel.guildId ?? null,
    });
    dispatch.channelPinsUpdate({
      channelId,
      guildId: ctx.channel.guildId ?? null,
      lastPinTimestamp: new Date().toISOString(),
    });
    return c.json({ message: messageDTO });
  },
);

/**
 * Unpin a message. Same permission as pin — keep the pair symmetric.
 */
messagesRouter.delete(
  '/:channelId/pins/:messageId',
  validate(
    'param',
    z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema }),
  ),
  async (c) => {
    const callerId = requireUserId(c);
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null) {
      throw errors.forbidden('Cannot pin messages in a DM');
    }
    await assertChannelPermission(channelId, callerId, [Permissions.MANAGE_MESSAGES]);

    const fresh = await messages.setPinned(channelId, messageId, false);
    // Broadcast a no-self DTO (selfId=0n) so the unpinner's ballot/reaction
    // highlights aren't fanned out as everyone's. See the pin handler above.
    const [broadcastDTO] = await messages.hydrateMessages([fresh], 0n);
    dispatch.messageUpdate({
      messageDTO: broadcastDTO,
      channelId,
      guildId: ctx.channel.guildId ?? null,
    });
    dispatch.channelPinsUpdate({
      channelId,
      guildId: ctx.channel.guildId ?? null,
      lastPinTimestamp: new Date().toISOString(),
    });
    return c.json({ ok: true });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Threads
// ═══════════════════════════════════════════════════════════════════════════

const createThreadSchema = z.object({
  /** User-set thread name. Falls back to a snippet of the parent message
      if not supplied. Max 100 chars (server enforces). */
  name: z.string().min(1).max(100).optional(),
});

/**
 * Create a thread anchored to a specific message in a guild text channel.
 * Threads are channels with `type='public_thread'` and `parentMessageId`
 * pointing at the originating message.
 *
 * Permissions: requires VIEW_CHANNEL + SEND_MESSAGES on the parent channel
 * (anyone who can post here can spawn a thread). MANAGE_THREADS isn't
 * needed to create one; it gates archiving/resolving other people's
 * threads (see assertCanToggleThreadState in routes/channels.ts). Starting
 * a thread is a send for moderation purposes: the same participation gates,
 * spam throttle, and banned words + automod (over a user-supplied name) apply.
 *
 * Idempotent: a second call with the same parentMessageId returns the
 * existing thread row instead of creating a duplicate.
 */
messagesRouter.post(
  '/:channelId/messages/:messageId/threads',
  validate(
    'param',
    z.object({ channelId: snowflakeSchema, messageId: snowflakeSchema }),
  ),
  validate('json', createThreadSchema),
  async (c) => {
    const callerId = requireUserId(c);
    // Instance mute (staff action): no thread while muted. See services/instanceMutes.
    await assertNotInstanceMuted(callerId);
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null || !ctx.channel.guildId) {
      throw errors.forbidden('Threads can only be started in guild channels');
    }
    if (ctx.channel.type !== 'guild_text') {
      // Voice/category channels can't host threads. Could relax later
      // for forum-style channels but that's a separate feature.
      throw errors.badRequest('Threads can only be started under text channels');
    }
    if (!hasPermission(ctx.channelPerms, Permissions.VIEW_CHANNEL)) {
      throw errors.notFound('Channel');
    }
    const body = c.req.valid('json');
    // SEND_MESSAGES, onboarding, timeout, supervision, spam, and banned
    // words + automod over the name the caller typed — the same gates, in
    // the same order, as a live send. No slowmode: it measures time since
    // the caller's last message here, and starting a thread posts none (at
    // most one thread per message, so messages already bound the rate). The
    // fallback name below is the anchor message's own text, which passed
    // its author's send gates; it isn't the caller's words to moderate. The
    // name goes in as extraText, not content: it is not stored as a message,
    // so it must not trip repeat_message by echoing one of the caller's.
    await enforceGuildSendGates({
      channel: ctx.channel,
      channelPerms: ctx.channelPerms,
      userId: callerId,
      content: '',
      extraText: body.name,
      enforceSlowmode: false,
    });

    // Verify the anchor message exists and lives in this channel.
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');

    // Default thread name: first ~50 chars of the message content,
    // collapsed whitespace. If the message was attachments-only, fall
    // back to a generic label.
    const fallback =
      m.content
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50) || 'New thread';
    const name = body.name ?? fallback;

    const thread = await threads.createThread({
      parentChannelId: channelId,
      parentMessageId: messageId,
      guildId: ctx.channel.guildId,
      name,
    });

    const channelDTO = toChannel(thread);
    // Channel creation uses the same permission-transition fanout as
    // regular channel creates. Thread inherits parent perms; this
    // emits CHANNEL_CREATE to every connected member who can VIEW the
    // parent (and thus the thread). See the comment in dispatch.ts on
    // why we don't broadcast a guild-wide CHANNEL_CREATE here.
    await dispatch.applyGuildPermissionChange({ guildId: ctx.channel.guildId });

    return c.json({ channel: channelDTO }, 201);
  },
);

/**
 * Create a forum post — a thread under a `guild_forum` channel with an
 * initial message that serves as the post body. Distinct from the
 * message-anchored thread route above: forum posts are anchor-less
 * (their root content is the first message itself, not a separate
 * pre-existing message).
 *
 * Permissions: VIEW_CHANNEL + SEND_MESSAGES on the forum channel. Same
 * gates as posting a regular message — if you can post in the forum,
 * you can start a post — including onboarding, timeout, supervision, the
 * spam throttle, and banned words + automod over the title and content.
 * JSON only: a post carries no files, so ATTACH_FILES never applies.
 *
 * Body: { title, content }. Both required and trimmed; empty title is
 * rejected since posts need a label. Empty content is allowed only if
 * the caller is going to attach something downstream (matches the
 * regular message-creation rules), but for the v1 forum surface we
 * require content too to keep things simple.
 *
 * Idempotency: not idempotent. Two clicks of "Submit post" create two
 * posts. Forum posts are intentionally cheap to create (the whole point
 * of forums is many posts on the same topic).
 */
const createForumPostSchema = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1).max(MESSAGE_CONTENT_MAX_LENGTH),
  /** Optional auto-archive duration override. Server accepts only the
   *  canonical preset minutes (1h / 1d / 3d / 7d). When omitted, the
   *  service applies the default (3 days). */
  autoArchiveMinutes: z
    .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
    .optional(),
});

messagesRouter.post(
  '/:channelId/posts',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', createForumPostSchema),
  async (c) => {
    const callerId = requireUserId(c);
    // Instance mute (staff action): no forum post while muted. See services/instanceMutes.
    await assertNotInstanceMuted(callerId);
    const channelId = BigInt(c.req.valid('param').channelId);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null || !ctx.channel.guildId) {
      throw errors.forbidden('Forum posts can only be created in guild channels');
    }
    if (ctx.channel.type !== 'guild_forum') {
      throw errors.badRequest('Channel is not a forum');
    }
    if (!hasPermission(ctx.channelPerms, Permissions.VIEW_CHANNEL)) {
      throw errors.notFound('Channel');
    }
    const { title, content, autoArchiveMinutes } = c.req.valid('json');
    // The live send's gates, in its order: SEND_MESSAGES, onboarding,
    // timeout, supervision, slowmode, spam, banned words + automod (over the
    // body, then the title, which is shown as the post's name). Slow-mode
    // limits how often each user can create a new post (MANAGE_MESSAGES
    // bypasses it) and uses the forum-specific variant, because regular
    // slowmode keys on (channelId, authorId) for the forum row, which is
    // always empty (forums don't hold direct messages).
    await enforceGuildSendGates({
      channel: ctx.channel,
      channelPerms: ctx.channelPerms,
      userId: callerId,
      content,
      extraText: title,
      enforceSlowmode: 'forum_post',
    });

    // 1. Create the post (thread row).
    const post = await threads.createForumPost({
      forumChannelId: channelId,
      guildId: ctx.channel.guildId,
      title,
      autoArchiveMinutes,
    });
    // 2. Create the initial message inside the post. If THIS step fails
    //    we hard-delete the freshly-created thread row to avoid an
    //    orphan empty post. A proper transactional fix would put both
    //    inserts in a single tx, but createMessage already has its own
    //    internal transaction (mentions, read-state bumps, etc.) and
    //    nesting txs in postgres-js needs a refactor we're not doing
    //    this round. Best-effort cleanup is enough: the failure mode
    //    is rare (validation passed; only DB-level errors remain) and
    //    the worst we leak on a cleanup miss is one empty post row,
    //    which a mod can delete.
    let created;
    try {
      created = await messages.createMessage({
        channelId: post.id,
        authorId: callerId,
        content,
        guildId: ctx.channel.guildId,
        allowEveryoneMention: hasPermission(
          ctx.channelPerms,
          Permissions.MENTION_EVERYONE,
        ),
      });
    } catch (err) {
      // Best-effort cleanup. If THIS fails too, log and continue —
      // the user's original error still propagates upward unchanged.
      try {
        await channelsSvc.hardDeleteChannel(post.id);
      } catch (cleanupErr) {
        log.warn?.('forum-post cleanup failed after createMessage error', {
          channelId: post.id.toString(),
          err: (cleanupErr as Error).message,
        });
      }
      throw err;
    }
    // 3. Fanout. Channel-create reaches anyone who can VIEW the parent
    //    forum (and therefore the new post). The message-create then
    //    delivers the body into the new channel's message stream.
    await dispatch.applyGuildPermissionChange({ guildId: ctx.channel.guildId });

    const author = await loadUser(callerId);
    const attachmentRows = await messages.loadAttachments([created.message.id]);
    const messageDTO = toMessage({
      message: created.message,
      author,
      attachments: attachmentRows.get(created.message.id) ?? [],
      reactions: [],
      mentionedUserIds: created.mentionedUserIds,
      mentionedRoleIds: created.mentionedRoleIds,
      poll: null,
      sticker: null,
      forwardedFrom: null,
      selfId: callerId,
    });
    dispatch.messageCreate({
      messageDTO,
      channelId: post.id,
      guildId: ctx.channel.guildId,
    });

    return c.json({ post: toChannel(post), message: messageDTO }, 201);
  },
);

/**
 * List active + archived threads under a channel. Anyone who can VIEW
 * the parent channel can list its threads — reading the index is the
 * same gate as reading the parent's message history.
 */
messagesRouter.get(
  '/:channelId/threads',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const callerId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const ctx = await loadChannelContext(channelId, callerId);
    if (ctx.isDM || ctx.channelPerms === null) {
      throw errors.forbidden('Threads only exist in guild channels');
    }
    if (!hasPermission(ctx.channelPerms, Permissions.VIEW_CHANNEL)) {
      throw errors.notFound('Channel');
    }
    const rows = await threads.listThreadsForChannel(channelId);
    return c.json({ threads: rows.map((r) => toChannel(r)) });
  },
);

// shim for unused imports in possible future expansion
void MESSAGE_CONTENT_MAX_LENGTH;

// ═══════════════════════════════════════════════════════════════════════════
// Poll voting routes
// ═══════════════════════════════════════════════════════════════════════════
//
// Vote, retract a vote, end a poll early. All three rebuild the message
// DTO with refreshed tallies and broadcast a MESSAGE_UPDATE so connected
// clients see live vote counts. The MESSAGE_UPDATE replaces the bubble's
// poll block in place; React diffs on poll.options[*].voteCount.

async function broadcastPollUpdate(channelId: bigint, messageId: bigint) {
  // A deleted or disappeared message is never re-broadcast: clients upsert on
  // MESSAGE_UPDATE, so it would come back on screen.
  const messageRows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.id, messageId), isNull(schema.messages.deletedAt), messages.notExpired()))
    .limit(1);
  const m = messageRows[0];
  if (!m) return;
  // All the hydration below is independent — run it in parallel (this DTO fans
  // out to every channel member, so trimming ~7 sequential round-trips to one
  // batch matters). selfId is deliberately NOT passed to the poll loader: per-
  // recipient vote state can't live in one fan-out payload, so passing the
  // acting user would broadcast THEIR ballot as everyone's `myVotes`. Clients
  // keep their own selection locally; the broadcast only refreshes shared
  // tallies. Reaction aggregation uses the shared O(n) helper (was an O(n²) loop).
  const [author, attachmentMap, pollMap, reactionAgg, um, rm, channelRows] = await Promise.all([
    m.authorId ? loadUser(m.authorId) : Promise.resolve(null),
    messages.loadAttachments([messageId]),
    polls.loadPollsForMessages([messageId], null),
    reactions.aggregateReactions(messageId),
    db.select().from(schema.messageUserMentions).where(eq(schema.messageUserMentions.messageId, messageId)),
    db.select().from(schema.messageRoleMentions).where(eq(schema.messageRoleMentions.messageId, messageId)),
    db
      .select({ guildId: schema.channels.guildId })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1),
  ]);
  const pollEntry = pollMap.get(messageId);
  const guildId = channelRows[0]?.guildId ?? null;

  const messageDTO = toMessage({
    message: m,
    author,
    attachments: attachmentMap.get(messageId) ?? [],
    reactions: reactionAgg,
    mentionedUserIds: um.map((x) => x.userId),
    mentionedRoleIds: rm.map((x) => x.roleId),
    poll: pollEntry ? toPoll(pollEntry) : null,
    sticker: m.stickerId ? (await (async () => {
      const sr = await stickers.getSticker(m.stickerId!);
      return sr ? toSticker(sr) : null;
    })()) : null,
    // No selfId: reactions[].me must be false in a fan-out DTO for the
    // same reason myVotes must be empty — it's one payload for everyone.
  });
  dispatch.messageUpdate({ messageDTO, channelId, guildId });
}

messagesRouter.post(
  '/:channelId/polls/:pollId/options/:optionId/vote',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      pollId: snowflakeSchema,
      optionId: snowflakeSchema,
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    // Instance mute (staff action): no poll vote while muted. See services/instanceMutes.
    await assertNotInstanceMuted(userId);
    const params = c.req.valid('param');
    // Voting is participation — enforce the same onboarding/timeout/supervision
    // gates as send + react (polls.vote() only checks SEND_MESSAGES, which a
    // timed-out or restricted member still holds). loadChannelContext also
    // re-verifies VIEW_CHANNEL / DM-recipient before we do any work.
    const ctx = await loadChannelContext(BigInt(params.channelId), userId);
    if (!ctx.isDM && ctx.channel.guildId) {
      await enforceGuildParticipationGates(ctx.channel.guildId, userId);
    }
    const { channelId, messageId } = await polls.vote({
      pollId: BigInt(params.pollId),
      optionId: BigInt(params.optionId),
      userId,
    });
    await broadcastPollUpdate(channelId, messageId);
    return c.body(null, 204);
  },
);

messagesRouter.delete(
  '/:channelId/polls/:pollId/options/:optionId/vote',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      pollId: snowflakeSchema,
      optionId: snowflakeSchema,
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const params = c.req.valid('param');
    const { channelId, messageId } = await polls.removeVote({
      pollId: BigInt(params.pollId),
      optionId: BigInt(params.optionId),
      userId,
    });
    await broadcastPollUpdate(channelId, messageId);
    return c.body(null, 204);
  },
);

messagesRouter.post(
  '/:channelId/polls/:pollId/end',
  validate(
    'param',
    z.object({
      channelId: snowflakeSchema,
      pollId: snowflakeSchema,
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const params = c.req.valid('param');
    const { channelId, messageId } = await polls.endPoll(BigInt(params.pollId), userId);
    await broadcastPollUpdate(channelId, messageId);
    return c.body(null, 204);
  },
);

// ── Scheduled message create ────────────────────────────────────────────
//
// POST a future-send queued message. Permission check is the same
// as a regular send (loadChannelContext gates VIEW_CHANNEL +
// SEND_MESSAGES), so if the user can't post now, they can't queue
// for later either. Slowmode is intentionally NOT enforced — a
// scheduled message firing past the slowmode window is fine and
// is the whole point of the feature; preventing it would force
// users to do math. The live send's channel-type refusal (forum /
// link channels) applies here and again at fire time. Every other
// live-send gate (timeout, onboarding, supervision, spam, banned
// words / automod, DM blocks) re-runs when the message FIRES — see
// scheduledMessages.fireScheduled.
//
// Attachments are NOT supported in v1 of scheduling — the simpler
// surface ships first. Attachments would need to upload-and-pin
// the CDN files indefinitely (so they don't GC before the scheduled
// time), which is a separate scope. For now, attachments=[] only.

const scheduleMessageBody = z.object({
  content: z.string().min(1).max(4000),
  scheduledFor: z.string().datetime(),
  replyToMessageId: snowflakeSchema.optional().nullable(),
});

messagesRouter.post(
  '/:channelId/scheduled-messages',
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', scheduleMessageBody),
  async (c) => {
    const userId = requireUserId(c);
    // Instance mute (staff action): no scheduled message while muted. See services/instanceMutes.
    await assertNotInstanceMuted(userId);
    const channelId = BigInt(c.req.valid('param').channelId);
    const body = c.req.valid('json');

    // Same permission preflight as a regular send. throws on no-access.
    const ctx = await loadChannelContext(channelId, userId);
    // loadChannelContext only verifies VIEW_CHANNEL — gate SEND_MESSAGES
    // explicitly. Without this, a member who can read but not post could
    // queue a message that fires later, bypassing the send permission.
    // Forum / link channels are refused with the live send's 400s first:
    // the worker would otherwise insert an invisible row into them.
    if (!ctx.isDM && ctx.channelPerms !== null) {
      assertChannelAcceptsMessages(ctx.channel);
      if (!hasPermission(ctx.channelPerms, Permissions.SEND_MESSAGES)) {
        throw errors.missingPermissions(['SEND_MESSAGES']);
      }
    }

    const scheduledSvc = await import('../services/scheduledMessages');
    const row = await scheduledSvc.createScheduled({
      authorId: userId,
      channelId,
      content: body.content,
      replyToMessageId: body.replyToMessageId
        ? BigInt(body.replyToMessageId)
        : null,
      scheduledFor: new Date(body.scheduledFor),
    });

    return c.json({
      scheduled: {
        id: row.id.toString(),
        channelId: row.channelId.toString(),
        content: row.content,
        scheduledFor: row.scheduledFor.toISOString(),
        replyToMessageId: row.replyToMessageId?.toString() ?? null,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
      },
    });
  },
);
