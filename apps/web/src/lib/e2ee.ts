/**
 * Client-side E2EE for DMs — shared-key model
 * --------------------------------------------
 * Both users of a 1:1 DM share a single symmetric key, derived
 * client-side from a passphrase one of them picks and tells the
 * other via any out-of-band channel. The server never sees the
 * passphrase or the derived key — only:
 *
 *   salt:     16 random bytes (base64) used by PBKDF2 alongside
 *             the passphrase to deterministically derive the key.
 *             Same on both clients.
 *   verifier: SHA-256 of the derived key (base64). Lets each
 *             client confirm "I typed the right password" without
 *             the server learning the key.
 *
 * Algorithm: PBKDF2-SHA-256 (250 000 iterations, 32-byte output)
 * → 256-bit symmetric key → AES-256-GCM with a 12-byte random IV
 * per message (the AES-GCM standard). Every algorithm here is a
 * recognized international standard (NIST FIPS / IETF RFC) — there is
 * no proprietary or non-standard cipher in the message path.
 *
 * Wire format: `zkE2EE/3:<base64(iv(12) || ciphertext||tag)>` (AES-256-GCM)
 * is the only format messages are written in OR read from.
 *
 * Legacy prefixes `zkE2EE/2:` (XSalsa20-Poly1305 / NaCl secretbox) and
 * `zkE2EE/1:` (per-user keypair) are still recognized as encrypted but are
 * NO LONGER decryptable — the XSalsa20 code path has been removed. Any
 * messages remaining in those formats are dead history and render as
 * "couldn't decrypt" tombstones.
 *
 * Local storage:
 *   - `zekktris.e2ee.shared.<channelId>.v2` → the derived key
 *     (base64). Cleared on disable; user re-types password to
 *     restore on a new device, OR imports from a saved backup.
 *
 * Disabling clears the local cached key + server purges encrypted
 * message history. Re-enabling generates a fresh salt; the old
 * password is dead.
 */

import naclUtil from 'tweetnacl-util';

const STORAGE_PREFIX = 'zekktris.e2ee.shared.';
const STORAGE_SUFFIX = '.v2';
// Wire-format prefixes. Messages are written in and read from v3
// (AES-256-GCM) ONLY — the single cipher in the message path. The legacy
// v2 (XSalsa20-Poly1305 / NaCl secretbox) and v1 (per-user keypair)
// prefixes are still recognized so old messages render as "couldn't
// decrypt" tombstones instead of raw ciphertext, but they are no longer
// decryptable — the XSalsa20 code path has been removed.
const WIRE_PREFIX_V3 = 'zkE2EE/3:';
const WIRE_PREFIX_V2 = 'zkE2EE/2:';
const KEY_BYTES = 32;
const GCM_IV_BYTES = 12; // 96-bit IV — the AES-GCM standard
const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 250_000;

const cache = new Map<string, Uint8Array>();

// Cache of imported AES-GCM CryptoKeys, keyed by base64 of the raw key bytes.
// crypto.subtle.importKey is async; caching the promise avoids re-importing on
// every message in a conversation. Keyed by key-content, so a rotated key can
// never collide with a stale entry.
const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const id = naclUtil.encodeBase64(keyBytes);
  let p = aesKeyCache.get(id);
  if (!p) {
    p = crypto.subtle.importKey(
      'raw',
      keyBytes.slice() as BufferSource,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    aesKeyCache.set(id, p);
  }
  return p;
}

// ── Reactive key-availability tracking ──────────────────────────────────
//
// MessageItem decrypts inside a useMemo. Without a key-availability
// signal in the memo's deps, a message rendered BEFORE the user
// unlocked the conversation stays rendered as "Enter password" even
// after the key arrives — the memo doesn't re-run. We export a
// React-friendly subscribe API that increments a version counter
// whenever any key is added/removed/imported so subscribed
// components re-render in lockstep with key changes.
//
// Used via useSyncExternalStore in MessageItem:
//   const ver = useSyncExternalStore(subscribeToKeyChanges, getKeyVersion);
//   // include `ver` in the decryption useMemo's deps
let keyVersion = 0;
const keyListeners = new Set<() => void>();

