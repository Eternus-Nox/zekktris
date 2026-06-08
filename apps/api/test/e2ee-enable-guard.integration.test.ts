import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { enableE2ee, disableE2eeAndPurge } from '../src/services/dms';
import { createUser, createDmChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping e2ee-enable-guard tests — no database reachable');
}

// Distinct opaque salt/verifier pairs (the service stores/compares them as
// strings; only their distinctness matters here).
const SALT_A = 'c2FsdEFzYWx0QXNhbHRBc2FsdA==';
const VER_A = 'QUFBQVZlcmlmaWVyQUFBQUFBQUFBQUFBQUFBQUFBQUE9';
const SALT_B = 'c2FsdEJzYWx0QnNhbHRCc2FsdA==';
const VER_B = 'QkJCQlZlcmlmaWVyQkJCQkJCQkJCQkJCQkJCQkJCQk9';

async function stored(channelId: bigint) {
  const [row] = await db
    .select({
      enabled: schema.channels.e2eeEnabled,
      salt: schema.channels.e2eeSalt,
      verifier: schema.channels.e2eeVerifier,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  return row;
}

describe.runIf(dbReady)('E2EE enable concurrency guard (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('enables a fresh DM (OFF -> ON) and stores the caller salt/verifier', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);

    expect((await enableE2ee(dm, SALT_A, VER_A)).status).toBe('enabled');
    const s = await stored(dm);
    expect(s?.enabled).toBe(true);
    expect(s?.salt).toBe(SALT_A);
    expect(s?.verifier).toBe(VER_A);
  });

  it('is idempotent for an identical re-enable (same salt+verifier)', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT_A, VER_A);

    expect((await enableE2ee(dm, SALT_A, VER_A)).status).toBe('unchanged');
    const s = await stored(dm);
    expect(s?.salt).toBe(SALT_A);
    expect(s?.verifier).toBe(VER_A);
  });

  it('REFUSES to clobber a live key with a different enable (the bug)', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT_A, VER_A);

    expect((await enableE2ee(dm, SALT_B, VER_B)).status).toBe('already_enabled');
    // The first party's key is untouched.
    const s = await stored(dm);
    expect(s?.salt).toBe(SALT_A);
    expect(s?.verifier).toBe(VER_A);
  });

  it('two CONCURRENT enables: exactly one wins, salt/verifier stays the winner’s', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);

    const [ra, rb] = await Promise.all([
      enableE2ee(dm, SALT_A, VER_A),
      enableE2ee(dm, SALT_B, VER_B),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual(['already_enabled', 'enabled']);

    // Stored values must be a consistent winner pair — never a mix.
    const s = await stored(dm);
    expect(s?.enabled).toBe(true);
    const winnerIsA = ra.status === 'enabled';
    expect(s?.salt).toBe(winnerIsA ? SALT_A : SALT_B);
    expect(s?.verifier).toBe(winnerIsA ? VER_A : VER_B);
  });

  it('rotation path: a fresh enable succeeds again after a gated disable', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT_A, VER_A);

    // Disable with the correct verifier (item #2 gate), then re-enable fresh.
    expect((await disableE2eeAndPurge(dm, VER_A)).status).toBe('disabled');
    expect((await enableE2ee(dm, SALT_B, VER_B)).status).toBe('enabled');
    const s = await stored(dm);
    expect(s?.enabled).toBe(true);
    expect(s?.salt).toBe(SALT_B);
    expect(s?.verifier).toBe(VER_B);
  });
});
