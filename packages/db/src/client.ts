import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type DbSchema = typeof schema;

/**
 * Create a Drizzle client.
 *
 * `max` is the connection cap PER PROCESS — a cluster-wide budget: keep
 * (replicas × max) + a couple reserved for migrations/admin at or below
 * Postgres `max_connections` (default 100). The API overrides this from
 * env.DB_POOL_MAX (default 20); this 20 fallback covers other consumers
 * (one-off scripts) that call createDb without options. At real scale, front
 * with pgBouncer and keep `max` small + `prepare:false` (transaction pooling
 * can't reuse prepared statements).
 */
export function createDb(connectionString: string, options?: postgres.Options<{}>) {
  const client = postgres(connectionString, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // pgbouncer-friendly default; flip on for direct connections
    ...options,
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = ReturnType<typeof createDb>['db'];
