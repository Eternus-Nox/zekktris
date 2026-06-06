/**
 * Guild backup / restore
 * ----------------------
 * Export a guild's *configuration* — name, settings, roles, the channel
 * tree (categories + channels), role-level permission overrides — plus its
 * icon and banner images, as a single self-contained JSON document. Restore
 * rebuilds it as a BRAND-NEW guild owned by the importer (clone semantics),
 * so a restore can never mutate or corrupt a live server. It's the
 * "recover if something happens" path: keep the file, and you can stand the
 * server back up at any time.
 *
 * What's intentionally NOT in a backup:
 *   - messages, threads, and any message-derived channels (public_thread)
 *   - members, bans, invites, webhooks, automod rules, scheduled messages
 *   - member-targeted permission overrides (the members don't exist in the
 *     clone, so a per-member override has nothing to bind to)
 *
 * References between objects are expressed by a stable "key" (the source
 * snowflake as a string). On import every key is remapped to a freshly
 * minted snowflake; the @everyone role keeps the invariant everyoneId ===
 * guildId by mapping to the new guild id rather than a new role id.
 */

import { db, schema } from '../db';
import { eq, and, isNull, inArray, ne } from 'drizzle-orm';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { writeAudit } from './audit';
import { EVERYONE_ROLE_NAME } from '@zekktris/shared/constants';
import {
  saveUploadedFile,
  openAttachmentForRead,
  parseCdnAttachmentId,
} from './uploads';

export const BACKUP_FORMAT = 'zekktris.guild-backup' as const;
export const BACKUP_VERSION = 1 as const;

/** Structural guild channel types that belong in a backup. Threads and DMs
 *  are excluded (see file header). */
const BACKUP_CHANNEL_TYPES = [
  'guild_text',
  'guild_category',
  'guild_voice',
  'guild_stage',
  'guild_forum',
  'guild_link',
] as const;
type BackupChannelType = (typeof BACKUP_CHANNEL_TYPES)[number];

export interface BackupImage {
  dataBase64: string;
  contentType: string;
  filename: string;
}

