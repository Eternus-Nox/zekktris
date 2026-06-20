/**
 * Channels service
 * ----------------
 * CRUD for `channels` rows plus the per-channel permission overrides that
 * live alongside them.
 *
 * Channel types:
 *   guild_text       a regular text channel inside a guild
 *   guild_category   a "folder" that other channels can have as parent
 *   guild_voice      reserved for v1.1, accepted by the schema; v1 routes
 *                    refuse to create these
 *   dm / group_dm    private message channels (handled by services/dm.ts
 *                    in stage 5; not created here)
 *
 * Categories cannot have a parent. Non-categories can either have a
 * category as parent or be top-level.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { writeAudit } from './audit';

type Channel = typeof schema.channels.$inferSelect;

export type GuildChannelType =
  | 'guild_text'
  | 'guild_category'
  | 'guild_voice'
  | 'guild_stage'
  | 'guild_forum'
  | 'guild_link';

export interface CreateChannelInput {
  guildId: bigint;
  actorId: bigint;
  type: GuildChannelType;
  name: string;
  topic?: string | null;
  parentId?: bigint | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  /** Required when type='guild_link'; rejected for any other type.
      Server validates the URL parses + uses http(s) scheme. */
  linkUrl?: string | null;
}

export async function createChannel(input: CreateChannelInput) {
  if (input.type === 'guild_category' && input.parentId) {
    throw errors.badRequest('Categories cannot have a parent');
  }
  // Link channels need a URL; non-link channels must not carry one
  // (silently dropping would be a footgun).
  if (input.type === 'guild_link') {
    if (!input.linkUrl) {
      throw errors.badRequest('Link channels require a URL');
    }
  } else if (input.linkUrl != null) {
    throw errors.badRequest('linkUrl is only valid for link channels');
  }

  await db.transaction(async (tx) => {
    if (input.parentId) {
      const parent = await tx
        .select({ id: schema.channels.id, type: schema.channels.type, guildId: schema.channels.guildId })
        .from(schema.channels)
        .where(and(
          eq(schema.channels.id, input.parentId),
          // Reject soft-deleted parents. Without this filter, a
          // moderator with MANAGE_CHANNELS can attach a new
          // channel to a category that was previously deleted —
          // and that category's permission overrides still flow
          // through the resolver (parent overrides are pulled by
          // parentId regardless of the parent's deletedAt). If
          // the deleted category had broad allows (a legitimate
          // grant from before its deletion), the new channel
          // inherits them, side-channeling elevated permissions.
          isNull(schema.channels.deletedAt),
        ))
        .limit(1);
      if (!parent[0]) throw errors.notFound('Parent channel');
      if (parent[0].guildId !== input.guildId) {
        throw errors.badRequest('Parent channel does not belong to this guild');
      }
      if (parent[0].type !== 'guild_category') {
        throw errors.badRequest('Parent must be a category');
      }
    }
  });

  // Place new channels at the end. Position is per-guild but the sort key
  // really used by the client is (parentId, position) — so "end" means
  // largest among siblings with the same parent. The MAX+1 is computed as
  // an inline scalar subquery INSIDE the insert so two concurrent creates
  // under the same parent can't read the same max and collide (ties were
  // only cosmetic — list order breaks them by id — but the append
  // invariant should hold).
  const parentCond =
    input.parentId === null || input.parentId === undefined
      ? sql`${schema.channels.parentId} IS NULL`
      : sql`${schema.channels.parentId} = ${input.parentId}`;

  const id = nextSnowflake();
  const [channel] = await db
    .insert(schema.channels)
    .values({
      id,
      guildId: input.guildId,
      type: input.type,
      name: input.name,
      topic: input.topic ?? null,
      parentId: input.parentId ?? null,
      nsfw: input.nsfw ?? false,
      rateLimitPerUser: input.rateLimitPerUser ?? 0,
      linkUrl: input.linkUrl ?? null,
      position: sql`(SELECT COALESCE(MAX(${schema.channels.position}), -1) + 1 FROM ${schema.channels} WHERE ${schema.channels.guildId} = ${input.guildId} AND ${parentCond})`,
    })
    .returning();
  if (!channel) throw errors.internal('Channel insert returned no row');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: 'channel.create',
    targetType: 'channel',
    targetId: id,
    changes: { name: input.name, type: input.type, parentId: input.parentId?.toString() ?? null },
  });

  return channel;
}

