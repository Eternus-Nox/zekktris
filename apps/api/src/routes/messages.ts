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
import { errors } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import {
  snowflakeSchema,
  messageContentSchema,
  messagePageLimitSchema,
  emojiSchema,
} from '../lib/validation';
import { toMessage, toPublicUser, toReadState, toChannel, toPoll, toForwardSource, toSticker, toGuildMember, type PollDTO, type ForwardSourceDTO, type StickerDTO } from '../lib/dto';
import * as messages from '../services/messages';
import * as polls from '../services/polls';
import * as embeds from '../services/embeds';
import * as supervision from '../services/supervision';
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
  assertChannelPermission,
} from '../services/permissions';
import { db, schema } from '../db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { env } from '../env';
import type { User } from '@zekktris/db';
import { MESSAGE_CONTENT_MAX_LENGTH } from '@zekktris/shared/constants';

export const messagesRouter = new Hono();
messagesRouter.use('*', requireAuth);

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
    const perms = await computeMemberChannelPermissions(channelId, userId);
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
});

messagesRouter.post(
  '/:channelId/messages',
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const channelId = BigInt(c.req.valid('param').channelId);
    const ctx = await loadChannelContext(channelId, userId);

    // ── Parse body: JSON or multipart ────────────────────────────────────
    const contentType = c.req.header('content-type') ?? '';
    let payload: z.infer<typeof sendMessageSchema>;
    let files: File[] = [];

    if (contentType.startsWith('multipart/form-data')) {
      const body = await c.req.parseBody({ all: true });
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
      // Collect File objects from any field whose value is a File. Discord-
      // style "files[0]", "files[1]", ... and bare "files" all work.
      for (const [key, value] of Object.entries(body)) {
        const list = Array.isArray(value) ? value : [value];
        for (const v of list) {
          if (v instanceof File) files.push(v);
        }
        if (key === 'payload_json') continue;
      }
      if (files.length > env.MAX_FILES_PER_MESSAGE) {
        throw errors.badRequest(`At most ${env.MAX_FILES_PER_MESSAGE} attachments per message`);
      }
    } else {
      const json = (await c.req.json().catch(() => ({}))) as unknown;
      payload = sendMessageSchema.parse(json);
    }

    // ── Permission gating (guild channels only) ──────────────────────────
    if (!ctx.isDM && ctx.channelPerms !== null) {
      // Archived threads are read-only. The threads service's
      // setArchived doc-comment promised this would be enforced
      // here, but until this round it wasn't actually checked.
      // To send to an archived thread, a moderator unarchives it
      // first via PATCH /channels/:id. No MANAGE_MESSAGES override
      // — keeping the rule simple: archived means locked, period.
      if (
        ctx.channel.type === 'public_thread' &&
        ctx.channel.threadArchivedAt !== null
      ) {
        throw errors.forbidden('This thread is archived');
      }
      // Forums are post containers — they hold public_thread children
      // (posts), not direct messages. The ForumView surface doesn't
      // render a message stream for the forum itself; messages sent
      // directly to a forum channel would be invisible to viewers
      // while still consuming DB rows. The proper path is the
      // forum-post route which creates a new thread + its first
      // message.
      if (ctx.channel.type === 'guild_forum') {
        throw errors.badRequest(
          'Forum channels only accept posts — use POST /channels/:forumId/posts',
        );
      }
      if (ctx.channel.type === 'guild_link') {
        throw errors.badRequest(
          'Link channels are bookmarks — they don\'t carry messages',
        );
      }
      if (!hasPermission(ctx.channelPerms, Permissions.SEND_MESSAGES)) {
        throw errors.missingPermissions(['SEND_MESSAGES']);
      }
      if (files.length > 0 && !hasPermission(ctx.channelPerms, Permissions.ATTACH_FILES)) {
        throw errors.missingPermissions(['ATTACH_FILES']);
      }
      // Onboarding gate. Members who haven't acknowledged the guild's
      // rules can't send messages. Placed before timeout because
      // onboarding is more fundamental — if you haven't agreed to
      // the rules yet, the timeout state isn't even relevant. The
      // client gets a distinct error code so it can surface the
      // rules-acknowledgment prompt rather than a generic permission
      // error.
      if (ctx.channel.guildId) {
        const state = await membersSvc.getMemberState(ctx.channel.guildId, userId);
        if (state === 'pending') {
          throw errors.pendingAcknowledgment();
        }
      }
      // Timeout enforcement. Unlike slowmode, this is NOT bypassed by
      // MANAGE_MESSAGES — a moderator who's been timed out by a
      // higher-ranked admin stays timed out. The until-timestamp is
      // included in the error so the client can render "you can send
      // again at <time>". Cheap PK lookup; no caching needed at this
      // throughput.
      if (ctx.channel.guildId) {
        const until = await membersSvc.getActiveTimeout(ctx.channel.guildId, userId);
        if (until !== null) {
          throw errors.timedOut(until);
        }
      }
      // Slowmode — bypassed for MANAGE_MESSAGES (mods).
      if (!hasPermission(ctx.channelPerms, Permissions.MANAGE_MESSAGES)) {
        await messages.enforceSlowmode(channelId, userId, ctx.channel.rateLimitPerUser);
      }
      // Instance security (Admin → Security): spam throttle + banned-word
      // gate. Guild plaintext only — E2EE/DMs are exempt by design.
      if (ctx.channel.guildId) {
        const security = await import('../services/security');
        await security.checkSpam({
          userId,
          guildId: ctx.channel.guildId,
          channelId: ctx.channel.id,
        });
        await security.checkBannedWords({
          userId,
          guildId: ctx.channel.guildId,
          channelId: ctx.channel.id,
          content: payload.content,
        });
      }
      // Automod — last gate. Runs only for guild messages. Hits the
      // partial enabled-index, so zero-rule guilds pay an index probe
      // and bail. Rules can OPTIONALLY apply a timeout in addition
      // to blocking the message; that side-effect happens here BEFORE
      // the throw so the timeout is in place by the time the client
      // sees the error.
      if (ctx.channel.guildId) {
        const { checkMessage } = await import('../services/automod');
        const roleIds = await membersSvc.getMemberRoleIds(ctx.channel.guildId, userId);
        const violation = await checkMessage({
          guildId: ctx.channel.guildId,
          channelId: ctx.channel.id,
          userId,
          content: payload.content,
          memberRoleIds: roleIds,
        });
        if (violation) {
          let timeoutApplied = false;
          if (violation.action === 'block_and_timeout' && violation.timeoutSeconds) {
            try {
              const until = new Date(Date.now() + violation.timeoutSeconds * 1000);
              await membersSvc.setMemberTimeout({
                guildId: ctx.channel.guildId,
                userId,
                actorId: userId,
                until,
              });
              timeoutApplied = true;
              const updated = await membersSvc.getMemberDetailed(ctx.channel.guildId, userId);
              if (updated) {
                dispatch.guildMemberUpdate(
                  toGuildMember(updated.member, updated.user, updated.roleIds),
                  ctx.channel.guildId,
                );
              }
            } catch {
              // Timeout failed but the message is still blocked.
              // Don't let a timeout-apply error suppress the block
              // — surfacing the automod block is the priority.
            }
          }

          // Audit entry for the trigger event itself. Written in its
          // own try so an audit-write failure can't suppress the
          // block error. The actor is the sender (they performed
          // the action that tripped the rule) and the target is the
          // RULE — when reviewing audit logs, admins want to see
          // "rule X was triggered N times" grouped by rule.
          //
          // Content snippet: first 80 chars give the reviewer
          // enough context to understand WHAT tripped the rule
          // without storing potentially-large message bodies in
          // every audit row. Original messages may be deleted later;
          // the snippet is the durable record.
          try {
            const snippet =
              payload.content.length > 80
                ? payload.content.slice(0, 80) + '…'
                : payload.content;
            const { writeAudit } = await import('../services/audit');
            await writeAudit({
              guildId: ctx.channel.guildId,
              actorId: userId,
              action: 'automod.rule_triggered',
              targetType: 'automod_rule',
              targetId: violation.id,
              changes: {
                ruleName: violation.name,
                ruleType: violation.ruleType,
                snippet,
                channelId: ctx.channel.id.toString(),
                timeoutApplied,
                action: violation.action,
              },
            });
          } catch {
            // Audit write failed — log only at next sweep, don't
            // surface to the user.
          }

          // log_only: the rule fired, we wrote an audit entry, but
          // we let the message through. Admins use this to observe
          // a rule's hit rate before promoting it to enforcement
          // mode, or to track suspicious senders without alerting
          // them. The audit log is the durable record; the message
          // proceeds to be saved normally.
          if (violation.action !== 'log_only') {
            throw errors.automodBlocked(violation.name, timeoutApplied);
          }
        }
      }
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
    if (payload.forwardFromMessageId) {
      const sourceId = BigInt(payload.forwardFromMessageId);
      const sourceRows = await db
        .select({
          id: schema.messages.id,
          channelId: schema.messages.channelId,
          deletedAt: schema.messages.deletedAt,
        })
        .from(schema.messages)
        .where(eq(schema.messages.id, sourceId))
        .limit(1);
      const source = sourceRows[0];
      if (!source) throw errors.notFound('Source message');
      if (source.deletedAt) {
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
    }

    // ── Sticker validation ──────────────────────────────────────────────
    //
    // Sticker must belong to the SAME guild as the destination channel.
    // Cross-guild sticker use is intentionally not supported — Discord
    // does the same; Nitro-tier cross-guild stickers can be a v2
    // feature if there's demand. Sticker + attachments + poll are
    // mutually exclusive (a message has one body shape).
    let stickerId: bigint | null = null;
    if (payload.stickerId) {
      if (files.length > 0) throw errors.badRequest('Cannot combine sticker with attachments');
      if (payload.poll) throw errors.badRequest('Cannot combine sticker with a poll');
      if (forwardedFromMessageId) throw errors.badRequest('Cannot combine sticker with a forward');
      const sid = BigInt(payload.stickerId);
      const stickerRow = await stickers.getSticker(sid);
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
    const saved = files.length > 0 ? await Promise.all(files.map((f) => uploads.saveUploadedFile(f))) : [];

    let result;
    try {
      result = await messages.createMessage({
        channelId,
        authorId: userId,
        content: payload.content,
        replyToId: payload.replyToId ? BigInt(payload.replyToId) : null,
        guildId: ctx.channel.guildId ?? null,
        allowEveryoneMention: allowEveryone,
        hasAttachedPoll: !!payload.poll,
        forwardedFromMessageId,
        stickerId,
        attachments: saved.map((s, i) => {
          // Tag the first (and only) attachment with voice metadata
          // when the request came in with a `voiceMessage` field.
          // The validation block above guarantees files.length === 1
          // when payload.voiceMessage is set, so applying to index 0
          // is unambiguous.
          const voice = i === 0 && payload.voiceMessage ? payload.voiceMessage : null;
          return {
            id: s.attachmentId,
            filename: s.filename,
            contentType: s.contentType,
            size: s.size,
            url: s.url,
            width: s.width,
            height: s.height,
            isVoiceMessage: !!voice,
            durationSeconds: voice ? voice.durationSeconds : null,
            waveform: voice ? voice.waveform : null,
          };
        }),
      });
    } catch (err) {
      // Roll back the on-disk files if the transaction failed.
      for (const s of saved) await uploads.deleteAttachmentFile(s.attachmentId);
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
    let stickerDTO: StickerDTO | null = null;
    if (stickerId) {
      const stickerRow = await stickers.getSticker(stickerId);
      if (stickerRow) stickerDTO = toSticker(stickerRow);
    }

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

    // Fan out over the gateway. The sender's nonce rides along ONLY on
    // this broadcast so their client can replace its optimistic
    // placeholder in place; other recipients just ignore it.
    dispatch.messageCreate({
      messageDTO: payload.nonce ? { ...messageDTO, nonce: payload.nonce } : messageDTO,
      channelId,
      guildId: ctx.channel.guildId ?? null,
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
          // Only stamp if the recipient has an active connection.
          // Their dmReadReceiptsEnabled toggle is also re-checked
          // inside markMessageDelivered so the gate is honored
          // even if the connection lookup says they're online.
          const conns = registry.byUserId(other);
          if (conns.length === 0) return;
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
    // (attachment-only messages, polls without text, etc.).
    if (payload.content && payload.content.trim().length > 0) {
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
        const messagePart =
          truncatedBody || (saved.length > 0 ? '(attachment)' : '');
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
        const title = isE2EEContent ? 'New message' : authorName;
        const body = isE2EEContent
          ? 'Open app to see message.'
          : isDM
            ? messagePart
            : `${messagePart}  ·  #${channelName}`;

        // URL the click should open. For guild channels:
        // /channels/<guildId>/<channelId>; for DMs: /channels/@me/<channelId>.
        const url = isDM
          ? `/channels/@me/${channelId.toString()}`
          : `/channels/${(ctx.channel.guildId ?? 0n).toString()}/${channelId.toString()}`;

        // Recipients: in a guild, the people @mentioned; in a DM,
        // every recipient. Always exclude the author — no one wants
        // a notification from themselves.
        let targetUserIds: bigint[] = [];
        if (isDM) {
          const recipients = await dms.listAllRecipients(channelId);
          targetUserIds = recipients.filter((id) => id !== userId);
        } else if (result.mentionedUserIds.length > 0) {
          targetUserIds = result.mentionedUserIds.filter((id) => id !== userId);
        }

        if (targetUserIds.length === 0) return;

        // Honor per-user mutes. Each recipient may have set a guild- or
        // channel-level override. Levels:
        //   - 'all'      → push always
        //   - 'mentions' → push only if this message mentions them (or
        //                  it's a DM, where every message is implicitly
        //                  a "mention")
        //   - 'nothing'  → never push
        // The targetUserIds set was already filtered to mentioned+self
        // in the guild path, and to all recipients in DMs. So:
        //   - In a guild: every target is mentioned, so 'mentions' AND
        //     'all' both push, only 'nothing' filters out.
        //   - In a DM: 'mentions' counts as an implicit mention so it
        //     also pushes; only 'nothing' filters out.
        // Simpler: in this code path 'mentions' and 'all' are equivalent,
        // and we filter exactly when level === 'nothing'.
        const { resolveLevelsBulk } = await import('../services/notifications');
        const levels = await resolveLevelsBulk(
          targetUserIds,
          channelId,
          ctx.channel.guildId ?? null,
        );
        const allowedTargets = targetUserIds.filter(
          (id) => (levels.get(id.toString()) ?? 'all') !== 'nothing',
        );

        if (allowedTargets.length === 0) return;

        const pushPayload = {
          title,
          body,
          url,
          tag: channelId.toString(),
        };

        await Promise.all(
          allowedTargets.map((target) => sendToUser(target, pushPayload)),
        );
      } catch {
        // Push is non-critical; failure here mustn't surface anywhere.
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
            await streaks.recordDmMessage({
              channelId,
              authorId: userId,
              recipientId: other,
            });
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
    const rows = await messages.listMessages(channelId, {
      before: q.before ? BigInt(q.before) : undefined,
      after: q.after ? BigInt(q.after) : undefined,
      around: q.around ? BigInt(q.around) : undefined,
      limit: q.limit ?? 50,
    });

    // DM viewed-at stamping. Stamps `viewed_at` on each non-self
    // message in the page that's still NULL, then dispatches
    // MESSAGE_VIEWED to the message author so their UI flips
    // "Delivered" → "Read". Drives both:
    //   - DM auto-delete (TTL clock starts on first view; sweep
    //     deletes after dm_settings.ttl_seconds_after_read)
    //   - Read-receipt UI (1:1 DMs only; group DMs skip)
    //
    // Constraints:
    //   - Channel must be a DM (guild messages never carry these
    //     receipts).
    //   - For receipts, the channel type must be 'dm' specifically;
    //     'group_dm' is excluded since "read by whom" is ambiguous
    //     with > 2 recipients.
    //   - The viewer's dmReadReceiptsEnabled toggle gates the
    //     stamp inside markMessagesViewed; if off, the function
    //     returns [] and we dispatch nothing.
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
          const { stamped, viewerReceiptsEnabled } = await dms.markMessagesViewed(
            channelId,
            userId,
            idsForCallerNotAuthor,
          );
          if (stamped.length === 0) return;
          // Dispatch MESSAGE_VIEWED only if the viewer has receipts
          // on. The stamp on viewed_at always lands (needed for the
          // auto-delete sweep) but the visible-to-sender effect is
          // gated. Group DMs are skipped entirely — the receipt
          // model only makes sense for 1:1.
          if (viewerReceiptsEnabled && ctx.channel.type === 'dm') {
            const now = new Date();
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
                viewedAt: now,
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
    // DB regardless (auto-delete depends on them) but a viewer who
    // has receipts off has their reads stripped from outgoing
    // responses. For each message in the page, the gating user is
    // the non-author (whose view the timestamp represents).
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
        return toMessage({
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
        });
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

    const author = m.authorId ? await loadUser(m.authorId) : null;
    const attachmentMap = await messages.loadAttachments([m.id]);
    const reactionAgg = await reactions.aggregateReactions(m.id);

    return c.json({
      message: toMessage({
        message: m,
        author,
        attachments: attachmentMap.get(m.id) ?? [],
        reactions: reactionAgg,
        selfId: userId,
      }),
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
    const { channelId: cid, messageId: mid } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);

    const ctx = await loadChannelContext(channelId, userId);

    const existing = await messages.getMessage(channelId, messageId);
    if (!existing) throw errors.notFound('Message');
    // Editing is author-only — even MANAGE_MESSAGES doesn't let you put words
    // in someone else's mouth. Mods can delete, not edit.
    if (existing.authorId !== userId) {
      throw errors.forbidden('You can only edit your own messages');
    }
    // Timeout enforcement — a timed-out user could otherwise edit an
    // old message into new content, bypassing the send-message gate.
    // Same check as send/react. Bypassed for DMs (no guild context).
    if (ctx.channel.guildId) {
      const until = await membersSvc.getActiveTimeout(ctx.channel.guildId, userId);
      if (until !== null) throw errors.timedOut(until);
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

    const messageDTO = toMessage({
      message: result.message,
      author,
      attachments: attachmentMap.get(result.message.id) ?? [],
      reactions: await reactions.aggregateReactions(result.message.id),
      mentionedUserIds: result.mentionedUserIds,
      mentionedRoleIds: result.mentionedRoleIds,
      sticker: editStickerDTO,
      poll: editPollDTO,
      forwardedFrom: editForwardDTO,
      selfId: userId,
    });

    dispatch.messageUpdate({
      messageDTO,
      channelId,
      guildId: ctx.channel.guildId ?? null,
    });

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
    // we need to publish the cleared list.
    void embeds.resolveAndPersistEmbeds({
      messageId: result.message.id,
      channelId,
      guildId: ctx.channel.guildId ?? null,
      content: c.req.valid('json').content,
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
    const { channelId: cid, messageId: mid, emoji } = c.req.valid('param');
    const channelId = BigInt(cid);
    const messageId = BigInt(mid);
    const ctx = await loadChannelContext(channelId, userId);

    if (!ctx.isDM && ctx.channelPerms !== null) {
      if (!hasPermission(ctx.channelPerms, Permissions.ADD_REACTIONS)) {
        throw errors.missingPermissions(['ADD_REACTIONS']);
      }
      // Onboarding gate.
      if (ctx.channel.guildId) {
        const state = await membersSvc.getMemberState(ctx.channel.guildId, userId);
        if (state === 'pending') throw errors.pendingAcknowledgment();
      }
      // Timeout enforcement — reactions are participation too. A
      // timed-out user shouldn't be able to add reactions any more
      // than they can send messages. Bypassed for DMs (no guild
      // membership, no timeout state).
      if (ctx.channel.guildId) {
        const until = await membersSvc.getActiveTimeout(ctx.channel.guildId, userId);
        if (until !== null) throw errors.timedOut(until);
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
    await assertChannelPermission(channelId, callerId, Permissions.MANAGE_MESSAGES);
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
    await assertChannelPermission(channelId, callerId, Permissions.MANAGE_MESSAGES);
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
    await assertChannelPermission(channelId, callerId, Permissions.MANAGE_MESSAGES);
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

    const userRows = await db.select().from(schema.users).where(inArray(schema.users.id, userIds));
    return c.json({ users: userRows.map(toPublicUser) });
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
        const { stamped, viewerReceiptsEnabled } =
          await dms.markMessagesViewedUpTo(channelId, userId, messageId);
        if (stamped.length === 0 || !viewerReceiptsEnabled) return;
        const now = new Date();
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
            viewedAt: now,
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
    await assertChannelPermission(channelId, callerId, Permissions.MANAGE_MESSAGES);

    const fresh = await messages.setPinned(channelId, messageId, true);
    const [messageDTO] = await messages.hydrateMessages([fresh], callerId);
    dispatch.messageUpdate({
      messageDTO,
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
    await assertChannelPermission(channelId, callerId, Permissions.MANAGE_MESSAGES);

    const fresh = await messages.setPinned(channelId, messageId, false);
    const [messageDTO] = await messages.hydrateMessages([fresh], callerId);
    dispatch.messageUpdate({
      messageDTO,
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
 * (anyone who can post here can spawn a thread). MANAGE_THREADS is not a
 * separate permission in v1 — keeping the model small.
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
    if (!hasPermission(ctx.channelPerms, Permissions.SEND_MESSAGES)) {
      throw errors.missingPermissions(['SEND_MESSAGES']);
    }

    // Verify the anchor message exists and lives in this channel.
    const m = await messages.getMessage(channelId, messageId);
    if (!m) throw errors.notFound('Message');

    // Default thread name: first ~50 chars of the message content,
    // collapsed whitespace. If the message was attachments-only, fall
    // back to a generic label.
    const body = c.req.valid('json');
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
 * you can start a post.
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
    if (!hasPermission(ctx.channelPerms, Permissions.SEND_MESSAGES)) {
      throw errors.missingPermissions(['SEND_MESSAGES']);
    }
    // Slow-mode on the forum channel — limits how often each user
    // can create a new post. Bypassed for MANAGE_MESSAGES (mods).
    // Uses the forum-specific variant because regular slowmode
    // keys on (channelId, authorId) for the forum row, which is
    // always empty (forums don't hold direct messages).
    if (!hasPermission(ctx.channelPerms, Permissions.MANAGE_MESSAGES)) {
      await messages.enforceForumPostSlowmode(
        channelId,
        callerId,
        ctx.channel.rateLimitPerUser,
      );
    }

    const { title, content, autoArchiveMinutes } = c.req.valid('json');
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

async function broadcastPollUpdate(channelId: bigint, messageId: bigint, selfId: bigint) {
  const messageRows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);
  const m = messageRows[0];
  if (!m) return;
  const author = m.authorId ? await loadUser(m.authorId) : null;
  const attachmentMap = await messages.loadAttachments([messageId]);
  const pollMap = await polls.loadPollsForMessages([messageId], selfId);
  const pollEntry = pollMap.get(messageId);

  // Reactions for the message
  const reactionRows = await db
    .select()
    .from(schema.reactions)
    .where(eq(schema.reactions.messageId, messageId));
  const reactionAgg: Array<{ emoji: string; count: number; userIds: bigint[] }> = [];
  for (const r of reactionRows) {
    const ex = reactionAgg.find((x) => x.emoji === r.emoji);
    if (ex) {
      ex.count++;
      ex.userIds.push(r.userId);
    } else reactionAgg.push({ emoji: r.emoji, count: 1, userIds: [r.userId] });
  }

  // Mentions: small enough to refetch.
  const um = await db
    .select()
    .from(schema.messageUserMentions)
    .where(eq(schema.messageUserMentions.messageId, messageId));
  const rm = await db
    .select()
    .from(schema.messageRoleMentions)
    .where(eq(schema.messageRoleMentions.messageId, messageId));

  const channelRows = await db
    .select({ guildId: schema.channels.guildId })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
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
    selfId,
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
    const params = c.req.valid('param');
    const { channelId, messageId } = await polls.vote({
      pollId: BigInt(params.pollId),
      optionId: BigInt(params.optionId),
      userId,
    });
    await broadcastPollUpdate(channelId, messageId, userId);
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
    await broadcastPollUpdate(channelId, messageId, userId);
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
    await broadcastPollUpdate(channelId, messageId, userId);
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
// users to do math.
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
    const channelId = BigInt(c.req.valid('param').channelId);
    const body = c.req.valid('json');

    // Same permission preflight as a regular send. throws on no-access.
    const ctx = await loadChannelContext(channelId, userId);
    // loadChannelContext only verifies VIEW_CHANNEL — gate SEND_MESSAGES
    // explicitly. Without this, a member who can read but not post could
    // queue a message that fires later, bypassing the send permission.
    if (!ctx.isDM && ctx.channelPerms !== null) {
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
