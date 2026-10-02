/**
 * Server composition
 * ------------------
 * Builds the Hono application — middleware order, route mounting, error
 * handling. The actual port binding lives in index.ts so tests can import
 * the app and exercise it without a network round-trip.
 *
 * Routes are mounted under /api/v1. The bare /health is intentionally NOT
 * versioned — health probes outlive API versions.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { errors } from './errors';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { guildsRouter } from './routes/guilds';
import { channelsRouter, guildChannelsRouter } from './routes/channels';
import { invitesRouter, guildInvitesRouter } from './routes/invites';
import { emojisRouter } from './routes/emojis';
import { stickersRouter } from './routes/stickers';
import { stageRouter } from './routes/stage';
import { discoveryRouter } from './routes/discovery';
import { unfurlRouter } from './routes/unfurl';
import { adminRouter } from './routes/admin';
import { instanceRouter } from './routes/instance';
import { messagesRouter } from './routes/messages';
import { webhooksAdminRouter, webhooksExecuteRouter } from './routes/webhooks';
import { familyRouter } from './routes/family';
import { billingRouter } from './routes/billing';
import { dmsRouter } from './routes/dms';
import { cdnRouter } from './routes/cdn';
import { voiceRouter } from './routes/voice';
import { requestId, accessLog, errorHandler } from './middleware';
import { env, isDev } from './env';

export function createApp() {
  const app = new Hono();

  // ── Global middleware (order matters) ──────────────────────────────────
  app.use('*', requestId);
  app.use('*', accessLog);
  app.use('*', secureHeaders());

  // ── Request body size limit ────────────────────────────────────────────
  // Bound how many bytes any single request can stream in, so a malicious or
  // buggy client can't exhaust memory with an unbounded body. Two ceilings,
  // dispatched by content-type because file uploads legitimately dwarf JSON:
  //   • multipart/form-data → the upload ceiling (per-file cap × max files,
  //     plus framing overhead). Per-file / per-message caps are still
  //     enforced downstream in the upload service; this is the outer bound.
  //   • everything else (JSON / urlencoded / text / Stripe webhook) → 8 MB,
  //     comfortably above the largest legit JSON body (a guild-backup import:
  //     ≤1000 roles + channels, low single-digit MB) while rejecting bombs.
  // bodyLimit measures ACTUAL streamed bytes, so a spoofed/absent
  // Content-Length can't slip past it.
  const JSON_BODY_LIMIT = 8 * 1024 * 1024;
  const UPLOAD_BODY_LIMIT =
    env.MAX_UPLOAD_SIZE_MB * 1024 * 1024 * env.MAX_FILES_PER_MESSAGE +
    4 * 1024 * 1024; // multipart framing + payload_json overhead
  const onBodyTooLarge = () => {
    throw errors.payloadTooLarge('Request body too large');
  };
  const jsonBodyLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: onBodyTooLarge });
  const uploadBodyLimit = bodyLimit({ maxSize: UPLOAD_BODY_LIMIT, onError: onBodyTooLarge });
  app.use('*', (c, next) => {
    const ct = c.req.header('content-type') ?? '';
    return ct.includes('multipart/form-data')
      ? uploadBodyLimit(c, next)
      : jsonBodyLimit(c, next);
  });

  // CORS: relaxed in dev (Vite at :5173); locked down in prod via reverse proxy.
  // The proxy serves the SPA from the same origin as /api, so CORS isn't
  // triggered in production.
  if (isDev) {
    app.use(
      '*',
      cors({
        origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
        credentials: true,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
        exposeHeaders: ['X-Request-Id'],
      }),
    );
  }

  // ── Routes ─────────────────────────────────────────────────────────────
  app.route('/health', healthRouter);

  // Prometheus scrape endpoint. Opt-in: disabled (404, no signal) unless
  // METRICS_TOKEN is set, in which case a scraper must present it as a Bearer
  // token (Prometheus `authorization.credentials`). Header-only — never a
  // query param — so the token can't leak into access logs. Lives at the root
  // (not /api/v1) and is NOT proxied by the bundled Caddy, so it's reachable
  // only on the internal network unless an operator adds a route. The same
  // numbers are available to instance admins at /api/v1/admin/metrics.
  app.get('/metrics', async (c) => {
    const token = env.METRICS_TOKEN;
    if (!token) return c.notFound();
    const auth = c.req.header('authorization');
    const provided = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    // Constant-time compare — avoid leaking the token via response timing.
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.text('unauthorized\n', 401);
    }
    const { gatherMetrics, toPrometheus } = await import('./services/metrics');
    const body = toPrometheus(await gatherMetrics());
    return c.text(body, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  });

  // CDN: served outside the /api/v1 prefix because static-file URLs shouldn't
  // change with API version bumps. In production Caddy serves these directly.
  app.route('/cdn', cdnRouter);

  // Versioned API root. Auth, users, guilds, channels, messages, gateway-
  // bootstrap, etc. all hang off /api/v1. Future breaking changes get /api/v2.
  const v1 = new Hono();
  v1.route('/auth', authRouter);
  v1.route('/users', usersRouter);
  // DM channel management hangs off /users/@me/channels for symmetry with
  // user-scoped resources.
  v1.route('/users/@me/channels', dmsRouter);
  // Guild-scoped sub-routers register their own /:guildId/<x> paths and need
  // to be mounted at the same /guilds prefix as the main guildsRouter.
  v1.route('/guilds', guildsRouter);
  v1.route('/guilds', guildChannelsRouter);
  v1.route('/guilds', guildInvitesRouter);
  v1.route('/guilds', emojisRouter);
  v1.route('/guilds', stickersRouter);
  // Channel-scoped routers mount additively at /channels.
  v1.route('/channels', channelsRouter);
  v1.route('/channels', messagesRouter);
  v1.route('/channels', voiceRouter);
  v1.route('/channels', stageRouter);
  v1.route('/', discoveryRouter);
  v1.route('/invites', invitesRouter);
  // Client-side link-preview resolution for E2EE messages (the server can't
  // unfurl ciphertext). See routes/unfurl.ts.
  v1.route('/unfurl', unfurlRouter);
  // Instance-wide read-only config for any signed-in user (monetization
  // paywall matrix) — the admin WRITE side lives under /admin.
  v1.route('/instance', instanceRouter);
  v1.route('/admin', adminRouter);
  // Webhook admin endpoints — auth-gated, registered under /api/v1.
  // The router itself has /channels/:channelId/webhooks and /webhooks/:id
  // routes; mounting at the v1 root means no path prefix collision.
  v1.route('/', webhooksAdminRouter);
  // Parental controls — linking + supervision summary. Defines its own
  // /family/* paths so it mounts at the v1 root.
  v1.route('/', familyRouter);
  // Legacy Stripe wind-down (portal/cancel/webhook; no checkout). The webhook
  // (/api/v1/billing/webhook) is unauthenticated by design — authenticity
  // comes from Stripe's signature over the raw body.
  v1.route('/billing', billingRouter);
  app.route('/api/v1', v1);

  // Public webhook execute — outside /api/v1 so the auth middleware
  // chain doesn't apply. The token in the URL is the gate.
  app.route('/api/webhooks', webhooksExecuteRouter);

  // 404 fallback — anything not matched above.
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));

  // ── Error handler — must be last ───────────────────────────────────────
  app.onError(errorHandler);

  return app;
}
