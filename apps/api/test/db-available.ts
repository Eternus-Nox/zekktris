/**
 * Integration-test database probe.
 * --------------------------------
 * The unit tests in this folder run with no infrastructure. The *integration*
 * tests (sessions rotation, message pagination) need a real Postgres because
 * the behavior under test lives in SQL (atomic UPDATE…WHERE, ordering).
 *
 * To keep `pnpm test` green in environments without a database, those files
 * call `probeDb()` at module load and wrap their suites in
 * `describe.runIf(dbReady)` — so they execute when a DB is reachable (CI, or
 * the docker-compose `db` service with DATABASE_URL pointed at it) and are
 * skipped otherwise.
 */

import { db, closeDb } from '../src/db';
import { sql } from 'drizzle-orm';

export { closeDb };

/** Try a trivial query within a timeout. Returns false (and tears the pool
 *  down) if the database can't be reached, so vitest doesn't hang on exit. */
export async function probeDb(timeoutMs = 2500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('db probe timeout')), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return true;
  } catch {
    clearTimeout(timer);
    try {
      await closeDb();
    } catch {
      /* already closed / never opened */
    }
    return false;
  }
}
