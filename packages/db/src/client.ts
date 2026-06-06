import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type DbSchema = typeof schema;

/**
 * Create a Drizzle client.
 *
 * The pool is sized for a small/medium self-hosted deployment. For larger
 * loads, raise `max` and configure idle/connect timeouts via env.
 */
export function createDb(connectionString: string, options?: postgres.Options<{}>) {
  const client = postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // pgbouncer-friendly default; flip on for direct connections
    ...options,
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Database = ReturnType<typeof createDb>['db'];
