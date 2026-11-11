import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping disappearing-messages migration test — no database reachable');
}

// Migration 0133 gives every message its own disappearing timer and deadline.
// The real tables already have the columns (the suite runs on a migrated
// database) and are shared with every other test file, so the backfill is
// replayed against TEMPORARY "messages" / "dm_settings" tables — which
// Postgres resolves before the public ones for unqualified names — inside a
// transaction that is rolled back.

class Rollback extends Error {}

const FILE = new URL('../../../packages/db/migrations/0133_disappearing_messages.sql', import.meta.url);

afterAll(async () => {
  if (dbReady) await closeDb();
});

type Row = { id: string; eas: number | null; ea: string | null };

describe.runIf(dbReady)('migration 0133 (disappearing messages)', () => {
  it('is journaled after 0132 with the next idx and a timestamp one day later', () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../../packages/db/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }> };
    const at = journal.entries.findIndex((e) => e.tag === '0133_disappearing_messages');
    expect(at).toBeGreaterThan(0);
    const prev = journal.entries[at - 1]!;
    const entry = journal.entries[at]!;
    expect(prev.tag).toBe('0132_voice_moved_from');
    expect(entry.idx).toBe(132);
    expect(entry.when).toBe(prev.when + 86_400_000);
    expect(entry.when).toBe(1785377930000);
    expect(entry.breakpoints).toBe(true);
  });

  it('left the migrated database with the enum value, both columns and the partial index', async () => {
    const enumRows = (await db.execute(
      sql.raw(
        `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'message_type' AND e.enumlabel = 'system_disappearing'`,
      ),
    )) as unknown as unknown[];
    expect(enumRows.length).toBe(1);
    const cols = (await db.execute(
      sql.raw(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'messages'
            AND column_name IN ('expire_after_seconds', 'expires_at') ORDER BY column_name`,
      ),
    )) as unknown as Array<{ column_name: string; data_type: string }>;
    expect(cols.map((c) => [c.column_name, c.data_type])).toEqual([
      ['expire_after_seconds', 'integer'],
      ['expires_at', 'timestamp with time zone'],
    ]);
    const idx = (await db.execute(
      sql.raw(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'messages_expires_at_idx'`),
    )) as unknown as Array<{ indexdef: string }>;
    expect(idx.length).toBe(1);
    expect(idx[0]!.indexdef).toMatch(/\(expires_at\) WHERE \(\(expires_at IS NOT NULL\) AND \(deleted_at IS NULL\)\)/);
    // The read ack's clock start: only rows still waiting for a reader.
    const pending = (await db.execute(
      sql.raw(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'messages_timer_pending_idx'`),
    )) as unknown as Array<{ indexdef: string }>;
    expect(pending.length).toBe(1);
    expect(pending[0]!.indexdef).toMatch(
      /\(channel_id, id\) WHERE \(\(expire_after_seconds IS NOT NULL\) AND \(expires_at IS NULL\) AND \(deleted_at IS NULL\)\)/,
    );
  });

  it("the read ack's clock start uses the partial index instead of walking the DM's history", async () => {
    // Replayed on TEMPORARY tables (see above) so the planner sees a known
    // shape: one long DM whose history is all soft-deleted or already
    // counting down, plus the two messages that still wait for a reader.
    const statements = readFileSync(FILE, 'utf8').split('--> statement-breakpoint');
    let plan = '';
    await db
      .transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            `CREATE TEMP TABLE "dm_settings" (channel_id bigint PRIMARY KEY, ttl_seconds_after_read integer) ON COMMIT DROP`,
          ),
        );
        await tx.execute(
          sql.raw(
            `CREATE TEMP TABLE "messages" (id bigint PRIMARY KEY, channel_id bigint NOT NULL, author_id bigint,
               viewed_at timestamptz, deleted_at timestamptz) ON COMMIT DROP`,
          ),
        );
        // Stands in for messages_channel_time_idx, the index the scan used.
        await tx.execute(sql.raw(`CREATE INDEX ON "messages" (channel_id, id)`));
        for (const stmt of statements) await tx.execute(sql.raw(stmt));
        await tx.execute(
          sql.raw(
            `INSERT INTO "messages" (id, channel_id, author_id, deleted_at, expire_after_seconds, expires_at)
             SELECT g, 10, 1 + g % 2,
                    CASE WHEN g % 5 < 3 THEN now() END, 60,
                    CASE WHEN g % 5 >= 3 THEN now() END
               FROM generate_series(1, 20000) AS g`,
          ),
        );
        await tx.execute(
          sql.raw(
            `INSERT INTO "messages" (id, channel_id, author_id, expire_after_seconds)
             VALUES (20001, 10, 2, 60), (20002, 10, 2, 60)`,
          ),
        );
        await tx.execute(sql.raw(`ANALYZE "messages"`));
        const rows = (await tx.execute(
          sql.raw(
            `EXPLAIN UPDATE "messages" SET expires_at = now() + make_interval(secs => expire_after_seconds)
              WHERE channel_id = 10 AND id <= 20002 AND expire_after_seconds IS NOT NULL
                AND expires_at IS NULL AND deleted_at IS NULL AND author_id IS DISTINCT FROM 1`,
          ),
        )) as unknown as Array<Record<string, string>>;
        plan = rows.map((r) => Object.values(r)[0]).join('\n');
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    expect(plan).toContain('messages_timer_pending_idx');
  });

  it('backfills exactly what the old sweep would delete, and re-running changes nothing', async () => {
    const statements = readFileSync(FILE, 'utf8').split('--> statement-breakpoint');
    // Nothing in the migration may USE the new enum value (it is added in the
    // same transaction as every other pending migration).
    for (const stmt of statements.slice(1)) expect(stmt).not.toMatch(/'system_disappearing'/);

    let first: Row[] = [];
    let second: Row[] = [];
    let tempIndex = 0;
    await db
      .transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            `CREATE TEMP TABLE "dm_settings" (channel_id bigint PRIMARY KEY, ttl_seconds_after_read integer) ON COMMIT DROP`,
          ),
        );
        await tx.execute(
          sql.raw(
            `CREATE TEMP TABLE "messages" (id bigint PRIMARY KEY, channel_id bigint NOT NULL,
               viewed_at timestamptz, deleted_at timestamptz) ON COMMIT DROP`,
          ),
        );
        // 10 = a DM with a 60 s timer; 20 = a DM that never set one;
        // 30 = a DM whose timer was turned off.
        await tx.execute(
          sql.raw(`INSERT INTO "dm_settings" VALUES (10, 60), (30, NULL)`),
        );
        await tx.execute(
          sql.raw(
            `INSERT INTO "messages" (id, channel_id, viewed_at, deleted_at) VALUES
               (1, 10, NULL, NULL),
               (2, 10, '2026-01-01T00:00:00Z', NULL),
               (3, 10, '2026-01-01T00:00:00Z', '2026-01-01T00:02:00Z'),
               (4, 20, '2026-01-01T00:00:00Z', NULL),
               (5, 30, '2026-01-01T00:00:00Z', NULL),
               (6, 30, NULL, NULL)`,
          ),
        );
        const read = async () =>
          (
            (await tx.execute(
              sql.raw(
                `SELECT id::text AS id, expire_after_seconds AS eas,
                        to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS ea
                   FROM "messages" ORDER BY id`,
              ),
            )) as unknown as Row[]
          ).map((r) => ({ id: r.id, eas: r.eas, ea: r.ea }));
        for (const stmt of statements) await tx.execute(sql.raw(stmt));
        first = await read();
        // A row that already has its own timer is never overwritten.
        await tx.execute(sql.raw(`UPDATE "messages" SET expire_after_seconds = 30, expires_at = NULL WHERE id = 1`));
        for (const stmt of statements) await tx.execute(sql.raw(stmt));
        second = await read();
        const idx = (await tx.execute(
          sql.raw(
            `SELECT 1 FROM pg_indexes WHERE schemaname LIKE 'pg_temp%'
                AND indexname IN ('messages_expires_at_idx', 'messages_timer_pending_idx')`,
          ),
        )) as unknown as unknown[];
        tempIndex = idx.length;
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    expect(first).toEqual([
      // Unviewed in the timer DM: takes the timer, its clock starts on read.
      { id: '1', eas: 60, ea: null },
      // Viewed: the deadline the old sweep gave it (viewed_at + 60 s).
      { id: '2', eas: 60, ea: '2026-01-01T00:01:00' },
      // Already deleted: untouched.
      { id: '3', eas: null, ea: null },
      // No timer DM / timer turned off: untouched.
      { id: '4', eas: null, ea: null },
      { id: '5', eas: null, ea: null },
      { id: '6', eas: null, ea: null },
    ]);
    expect(second).toEqual([{ id: '1', eas: 30, ea: null }, ...first.slice(1)]);
    expect(tempIndex).toBe(2);
  });
});
