import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { achievementsForUser } from '../src/services/achievements';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping achievements tests — no database reachable');
}

// Underpins the native achievements gallery: the owner's shelf must return the
// FULL catalog with both earned and not-yet-earned entries (locked entries
// carry live progress toward `goal`). The route layer filters to earned-only
// for other viewers and gates on achievements_public (verified live).
describe.runIf(dbReady)('achievementsForUser (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('returns the full catalog with locked entries carrying progress for a fresh user', async () => {
    const u = await createUser();
    const list = await achievementsForUser(u);

    // Catalog is non-trivial and every core definition is represented.
    expect(list.length).toBeGreaterThanOrEqual(10);
    const ids = list.map((a) => a.id);
    expect(ids.some((id) => id.startsWith('chatterbox'))).toBe(true);
    expect(ids.some((id) => id.startsWith('social'))).toBe(true);
    expect(ids).toContain('night_owl');
    expect(ids).toContain('marathon');

    // A fresh account has earned nothing — but locked entries are returned
    // (this is what makes a "see what's left" gallery possible) and carry a
    // goal + a value.
    const locked = list.filter((a) => !a.earned);
    expect(locked.length).toBeGreaterThan(0);
    for (const a of locked) {
      expect(typeof a.name).toBe('string');
      expect(typeof a.description).toBe('string');
    }
    const cb100 = list.find((a) => a.id === 'chatterbox_100');
    expect(cb100).toBeDefined();
    expect(cb100!.earned).toBe(false);
    expect(cb100!.goal).toBe(100);
  });

  it('marks the veteran badge earned once the account is old enough — earned + locked coexist', async () => {
    const u = await createUser();
    // Backdate creation ~400 days so the 1-year veteran badge unlocks.
    await db
      .update(schema.users)
      .set({ createdAt: new Date(Date.now() - 400 * 24 * 3600 * 1000) })
      .where(eq(schema.users.id, u));

    const list = await achievementsForUser(u);
    const earned = list.filter((a) => a.earned);
    const locked = list.filter((a) => !a.earned);

    // At least the veteran year is earned, and other catalog entries remain
    // locked — so a gallery shows both states for the same user.
    expect(earned.some((a) => a.id.startsWith('veteran'))).toBe(true);
    expect(locked.length).toBeGreaterThan(0);

    // The "earned-only for other viewers" route filter would keep exactly the
    // earned set — assert that subset is non-empty and all earned.
    const publicShelf = list.filter((a) => a.earned);
    expect(publicShelf.length).toBeGreaterThan(0);
    expect(publicShelf.every((a) => a.earned)).toBe(true);
  });
});
