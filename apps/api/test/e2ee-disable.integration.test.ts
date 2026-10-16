import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import {
  enableE2ee,
  disableE2eeAndPurge,
  registerE2eePurgeProof,
  hashPurgeProof,
} from '../src/services/dms';
import { dmsRouter } from '../src/routes/dms';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
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
// Purge proofs: base64 SHA-256(key || "zkE2EE/purge-v1") on real clients;
// opaque 44-char strings here. PROOF is the key holder's; FORGED is anything
// else a participant without the key could send.
const PROOF = 'UHVyZ2VQcm9vZktleUhvbGRlcjAwMDAwMDAwMDAwMDA9';
const FORGED = 'Rm9yZ2VkUHJvb2YwMDAwMDAwMDAwMDAwMDAwMDAwMDA9';

const app = new Hono();
app.onError(errorHandler);
app.route('/users/@me/channels', dmsRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
function call(method: string, path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function storedProofHash(channelId: bigint): Promise<string | null> {
  const [row] = await db
    .select({ h: schema.channels.e2eePurgeProofHash })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  return row?.h ?? null;
}

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

// One teardown for both suites below (closing the pool after the first would
// break the second).
afterAll(async () => {
  if (!dbReady) return;
  await cleanupAll();
  await closeDb();
});

describe.runIf(dbReady)('E2EE disable requires the passphrase verifier (integration)', () => {
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

describe.runIf(dbReady)('E2EE purge requires the undisclosed purge proof (integration)', () => {
  it('stores only the hash of the proof on enable and clears it on disable', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT, PROOF);
    expect(await storedProofHash(dm)).toBe(hashPurgeProof(PROOF));
    expect(await storedProofHash(dm)).not.toBe(PROOF);

    expect((await disableE2eeAndPurge(dm, CORRECT, PROOF)).status).toBe('disabled');
    expect(await storedProofHash(dm)).toBeNull();
  });

  it('refuses the public verifier alone (old client / echoed DTO) and purges nothing', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT, PROOF);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    const res = await disableE2eeAndPurge(dm, CORRECT);
    expect(res.status).toBe('purge_proof_mismatch');
    expect(res.purgedMessageIds).toHaveLength(0);
    expect(await isEnabled(dm)).toBe(true);
    expect(await messageExists(enc)).toBe(true);
  });

  it('refuses a forged proof and purges nothing', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT, PROOF);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    const res = await disableE2eeAndPurge(dm, CORRECT, FORGED);
    expect(res.status).toBe('purge_proof_mismatch');
    expect(await isEnabled(dm)).toBe(true);
    expect(await messageExists(enc)).toBe(true);
  });

  it('purges with the key holder\'s proof', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT, PROOF);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    const res = await disableE2eeAndPurge(dm, CORRECT, PROOF);
    expect(res.status).toBe('disabled');
    expect(res.purgedMessageIds).toContain(enc);
    expect(await messageExists(enc)).toBe(false);
  });

  it('legacy DM (no proof): registration is first-wins, then the proof is required', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT); // enabled before purge proofs existed
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    // A stale key (wrong verifier) can't register.
    expect((await registerE2eePurgeProof(dm, WRONG, PROOF)).status).toBe('verifier_mismatch');
    expect(await storedProofHash(dm)).toBeNull();

    expect((await registerE2eePurgeProof(dm, CORRECT, PROOF)).status).toBe('registered');
    expect((await registerE2eePurgeProof(dm, CORRECT, PROOF)).status).toBe('unchanged');
    // A later, different proof never overwrites the first.
    expect((await registerE2eePurgeProof(dm, CORRECT, FORGED)).status).toBe('already_registered');
    expect(await storedProofHash(dm)).toBe(hashPurgeProof(PROOF));

    // From now on the verifier alone no longer purges.
    expect((await disableE2eeAndPurge(dm, CORRECT)).status).toBe('purge_proof_mismatch');
    expect((await disableE2eeAndPurge(dm, CORRECT, FORGED)).status).toBe('purge_proof_mismatch');
    expect(await messageExists(enc)).toBe(true);
    expect((await disableE2eeAndPurge(dm, CORRECT, PROOF)).status).toBe('disabled');
    expect(await messageExists(enc)).toBe(false);
  });

  it('legacy DM with no registered proof still purges on the verifier (old clients)', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    await enableE2ee(dm, SALT, CORRECT);
    expect((await registerE2eePurgeProof(dm, CORRECT, PROOF)).status).toBe('registered');
    // ...whereas a DM that is OFF can't take a registration at all.
    expect((await disableE2eeAndPurge(dm, CORRECT, PROOF)).status).toBe('disabled');
    expect((await registerE2eePurgeProof(dm, CORRECT, PROOF)).status).toBe('not_enabled');

    const dm2 = await createDmChannel([a, b]);
    await enableE2ee(dm2, SALT, CORRECT);
    expect((await disableE2eeAndPurge(dm2, CORRECT)).status).toBe('disabled');
  });

  it('route: a participant echoing the DTO verifier gets 403 and nothing is deleted', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const tokenA = await tokenFor(a);
    const tokenB = await tokenFor(b);

    const enableRes = await call('PUT', `/users/@me/channels/${dm}/e2ee-enable`, tokenA, {
      salt: SALT,
      verifier: CORRECT,
      purgeProof: PROOF,
    });
    expect(enableRes.status).toBe(200);
    const enc = await createMessage(dm, { authorId: a, content: 'zkE2EE/3:ciphertext' });

    // B (never knew the password) reads the DM DTO: the verifier is there,
    // the proof and its hash are not.
    const listRes = await call('GET', '/users/@me/channels', tokenB);
    expect(listRes.status).toBe(200);
    const { channels: listed } = (await listRes.json()) as {
      channels: Array<Record<string, unknown>>;
    };
    const dto = listed.find((c) => c.id === dm.toString());
    expect(dto?.e2eeVerifier).toBe(CORRECT);
    expect(dto?.e2eePurgeProofSet).toBe(true);
    const raw = JSON.stringify(dto);
    expect(raw).not.toContain(PROOF);
    expect(raw).not.toContain(hashPurgeProof(PROOF));

    // Echoing the verifier back (what an old or modified client can do).
    const echo = await call('DELETE', `/users/@me/channels/${dm}/e2ee-disable`, tokenB, {
      verifier: dto?.e2eeVerifier,
    });
    expect(echo.status).toBe(403);
    const forged = await call('DELETE', `/users/@me/channels/${dm}/e2ee-disable`, tokenB, {
      verifier: dto?.e2eeVerifier,
      purgeProof: FORGED,
    });
    expect(forged.status).toBe(403);
    // B can't register its own proof over A's either.
    const reg = await call('PUT', `/users/@me/channels/${dm}/e2ee-purge-proof`, tokenB, {
      verifier: CORRECT,
      purgeProof: FORGED,
    });
    expect(reg.status).toBe(409);
    expect(await isEnabled(dm)).toBe(true);
    expect(await messageExists(enc)).toBe(true);

    // The key holder's proof purges.
    const ok = await call('DELETE', `/users/@me/channels/${dm}/e2ee-disable`, tokenA, {
      verifier: CORRECT,
      purgeProof: PROOF,
    });
    expect(ok.status).toBe(200);
    expect(await isEnabled(dm)).toBe(false);
    expect(await messageExists(enc)).toBe(false);
  });
});
