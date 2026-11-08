/**
 * Purge — what "delete" actually means for a server or an account.
 * ----------------------------------------------------------------
 * Both deletions used to leave the content behind:
 *
 *   - `deleteGuild` only set `deleted_at` on the guild and its channels. Every
 *     message, member, role and attachment row stayed in the database forever;
 *     only the files were eventually reclaimed by the attachment GC.
 *   - Account deletion hard-deleted the user row, but `messages.author_id` is
 *     ON DELETE SET NULL, so everything the person ever wrote stayed in place
 *     with a blank author.
 *
 * What a purge does now, and the three rules that shape it:
 *
 *   1. A deleted server is GONE. The guild row is hard-deleted and the FK
 *      cascade takes channels, messages, attachments, roles, members, invites,
 *      emojis, stickers and webhooks with it. The files come off disk here
 *      rather than waiting for the GC sweep.
 *
 *   2. A deleted account keeps its DM conversations, under the old username.
 *      That is a deliberate product decision: a one-to-one conversation is
 *      also the OTHER person's history, and blanking half of it destroys
 *      something that isn't solely the leaver's. So the user row survives as a
 *      TOMBSTONE — id, username and display name, nothing else — and every
 *      other trace goes. Server messages, files, reactions and votes are
 *      deleted outright.
 *
 *   3. Moderation records survive both. Deleting a server (or an account) is
 *      otherwise the cheapest way to erase the evidence that it was reported.
 *      `reports` and `security_events` keep their rows; their `guild_id` is
 *      nulled by the FK and the server's name is snapshotted first so staff can
 *      still read what happened (migration 0124).
 *
 * The tombstone is why `users.deleted_at` exists but was never written by
 * anything until now: every read path already filters on it, so a tombstoned
 * account is automatically absent from logins, the gateway, user search,
 * member lists and admin counts — while message and DM-recipient joins, which
 * do NOT filter it, still resolve the old name.
 */

import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { log } from '../log';
import { rollbackChannelWatermarks } from './messages';
import { deleteAttachmentFile, parseCdnAttachmentId } from './uploads';

/** Messages are deleted in batches so one huge account or server can't hold a
 *  single statement (and its locks) open for minutes. */
const BATCH = 500;

export interface PurgeResult {
  /** Message rows removed. */
  messages: number;
  /** Upload directories removed from disk. */
  files: number;
}

/** Best-effort disk cleanup. A file that survives is picked up by the
 *  attachment GC later; a throw here must never fail the purge. */
async function removeFiles(ids: Iterable<bigint>): Promise<number> {
  let n = 0;
  for (const id of ids) {
    try {
      await deleteAttachmentFile(id);
      n++;
    } catch (err) {
      log.warn('purge: file delete failed', { attachmentId: id.toString(), err });
    }
  }
  return n;
}

function collectCdnId(into: Set<bigint>, url: string | null | undefined): void {
  const id = parseCdnAttachmentId(url);
  if (id) into.add(id);
}

/**
 * Hard-delete a guild and everything under it.
 *
 * Ordering matters: the moderation snapshot has to be written while the rows
 * still point at the guild, and the attachment ids have to be read while the
 * messages still exist — after the cascade there is nothing left to join.
 */
