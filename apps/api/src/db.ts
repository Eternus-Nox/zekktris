/**
 * Database client
 * ---------------
 * Single Drizzle instance per process. The pool is sized for a small/medium
 * deployment; tune via env if you scale up.
 *
 * Schema imports are re-exported here so route code can do:
 *   import { db, schema } from '../db';
 *   db.select().from(schema.users)...
 */

import { createDb } from '@zekktris/db';
import { env } from './env';
import { log } from './log';

const { db, client } = createDb(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  prepare: env.DB_PREPARED,
});

log.info('database client initialized', {
  // The connection string contains credentials; only log the host portion.
  host: safeHost(env.DATABASE_URL),
});

function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return '<unparseable>';
  }
}

export { db, client };
export * as schema from '@zekktris/db/schema';

/** Gracefully close the db connection. Call on SIGTERM / SIGINT. */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
  log.info('database client closed');
}
