/**
 * HTTP middleware
 * ---------------
 * - requestId: assigns or honors X-Request-Id; sets it on context and response.
 * - accessLog: one log line per request with status, latency, method, path.
 * - errorHandler: turns thrown AppErrors into JSON responses; everything else
 *   becomes a 500 with the message hidden in production.
 *
 * These are wired into the Hono app in server.ts.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import { nanoid } from 'nanoid';
import { AppError, errors as e } from '../errors';
import { log } from '../log';
import { isProd } from '../env';

// ── Hono context variables ─────────────────────────────────────────────────
// Anything set on `c.set(...)` should be declared here so it's typed everywhere.
declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    /** Set by the auth middleware when the caller is authenticated. */
    userId?: bigint;
    sessionId?: bigint;
    /** Set by requireNodeUser (node mode) when a backbone token is verified. */
    nodeUser?: { userId: bigint; guildId: bigint; roleIds: bigint[] };
    /** Set by requireStaff: true = full admin, false = moderator. */
    staffIsAdmin?: boolean;
  }
}

// ── requestId ──────────────────────────────────────────────────────────────

export const requestId: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[a-zA-Z0-9_-]{1,64}$/.test(incoming) ? incoming : nanoid(16);
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
};

// ── accessLog ──────────────────────────────────────────────────────────────

export const accessLog: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  const ms = Math.round(performance.now() - start);
  const status = c.res.status;
  const fields = {
    requestId: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    status,
    durationMs: ms,
    userId: c.get('userId')?.toString(),
  };
  // Pick level from status: 5xx → error, 4xx → warn, else → info.
  if (status >= 500) log.error('http', fields);
  else if (status >= 400) log.warn('http', fields);
  else log.info('http', fields);
};

// ── errorHandler ───────────────────────────────────────────────────────────
//
// Hono's app.onError takes a (err, c) handler. We export the function and the
// server wires it via `app.onError(errorHandler)`.

export function errorHandler(err: Error, c: Context): Response {
  // Validation errors from @hono/zod-validator — surface field details.
  if (err instanceof ZodError) {
    const appErr = e.validation({
      issues: err.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    });
    return c.json(appErr.toResponseBody(), appErr.status as 400);
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      log.error('app error', { requestId: c.get('requestId'), code: err.code, err });
    } else {
      log.debug('app error', { requestId: c.get('requestId'), code: err.code, msg: err.message });
    }
    return c.json(err.toResponseBody(), err.status as 400);
  }

  // Anything else is a bug. Log full detail; expose generic message in prod.
  log.error('unhandled error', { requestId: c.get('requestId'), err });
  const safe = isProd
    ? new AppError('INTERNAL', 'Internal server error')
    : new AppError('INTERNAL', err.message);
  return c.json(safe.toResponseBody(), safe.status as 500);
}
