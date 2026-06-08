/**
 * Messages service
 * ----------------
 * Create / list / get / edit / delete operations for messages. Mentions are
 * parsed and persisted in the same transaction as the message so a partial
 * write is impossible.
 *
 * Slowmode is enforced here: when a guild text channel has
 * `rateLimitPerUser > 0`, we look up the caller's last message in that
 * channel and refuse if not enough time has elapsed. The check is skipped
 * for users with MANAGE_MESSAGES (mods bypass slowmode), but that's the
 * route layer's job — this service is dumb about permissions.
 *
 * Edit / delete authorization (must be author OR MANAGE_MESSAGES) also lives
 * in the route layer; this service trusts its caller.
 */

import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { parseMentions, resolveMentions, writeMessageMentions } from './mentions';
import { deleteStorageItem } from './uploads';
import type { Database } from '@zekktris/db';

type DbHandle = Omit<Database, '$client'>;

// ── Slowmode ───────────────────────────────────────────────────────────────

/**
 * Refuse the send if the caller posted in this channel within the rate
 * window. We use the snowflake id (which encodes the timestamp) instead of
 * created_at — same answer, no extra column needed for ordering.
 */
export async function enforceSlowmode(
  channelId: bigint,
  userId: bigint,
  rateLimitPerUser: number,
): Promise<void> {
  if (rateLimitPerUser <= 0) return;

  const last = await db
    .select({ createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        eq(schema.messages.authorId, userId),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(1);

  if (!last[0]) return; // first message ever — always allowed
  const elapsedMs = Date.now() - last[0].createdAt.getTime();
  const requiredMs = rateLimitPerUser * 1000;
  if (elapsedMs < requiredMs) {
    throw errors.rateLimited(Math.ceil((requiredMs - elapsedMs) / 1000));
  }
}

/**
 * Return the content strings of an author's recent messages within
 * one guild (across all channels), for the past `windowSeconds`.
 * Used by automod's repeat_message rule: caller counts how many
 * returned contents match the message being sent, and triggers
 * when count >= threshold.
 *
 * Bounded by `limit` (100 default) so a runaway sender can't blow
 * up the query. Beyond 100 the threshold is effectively reached
 * regardless of exact count, so the cap doesn't change behavior at
 * sane threshold values.
 *
 * Index path: (author_id, created_at) on messages; channels PK on
 * the JOIN side. Cheap even on busy guilds.
 */
export async function listRecentContentByAuthor(
  userId: bigint,
  guildId: bigint,
  windowSeconds: number,
  limit = 100,
): Promise<string[]> {
  if (windowSeconds <= 0) return [];
  const cutoff = new Date(Date.now() - windowSeconds * 1000);
  const rows = await db
    .select({ content: schema.messages.content })
    .from(schema.messages)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(
      and(
        eq(schema.messages.authorId, userId),
        eq(schema.channels.guildId, guildId),
        gt(schema.messages.createdAt, cutoff),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(limit);
  return rows.map((r) => r.content);
}

/**
 * Forum-post slow-mode. Forums hold threads (posts), not direct
 * messages, so the regular enforceSlowmode (keyed on
 * `(channelId, authorId)` for the forum channel itself) is a no-op:
 * users never message the forum directly. This variant finds the
 * user's most-recent authored message in ANY thread under the
 * forum — i.e. their most recent post's first message — and
 * throttles new posts against that.
 *
 * Threads-under-this-forum is a small set (capped at 50 active
 * per forum per the listThreadsForChannel cap), so the join +
 * MAX(createdAt) is cheap.
 */
export async function enforceForumPostSlowmode(
  forumChannelId: bigint,
  userId: bigint,
  rateLimitPerUser: number,
): Promise<void> {
  if (rateLimitPerUser <= 0) return;

  const last = await db
    .select({ createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .innerJoin(
      schema.channels,
      eq(schema.channels.id, schema.messages.channelId),
    )
    .where(
      and(
        eq(schema.channels.parentId, forumChannelId),
        eq(schema.channels.type, 'public_thread'),
        eq(schema.messages.authorId, userId),
        isNull(schema.messages.deletedAt),
        isNull(schema.channels.deletedAt),
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(1);

  if (!last[0]) return;
  const elapsedMs = Date.now() - last[0].createdAt.getTime();
  const requiredMs = rateLimitPerUser * 1000;
  if (elapsedMs < requiredMs) {
    throw errors.rateLimited(Math.ceil((requiredMs - elapsedMs) / 1000));
  }
}

// ── Create ─────────────────────────────────────────────────────────────────

export interface CreateMessageInput {
  channelId: bigint;
  /** Null permitted only for system messages; user messages always have an author. */
  authorId: bigint;
  content: string;
  replyToId?: bigint | null;
  /** Guild id of the channel — null for DMs. Used for role-mention scoping. */
  guildId: bigint | null;
  /** Pre-validated attachment rows to insert alongside the message. */
  attachments?: NewAttachmentInput[];
  /** True when the caller has MENTION_EVERYONE — clears the everyone flag if false. */
  allowEveryoneMention: boolean;
  /**
   * When set, this message is a forward of another message. The
   * service does NOT validate permissions on the source — the route
   * layer is responsible for confirming the caller can VIEW_CHANNEL +
   * READ_MESSAGE_HISTORY on the source channel. Once a forward is
   * created, the source content is implicitly "shared" to anyone who
   * can view the destination channel; that's the deliberate semantic.
   */
  forwardedFromMessageId?: bigint | null;
  /** When set, this message attaches a sticker. Renders as a standalone
      ~160px image instead of (or alongside) text content. The route
      layer validates the sticker belongs to the destination's guild. */
  stickerId?: bigint | null;
  /**
   * Set when the caller is going to attach a poll to this message in
   * the same transaction (poll insert happens after, in the route).
   * The empty-content/no-attachments rejection is suppressed because
   * a poll-only message is a valid construct.
   */
  hasAttachedPoll?: boolean;
  /**
   * Webhook attribution. When set, the message renders with the override
   * name + avatar instead of the author's user record. authorId still
   * points to the webhook's owner (createdBy at the time the webhook
   * was created) so audit + mention math work, but the rendered identity
   * is the webhook's persona.
   */
  webhookId?: bigint | null;
  authorOverrideName?: string | null;
  authorOverrideAvatar?: string | null;
}

export interface NewAttachmentInput {
  /**
   * Pre-assigned snowflake — must match the id baked into the public URL by
   * services/uploads.saveUploadedFile. Without this, the row id and the URL
   * id diverge and CDN reads 404.
   */
  id: bigint;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  width?: number | null;
  height?: number | null;
  /** Voice-message flag — caller sets when this attachment was a
      browser-recorded voice message rather than a generic upload. */
  isVoiceMessage?: boolean;
  /** Duration in seconds. Only meaningful when isVoiceMessage is true. */
  durationSeconds?: number | null;
  /** Base64-encoded waveform bytes (typically 32-64 samples). Only
      meaningful when isVoiceMessage is true. */
  waveform?: string | null;
}

/** Result of a create or edit — the row plus the just-resolved mention ids. */
export interface MessageWithMentions {
  message: schema.Message;
  mentionedUserIds: bigint[];
  mentionedRoleIds: bigint[];
  /** True if @everyone or @here was in the content and the caller had permission. */
  mentionsEveryone: boolean;
}

export async function createMessage(input: CreateMessageInput): Promise<MessageWithMentions> {
  // Sanity check: empty message with no attachments is rejected. (The DB
  // would happily store it, but it's not useful.) An attached poll
  // counts as content for this purpose — the poll IS the message.
  // A forward also counts — the forwarded content IS the message body.
  // A sticker is itself a body.
  if (
    (!input.content || input.content.trim() === '') &&
    !input.attachments?.length &&
    !input.hasAttachedPoll &&
    !input.forwardedFromMessageId &&
    !input.stickerId
  ) {
    throw errors.badRequest('Message must have content or attachments');
  }

  const parsed = parseMentions(input.content);
  // Strip @everyone mention if caller doesn't have permission. This is a
  // hard refusal pattern (Discord pretends the @ wasn't there); we return
  // 403 instead so clients get a clear signal.
  if ((parsed.everyone) && !input.allowEveryoneMention) {
    throw errors.missingPermissions(['MENTION_EVERYONE']);
  }
  const resolved = await resolveMentions(parsed, input.guildId, input.channelId);

  const messageId = nextSnowflake();

  const message = await db.transaction(async (tx) => {
    // Validate replyTo if given.
    if (input.replyToId) {
      const ref = await tx
        .select({
          id: schema.messages.id,
          channelId: schema.messages.channelId,
          deletedAt: schema.messages.deletedAt,
        })
        .from(schema.messages)
        .where(eq(schema.messages.id, input.replyToId))
        .limit(1);
      if (!ref[0] || ref[0].channelId !== input.channelId || ref[0].deletedAt) {
        throw errors.badRequest('replyToId does not refer to a message in this channel');
      }
    }

    const [inserted] = await tx
      .insert(schema.messages)
      .values({
        id: messageId,
        channelId: input.channelId,
        authorId: input.authorId,
        content: input.content,
        replyToId: input.replyToId ?? null,
        mentionsEveryone: parsed.everyone,
        mentionsHere: false, // we treat @here identically to @everyone for v1
        webhookId: input.webhookId ?? null,
        authorOverrideName: input.authorOverrideName ?? null,
        authorOverrideAvatar: input.authorOverrideAvatar ?? null,
        forwardedFromMessageId: input.forwardedFromMessageId ?? null,
        stickerId: input.stickerId ?? null,
      })
      .returning();
    if (!inserted) throw errors.internal('Message insert returned no row');

    if (input.attachments && input.attachments.length > 0) {
      await tx.insert(schema.attachments).values(
        input.attachments.map((a) => ({
          id: a.id,
          messageId,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
          url: a.url,
          width: a.width ?? null,
          height: a.height ?? null,
          isVoiceMessage: a.isVoiceMessage ?? false,
          durationSeconds: a.durationSeconds ?? null,
          waveform: a.waveform ?? null,
        })),
      );
    }

    await writeMessageMentions(messageId, resolved, tx as DbHandle);

    // Bump the channel's last_message_id so the unread/last-msg display can
    // be computed by a single channel read instead of a sub-select.
    await tx
      .update(schema.channels)
      .set({ lastMessageId: messageId })
      .where(eq(schema.channels.id, input.channelId));

    // Mention-count bookkeeping: for every user this message directly
    // mentions (except the author themselves — self-mentions are noise),
    // increment their read_state.mention_count for this channel. This is
    // an UPSERT because the user may not yet have a read_state row for
    // this channel; in that case we INSERT with mention_count=1 and a NULL
    // last_message_id (they haven't acked anything yet, so all messages
    // up to and including the mentioning one are unread).
    //
    // Mass mentions (@everyone/@here) are NOT counted here — that's a
    // separate notification semantic that can flood badges; tracking it
    // would need a per-channel "everyone-mention pending" flag, which is
    // a v1.x concern. For v1 only direct user mentions trigger the chip.
    const mentionedExceptAuthor = resolved.userIds.filter((u) => u !== input.authorId);
    if (mentionedExceptAuthor.length > 0) {
      await tx
        .insert(schema.readStates)
        .values(
          mentionedExceptAuthor.map((userId) => ({
            userId,
            channelId: input.channelId,
            lastMessageId: null,
            mentionCount: 1,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.readStates.userId, schema.readStates.channelId],
          set: {
            mentionCount: sql`${schema.readStates.mentionCount} + 1`,
            updatedAt: new Date(),
          },
        });
    }

    return inserted;
  });

  return {
    message,
    mentionedUserIds: resolved.userIds,
    mentionedRoleIds: resolved.roleIds,
    mentionsEveryone: parsed.everyone,
  };
}

/**
 * Insert a `system_join` message — the welcome / greeting that fires
 * when a new member lands in a guild that has welcome messages
 * enabled. Plain insert without the createMessage mention-resolution
 * + read-state machinery: the content has been pre-rendered by the
 * welcome service (template + {user} → @mention substitution) and
 * the mention array is passed in directly. Read-state bumps are
 * skipped because the joining user is the one being greeted —
 * they're "live" in the channel by definition and don't need an
 * unread-count nudge for their own welcome.
 *
 * `authorId` is the joining user. The `type` flag flips the
 * client's rendering to a banner-style welcome row rather than a
 * regular message bubble. Returns the inserted row so the caller
 * can build a Message DTO and dispatch MESSAGE_CREATE.
 */
export async function createSystemMessage(input: {
  channelId: bigint;
  /** Guild this channel lives in, or null for DM channels. The
   *  function doesn't write this directly (messages don't have a
   *  guild_id column — they derive guild from channel.guild_id), but
   *  the caller may pass it for clarity; it's currently unused. */
  guildId: bigint | null;
  authorId: bigint;
  content: string;
  type: 'system_join' | 'system_call';
  mentionedUserIds: bigint[];
  /** Structured metadata for system messages that need it. Currently
   *  used by system_call to carry { missed, durationMs, initiatorId }.
   *  Stored as-is in the JSONB metadata column. */
  metadata?: import('@zekktris/db').MessageMetadataJson | null;
}): Promise<typeof schema.messages.$inferSelect> {
  const messageId = nextSnowflake();
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.messages)
      .values({
        id: messageId,
        channelId: input.channelId,
        authorId: input.authorId,
        content: input.content,
        type: input.type,
        mentionsEveryone: false,
        mentionsHere: false,
        metadata: input.metadata ?? null,
      })
      .returning();
    if (!inserted) throw errors.internal('System message insert returned no row');
    if (input.mentionedUserIds.length > 0) {
      await tx.insert(schema.messageUserMentions).values(
        input.mentionedUserIds.map((userId) => ({
          messageId,
          userId,
        })),
      );
    }
    return inserted;
  });
}

// ── List ───────────────────────────────────────────────────────────────────

export interface ListMessagesOptions {
  /** Return messages with id < before. */
  before?: bigint;
  /** Return messages with id > after. */
  after?: bigint;
  /** Return messages bracketing this id — `limit/2` older (incl. the
      target itself if it exists) plus `limit/2` newer. Mutually
      exclusive with before/after; the route validates. Used by
      message-link jumping ("scroll into history to a specific
      message"). */
  around?: bigint;
  /** Hard cap enforced by the route layer; we trust the value here. */
  limit: number;
  /** Include soft-deleted messages (content retained). Only the parental
      supervision reader sets this — normal clients never see deleted
      rows. The caller is responsible for labelling them as deleted. */
  includeDeleted?: boolean;
}

/**
 * Paginate messages in a channel. Default ordering is newest-first
 * (`id desc`); when `after` is set we flip to oldest-first so the page
 * walks forward from the cursor.
 *
 * For `around`, we run two queries — one for the older half (≤ target)
 * and one for the newer half (> target) — and merge. Result is
 * returned in chronological order (oldest first) to simplify the
 * scroll-into-view UI: the client can splice the result into state
 * and immediately scroll to the target without reversing.
 */
export async function listMessages(channelId: bigint, opts: ListMessagesOptions) {
  if (opts.around !== undefined) {
    const half = Math.max(1, Math.floor(opts.limit / 2));
    const baseConditions = [
      eq(schema.messages.channelId, channelId),
      isNull(schema.messages.deletedAt),
    ];
    const older = await db
      .select()
      .from(schema.messages)
      .where(and(...baseConditions, lte(schema.messages.id, opts.around)))
      .orderBy(desc(schema.messages.id))
      .limit(half);
    const newer = await db
      .select()
      .from(schema.messages)
      .where(and(...baseConditions, gt(schema.messages.id, opts.around)))
      .orderBy(asc(schema.messages.id))
      .limit(half);
    // older is desc (newest of older first); reverse to oldest-first
    // so concatenation produces chronological order.
    return [...older.reverse(), ...newer];
  }

  const useAsc = opts.after !== undefined && opts.before === undefined;

  const conditions = [eq(schema.messages.channelId, channelId)];
  if (!opts.includeDeleted) conditions.push(isNull(schema.messages.deletedAt));
  if (opts.before !== undefined) conditions.push(lt(schema.messages.id, opts.before));
  if (opts.after !== undefined) conditions.push(gt(schema.messages.id, opts.after));

  return db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(useAsc ? asc(schema.messages.id) : desc(schema.messages.id))
    .limit(opts.limit);
}

export async function getMessage(channelId: bigint, messageId: bigint) {
  const r = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.messages.channelId, channelId),
        isNull(schema.messages.deletedAt),
      ),
    )
    .limit(1);
  return r[0] ?? null;
}

/** Fetch attachments for a list of message IDs in one query. */
export async function loadAttachments(messageIds: bigint[]) {
  if (messageIds.length === 0) return new Map<bigint, schema.Attachment[]>();
  const rows = await db
    .select()
    .from(schema.attachments)
    .where(inArray(schema.attachments.messageId, messageIds));
  const map = new Map<bigint, schema.Attachment[]>();
  for (const r of rows) {
    const list = map.get(r.messageId);
    if (list) list.push(r);
    else map.set(r.messageId, [r]);
  }
  return map;
}

/**
 * Load sticker rows for a batch of messages. Returns a map keyed by
 * sticker id so callers index by the message's `stickerId` field.
 *
 * The row may be missing if the sticker was deleted after the message
 * was sent — those messages render with a "[sticker unavailable]"
 * tombstone client-side. Same posture as forward sources.
 */
export async function loadStickersForMessages(stickerIds: bigint[]) {
  if (stickerIds.length === 0) return new Map<bigint, schema.Sticker>();
  const rows = await db
    .select()
    .from(schema.stickers)
    .where(inArray(schema.stickers.id, stickerIds));
  const map = new Map<bigint, schema.Sticker>();
  for (const r of rows) map.set(r.id, r);
  return map;
}

/**
 * Load source messages for a batch of forwards.
 *
 * Given a list of message ids that have non-null `forwardedFromMessageId`,
 * fetches the source messages plus their authors, attachments, and
 * source-channel info. Returns a map keyed by the SOURCE message id —
 * callers index by the forwarder's `forwardedFromMessageId` field.
 *
 * The source row may be missing (deleted, or never existed if the id is
 * stale) — those forwards render as "[unavailable]" client-side. We
 * intentionally don't filter `deletedAt` server-side: if a source was
 * soft-deleted, the forward should still show what was forwarded
 * (Discord behaves the same way) — preservation of historical context
 * over cleanliness of state. Hard-deleted rows are simply absent.
 *
 * Source-side attachments are included so an image-only forward shows
 * the image. Polls are NOT preserved (forwarding a poll into another
 * channel doesn't transfer the votes; sharing the question + options
 * via plain content is the cleaner semantic).
 */
export async function loadForwardSources(sourceMessageIds: bigint[]) {
  if (sourceMessageIds.length === 0) {
    return {
      messages: new Map<bigint, schema.Message>(),
      authors: new Map<bigint, schema.User>(),
      attachments: new Map<bigint, schema.Attachment[]>(),
      channels: new Map<bigint, schema.Channel>(),
    };
  }
  const messages = await db
    .select()
    .from(schema.messages)
    .where(inArray(schema.messages.id, sourceMessageIds));
  const messageMap = new Map<bigint, schema.Message>();
  for (const m of messages) messageMap.set(m.id, m);

  const authorIds = Array.from(
    new Set(messages.map((m) => m.authorId).filter((x): x is bigint => x !== null)),
  );
  const channelIds = Array.from(new Set(messages.map((m) => m.channelId)));

  // Authors, channels, and attachments are mutually independent —
  // each one only needs the in-memory derivations from messages or
  // the original sourceMessageIds. Sequential awaits paid 3 round-
  // trips for every forwarded message in a hydration batch; one
  // parallel batch is enough.
  const [authors, channels, attachmentMap] = await Promise.all([
    authorIds.length
      ? db.select().from(schema.users).where(inArray(schema.users.id, authorIds))
      : Promise.resolve([] as schema.User[]),
    channelIds.length
      ? db.select().from(schema.channels).where(inArray(schema.channels.id, channelIds))
      : Promise.resolve([] as schema.Channel[]),
    loadAttachments(sourceMessageIds),
  ]);

  const authorMap = new Map<bigint, schema.User>();
  for (const a of authors) authorMap.set(a.id, a);
  const channelMap = new Map<bigint, schema.Channel>();
  for (const c of channels) channelMap.set(c.id, c);

  return { messages: messageMap, authors: authorMap, attachments: attachmentMap, channels: channelMap };
}

// ── Edit ───────────────────────────────────────────────────────────────────

export interface EditMessageInput {
  messageId: bigint;
  content: string;
  guildId: bigint | null;
  /** Channel the message lives in. Needed for audience-scoped mention
      resolution: an edit could add a mention; we apply the same
      filter as create. */
  channelId: bigint;
  allowEveryoneMention: boolean;
}

export async function editMessage(input: EditMessageInput): Promise<MessageWithMentions> {
  const parsed = parseMentions(input.content);
  if (parsed.everyone && !input.allowEveryoneMention) {
    throw errors.missingPermissions(['MENTION_EVERYONE']);
  }
  const resolved = await resolveMentions(parsed, input.guildId, input.channelId);

  const message = await db.transaction(async (tx) => {
    const now = new Date();
    const [updated] = await tx
      .update(schema.messages)
      .set({
        content: input.content,
        mentionsEveryone: parsed.everyone,
        editedAt: now,
      })
      .where(
        and(eq(schema.messages.id, input.messageId), isNull(schema.messages.deletedAt)),
      )
      .returning();
    if (!updated) throw errors.notFound('Message');

    await writeMessageMentions(input.messageId, resolved, tx as DbHandle);
    return updated;
  });

  return {
    message,
    mentionedUserIds: resolved.userIds,
    mentionedRoleIds: resolved.roleIds,
    mentionsEveryone: parsed.everyone,
  };
}

// ── Delete ─────────────────────────────────────────────────────────────────

/**
 * Soft-delete: keeps the row so reply chains stay walkable. Clients should
 * render deleted messages as a tombstone. The actual content stays in the
 * row for audit purposes; clients filter it out via deletedAt.
 */
export async function deleteMessage(messageId: bigint): Promise<void> {
  const [updated] = await db
    .update(schema.messages)
    .set({ deletedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), isNull(schema.messages.deletedAt)))
    .returning({ id: schema.messages.id });
  if (!updated) throw errors.notFound('Message');
}

/**
 * Soft-delete every non-deleted message in a channel. Returns the
 * list of deleted message ids so the caller can dispatch
 * MESSAGE_DELETE events to connected clients.
 *
 * Implementation choice: we mark `deletedAt` rather than DROP rows,
 * matching what `deleteMessage` does for a single message — keeps
 * audit logs sensible (the rows still exist with the moderator's
 * action recorded against the channel) and lets attachments be
 * GC'd by the same background job that handles single deletions.
 *
 * Cap to MAX_PURGE_BATCH per call so a runaway purge can't lock
 * the table for minutes on a busy channel. Caller can re-run; the
 * UI exposes a "purge" action that loops until the channel is
 * empty (returns 0 deleted to signal completion).
 */
const MAX_PURGE_BATCH = 1000;

export async function purgeChannel(channelId: bigint): Promise<bigint[]> {
  // Two-step: select-then-update so we get the ids back. Drizzle's
  // .returning() works on UPDATE so we could combine, but the
  // explicit select keeps the cap clear AND lets us log how many
  // rows were touched without a follow-up COUNT.
  const rows = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, channelId), isNull(schema.messages.deletedAt)))
    .limit(MAX_PURGE_BATCH);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await db
    .update(schema.messages)
    .set({ deletedAt: new Date() })
    .where(and(eq(schema.messages.channelId, channelId), inArray(schema.messages.id, ids)));

  // Reclaim uploaded attachment files for the purged messages. Purge is
  // a soft-delete of the message rows, but the uploaded bytes should go
  // immediately: the GC counts any row in the attachments table as
  // "referenced", so without this the files would never be collected.
  // Delete the files from disk AND drop the attachment rows so storage
  // accounting stays correct. Best-effort — a missing file or partial
  // failure must not fail the purge (the messages are already gone).
  try {
    const atts = await db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(inArray(schema.attachments.messageId, ids));
    if (atts.length > 0) {
      await Promise.allSettled(atts.map((a) => deleteStorageItem(a.id)));
      await db
        .delete(schema.attachments)
        .where(inArray(schema.attachments.messageId, ids));
    }
  } catch (e) {
    console.warn('purgeChannel: attachment cleanup failed', e);
  }

  return ids;
}

