/**
 * Admin-configurable monetization — settings round-trip + gate enforcement.
 * -------------------------------------------------------------------------
 * Covers the instance_settings-backed monetization config end to end:
 *   - GET /instance/monetization returns the shipped DEFAULTS on an empty table
 *   - PUT /admin/monetization (admin) persists partial patches + audits
 *   - PUT is admin-only: moderators and normal users get 403 (fail-safe
 *     allowlist — the route is deliberately NOT moderator-allowed)
 *   - the Appearance cosmetic gate honors the configured tier ('none' = free;
 *     'legend' blocks a scout member)
 *   - the per-file upload cap honors a configured per-tier cap, with the env
 *     MAX_UPLOAD_SIZE_MB as the hard ceiling
 *
 * instance_settings is a global singleton table; only this file touches the
 * monetize.* / upload.cap_mb.* keys, and it purges them before AND after so
 * parallel workers running other files never observe the overrides.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, like, or } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { adminRouter } from '../src/routes/admin';
import { instanceRouter } from '../src/routes/instance';
import { usersRouter } from '../src/routes/users';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';
import { env } from '../src/env';
import * as monetization from '../src/services/monetization';
import { saveUploadedFile } from '../src/services/uploads';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping monetization tests — no database reachable');
}

// Mount at the PRODUCTION prefixes — the admin moderator-allowlist middleware
// normalizes c.req.path by stripping /api/v1/admin, so the test must present
// the same paths the real server does.
const app = new Hono();
app.onError(errorHandler);
app.route('/api/v1/admin', adminRouter);
app.route('/api/v1/instance', instanceRouter);
app.route('/users', usersRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

function req(method: string, path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function makeAdmin(userId: bigint) {
  await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId));
}
async function makeModerator(userId: bigint) {
  await db.update(schema.users).set({ isModerator: true }).where(eq(schema.users.id, userId));
}

/** A user with an own active membership row at `tier` (forever, gift). */
async function memberUser(tier: 'scout' | 'guardian' | 'legend'): Promise<bigint> {
  const uid = await createUser();
  await db.insert(schema.subscriptions).values({ userId: uid, tier, source: 'gift' });
  return uid;
}

/** Drop every monetization/upload-cap key and the in-memory cache, so each
 *  test (and every OTHER test file) starts from the shipped defaults. */
async function purgeMonetizationSettings() {
  await db
    .delete(schema.instanceSettings)
    .where(
      or(
        like(schema.instanceSettings.key, 'monetize.%'),
        like(schema.instanceSettings.key, 'upload.cap%'),
      ),
    );
  monetization.invalidateCache();
}