export async function listGuildChannels(guildId: bigint) {
  return db
    .select()
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.guildId, guildId),
        isNull(schema.channels.deletedAt),
      ),
    )
    .orderBy(asc(schema.channels.position), asc(schema.channels.id));
}

export async function getChannel(channelId: bigint) {
  const r = await db
    .select()
    .from(schema.channels)
    .where(and(eq(schema.channels.id, channelId), isNull(schema.channels.deletedAt)))
    .limit(1);
  return r[0] ?? null;
}

export interface UpdateChannelInput {
  channelId: bigint;
  actorId: bigint;
  name?: string;
  topic?: string | null;
  position?: number;
  parentId?: bigint | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  /** Voice-channel only: disable voice in the channel. Route enforces type. */
  voiceDisabled?: boolean;
  /** Link-channel URL update. Only valid on guild_link channels;
      the route layer enforces that. */
  linkUrl?: string;
}

export async function updateChannel(input: UpdateChannelInput) {
  const existing = await getChannel(input.channelId);
  if (!existing) throw errors.notFound('Channel');

  if (existing.type === 'guild_category' && input.parentId) {
    throw errors.badRequest('Categories cannot have a parent');
  }

  // If parentId is being changed (and isn't null), validate the new parent.
  if (input.parentId) {
    const parent = await db
      .select({ id: schema.channels.id, type: schema.channels.type, guildId: schema.channels.guildId })
      .from(schema.channels)
      .where(and(
        eq(schema.channels.id, input.parentId),
        // See createChannel's parent-validation block for the
        // rationale — soft-deleted categories still have their
        // overrides applied during permission resolution, so
        // reparenting under one would inherit potentially broad
        // grants that the deleted category was holding.
        isNull(schema.channels.deletedAt),
      ))
      .limit(1);
    if (!parent[0]) throw errors.notFound('Parent channel');
    if (parent[0].guildId !== existing.guildId) {
      throw errors.badRequest('Parent channel does not belong to this guild');
    }
    if (parent[0].type !== 'guild_category') {
      throw errors.badRequest('Parent must be a category');
    }
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) update.name = input.name;
  if (input.topic !== undefined) update.topic = input.topic;
  if (input.position !== undefined) update.position = input.position;
  if (input.parentId !== undefined) update.parentId = input.parentId;
  if (input.nsfw !== undefined) update.nsfw = input.nsfw;
  if (input.rateLimitPerUser !== undefined) update.rateLimitPerUser = input.rateLimitPerUser;
  if (input.voiceDisabled !== undefined) update.voiceDisabled = input.voiceDisabled;
  if (input.linkUrl !== undefined) update.linkUrl = input.linkUrl;

  const [updated] = await db
    .update(schema.channels)
    .set(update)
    .where(and(eq(schema.channels.id, input.channelId), isNull(schema.channels.deletedAt)))
    .returning();
  if (!updated) throw errors.notFound('Channel');

  if (existing.guildId) {
    await writeAudit({
      guildId: existing.guildId,
      actorId: input.actorId,
      action: 'channel.update',
      targetType: 'channel',
      targetId: input.channelId,
      changes: Object.fromEntries(
        Object.entries(update).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
      ),
    });
  }

  return updated;
}

/**
 * Atomic bulk reorder. Takes a list of `{channelId, position, parentId?}`
 * updates, applies them in a single transaction, and returns the
 * post-update rows for everything that actually changed (so the caller
 * can dispatch CHANNEL_UPDATE only for those).
 *
 * Validation:
 *   - Every channel must belong to the given guild (cross-guild moves
 *     are not supported)
 *   - parentId, when not null, must reference an existing category in
 *     the SAME guild
 *   - Categories themselves cannot be assigned a parent (no nesting)
 *
 * On any validation failure the transaction rolls back — no partial
 * reorder ever lands in the DB.
 */
