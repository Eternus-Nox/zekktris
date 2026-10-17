/**
 * Webhooks service
 * ----------------
 * Discord-compatible incoming webhooks. Each webhook is a (channel,
 * secret-token) pair that lets external services post a message to the
 * channel without a user account. The execute endpoint is unauthed —
 * the secret token in the URL is the only gate. Tokens are 32 random
 * urlsafe-base64 chars (~190 bits of entropy).
 *
 * Lifecycle:
 *   - create: caller needs MANAGE_WEBHOOKS on the channel. We mint an
 *     id + token and persist; the caller gets back the row including
 *     the token (one-time visibility — the API also returns the token
 *     on subsequent list/get calls, mirroring Discord's behavior).
 *   - list / get: caller needs MANAGE_WEBHOOKS.
 *   - delete: caller needs MANAGE_WEBHOOKS. Hard-delete; the token
 *     instantly stops working. (No soft-delete — there's no use case
 *     for "I bricked my webhook by accident, undelete it.")
 *   - execute: token-gated, no permission check. The webhook's
 *     channel + guild are read from the row; we create a message with
 *     the webhook's persona (name + avatar) and broadcast it through
 *     the normal gateway path so subscribers see it identically to a
 *     user-authored message.
 *
 * Audit: create/delete/update mutations write audit log entries
 * attributed to the actor; executes do not (the volume would dwarf the
 * rest of the audit log and the persona itself isn't sensitive — what
 * we'd really want is rate-limit telemetry, which lives elsewhere).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { writeAudit } from './audit';
import { log } from '../log';
import { createMessage } from './messages';
import { isCurrentlyBanned } from './instanceBans';
import * as dispatch from '../gateway/dispatch';
import { toMessage } from '../lib/dto';
import { computeMemberChannelPermissions, Permissions, hasPermission } from './permissions';

// ── Token generation ───────────────────────────────────────────────────────
//
// We aim for ~190 bits of entropy: 24 random bytes encoded as urlsafe
// base64 = 32 chars. Using crypto.getRandomValues / node:crypto.randomBytes
// — both are CSPRNG. The encoding strips '=' padding and replaces +/ with
// -_  so the token is safe in URL paths without escaping.

function urlsafeB64(bytes: Uint8Array): string {
  // Node's Buffer can do this in one call; falls back gracefully on
  // platforms where we'd want browser globals (we shouldn't have any
  // on the API side, but the import is one line and zero cost).
  const b64 = Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateToken(): string {
  return urlsafeB64(randomBytes(24));
}

// ── Validation helpers ─────────────────────────────────────────────────────

const MIN_NAME_LEN = 1;
const MAX_NAME_LEN = 80;
const MAX_AVATAR_URL_LEN = 1024;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LEN || trimmed.length > MAX_NAME_LEN) {
    throw errors.badRequest(`Webhook name must be ${MIN_NAME_LEN}-${MAX_NAME_LEN} chars`);
  }
  // Reject control chars + the @-prefix sigil that could confuse mention
  // parsing if someone names a webhook "@everyone".
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) {
    throw errors.badRequest('Webhook name cannot contain control characters');
  }
  if (trimmed === 'everyone' || trimmed === 'here' || trimmed.startsWith('@')) {
    throw errors.badRequest('Webhook name conflicts with reserved mention syntax');
  }
  return trimmed;
}

function validateAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_AVATAR_URL_LEN) {
    throw errors.badRequest(`Webhook avatar URL must be ≤ ${MAX_AVATAR_URL_LEN} chars`);
  }
  // We accept any http(s) URL or an internal /cdn/ path. We don't fetch
  // it to validate — clients that paste a 404 URL will see a broken
  // avatar in their messages, which is recoverable by editing.
  if (!/^(https?:\/\/|\/cdn\/)/i.test(trimmed)) {
    throw errors.badRequest('Webhook avatar URL must be http(s) or a /cdn/ path');
  }
  return trimmed;
}

// ── Permission gate ────────────────────────────────────────────────────────

async function assertManageWebhooks(channelId: bigint, actorId: bigint): Promise<{
  guildId: bigint;
}> {
  // Resolve the channel's guild (webhooks only on guild channels —
  // never DMs). The channel-permissions resolver already validates
  // this; we just read the guildId out for downstream operations.
  const ch = await db
    .select({ guildId: schema.channels.guildId, type: schema.channels.type })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.id, channelId),
        isNull(schema.channels.deletedAt),
      ),
    )
    .limit(1);
  const row = ch[0];
  if (!row || !row.guildId) {
    throw errors.notFound('Channel');
  }
  // Webhooks only make sense in text-bearing channels. Voice / category
  // / thread channels have no message stream the webhook could post to.
  if (row.type !== 'guild_text') {
    throw errors.badRequest('Webhooks are only supported on text channels');
  }
  const perms = await computeMemberChannelPermissions(channelId, actorId);
  if (!hasPermission(perms, Permissions.MANAGE_WEBHOOKS)) {
    throw errors.missingPermissions(['MANAGE_WEBHOOKS']);
  }
  return { guildId: row.guildId };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface CreateWebhookInput {
  channelId: bigint;
  actorId: bigint;
  name: string;
  avatarUrl?: string | null;
}

export async function createWebhook(input: CreateWebhookInput): Promise<schema.Webhook> {
  const { guildId } = await assertManageWebhooks(input.channelId, input.actorId);
  const name = validateName(input.name);
  const avatarUrl = validateAvatarUrl(input.avatarUrl);
  const id = nextSnowflake();
  const token = generateToken();

  // Wrap the DB insert + audit write so any underlying Postgres error
  // (missing column, FK violation, enum mismatch, etc.) gets logged
  // with full context AND surfaces a meaningful AppError to the
  // client instead of being masked as a generic 500. Without this
  // wrapping the prod error handler would mask the real cause and
  // make the bug invisible from logs at the route level.
  let row: schema.Webhook | undefined;
  try {
    [row] = await db
      .insert(schema.webhooks)
      .values({
        id,
        channelId: input.channelId,
        guildId,
        name,
        avatarUrl,
        token,
        createdBy: input.actorId,
      })
      .returning();
  } catch (err) {
    log.error('webhook insert failed', {
      err,
      channelId: input.channelId.toString(),
      guildId: guildId.toString(),
      actorId: input.actorId.toString(),
    });
    const msg = err instanceof Error ? err.message : String(err);
    throw errors.internal(`Webhook create failed: ${msg}`);
  }
  if (!row) throw errors.internal('Webhook insert returned no row');

  try {
    await writeAudit({
      guildId,
      actorId: input.actorId,
      action: 'webhook_create',
      targetType: 'webhook',
      targetId: id,
      changes: { channelId: input.channelId.toString(), name },
    });
  } catch (err) {
    // Audit write failed but the webhook itself was created. Log
    // and continue rather than throwing — losing one audit row
    // beats blocking the whole feature on an audit-table issue.
    log.error('webhook audit write failed', {
      err,
      webhookId: id.toString(),
      guildId: guildId.toString(),
    });
  }

  return row;
}

export async function listChannelWebhooks(
  channelId: bigint,
  actorId: bigint,
): Promise<schema.Webhook[]> {
  await assertManageWebhooks(channelId, actorId);
  return db
    .select()
    .from(schema.webhooks)
    .where(eq(schema.webhooks.channelId, channelId))
    .orderBy(schema.webhooks.createdAt);
}

export async function deleteWebhook(webhookId: bigint, actorId: bigint): Promise<void> {
  // Read the row first so we know the channel + guild for the perm
  // check + audit. A webhook id without context can't be permission-
  // checked — we'd have to either trust the caller or lookup. We
  // lookup.
  const rows = await db
    .select()
    .from(schema.webhooks)
    .where(eq(schema.webhooks.id, webhookId))
    .limit(1);
  const wh = rows[0];
  if (!wh) throw errors.notFound('Webhook');
  await assertManageWebhooks(wh.channelId, actorId);
  await db.delete(schema.webhooks).where(eq(schema.webhooks.id, webhookId));
  // Drop the avatar file too if it was CDN-hosted, so deleting a webhook
  // doesn't leave its picture orphaned on disk.
  if (wh.avatarUrl) {
    const { parseCdnAttachmentId, deleteAttachmentFile } = await import('./uploads');
    const id = parseCdnAttachmentId(wh.avatarUrl);
    if (id !== null) void deleteAttachmentFile(id);
  }
  await writeAudit({
    guildId: wh.guildId,
    actorId,
    action: 'webhook_delete',
    targetType: 'webhook',
    targetId: webhookId,
    changes: { channelId: wh.channelId.toString(), name: wh.name },
  });
}

export interface PatchWebhookInput {
  webhookId: bigint;
  actorId: bigint;
  name?: string;
  avatarUrl?: string | null;
}

export async function patchWebhook(input: PatchWebhookInput): Promise<schema.Webhook> {
  const rows = await db
    .select()
    .from(schema.webhooks)
    .where(eq(schema.webhooks.id, input.webhookId))
    .limit(1);
  const wh = rows[0];
  if (!wh) throw errors.notFound('Webhook');
  await assertManageWebhooks(wh.channelId, input.actorId);

  const update: Partial<schema.NewWebhook> = {};
  if (input.name !== undefined) update.name = validateName(input.name);
  if (input.avatarUrl !== undefined) update.avatarUrl = validateAvatarUrl(input.avatarUrl);

  if (Object.keys(update).length === 0) return wh;

  const [updated] = await db
    .update(schema.webhooks)
    .set(update)
    .where(eq(schema.webhooks.id, input.webhookId))
    .returning();
  if (!updated) throw errors.internal('Webhook update returned no row');

  // Clean up the previous avatar file if it was CDN-hosted and actually
  // changed, so replacing or clearing a webhook picture doesn't orphan the
  // old image on disk. External (http) avatar URLs aren't ours to delete —
  // parseCdnAttachmentId returns null for those, so they're left alone.
  if ('avatarUrl' in update && wh.avatarUrl && wh.avatarUrl !== updated.avatarUrl) {
    const { parseCdnAttachmentId, deleteAttachmentFile } = await import('./uploads');
    const priorId = parseCdnAttachmentId(wh.avatarUrl);
    if (priorId !== null) void deleteAttachmentFile(priorId);
  }

  await writeAudit({
    guildId: wh.guildId,
    actorId: input.actorId,
    action: 'webhook_update',
    targetType: 'webhook',
    targetId: input.webhookId,
    changes: {
      channelId: wh.channelId.toString(),
      ...('name' in update ? { newName: update.name } : {}),
    },
  });
  return updated;
}

// ── Execute ────────────────────────────────────────────────────────────────
//
// Public, token-gated. Returns the created message (Discord returns it
// when ?wait=true; we always return it because the route wrapper is
// already built around a JSON response and the body is small).

export interface ExecuteWebhookInput {
  webhookId: bigint;
  token: string;
  content: string;
  /** Per-message override for the webhook's display name. */
  username?: string | null;
  /** Per-message override for the webhook's avatar. */
  avatarUrl?: string | null;
  /** Pre-parsed rich embed cards (Discord-style) to store on the message. */
  embeds?: schema.MessageEmbedJson[] | null;
}

