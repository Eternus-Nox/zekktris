import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createUser, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';
import {
  encryptField,
  decryptField,
  decodeFieldKey,
  __setKeysForTests,
  __resetKeysForTests,
} from '../src/lib/fieldCrypto';
import { reencryptAllFields } from '../scripts/reencrypt-fields';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping reencrypt-fields tests — no database reachable');
}

const KA = decodeFieldKey('aa'.repeat(32)); // original key
const KB = decodeFieldKey('bb'.repeat(32)); // new primary
const KC = decodeFieldKey('cc'.repeat(32)); // an unknown key (never configured)

function encryptUnder(key: Buffer, plaintext: string): string {
  __setKeysForTests(key, []);
  return encryptField(plaintext);
}

async function readUser(id: bigint) {
  const [row] = await db
    .select({ totpSecret: schema.users.totpSecret, botEventSecret: schema.users.botEventSecret })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return row!;
}

describe.runIf(dbReady)('reencrypt-fields script (integration)', () => {
  afterEach(() => __resetKeysForTests());
  afterAll(async () => {
    __resetKeysForTests();
    await cleanupAll();
    await closeDb();
  });

  it('re-encrypts totp + bot secrets from an OLD key to the NEW primary, idempotently', async () => {
    const id = await createUser();
    // Seed both columns as if written under the old key KA.
    await db
      .update(schema.users)
      .set({
        totpSecret: encryptUnder(KA, 'JBSWY3DPEHPK3PXP'),
        botEventSecret: encryptUnder(KA, 'zkbsec_deadbeef'),
      })
      .where(eq(schema.users.id, id));

    // Rotate: KB primary, KA demoted to old.
    __setKeysForTests(KB, [KA]);
    const stats = await reencryptAllFields();
    expect(stats.failures).toEqual([]);
    expect(stats.totp).toBeGreaterThanOrEqual(1);
    expect(stats.bot).toBeGreaterThanOrEqual(1);

    // The stored values now read under the NEW key with NO old keys present.
    const row = await readUser(id);
    __setKeysForTests(KB, []);
    expect(decryptField(row.totpSecret!)).toBe('JBSWY3DPEHPK3PXP');
    expect(decryptField(row.botEventSecret!)).toBe('zkbsec_deadbeef');

    // Idempotent: a second run (KB primary) rewrites nothing for this row.
    __setKeysForTests(KB, [KA]);
    const before = await readUser(id);
    const stats2 = await reencryptAllFields();
    const after = await readUser(id);
    expect(after.totpSecret).toBe(before.totpSecret); // byte-identical → not rewritten
    expect(after.botEventSecret).toBe(before.botEventSecret);
    // (stats2.updated counts only rows that changed; this row contributed 0.)
    expect(stats2.failures).toEqual([]);
  });

  it('leaves a row untouched and reports it when no configured key can decrypt', async () => {
    const id = await createUser();
    const orphaned = encryptUnder(KC, 'JBSWY3DPEHPK3PXP'); // KC is never configured below
    await db.update(schema.users).set({ totpSecret: orphaned }).where(eq(schema.users.id, id));

    __setKeysForTests(KB, [KA]); // neither KB nor KA can read a KC value
    const stats = await reencryptAllFields();

    expect(stats.failures.map((f) => f.id)).toContain(id.toString());
    // Untouched — no data lost.
    const row = await readUser(id);
    expect(row.totpSecret).toBe(orphaned);
  });
});
