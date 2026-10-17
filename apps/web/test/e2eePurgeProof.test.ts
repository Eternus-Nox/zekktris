import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computePurgeProof, computeVerifier, saveLocalKey, clearLocalKey } from '../src/lib/e2ee';
import { ensurePurgeProofRegistered } from '../src/lib/e2eePurgeProof';

// ── E2EE purge proof ───────────────────────────────────────────────────────
//
// Disabling E2EE purges the encrypted history, so the server requires a proof
// only a key holder can produce: base64( SHA-256( keyBytes || "zkE2EE/purge-v1" ) ).
// It stores only the proof's hash and never returns it (the verifier, by
// contrast, is in every participant's channel DTO).
//
// Golden vector — computed independently with Node's crypto.createHash from
// the same key as e2eeCallKey.test.ts. ios-native/ZekktrisTests asserts the
// same vector; android-native's E2EE.purgeProof is the same computation.
const KEY_B64 = 'YimdlwXN5XtC7BY6H+EsKc8JTSMycfv9Cl2dBSNg2wo=';
const VERIFIER = 'FagWYpIz64/IzDGxoQ/uBvRKIrzc+VthN0p/st8h790=';
const PURGE_PROOF = 'rH+DBSWbET5wJGN0x8XwSqpgiPhCc4wJtxgKv+fbaQI=';

const CHANNEL = '223456789012345678';

describe('E2EE purge proof', () => {
  it('derives the cross-platform golden vector', async () => {
    expect(await computePurgeProof(KEY_B64)).toBe(PURGE_PROOF);
  });

  it('is domain-separated from the public verifier', async () => {
    expect(await computeVerifier(KEY_B64)).toBe(VERIFIER);
    expect(PURGE_PROOF).not.toBe(VERIFIER);
  });
});

describe('ensurePurgeProofRegistered', () => {
  beforeEach(() => {
    clearLocalKey(CHANNEL);
  });

  function fakeRest() {
    return { registerDmE2eePurgeProof: vi.fn(async () => ({ ok: true as const })) };
  }
  // Each test uses its own channel id: registration is attempted once per
  // channel+verifier per session.
  let n = 0;
  function channel(overrides: Record<string, unknown> = {}) {
    n += 1;
    const id = `${CHANNEL}${n}`;
    saveLocalKey(id, KEY_B64);
    return {
      id,
      e2eeEnabled: true,
      e2eeVerifier: VERIFIER,
      e2eePurgeProofSet: false,
      ...overrides,
    };
  }

  it('registers the proof for an encrypted DM the server has no proof for', async () => {
    const rest = fakeRest();
    const ch = channel();
    expect(await ensurePurgeProofRegistered(rest, ch)).toBe(true);
    expect(rest.registerDmE2eePurgeProof).toHaveBeenCalledWith(ch.id, VERIFIER, PURGE_PROOF);
    // Only once per session for the same key.
    expect(await ensurePurgeProofRegistered(rest, ch)).toBe(false);
    expect(rest.registerDmE2eePurgeProof).toHaveBeenCalledTimes(1);
  });

  it('does nothing when a proof is already set, or the server predates the field', async () => {
    const rest = fakeRest();
    expect(await ensurePurgeProofRegistered(rest, channel({ e2eePurgeProofSet: true }))).toBe(false);
    expect(await ensurePurgeProofRegistered(rest, channel({ e2eePurgeProofSet: undefined }))).toBe(false);
    expect(rest.registerDmE2eePurgeProof).not.toHaveBeenCalled();
  });

  it('does nothing without the current key (locked, or stale after a re-key)', async () => {
    const rest = fakeRest();
    const locked = channel();
    clearLocalKey(locked.id);
    expect(await ensurePurgeProofRegistered(rest, locked)).toBe(false);
    const stale = channel({ e2eeVerifier: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    expect(await ensurePurgeProofRegistered(rest, stale)).toBe(false);
    expect(rest.registerDmE2eePurgeProof).not.toHaveBeenCalled();
  });

  it('swallows a refused registration (e.g. 409, another proof already stored)', async () => {
    const rest = {
      registerDmE2eePurgeProof: vi.fn(async () => {
        throw new Error('conflict');
      }),
    };
    expect(await ensurePurgeProofRegistered(rest, channel())).toBe(false);
    expect(rest.registerDmE2eePurgeProof).toHaveBeenCalledTimes(1);
  });
});