export async function reorderChannels(input: {
  guildId: bigint;
  actorId: bigint;
  updates: ReadonlyArray<{
    channelId: bigint;
    position: number;
    parentId?: bigint | null;
  }>;
}): Promise<Channel[]> {
  if (input.updates.length === 0) return [];

  // Pre-fetch the current rows for all the channels referenced. Using a
  // single query keeps validation cheap and lets us diff for the
  // "actually changed" return value. Soft-deleted channels are
  // excluded — operating on them would silently churn state on
  // rows the user can't see.
  const ids = input.updates.map((u) => u.channelId);
  const before = await db
    .select()
    .from(schema.channels)
    .where(
      and(
        inArray(schema.channels.id, ids),
        isNull(schema.channels.deletedAt),
      ),
    );

  const byId = new Map(before.map((ch) => [ch.id, ch]));
  for (const u of input.updates) {
    const ch = byId.get(u.channelId);
    if (!ch) throw errors.notFound('Channel');
    if (ch.guildId !== input.guildId) {
      throw errors.badRequest('Channel does not belong to this guild');
    }
    if (ch.type === 'guild_category' && u.parentId) {
      throw errors.badRequest('Categories cannot have a parent');
    }
  }

  // Validate any new parents in a single query. Soft-deleted parents
  // are excluded — re-parenting under a gone category leaves
  // dangling references that break the channel-list rendering.
  const newParentIds = Array.from(
    new Set(
      input.updates
        .map((u) => u.parentId)
        .filter((p): p is bigint => typeof p === 'bigint'),
    ),
  );
  if (newParentIds.length > 0) {
    const parents = await db
      .select({
        id: schema.channels.id,
        type: schema.channels.type,
        guildId: schema.channels.guildId,
      })
      .from(schema.channels)
      .where(
        and(
          inArray(schema.channels.id, newParentIds),
          isNull(schema.channels.deletedAt),
        ),
      );
    for (const p of parents) {
      if (p.guildId !== input.guildId) {
        throw errors.badRequest('Parent channel does not belong to this guild');
      }
      if (p.type !== 'guild_category') {
        throw errors.badRequest('Parent must be a category');
      }
    }
    if (parents.length !== newParentIds.length) {
      throw errors.notFound('Parent channel');
    }
  }

  // Compute which rows would actually change. Skipping no-op rows
  // keeps the CASE expression below tight, and skipping the whole
  // UPDATE when nothing changed (drag ended in the same spot) saves
  // an entire round-trip.
  const willChange = input.updates.filter((u) => {
    const before = byId.get(u.channelId)!;
    return (
      before.position !== u.position ||
      (u.parentId !== undefined && before.parentId !== (u.parentId ?? null))
    );
  });
  if (willChange.length === 0) return [];

  // Apply all updates inside one transaction. We use a single UPDATE
  // with CASE expressions over `position` and (when applicable)
  // `parent_id`. The previous implementation issued one UPDATE per
  // moved row inside the same transaction — which on a single
  // Drizzle/postgres-js transaction connection serializes regardless
  // of any Promise.all wrapping, so a 500-channel reorder paid 500
  // sequential round-trips. With CASE we collapse that to one.
  const now = new Date();
  const updateIds = willChange.map((u) => u.channelId);

  // Position CASE — always populated because every willChange row
  // either changes position or has its parent_id changed (in which
  // case keeping its position via WHEN id=X THEN current_position is
  // still cheaper than re-computing client-side).
  const positionCases = willChange
    .map((u) => sql`WHEN ${schema.channels.id} = ${u.channelId} THEN ${u.position}`)
    .reduce(
      (acc, cur, i) => (i === 0 ? cur : sql`${acc} ${cur}`),
      sql.empty(),
    );

  // parent_id CASE — only populated when at least one row in the
  // batch supplies a parentId (undefined means "don't touch
  // parent_id"). The ELSE branch preserves the existing parent for
  // rows that only changed position. When no row reparents, we
  // omit the parent_id column from the SET clause entirely.
  const reparented = willChange.filter((u) => u.parentId !== undefined);
  const parentCases = reparented.length
    ? reparented
        .map(
          (u) =>
            sql`WHEN ${schema.channels.id} = ${u.channelId} THEN ${u.parentId ?? null}`,
        )
        .reduce(
          (acc, cur, i) => (i === 0 ? cur : sql`${acc} ${cur}`),
          sql.empty(),
        )
    : null;

  const updatedRows = await db.transaction(async (tx) => {
    const setPatch: Record<string, unknown> = {
      position: sql`CASE ${positionCases} ELSE ${schema.channels.position} END`,
      updatedAt: now,
    };
    if (parentCases) {
      setPatch.parentId = sql`CASE ${parentCases} ELSE ${schema.channels.parentId} END`;
    }
    return tx
      .update(schema.channels)
      .set(setPatch)
      .where(inArray(schema.channels.id, updateIds))
      .returning();
  });

  if (updatedRows.length > 0) {
    await writeAudit({
      guildId: input.guildId,
      actorId: input.actorId,
      action: 'channel.reorder',
      targetType: 'guild',
      targetId: input.guildId,
      changes: { changed: updatedRows.length },
    });
  }

  return updatedRows;
}

