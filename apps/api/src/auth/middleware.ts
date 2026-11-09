/**
 * Auth middleware
 * ---------------
 * `requireAuth`: rejects the request unless a valid access token is present
 * in the Authorization header. On success, c.get('userId') and
 * c.get('sessionId') are set for downstream handlers.
 *
 * Note we deliberately do NOT look up the session in the db on every
 * request — the JWT signature + expiry is enough. This keeps the hot path
 * one query lighter.
 *
 * Revocation is made prompt (not just at token expiry) by a cheap session
 * blacklist check: on revoke the session id is added to a short-lived
 * blacklist (Redis when configured, else in-memory), and we reject here if
 * the token's `sid` is listed. One blacklist lookup per authed request — no
 * DB hit — and it fails open so a Redis blip degrades to the old
 * expire-on-TTL behaviour rather than locking everyone out. See
 * ./session-blacklist.ts.
 *
 * The one exception is an intent token (`Authorization: Intent …`, see
 * signIntentToken): it lives 30 days, so its session row IS read on each use,
 * and it only opens the few routes the native Siri / widget / watch senders
 * call. See authenticateIntent.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { verifyAccessToken, verifyIntentToken } from './tokens';
import { isSessionBlacklisted } from './session-blacklist';
import { isCurrentlyBanned } from '../services/instanceBans';

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('authorization');
  if (!header) {
    throw errors.unauthenticated();
  }

  // Bot token path: `Authorization: Bot <token>`. Bots authenticate
  // with a static token (no JWT session). We resolve the token to the
  // bot's user row and set userId so the rest of the request pipeline
  // — permission checks, rate limits, audit attribution — treats the
  // bot identically to a human user. sessionId stays unset; bots
  // don't use session-scoped endpoints (logout, session list, etc).
  if (header.startsWith('Bot ')) {
    const token = header.slice(4).trim();
    if (!token) throw errors.unauthenticated();
    const bots = await import('../services/bots');
    const bot = await bots.resolveBotByToken(token);
    if (!bot) throw errors.unauthenticated();
    c.set('userId', bot.id);
    await next();
    return;
  }

  // Intent path: `Authorization: Intent <token>`, the long-lived, narrowly
  // scoped token the native Siri / widget / watch senders use. See
  // authenticateIntent below.
  if (header.startsWith('Intent ')) {
    await authenticateIntent(c, header.slice(7).trim());
    await next();
    return;
  }

  // Human path: JWT access token.
  if (!header.startsWith('Bearer ')) {
    throw errors.unauthenticated();
  }
  const token = header.slice(7).trim();
  if (!token) throw errors.unauthenticated();

  const claims = await verifyAccessToken(token);

  // Prompt revocation: reject if this session was revoked within the
  // access-token window. Cheap (one blacklist lookup, no DB) and fails open.
  if (await isSessionBlacklisted(claims.sessionId)) {
    throw errors.tokenInvalid('Session revoked');
  }

  c.set('userId', claims.userId);
  c.set('sessionId', claims.sessionId);

  await next();
};

/**
 * Everything an intent token may do: list the DMs, send a message, poke. That
 * is all Siri, the widgets and the watch send. Anchored and matched against
 * c.req.path, which is the same decoded path the router dispatched on.
 */
const INTENT_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/v1\/users\/@me\/channels$/ },
  { method: 'POST', path: /^\/api\/v1\/channels\/\d+\/messages$/ },
  { method: 'POST', path: /^\/api\/v1\/channels\/\d+\/poke$/ },
];

/**
 * The Intent half of requireAuth. Unlike the Bearer path this looks the
 * session up in the DB: the token lives 30 days and the revocation blacklist
 * only spans the 15-minute access window, so the sessions row is what makes a
 * logout or revoke end it. One small indexed read, only on these few routes.
 *
 * requireAuth runs once per router a path is mounted under (a /channels/* path
 * passes through four), so the verify + lookup happen on the first pass only;
 * authScope can't be set any other way. The route checks run every pass.
 */
async function authenticateIntent(c: Context, token: string): Promise<void> {
  if (!token) throw errors.unauthenticated();

  if (c.get('authScope') !== 'intents') {
    const claims = await verifyIntentToken(token);
    if (await isSessionBlacklisted(claims.sessionId)) {
      throw errors.tokenInvalid('Session revoked');
    }
    await assertSessionLive(claims.userId, claims.sessionId);
    c.set('userId', claims.userId);
    c.set('sessionId', claims.sessionId);
    c.set('authScope', 'intents');
  }

  const method = c.req.method;
  const path = c.req.path;
  if (!INTENT_ROUTES.some((r) => r.method === method && r.path.test(path))) {
    throw errors.forbidden('An intent token can only list DMs, send a DM or poke');
  }
  // Text only: no uploads. Matched loosely (any case, anywhere in the header)
  // so no spelling of a multipart body gets past it.
  if (/multipart\//i.test(c.req.header('content-type') ?? '')) {
    throw errors.forbidden('An intent token can only send a JSON message');
  }
}