// ── Pins ───────────────────────────────────────────────────────────────────

/**
 * Pin or unpin a message in its channel. Channel-scoped check (the messageId
 * MUST belong to channelId) prevents cross-channel pin spoofing — without it,
 * an admin who can MANAGE_MESSAGES on channel A could in theory pin a message
 * authored to channel B by passing the wrong cid.
 *
 * Idempotent: pinning an already-pinned message is a no-op (returns the
 * existing row); unpinning a not-pinned one likewise.
 */
export async function setPinned(
  channelId: bigint,
  messageId: bigint,
  pinned: boolean,
): Promise<typeof schema.messages.$inferSelect> {
  const [updated] = await db
    .update(schema.messages)
    .set({ pinned })
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.messages.channelId, channelId),
        isNull(schema.messages.deletedAt),
      ),
    )
    .returning();
  if (!updated) throw errors.notFound('Message');
  return updated;
}

/**
 * List pinned messages in a channel, newest first. Capped at 50 to match
 * Discord's per-channel pin ceiling — beyond that the UI becomes unusable
 * anyway. Excludes soft-deleted messages: a pinned message that was later
 * deleted still has `pinned=true` in the row but shouldn't surface.
 */
export async function listPinned(channelId: bigint) {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        eq(schema.messages.pinned, true),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(50);
  return rows;
}

