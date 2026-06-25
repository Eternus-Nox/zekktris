/**
 * Notification settings service
 * -----------------------------
 * Per-user mute / level overrides for guilds and channels. The service
 * is intentionally small — most of the value of "mute server" is felt
 * inside the push pipeline (skip muted targets) and on the client
 * (skip badge increments). This file provides the storage primitives;
 * the push service consumes `resolveLevelsBulk` to decide whether to
 * fan out a notification.
 *
 * Resolution order for a (user, channel-in-guild) pair:
 *   1. Per-channel override, if any
 *   2. Per-guild override, if any
 *   3. Default: 'all'
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';

export type NotificationLevel = 'all' | 'mentions' | 'nothing';

export type NotificationOverrideDTO = {
  targetType: 'guild' | 'channel';
  targetId: string;
  level: NotificationLevel;
};

/**
 * Set or clear a per-target override. Passing `null` deletes the row
 * (back to "default"); passing a level upserts.
 */
export async function setOverride(
  userId: bigint,
  targetType: 'guild' | 'channel',
  targetId: bigint,
  level: NotificationLevel | null,
): Promise<void> {
  if (level === null) {
    await db
      .delete(schema.notificationOverrides)
      .where(
        and(
          eq(schema.notificationOverrides.userId, userId),
          eq(schema.notificationOverrides.targetType, targetType),
          eq(schema.notificationOverrides.targetId, targetId),
        ),
      );
    return;
  }
  await db
    .insert(schema.notificationOverrides)
    .values({ userId, targetType, targetId, level })
    .onConflictDoUpdate({
      target: [
        schema.notificationOverrides.userId,
        schema.notificationOverrides.targetType,
        schema.notificationOverrides.targetId,
      ],
      set: { level, updatedAt: new Date() },
    });
}

/**
 * Return every override row for a user. Used to hydrate the client's
 * AppState on connect so unread badges and notification UX respect
 * mutes immediately, without waiting for individual channel queries.
 */
export async function listOverrides(
  userId: bigint,
): Promise<NotificationOverrideDTO[]> {
  const rows = await db
    .select({
      targetType: schema.notificationOverrides.targetType,
      targetId: schema.notificationOverrides.targetId,
      level: schema.notificationOverrides.level,
    })
    .from(schema.notificationOverrides)
    .where(eq(schema.notificationOverrides.userId, userId));
  return rows.map((r) => ({
    targetType: r.targetType,
    targetId: r.targetId.toString(),
    level: r.level as NotificationLevel,
  }));
}

/**
 * Bulk variant of resolveLevel — given a single channel, returns each
 * user's effective level. Used by the push fan-out: we look up the
 * member list once then filter by level rather than running one
 * resolveLevel per user.
 *
 * Returns a Map<userId-string, NotificationLevel>. Users with no
 * override entries default to 'all' (caller should treat missing keys
 * the same as 'all' for safety).
 */
export async function resolveLevelsBulk(
  userIds: bigint[],
  channelId: bigint,
  guildId: bigint | null,
): Promise<Map<string, NotificationLevel>> {
  if (userIds.length === 0) return new Map();
  const targets: bigint[] = guildId !== null ? [channelId, guildId] : [channelId];
  const rows = await db
    .select({
      userId: schema.notificationOverrides.userId,
      targetType: schema.notificationOverrides.targetType,
      targetId: schema.notificationOverrides.targetId,
      level: schema.notificationOverrides.level,
    })
    .from(schema.notificationOverrides)
    .where(
      and(
        inArray(schema.notificationOverrides.userId, userIds),
        inArray(schema.notificationOverrides.targetId, targets),
      ),
    );

  // Bucket per user, then resolve via channel > guild > default.
  type Buckets = { channel?: NotificationLevel; guild?: NotificationLevel };
  const byUser = new Map<string, Buckets>();
  for (const r of rows) {
    const key = r.userId.toString();
    let b = byUser.get(key);
    if (!b) {
      b = {};
      byUser.set(key, b);
    }
    if (r.targetType === 'channel' && r.targetId === channelId) {
      b.channel = r.level as NotificationLevel;
    } else if (r.targetType === 'guild' && guildId !== null && r.targetId === guildId) {
      b.guild = r.level as NotificationLevel;
    }
  }
  const out = new Map<string, NotificationLevel>();
  for (const userId of userIds) {
    const b = byUser.get(userId.toString());
    out.set(userId.toString(), b?.channel ?? b?.guild ?? 'all');
  }
  return out;
}

/**
 * Users who EXPLICITLY opted into ALL-message notifications for this channel —
 * a channel-level 'all', or a guild-level 'all' not downgraded by a channel
 * override (resolution channel > guild). Drives the "get notifications from
 * servers too" push for ordinary (non-mention) guild messages.
 *
 * Crucially this is OPT-IN ONLY: it queries the notification_overrides table
 * (small, indexed) and never treats the implicit 'all' default as a
 * subscription — so a user with no override row gets NOTHING for non-mention
 * messages (otherwise every member would be fire-hosed on every message). The
 * caller must still filter the returned ids to channel VIEWERS and exclude the
 * author.
 */
export async function listChannelAllSubscribers(
  channelId: bigint,
  guildId: bigint | null,
): Promise<bigint[]> {
  const targets: bigint[] = guildId !== null ? [channelId, guildId] : [channelId];
  const rows = await db
    .select({
      userId: schema.notificationOverrides.userId,
      targetType: schema.notificationOverrides.targetType,
      targetId: schema.notificationOverrides.targetId,
      level: schema.notificationOverrides.level,
    })
    .from(schema.notificationOverrides)
    .where(inArray(schema.notificationOverrides.targetId, targets));

  type Buckets = { channel?: NotificationLevel; guild?: NotificationLevel };
  const byUser = new Map<string, { id: bigint; b: Buckets }>();
  for (const r of rows) {
    const key = r.userId.toString();
    let entry = byUser.get(key);
    if (!entry) {
      entry = { id: r.userId, b: {} };
      byUser.set(key, entry);
    }
    if (r.targetType === 'channel' && r.targetId === channelId) {
      entry.b.channel = r.level as NotificationLevel;
    } else if (r.targetType === 'guild' && guildId !== null && r.targetId === guildId) {
      entry.b.guild = r.level as NotificationLevel;
    }
  }
  const out: bigint[] = [];
  for (const { id, b } of byUser.values()) {
    if ((b.channel ?? b.guild) === 'all') out.push(id);
  }
  return out;
}

// Suppress unused-warning for sql tag we keep available to migrations.
void sql;
