import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createApp } from '../src/server';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { giftSubscription } from '../src/services/subscriptions';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping billing-removed tests — no database reachable');
}

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

// Payments and all Stripe code are gone. The old endpoints must not exist on
// the real app, so nothing — a replayed Stripe webhook included — can write a
// tier any more.
describe.runIf(dbReady)('Stripe billing removed (integration)', () => {
  const app = createApp();

  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('a Stripe checkout webhook is not routed and cannot overwrite a gift', async () => {
    const admin = await createUser();
    const user = await createUser();
    await giftSubscription(admin, user, 'legend', 'forever');

    const res = await app.request('/api/v1/billing/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=x' },
      body: JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { mode: 'subscription', subscription: 'sub_x', metadata: { userId: String(user), tier: 'scout' } } },
      }),
    });
    expect(res.status).toBe(404);

    const [row] = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.userId, user))
      .limit(1);
    expect(row).toMatchObject({ tier: 'legend', source: 'gift', expiresAt: null });
  });

  it('the billing and paid-subscription endpoints are gone', async () => {
    const admin = await createUser();
    await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, admin));
    const token = await tokenFor(admin);
    const call = (method: string, path: string) =>
      app.request(path, { method, headers: { authorization: `Bearer ${token}` } });

    expect((await call('GET', '/api/v1/billing/status')).status).toBe(404);
    expect((await call('POST', '/api/v1/billing/portal')).status).toBe(404);
    expect((await call('POST', '/api/v1/billing/cancel')).status).toBe(404);
    expect((await call('GET', '/api/v1/admin/paid-subscriptions')).status).toBe(404);
    expect((await call('POST', '/api/v1/admin/paid-subscriptions/retire')).status).toBe(404);
  });

  it('GET /users/@me no longer carries the paid-subscription cancel flag', async () => {
    const admin = await createUser();
    const user = await createUser();
    await giftSubscription(admin, user, 'scout', 'forever');
    const res = await app.request('/api/v1/users/@me', {
      headers: { authorization: `Bearer ${await tokenFor(user)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user.subscriptionSource).toBe('gift');
    expect(body.user).not.toHaveProperty('subscriptionCancelAtPeriodEnd');
  });
});
