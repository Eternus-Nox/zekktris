/**
 * Password hashing
 * ----------------
 * scrypt via node:crypto. Pure standard library, no native deps, no
 * ESM/CJS interop, NIST-recommended.
 *
 * Stored format:  scrypt-v1$<saltHex>$<derivedHex>
 *
 *   scrypt-v1   format version. New versions can coexist; verify dispatches
 *               on the prefix.
 *   saltHex     16 random bytes, hex-encoded (32 chars).
 *   derivedHex  64 bytes of derived key, hex-encoded (128 chars).
 *
 * Cost parameters (N=16384, r=8, p=1) are baked into v1. To raise them,
 * introduce scrypt-v2 with new params and rehash on next successful login.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const VERSION = 'scrypt-v1';

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
    );
  });
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error('Password cannot be empty');
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plaintext, salt, KEY_BYTES);
  return `${VERSION}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Constant-time password verification.
 *
 * Returns false (rather than throwing) for any kind of malformed stored
 * hash — that way an attacker who somehow corrupts a row can't distinguish
 * "wrong password" from "wrong format".
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  if (!plaintext || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [version, saltHex, derivedHex] = parts;
  if (version !== VERSION) return false;
  if (!saltHex || !derivedHex) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(derivedHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;

  const derived = await scryptAsync(plaintext, salt, expected.length);
  // timingSafeEqual requires equal-length buffers; we already checked.
  return timingSafeEqual(derived, expected);
}

/**
 * Spend the same CPU as a real verify, then return false. Used by the login
 * route on the email-lookup-miss path so an attacker can't distinguish
 * "no such user" from "wrong password" by timing. The salt is random so
 * the result is meaningless, but the work is real.
 */
export async function verifyAgainstDummy(plaintext: string): Promise<false> {
  const salt = randomBytes(SALT_BYTES);
  await scryptAsync(plaintext || '\0', salt, KEY_BYTES);
  return false;
}
