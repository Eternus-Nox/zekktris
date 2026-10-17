/**
 * Message send gates
 * ------------------
 * The checks a message has to pass before it is created, shared by every
 * path that creates or rewrites one on a user's behalf: the live send route,
 * the edit route, reactions / poll votes (participation only), and the
 * scheduled-message worker at FIRE time. They live here, not in the route,
 * so the worker cannot drift from the live send: a scheduled message used to
 * re-check only SEND_MESSAGES, which let a timed-out member, or text automod
 * would block, be posted by scheduling it a minute out.
 */

import { errors, AppError } from '../errors';
import * as membersSvc from './members';
import * as supervision from './supervision';
import * as dispatch from '../gateway/dispatch';
import { toGuildMember } from '../lib/dto';
import { Permissions, hasPermission, computeMemberChannelPermissions } from './permissions';
import { assertNotInstanceMuted } from './instanceMutes';
import type { schema } from '../db';

/** Our E2EE wire format: `zkE2EE/<version>:<base64>`. Used server-side only to
 *  REJECT ciphertext from a supervised DM (the server never decrypts). */
export const E2EE_CIPHERTEXT_RE = /^zkE2EE\/\d+:/;

/**
 * Participation gates shared by the send, reaction, and poll-vote paths for a
 * GUILD channel: a pending (un-onboarded) member, a timed-out member, or a
 * supervision-restricted minor may not participate. No-op for DMs (no guild
 * membership / timeout / server-messaging restriction applies). Call AFTER the
 * per-action permission check. Kept as one helper so a new participation path
 * (like poll voting, which previously bypassed these) can't drift from send.
 */
export async function enforceGuildParticipationGates(guildId: bigint, userId: bigint): Promise<void> {
  // One member-row read (pending + timeout) in parallel with the independent
  // supervision read — 2 round-trips instead of 3 serial ones. Throw priority
  // unchanged: pending → timeout → restricted.
  const [part, restr] = await Promise.all([
    membersSvc.getParticipationRow(guildId, userId),
    supervision.getEffectiveRestrictions(userId),
  ]);
  if (part.state === 'pending') throw errors.pendingAcknowledgment();
  if (part.timeoutUntil !== null) throw errors.timedOut(part.timeoutUntil);
  if (restr && !restr.allowMessaging) {
    throw new AppError(
      'FORBIDDEN',
      'Messaging is restricted — connect a guardian to continue',
      { supervisionRestricted: 'messaging' },
    );
  }
}

/**
 * Content moderation for GUILD plaintext: banned-words filter + automod rules
 * (block / block-and-timeout / log_only, with the trigger audit + member-update
 * dispatch on timeout). Throws on a blocking violation. Shared by the send AND
 * edit paths so an edit faces the same gate as a fresh send — otherwise a user
 * could post "hi" and edit it into banned content within the mutate window.
 * Spam throttling stays send-only (it's rate-based; edits don't add volume).
 * No-op for DMs / E2EE (never inspected).
 *
 * Webhook executes pass `webhookId` (with the webhook's creator as `userId`,
 * the message's recorded author): a webhook is not a member, so no role
 * exemptions apply and a block_and_timeout rule only blocks — it must not
 * time out whoever happened to create the webhook.
 */
export async function enforceGuildContentModeration(args: {
  guildId: bigint;
  channelId: bigint;
  userId: bigint;
  content: string;
  webhookId?: bigint;
}): Promise<void> {
  const { guildId, channelId, userId, content, webhookId } = args;
  const security = await import('./security');
  await security.checkBannedWords({ userId, guildId, channelId, content });

  const { checkMessage } = await import('./automod');
  const roleIds = webhookId !== undefined ? [] : await membersSvc.getMemberRoleIds(guildId, userId);
  const violation = await checkMessage({ guildId, channelId, userId, content, memberRoleIds: roleIds });
  if (!violation) return;

  let timeoutApplied = false;
  if (
    webhookId === undefined &&
    violation.action === 'block_and_timeout' &&
    violation.timeoutSeconds
  ) {
    try {
      const until = new Date(Date.now() + violation.timeoutSeconds * 1000);
      await membersSvc.setMemberTimeout({ guildId, userId, actorId: userId, until });
      timeoutApplied = true;
      const updated = await membersSvc.getMemberDetailed(guildId, userId);
      if (updated) {
        dispatch.guildMemberUpdate(
          toGuildMember(updated.member, updated.user, updated.roleIds),
          guildId,
        );
      }
    } catch {
      // Timeout failed but the message is still blocked — surfacing the block
      // is the priority.
    }
  }

  try {
    const snippet = content.length > 80 ? content.slice(0, 80) + '…' : content;
    const { writeAudit } = await import('./audit');
    await writeAudit({
      guildId,
      actorId: userId,
      action: 'automod.rule_triggered',
      targetType: 'automod_rule',
      targetId: violation.id,
      changes: {
        ruleName: violation.name,
        ruleType: violation.ruleType,
        snippet,
        channelId: channelId.toString(),
        timeoutApplied,
        action: violation.action,
        ...(webhookId !== undefined ? { webhookId: webhookId.toString() } : {}),
      },
    });
  } catch {
    // Audit write failed — don't surface to the user.
  }

  if (violation.action !== 'log_only') {
    throw errors.automodBlocked(violation.name, timeoutApplied);
  }
}