// ── Full-text search ───────────────────────────────────────────────────────

/**
 * Search messages within a channel by content using Postgres' built-in
 * full-text search. We don't keep a separate tsvector column — for the
 * volume one self-hosted server sees, `to_tsvector('english', content)`
 * computed at query time + a trigram or expression GIN index is plenty.
 *
 * The migration adds `messages_content_fts_idx` as an expression GIN index
 * over `to_tsvector('english', content)`, so this query uses the index
 * even though we recompute the tsvector inline.
 *
 * Bound the result count tightly (50) — full-text search is usually a
 * "find the conversation about X" query, not a paginated archive walk.
 *
 * Returns plain message rows; callers decorate with mentions/attachments
 * via the same loader as listMessages.
 */
export async function searchMessages(
  channelId: bigint,
  query: string,
  limit = 50,
  filters: { authorId?: bigint; before?: bigint; after?: bigint } = {},
) {
  const trimmed = query.trim();
  // With filters in play, an empty query is now valid — the user might
  // want "every message from Alice in this channel" without keywords.
  // Postgres' to_tsquery on empty input would error, so we conditionally
  // skip the FTS predicate when the keyword string is blank.
  const hasFilters =
    filters.authorId !== undefined ||
    filters.before !== undefined ||
    filters.after !== undefined;
  if (trimmed.length === 0 && !hasFilters) return [];

  // Build the WHERE clause incrementally. Each filter is appended only
  // when supplied. We use sql tag fragments so the parameters stay
  // properly bound — concatenating into a string would defeat the
  // injection guarantees Postgres gives us via parameterised queries.
  //
  // Built with the drizzle query builder rather than a hand-composed
  // `db.execute(sql`…`)`: the old raw-SQL path tripped postgres-js with
  // "UNDEFINED_VALUE" when the nested WHERE fragment was embedded, and it
  // returned snake_case rows that hydrateMessages (which reads camelCase)
  // couldn't decorate. The builder binds params correctly and returns typed
  // camelCase rows. The FTS predicate stays raw `sql` so it matches the GIN
  // expression index from migration 0002 (`to_tsvector('english', content)`).
  const conds: SQL[] = [
    eq(schema.messages.channelId, channelId),
    isNull(schema.messages.deletedAt),
  ];
  if (trimmed.length > 0) {
    conds.push(
      sql`to_tsvector('english', ${schema.messages.content}) @@ websearch_to_tsquery('english', ${trimmed})`,
    );
  }
  if (filters.authorId !== undefined) conds.push(eq(schema.messages.authorId, filters.authorId));
  // Snowflake comparison: smaller id = older.
  if (filters.before !== undefined) conds.push(lt(schema.messages.id, filters.before));
  if (filters.after !== undefined) conds.push(gt(schema.messages.id, filters.after));

  return db
    .select()
    .from(schema.messages)
    .where(and(...conds))
    .orderBy(desc(schema.messages.id))
    .limit(limit);
}

