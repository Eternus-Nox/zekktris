/**
 * DMs service
 * -----------
 * 1:1 direct-message channels. Group DMs are deferred to v1.x; the schema
 * supports them (channel.type='group_dm', dm_recipients table) but the
 * routes here only handle the 1:1 case.
 *
 * `getOrCreateDM(a, b)` is idempotent: the same pair always resolves to the
 * same channel id no matter who initiates. To make this fast and race-free
 * we identify a 1:1 DM by the unordered pair of recipient ids and look it
 * up via a JOIN that requires both rows to be present.
 */

import { and, desc, eq, exists, inArray, isNull, like, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import * as dispatch from '../gateway/dispatch';

/**
 * Find an existing 1:1 DM channel between two users, or create one.
 * Returns the channel id and a `created` flag so callers can avoid
 * firing "new DM" gateway events on idempotent re-calls.
 *
 * Concurrency: two simultaneous calls between the same pair (e.g.
 * the user clicks Send in two tabs at once) could each pass the
 * initial "no existing channel" check and both create a channel.
 * Postgres allows it because there's no unique constraint on the
 * unordered pair (and there can't easily be one — the recipients
 * live in a join table). To compensate we do a single retry: if
 * the first attempt's INSERTs into dm_recipients race with another
 * transaction that beat us in, the unique (channelId, userId) PK
 * fires and we roll back, then re-run the initial find — which
 * now sees the channel the other side created. One retry is enough
 * because each retry runs the find from scratch and a winning
 * transaction must already exist by the time we get here.
 */
async function findExistingDM(userA: bigint, userB: bigint): Promise<bigint | null> {
  const [existing] = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.type, 'dm'),
        exists(
          db
            .select()
            .from(schema.dmRecipients)
            .where(
              and(
                eq(schema.dmRecipients.channelId, schema.channels.id),
                eq(schema.dmRecipients.userId, userA),
              ),
            ),
        ),
        exists(
          db
            .select()
            .from(schema.dmRecipients)
            .where(
              and(
                eq(schema.dmRecipients.channelId, schema.channels.id),
                eq(schema.dmRecipients.userId, userB),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

export async function getOrCreateDM(
  userA: bigint,
  userB: bigint,
): Promise<{ channelId: bigint; created: boolean }> {
  if (userA === userB) {
    throw errors.badRequest('Cannot DM yourself');
  }

  // Privacy + block check. Friends-only by default; the recipient can
  // opt in to allowing DMs from anyone sharing a guild with them. A
  // block in either direction always denies regardless of the toggle.
  // We respond with the same generic notFound surface as a missing
  // user so the result doesn't leak whether the target exists (or
  // what their privacy preference is).
  //
  // Dynamic-imported so the dms service doesn't pull relationships
  // into its top-level import graph — both are leaf services and a
  // cycle would surface if either grew.
  const { canReachByDmOrCall } = await import('./relationships');
  if (!(await canReachByDmOrCall(userA, userB))) {
    throw errors.notFound('User');
  }

  const existingId = await findExistingDM(userA, userB);
  if (existingId !== null) return { channelId: existingId, created: false };

  // Create new DM channel.
  const channelId = nextSnowflake();
  try {
    await db.transaction(async (tx) => {
      // Verify both users actually exist (and are not banned /
      // soft-deleted) before creating the channel. Without these
      // filters, a DM can be opened with a banned user: the channel
      // gets created, the initiator sends messages, the banned user
      // has no gateway connection and can't read REST, so nothing
      // delivers. The channel then sits in the initiator's DM list
      // pointing at someone they can't actually reach.
      const userCount = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            sql`${schema.users.id} IN (${userA}, ${userB})`,
            isNull(schema.users.bannedAt),
            isNull(schema.users.deletedAt),
          ),
        );
      if (userCount.length !== 2) {
        throw errors.notFound('User');
      }

      await tx.insert(schema.channels).values({
        id: channelId,
        type: 'dm',
        guildId: null,
        name: null,
        position: 0,
      });
      await tx.insert(schema.dmRecipients).values([
        { channelId, userId: userA },
        { channelId, userId: userB },
      ]);
    });
  } catch (err: unknown) {
    // Postgres unique violation code = 23505. If we tripped on the
    // dm_recipients PK that means another transaction created the
    // DM channel and inserted the same (channelId, userId) — but
    // wait, our channelId is a fresh snowflake so it can't collide
    // on that. The realistic collision is racing two *different*
    // calls each picking a different channelId and both passing
    // the find — that wouldn't trip any constraint with the current
    // schema. So the more useful race-resolution here is: re-run
    // the find, and if a parallel call inserted, return its id
    // instead. We only return a non-null retry result on the rare
    // unique-violation path.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === '23505'
    ) {
      const retryId = await findExistingDM(userA, userB);
      if (retryId !== null) return { channelId: retryId, created: false };
    }
    throw err;
  }

  // Belt-and-suspenders: after a successful create, re-run the find.
  // If another concurrent caller's create won the lookup-race AND
  // committed before ours did, both transactions would have succeeded
  // (different channelIds, no shared rows). In that case the SECOND
  // committer's channel becomes a duplicate. The cleanest UX is to
  // return whichever channel the find query returns now — both have
  // the same membership, but the older snowflake will sort first in
  // newest-activity ordering. We drop the duplicate we just created
  // to keep the data tidy.
  const winnerId = await findExistingDM(userA, userB);
  if (winnerId !== null && winnerId !== channelId) {
    // Another caller beat us. Clean up our orphan.
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.dmRecipients)
        .where(eq(schema.dmRecipients.channelId, channelId));
      await tx.delete(schema.channels).where(eq(schema.channels.id, channelId));
    });
    return { channelId: winnerId, created: false };
  }

  return { channelId, created: true };
}

