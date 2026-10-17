import { readFileSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
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

describe.runIf(dbReady)('perk tiers (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  // The first test in this file pays the one-time dynamic import
  // of the (large) supervision module — slow on the SMB-mounted repo.
  it('no row → no membership; admin gift grants it; forever never expires', async () => {
    const admin = await createUser();
    const user = await createUser();
    expect(await hasMembership(user)).toBe(false);

    await giftSubscription(admin, user, 'guardian', 'forever');
    const eff = await getEffectiveSubscription(user);
    expect(eff).toEqual({ tier: 'guardian', expiresAt: null, inherited: false, titled: true, source: 'gift' });
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
    expect(second).toEqual({ tier: 'legend', expiresAt: null, inherited: false, titled: true, source: 'gift' });
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

    // Choosing a tier (an admin gift) titles them.
    await giftSubscription(admin, founder, 'guardian', 'forever');
    const regifted = await getEffectiveSubscription(founder);
    expect(regifted!.titled).toBe(true);
    expect(regifted!.tier).toBe('guardian');
  });

  it('removing a tier keeps the cosmetics — they are free', async () => {
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
    expect(cosmetics.avatarDecoration).toBe('gold');
    expect(cosmetics.tagLabel).toBe('ZKT');
  });

  it('migration 0129 turns live paid rows into forever gifts and drops lapsed ones', async () => {
    const admin = await createUser();
    const paid = await createUser();
    const lapsed = await createUser();
    const gifted = await createUser();
    const founder = await createUser();
    // Rows as the removed Stripe webhook left them.
    await db.insert(schema.subscriptions).values([
      {
        userId: paid,
        tier: 'guardian',
        source: 'stripe',
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        stripeCustomerId: 'cus_live',
        stripeSubscriptionId: 'sub_live',
        cancelAtPeriodEnd: true,
      },
      {
        userId: lapsed,
        tier: 'scout',
        source: 'stripe',
        expiresAt: new Date(Date.now() - 1000),
        stripeCustomerId: 'cus_lapsed',
        stripeSubscriptionId: 'sub_lapsed',
      },
      { userId: founder, tier: 'scout', source: 'founder', expiresAt: null },
    ]);
    await giftSubscription(admin, gifted, 'scout', '1m');
    const giftedBefore = await getEffectiveSubscription(gifted);

    const file = new URL('../../../packages/db/migrations/0129_retire_stripe_rows.sql', import.meta.url);
    const statements = readFileSync(file, 'utf8').split('--> statement-breakpoint');
    // Twice: the migration must be idempotent.
    for (let i = 0; i < 2; i++) {
      for (const stmt of statements) await db.execute(sql.raw(stmt));
    }

    // Same tier, now forever, titled, and not scheduled to end.
    expect(await getEffectiveSubscription(paid)).toEqual({
      tier: 'guardian',
      expiresAt: null,
      inherited: false,
      titled: true,
      source: 'gift',
    });
    const [row] = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, paid))
      .limit(1);
    expect(row!.cancelAtPeriodEnd).toBe(false);
    expect(row!.giftedBy).toBeNull();
    // The Stripe ids stay so an operator can still find it in the dashboard.
    expect(row!.stripeSubscriptionId).toBe('sub_live');
    // The expiry sweep then leaves it alone.
    await sweepExpiredSubscriptions();
    expect(await hasMembership(paid)).toBe(true);

    // A paid row that had already lapsed is gone, as the sweep would do.
    const [lapsedRow] = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, lapsed))
      .limit(1);
    expect(lapsedRow).toBeUndefined();

    // Gifts and founder rows are untouched.
    expect(await getEffectiveSubscription(gifted)).toEqual(giftedBefore);
    expect((await getEffectiveSubscription(founder))!.source).toBe('founder');
    const leftover = await db
      .select({ userId: schema.subscriptions.userId })
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.source, 'stripe'), inArray(schema.subscriptions.userId, [paid, lapsed])));
    expect(leftover).toEqual([]);
  });

  it('expired rows grant nothing and the sweep deletes them (cosmetics stay)', async () => {
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
    expect(cosmetics.avatarDecoration).toBe('rose');
    expect(cosmetics.tagLabel).toBe('PAID');
  });
});