// Decrypted-TEXT cache: channelId + keyVersion + wireFormat -> plaintext.
// In-memory only (never persisted), FIFO-evicted past a count cap, and CLEARED
// on any key change below so a rotated/cleared key can never serve stale
// plaintext. Avoids re-running AES-GCM every time a virtualized message row
// re-mounts on scroll — the dominant E2EE-DM scroll cost on web. Same contract
// as the decryptedMedia cache, for text.
const decryptedText = new Map<string, string>();
const DECRYPTED_TEXT_MAX = 4000;

function notifyKeyChange(): void {
  keyVersion++;
  decryptedText.clear();
  for (const fn of keyListeners) {
    try {
      fn();
    } catch {
      // listener errors must not affect other listeners
    }
  }
}

export function getKeyVersion(): number {
  return keyVersion;
}

export function subscribeToKeyChanges(listener: () => void): () => void {
  keyListeners.add(listener);
  return () => {
    keyListeners.delete(listener);
  };
}

function storageKey(channelId: string): string {
  return STORAGE_PREFIX + channelId + STORAGE_SUFFIX;
}

// ── Salt + key derivation ────────────────────────────────────────────────

/**
 * Generate a fresh 16-byte PBKDF2 salt. Called by the user who is
 * enabling E2EE; the salt is uploaded to the server alongside the
 * key verifier so the other participant can rederive the same key
 * from the same passphrase.
 */
export function generateSalt(): string {
  return naclUtil.encodeBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Derive the symmetric key from a passphrase + salt. Uses Web
 * Crypto's PBKDF2-SHA-256 at 250 000 iterations — slow enough to
 * make offline password-cracking computationally expensive while
 * still completing in <1s on a typical phone. Returns the key
 * base64-encoded.
 *
 * The same (password, salt) pair always produces the same key, so
 * both participants in a DM arrive at the identical key without
 * any server-mediated exchange of the key itself.
 */
export async function deriveKeyFromPassword(
  password: string,
  saltBase64: string,
): Promise<string> {
  const salt = naclUtil.decodeBase64(saltBase64);
  const passwordBytes = naclUtil.decodeUTF8(password);
  // Import the password as a "raw" key material for PBKDF2.
  // crypto.subtle.importKey is the only way to feed bytes into the
  // PBKDF2 step. Cast to BufferSource — TS narrows Uint8Array's
  // backing buffer to ArrayBufferLike (could be SharedArrayBuffer)
  // but Web Crypto only accepts plain ArrayBuffer; at runtime the
  // call works either way.
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    KEY_BYTES * 8, // bits
  );
  return naclUtil.encodeBase64(new Uint8Array(derivedBits));
}

/**
 * Compute the verifier hash for a derived key — base64 SHA-256.
 * Server stores this; second user's client recomputes it from their
 * typed password and checks it matches. Includes a domain-separation
 * tag so this hash is never reusable for any other crypto purpose
 * (a precaution against future protocol mistakes that might want
 * to hash the same value differently).
 */
export async function computeVerifier(keyBase64: string): Promise<string> {
  const keyBytes = naclUtil.decodeBase64(keyBase64);
  // Domain-separate the verifier hash from any other use of the
  // key. Without this, an attacker who learned the verifier might
  // try to use it as input to some downstream operation that
  // also hashes the key directly. The tag bytes break any such
  // accidental overlap.
  const tag = naclUtil.decodeUTF8('zkE2EE/verify-v2');
  const combined = new Uint8Array(keyBytes.length + tag.length);
  combined.set(keyBytes, 0);
  combined.set(tag, keyBytes.length);
  const hash = await crypto.subtle.digest('SHA-256', combined as BufferSource);
  return naclUtil.encodeBase64(new Uint8Array(hash));
}