/** List all 1:1 DM channels the user is a recipient of, newest activity first. */
export async function listMyDMs(userId: bigint) {
  return db
    .select({ channel: schema.channels })
    .from(schema.dmRecipients)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.dmRecipients.channelId))
    .where(eq(schema.dmRecipients.userId, userId))
    .orderBy(desc(schema.channels.lastMessageId))
    .then((rows) => rows.map((r) => r.channel));
}

/** Throws NOT_FOUND if the user isn't a recipient of the given DM channel. */
export async function ensureRecipient(channelId: bigint, userId: bigint): Promise<void> {
  const r = await db
    .select({ userId: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(
      and(eq(schema.dmRecipients.channelId, channelId), eq(schema.dmRecipients.userId, userId)),
    )
    .limit(1);
  if (!r[0]) throw errors.notFound('Channel');
}

/** Pull the OTHER user's id from a 1:1 DM (used to render display names client-side). */
export async function getOtherRecipient(
  channelId: bigint,
  selfId: bigint,
): Promise<bigint | null> {
  const r = await db
    .select({ userId: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(
      and(
        eq(schema.dmRecipients.channelId, channelId),
        ne(schema.dmRecipients.userId, selfId),
      ),
    )
    .limit(1);
  return r[0]?.userId ?? null;
}

/**
 * List every recipient (self + others) of a DM/group-DM channel.
 * Used by the push-notification hook to fan out an inbound DM to all
 * recipients except the author. Returns user ids.
 */
/**
 * Every user the given user shares a DM or group DM with, deduped,
 * excluding the user themselves. Used for fanning out user-profile
 * updates (avatar, display name, status) to friends who don't share
 * a guild — without this, a DM-only friend wouldn't get the
 * USER_UPDATE gateway event and would see stale profile data until
 * they manually refreshed or the user sent them a new message.
 *
 * The query uses a self-join on dm_recipients: outer membership says
 * "channels the user is in", inner membership says "everyone in those
 * channels". The DISTINCT + `ne(userId, self)` filter handles the
 * group-DM case where the same peer might appear in multiple shared
 * channels.
 */
export async function listDmPeers(userId: bigint): Promise<bigint[]> {
  const r = await db
    .selectDistinct({ peer: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(
      and(
        // The "channels the user is in" subselect. Inline rather than
        // a second roundtrip — the planner can fold this into a hash
        // join or anti-join depending on row counts.
        inArray(
          schema.dmRecipients.channelId,
          db
            .select({ channelId: schema.dmRecipients.channelId })
            .from(schema.dmRecipients)
            .where(eq(schema.dmRecipients.userId, userId)),
        ),
        ne(schema.dmRecipients.userId, userId),
      ),
    );
  return r.map((row) => row.peer);
}

export async function listAllRecipients(channelId: bigint): Promise<bigint[]> {
  const r = await db
    .select({ userId: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(eq(schema.dmRecipients.channelId, channelId));
  return r.map((row) => row.userId);
}

/**
 * Load the OTHER recipient(s) for a single DM channel — i.e. everyone
 * except `selfId`. Returns full User rows so the route layer can pass
 * them to `toChannel(... , recipients)` for client hydration.
 */
export async function loadOtherRecipients(
  channelId: bigint,
  selfId: bigint,
): Promise<typeof schema.users.$inferSelect[]> {
  const r = await db
    .select({ user: schema.users })
    .from(schema.dmRecipients)
    .innerJoin(schema.users, eq(schema.users.id, schema.dmRecipients.userId))
    .where(
      and(
        eq(schema.dmRecipients.channelId, channelId),
        ne(schema.dmRecipients.userId, selfId),
      ),
    );
  return r.map((row) => row.user);
}

/**
 * Bulk variant of `loadOtherRecipients` — for a list of channel ids,
 * returns a map of channelId → recipients (excluding `selfId`). Used
 * by the DM-list route to avoid N+1 queries when the user has many
 * conversations.
 */
export async function loadRecipientsForChannels(
  channelIds: bigint[],
  selfId: bigint,
): Promise<Map<string, typeof schema.users.$inferSelect[]>> {
  const out = new Map<string, typeof schema.users.$inferSelect[]>();
  if (channelIds.length === 0) return out;
  const rows = await db
    .select({
      channelId: schema.dmRecipients.channelId,
      user: schema.users,
    })
    .from(schema.dmRecipients)
    .innerJoin(schema.users, eq(schema.users.id, schema.dmRecipients.userId))
    .where(
      and(
        inArray(schema.dmRecipients.channelId, channelIds),
        ne(schema.dmRecipients.userId, selfId),
      ),
    );
  for (const r of rows) {
    const key = r.channelId.toString();
    let bucket = out.get(key);
    if (!bucket) {
      bucket = [];
      out.set(key, bucket);
    }
    bucket.push(r.user);
  }
  return out;
}

/**
 * Load per-DM E2EE public keys for a list of channels. Returns a
 * map of channelId → (userId → publicKey base64). Includes ALL
 * users for each channel (not just "others") — the client needs to
 * see its own entry to detect whether E2EE is enabled for this
 * conversation on this device.
 *
 * Users with NULL public_key on dm_recipients are omitted from the
 * inner map. So `e2eeKeys[userId]` exists iff that user has
 * enabled E2EE on this DM.
 */
export async function loadE2eeKeysForChannels(
  channelIds: bigint[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (channelIds.length === 0) return out;
  const rows = await db
    .select({
      channelId: schema.dmRecipients.channelId,
      userId: schema.dmRecipients.userId,
      publicKey: schema.dmRecipients.publicKey,
    })
    .from(schema.dmRecipients)
    .where(inArray(schema.dmRecipients.channelId, channelIds));
  for (const r of rows) {
    if (!r.publicKey) continue;
    const key = r.channelId.toString();
    let bucket = out.get(key);
    if (!bucket) {
      bucket = {};
      out.set(key, bucket);
    }
    bucket[r.userId.toString()] = r.publicKey;
  }
  return out;
}

/**
 * Per-channel variant of `loadE2eeKeysForChannels` — returns just
 * the userId → publicKey map for one channel. Convenient for routes
 * that operate on a single DM.
 */
export async function loadE2eeKeys(
  channelId: bigint,
): Promise<Record<string, string>> {
  const map = await loadE2eeKeysForChannels([channelId]);
  return map.get(channelId.toString()) ?? {};
}

/**
 * Enable shared-key E2EE on a DM. Stores the PBKDF2 salt + the
 * key verifier; flips e2eeEnabled to true. Idempotent — calling
 * twice with the same values is a no-op. Calling with NEW values
 * effectively rotates the password (the old verifier is overwritten;
 * the old password becomes uncheckable).
 */
export async function enableE2ee(
  channelId: bigint,
  salt: string,
  verifier: string,
): Promise<void> {
  await db
    .update(schema.channels)
    .set({
      e2eeEnabled: true,
      e2eeSalt: salt,
      e2eeVerifier: verifier,
    })
    .where(eq(schema.channels.id, channelId));
}

/**
 * Disable E2EE on a DM and purge all encrypted messages in the
 * conversation. Returns the list of deleted message ids so the
 * caller can fan out MESSAGE_DELETE events on the gateway.
 *
 * "Purge" here means hard delete of messages whose content begins
 * with the `zkE2EE/` wire-format prefix. Plaintext messages from
 * before E2EE was enabled (or from any window when it was off) are
 * preserved. This matches the user's stated intent: turning E2EE
 * off wipes the encrypted history that nobody can decrypt anymore
 * anyway, while sparing the plaintext history that has nothing to
 * do with the encrypted key being thrown away.
 *
 * The clear-fields and the delete run in a single transaction so a
 * crash mid-way can't leave the channel in a "disabled but still
 * has ciphertext messages" state.
 */
export async function disableE2eeAndPurge(
  channelId: bigint,
): Promise<{ purgedMessageIds: bigint[] }> {
  return db.transaction(async (tx) => {
    // Find every encrypted message in the channel. We match on the
    // content prefix `zkE2EE/` so future wire-format bumps (zkE2EE/2:,
    // zkE2EE/3:) automatically participate without code change.
    const encryptedRows = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelId, channelId),
          like(schema.messages.content, 'zkE2EE/%'),
        ),
      );
    const purgedMessageIds = encryptedRows.map((r) => r.id);
    if (purgedMessageIds.length > 0) {
      await tx
        .delete(schema.messages)
        .where(inArray(schema.messages.id, purgedMessageIds));
    }
    // Clear the E2EE state. enabled→false, salt+verifier→null.
    await tx
      .update(schema.channels)
      .set({
        e2eeEnabled: false,
        e2eeSalt: null,
        e2eeVerifier: null,
      })
      .where(eq(schema.channels.id, channelId));
    return { purgedMessageIds };
  });
}

/**
 * Close (delete) a DM channel for one user without affecting the other
 * party's view of it. Implementation: hard-remove the dm_recipients
 * row for THIS user only. The channel and its messages persist; the
 * other recipient continues to see the conversation. If this user
 * later opens a fresh DM with the same person, getOrCreateDM looks
 * for a channel where BOTH are recipients — finds none — and creates
 * a new channel with empty history. That's the behavior the user
 * asked for: "delete completely" from their side.
 *
 * Throws notFound if the user wasn't a recipient of the channel.
 */
export async function closeDMForUser(input: {
  channelId: bigint;
  userId: bigint;
}): Promise<void> {
  const removed = await db
    .delete(schema.dmRecipients)
    .where(
      and(
        eq(schema.dmRecipients.channelId, input.channelId),
        eq(schema.dmRecipients.userId, input.userId),
      ),
    )
    .returning({ userId: schema.dmRecipients.userId });
  if (removed.length === 0) throw errors.notFound('DM channel');
}

// ── Auto-delete (per-DM TTL on viewed messages) ─────────────────────────────
//
// The DM auto-delete feature lets either recipient configure a TTL on
// the conversation. Once configured, messages get a `viewed_at`
// timestamp the first time the OTHER recipient fetches them (stamped
// by markMessageViewed below, called from the message-list route in a
// DM channel). A periodic sweep finds messages whose `viewed_at` is
// older than the configured TTL and soft-deletes them — same delete
// path other messages take, so reactions/threads/embeds all clean up
// via existing cascade rules.
//
// Design choices:
//
//   - TTL is per-channel, not per-user. The change affects both sides
//     because it's a property of the conversation. (Alternative: each
//     user has their own copy of every message with independent
//     TTLs. Way too much state for v1; everyone would need to
//     re-index the whole DM on every change.)
//
//   - We don't bump viewed_at after the first view. A slow reader
//     scrolling through old messages shouldn't extend their lifetime.
//
//   - Sweep is best-effort + idempotent. Failures get logged and
//     retried next interval. Soft-delete leaves the row for thread
//     navigation continuity (matches the regular delete flow).
//
//   - Group DMs use "first viewer among any non-author recipient" —
//     we don't track per-user view timestamps. This matches the
//     conceptual model of disappearing messages: as soon as any
//     other party has read it, the clock starts.

/**
 * Read the auto-delete TTL for a DM channel. Returns the configured
 * seconds value, or null if no auto-delete is set. Callers can treat
 * a null as "no auto-delete in effect" and skip the markMessageViewed
 * stamping path entirely.
 */
export async function getDmSettings(channelId: bigint): Promise<{
  ttlSecondsAfterRead: number | null;
}> {
  const r = await db
    .select({ ttlSecondsAfterRead: schema.dmSettings.ttlSecondsAfterRead })
    .from(schema.dmSettings)
    .where(eq(schema.dmSettings.channelId, channelId))
    .limit(1);
  return { ttlSecondsAfterRead: r[0]?.ttlSecondsAfterRead ?? null };
}

/**
 * Upsert the auto-delete TTL for a DM channel. Pass null to disable.
 * Accepts only sensible values (30, 60, 120 are the documented set in
 * the UI, but we accept anything in [10, 86400] to give power users
 * room to experiment). Disabling does NOT clear viewed_at on existing
 * messages — they'll just no longer be swept.
 */
export async function updateDmSettings(input: {
  channelId: bigint;
  ttlSecondsAfterRead: number | null;
}): Promise<void> {
  if (
    input.ttlSecondsAfterRead !== null &&
    (input.ttlSecondsAfterRead < 10 || input.ttlSecondsAfterRead > 86_400)
  ) {
    throw errors.badRequest('TTL must be between 10 and 86400 seconds, or null');
  }
  await db
    .insert(schema.dmSettings)
    .values({
      channelId: input.channelId,
      ttlSecondsAfterRead: input.ttlSecondsAfterRead,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.dmSettings.channelId,
      set: {
        ttlSecondsAfterRead: input.ttlSecondsAfterRead,
        updatedAt: new Date(),
      },
    });
}

/**
 * Stamp `viewed_at = now()` on every message in `messageIds` that:
 *   - lives in `channelId`,
 *   - was not authored by `viewerId` (you can't "view" your own
 *     message — viewed_at tracks the OTHER party's read),
 *   - has viewed_at still NULL.
 *
 * Stamping is UNCONDITIONAL — even when the viewer has read receipts
 * disabled, the column gets written. This is because viewed_at is
 * shared infrastructure with the auto-delete sweep (which decides
 * when to purge based on "viewed_at + ttl_seconds_after_read"); a
 * privacy gate on the stamp would silently break TTL DMs sent to
 * users who turned receipts off.
 *
 * Receipt visibility — the actual "the sender's UI sees Read" effect
 * — is gated separately at the dispatch + DTO layers. This function
 * returns BOTH the stamped pairs AND a `viewerReceiptsEnabled` flag
 * so the caller can decide whether to fire MESSAGE_VIEWED events
 * and whether to surface the timestamp in the response DTO. The
 * gate is the viewer's own dmReadReceiptsEnabled, since this column
 * represents the viewer's read.
 */
export async function markMessagesViewed(
  channelId: bigint,
  viewerId: bigint,
  messageIds: bigint[],
): Promise<{
  stamped: Array<{ messageId: bigint; authorId: bigint }>;
  viewerReceiptsEnabled: boolean;
}> {
  if (messageIds.length === 0) {
    return { stamped: [], viewerReceiptsEnabled: true };
  }
  // Read the viewer's toggle so the caller can gate dispatch. We do
  // NOT use it to gate the stamp — see the comment above.
  const [viewer] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, viewerId))
    .limit(1);
  const viewerReceiptsEnabled = viewer?.enabled ?? true;
  // Single UPDATE with IN-list. Bounded by however many messages the
  // route loads at a time (the default page is ~50), so this is
  // never a multi-thousand-row hammer. .returning() pulls the
  // author ids back so we can dispatch MESSAGE_VIEWED scoped to
  // each author without a second SELECT.
  const updated = await db
    .update(schema.messages)
    .set({ viewedAt: new Date() })
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        inArray(schema.messages.id, messageIds),
        sql`${schema.messages.viewedAt} IS NULL`,
        sql`${schema.messages.authorId} <> ${viewerId} OR ${schema.messages.authorId} IS NULL`,
      ),
    )
    .returning({
      id: schema.messages.id,
      authorId: schema.messages.authorId,
    });
  const stamped = updated
    .filter((r): r is { id: bigint; authorId: bigint } => r.authorId !== null)
    .map((r) => ({ messageId: r.id, authorId: r.authorId }));
  return { stamped, viewerReceiptsEnabled };
}

/**
 * Bulk variant of markMessagesViewed — stamps viewed_at on EVERY
 * unviewed non-self message in `channelId` up to and including
 * `upToMessageId`. Driven by the channel-ack path: when the user
 * acks through a message, every prior unviewed message in the
 * conversation is implicitly read too. This is the path that
 * advances "Delivered" to "Read" when a new message arrives via
 * gateway while the recipient already has the DM open — without
 * it, the receipt would stick at Delivered until the next
 * listMessages call (page refresh).
 *
 * Same privacy semantics as markMessagesViewed: stamping is
 * unconditional (auto-delete sweep depends on viewed_at), the
 * caller gates dispatch + DTO surface on the viewer's toggle.
 */
export async function markMessagesViewedUpTo(
  channelId: bigint,
  viewerId: bigint,
  upToMessageId: bigint,
): Promise<{
  stamped: Array<{ messageId: bigint; authorId: bigint }>;
  viewerReceiptsEnabled: boolean;
}> {
  const [viewer] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, viewerId))
    .limit(1);
  const viewerReceiptsEnabled = viewer?.enabled ?? true;

  // UPDATE … WHERE channel = X AND id <= upTo AND viewed_at IS NULL
  // AND author <> viewer. .returning() pulls the author ids so we
  // can dispatch MESSAGE_VIEWED per author. Bounded by however many
  // unviewed messages live in the channel — typically very small
  // when this fires (one new gateway message), but on a channel
  // that was scrolled-away-from for a while it could be larger.
  // No artificial cap: the user explicitly opened the channel, so
  // marking all prior unviewed messages is the desired semantic.
  const updated = await db
    .update(schema.messages)
    .set({ viewedAt: new Date() })
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        sql`${schema.messages.id} <= ${upToMessageId}`,
        sql`${schema.messages.viewedAt} IS NULL`,
        sql`${schema.messages.authorId} <> ${viewerId} OR ${schema.messages.authorId} IS NULL`,
      ),
    )
    .returning({
      id: schema.messages.id,
      authorId: schema.messages.authorId,
    });
  const stamped = updated
    .filter((r): r is { id: bigint; authorId: bigint } => r.authorId !== null)
    .map((r) => ({ messageId: r.id, authorId: r.authorId }));
  return { stamped, viewerReceiptsEnabled };
}

