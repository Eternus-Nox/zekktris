import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping chosen-status migration test — no database reachable');
}

// Migration 0130 splits the chosen status off users.status. The real users
// table already has the column (the suite runs on a migrated database) and is
// shared with every other test file, so the migration's own SQL is replayed
// against a TEMPORARY "users" table — which Postgres resolves before
// public.users for unqualified names — inside a transaction that is rolled
// back.

class Rollback extends Error {}

afterAll(async () => {
  if (dbReady) await closeDb();
});

describe.runIf(dbReady)('migration 0130 (chosen_status)', () => {
  it('backfills dnd and invisible, and maps idle / online / offline to online', async () => {
    const file = new URL('../../../packages/db/migrations/0130_chosen_status.sql', import.meta.url);
    const statements = readFileSync(file, 'utf8').split('--> statement-breakpoint');
    let rows: Array<{ id: string; chosen: string }> = [];
    let offlineRejected = false;
    await db
      .transaction(async (tx) => {
        await tx.execute(
          sql.raw(`CREATE TEMP TABLE "users" (id bigint PRIMARY KEY, status "user_status" NOT NULL) ON COMMIT DROP`),
        );
        await tx.execute(
          sql.raw(
            `INSERT INTO "users" (id, status) VALUES (1, 'online'), (2, 'idle'), (3, 'dnd'), (4, 'offline'), (5, 'invisible')`,
          ),
        );
        for (const stmt of statements) await tx.execute(sql.raw(stmt));
        const res = await tx.execute(sql.raw(`SELECT id::text AS id, chosen_status::text AS chosen FROM "users" ORDER BY id`));
        rows = (res as unknown as Array<{ id: string; chosen: string }>).map((r) => ({ id: r.id, chosen: r.chosen }));
        // The CHECK: 'offline' can never be a chosen status.
        try {
          await tx.execute(sql.raw(`SAVEPOINT chk`));
          await tx.execute(sql.raw(`UPDATE "users" SET chosen_status = 'offline' WHERE id = 1`));
        } catch {
          offlineRejected = true;
          await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT chk`));
        }
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    expect(rows).toEqual([
      { id: '1', chosen: 'online' },
      // Auto-idle from the old desktop/iOS logic must not become a sticky Away.
      { id: '2', chosen: 'online' },
      { id: '3', chosen: 'dnd' },
      { id: '4', chosen: 'online' },
      { id: '5', chosen: 'invisible' },
    ]);
    expect(offlineRejected).toBe(true);
  });
});

describe.runIf(dbReady)('migration 0131 (chosen_status_auto)', () => {
  it('is journaled after 0130 with a strictly larger timestamp', () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../../../packages/db/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const at = journal.entries.findIndex((e) => e.tag === '0131_chosen_status_auto');
    expect(at).toBeGreaterThan(0);
    const prev = journal.entries[at - 1]!;
    const entry = journal.entries[at]!;
    expect(prev.tag).toBe('0130_chosen_status');
    expect(entry.idx).toBe(prev.idx + 1);
    expect(entry.when).toBeGreaterThan(prev.when);
    expect(at).toBe(journal.entries.length - 1);
  });

  it('adds the flag false for every existing row and allows it only with a chosen idle', async () => {
    const file = new URL('../../../packages/db/migrations/0131_chosen_status_auto.sql', import.meta.url);
    const statements = readFileSync(file, 'utf8').split('--> statement-breakpoint');
    let rows: Array<{ id: string; auto: boolean }> = [];
    const rejected: string[] = [];
    let idleAccepted = false;
    await db
      .transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            `CREATE TEMP TABLE "users" (id bigint PRIMARY KEY, status "user_status" NOT NULL, chosen_status "user_status" NOT NULL DEFAULT 'online') ON COMMIT DROP`,
          ),
        );
        await tx.execute(
          sql.raw(
            `INSERT INTO "users" (id, status, chosen_status) VALUES (1, 'online', 'online'), (2, 'idle', 'idle'), (3, 'dnd', 'dnd'), (4, 'offline', 'invisible')`,
          ),
        );
        for (const stmt of statements) await tx.execute(sql.raw(stmt));
        const res = await tx.execute(
          sql.raw(`SELECT id::text AS id, chosen_status_auto AS auto FROM "users" ORDER BY id`),
        );
        rows = (res as unknown as Array<{ id: string; auto: boolean }>).map((r) => ({
          id: r.id,
          auto: r.auto,
        }));
        // The CHECK: the flag only ever rides on a chosen 'idle'.
        for (const id of [1, 3, 4]) {
          try {
            await tx.execute(sql.raw(`SAVEPOINT chk`));
            await tx.execute(sql.raw(`UPDATE "users" SET chosen_status_auto = true WHERE id = ${id}`));
            await tx.execute(sql.raw(`RELEASE SAVEPOINT chk`));
          } catch {
            rejected.push(String(id));
            await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT chk`));
          }
        }
        await tx.execute(sql.raw(`UPDATE "users" SET chosen_status_auto = true WHERE id = 2`));
        idleAccepted = true;
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    expect(rows).toEqual([
      { id: '1', auto: false },
      { id: '2', auto: false },
      { id: '3', auto: false },
      { id: '4', auto: false },
    ]);
    expect(rejected).toEqual(['1', '3', '4']);
    expect(idleAccepted).toBe(true);
  });
});
