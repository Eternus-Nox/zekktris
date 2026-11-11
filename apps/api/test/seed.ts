/**
 * Guild seeding helpers for integration tests.
 * --------------------------------------------
 * Builds the minimal row graph the permission resolver reads: a guild with its
 * @everyone role (id === guildId, per loadMember), members, roles, member-role
 * assignments, channels, and channel permission overrides.
 *
 * Everything created via a guild cascades on guild delete (all guild FKs are
 * ON DELETE CASCADE), so cleanupAll() just drops the tracked guilds + users.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { Permissions } from '@zekktris/shared/permissions';
import type { MessageMetadataJson } from '@zekktris/db';

const _guilds: bigint[] = [];
const _users: bigint[] = [];
const _dmChannels: bigint[] = [];

export async function createUser(
  opts: { allowDmsFromServerMembers?: boolean; dateOfBirth?: string } = {},
): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.users).values({
    id,
    email: `u-${id}@test.local`,
    username: `u_${id}`,
    displayName: 'Seed User',
    passwordHash: 'scrypt-v1$00$00',
    ...(opts.allowDmsFromServerMembers !== undefined
      ? { allowDmsFromServerMembers: opts.allowDmsFromServerMembers }
      : {}),
    ...(opts.dateOfBirth !== undefined ? { dateOfBirth: opts.dateOfBirth } : {}),
  });
  _users.push(id);
  return id;
}

/** Create a guild owned by `ownerId`, with the @everyone role (id === guildId)
 *  carrying `everyonePermissions`. */
export async function createGuild(ownerId: bigint, everyonePermissions: bigint = 0n): Promise<bigint> {
  const guildId = nextSnowflake();
  await db.insert(schema.guilds).values({ id: guildId, name: 'Seed Guild', ownerId });
  await db.insert(schema.roles).values({
    id: guildId, // @everyone shares the guild id
    guildId,
    name: '@everyone',
    position: 0,
    permissions: everyonePermissions,
  });
  _guilds.push(guildId);
  return guildId;
}

export async function addMember(guildId: bigint, userId: bigint): Promise<void> {
  await db.insert(schema.guildMembers).values({ guildId, userId });
}

/** Create + return a non-everyone role. */
export async function createRole(
  guildId: bigint,
  permissions: bigint,
  position = 1,
): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.roles).values({ id, guildId, name: `role-${id}`, position, permissions });
  return id;
}

export async function assignRole(guildId: bigint, userId: bigint, roleId: bigint): Promise<void> {
  await db.insert(schema.memberRoles).values({ guildId, userId, roleId });
}

export async function createChannel(
  guildId: bigint,
  opts: { type?: 'guild_text' | 'guild_category'; parentId?: bigint | null } = {},
): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.channels).values({
    id,
    type: opts.type ?? 'guild_text',
    guildId,
    parentId: opts.parentId ?? null,
  });
  return id;
}

/** Add a channel permission override. For the @everyone override, pass
 *  targetType 'role' with targetId === guildId. */
export async function addOverride(
  channelId: bigint,
  targetType: 'role' | 'member',
  targetId: bigint,
  allow: bigint,
  deny: bigint,
): Promise<void> {
  await db.insert(schema.permissionOverrides).values({ channelId, targetType, targetId, allow, deny });
}

/** Drop every tracked guild (cascades members/roles/channels/overrides) + user. */
export async function cleanupAll(): Promise<void> {
  for (const c of _dmChannels) await db.delete(schema.channels).where(eq(schema.channels.id, c));
  for (const g of _guilds) await db.delete(schema.guilds).where(eq(schema.guilds.id, g));
  for (const u of _users) await db.delete(schema.users).where(eq(schema.users.id, u));
  _dmChannels.length = 0;
  _guilds.length = 0;
  _users.length = 0;
}

export { Permissions };

/** Insert a bare message. Optionally set authorId / createdAt / content / type,
 *  and the receipt / disappearing-message columns. */
export async function createMessage(
  channelId: bigint,
  opts: {
    authorId?: bigint;
    createdAt?: Date;
    content?: string;
    type?: 'default' | 'reply' | 'system_join' | 'system_call' | 'system_disappearing' | 'system_pet';
    expireAfterSeconds?: number | null;
    viewedAt?: Date | null;
    expiresAt?: Date | null;
    deletedAt?: Date | null;
    metadata?: MessageMetadataJson | null;
  } = {},
): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.messages).values({
    id,
    channelId,
    ...(opts.authorId !== undefined ? { authorId: opts.authorId } : {}),
    ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
    ...(opts.content !== undefined ? { content: opts.content } : {}),
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.expireAfterSeconds !== undefined ? { expireAfterSeconds: opts.expireAfterSeconds } : {}),
    ...(opts.viewedAt !== undefined ? { viewedAt: opts.viewedAt } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    ...(opts.deletedAt !== undefined ? { deletedAt: opts.deletedAt } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  });
  return id;
}

/** Create a 1:1/group DM channel (no guild) with the given recipients. Tracked
 *  for cleanup (cascades dm_recipients on delete). */
export async function createDmChannel(
  recipientIds: bigint[],
  type: 'dm' | 'group_dm' = 'dm',
): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.channels).values({ id, type, guildId: null, position: 0 });
  await db.insert(schema.dmRecipients).values(recipientIds.map((userId) => ({ channelId: id, userId })));
  _dmChannels.push(id);
  return id;
}

/** Track a DM channel created elsewhere (e.g. by getOrCreateDM) for cleanup. */
export function trackChannel(id: bigint): void {
  _dmChannels.push(id);
}

export async function addRelationship(
  userId: bigint,
  targetId: bigint,
  type: 'friend' | 'blocked' | 'incoming_request' | 'outgoing_request',
): Promise<void> {
  await db.insert(schema.relationships).values({ userId, targetId, type });
}
