/**
 * Webhooks routers
 * ----------------
 * Two routers because webhooks have two different audiences:
 *
 *   1. webhooksAdminRouter — mounted under /api/v1, all routes require
 *      auth + MANAGE_WEBHOOKS. Used by the channel-settings UI to
 *      create / list / patch / delete webhooks. The list response
 *      includes the secret token (Discord behaves the same way — the
 *      perm gate is the only protection).
 *
 *   2. webhooksExecuteRouter — mounted at /api/webhooks (NOT under
 *      /api/v1) so it bypasses the auth middleware applied to v1.
 *      Anyone with the token can post; that's the whole point of
 *      webhooks. The token is the bearer secret.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors';
import { requireAuth, requireUserId } from '../auth/middleware';
import { validate } from '../lib/validate';
import { parseFormBody } from '../middleware/multipartCompat';
import { snowflakeSchema, webhookUsernameSchema } from '../lib/validation';
import { toWebhook } from '../lib/dto';
import { RateLimiter } from '../lib/rateLimit';
import * as webhooks from '../services/webhooks';
import type { MessageEmbedJson } from '@zekktris/db';

// ── Execute-endpoint rate limiters ─────────────────────────────────────────
//
// The /api/webhooks/:webhookId/:token endpoint is bearer-token auth with
// the token literally in the URL path. Anywhere that URL gets leaked
// (CI config repo, accidentally-shared chat message, server access logs,
// shoulder-surf on a settings screen) becomes a flooding vector against
// the bound channel. Limit per-webhook so a single compromised URL can't
// be used to bury the channel under spam, while keeping the ceiling
// generous enough that legitimate burst senders (GitHub Actions fan-out,
// Uptime Kuma alerting cascades) aren't penalised.
//
// Two-tier limit:
//   - 10 messages per 5-second window (burst)
//   - 60 messages per 60-second window (sustained)
//
// Both consume on every request; whichever trips first wins. Discord's
// public docs cite ~5/5s; we're slightly more generous because the
// failure mode of being a touch too lax is "channel temporarily noisy"
// whereas the failure mode of being a touch too strict is "legitimate
// CI integration breaks intermittently and operator has to debug it."
const webhookExecBurst = new RateLimiter(10, 5_000, 'webhook-burst');
const webhookExecSustained = new RateLimiter(60, 60_000, 'webhook-sustained');

// ── Admin router — auth + MANAGE_WEBHOOKS ────────────────────────────────

export const webhooksAdminRouter = new Hono();
// requireAuth is applied PER-ROUTE below, NOT via a catch-all `.use('*')`. A
// catch-all here leaks onto sibling routers mounted at '/' after this one in
// Hono (notably federation's PUBLIC enrollment/JWKS routes, which would then
// 401). Gating each route keeps auth scoped to this router only.

const createSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.string().max(1024).nullish(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  avatarUrl: z.string().max(1024).nullish(),
});

webhooksAdminRouter.post(
  '/channels/:channelId/webhooks',
  requireAuth,
  validate('param', z.object({ channelId: snowflakeSchema })),
  validate('json', createSchema),
  async (c) => {
    const actorId = requireUserId(c);
    const { channelId } = c.req.valid('param');
    const body = c.req.valid('json');
    const wh = await webhooks.createWebhook({
      channelId: BigInt(channelId),
      actorId,
      name: body.name,
      avatarUrl: body.avatarUrl ?? null,
    });
    return c.json({ webhook: toWebhook(wh) }, 201);
  },
);

webhooksAdminRouter.get(
  '/channels/:channelId/webhooks',
  requireAuth,
  validate('param', z.object({ channelId: snowflakeSchema })),
  async (c) => {
    const actorId = requireUserId(c);
    const { channelId } = c.req.valid('param');
    const list = await webhooks.listChannelWebhooks(BigInt(channelId), actorId);
    return c.json({ webhooks: list.map(toWebhook) });
  },
);

webhooksAdminRouter.patch(
  '/webhooks/:webhookId',
  requireAuth,
  validate('param', z.object({ webhookId: snowflakeSchema })),
  validate('json', patchSchema),
  async (c) => {
    const actorId = requireUserId(c);
    const { webhookId } = c.req.valid('param');
    const body = c.req.valid('json');
    const updated = await webhooks.patchWebhook({
      webhookId: BigInt(webhookId),
      actorId,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl ?? null } : {}),
    });
    return c.json({ webhook: toWebhook(updated) });
  },
);

webhooksAdminRouter.delete(
  '/webhooks/:webhookId',
  requireAuth,
  validate('param', z.object({ webhookId: snowflakeSchema })),
  async (c) => {
    const actorId = requireUserId(c);
    const { webhookId } = c.req.valid('param');
    await webhooks.deleteWebhook(BigInt(webhookId), actorId);
    return c.body(null, 204);
  },
);

// POST /webhooks/:webhookId/avatar — multipart image upload → set the
// webhook's avatar to the resulting /cdn/ path. Gives the webhook its own
// picture without the operator needing an image URL on hand. Permission is
// enforced inside patchWebhook (manage-webhooks on the channel).
const WEBHOOK_AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
webhooksAdminRouter.post(
  '/webhooks/:webhookId/avatar',
  requireAuth,
  validate('param', z.object({ webhookId: snowflakeSchema })),
  async (c) => {
    const actorId = requireUserId(c);
    const { webhookId } = c.req.valid('param');
    const form = await parseFormBody(c);
    const file = form.file;
    if (!(file instanceof File)) {
      throw errors.badRequest('Missing file (expected multipart field "file")');
    }
    if (!WEBHOOK_AVATAR_TYPES.has(file.type)) {
      throw errors.badRequest('Avatar must be a PNG, JPEG, GIF, or WebP image');
    }
    const { saveUploadedFile } = await import('../services/uploads');
    const saved = await saveUploadedFile(file);
    const updated = await webhooks.patchWebhook({
      webhookId: BigInt(webhookId),
      actorId,
      avatarUrl: saved.url,
    });
    return c.json({ webhook: toWebhook(updated) });
  },
);

// ── Public execute router — token-gated, NO auth ──────────────────────────
//
// Mounted at /api/webhooks (top-level, not /api/v1) so it sits outside
// the auth middleware. Token is supplied in the URL path; rate limits
// can be applied per-token at the proxy layer.

export const webhooksExecuteRouter = new Hono();

// Embed shape we accept from Discord-compatible senders. We now store + render
// these as rich cards (color, author, fields, image, thumbnail, footer) rather
// than flattening to text — see parseWebhookEmbeds below. Field caps mirror
// Discord's so an oversized payload can't bloat a row. icon/image keys accept
// both snake_case (Discord) and camelCase.
const embedSchema = z
  .object({
    title: z.string().max(256).nullish(),
    description: z.string().max(4096).nullish(),
    url: z.string().max(2048).nullish(),
    color: z.number().int().nullish(),
    timestamp: z.string().max(64).nullish(),
    author: z
      .object({
        name: z.string().max(256).nullish(),
        icon_url: z.string().max(2048).nullish(),
        iconUrl: z.string().max(2048).nullish(),
      })
      .passthrough()
      .nullish(),
    footer: z
      .object({
        text: z.string().max(2048).nullish(),
        icon_url: z.string().max(2048).nullish(),
        iconUrl: z.string().max(2048).nullish(),
      })
      .passthrough()
      .nullish(),
    image: z.object({ url: z.string().max(2048).nullish() }).passthrough().nullish(),
    thumbnail: z.object({ url: z.string().max(2048).nullish() }).passthrough().nullish(),
    fields: z
      .array(
        z.object({
          name: z.string().max(256),
          value: z.string().max(1024),
          inline: z.boolean().nullish(),
        }),
      )
      .max(25)
      .nullish(),
  })
  .passthrough(); // tolerate extra fields (provider, video, etc.)

/** Accept only http(s) URLs. Image/icon URLs are rendered directly as
 *  <img>/AsyncImage and the embed `url` becomes a clickable link, so rejecting
 *  javascript:/data:/relative here (the trust boundary for untrusted webhook
 *  input) is what stops a `javascript:` href or non-image scheme being stored. */
function safeHttpUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (s.length === 0 || s.length > 2048) return null;
  return /^https?:\/\//i.test(s) ? s : null;
}

/** Total stored embed text budget per message. Per-field caps alone allow
 *  ~0.5MB of JSONB across 10 maxed embeds; this bounds row bloat. Generous vs
 *  Discord's ~6000-char per-message total, so real payloads are unaffected —
 *  once exceeded, remaining embeds are dropped. */
const MAX_EMBED_TOTAL_CHARS = 50_000;

/** Convert incoming Discord-style embeds into stored rich embed cards. Skips
 *  embeds with no renderable content so an empty `{}` doesn't render a blank
 *  card, and stops once the per-message text budget is exceeded. */
function parseWebhookEmbeds(embeds: ExecuteBody['embeds']): MessageEmbedJson[] {
  if (!embeds || embeds.length === 0) return [];
  const out: MessageEmbedJson[] = [];
  let totalChars = 0;
  for (const e of embeds.slice(0, 10)) {
    const authorName = e.author?.name?.trim() || null;
    const footerText = e.footer?.text?.trim() || null;
    const fields = (e.fields ?? [])
      .slice(0, 25)
      .map((f) => ({ name: f.name, value: f.value, inline: !!f.inline }));
    const imageUrl = safeHttpUrl(e.image?.url);
    const thumbnailUrl = safeHttpUrl(e.thumbnail?.url);
    const title = e.title?.trim() || null;
    const description = e.description?.trim() || null;
    // Drop embeds with nothing to show.
    if (!title && !description && !imageUrl && !thumbnailUrl && !authorName && !footerText && fields.length === 0) {
      continue;
    }
    // Aggregate-size guard: stop adding embeds once the message text budget is
    // exceeded (the per-field caps don't bound the cross-embed total).
    const size =
      (title?.length ?? 0) +
      (description?.length ?? 0) +
      (authorName?.length ?? 0) +
      (footerText?.length ?? 0) +
      fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    if (totalChars + size > MAX_EMBED_TOTAL_CHARS) break;
    totalChars += size;
    out.push({
      kind: 'rich',
      // Scheme-validated: a `javascript:`/`data:` url would otherwise be
      // rendered as a clickable href (stored XSS on web — React doesn't
      // sanitize hrefs). Empty string => "no link", which both clients honor.
      url: safeHttpUrl(e.url) ?? '',
      title,
      description,
      color: typeof e.color === 'number' ? e.color : null,
      imageUrl,
      thumbnailUrl,
      authorName,
      authorIconUrl: authorName ? safeHttpUrl(e.author?.icon_url ?? e.author?.iconUrl) : null,
      footerText,
      footerIconUrl: footerText ? safeHttpUrl(e.footer?.icon_url ?? e.footer?.iconUrl) : null,
      fields: fields.length > 0 ? fields : null,
      timestamp: e.timestamp ?? null,
      siteName: null,
      faviconUrl: null,
    });
  }
  return out;
}