/**
 * Cross-DM message search. Scans messages across ALL DMs the user
 * is a recipient in. Used by GET /users/@me/dms/search to surface
 * the "find that conversation" affordance on the DM list view
 * (previously search was per-channel only — users had to open a
 * specific DM first to search inside it).
 *
 * Implementation: JOIN messages with dm_recipients on channel_id;
 * filter to rows where the recipient is the caller. The FTS
 * predicate is the same as per-channel search — the GIN index on
 * `to_tsvector('english', content)` from migration 0002 covers
 * both call sites.
 *
 * We do NOT search guild messages here — that path stays per-
 * channel because guild permissions are per-channel and computing
 * effective visibility across an unknown set of guilds would
 * defeat the index. A future "search everything you can see"
 * endpoint would batch-resolve permissions; out of scope here.
 *
 * Returns raw message rows; the route calls hydrateMessages to
 * decorate with authors, attachments, etc.
 */
export async function searchDirectMessages(
  userId: bigint,
  query: string,
  limit = 50,
  filters: { authorId?: bigint; before?: bigint; after?: bigint } = {},
) {
  const trimmed = query.trim();
  const hasFilters =
    filters.authorId !== undefined ||
    filters.before !== undefined ||
    filters.after !== undefined;
  if (trimmed.length === 0 && !hasFilters) return [];

  // Query builder (same rationale as searchMessages above — the old raw
  // db.execute path 500'd with UNDEFINED_VALUE and returned snake_case rows
  // hydrateMessages couldn't read). Base predicate: not soft-deleted AND the
  // caller is a recipient of the message's DM channel (correlated EXISTS,
  // index-friendly via dm_recipients_user_idx). FTS stays raw `sql` to match
  // the migration-0002 GIN index.
  const conds: SQL[] = [
    isNull(schema.messages.deletedAt),
    exists(
      db
        .select({ one: sql`1` })
        .from(schema.dmRecipients)
        .where(
          and(
            eq(schema.dmRecipients.channelId, schema.messages.channelId),
            eq(schema.dmRecipients.userId, userId),
          ),
        ),
    ),
  ];
  if (trimmed.length > 0) {
    conds.push(
      sql`to_tsvector('english', ${schema.messages.content}) @@ websearch_to_tsquery('english', ${trimmed})`,
    );
  }
  if (filters.authorId !== undefined) conds.push(eq(schema.messages.authorId, filters.authorId));
  if (filters.before !== undefined) conds.push(lt(schema.messages.id, filters.before));
  if (filters.after !== undefined) conds.push(gt(schema.messages.id, filters.after));

  return db
    .select()
    .from(schema.messages)
    .where(and(...conds))
    .orderBy(desc(schema.messages.id))
    .limit(limit);
}

