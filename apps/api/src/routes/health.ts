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
  return c.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
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