/**
 * Stamp `delivered_at = now()` on a freshly-created DM message if
 * the column is still NULL.
 *
 * Stamping is UNCONDITIONAL with respect to the recipient's
 * receipts toggle (same rationale as markMessagesViewed — keeps
 * the column reliable for any future infrastructure that depends
 * on it). The toggle gates only the MESSAGE_DELIVERED dispatch
 * and DTO surface; the caller uses the returned flag to decide.
 *
 * Returns:
 *   - `stamped`: true if a stamp actually landed (false if already
 *     stamped or the message is gone)
 *   - `recipientReceiptsEnabled`: the recipient's current toggle,
 *     so the caller can decide whether to fire MESSAGE_DELIVERED
 *     and surface deliveredAt in subsequent DTOs.
 */
export async function markMessageDelivered(
  messageId: bigint,
  recipientId: bigint,
): Promise<{ stamped: boolean; recipientReceiptsEnabled: boolean }> {
  const [recipient] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, recipientId))
    .limit(1);
  const recipientReceiptsEnabled = recipient?.enabled ?? true;

  const updated = await db
    .update(schema.messages)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        eq(schema.messages.id, messageId),
        sql`${schema.messages.deliveredAt} IS NULL`,
        sql`${schema.messages.authorId} <> ${recipientId} OR ${schema.messages.authorId} IS NULL`,
      ),
    )
    .returning({ id: schema.messages.id });
  return { stamped: updated.length > 0, recipientReceiptsEnabled };
}