// ── Local key storage ────────────────────────────────────────────────────

export function saveLocalKey(channelId: string, keyBase64: string): void {
  const keyBytes = naclUtil.decodeBase64(keyBase64);
  if (keyBytes.length !== KEY_BYTES) return;
  cache.set(channelId, keyBytes);
  try {
    localStorage.setItem(storageKey(channelId), keyBase64);
  } catch {
    // Private mode etc — in-memory cache still works this session.
  }
  // Fire reactive notification so MessageItem (and anyone else who
  // subscribed) re-renders against the freshly-available key.
  notifyKeyChange();
}

export function getLocalKey(channelId: string): Uint8Array | null {
  const cached = cache.get(channelId);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(storageKey(channelId));
    if (!raw) return null;
    const bytes = naclUtil.decodeBase64(raw);
    if (bytes.length !== KEY_BYTES) return null;
    cache.set(channelId, bytes);
    return bytes;
  } catch {
    return null;
  }
}

export function hasLocalKey(channelId: string): boolean {
  return getLocalKey(channelId) !== null;
}

export function clearLocalKey(channelId: string): void {
  // Release the imported AES-GCM CryptoKey alongside the raw bytes so a
  // disabled/rotated key doesn't linger in aesKeyCache for the page
  // lifetime. Read the bytes first (before deleting) to recover the
  // content-addressed cache id.
  const existing = cache.get(channelId);
  if (existing) {
    try {
      aesKeyCache.delete(naclUtil.encodeBase64(existing));
    } catch {
      // ignore — eviction is best-effort hygiene
    }
  }
  cache.delete(channelId);
  try {
    localStorage.removeItem(storageKey(channelId));
  } catch {
    // ignore
  }
  notifyKeyChange();
}

// ── Encrypt / decrypt ────────────────────────────────────────────────────

/**
 * Encrypt `plaintext` for the given DM using the local cached key.
 * Returns the wire-format string or null if no local key exists.
 * Caller should check hasLocalKey first or surface "enter password"
 * UI when this returns null.
 *
 * When `expectedVerifier` is supplied and the cached key no longer
 * matches it — a stale key left over from a previous E2EE epoch after
 * the peer disabled + re-enabled the DM with a fresh salt — the stale
 * key is dropped and null is returned, rather than encrypting under a
 * dead key (which would produce ciphertext the re-keyed peer can't
 * decrypt while the sender's UI shows a normally-sent message). Mirrors
 * the call-path guard in getCallKeyString.
 */
export async function encryptForDm(
  plaintext: string,
  channelId: string,
  expectedVerifier?: string | null,
): Promise<string | null> {
  const key = getLocalKey(channelId);
  if (!key) return null;
  if (expectedVerifier) {
    try {
      const verifier = await computeVerifier(naclUtil.encodeBase64(key));
      if (verifier !== expectedVerifier) {
        clearLocalKey(channelId);
        return null;
      }
    } catch {
      return null;
    }
  }
  try {
    const cryptoKey = await importAesKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const plaintextBytes = naclUtil.decodeUTF8(plaintext);
    // WebCrypto AES-GCM appends the 16-byte auth tag onto the ciphertext.
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        cryptoKey,
        plaintextBytes as BufferSource,
      ),
    );
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    return WIRE_PREFIX_V3 + naclUtil.encodeBase64(combined);
  } catch {
    return null;
  }
}

function decryptedTextKey(channelId: string, wireFormat: string): string {
  return `${channelId}\0${keyVersion}\0${wireFormat}`;
}

/**
 * Synchronous peek into the decrypted-text cache. Lets a re-mounted message row
 * paint its plaintext on the FIRST frame (no empty→filled flash) when the row
 * was already decrypted this session. Returns null on a miss.
 */
export function peekDecryptedText(wireFormat: string, channelId: string): string | null {
  return decryptedText.get(decryptedTextKey(channelId, wireFormat)) ?? null;
}