export async function purgeGuild(guildId: bigint): Promise<PurgeResult> {
  const [guild] = await db
    .select({
      name: schema.guilds.name,
      iconUrl: schema.guilds.iconUrl,
      bannerUrl: schema.guilds.bannerUrl,
    })
    .from(schema.guilds)
    .where(eq(schema.guilds.id, guildId))
    .limit(1);
  if (!guild) return { messages: 0, files: 0 };

  // 1. Keep the moderation trail readable after the server is gone.
  await db
    .update(schema.reports)
    .set({ guildName: guild.name })
    .where(eq(schema.reports.guildId, guildId));
  await db
    .update(schema.securityEvents)
    .set({ guildName: guild.name })
    .where(eq(schema.securityEvents.guildId, guildId));

  // 2. Everything on disk that belongs to this server.
  const files = new Set<bigint>();
  collectCdnId(files, guild.iconUrl);
  collectCdnId(files, guild.bannerUrl);

  const attachmentRows = await db
    .select({ id: schema.attachments.id })
    .from(schema.attachments)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.attachments.messageId))
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(eq(schema.channels.guildId, guildId));
  for (const row of attachmentRows) files.add(row.id);

  const emojiRows = await db
    .select({ url: schema.guildEmojis.url })
    .from(schema.guildEmojis)
    .where(eq(schema.guildEmojis.guildId, guildId));
  for (const row of emojiRows) collectCdnId(files, row.url);

  const stickerRows = await db
    .select({ url: schema.stickers.url })
    .from(schema.stickers)
    .where(eq(schema.stickers.guildId, guildId));
  for (const row of stickerRows) collectCdnId(files, row.url);

  const memberAvatarRows = await db
    .select({ url: schema.guildMembers.avatarUrl })
    .from(schema.guildMembers)
    .where(and(eq(schema.guildMembers.guildId, guildId), isNotNull(schema.guildMembers.avatarUrl)));
  for (const row of memberAvatarRows) collectCdnId(files, row.url);

  const webhookRows = await db
    .select({ url: schema.webhooks.avatarUrl })
    .from(schema.webhooks)
    .where(and(eq(schema.webhooks.guildId, guildId), isNotNull(schema.webhooks.avatarUrl)));
  for (const row of webhookRows) collectCdnId(files, row.url);

  const [counted] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(schema.messages)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(eq(schema.channels.guildId, guildId));

  // 3. One statement; Postgres cascades the rest.
  await db.delete(schema.guilds).where(eq(schema.guilds.id, guildId));

  const removed = await removeFiles(files);
  return { messages: counted?.n ?? 0, files: removed };
}

/**
 * Delete every message this user wrote OUTSIDE a DM, with its attachments.
 * DM channels have `guild_id IS NULL`, which is exactly the line between "their
 * content in someone else's conversation" and "their content in a shared one".
 */
async function purgeServerMessages(userId: bigint): Promise<PurgeResult> {
  let messages = 0;
  const files = new Set<bigint>();

  for (;;) {
    const rows = await db
      .select({ id: schema.messages.id, channelId: schema.messages.channelId })
      .from(schema.messages)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
      .where(and(eq(schema.messages.authorId, userId), isNotNull(schema.channels.guildId)))
      .limit(BATCH);
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const attachmentRows = await db
      .select({ id: schema.attachments.id })
      .from(schema.attachments)
      .where(inArray(schema.attachments.messageId, ids));
    for (const row of attachmentRows) files.add(row.id);

    await db.delete(schema.messages).where(inArray(schema.messages.id, ids));
    messages += ids.length;
    // A channel whose newest message was theirs keeps a watermark naming a
    // row that is gone: unread forever, and an ack of it 404s. Move it back
    // to what is left, as a delete does. Best-effort: never fail the purge.
    try {
      await rollbackChannelWatermarks([...new Set(rows.map((r) => r.channelId))], ids);
    } catch (err) {
      log.warn('purge: channel watermark rollback failed', { err });
    }
    if (rows.length < BATCH) break;
  }

  const removed = await removeFiles(files);
  return { messages, files: removed };
}

/**
 * Delete the account: scrub the row to a tombstone, drop every piece of
 * personal data, and purge their server content. DM history stays.
 *
 * The caller is responsible for the things that belong to the request rather
 * than the data: re-auth, closing the user's sockets, revoking sessions and
 * writing the audit entry.
 */