const executeSchema = z.object({
  /** Discord-compatible: most senders post `content`. Senders that
      use `embeds` only (Uptime Kuma, GitHub Actions, etc.) get
      synthesized content from the embed's title/description. */
  content: z.string().min(1).max(2000).nullish(),
  /** Per-message persona override. Optional. Sanitized to strip
      invisible/bidi chars that would let a webhook impersonate
      real users. */
  username: webhookUsernameSchema.nullish(),
  /** Per-message avatar override. Discord uses `avatar_url`; we accept
      both that and `avatarUrl` so library authors don't have to think
      about which one we use. */
  avatar_url: z.string().max(1024).nullish(),
  avatarUrl: z.string().max(1024).nullish(),
  /** Discord-style embeds — stored + rendered as rich cards (color, author,
      fields, image, thumbnail, footer). Cap to 10, Discord's limit. */
  embeds: z.array(embedSchema).max(10).nullish(),
  /** Uptime Kuma's generic "Webhook" notification posts
      { heartbeat, monitor, msg } — no content/embeds at all. `msg`
      carries the human-readable line ("[My site] ✅ Up" etc.), so we
      accept it as a content source. */
  msg: z.string().max(4000).nullish(),
  /** Slack-compatible senders post `text`. */
  text: z.string().max(4000).nullish(),
  /** Some generic senders pair `title` with a body field. */
  title: z.string().max(300).nullish(),
  /** Kuma metadata — used as a last-resort content synthesizer when
      msg is absent (and tolerated otherwise). */
  monitor: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  heartbeat: z
    .object({ status: z.number().nullish(), msg: z.string().nullish() })
    .passthrough()
    .nullish(),
});

