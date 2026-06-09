import { describe, it, expect, afterEach } from 'vitest';
import {
  encryptField,
  decryptField,
  isEncrypted,
  reencryptToPrimary,
  decodeFieldKey,
  __setKeysForTests,
  __resetKeysForTests,
} from '../src/lib/fieldCrypto';

// Three distinct valid 32-byte keys (hex).
const KA = decodeFieldKey('11'.repeat(32));
const KB = decodeFieldKey('22'.repeat(32));
const KC = decodeFieldKey('33'.repeat(32));

/** Encrypt a value under a specific key, as if it were written before rotation. */
function encryptUnder(key: Buffer, plaintext: string): string {
  __setKeysForTests(key, []);
  return encryptField(plaintext);
}

afterEach(() => {
  __resetKeysForTests();
});

describe('field crypto — multi-key decryption (rotation)', () => {
  it('decrypts a value written under a PREVIOUS key after rotation', () => {
    const stored = encryptUnder(KA, 's3cr3t-totp');
    // Rotate: new primary KB, KA demoted to old.
    __setKeysForTests(KB, [KA]);
    expect(decryptField(stored)).toBe('s3cr3t-totp');
  });

  it('always ENCRYPTS under the primary key (not an old key)', () => {
    __setKeysForTests(KB, [KA]);
    const fresh = encryptField('hello');
    // KB alone (no old keys) must be able to read it.
    __setKeysForTests(KB, []);
    expect(decryptField(fresh)).toBe('hello');
  });

  it('tries keys in order and the right one wins (KA in the old list)', () => {
    const underA = encryptUnder(KA, 'alpha');
    __setKeysForTests(KB, [KC, KA]); // primary + two olds; only KA verifies
    expect(decryptField(underA)).toBe('alpha');
  });

  it('throws (loud) when no configured key can decrypt — the rotation footgun', () => {
    const underA = encryptUnder(KA, 'alpha');
    __setKeysForTests(KC, []); // wrong key, no olds
    expect(() => decryptField(underA)).toThrow(/Could not decrypt/i);
  });

  it('throws when an encrypted value is seen but no key is configured', () => {
    const underA = encryptUnder(KA, 'alpha');
    __setKeysForTests(null, []);
    expect(() => decryptField(underA)).toThrow(/no FIELD_ENCRYPTION_KEY/i);
  });

  it('passes legacy plaintext through unchanged regardless of keys', () => {
    __setKeysForTests(KB, [KA]);
    expect(decryptField('legacy-plaintext')).toBe('legacy-plaintext');
    expect(isEncrypted('legacy-plaintext')).toBe(false);
  });
});

describe('field crypto — reencryptToPrimary', () => {
  it('migrates a value old→new and the result reads under the NEW key alone', () => {
    const underA = encryptUnder(KA, 'migrate-me');
    __setKeysForTests(KB, [KA]);

    const migrated = reencryptToPrimary(underA);
    expect(migrated).not.toBeNull();
    expect(isEncrypted(migrated!)).toBe(true);

    // Now decryptable by KB with no old keys at all.
    __setKeysForTests(KB, []);
    expect(decryptField(migrated!)).toBe('migrate-me');
  });

  it('is idempotent — a value already under the primary returns null (no rewrite)', () => {
    __setKeysForTests(KB, [KA]);
    const underB = encryptField('already-current');
    expect(reencryptToPrimary(underB)).toBeNull();
  });

  it('upgrades legacy plaintext to encrypted when a key is configured', () => {
    __setKeysForTests(KB, [KA]);
    const out = reencryptToPrimary('plain-old-secret');
    expect(out).not.toBeNull();
    expect(isEncrypted(out!)).toBe(true);
    expect(decryptField(out!)).toBe('plain-old-secret');
  });

  it('returns null when encryption is disabled (no primary key)', () => {
    __setKeysForTests(null, []);
    expect(reencryptToPrimary('plain-old-secret')).toBeNull();
  });

  it('throws when the value cannot be decrypted with any configured key', () => {
    const underA = encryptUnder(KA, 'alpha');
    __setKeysForTests(KB, [KC]); // KA missing → cannot decrypt
    expect(() => reencryptToPrimary(underA)).toThrow(/Could not decrypt/i);
  });
});
