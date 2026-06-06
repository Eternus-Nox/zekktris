/**
 * Field-level encryption at rest
 * ------------------------------
 * AES-256-GCM for individual sensitive columns whose plaintext would be
 * damaging in a database-only breach but which the *server* must still be
 * able to read (so true end-to-end encryption isn't applicable). Today
 * this protects the TOTP 2FA secret and the bot event-signing secret.
 *
 * Why these and not "everything": fields the server queries by value
 * (email, username) can't use random-IV encryption without losing
 * equality lookups, and most profile text isn't a credential. These two
 * columns ARE credentials, are only ever read for verification/signing,
 * and are never looked up by value — so they encrypt cleanly.
 *
 * Key
 *   Read from FIELD_ENCRYPTION_KEY (32 bytes, hex or base64; validated in
 *   env.ts). When the key is UNSET, encryption is disabled: encryptField
 *   returns plaintext and logs a one-time warning. This keeps existing
 *   deployments working on upgrade — turning encryption on is opt-in by
 *   setting the key. decryptField always reads both formats, so flipping
 *   the key on (or running the backfill script) is seamless.
 *
 * Stored format (versioned so the scheme can rotate later):
 *   enc:v1:<base64url(iv)>:<base64url(authTag)>:<base64url(ciphertext)>
 *
 * Anything WITHOUT the `enc:v1:` prefix is treated as legacy plaintext and
 * passed through unchanged on decrypt — so rows written before the key was
 * set keep working until they're next written (writes re-encrypt when a
 * key is present) or until the backfill script runs.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

// undefined = not yet resolved; null = no key configured; Buffer = active key.
let keyCache: Buffer | null | undefined;
let warnedMissing = false;

/** Decode a hex (64 chars) or base64 (44 chars) key string to 32 bytes. */
export function decodeFieldKey(raw: string): Buffer {
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

function getKey(): Buffer | null {
  if (keyCache !== undefined) return keyCache;
  const raw = env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    keyCache = null;
    if (!warnedMissing) {
      warnedMissing = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[fieldCrypto] FIELD_ENCRYPTION_KEY is not set — sensitive fields ' +
          '(TOTP and bot event secrets) are stored UNENCRYPTED at rest. Set a ' +
          '32-byte key (openssl rand -hex 32) to enable encryption.',
      );
    }
    return null;
  }
  keyCache = decodeFieldKey(raw);
  return keyCache;
}

/** True when a valid encryption key is configured. */
export function isFieldEncryptionEnabled(): boolean {
  return getKey() !== null;
}

/** True when a stored value is in the enc:v1 envelope (vs legacy plaintext). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext string for at-rest storage. With no key configured,
 * returns the plaintext unchanged (warning logged once) so writes never
 * fail on a deployment that hasn't opted in yet.
 */
export function encryptField(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    [iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
      ':',
    )
  );
}

/**
 * Decrypt a value produced by encryptField. Legacy plaintext (no prefix)
 * is returned as-is. Throws if a value IS encrypted but no key is set, the
 * envelope is malformed, or the auth tag fails to verify (wrong key /
 * tampering) — callers should treat that as "secret unavailable", never as
 * a silent pass.
 */
export function decryptField(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const key = getKey();
  if (!key) {
    throw new Error(
      'Encountered an encrypted field but FIELD_ENCRYPTION_KEY is not set. ' +
        'Restore the key the data was encrypted with.',
    );
  }
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted field (expected iv:tag:ciphertext)');
  }
  const iv = Buffer.from(parts[0]!, 'base64url');
  const tag = Buffer.from(parts[1]!, 'base64url');
  const ciphertext = Buffer.from(parts[2]!, 'base64url');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Nullable convenience wrapper for nullable columns. */
export function encryptNullable(plaintext: string | null | undefined): string | null {
  return plaintext == null ? null : encryptField(plaintext);
}

/** Nullable convenience wrapper for nullable columns. */
export function decryptNullable(stored: string | null | undefined): string | null {
  return stored == null ? null : decryptField(stored);
}
