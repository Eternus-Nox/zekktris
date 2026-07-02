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
 */

import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { verifyAccessToken } from './tokens';
import { isSessionBlacklisted } from './session-blacklist';

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
  if (u.bannedAt || u.deletedAt) {
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
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const u = rows[0];
  if (!u || (!u.isAdmin && !u.isModerator) || u.bannedAt || u.deletedAt) {
    throw errors.forbidden('Instance staff required');
  }
  c.set('staffIsAdmin', u.isAdmin);
  await next();
};

/** True when requireStaff resolved the caller as a full admin. */
export function staffIsAdmin(c: import('hono').Context): boolean {
  return c.get('staffIsAdmin') === true;
}