/**
 * Decrypt a wire-format string back to plaintext using the local
 * cached key. Returns null on any failure (no local key, malformed
 * wire format, MAC failure). Cached per (channel, keyVersion, ciphertext) so a
 * row scrolled out and back doesn't re-run AES-GCM.
 */
export async function decryptForDm(
  wireFormat: string,
  channelId: string,
): Promise<string | null> {
  const cached = decryptedText.get(decryptedTextKey(channelId, wireFormat));
  if (cached !== undefined) return cached;
  const key = getLocalKey(channelId);
  if (!key) return null;
  const kvAtStart = keyVersion;
  try {
    // v3 — AES-256-GCM (current). WebCrypto throws on an auth-tag mismatch,
    // which the surrounding catch turns into a null (failed) result.
    if (wireFormat.startsWith(WIRE_PREFIX_V3)) {
      const combined = naclUtil.decodeBase64(wireFormat.slice(WIRE_PREFIX_V3.length));
      if (combined.length <= GCM_IV_BYTES) return null;
      const iv = combined.slice(0, GCM_IV_BYTES);
      const ct = combined.slice(GCM_IV_BYTES);
      const cryptoKey = await importAesKey(key);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        cryptoKey,
        ct as BufferSource,
      );
      const plain = naclUtil.encodeUTF8(new Uint8Array(pt));
      // Never cache/return plaintext if the key was rotated/cleared mid-decrypt.
      if (keyVersion !== kvAtStart) return null;
      if (decryptedText.size > DECRYPTED_TEXT_MAX) {
        const oldest = decryptedText.keys().next().value;
        if (oldest !== undefined) decryptedText.delete(oldest);
      }
      decryptedText.set(decryptedTextKey(channelId, wireFormat), plain);
      return plain;
    }
    // v2 (legacy XSalsa20-Poly1305 / NaCl secretbox) and v1 (per-user
    // keypair) are no longer decryptable — the XSalsa20 path was removed.
    // They're still recognized as encrypted (see isEncryptedWireFormat) so
    // they render as "couldn't decrypt" rather than as raw ciphertext.
    return null;
  } catch {
    return null;
  }
}

/**
 * Cheap prefix check used by the message renderer to decide whether to
 * attempt decryption. v3 is the only decryptable format; the legacy v2
 * (XSalsa20) and v1 prefixes are still recognized so those old messages
 * render as "couldn't decrypt" tombstones rather than raw ciphertext.
 */
/**
 * Encrypt raw bytes with the channel's shared key. Output layout matches
 * the iOS native app exactly — iv(12) || ciphertext || tag(16) — so an
 * attachment encrypted on either platform decrypts on the other. Callers
 * append the `.zke` suffix to the filename to mark the payload.
 */
export async function encryptBytesForDm(
  data: Uint8Array,
  channelId: string,
): Promise<Uint8Array | null> {
  const key = getLocalKey(channelId);
  if (!key) return null;
  try {
    const cryptoKey = await importAesKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        cryptoKey,
        data as BufferSource,
      ),
    );
    const combined = new Uint8Array(iv.length + ct.length);
    combined.set(iv, 0);
    combined.set(ct, iv.length);
    return combined;
  } catch {
    return null;
  }
}

/**
 * Read an image file's natural pixel dimensions (decode-only, no re-encode).
 * Used to send plaintext dims alongside an E2EE (.zke) image so the recipient
 * reserves the exact slot before decrypt (no reflow). Returns null for formats
 * the browser can't decode (some SVG/HEIC) — the caller then sends no dims.
 */
export async function imageBitmapDims(
  file: File | Blob,
): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(file);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close();
    return dims.width > 0 && dims.height > 0 ? dims : null;
  } catch {
    return null;
  }
}