export async function executeWebhook(input: ExecuteWebhookInput): Promise<schema.Message> {
  // Pin the lookup on BOTH id and token. We read both in a single query
  // so a leaked id without the token can't be confirmed (the row simply
  // doesn't exist from the caller's perspective).
  const rows = await db
    .select()
    .from(schema.webhooks)
    .where(and(eq(schema.webhooks.id, input.webhookId), eq(schema.webhooks.token, input.token)))
    .limit(1);
  const wh = rows[0];
  if (!wh) {
    // 401 because the route is auth-by-token and we want the failure to
    // look like authentication failure — not 404 (which leaks existence).
    throw errors.unauthenticated('Invalid webhook id or token');
  }

  // Validate the target channel still exists. channels.deleteChannel
  // soft-deletes the channel row but doesn't cascade to webhooks —
  // without this check, a leaked or pre-existing webhook token keeps
  // producing messages against a channel that no longer renders for
  // anyone. The messages would persist in the messages table pointing
  // at a deletedAt-set channel; clients filter them out, but DB bloat
  // and audit-trail noise remain. Generic "invalid" surface to avoid
  // leaking deletion state.
  const channelRows = await db
    .select({ id: schema.channels.id, deletedAt: schema.channels.deletedAt })
    .from(schema.channels)
    .where(eq(schema.channels.id, wh.channelId))
    .limit(1);
  if (!channelRows[0] || channelRows[0].deletedAt !== null) {
    throw errors.unauthenticated('Invalid webhook id or token');
  }

  // Persona resolution: per-message overrides win over the webhook's
  // stored values, which win over a default. Validation runs here so
  // a bogus per-message value is rejected with a useful error rather
  // than silently dropping back to the stored default.
  const personaName =
    input.username !== undefined && input.username !== null
      ? validateName(input.username)
      : wh.name;
  const personaAvatar =
    input.avatarUrl !== undefined
      ? validateAvatarUrl(input.avatarUrl)
      : wh.avatarUrl;

  // We post as the webhook's owner. Three failure modes to reject:
  //   - createdBy is NULL (owner row hard-deleted; webhook orphaned)
  //   - owner is banned (their REST/gateway is gated, but their
  //     pre-existing webhook token would keep working — an evasion
  //     path for any admin who created webhooks before being
  //     banned)
  //   - owner is soft-deleted (account-deletion in flight; we
  //     shouldn't keep posting as them)
  // All three return the generic invalid-token surface so the
  // failure mode of a compromised token from a deleted/banned user
  // looks identical to a wrong token.
  if (!wh.createdBy) {
    throw errors.badRequest('Webhook owner has been removed; recreate this webhook');
  }
  // Full row (not just bannedAt/deletedAt) so we can reuse it as the message
  // author below instead of re-querying the same user.
  const ownerRows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, wh.createdBy))
    .limit(1);
  if (!ownerRows[0] || isCurrentlyBanned(ownerRows[0]) || ownerRows[0].deletedAt !== null) {
    throw errors.unauthenticated('Invalid webhook id or token');
  }

  const result = await createMessage({
    channelId: wh.channelId,
    authorId: wh.createdBy,
    content: input.content,
    guildId: wh.guildId,
    // Webhooks can't @everyone for v1. If we relax this we should add a
    // per-webhook flag (Discord's mention_everyone permission on the
    // webhook itself). For now, easier to be safe and not surprise
    // server members with everyone-pings from external services.
    allowEveryoneMention: false,
    webhookId: wh.id,
    authorOverrideName: personaName,
    authorOverrideAvatar: personaAvatar,
    embeds: input.embeds && input.embeds.length > 0 ? input.embeds : undefined,
  });

  // Broadcast through the normal gateway path so connected clients see
  // the message arrive in real time. Building the DTO mirrors what the
  // routes/messages send-message handler does — load author, fan
  // attachments, hand to the toMessage builder. The message DTO
  // carries webhookId + override fields so client-side renderers know
  // which row is webhook-authored.
  // Reuse the owner row fetched above (already proven to exist and be
  // non-deleted/non-banned) instead of re-querying. Webhook messages carry
  // no attachments (createMessage was called without any), so the previous
  // loadAttachments() was a guaranteed-empty round-trip — pass [] directly.
  const author = ownerRows[0];
  const messageDTO = toMessage({
    message: result.message,
    author,
    attachments: [],
    reactions: [],
    mentionedUserIds: result.mentionedUserIds,
    mentionedRoleIds: result.mentionedRoleIds,
    // selfId omitted — webhook execution has no caller-user context
    // (the request is unauthed). The DTO's "is this from me?" flag
    // matters for client-side optimistic-bubble dedup, which doesn't
    // apply here since no client originated this message.
  });
  dispatch.messageCreate({
    messageDTO,
    channelId: wh.channelId,
    guildId: wh.guildId,
  });

  return result.message;
}