describe.runIf(dbReady)('admin-configurable monetization', () => {
  beforeAll(async () => {
    await purgeMonetizationSettings();
  });
  afterAll(async () => {
    await purgeMonetizationSettings();
    await cleanupAll();
    await closeDb();
  });

  it('GET /instance/monetization returns the shipped defaults on an empty table', async () => {
    const user = await createUser();
    const res = await req('GET', '/api/v1/instance/monetization', await tokenFor(user));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: monetization.MonetizationConfig };
    expect(body.config).toEqual({
      stream: { p1080: 'none', k2: 'guardian', k4: 'legend' },
      camera: { p1080: 'none', k2: 'guardian', k4: 'legend' },
      appearance: 'scout',
      uploadCapsMb: { free: null, scout: null, guardian: null, legend: null },
    });
    expect(body.config).toEqual(monetization.DEFAULTS);

    // Auth required — no token → 401.
    const anon = await app.request('/api/v1/instance/monetization');
    expect(anon.status).toBe(401);
  });

  it('PUT /admin/monetization (admin) persists a partial patch, audits, and GET reflects it', async () => {
    const admin = await createUser();
    await makeAdmin(admin);
    const adminToken = await tokenFor(admin);

    const put = await req('PUT', '/api/v1/admin/monetization', adminToken, {
      config: {
        stream: { k2: 'legend' },
        camera: { p1080: 'scout' },
        appearance: 'none',
        uploadCapsMb: { free: 25 },
      },
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { config: monetization.MonetizationConfig };
    // Patched leaves changed; everything else stays at defaults.
    expect(putBody.config.stream).toEqual({ p1080: 'none', k2: 'legend', k4: 'legend' });
    expect(putBody.config.camera).toEqual({ p1080: 'scout', k2: 'guardian', k4: 'legend' });
    expect(putBody.config.appearance).toBe('none');
    expect(putBody.config.uploadCapsMb).toEqual({ free: 25, scout: null, guardian: null, legend: null });

    // Reflected in the any-user read.
    const viewer = await createUser();
    const got = await req('GET', '/api/v1/instance/monetization', await tokenFor(viewer));
    expect(got.status).toBe(200);
    expect(((await got.json()) as { config: unknown }).config).toEqual(putBody.config);

    // Audited as staff_monetization with the changed keys in the detail.
    const events = await req('GET', '/api/v1/admin/security/events?kind=staff', adminToken);
    expect(events.status).toBe(200);
    const evBody = (await events.json()) as {
      events: Array<{ kind: string; actorId: string | null; detail: string }>;
    };
    const ev = evBody.events.find((e) => e.kind === 'staff_monetization');
    expect(ev).toBeDefined();
    expect(ev!.actorId).toBe(admin.toString());
    expect(ev!.detail).toContain('monetize.stream.k2');
    expect(ev!.detail).toContain('upload.cap_mb.free');

    // Bad enum value → 400, nothing written.
    const bad = await req('PUT', '/api/v1/admin/monetization', adminToken, {
      config: { stream: { k2: 'platinum' } },
    });
    expect(bad.status).toBe(400);
  });

  it('PUT /admin/monetization is admin-only: moderator and normal user get 403', async () => {
    const mod = await createUser();
    await makeModerator(mod);
    const nobody = await createUser();
    const patch = { config: { appearance: 'legend' } };

    const modRes = await req('PUT', '/api/v1/admin/monetization', await tokenFor(mod), patch);
    expect(modRes.status).toBe(403);
    const userRes = await req('PUT', '/api/v1/admin/monetization', await tokenFor(nobody), patch);
    expect(userRes.status).toBe(403);
  });

  it("appearance gate: 'none' lets a free user set a cosmetic; 'legend' blocks a scout member", async () => {
    // Free instance → a bare (never-subscribed) user can set a clan tag.
    await monetization.saveConfig({ appearance: 'none' });
    const freeUser = await createUser();
    const okRes = await req('PATCH', '/users/@me', await tokenFor(freeUser), { tagLabel: 'ZK' });
    expect(okRes.status).toBe(200);

    // Legend-gated → a scout member is below the bar and keeps today's
    // machine-readable error shape; a legend member clears it.
    await monetization.saveConfig({ appearance: 'legend' });
    const scout = await memberUser('scout');
    const blocked = await req('PATCH', '/users/@me', await tokenFor(scout), { tagLabel: 'ZK' });
    expect(blocked.status).toBe(403);
    const err = (await blocked.json()) as {
      error: { code: string; message: string; details?: { membershipRequired?: boolean } };
    };
    expect(err.error.details?.membershipRequired).toBe(true);
    expect(err.error.message).toContain('Legend');

    const legend = await memberUser('legend');
    const allowed = await req('PATCH', '/users/@me', await tokenFor(legend), { tagLabel: 'ZK' });
    expect(allowed.status).toBe(200);

    // Restore the default so later tests/files see stock behavior.
    await monetization.saveConfig({ appearance: 'scout' });
  });

  it('upload cap honors a configured per-tier cap, with env as the hard ceiling', async () => {
    await monetization.saveConfig({ uploadCapsMb: { free: 2, scout: 50, legend: 9_999 } });

    // A 3 MB file from a free user is over the configured 2 MB cap — rejected
    // before any disk IO, and the error names the EFFECTIVE limit.
    const freeUser = await createUser();
    const threeMb = new File([new Uint8Array(3 * 1024 * 1024)], 'big.bin', {
      type: 'application/octet-stream',
    });
    await expect(saveUploadedFile(threeMb, { uploaderId: freeUser })).rejects.toThrow(
      /exceeds 2 MB limit/,
    );

    // Per-tier resolution: scout's configured 50 wins under the env ceiling…
    expect(await monetization.uploadCapMbForTier('scout')).toBe(
      Math.min(env.MAX_UPLOAD_SIZE_MB, 50),
    );
    // …and a configured cap can never RAISE the env hard ceiling.
    expect(await monetization.uploadCapMbForTier('legend')).toBe(
      Math.min(env.MAX_UPLOAD_SIZE_MB, 9_999),
    );
    // Unconfigured tier → plain env cap.
    expect(await monetization.uploadCapMbForTier('guardian')).toBe(env.MAX_UPLOAD_SIZE_MB);
  });
});