/**
 * Throws 401 unless `sessionId` is a live session of `userId`: present, not
 * revoked, not expired, and its user neither banned nor deleted (the refresh
 * route's own predicate, which an access token gets from refreshing every 15
 * minutes and a 30-day token would otherwise skip). Used by the Intent path
 * and by the route that mints intent tokens.
 */
export async function assertSessionLive(userId: bigint, sessionId: bigint): Promise<void> {
  const rows = await db
    .select({
      userId: schema.sessions.userId,
      revokedAt: schema.sessions.revokedAt,
      expiresAt: schema.sessions.expiresAt,
      bannedAt: schema.users.bannedAt,
      bannedUntil: schema.users.bannedUntil,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  const s = rows[0];
  if (
    !s ||
    s.userId !== userId ||
    s.revokedAt !== null ||
    s.expiresAt <= new Date() ||
    isCurrentlyBanned(s) ||
    s.deletedAt !== null
  ) {
    throw errors.tokenInvalid('Session revoked');
  }
}

/**
 * Helper for handlers running under requireAuth. Throws if somehow called
 * without auth (defense-in-depth: the typed context already implies it).
 */
export function requireUserId(c: import('hono').Context): bigint {
  const userId = c.get('userId');
  if (userId === undefined) throw errors.unauthenticated();
  return userId;
}

export function requireSessionId(c: import('hono').Context): bigint {
  const sessionId = c.get('sessionId');
  if (sessionId === undefined) throw errors.unauthenticated();
  return sessionId;
}

/**
 * Reject a BOT principal on session-scoped endpoints.
 *
 * requireAuth accepts `Authorization: Bot <token>` and sets userId without a
 * sessionId, on the assumption — stated in its comment but never enforced —
 * that "bots don't use session-scoped endpoints". Nothing stopped a bot token
 * from reaching them. In particular POST /auth/quick-login/create ran under
 * plain requireAuth, so a bot token could mint a quick-login code for its own
 * user and redeem it (the redeem endpoint is public) for a full human
 * JWT + rotating refresh session. That session outlives bot-token
 * regeneration, so revoking a leaked bot token no longer evicted the holder.
 *
 * The absence of a sessionId is the precise signal: only the JWT path sets
 * one, so this covers every non-human principal generically rather than
 * enumerating bot flags at each call site.
 *
 * Compose AFTER requireAuth.
 */
export const requireHumanSession: MiddlewareHandler = async (c, next) => {
  if (c.get('sessionId') === undefined) {
    throw errors.forbidden('This endpoint requires a user session');
  }
  await next();
};

/**
 * Instance-admin gate. Reads users.is_admin and rejects with 403 if
 * the authenticated user isn't an admin. Runs ONE extra DB hit on
 * each admin-route request to read the flag — acceptable because
 * admin traffic is rare and we want fresh permission checks (an
 * admin we just demoted shouldn't keep their access for 15 minutes
 * waiting for token expiry).
 *
 * Must be composed AFTER requireAuth in the route chain so userId
 * is already set in context.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const userId = requireUserId(c);
  const rows = await db
    .select({
      isAdmin: schema.users.isAdmin,
      bannedAt: schema.users.bannedAt,
      bannedUntil: schema.users.bannedUntil,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const u = rows[0];
  if (!u?.isAdmin) {
    throw errors.forbidden('Instance admin required');
  }
  // Reject banned or soft-deleted admins. The general banned-user
  // check for all REST endpoints is deferred behind a Redis
  // blacklist (since requireAuth deliberately avoids a per-request
  // DB hit on the hot path), but the admin middleware already
  // pays for a DB lookup. Adding the column checks here closes the
  // 15-minute window during which a freshly-banned admin's valid
  // access token would otherwise still authenticate them on every
  // admin endpoint — ban/unban, force-signout, delete, etc.
  // isCurrentlyBanned treats an EXPIRED timed ban as not-banned.
  if (isCurrentlyBanned(u) || u.deletedAt) {
    throw errors.forbidden('Instance admin required');
  }
  await next();
};

/**
 * Staff gate (admin OR moderator) for the admin router. Same fresh-DB
 * semantics as requireAdmin. Sets `staffIsAdmin` in context so route
 * handlers and the moderator allowlist can distinguish the two roles —
 * moderators get a restricted subset (security log, ban/unban, sign-out,
 * membership view + capped gifting, DOB reset, server observe).
 *
 * Must be composed AFTER requireAuth in the route chain.
 */
export const requireStaff: MiddlewareHandler = async (c, next) => {
  const userId = requireUserId(c);
  const rows = await db
    .select({
      isAdmin: schema.users.isAdmin,
      isModerator: schema.users.isModerator,
      bannedAt: schema.users.bannedAt,
      bannedUntil: schema.users.bannedUntil,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const u = rows[0];
  if (!u || (!u.isAdmin && !u.isModerator) || isCurrentlyBanned(u) || u.deletedAt) {
    throw errors.forbidden('Instance staff required');
  }
  c.set('staffIsAdmin', u.isAdmin);
  await next();
};

/** True when requireStaff resolved the caller as a full admin. */
export function staffIsAdmin(c: import('hono').Context): boolean {
  return c.get('staffIsAdmin') === true;
}
