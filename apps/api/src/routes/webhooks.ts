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
import { snowflakeSchema, webhookUsernameSchema } from '../lib/validation';
import { toWebhook } from '../lib/dto';
import { RateLimiter } from '../lib/rateLimit';
import * as webhooks from '../services/webhooks';

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
const webhookExecBurst = new RateLimiter(10, 5_000);
const webhookExecSustained = new RateLimiter(60, 60_000);

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
    const form = await c.req.parseBody();
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

// Embed shape we accept from Discord-compatible senders. We don't
// fully render embeds yet — we extract title + description into a
// fallback content string so the message at least shows up. This
// keeps Uptime Kuma's default Discord webhook integration working
// out of the box (its status-change notifications post embeds with
// no top-level `content` field; the test-message DOES include
// content, which is why test worked but real alerts didn't).
const embedSchema = z
  .object({
    title: z.string().nullish(),
    description: z.string().nullish(),
    url: z.string().nullish(),
  })
  .passthrough(); // tolerate extra fields (color, fields[], thumbnail, footer, etc.)

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
  /** Discord-style embeds. We don't render rich cards yet; we
      flatten to a text content string when no top-level content is
      provided. Cap to 10 — Discord's limit, more than enough. */
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
      const burst = webhookExecBurst.consume(k);
      if (!burst.ok) throw errors.rateLimited(Math.ceil(burst.retryAfterMs / 1000));
      const sustained = webhookExecSustained.consume(k);
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
    // Resolve a content string. If the sender provided `content`,
    // use it directly. Otherwise synthesize from embeds — title +
    // description per embed, joined with newlines. This keeps
    // Discord-compatible senders (Uptime Kuma, GitHub Actions, etc)
    // working when they only ship embed cards.
    let content = body.content?.trim();
    if (!content && body.embeds && body.embeds.length > 0) {
      const parts: string[] = [];
      for (const e of body.embeds) {
        const seg: string[] = [];
        if (e.title) seg.push(`**${e.title}**`);
        if (e.description) seg.push(e.description);
        if (seg.length > 0) parts.push(seg.join('\n'));
      }
      content = parts.join('\n\n').slice(0, 2000);
    }
    // Uptime Kuma ("Webhook" type) / Slack-style fallbacks: msg or text,
    // optionally prefixed by a title.
    if (!content) {
      const bodyText = body.msg?.trim() || body.text?.trim() || '';
      const title = body.title?.trim();
      if (bodyText) {
        content = (title ? `**${title}**\n${bodyText}` : bodyText).slice(0, 2000);
      }
    }
    // Last resort: synthesize from Kuma's monitor/heartbeat metadata so a
    // bare status ping still lands as something readable.
    if (!content && (body.monitor || body.heartbeat)) {
      const name = body.monitor?.name ?? 'Monitor';
      const hb = body.heartbeat;
      const status =
        hb?.status === 1 ? '✅ Up' : hb?.status === 0 ? '❌ Down' : 'status update';
      content = `**${name}** ${status}${hb?.msg ? ` — ${hb.msg}` : ''}`.slice(0, 2000);
    }
    if (!content) {
      throw errors.badRequest(
        'Webhook payload must include `content`, `embeds`, `msg`, or `text`',
      );
    }
    try {
      await webhooks.executeWebhook({
        webhookId: BigInt(webhookId),
        token,
        content,
        username: body.username ?? undefined,
        avatarUrl: avatarOverride === undefined ? undefined : (avatarOverride ?? null),
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