export interface GuildBackup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  sourceGuildId: string;
  guild: {
    name: string;
    description: string | null;
    afkTimeoutSeconds: number;
    welcomeMessageEnabled: boolean;
    welcomeMessageTemplate: string | null;
    rulesContent: string | null;
    /** References into `channels[].key`, remapped on import. */
    systemChannelKey: string | null;
    afkChannelKey: string | null;
    welcomeChannelKey: string | null;
  };
  roles: Array<{
    key: string;
    isEveryone: boolean;
    name: string;
    color: number;
    position: number;
    /** bigint bitfield serialized as a decimal string. */
    permissions: string;
    hoist: boolean;
    mentionable: boolean;
    selfAssignable: boolean;
    description: string | null;
  }>;
  channels: Array<{
    key: string;
    type: BackupChannelType;
    name: string | null;
    topic: string | null;
    position: number;
    nsfw: boolean;
    rateLimitPerUser: number;
    linkUrl: string | null;
    parentKey: string | null;
  }>;
  /** Role-level overrides only. */
  overrides: Array<{
    channelKey: string;
    roleKey: string;
    allow: string;
    deny: string;
  }>;
  images: {
    icon: BackupImage | null;
    banner: BackupImage | null;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Export
// ───────────────────────────────────────────────────────────────────────────

function contentTypeFromName(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/** Read a `/cdn/<id>/<filename>` image off disk and base64-encode it.
 *  Returns null for missing/unreadable/non-cdn URLs — a backup with a
 *  dropped image is still a valid backup. */
async function readImage(url: string | null): Promise<BackupImage | null> {
  if (!url) return null;
  const id = parseCdnAttachmentId(url);
  if (id === null) return null;
  const m = url.match(/^\/cdn\/\d+\/(.+)$/);
  const filename = m && m[1] ? decodeURIComponent(m[1]) : 'image';
  const opened = await openAttachmentForRead(id, filename);
  if (!opened) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const buf = Buffer.concat(chunks);
  return {
    dataBase64: buf.toString('base64'),
    contentType: contentTypeFromName(filename),
    filename,
  };
}

/** Build a full backup document for a guild. Caller must have already
 *  checked MANAGE_GUILD. Assumes the guild exists (throws notFound if not). */
export async function exportGuild(guildId: bigint): Promise<GuildBackup> {
  const [guild] = await db
    .select()
    .from(schema.guilds)
    .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
    .limit(1);
  if (!guild) throw errors.notFound('Guild');

  const roleRows = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.guildId, guildId));
  roleRows.sort((a, b) => a.position - b.position);

  const channelRows = (
    await db
      .select()
      .from(schema.channels)
      .where(
        and(eq(schema.channels.guildId, guildId), isNull(schema.channels.deletedAt)),
      )
  ).filter((c): c is typeof c & { type: BackupChannelType } =>
    (BACKUP_CHANNEL_TYPES as readonly string[]).includes(c.type),
  );
  channelRows.sort((a, b) => a.position - b.position);

  const channelIds = channelRows.map((c) => c.id);
  const roleIdSet = new Set(roleRows.map((r) => r.id.toString()));

  const overrideRows =
    channelIds.length > 0
      ? await db
          .select()
          .from(schema.permissionOverrides)
          .where(
            and(
              inArray(schema.permissionOverrides.channelId, channelIds),
              eq(schema.permissionOverrides.targetType, 'role'),
            ),
          )
      : [];

  const key = (id: bigint) => id.toString();

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sourceGuildId: key(guildId),
    guild: {
      name: guild.name,
      description: guild.description,
      afkTimeoutSeconds: guild.afkTimeoutSeconds,
      welcomeMessageEnabled: guild.welcomeMessageEnabled,
      welcomeMessageTemplate: guild.welcomeMessageTemplate,
      rulesContent: guild.rulesContent,
      systemChannelKey: guild.systemChannelId ? key(guild.systemChannelId) : null,
      afkChannelKey: guild.afkChannelId ? key(guild.afkChannelId) : null,
      welcomeChannelKey: guild.welcomeChannelId ? key(guild.welcomeChannelId) : null,
    },
    roles: roleRows.map((r) => ({
      // @everyone's id equals the guild id — flag it so import can preserve
      // that invariant instead of minting a stray role id.
      key: key(r.id),
      isEveryone: r.id === guildId,
      name: r.name,
      color: r.color,
      position: r.position,
      permissions: r.permissions.toString(),
      hoist: r.hoist,
      mentionable: r.mentionable,
      selfAssignable: r.selfAssignable,
      description: r.description,
    })),
    channels: channelRows.map((c) => ({
      key: key(c.id),
      type: c.type,
      name: c.name,
      topic: c.topic,
      position: c.position,
      nsfw: c.nsfw,
      rateLimitPerUser: c.rateLimitPerUser,
      linkUrl: c.linkUrl,
      parentKey: c.parentId ? key(c.parentId) : null,
    })),
    overrides: overrideRows
      // Defensive: only keep overrides whose role is actually in this export.
      .filter((o) => roleIdSet.has(o.targetId.toString()))
      .map((o) => ({
        channelKey: key(o.channelId),
        roleKey: key(o.targetId),
        allow: o.allow.toString(),
        deny: o.deny.toString(),
      })),
    images: {
      icon: await readImage(guild.iconUrl),
      banner: await readImage(guild.bannerUrl),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Import (clone)
// ───────────────────────────────────────────────────────────────────────────

/** Reconstruct a base64 backup image as a freshly-stored upload, returning
 *  its new /cdn/ url. Runs OUTSIDE the import transaction (slow IO); an
 *  orphaned file on a failed import is reclaimed by the attachment GC. */
async function restoreImage(img: BackupImage | null): Promise<string | null> {
  if (!img) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(img.dataBase64, 'base64');
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  const file = new File([buf], img.filename || 'image', {
    type: img.contentType || 'application/octet-stream',
  });
  const saved = await saveUploadedFile(file);
  return saved.url;
}

/**
 * Create a new guild from a backup, owned by `userId`. Returns the new
 * guild id. The backup is assumed already shape-validated by the route's
 * zod schema; this layer enforces the relational invariants (key remapping,
 * @everyone, channel-ref types).
 *
 * `nameOverride`, when provided (trimmed, non-empty), replaces the name
 * stored in the backup. The create-server flow uses this so the name the
 * user typed wins over whatever the template/backup file was called.
 */
export async function importGuild(
  userId: bigint,
  backup: GuildBackup,
  nameOverride?: string,
): Promise<{ guildId: bigint; defaultChannelId: bigint | null }> {
  if (backup.format !== BACKUP_FORMAT) {
    throw errors.badRequest('Unrecognized backup file');
  }
  if (backup.version !== BACKUP_VERSION) {
    throw errors.badRequest(
      `Unsupported backup version ${String(backup.version)} (expected ${BACKUP_VERSION})`,
    );
  }
  if (!backup.roles.some((r) => r.isEveryone)) {
    throw errors.badRequest('Backup is missing its base @everyone role');
  }

  // Pre-store images before opening the transaction.
  const iconUrl = await restoreImage(backup.images.icon);
  const bannerUrl = await restoreImage(backup.images.banner);

  const guildId = nextSnowflake();
  const everyoneRoleId = guildId; // invariant: @everyone id === guild id

  // key → new snowflake maps
  const roleIdByKey = new Map<string, bigint>();
  for (const r of backup.roles) {
    roleIdByKey.set(r.key, r.isEveryone ? everyoneRoleId : nextSnowflake());
  }
  const channelIdByKey = new Map<string, bigint>();
  for (const ch of backup.channels) {
    channelIdByKey.set(ch.key, nextSnowflake());
  }

  // Pick a sensible landing channel for post-restore navigation: the
  // lowest-position text channel (ties broken by key for determinism).
  const firstText = backup.channels
    .filter((c) => c.type === 'guild_text')
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))[0];
  const defaultChannelId = firstText ? channelIdByKey.get(firstText.key) ?? null : null;

  // Resolve guild-level channel references, validating the afk target is
  // actually a voice channel (otherwise the resolver invariant breaks).
  const resolveChannel = (k: string | null): bigint | null =>
    k ? channelIdByKey.get(k) ?? null : null;
  const systemChannelId = resolveChannel(backup.guild.systemChannelKey);
  const welcomeChannelId = resolveChannel(backup.guild.welcomeChannelKey);
  let afkChannelId = resolveChannel(backup.guild.afkChannelKey);
  if (afkChannelId !== null) {
    const afkCh = backup.channels.find((c) => channelIdByKey.get(c.key) === afkChannelId);
    if (!afkCh || afkCh.type !== 'guild_voice') afkChannelId = null;
  }

  const trimmedOverride = nameOverride?.trim();
  await db.transaction(async (tx) => {
    await tx.insert(schema.guilds).values({
      id: guildId,
      name: trimmedOverride && trimmedOverride.length > 0 ? trimmedOverride.slice(0, 100) : backup.guild.name,
      description: backup.guild.description,
      iconUrl,
      bannerUrl,
      ownerId: userId,
      afkTimeoutSeconds: backup.guild.afkTimeoutSeconds,
      welcomeMessageEnabled: backup.guild.welcomeMessageEnabled,
      welcomeMessageTemplate: backup.guild.welcomeMessageTemplate,
      rulesContent: backup.guild.rulesContent,
      rulesUpdatedAt: backup.guild.rulesContent ? new Date() : null,
    });

    for (const r of backup.roles) {
      const id = roleIdByKey.get(r.key);
      if (id === undefined) continue;
      await tx.insert(schema.roles).values({
        id,
        guildId,
        name: r.isEveryone ? EVERYONE_ROLE_NAME : r.name,
        color: r.color,
        position: r.position,
        permissions: BigInt(r.permissions),
        hoist: r.hoist,
        mentionable: r.mentionable,
        selfAssignable: r.selfAssignable,
        // Only @everyone is managed; cloned custom roles are normal roles.
        managed: r.isEveryone,
        description: r.description,
      });
    }

    await tx.insert(schema.guildMembers).values({ guildId, userId });

    // Insert categories first so child channels' parentId FK resolves.
    const ordered = [
      ...backup.channels.filter((c) => c.type === 'guild_category'),
      ...backup.channels.filter((c) => c.type !== 'guild_category'),
    ];
    for (const ch of ordered) {
      const id = channelIdByKey.get(ch.key);
      if (id === undefined) continue;
      await tx.insert(schema.channels).values({
        id,
        guildId,
        type: ch.type,
        name: ch.name,
        topic: ch.topic,
        position: ch.position,
        nsfw: ch.nsfw,
        rateLimitPerUser: ch.rateLimitPerUser,
        linkUrl: ch.linkUrl,
        parentId: ch.parentKey ? channelIdByKey.get(ch.parentKey) ?? null : null,
      });
    }

    for (const o of backup.overrides) {
      const channelId = channelIdByKey.get(o.channelKey);
      const targetId = roleIdByKey.get(o.roleKey);
      if (channelId === undefined || targetId === undefined) continue;
      await tx.insert(schema.permissionOverrides).values({
        channelId,
        targetType: 'role',
        targetId,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      });
    }

    if (systemChannelId !== null || welcomeChannelId !== null || afkChannelId !== null) {
      await tx
        .update(schema.guilds)
        .set({ systemChannelId, welcomeChannelId, afkChannelId, updatedAt: new Date() })
        .where(eq(schema.guilds.id, guildId));
    }

    await writeAudit({
      tx,
      guildId,
      actorId: userId,
      action: 'guild.create',
      targetType: 'guild',
      targetId: guildId,
      changes: { restoredFrom: backup.sourceGuildId },
    });
  });

  return { guildId, defaultChannelId };
}

