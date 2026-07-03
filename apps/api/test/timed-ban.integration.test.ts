import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import {
  banExpiryFor,
  isCurrentlyBanned,
  sweepExpiredInstanceBans,
} from '../src/services/instanceBans';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping timed-ban tests — no database reachable');
}

describe('timed instance ban helpers (pure)', () => {
  it('banExpiryFor maps durations to months; perm → null', () => {
    const from = new Date('2026-01-15T00:00:00Z');
    expect(banExpiryFor('perm', from)).toBeNull();
    expect(banExpiryFor('1m', from)!.toISOString()).toBe('2026-02-15T00:00:00.000Z');
    expect(banExpiryFor('3m', from)!.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(banExpiryFor('6m', from)!.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('isCurrentlyBanned: not banned / permanent / active-timed / expired-timed', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(isCurrentlyBanned({ bannedAt: null, bannedUntil: null }, now)).toBe(false);
    // permanent
    expect(isCurrentlyBanned({ bannedAt: new Date(), bannedUntil: null }, now)).toBe(true);
    // timed, still active
    expect(
      isCurrentlyBanned({ bannedAt: new Date(), bannedUntil: new Date('2026-07-01T00:00:00Z') }, now),
    ).toBe(true);
    // timed, expired → NOT banned even before the sweep clears columns
    expect(
      isCurrentlyBanned({ bannedAt: new Date(), bannedUntil: new Date('2026-05-01T00:00:00Z') }, now),
    ).toBe(false);
  });
});

describe.runIf(dbReady)('auto-unban sweep (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('lifts expired timed bans, leaves active + permanent ones', async () => {
    const expired = await createUser();
    const active = await createUser();
    const perm = await createUser();
    const now = new Date();
    await db
      .update(schema.users)
      .set({ bannedAt: now, bannedUntil: new Date(now.getTime() - 1000) })
      .where(eq(schema.users.id, expired));
    await db
      .update(schema.users)
      .set({ bannedAt: now, bannedUntil: new Date(now.getTime() + 3_600_000) })
      .where(eq(schema.users.id, active));
    await db
      .update(schema.users)
      .set({ bannedAt: now, bannedUntil: null })
      .where(eq(schema.users.id, perm));

    const lifted = await sweepExpiredInstanceBans();
    expect(lifted).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({ id: schema.users.id, bannedAt: schema.users.bannedAt })
      .from(schema.users);
    const byId = new Map(rows.map((r) => [r.id.toString(), r.bannedAt]));
    expect(byId.get(expired.toString())).toBeNull(); // lifted
    expect(byId.get(active.toString())).not.toBeNull(); // still banned
    expect(byId.get(perm.toString())).not.toBeNull(); // permanent stays
  });
});