// ── Hydration helper (shared between list / pins / search routes) ─────────

/**
 * Take a batch of raw message rows and return them as fully-hydrated
 * MessageDTOs. Bulk-loads authors, attachments, mentions, and reactions
 * in parallel — same shape as the inline block in the GET messages route,
 * but reusable by pins and search.
 *
 * `selfId` is used by the DTO to mark `mentioned: true` on messages that
 * @mentioned the requesting user.
 */
export async function hydrateMessages(
  rows: Array<typeof schema.messages.$inferSelect>,
  selfId: bigint,
): Promise<unknown[]> {
  if (rows.length === 0) return [];

  const authorIds = Array.from(
    new Set(rows.map((m) => m.authorId).filter((x): x is bigint => x !== null)),
  );
  const messageIds = rows.map((m) => m.id);

  const [authors, attachmentMap, userMentionRows, roleMentionRows, reactionRows] =
    await Promise.all([
      authorIds.length === 0
        ? Promise.resolve<Array<typeof schema.users.$inferSelect>>([])
        : db.select().from(schema.users).where(inArray(schema.users.id, authorIds)),
      loadAttachments(messageIds),
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
    ]);

  const authorMap = new Map(authors.map((u) => [u.id, u]));
  const userMentionMap = new Map<bigint, bigint[]>();
  for (const r of userMentionRows) {
    const list = userMentionMap.get(r.messageId);
    if (list) list.push(r.userId);
    else userMentionMap.set(r.messageId, [r.userId]);
  }
  const roleMentionMap = new Map<bigint, bigint[]>();
  for (const r of roleMentionRows) {
    const list = roleMentionMap.get(r.messageId);
    if (list) list.push(r.roleId);
    else roleMentionMap.set(r.messageId, [r.roleId]);
  }

  // Aggregate reactions by message → emoji → users.
  const reactionsByMessage = new Map<
    bigint,
    Array<{ emoji: string; count: number; userIds: bigint[] }>
  >();
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

  // Imported lazily to avoid a circular import (dto imports back from
  // schema, which would loop through this module otherwise).
  const { toMessage } = await import('../lib/dto');
  return rows.map((m) =>
    toMessage({
      message: m,
      author: m.authorId ? authorMap.get(m.authorId) ?? null : null,
      attachments: attachmentMap.get(m.id) ?? [],
      reactions: reactionsByMessage.get(m.id) ?? [],
      mentionedUserIds: userMentionMap.get(m.id) ?? [],
      mentionedRoleIds: roleMentionMap.get(m.id) ?? [],
      selfId,
    }),
  );
}