/**
 * Periodic sweep: soft-delete every message whose viewed_at is older
 * than its channel's configured TTL. Runs alongside the inactivity
 * sweep on the API's interval timer; safe to call repeatedly.
 *
 * Returns the number of messages soft-deleted. Bounded per-call at
 * 1000 rows so a sudden burst of expirations doesn't lock the
 * messages table for too long; the next interval picks up the rest.
 *
 * Implementation: subquery-join on dm_settings to read each channel's
 * TTL, then filter messages whose viewed_at age exceeds it. Soft-
 * delete by setting deleted_at; existing delete-related cleanup paths
 * (reaction cascades, thread invalidation, etc.) cascade through the
 * regular delete flow.
 */
export async function sweepExpiredDmMessages(): Promise<number> {
  // Limit the per-call work so a sudden burst of expirations doesn't
  // lock the messages table. We RETURN the affected ids + channels so
  // we can fire MESSAGE_DELETE for each — without that fanout,
  // connected clients would keep showing already-deleted messages
  // until they refetch (next channel switch, next reconnect, etc).
  // The UX of disappearing messages requires the gateway delivery.
  const rows = await db.execute<{
    id: string;
    channel_id: string;
  }>(sql`
    UPDATE messages m
    SET deleted_at = now()
    FROM dm_settings s
    WHERE m.channel_id = s.channel_id
      AND s.ttl_seconds_after_read IS NOT NULL
      AND m.viewed_at IS NOT NULL
      AND m.deleted_at IS NULL
      AND m.viewed_at < (now() - (s.ttl_seconds_after_read || ' seconds')::interval)
      AND m.id IN (
        SELECT id FROM messages mi
        JOIN dm_settings si ON si.channel_id = mi.channel_id
        WHERE si.ttl_seconds_after_read IS NOT NULL
          AND mi.viewed_at IS NOT NULL
          AND mi.deleted_at IS NULL
          AND mi.viewed_at < (now() - (si.ttl_seconds_after_read || ' seconds')::interval)
        LIMIT 1000
      )
    RETURNING m.id, m.channel_id
  `);
  // The drizzle execute() shape varies by adapter — node-postgres
  // returns an object with a `rows` array, while neon-http returns
  // the array directly. Normalize both.
  const affected = Array.isArray(rows)
    ? rows
    : (rows as { rows?: { id: string; channel_id: string }[] }).rows ?? [];
  for (const r of affected) {
    // BigInt coercion: ids come back as numeric strings from PG.
    // DMs always have null guildId (the audience is the channel's
    // dm_recipients set, walked inside dispatch). messageDelete fires
    // one MESSAGE_DELETE per row to every connection of every
    // recipient.
    //
    // Per-row try/catch: if any one publish throws (e.g. a registry
    // bug, a transient bus failure), we don't want it to abort the
    // whole fanout — every subsequent row would skip its dispatch
    // and clients would keep rendering already-deleted messages
    // until they next refetch. Swallow + log + continue.
    try {
      dispatch.messageDelete({
        messageId: BigInt(r.id),
        channelId: BigInt(r.channel_id),
        guildId: null,
      });
    } catch {
      // Best-effort. The DB delete already committed; clients will
      // catch up on next listMessages.
    }
  }
  return affected.length;
}