/**
 * Hard-delete a channel row outright. Bypasses the soft-delete +
 * audit-log path that deleteChannel uses. Reserved for cleanup paths
 * that need to remove a channel that was created as part of a
 * compound op that failed partway through (e.g. forum-post creation
 * where the first-message insert errored after the thread row
 * landed). Cascade FKs handle any child rows that may have been
 * inserted in the meantime.
 *
 * Don't use for user-facing deletes — those need the audit trail and
 * the soft-delete semantic so reply chains and forwards remain
 * navigable.
 */
export async function hardDeleteChannel(channelId: bigint): Promise<void> {
  await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
}

export async function deleteChannel(channelId: bigint, actorId: bigint): Promise<{
  /** Ids of cascade-deleted child threads / channels. The route uses
      these to fan CHANNEL_DELETE for each so the gateway clients
      drop them from their local state alongside the parent. */
  cascadedChildIds: bigint[];
}> {
  const existing = await getChannel(channelId);
  if (!existing) throw errors.notFound('Channel');

  return db.transaction(async (tx) => {
    const now = new Date();
    // Soft-delete the channel row first.
    await tx
      .update(schema.channels)
      .set({ deletedAt: now })
      .where(eq(schema.channels.id, channelId));

    // Cascade soft-delete to direct children. For text channels and
    // forums, children are public_thread rows (replies and forum
    // posts respectively). Without this cascade, threads / posts
    // would survive their parent's deletion as orphans: parentId
    // pointing at a deleted channel, no UI bucket to render in,
    // but still appearing in listViewableGuildChannelIds and
    // contributing to permission-refresh diffs. The cascade is
    // scoped to a single level — categories have a separate
    // top-level path that explicitly deletes children first; we
    // don't recurse here.
    const cascaded = await tx
      .update(schema.channels)
      .set({ deletedAt: now })
      .where(
        and(
          eq(schema.channels.parentId, channelId),
          isNull(schema.channels.deletedAt),
        ),
      )
      .returning({ id: schema.channels.id });

    if (existing.guildId) {
      await writeAudit({
        tx,
        guildId: existing.guildId,
        actorId,
        action: 'channel.delete',
        targetType: 'channel',
        targetId: channelId,
      });
    }

    return { cascadedChildIds: cascaded.map((r) => r.id) };
  });
}

// ── Permission overrides ───────────────────────────────────────────────────

export interface UpsertOverrideInput {
  channelId: bigint;
  actorId: bigint;
  /** Either a role override or a member override. */
  targetType: 'role' | 'member';
  targetId: bigint;
  allow: bigint;
  deny: bigint;
}

/**
 * Set or replace an override for a (channel, target) pair. allow/deny are
 * absolute (not delta-encoded).
 *
 * Setting both allow=0 and deny=0 deletes the row, since "no effect" is the
 * same as no row at all and keeps the table tidy.
 */
