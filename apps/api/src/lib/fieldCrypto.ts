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
 * Rotation
 *   Writes always use the PRIMARY key (FIELD_ENCRYPTION_KEY). Decryption
 *   tries the primary first, then each key in FIELD_ENCRYPTION_KEYS_OLD (a
 *   comma-separated list). So a self-hoster rotates by: move the current key
 *   into FIELD_ENCRYPTION_KEYS_OLD, set a fresh FIELD_ENCRYPTION_KEY, deploy
 *   (everything still decrypts), run the re-encrypt script to rewrite all
 *   field-encrypted columns under the new primary, then drop the old key.
 *   AES-GCM's auth tag makes a wrong-key attempt fail cleanly, so trying keys
 *   in order is unambiguous — only the correct key verifies.
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
// Old keys for decrypt-only (rotation). undefined = not yet resolved.
let oldKeysCache: Buffer[] | undefined;
// Resolved decrypt order ([primary?, ...old]). undefined = not yet resolved.
let decryptKeysCache: Buffer[] | undefined;
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

/** Old keys (FIELD_ENCRYPTION_KEYS_OLD) for decrypt during/after rotation. */
function getOldKeys(): Buffer[] {
  if (oldKeysCache !== undefined) return oldKeysCache;
  oldKeysCache = (env.FIELD_ENCRYPTION_KEYS_OLD ?? []).map(decodeFieldKey);
  return oldKeysCache;
}

/** Keys to try on decrypt, in order: primary first, then old keys. */
function getDecryptKeys(): Buffer[] {
  if (decryptKeysCache !== undefined) return decryptKeysCache;
  const keys: Buffer[] = [];
  const primary = getKey();
  if (primary) keys.push(primary);
  keys.push(...getOldKeys());
  decryptKeysCache = keys;
  return keys;
}

/** Attempt one AES-GCM open. Returns null when this key doesn't verify. */
function tryDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer): string | null {
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key (tag mismatch) or corrupt envelope
  }
}

/** Parse an enc:v1 envelope into its parts, or throw if malformed. */
function parseEnvelope(stored: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted field (expected iv:tag:ciphertext)');
  }
  return {
    iv: Buffer.from(parts[0]!, 'base64url'),
    tag: Buffer.from(parts[1]!, 'base64url'),
    ciphertext: Buffer.from(parts[2]!, 'base64url'),
  };
}

/** True when `stored` is encrypted AND `key` verifies it. No throw. */
function decryptableWith(stored: string, key: Buffer): boolean {
  if (!isEncrypted(stored)) return false;
  let env_: { iv: Buffer; tag: Buffer; ciphertext: Buffer };
  try {
    env_ = parseEnvelope(stored);
  } catch {
    return false;
  }
  return tryDecrypt(key, env_.iv, env_.tag, env_.ciphertext) !== null;
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
  const keys = getDecryptKeys();
  if (keys.length === 0) {
    throw new Error(
      'Encountered an encrypted field but no FIELD_ENCRYPTION_KEY is set. ' +
        'Restore the key the data was encrypted with.',
    );
  }
  const { iv, tag, ciphertext } = parseEnvelope(stored);
  for (const key of keys) {
    const out = tryDecrypt(key, iv, tag, ciphertext);
    if (out !== null) return out;
  }
  // Every configured key failed the auth tag — the data was encrypted with a
  // key not in FIELD_ENCRYPTION_KEY or FIELD_ENCRYPTION_KEYS_OLD. Loud, never
  // a silent pass: this is the "rotation bricked the secret" footgun.
  throw new Error(
    'Could not decrypt field with any configured key (wrong or rotated ' +
      'FIELD_ENCRYPTION_KEY?). Add the original key to FIELD_ENCRYPTION_KEYS_OLD.',
  );
}

/**
 * Re-encrypt a stored value under the PRIMARY key, returning the new envelope
 * to write — or null when no rewrite is needed (already under the primary key,
 * or encryption is disabled, so re-runs are no-ops). Throws if the value can't
 * be decrypted with any configured key, so a bad rotation is loud, not silent.
 *
 * Also upgrades legacy plaintext (written before a key was set) to encrypted,
 * so the same helper serves both first-time backfill and key rotation.
 */
export function reencryptToPrimary(stored: string): string | null {
  const primary = getKey();
  if (!primary) return null; // encryption disabled — nothing to migrate
  if (isEncrypted(stored) && decryptableWith(stored, primary)) return null; // already current
  const plaintext = decryptField(stored); // primary + old keys; throws if none verify
  return encryptField(plaintext); // fresh IV under the primary key
}

// ── Test seams ───────────────────────────────────────────────────────────────
// env is validated at import, so process.env changes can't re-drive the caches.
// These let tests inject key material directly (Buffers via decodeFieldKey).

/** Set the primary + old keys directly (tests). */
export function __setKeysForTests(primary: Buffer | null, old: Buffer[] = []): void {
  keyCache = primary;
  oldKeysCache = old;
  decryptKeysCache = undefined; // recompute from the above on next decrypt
  warnedMissing = false;
}

/** Clear all key caches so they re-resolve from env (tests). */
export function __resetKeysForTests(): void {
  keyCache = undefined;
  oldKeysCache = undefined;
  decryptKeysCache = undefined;
  warnedMissing = false;
}
