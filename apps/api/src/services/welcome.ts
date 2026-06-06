/**
 * Welcome message service
 * -----------------------
 * Called from guild-join paths (invite acceptance, discovery join,
 * and any future direct-add flow) to post a `system_join` greeting
 * when a guild has welcome messages enabled.
 *
 * Resolution order for the target channel:
 *   1. `welcome_channel_id` if set and the channel still exists,
 *      isn't deleted, and is a text channel.
 *   2. `system_channel_id` (same checks).
 *   3. Best-effort fallback: the FIRST non-deleted guild_text
 *      channel in this guild, ordered by position. This keeps
 *      the welcome message from silently vanishing when both
 *      configured channels are gone — picks SOMETHING reasonable
 *      rather than nothing.
 * If none of the three resolve, we skip the welcome entirely; the
 * join itself isn't affected.
 *
 * Template rendering: `{user}` placeholder → `<@USERID>` mention.
 * Any other text is preserved verbatim. The pre-existing message-
 * content sanitization in the route layer doesn't run here because
 * we're not going through createMessage — but the template was
 * validated at PATCH time by the same hygiene schema, and {user}
 * substitution can't smuggle in disallowed chars.
 *
 * Error handling: this entire helper is best-effort. Any thrown
 * exception is logged and swallowed by the caller — a misconfigured
 * welcome (deleted target channel, etc.) MUST NOT block the join
 * transaction or surface a confusing error to the new member.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { createSystemMessage } from './messages';
import * as dispatch from '../gateway/dispatch';
import { toMessage } from '../lib/dto';
import { log } from '../log';

const DEFAULT_TEMPLATE = 'Welcome to the server, {user}! 👋';
const TEMPLATE_PLACEHOLDER = /\{user\}/g;

/**
 * Resolve + post the welcome message for a freshly-joined member.
 * No-op when the guild has welcome messages disabled or no eligible
 * channel can be found. Returns true if a message was actually
 * posted, false otherwise — handy for tests + logging at call sites.
 */
export async function postWelcomeMessage(
  guildId: bigint,
  joinerId: bigint,
): Promise<boolean> {
  try {
    // Load the guild's welcome config + the joiner record in one go.
    const [guild] = await db
      .select({
        welcomeMessageEnabled: schema.guilds.welcomeMessageEnabled,
        welcomeMessageTemplate: schema.guilds.welcomeMessageTemplate,
        welcomeChannelId: schema.guilds.welcomeChannelId,
        systemChannelId: schema.guilds.systemChannelId,
      })
      .from(schema.guilds)
      .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
      .limit(1);
    if (!guild || !guild.welcomeMessageEnabled) return false;

    // Resolve the target channel — see the resolution order in the
    // file header. Each candidate gets validated for existence,
    // non-deletion, and being a guild_text channel.
    const targetChannelId = await resolveWelcomeChannel(
      guildId,
      guild.welcomeChannelId,
      guild.systemChannelId,
    );
    if (!targetChannelId) return false;

    // Render template. {user} → <@JOINERID> which the client renders
    // as a mention chip. No other substitutions in v1.
    const template = guild.welcomeMessageTemplate ?? DEFAULT_TEMPLATE;
    const content = template.replace(TEMPLATE_PLACEHOLDER, `<@${joinerId.toString()}>`);

    // Insert + dispatch. We don't write to read_states for the
    // joiner (they're "live") nor for other guild members (the
    // CHANNEL_ACK / mention-count flow on a system_join is noisy
    // for a moment that's already visually loud).
    const inserted = await createSystemMessage({
      channelId: targetChannelId,
      guildId,
      authorId: joinerId,
      content,
      type: 'system_join',
      mentionedUserIds: [joinerId],
    });

    // Build the DTO and dispatch MESSAGE_CREATE to the channel
    // audience (which now includes the joiner — userJoinedGuild
    // fanned out before this call).
    const [author] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, joinerId))
      .limit(1);
    const messageDTO = toMessage({
      message: inserted,
      author: author ?? null,
      attachments: [],
      reactions: [],
      mentionedUserIds: [joinerId],
      mentionedRoleIds: [],
      poll: null,
      sticker: null,
      forwardedFrom: null,
      selfId: joinerId,
    });
    dispatch.messageCreate({
      messageDTO,
      channelId: targetChannelId,
      guildId,
    });
    return true;
  } catch (err) {
    // Best-effort. A welcome failure must NOT block the join. Log
    // and move on.
    log.warn?.('welcome message failed', {
      guildId: guildId.toString(),
      joinerId: joinerId.toString(),
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Walk the resolution order (configured welcome channel → system
 * channel → first text channel). Returns the resolved id or null
 * if nothing usable was found.
 *
 * Each candidate must:
 *   - Reference a real channel row (not a stale id pointing at a
 *     deleted channel — that's the kind of misconfiguration where
 *     we silently fall through rather than fail).
 *   - Belong to THIS guild (defensive — the column doesn't FK so
 *     a stored id from a different guild could in principle slip
 *     through).
 *   - Be a guild_text channel.
 *   - Not be soft-deleted.
 */
async function resolveWelcomeChannel(
  guildId: bigint,
  preferredId: bigint | null,
  systemId: bigint | null,
): Promise<bigint | null> {
  const candidates: bigint[] = [];
  if (preferredId) candidates.push(preferredId);
  if (systemId && systemId !== preferredId) candidates.push(systemId);

  if (candidates.length > 0) {
    const rows = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.guildId, guildId),
          isNull(schema.channels.deletedAt),
          eq(schema.channels.type, 'guild_text'),
        ),
      );
    const valid = new Set(rows.map((r) => r.id.toString()));
    for (const c of candidates) {
      if (valid.has(c.toString())) return c;
    }
  }

  // Last-ditch fallback: first text channel by position. Bounded to
  // 1 row.
  const [fallback] = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.guildId, guildId),
        isNull(schema.channels.deletedAt),
        eq(schema.channels.type, 'guild_text'),
      ),
    )
    .orderBy(asc(schema.channels.position), asc(schema.channels.id))
    .limit(1);
  return fallback?.id ?? null;
}
