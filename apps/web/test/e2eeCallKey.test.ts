import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveKeyFromPassword,
  computeVerifier,
  saveLocalKey,
  clearLocalKey,
  getCallKeyString,
} from '../src/lib/e2ee';

// ── E2EE 1:1 call-key interop contract ─────────────────────────────────────
//
// 1:1 DM calls key LiveKit's media E2EE from the DM's shared key. For calls to
// decrypt across clients, native (Swift) and web MUST feed LiveKit's key
// provider the *identical* shared-key string so both run the same PBKDF2 and
// land on the same media key.
//
// The contract these tests lock in:
//   • Both platforms derive the 32-byte DM key with PBKDF2-SHA-256(250k) from
//     the same (password, salt)  →  identical bytes.
//   • Both feed LiveKit the base64 of those 32 bytes as a STRING (PBKDF2 path),
//     NOT raw bytes (HKDF path). `getCallKeyString` returns exactly that string.
//
// Golden vector — computed independently with Node's crypto.pbkdf2Sync so this
// test fails loudly if the derivation or encoding ever drifts on either side.
// The native side asserts the same vector in ios-native/ZekktrisTests.
const PASSWORD = 'correct horse battery staple';
// 16 bytes of 0x07, base64.
const SALT_B64 = 'BwcHBwcHBwcHBwcHBwcHBw==';
// base64( PBKDF2-SHA256(PASSWORD, salt, 250000, 32) ) — the LiveKit shared-key
// STRING both platforms pass to setKey(...).
const KEY_B64 = 'YimdlwXN5XtC7BY6H+EsKc8JTSMycfv9Cl2dBSNg2wo=';
// base64( SHA-256( keyBytes || "zkE2EE/verify-v2" ) )
const VERIFIER = 'FagWYpIz64/IzDGxoQ/uBvRKIrzc+VthN0p/st8h790=';

const CHANNEL = '123456789012345678';

describe('E2EE call-key interop contract', () => {
  beforeEach(() => {
    clearLocalKey(CHANNEL);
  });

  it('derives the DM key to the cross-platform golden vector', async () => {
    const key = await deriveKeyFromPassword(PASSWORD, SALT_B64);
    expect(key).toBe(KEY_B64);
  });

  it('computes the matching verifier for the derived key', async () => {
    expect(await computeVerifier(KEY_B64)).toBe(VERIFIER);
  });

  it('getCallKeyString returns the base64 key STRING the native client feeds LiveKit', async () => {
    saveLocalKey(CHANNEL, KEY_B64);
    const callKey = await getCallKeyString(CHANNEL);
    // Must be the exact base64 string (NOT an ArrayBuffer / raw bytes — that
    // was the bug: raw bytes select web-only HKDF and garble native↔web calls).
    expect(typeof callKey).toBe('string');
    expect(callKey).toBe(KEY_B64);
    // And it is precisely the base64 of the derived DM key — i.e. byte-for-byte
    // what Swift's `key.base64EncodedString()` produces from the same key.
    expect(callKey).toBe(await deriveKeyFromPassword(PASSWORD, SALT_B64));
  });

  it('returns the key when the expected verifier matches (fresh, unlocked key)', async () => {
    saveLocalKey(CHANNEL, KEY_B64);
    expect(await getCallKeyString(CHANNEL, VERIFIER)).toBe(KEY_B64);
  });

  it('refuses (null) when the cached key is stale vs the server verifier', async () => {
    saveLocalKey(CHANNEL, KEY_B64);
    const staleVerifier = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    expect(await getCallKeyString(CHANNEL, staleVerifier)).toBeNull();
  });

  it('returns null when no key is cached for the channel (conversation locked)', async () => {
    expect(await getCallKeyString(CHANNEL)).toBeNull();
    expect(await getCallKeyString(CHANNEL, VERIFIER)).toBeNull();
  });
});