export async function purgeAccount(userId: bigint): Promise<PurgeResult> {
  const [user] = await db
    .select({
      username: schema.users.username,
      avatarUrl: schema.users.avatarUrl,
      bannerUrl: schema.users.bannerUrl,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) throw errors.notFound('User');

  const result = await purgeServerMessages(userId);

  // Their reactions and votes in servers go with the rest of their server
  // activity. The DM ones stay, for the same reason the DM messages do.
  const serverMessageIds = db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
    .where(isNotNull(schema.channels.guildId));
  await db
    .delete(schema.reactions)
    .where(
      and(
        eq(schema.reactions.userId, userId),
        inArray(schema.reactions.messageId, serverMessageIds),
      ),
    );
  await db.delete(schema.pollVotes).where(eq(schema.pollVotes.userId, userId));

  const profileFiles = new Set<bigint>();
  collectCdnId(profileFiles, user.avatarUrl);
  collectCdnId(profileFiles, user.bannerUrl);

  await db.transaction(async (tx) => {
    // ── Credentials and devices ──────────────────────────────────────────
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    await tx.delete(schema.apnsDeviceTokens).where(eq(schema.apnsDeviceTokens.userId, userId));
    await tx.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
    await tx
      .delete(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, userId));
    await tx.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, userId));
    await tx.delete(schema.emailVerifications).where(eq(schema.emailVerifications.userId, userId));
    await tx
      .delete(schema.emailChangeRequests)
      .where(eq(schema.emailChangeRequests.userId, userId));
    await tx.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, userId));

    // ── Social graph, preferences, activity ──────────────────────────────
    await tx
      .delete(schema.relationships)
      .where(
        or(
          eq(schema.relationships.userId, userId),
          eq(schema.relationships.targetId, userId),
        ),
      );
    await tx.delete(schema.readStates).where(eq(schema.readStates.userId, userId));
    await tx.delete(schema.savedMessages).where(eq(schema.savedMessages.userId, userId));
    await tx
      .delete(schema.notificationOverrides)
      .where(eq(schema.notificationOverrides.userId, userId));
    await tx
      .delete(schema.dmNotificationPrefs)
      .where(eq(schema.dmNotificationPrefs.userId, userId));
    await tx.delete(schema.dmNicknames).where(eq(schema.dmNicknames.ownerId, userId));
    await tx.delete(schema.userAchievements).where(eq(schema.userAchievements.userId, userId));
    await tx.delete(schema.userVoiceStats).where(eq(schema.userVoiceStats.userId, userId));
    await tx
      .delete(schema.pokes)
      .where(or(eq(schema.pokes.initiatorId, userId), eq(schema.pokes.recipientId, userId)));
    await tx
      .delete(schema.pokeTallies)
      .where(
        or(eq(schema.pokeTallies.initiatorId, userId), eq(schema.pokeTallies.recipientId, userId)),
      );
    await tx
      .delete(schema.messageUserMentions)
      .where(eq(schema.messageUserMentions.userId, userId));
    await tx.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));
    // Queued sends would otherwise sit in the table (their text is theirs) and
    // be retried against a deleted author until they fail out.
    await tx
      .delete(schema.scheduledMessages)
      .where(eq(schema.scheduledMessages.authorId, userId));

    // ── Memberships and live state ───────────────────────────────────────
    await tx.delete(schema.memberRoles).where(eq(schema.memberRoles.userId, userId));
    await tx.delete(schema.guildMembers).where(eq(schema.guildMembers.userId, userId));
    await tx.delete(schema.voiceStates).where(eq(schema.voiceStates.userId, userId));
    await tx.delete(schema.stageParticipants).where(eq(schema.stageParticipants.userId, userId));

    // ── Supervision links (both directions) ──────────────────────────────
    await tx
      .delete(schema.parentChildLinks)
      .where(
        or(
          eq(schema.parentChildLinks.childId, userId),
          eq(schema.parentChildLinks.parentId, userId),
        ),
      );
    await tx.delete(schema.childRestrictions).where(eq(schema.childRestrictions.childId, userId));
    await tx.delete(schema.childWatchWords).where(eq(schema.childWatchWords.childId, userId));
    await tx.delete(schema.childBlockedGuilds).where(eq(schema.childBlockedGuilds.childId, userId));

    // ── The tombstone ────────────────────────────────────────────────────
    // Everything that identifies the person goes; the name stays so their side
    // of a DM still reads as a conversation with someone rather than a blank.
    // The email is rewritten rather than nulled (NOT NULL, and unique) so the
    // address is free for a new signup.
    await tx
      .update(schema.users)
      .set({
        deletedAt: new Date(),
        email: `deleted-${userId}@deleted.invalid`,
        emailVerified: false,
        passwordHash: '',
        dateOfBirth: null,
        avatarUrl: null,
        bannerUrl: null,
        bio: null,
        avatarDecoration: null,
        customStatus: null,
        customStatusEmoji: null,
        customStatusExpiresAt: null,
        lastSeenAt: null,
        locale: 'en-US',
        isAdmin: false,
        isModerator: false,
        staffColor: null,
        staffGlow: false,
        tagLabel: null,
        tagColor: null,
        totpSecret: null,
        totpEnabled: false,
        totpVerifiedAt: null,
        totpLastStep: null,
        botTokenHash: null,
        botEventUrl: null,
        botEventSecret: null,
        guildOrder: null,
        guildFolders: [],
        voicePrefs: {},
        mentionsClearedMessageId: null,
        publicKey: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId));
  });

  result.files += await removeFiles(profileFiles);
  return result;
}
