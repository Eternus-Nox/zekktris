import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import {
  getEffectiveSubscription,
  giftSubscription,
  hasMembership,
  removeSubscription,
  sweepExpiredSubscriptions,
} from '../src/services/subscriptions';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping subscriptions tests — no database reachable');
}

async function linkParent(parentId: bigint, childId: bigint) {
  await db.insert(schema.parentChildLinks).values({
    parentId,
    childId,
    status: 'active',
    initiatedBy: 'parent',
  });
}

async function userCosmetics(userId: bigint) {
  const [row] = await db
    .select({
      avatarDecoration: schema.users.avatarDecoration,
      tagLabel: schema.users.tagLabel,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row!;
}

describe.runIf(dbReady)('supporter memberships (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  // 20s timeout: the first entitlement read pays the one-time dynamic import
  // of the (large) supervision module — slow on the SMB-mounted repo.
  it('no row → no membership; admin gift grants it; forever never expires', { timeout: 20_000 }, async () => {
    const admin = await createUser();
    const user = await createUser();
    expect(await hasMembership(user)).toBe(false);

    await giftSubscription(admin, user, 'guardian', 'forever');
    const eff = await getEffectiveSubscription(user);
    expect(eff).toEqual({ tier: 'guardian', expiresAt: null, inherited: false, titled: true });
  });

  it('timed gift sets an expiry; re-gifting overwrites tier + duration', async () => {
    const admin = await createUser();
    const user = await createUser();
    await giftSubscription(admin, user, 'scout', '1m');
    const first = await getEffectiveSubscription(user);
    expect(first!.tier).toBe('scout');
    expect(first!.expiresAt).not.toBeNull();

    await giftSubscription(admin, user, 'legend', 'forever');
    const second = await getEffectiveSubscription(user);
    expect(second).toEqual({ tier: 'legend', expiresAt: null, inherited: false, titled: true });
  });

  it("a supervising parent's membership passes down (highest tier wins)", async () => {
    const admin = await createUser();
    const parentA = await createUser({ dateOfBirth: '1990-01-01' });
    const parentB = await createUser({ dateOfBirth: '1990-01-01' });
    const child = await createUser({ dateOfBirth: '2011-06-15' });
    await linkParent(parentA, child);
    await linkParent(parentB, child);
    await giftSubscription(admin, parentA, 'scout', 'forever');
    await giftSubscription(admin, parentB, 'legend', '3m');

    const eff = await getEffectiveSubscription(child);
    expect(eff!.inherited).toBe(true);
    expect(eff!.tier).toBe('legend'); // highest of the two guardians

    // The child's OWN row (none) is what admin tooling manages; entitlement
    // is read-time so unlinking would end it implicitly (supervision-tested).
  });

  it('founder (grandfathered) memberships have the perks but NO title; re-gifting titles them', async () => {
    const admin = await createUser();
    const founder = await createUser();
    // Simulate the 0097 backfill + 0098 founder marking: forever row, no
    // gifting admin, source 'founder'.
    await db.insert(schema.subscriptions).values({
      userId: founder,
      tier: 'scout',
      source: 'founder',
      expiresAt: null,
    });

    const eff = await getEffectiveSubscription(founder);
    expect(eff).not.toBeNull();
    expect(await hasMembership(founder)).toBe(true); // perks work
    expect(eff!.titled).toBe(false); // …but no title

    // Choosing a tier (admin gift here; a paid sub later) titles them.
    await giftSubscription(admin, founder, 'guardian', 'forever');
    const regifted = await getEffectiveSubscription(founder);
    expect(regifted!.titled).toBe(true);
    expect(regifted!.tier).toBe('guardian');
  });

  it('admin reset removes the membership AND clears paid cosmetics', async () => {
    const admin = await createUser();
    const user = await createUser();
    await giftSubscription(admin, user, 'legend', 'forever');
    await db
      .update(schema.users)
      .set({ avatarDecoration: 'gold', tagLabel: 'ZKT', tagColor: '#ff4d4d' })
      .where(eq(schema.users.id, user));

    await removeSubscription(user);
    expect(await hasMembership(user)).toBe(false);
    const cosmetics = await userCosmetics(user);
    expect(cosmetics.avatarDecoration).toBeNull();
    expect(cosmetics.tagLabel).toBeNull();
  });

  it('expired rows grant nothing and the sweep hard-locks them', async () => {
    const admin = await createUser();
    const user = await createUser();
    await giftSubscription(admin, user, 'guardian', '1m');
    // Force the expiry into the past (simulating a lapsed month).
    await db
      .update(schema.subscriptions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.subscriptions.userId, user));
    await db
      .update(schema.users)
      .set({ avatarDecoration: 'rose', tagLabel: 'PAID' })
      .where(eq(schema.users.id, user));

    expect(await getEffectiveSubscription(user)).toBeNull();

    await sweepExpiredSubscriptions();
    const [row] = await db
      .select()
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.userId, user)))
      .limit(1);
    expect(row).toBeUndefined();
    const cosmetics = await userCosmetics(user);
    expect(cosmetics.avatarDecoration).toBeNull();
    expect(cosmetics.tagLabel).toBeNull();
  });
});