/**
 * Every gate a new message in a GUILD channel must pass, in throw-priority
 * order: archived-thread lock → SEND_MESSAGES → ATTACH_FILES (when the
 * message carries files) → participation (pending / timeout / supervision) →
 * slowmode (unless skipped; MANAGE_MESSAGES bypasses it) → instance spam
 * throttle → banned words + automod. Request-shape checks (forum / link
 * channels) and instance mute stay with the caller.
 */
export async function enforceGuildSendGates(args: {
  channel: schema.Channel;
  /** The author's effective permissions in `channel`. */
  channelPerms: bigint;
  userId: bigint;
  content: string;
  hasFiles?: boolean;
  /** False for scheduled fires: the author can't respond to a slowmode
   *  rejection at fire time, and the 60 s minimum schedule delay already
   *  bounds the rate. */
  enforceSlowmode: boolean;
}): Promise<void> {
  const { channel, channelPerms, userId, content } = args;
  const guildId = channel.guildId;
  if (guildId === null) return;
  // Archived threads are read-only. To send to an archived thread, a
  // moderator unarchives it first via PATCH /channels/:id. No
  // MANAGE_MESSAGES override — archived means locked, period.
  if (channel.type === 'public_thread' && channel.threadArchivedAt !== null) {
    throw errors.forbidden('This thread is archived');
  }
  if (!hasPermission(channelPerms, Permissions.SEND_MESSAGES)) {
    throw errors.missingPermissions(['SEND_MESSAGES']);
  }
  if (args.hasFiles && !hasPermission(channelPerms, Permissions.ATTACH_FILES)) {
    throw errors.missingPermissions(['ATTACH_FILES']);
  }
  // Onboarding before timeout: if you haven't agreed to the rules yet, the
  // timeout state isn't even relevant. Timeout is NOT bypassed by
  // MANAGE_MESSAGES (a timed-out mod stays timed out).
  await enforceGuildParticipationGates(guildId, userId);
  if (args.enforceSlowmode && !hasPermission(channelPerms, Permissions.MANAGE_MESSAGES)) {
    const { enforceSlowmode } = await import('./messages');
    await enforceSlowmode(channel.id, userId, channel.rateLimitPerUser);
  }
  // Instance security (Admin → Security): spam throttle, then banned words +
  // automod. Guild plaintext only — E2EE/DMs are exempt by design.
  const security = await import('./security');
  await security.checkSpam({ userId, guildId, channelId: channel.id });
  await enforceGuildContentModeration({ guildId, channelId: channel.id, userId, content });
}

/**
 * Fire-time gates for a scheduled message: the same checks a live send of
 * `content` by `authorId` into `channel` would face right now, because the
 * author may have been muted, timed out, kicked, blocked or put under
 * supervision since scheduling. Slowmode is skipped (see enforceGuildSendGates).
 * Throws on any failure; the worker records the message as the row's lastError.
 */
export async function enforceScheduledFireGates(args: {
  channel: schema.Channel;
  authorId: bigint;
  content: string;
}): Promise<void> {
  const { channel, authorId, content } = args;
  await assertNotInstanceMuted(authorId);
  // computeMemberChannelPermissions fails closed (0n) for non-members and
  // non-recipients, so one check covers kicked members and DMs alike.
  const perms = await computeMemberChannelPermissions(channel.id, authorId, channel);
  if (!hasPermission(perms, Permissions.SEND_MESSAGES)) {
    throw new Error('No permission to send in this channel');
  }
  if (channel.guildId !== null) {
    await enforceGuildSendGates({
      channel,
      channelPerms: perms,
      userId: authorId,
      content,
      enforceSlowmode: false,
    });
    return;
  }
  // DM-only gates: a scheduled DM must NOT defeat a block, a guardian's DM
  // policy, or the supervised-pair plaintext invariant that was set AFTER
  // the message was scheduled (a block only mutates relationships, not
  // dm_recipients, so SEND_MESSAGES alone doesn't cover these).
  if (channel.type === 'dm') {
    const dmsSvc = await import('./dms');
    const relationships = await import('./relationships');
    const other = await dmsSvc.getOtherRecipient(channel.id, authorId);
    if (other !== null) {
      if (await relationships.isBlockedEitherWay(authorId, other)) {
        throw new Error('Recipient is unavailable');
      }
      if (await supervision.dmBlockedBySupervision(authorId, other)) {
        throw new Error('Direct messages are restricted');
      }
      if (
        E2EE_CIPHERTEXT_RE.test(content) &&
        !(await supervision.isE2eeAllowedBetween(authorId, other))
      ) {
        throw new Error('Encrypted messages are unavailable while supervised');
      }
    }
  }
}
