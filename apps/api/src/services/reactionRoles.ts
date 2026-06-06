/*
 * Reaction-roles service.
 *
 * The gateway's reaction-add / reaction-remove handlers call into
 * here on every reaction event. We do a single PK-indexed lookup
 * to check whether the (message, emoji) combo is mapped to a role
 * and, if so, grant/revoke that role for the reacting member.
 *
 * Failure mode: if the role assignment fails (role deleted between
 * the lookup and the assign, member already has the role, etc.) we
 * swallow the error rather than failing the reaction event. The
 * reaction itself succeeds; only the role-assignment side effect
 * doesn't take. This keeps the reaction-add UX consistent — users
 * shouldn't see "reaction failed" toasts for what's really a
 * server-config issue.
 */

import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';

export interface ReactionRoleListItem {
  messageId: string;
  emoji: string;
  channelId: string;
  roleId: string;
}

/**
 * One-shot lookup used by the gateway reaction handlers. Returns
 * the role id mapped to this (message, emoji) pair, or null if no
 * mapping exists. The PK index makes this an O(log n) point read.
 */
export async function lookupReactionRole(
  messageId: bigint,
  emoji: string,
): Promise<bigint | null> {
  const rows = await db
    .select({ roleId: schema.reactionRoles.roleId })
    .from(schema.reactionRoles)
    .where(
      and(
        eq(schema.reactionRoles.messageId, messageId),
        eq(schema.reactionRoles.emoji, emoji),
      ),
    )
    .limit(1);
  return rows[0]?.roleId ?? null;
}

/** List all reaction-role mappings in a guild for the management UI. */
export async function listForGuild(guildId: bigint): Promise<ReactionRoleListItem[]> {
  const rows = await db
    .select()
    .from(schema.reactionRoles)
    .where(eq(schema.reactionRoles.guildId, guildId));
  return rows.map((r) => ({
    messageId: r.messageId.toString(),
    emoji: r.emoji,
    channelId: r.channelId.toString(),
    roleId: r.roleId.toString(),
  }));
}

export async function createMapping(input: {
  messageId: bigint;
  emoji: string;
  guildId: bigint;
  channelId: bigint;
  roleId: bigint;
  createdBy: bigint;
}) {
  // INSERT ... ON CONFLICT DO UPDATE — letting an admin "redirect"
  // an existing emoji on the same message to a different role
  // without having to delete first.
  await db
    .insert(schema.reactionRoles)
    .values({
      messageId: input.messageId,
      emoji: input.emoji,
      guildId: input.guildId,
      channelId: input.channelId,
      roleId: input.roleId,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [schema.reactionRoles.messageId, schema.reactionRoles.emoji],
      set: { roleId: input.roleId, createdBy: input.createdBy },
    });
}

export async function deleteMapping(messageId: bigint, emoji: string): Promise<boolean> {
  const rows = await db
    .delete(schema.reactionRoles)
    .where(
      and(
        eq(schema.reactionRoles.messageId, messageId),
        eq(schema.reactionRoles.emoji, emoji),
      ),
    )
    .returning({ messageId: schema.reactionRoles.messageId });
  return rows.length > 0;
}
