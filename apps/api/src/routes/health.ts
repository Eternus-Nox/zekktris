/**
 * Health checks
 * -------------
 * /health        — process is up. Cheap. Use for liveness.
 * /health/ready  — process can serve traffic (db reachable). Use for readiness.
 *
 * Docker compose `healthcheck:` and Caddy upstream probes both target /health.
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { log } from '../log';

export const healthRouter = new Hono();

healthRouter.get('/', (c) => {
  // `version` is the git commit the image was built from (Dockerfile.api sets
  // GIT_SHA via --build-arg). 'dev' locally / 'unknown' if the build didn't
  // pass it. Lets you confirm what's actually deployed: GET /api/v1/health.
  return c.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    version: process.env.GIT_SHA ?? 'dev',
  });
});

healthRouter.get('/ready', async (c) => {
  try {
    // Trivial query that exercises the connection pool.
    await db.execute(sql`select 1`);
    return c.json({ status: 'ready' });
  } catch (err) {
    log.warn('readiness check failed', { err });
    return c.json({ status: 'not-ready', reason: 'database-unreachable' }, 503);
  }
});
