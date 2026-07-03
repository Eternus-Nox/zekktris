import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import {
  activateStripeSubscription,
  endStripeSubscription,
  getEffectiveSubscription,
  giftSubscription,
  hasMembership,
  removeSubscription,
  renewStripeSubscription,
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

  // The first test in this file pays the one-time dynamic import
  // of the (large) supervision module — slow on the SMB-mounted repo.
  it('no row → no membership; admin gift grants it; forever never expires', async () => {
    const admin = await createUser();
    const user = await createUser();
    expect(await hasMembership(user)).toBe(false);

    await giftSubscription(admin, user, 'guardian', 'forever');
    const eff = await getEffectiveSubscription(user);
    expect(eff).toEqual({ tier: 'guardian', expiresAt: null, inherited: false, titled: true, source: 'gift', cancelAtPeriodEnd: false });
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
    expect(second).toEqual({ tier: 'legend', expiresAt: null, inherited: false, titled: true, source: 'gift', cancelAtPeriodEnd: false });
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

  it('stripe lifecycle: activate → titled member; renew extends; delete hard-locks', async () => {
    const user = await createUser();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000);
    await activateStripeSubscription({
      userId: user,
      tier: 'guardian',
      stripeCustomerId: 'cus_test1',
      stripeSubscriptionId: 'sub_test1',
      currentPeriodEnd: periodEnd,
    });
    const eff = await getEffectiveSubscription(user);
    expect(eff!.tier).toBe('guardian');
    expect(eff!.titled).toBe(true);
    expect(eff!.source).toBe('stripe');
    // 24h grace beyond the period end.
    expect(eff!.expiresAt!.getTime()).toBe(periodEnd.getTime() + 24 * 3_600_000);

    // A fresh activation is auto-renewing (not scheduled to cancel).
    expect(eff!.cancelAtPeriodEnd).toBe(false);

    // Renewal pushes the expiry forward (and can retier on plan change).
    const nextEnd = new Date(Date.now() + 60 * 86_400_000);
    expect(await renewStripeSubscription('sub_test1', nextEnd, 'legend')).toBe(true);
    const renewed = await getEffectiveSubscription(user);
    expect(renewed!.tier).toBe('legend');
    expect(renewed!.expiresAt!.getTime()).toBe(nextEnd.getTime() + 24 * 3_600_000);

    // A cancel (cancel_at_period_end) is reflected in the entitlement read so
    // Settings can show "Cancels on <date> · Resume".
    expect(await renewStripeSubscription('sub_test1', nextEnd, undefined, true)).toBe(true);
    expect((await getEffectiveSubscription(user))!.cancelAtPeriodEnd).toBe(true);
    // Reactivate clears it.
    expect(await renewStripeSubscription('sub_test1', nextEnd, undefined, false)).toBe(true);
    expect((await getEffectiveSubscription(user))!.cancelAtPeriodEnd).toBe(false);

    // Gifting over an active paid subscription is refused (would keep
    // charging them while the row says gift).
    const admin = await createUser();
    await expect(giftSubscription(admin, user, 'scout', 'forever')).rejects.toThrow();

    // Stripe-side deletion hard-locks: row gone + cosmetics cleared.
    await db
      .update(schema.users)
      .set({ avatarDecoration: 'ocean', tagLabel: 'PAID' })
      .where(eq(schema.users.id, user));
    expect(await endStripeSubscription('sub_test1')).toBe(true);
    expect(await hasMembership(user)).toBe(false);
    const cosmetics = await userCosmetics(user);
    expect(cosmetics.avatarDecoration).toBeNull();
    expect(cosmetics.tagLabel).toBeNull();
    // Unknown subscription id → no-op.
    expect(await endStripeSubscription('sub_missing')).toBe(false);
  });

  it('activating a DIFFERENT stripe sub for the same user reports the superseded id', async () => {
    const user = await createUser();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000);
    const first = await activateStripeSubscription({
      userId: user,
      tier: 'scout',
      stripeCustomerId: 'cus_dup',
      stripeSubscriptionId: 'sub_A',
      currentPeriodEnd: periodEnd,
    });
    // First activation supersedes nothing.
    expect(first.supersededSubscriptionId).toBeNull();

    // A second checkout (race) completes with a different subscription id →
    // the old one is reported so the caller cancels it at Stripe (no orphan).
    const second = await activateStripeSubscription({
      userId: user,
      tier: 'guardian',
      stripeCustomerId: 'cus_dup',
      stripeSubscriptionId: 'sub_B',
      currentPeriodEnd: periodEnd,
    });
    expect(second.supersededSubscriptionId).toBe('sub_A');

    // Re-activating the SAME subscription id (idempotent webhook redelivery)
    // supersedes nothing.
    const again = await activateStripeSubscription({
      userId: user,
      tier: 'guardian',
      stripeCustomerId: 'cus_dup',
      stripeSubscriptionId: 'sub_B',
      currentPeriodEnd: periodEnd,
    });
    expect(again.supersededSubscriptionId).toBeNull();
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