// ── User mentions inbox ───────────────────────────────────────────────────
//
// Returns messages that mention a specific user across all channels they
// can currently access. The driving use case is the "mentions inbox" UI
// — Discord's top-bar inbox where you see every @ that pings you.
//
// Permission model: the user must currently be a member of the guild
// the channel belongs to (we don't surface mentions from servers you've
// left). For DM channels, the user must be a participant. We do NOT
// re-check channel-level VIEW_CHANNEL overrides at query time — that
// would multiply the query cost by the number of channels and the
// edge case (channel perm changed after a mention was sent) is rare
// enough to accept ghost mentions until the next mark-as-read.
//
// Ordering: newest first. Pagination via `before` (a message id).

export interface ListUserMentionsOptions {
  before?: bigint;
  limit: number;
}

export async function listUserMentions(
  userId: bigint,
  opts: ListUserMentionsOptions,
): Promise<Array<typeof schema.messages.$inferSelect>> {
  // Mentions inbox query. Joins message_user_mentions → messages →
  // channels and filters to mentions for this user in channels they
  // can currently access. The "Clear all" path deletes the user's
  // message_user_mentions rows directly, so cleared mentions don't
  // need a separate filter here — they simply don't appear in the
  // join.
  const conds = [
    eq(schema.messageUserMentions.userId, userId),
    isNull(schema.messages.deletedAt),
  ];
  if (opts.before !== undefined) {
    conds.push(lt(schema.messages.id, opts.before));
  }

  // Subquery: channels the user currently has access to. Either:
  //   - a guild channel where the user is a current member of the guild
  //   - a DM channel where the user is in the dm_recipients table
  //
  // We do the membership filter inline via EXISTS subselects so the
  // query stays a single round trip.
  const rows = await db
    .select({ msg: schema.messages })
    .from(schema.messageUserMentions)
    .innerJoin(
      schema.messages,
      eq(schema.messages.id, schema.messageUserMentions.messageId),
    )
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(
      and(
        ...conds,
        sql`(
          (${schema.channels.guildId} IS NOT NULL AND EXISTS (
            SELECT 1 FROM ${schema.guildMembers}
            WHERE ${schema.guildMembers.guildId} = ${schema.channels.guildId}
              AND ${schema.guildMembers.userId} = ${userId}
          ))
          OR
          (${schema.channels.guildId} IS NULL AND EXISTS (
            SELECT 1 FROM ${schema.dmRecipients}
            WHERE ${schema.dmRecipients.channelId} = ${schema.channels.id}
              AND ${schema.dmRecipients.userId} = ${userId}
          ))
        )`,
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(opts.limit);

  return rows.map((r) => r.msg);
}
