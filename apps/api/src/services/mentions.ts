/**
 * Mentions
 * --------
 * Parses Discord-style mention markup out of message content and persists
 * the resolved IDs to message_user_mentions and message_role_mentions.
 *
 * Markup forms recognized:
 *   <@123456789>        user mention by id
 *   <@!123456789>       user mention with nickname (treated identically)
 *   <@&123456789>       role mention by id
 *   @everyone           literal — mentions every member
 *   @here               literal — mentions every online member (online state
 *                       is gateway territory; persisted same as @everyone)
 *
 * Channel mentions (<#123>) are recognized at render time by clients; they
 * don't go in any mentions table.
 *
 * The parser is non-strict: unknown ids parse but get filtered out at
 * resolution (when we check the user/role actually exists). That way a
 * stale mention in a quoted block doesn't make the message un-postable.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { listViewableGuildChannelIdsForUsers } from './permissions';
import type { Database } from '@zekktris/db';

type DbHandle = Omit<Database, '$client'>;

export interface ParsedMentions {
  /** Snowflake ids — unvalidated, may include nonexistent users. */
  userIds: bigint[];
  /** Snowflake ids — unvalidated, may include nonexistent roles. */
  roleIds: bigint[];
  /** True if @everyone or @here appears in the content. */
  everyone: boolean;
}

const USER_MENTION = /<@!?(\d{1,20})>/g;
const ROLE_MENTION = /<@&(\d{1,20})>/g;
const EVERYONE = /(^|\s)@(everyone|here)(\b)/;

/** Pure parse — no DB access, no validation. */
export function parseMentions(content: string): ParsedMentions {
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];

  for (const m of content.matchAll(USER_MENTION)) {
    try {
      userIds.push(BigInt(m[1]!));
    } catch {
      /* unparseable id — silently skip */
    }
  }
  for (const m of content.matchAll(ROLE_MENTION)) {
    try {
      roleIds.push(BigInt(m[1]!));
    } catch {
      /* skip */
    }
  }

  // De-duplicate — a content of "<@1> <@1>" should only mention user 1 once.
  const uniqUsers = Array.from(new Set(userIds.map((b) => b.toString()))).map((s) => BigInt(s));
  const uniqRoles = Array.from(new Set(roleIds.map((b) => b.toString()))).map((s) => BigInt(s));

  return {
    userIds: uniqUsers,
    roleIds: uniqRoles,
    everyone: EVERYONE.test(content),
  };
}

/**
 * Resolve parsed mentions against the database — drop ids that don't refer
 * to real users/roles. For role mentions, also confirm the role belongs to
 * the same guild as the channel (so a cross-guild role id can't be
 * smuggled in via copy-paste).
 *
 * For user mentions, also restrict the resolved set to the channel's
 * actual audience:
 *   - Guild channels: members of the guild only.
 *   - DM channels: recipients of the DM only.
 *
 * Without this filter, a sender could mention any user on the platform,
 * triggering a mention badge on a channel the target can't see (the
 * read_state mentionCount bump happens unconditionally downstream).
 * That's a notification spam vector AND a privacy leak — mentions to
 * users outside the channel's audience persist and accumulate in their
 * mention counter for a channel they have no access to.
 *
 * The audience filter takes the channel id, not just guild id, so DM
 * channels (no guild) can be scoped properly.
 */
export async function resolveMentions(
  parsed: ParsedMentions,
  guildId: bigint | null,
  channelId: bigint | null = null,
): Promise<ParsedMentions> {
  const out: ParsedMentions = { userIds: [], roleIds: [], everyone: parsed.everyone };

  if (parsed.userIds.length > 0) {
    // Base filter: user exists, isn't banned, isn't soft-deleted.
    // Without these, mentioning a banned user would persist a valid
    // mention row and trigger a push notification — banned users
    // would keep receiving channel-activity pings about content they
    // can no longer see. The mention silently resolves to "no such
    // user" instead (the @id token stays in the message content as
    // plain text on the client side).
    const baseQuery = db
      .select({ id: schema.users.id })
      .from(schema.users);

    let found: { id: bigint }[];
    if (guildId !== null) {
      // Guild channel: require guild membership. INNER JOIN against
      // guild_members where guildId matches.
      found = await baseQuery
        .innerJoin(
          schema.guildMembers,
          and(
            eq(schema.guildMembers.userId, schema.users.id),
            eq(schema.guildMembers.guildId, guildId),
          ),
        )
        .where(
          and(
            inArray(schema.users.id, parsed.userIds),
            isNull(schema.users.bannedAt),
            isNull(schema.users.deletedAt),
          ),
        );
      // Guild membership alone is NOT the channel's audience: role/member
      // overrides can hide a channel from most members (private mod
      // channels). A mention that resolves for a non-viewer leaks the
      // private channel's existence and content downstream — a phantom
      // badge on an invisible channel, a push notification carrying the
      // message preview, and a mentions-inbox row that returns the full
      // message body. Restrict to users who can VIEW_CHANNEL here, the
      // single choke point all three flows derive from.
      if (found.length > 0 && channelId !== null) {
        const viewable = await listViewableGuildChannelIdsForUsers(
          guildId,
          found.map((u) => u.id),
        );
        found = found.filter((u) => viewable.get(u.id)?.has(channelId));
      }
    } else if (channelId !== null) {
      // DM channel: require dm_recipients membership.
      found = await baseQuery
        .innerJoin(
          schema.dmRecipients,
          and(
            eq(schema.dmRecipients.userId, schema.users.id),
            eq(schema.dmRecipients.channelId, channelId),
          ),
        )
        .where(
          and(
            inArray(schema.users.id, parsed.userIds),
            isNull(schema.users.bannedAt),
            isNull(schema.users.deletedAt),
          ),
        );
    } else {
      // No channel context — fall back to global existence check.
      // This branch is reached only if a caller passes both
      // guildId=null and channelId=null, which shouldn't happen for
      // real message creates but the test surface includes it.
      found = await baseQuery.where(
        and(
          inArray(schema.users.id, parsed.userIds),
          isNull(schema.users.bannedAt),
          isNull(schema.users.deletedAt),
        ),
      );
    }
    out.userIds = found.map((u) => u.id);
  }

  if (parsed.roleIds.length > 0 && guildId) {
    const found = await db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.guildId, guildId),
          inArray(schema.roles.id, parsed.roleIds),
        ),
      );
    out.roleIds = found.map((r) => r.id);
  }

  return out;
}

/**
 * Replace the persisted mentions for a message. Used both on initial create
 * (no existing rows) and on edit (clear-then-insert). Idempotent inserts.
 */
export async function writeMessageMentions(
  messageId: bigint,
  resolved: ParsedMentions,
  tx: DbHandle = db,
): Promise<void> {
  // Clear any prior rows. On create this is a no-op; on edit it's correct.
  await tx
    .delete(schema.messageUserMentions)
    .where(eq(schema.messageUserMentions.messageId, messageId));
  await tx
    .delete(schema.messageRoleMentions)
    .where(eq(schema.messageRoleMentions.messageId, messageId));

  if (resolved.userIds.length > 0) {
    await tx.insert(schema.messageUserMentions).values(
      resolved.userIds.map((userId) => ({ messageId, userId })),
    );
  }
  if (resolved.roleIds.length > 0) {
    await tx.insert(schema.messageRoleMentions).values(
      resolved.roleIds.map((roleId) => ({ messageId, roleId })),
    );
  }
  // The @everyone flag is stored on the message row itself by the caller;
  // there's no separate table for it.
}