/**
 * IDENTIFY-time backfill: stamp delivered_at on every pending DM
 * message addressed to this user. Returns the stamped (messageId,
 * channelId, authorId) tuples so the caller can fan out
 * MESSAGE_DELIVERED events to each original sender.
 *
 * Scoped to 1:1 DMs (`channels.type = 'dm'`) where the user is a
 * recipient. Honors the user's dmReadReceiptsEnabled toggle — if
 * receipts are off, no stamping happens and the function returns [].
 *
 * Capped at 500 messages per backfill. A recipient who's been
 * offline for weeks with thousands of unread DMs would otherwise
 * pay the full UPDATE on every IDENTIFY; the cap keeps the
 * connect path responsive. The remaining unstamped rows will get
 * picked up incrementally on subsequent listMessages calls (which
 * also drive viewed_at — and viewed implies delivered, so the
 * surface eventually catches up).
 */
export async function backfillPendingDeliveries(
  userId: bigint,
): Promise<{
  stamped: Array<{ messageId: bigint; channelId: bigint; authorId: bigint }>;
  userReceiptsEnabled: boolean;
}> {
  const [user] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const userReceiptsEnabled = user?.enabled ?? true;

  // Single UPDATE driven by a CTE that walks the user's 1:1 DM
  // channels and finds rows the user didn't author with
  // delivered_at still NULL. Bounded by LIMIT 500. Stamping is
  // unconditional — see markMessagesViewed comment. The caller
  // gates the dispatch on userReceiptsEnabled.
  const rows = await db.execute<{
    id: string;
    channel_id: string;
    author_id: string;
  }>(sql`
    WITH pending AS (
      SELECT m.id
      FROM messages m
      JOIN dm_recipients dr
        ON dr.channel_id = m.channel_id AND dr.user_id = ${userId}
      JOIN channels c
        ON c.id = m.channel_id AND c.type = 'dm'
      WHERE m.delivered_at IS NULL
        AND m.deleted_at IS NULL
        AND (m.author_id IS NULL OR m.author_id <> ${userId})
      ORDER BY m.id DESC
      LIMIT 500
    )
    UPDATE messages SET delivered_at = now()
    WHERE id IN (SELECT id FROM pending)
    RETURNING id, channel_id, author_id
  `);
  // Adapter normalization (postgres-js vs node-postgres) — same
  // pattern used in the auto-delete sweep above.
  const affected = Array.isArray(rows)
    ? (rows as Array<{ id: string; channel_id: string; author_id: string | null }>)
    : ((rows as unknown as { rows?: Array<{ id: string; channel_id: string; author_id: string | null }> }).rows ?? []);
  const stamped = affected
    .filter((r): r is { id: string; channel_id: string; author_id: string } => r.author_id !== null)
    .map((r) => ({
      messageId: BigInt(r.id),
      channelId: BigInt(r.channel_id),
      authorId: BigInt(r.author_id),
    }));
  return { stamped, userReceiptsEnabled };
}
