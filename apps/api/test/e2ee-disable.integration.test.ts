import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { enableE2ee, disableE2eeAndPurge } from '../src/services/dms';
import { createUser, createDmChannel, createMessage, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping e2ee-disable tests — no database reachable');
}

// Opaque base64-shaped verifiers (44 chars). The service compares them as
// strings; their exact value doesn't matter, only that "correct" matches what
// was stored and "wrong"/"" do not.
const SALT = 'c2FsdHNhbHRzYWx0c2FsdA==';
const CORRECT = 'Q29ycmVjdFZlcmlmaWVyMDAwMDAwMDAwMDAwMDAwMD0=';
const WRONG = 'V3JvbmdWZXJpZmllcjAwMDAwMDAwMDAwMDAwMDAwMDA9=';

async function isEnabled(channelId: bigint): Promise<boolean> {
  const [row] = await db
    .select({ e: schema.channels.e2eeEnabled })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  return row?.e === true;
}
async function messageExists(id: bigint): Promise<boolean> {
  const rows = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  return rows.length > 0;
}

describe.runIf(dbReady)('E2EE disable requires the passphrase verifier (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('returns not_enabled (no purge) when E2EE was never on', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    const res = await disableE2eeAndPurge(dm, CORRECT);
    expect(res.status).toBe('not_enabled');
    expect(res.purgedMessageIds).toHaveLength(0);
    // Nothing touched.
    expect(await messageExists(enc)).toBe(true);
  });

  it('rejects a WRONG verifier and purges nothing', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    const res = await disableE2eeAndPurge(dm, WRONG);
    expect(res.status).toBe('verifier_mismatch');
    expect(res.purgedMessageIds).toHaveLength(0);
    // Encryption stays ON and the encrypted message survives.
    expect(await isEnabled(dm)).toBe(true);
    expect(await messageExists(enc)).toBe(true);
  });

  it('rejects an EMPTY/missing verifier and purges nothing', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    const res = await disableE2eeAndPurge(dm, '');
    expect(res.status).toBe('verifier_mismatch');
    expect(await isEnabled(dm)).toBe(true);
    expect(await messageExists(enc)).toBe(true);
  });

  it('disables and purges encrypted messages with the CORRECT verifier, sparing plaintext', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });
    const plain = await createMessage(dm, { authorId: a, content: 'hello (plaintext)' });

    const res = await disableE2eeAndPurge(dm, CORRECT);
    expect(res.status).toBe('disabled');
    expect(res.purgedMessageIds).toContain(enc);
    // Encryption is now OFF, the ciphertext is gone, plaintext is preserved.
    expect(await isEnabled(dm)).toBe(false);
    expect(await messageExists(enc)).toBe(false);
    expect(await messageExists(plain)).toBe(true);
  });
});