type ExecuteBody = z.infer<typeof executeSchema>;

webhooksExecuteRouter.post(
  '/:webhookId/:token',
  validate('param', z.object({ webhookId: snowflakeSchema, token: z.string().min(8).max(64) })),
  validate('json', executeSchema),
  async (c) => {
    const { webhookId, token } = c.req.valid('param');
    // Rate-limit BEFORE any DB work. Key by webhookId so each webhook
    // gets its own bucket — a compromised token can't be used to
    // exhaust a shared limit and lock out other webhooks. Note we
    // intentionally don't include the token in the key: the limiter
    // should still gate even when an attacker rotates through
    // guesses against the same webhookId, and using just the id
    // bucket means the (rejected) bad-token attempts share quota
    // with the legitimate sender, which is the conservative choice.
    {
      const k = webhookId;
      const burst = await webhookExecBurst.consume(k);
      if (!burst.ok) throw errors.rateLimited(Math.ceil(burst.retryAfterMs / 1000));
      const sustained = await webhookExecSustained.consume(k);
      if (!sustained.ok) throw errors.rateLimited(Math.ceil(sustained.retryAfterMs / 1000));
    }
    const body = c.req.valid('json');
    // Avatar URL: prefer the snake_case Discord-compatible field; fall
    // back to camelCase. Treat undefined as "don't override" and empty
    // string as "explicit clear" (which the service handles as null).
    const avatarOverride =
      body.avatar_url !== undefined
        ? body.avatar_url
        : body.avatarUrl !== undefined
          ? body.avatarUrl
          : undefined;
    // Parse Discord-style embeds into rich cards we store + render (color,
    // author, fields, image, thumbnail, footer). These no longer get flattened
    // into the content string — they ride along as embeds, so an embed-only
    // payload posts a card with no text body.
    const richEmbeds = parseWebhookEmbeds(body.embeds);
    // Resolve a content string. Use `content` directly when provided. The
    // msg/text/title and Kuma monitor/heartbeat fallbacks only kick in when
    // there's neither content NOR an embed to show, so a bare Kuma status ping
    // still lands as readable text.
    let content = body.content?.trim();
    if (!content && richEmbeds.length === 0) {
      // Uptime Kuma ("Webhook" type) / Slack-style fallbacks: msg or text,
      // optionally prefixed by a title.
      const bodyText = body.msg?.trim() || body.text?.trim() || '';
      const title = body.title?.trim();
      if (bodyText) {
        content = (title ? `**${title}**\n${bodyText}` : bodyText).slice(0, 2000);
      }
    }
    if (!content && richEmbeds.length === 0 && (body.monitor || body.heartbeat)) {
      // Last resort: synthesize from Kuma's monitor/heartbeat metadata so a
      // bare status ping still lands as something readable.
      const name = body.monitor?.name ?? 'Monitor';
      const hb = body.heartbeat;
      const status =
        hb?.status === 1 ? '✅ Up' : hb?.status === 0 ? '❌ Down' : 'status update';
      content = `**${name}** ${status}${hb?.msg ? ` — ${hb.msg}` : ''}`.slice(0, 2000);
    }
    if (!content && richEmbeds.length === 0) {
      throw errors.badRequest(
        'Webhook payload must include `content`, `embeds`, `msg`, or `text`',
      );
    }
    try {
      await webhooks.executeWebhook({
        webhookId: BigInt(webhookId),
        token,
        content: content ?? '',
        username: body.username ?? undefined,
        avatarUrl: avatarOverride === undefined ? undefined : (avatarOverride ?? null),
        embeds: richEmbeds.length > 0 ? richEmbeds : undefined,
      });
    } catch (e) {
      // Re-throw — the central error handler converts AppError to a
      // proper response. We only catch here to add a generic fallback
      // for unexpected throws.
      throw e;
    }
    // Discord returns 204 by default and the message body when called
    // with ?wait=true. Returning 204 keeps the wire small and matches
    // the client expectation for fire-and-forget webhook senders.
    return c.body(null, 204);
  },
);
