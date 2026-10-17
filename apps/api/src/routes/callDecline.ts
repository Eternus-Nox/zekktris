/**
 * Call decline from a push notification
 * -------------------------------------
 * Mounted at /api/v1/call-decline.
 *
 *   POST /call-decline   { token }   — decline the ringing 1:1 DM call
 *
 * The web push "Decline" button runs in the service worker, which has no
 * bearer token, so it can't use POST /channels/:id/voice/decline. Instead
 * the ring push carries a signed, short-lived capability
 * (auth/callDeclineToken.ts) bound to the callee, the DM, the caller and
 * that specific call; this endpoint accepts ONLY that token and does ONLY
 * the decline. It is deliberately not under /channels: routers mounted
 * there apply requireAuth to every /channels/* path.
 *
 * Idempotent: an ended, answered or superseded call is a 200 no-op.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { validate } from '../lib/validate';
import { errors } from '../errors';
import { verifyCallDeclineToken } from '../auth/callDeclineToken';
import { declineDmCall } from './voice';

export const callDeclineRouter = new Hono();

callDeclineRouter.post(
  '/',
  validate('json', z.object({ token: z.string().min(1).max(512) })),
  async (c) => {
    const claims = verifyCallDeclineToken(c.req.valid('json').token);
    if (!claims) throw errors.unauthenticated('Invalid or expired decline token');
    const result = await declineDmCall(claims.userId, claims.channelId, {
      callerId: claims.callerId,
      callStartedAtMs: claims.callStartedAtMs,
    });
    if (result === 'not_found') throw errors.notFound('Channel');
    return c.json({ ok: true });
  },
);