export async function upsertOverride(input: UpsertOverrideInput) {
  const channel = await getChannel(input.channelId);
  if (!channel) throw errors.notFound('Channel');
  if (!channel.guildId) {
    throw errors.badRequest('DM channels do not have permission overrides');
  }

  if (input.allow === 0n && input.deny === 0n) {
    await deleteOverride({
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      actorId: input.actorId,
      _channelGuildId: channel.guildId,
    });
    return null;
  }

  // Validate the target exists and belongs to the same guild.
  if (input.targetType === 'role') {
    const r = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.id, input.targetId), eq(schema.roles.guildId, channel.guildId)))
      .limit(1);
    if (!r[0]) throw errors.notFound('Role');
  } else {
    const m = await db
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(
        and(
          eq(schema.guildMembers.guildId, channel.guildId),
          eq(schema.guildMembers.userId, input.targetId),
        ),
      )
      .limit(1);
    if (!m[0]) throw errors.notFound('Member');
  }

  await db
    .insert(schema.permissionOverrides)
    .values({
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      allow: input.allow,
      deny: input.deny,
    })
    .onConflictDoUpdate({
      target: [
        schema.permissionOverrides.channelId,
        schema.permissionOverrides.targetType,
        schema.permissionOverrides.targetId,
      ],
      set: { allow: input.allow, deny: input.deny },
    });

  await writeAudit({
    guildId: channel.guildId,
    actorId: input.actorId,
    action: 'channel.override_upsert',
    targetType: 'channel',
    targetId: input.channelId,
    changes: {
      target: { type: input.targetType, id: input.targetId.toString() },
      allow: input.allow.toString(),
      deny: input.deny.toString(),
    },
  });

  return { ...input };
}

interface DeleteOverrideInput {
  channelId: bigint;
  targetType: 'role' | 'member';
  targetId: bigint;
  actorId: bigint;
  /** Cached to avoid an extra channel fetch when called from upsertOverride. */
  _channelGuildId?: bigint;
}

export async function deleteOverride(input: DeleteOverrideInput): Promise<void> {
  let guildId = input._channelGuildId;
  if (!guildId) {
    const channel = await getChannel(input.channelId);
    if (!channel?.guildId) throw errors.notFound('Channel');
    guildId = channel.guildId;
  }

  const result = await db
    .delete(schema.permissionOverrides)
    .where(
      and(
        eq(schema.permissionOverrides.channelId, input.channelId),
        eq(schema.permissionOverrides.targetType, input.targetType),
        eq(schema.permissionOverrides.targetId, input.targetId),
      ),
    )
    .returning({ targetId: schema.permissionOverrides.targetId });

  if (result.length > 0) {
    await writeAudit({
      guildId,
      actorId: input.actorId,
      action: 'channel.override_delete',
      targetType: 'channel',
      targetId: input.channelId,
      changes: { target: { type: input.targetType, id: input.targetId.toString() } },
    });
  }
}

export async function listOverrides(channelId: bigint) {
  return db
    .select()
    .from(schema.permissionOverrides)
    .where(eq(schema.permissionOverrides.channelId, channelId));
}


// ── Threads ────────────────────────────────────────────────────────────────

export interface CreateThreadInput {
  guildId: bigint;
  parentChannelId: bigint;
  parentMessageId: bigint;
  name: string;
}

/**
 * Create a public thread off a parent message. Threads are channels
 * with type='public_thread'; they live in the same guild as the parent
 * and inherit its permissions (we don't store thread-level overrides
 * yet — anyone who can VIEW_CHANNEL the parent can VIEW_CHANNEL the
 * thread).
 *
 * The parent message must exist in the parent channel; we don't check
 * whether the parent is itself a thread (no nested threads — Discord
 * forbids this and it keeps the depth bounded).
 */
export async function createThread(input: CreateThreadInput) {
  const id = nextSnowflake();
  const [created] = await db
    .insert(schema.channels)
    .values({
      id,
      type: 'public_thread',
      guildId: input.guildId,
      parentId: input.parentChannelId,
      parentMessageId: input.parentMessageId,
      name: input.name,
      position: 0,
    })
    .returning();
  if (!created) throw errors.internal('Failed to create thread');
  return created;
}