/** Decrypt `.zke` attachment bytes (iv(12) || ciphertext || tag(16)). */
export async function decryptBytesForDm(
  data: Uint8Array,
  channelId: string,
): Promise<Uint8Array | null> {
  const key = getLocalKey(channelId);
  if (!key || data.length <= GCM_IV_BYTES + 16) return null;
  try {
    const cryptoKey = await importAesKey(key);
    const iv = data.slice(0, GCM_IV_BYTES);
    const body = data.slice(GCM_IV_BYTES);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      cryptoKey,
      body as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

export function isEncryptedWireFormat(s: string): boolean {
  return (
    s.startsWith(WIRE_PREFIX_V3) ||
    s.startsWith(WIRE_PREFIX_V2) ||
    s.startsWith('zkE2EE/1:')
  );
}

// ── Decrypted-media cache (in-memory, whole session) ───────────────────────
//
// Decrypting an E2EE attachment = fetch(.zke) + AES-GCM decrypt + a Blob
// object URL. Components used to redo all of that on every mount and revoke
// the URL on unmount, so scrolling a photo out and back — or reopening it in
// the gallery/lightbox — re-fetched and re-decrypted every time. Cache the
// resulting object URL IN MEMORY for the whole session, keyed by channel+url,
// so repeat views are instant. Plaintext lives ONLY as an in-memory Blob —
// never written to disk; the page reload that ends a session drops it.
// Entries are invalidated when the channel key changes (relock/unlock) and
// evicted least-recently-used past a byte/count budget. Mirrors the iOS
// decryptedMedia LRU.
type DecryptedMediaEntry = { url: string; bytes: number; keyVersion: number };
const decryptedMedia = new Map<string, DecryptedMediaEntry>();
const decryptedMediaLRU: string[] = []; // oldest first
let decryptedMediaBytes = 0;
const DECRYPTED_MEDIA_MAX_BYTES = 256 * 1024 * 1024; // 256 MB
const DECRYPTED_MEDIA_MAX_COUNT = 256;
const decryptedMediaInFlight = new Map<string, Promise<string | null>>();

function decryptedMediaCacheKey(channelId: string, url: string): string {
  return `${channelId} ${url}`;
}

function revokeDecryptedMedia(key: string): void {
  const e = decryptedMedia.get(key);
  if (!e) return;
  URL.revokeObjectURL(e.url);
  decryptedMediaBytes -= e.bytes;
  decryptedMedia.delete(key);
  const i = decryptedMediaLRU.indexOf(key);
  if (i >= 0) decryptedMediaLRU.splice(i, 1);
}

/**
 * Decrypt an E2EE (`.zke`) attachment to a Blob object URL, cached in memory
 * for the session. The cache OWNS the returned URL — callers must NOT revoke
 * it (revocation happens on LRU eviction and on key change). Returns null when
 * the channel is locked or decryption fails. Concurrent callers for the same
 * attachment share one fetch+decrypt.
 */
export async function decryptedMediaURL(
  attachmentUrl: string,
  channelId: string,
  mimeType?: string,
): Promise<string | null> {
  const key = decryptedMediaCacheKey(channelId, attachmentUrl);
  const hit = decryptedMedia.get(key);
  if (hit) {
    if (hit.keyVersion === getKeyVersion()) {
      // Mark most-recently-used.
      const i = decryptedMediaLRU.indexOf(key);
      if (i >= 0) {
        decryptedMediaLRU.splice(i, 1);
        decryptedMediaLRU.push(key);
      }
      return hit.url;
    }
    revokeDecryptedMedia(key); // key changed → stale plaintext
  }
  const inflight = decryptedMediaInFlight.get(key);
  if (inflight) return inflight;
  // Version captured BEFORE the async fetch/decrypt. If a relock bumps the
  // version mid-flight, the key-change purge ran before this entry existed, so
  // we must refuse to cache the now-stale plaintext ourselves (otherwise it
  // would be stamped with the new version and escape the purge).
  const kvAtStart = getKeyVersion();
  const p = (async (): Promise<string | null> => {
    try {
      const res = await fetch(attachmentUrl);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const pt = await decryptBytesForDm(bytes, channelId);
      if (!pt) return null;
      // Relock landed while we were fetching/decrypting → drop the plaintext
      // (don't even create a Blob) so nothing viewable outlives the key.
      if (getKeyVersion() !== kvAtStart) return null;
      const url = URL.createObjectURL(
        new Blob([pt as BlobPart], mimeType ? { type: mimeType } : {}),
      );
      decryptedMedia.set(key, { url, bytes: pt.byteLength, keyVersion: kvAtStart });
      decryptedMediaLRU.push(key);
      decryptedMediaBytes += pt.byteLength;
      while (
        (decryptedMediaBytes > DECRYPTED_MEDIA_MAX_BYTES ||
          decryptedMedia.size > DECRYPTED_MEDIA_MAX_COUNT) &&
        decryptedMediaLRU.length > 1
      ) {
        revokeDecryptedMedia(decryptedMediaLRU[0]!);
      }
      return url;
    } catch {
      return null;
    } finally {
      decryptedMediaInFlight.delete(key);
    }
  })();
  decryptedMediaInFlight.set(key, p);
  return p;
}

/** Drop all cached decrypted media (revoking every object URL). */
export function clearDecryptedMediaCache(): void {
  for (const e of decryptedMedia.values()) URL.revokeObjectURL(e.url);
  decryptedMedia.clear();
  decryptedMediaLRU.length = 0;
  decryptedMediaBytes = 0;
  decryptedMediaInFlight.clear();
}

// A channel key change (unlock/relock/rotate) supersedes any plaintext cached
// under the old key version — eagerly revoke stale entries; the next access
// re-decrypts against the current key.
subscribeToKeyChanges(() => {
  const kv = getKeyVersion();
  for (const [k, e] of [...decryptedMedia]) {
    if (e.keyVersion !== kv) revokeDecryptedMedia(k);
  }
});

// ── Voice/video call key material ─────────────────────────────────────────

/**
 * Produce the LiveKit media-E2EE shared key for a 1:1 DM call as a
 * base64 STRING, derived from the SAME shared key this DM uses for
 * message E2EE. The returned value is the base64 of the 32-byte DM key
 * — the exact string fed to LiveKit's key provider on EVERY platform.
 *
 * ── Why a base64 string, not raw bytes (cross-client interop) ──────────
 * LiveKit's key providers expose two NON-interchangeable derivations:
 *   • a STRING passphrase → `createKeyMaterialFromString` → PBKDF2-SHA-256
 *     (salt "LKFrameEncryptionKey", 100 000 iters) → AES-128-GCM media key.
 *     The native Swift SDK uses exactly this path: `BaseKeyProvider(
 *     isSharedKey:true, sharedKey:)` UTF-8-encodes the string and runs it
 *     through the same libwebrtc PBKDF2. livekit-client documents the
 *     string path as "recommended for maximum compatibility across SDKs."
 *   • an ArrayBuffer → `createKeyMaterialFromBuffer` → HKDF over the raw
 *     bytes. Web-only; the docs warn "Not all client SDKs support HKDF,"
 *     and the Swift SDK has no raw-bytes entry point at all.
 *
 * The native client feeds `key.base64EncodedString()` (the STRING/PBKDF2
 * path). For native↔web calls to decrypt, the web client must feed the
 * IDENTICAL string through the IDENTICAL PBKDF2 path — so this returns the
 * base64 string and the caller passes it to `keyProvider.setKey(<string>)`,
 * which selects PBKDF2. Passing raw bytes here would silently switch web
 * to HKDF — that mismatch was the bug that left native↔web call audio
 * garbled while native↔native and web↔web each worked in isolation.
 *
 * Both participants derive the identical DM key from the same password +
 * salt (the unlock verifier guarantees this), so they feed setKey the
 * identical string and converge on the same media key. Mismatched
 * passwords mean different (or absent) keys, so the media is mutually
 * undecryptable and the call carries no audio/video — the intended
 * "calls won't work unless the passwords match" behavior.
 *
 * Returns null when there is nothing safe to key the call with:
 *   - no key is cached locally for this channel (the user hasn't
 *     unlocked the conversation on this device), or
 *   - `expectedVerifier` is supplied and the cached key no longer
 *     matches it — a stale key left over from a previous E2EE epoch
 *     after the DM was disabled and re-enabled with a fresh salt.
 *
 * In either case the caller should refuse to start the call and prompt
 * the user to (re-)enter the conversation password, rather than placing
 * a call whose media the encrypted peer can't decode.
 */
export async function getCallKeyString(
  channelId: string,
  expectedVerifier?: string | null,
): Promise<string | null> {
  const keyBytes = getLocalKey(channelId);
  if (!keyBytes || keyBytes.length !== KEY_BYTES) return null;
  // Re-encode to the canonical base64 of exactly the 32 key bytes. This is
  // the identical string the native client passes to its key provider
  // (Swift's `Data.base64EncodedString()` and tweetnacl-util both emit
  // RFC 4648 base64 with padding), so the two platforms key LiveKit's
  // PBKDF2 from byte-for-byte the same input.
  const keyBase64 = naclUtil.encodeBase64(keyBytes);
  if (expectedVerifier) {
    try {
      const verifier = await computeVerifier(keyBase64);
      if (verifier !== expectedVerifier) return null;
    } catch {
      return null;
    }
  }
  return keyBase64;
}

// ── Backup / restore ─────────────────────────────────────────────────────

interface StoredKey {
  keyBase64: string;
  /** Approximate timestamp the key was first cached locally. Optional
      so backups from older clients still import. */
  cachedAt?: string;
}

export interface SharedKeysBackup {
  type: 'zekktris-e2ee-shared-keys';
  version: number;
  exportedAt: string;
  keys: Record<string, StoredKey>;
}

/**
 * Bundle every cached shared-key from this device into a single
 * backup object. Used by users who'd rather not remember their
 * passphrase — the backup file restores access without needing
 * to re-type the password on a new device.
 *
 * Returns null when no shared keys are cached locally.
 */
export function exportAllDmKeys(): SharedKeysBackup | null {
  const keys: Record<string, StoredKey> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (!k.startsWith(STORAGE_PREFIX)) continue;
      if (!k.endsWith(STORAGE_SUFFIX)) continue;
      const channelId = k.slice(STORAGE_PREFIX.length, -STORAGE_SUFFIX.length);
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      keys[channelId] = { keyBase64: raw };
    }
  } catch {
    return null;
  }
  if (Object.keys(keys).length === 0) return null;
  return {
    type: 'zekktris-e2ee-shared-keys',
    version: 2,
    exportedAt: new Date().toISOString(),
    keys,
  };
}

/**
 * Restore per-DM keys from a backup file. Returns the list of
 * channel ids successfully restored, or null on whole-file failure.
 * Individual bad entries are silently skipped.
 *
 * Restored keys are saved BOTH in memory and to localStorage.
 */
export function importAllDmKeys(rawJson: string): string[] | null {
  try {
    const parsed = JSON.parse(rawJson) as Partial<SharedKeysBackup>;
    if (parsed.type !== 'zekktris-e2ee-shared-keys') return null;
    if (parsed.version !== 2) return null;
    if (!parsed.keys || typeof parsed.keys !== 'object') return null;
    const restored: string[] = [];
    for (const [channelId, entry] of Object.entries(parsed.keys)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.keyBase64 !== 'string') continue;
      try {
        const bytes = naclUtil.decodeBase64(entry.keyBase64);
        if (bytes.length !== KEY_BYTES) continue;
        cache.set(channelId, bytes);
        localStorage.setItem(storageKey(channelId), entry.keyBase64);
        restored.push(channelId);
      } catch {
        // skip
      }
    }
    if (restored.length > 0) notifyKeyChange();
    return restored;
  } catch {
    return null;
  }
}
