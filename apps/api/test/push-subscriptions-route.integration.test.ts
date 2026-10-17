import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { usersRouter } from '../src/routes/users';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { upsertSubscription } from '../src/services/push';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping push-subscriptions-route tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/users', usersRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

type Device = { id: string; label: string | null; endpointHash: string; endpoint?: unknown };

async function list(token: string): Promise<Device[]> {
  const res = await app.request('/users/@me/push-subscriptions', {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { subscriptions: Device[] }).subscriptions;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe.runIf(dbReady)('push subscription list (route)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('lets a browser find and remove ONLY its own row among several devices', async () => {
    const user = await createUser();
    const token = await tokenFor(user);
    const phone = `https://push.example/phone-${user}`;
    const laptop = `https://push.example/laptop-${user}`;
    await upsertSubscription({ userId: user, endpoint: phone, p256dh: 'p', auth: 'a', label: 'Phone' });
    await upsertSubscription({ userId: user, endpoint: laptop, p256dh: 'p', auth: 'a', label: 'Laptop' });

    const devices = await list(token);
    expect(devices).toHaveLength(2);
    // The endpoint itself (a send capability) is never listed — only its hash.
    for (const d of devices) expect(d.endpoint).toBeUndefined();
    expect(new Set(devices.map((d) => d.endpointHash))).toEqual(new Set([sha(phone), sha(laptop)]));

    // The laptop turns push off: it removes the row whose hash matches ITS endpoint.
    const own = devices.find((d) => d.endpointHash === sha(laptop))!;
    expect(own.label).toBe('Laptop');
    const del = await app.request(`/users/@me/push-subscriptions/${own.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(200);

    const after = await list(token);
    expect(after.map((d) => d.label)).toEqual(['Phone']);
  });
});
