/**
 * Two-factor authentication.
 * --------------------------
 * RFC 6238 TOTP implementation plus recovery-code management.
 *
 * We intentionally don't pull in a TOTP library — the algorithm is
 * a hundred lines of well-specified arithmetic, and avoiding the
 * dependency means one less supply-chain risk for a security-
 * critical code path.
 *
 * Algorithm (RFC 6238 + RFC 4226):
 *   1. counter = floor(time / 30)
 *   2. hmac = HMAC-SHA1(secret, counter as 8-byte big-endian)
 *   3. offset = last 4 bits of hmac
 *   4. value = (4 bytes starting at offset, top bit cleared) % 10^6
 *
 * Verification accepts ±1 step (one 30-second window in either
 * direction) to absorb client clock skew without expanding the
 * brute-force window meaningfully.
 *
 * Threat model notes:
 *   - Brute-force is mitigated by per-user limiters in the route
 *     layer: `twoFactorByUser` on login (routes/auth.ts) and the
 *     shared `stepUpRl` on confirm/disable (routes/users.ts).
 *     With a 10^6 code space and a handful of guesses per 15-min
 *     window, a determined attacker would need weeks of nonstop
 *     guessing to hit 50% probability, and the activity would
 *     spike the logs well before then.
 *   - Replay is only WINDOW-bounded: a captured code stays valid
 *     for up to ~90 seconds (±1 step) and we do not persist a
 *     last-used step. True single-use would need a per-user
 *     `totp_last_step` column checked on verify.
 *   - Recovery codes are sha256-hashed at rest. Hashing is fine
 *     here (not bcrypt) because the codes ARE random 80-bit
 *     secrets — pre-image attacks on sha256 of an 80-bit secret
 *     are not feasible.
 */
import { createHmac, randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, or, lt } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { encryptField, decryptField } from '../lib/fieldCrypto';

// ───────────────────────────────────────────────────────────────────────────
// base32 (RFC 4648, lowercase output, padding stripped — what authenticator
// apps expect when pasting). We avoid `Buffer.toString('base32')` because
// Node doesn't ship that encoder.
// ───────────────────────────────────────────────────────────────────────────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(s: string): Buffer {
  // Be forgiving on input — strip whitespace + padding, uppercase.
  const clean = s.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ───────────────────────────────────────────────────────────────────────────
// TOTP core
// ───────────────────────────────────────────────────────────────────────────

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

/** Compute the 6-digit TOTP code for a given secret + timestamp.
    Exported for the verify path; you usually want `verifyTotp`. */
export function totpCode(secret: string, atUnixSeconds: number): string {
  const key = base32Decode(secret);
  const counter = Math.floor(atUnixSeconds / TOTP_PERIOD_SECONDS);
  // 8-byte big-endian counter buffer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const slice =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(slice % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Verify a user-supplied code against the secret, allowing ±1 period of clock
    skew. Returns the matched STEP (the RFC 6238 counter, floor(time/30)) or
    null if no window matches. The step is what the single-use gate records so a
    captured code can't be replayed within its validity window. */
export function verifyTotpStep(secret: string, code: string): number | null {
  const trimmed = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return null;
  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (const offset of [-1, 0, 1]) {
    const step = currentStep + offset;
    const candidate = totpCode(secret, step * TOTP_PERIOD_SECONDS);
    // Constant-time compare to defeat timing oracles; for 6-digit
    // strings the practical risk is minimal but it costs nothing.
    if (constantTimeEqual(candidate, trimmed)) return step;
  }
  return null;
}

/** Boolean convenience wrapper over {@link verifyTotpStep}. Used where no
    single-use bookkeeping is needed (e.g. enrollment confirmation, which is
    itself one-shot). Prefer {@link consumeTotpForUser} on the login / step-up
    paths so codes are single-use. */
export function verifyTotp(secret: string, code: string): boolean {
  return verifyTotpStep(secret, code) !== null;
}

/**
 * Verify a TOTP code AND atomically mark its step consumed, making codes
 * single-use. Rejects (returns false) both a wrong code and a replay of a step
 * at or below the last one this user consumed — closing the ~90s replay window
 * a captured code otherwise had. The compare-and-set in the UPDATE WHERE means
 * two concurrent logins with the same code can't both win: only the first to
 * advance totp_last_step past `step` matches a row.
 */
export async function consumeTotpForUser(
  userId: bigint,
  secret: string,
  code: string,
): Promise<boolean> {
  const step = verifyTotpStep(secret, code);
  if (step === null) return false;
  const stepBig = BigInt(step);
  const res = await db
    .update(schema.users)
    .set({ totpLastStep: stepBig })
    .where(
      and(
        eq(schema.users.id, userId),
        or(
          isNull(schema.users.totpLastStep),
          lt(schema.users.totpLastStep, stepBig),
        ),
      ),
    )
    .returning({ id: schema.users.id });
  return res.length > 0;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Generate a fresh 160-bit (20-byte) base32 secret. 160 bits is
    RFC 4226's recommended minimum for HOTP/TOTP. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Build the standard otpauth:// URI for QR code rendering. Most
    authenticator apps (Google, 1Password, Authy, etc.) accept this
    format and provision the account on scan. */
export function buildOtpAuthUri(opts: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Recovery codes
// ───────────────────────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 10;

/** Generate a batch of recovery codes. Each code is 10 base32 chars
    (50 bits of entropy) split into two groups of 5 for readability:
    `H7FQ4-K9PXR`. The plaintext list is returned to the caller so it
    can be shown to the user once; we persist only the sha256 hashes. */
export function generateRecoveryCodes(): string[] {
  const out: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = base32Encode(randomBytes(8)).slice(0, 10);
    out.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return out;
}

function hashRecoveryCode(code: string): string {
  // Normalize: strip whitespace + dashes, uppercase. Users get a
  // dashed-uppercase display string but might paste differently;
  // we want all of `H7FQ4-K9PXR`, `h7fq4 k9pxr`, `H7FQ4K9PXR` etc
  // to hash identically.
  const norm = code.replace(/[\s-]/g, '').toUpperCase();
  return createHash('sha256').update(norm).digest('hex');
}

/** Store a fresh batch of recovery codes for a user, replacing any
    existing ones. Plaintexts are returned to the caller; only the
    sha256 hashes are written to the database. */
export async function persistRecoveryCodes(
  userId: bigint,
  plaintext: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, userId));
    if (plaintext.length === 0) return;
    await tx.insert(schema.userRecoveryCodes).values(
      plaintext.map((p) => ({
        userId,
        codeHash: hashRecoveryCode(p),
        usedAt: null,
      })),
    );
  });
}

/** Attempt to consume a recovery code. Returns true on success
    (and marks the row used so it can't be reused). */
export async function consumeRecoveryCode(userId: bigint, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  const rows = await db
    .update(schema.userRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.userRecoveryCodes.userId, userId),
        eq(schema.userRecoveryCodes.codeHash, hash),
        isNull(schema.userRecoveryCodes.usedAt),
      ),
    )
    .returning({ codeHash: schema.userRecoveryCodes.codeHash });
  return rows.length > 0;
}

/** Count remaining (unused) recovery codes for a user. Surfaced in
    settings so the user can see "3 codes left, regenerate?". */
export async function remainingRecoveryCodes(userId: bigint): Promise<number> {
  const r = await db
    .select({ codeHash: schema.userRecoveryCodes.codeHash })
    .from(schema.userRecoveryCodes)
    .where(
      and(
        eq(schema.userRecoveryCodes.userId, userId),
        isNull(schema.userRecoveryCodes.usedAt),
      ),
    );
  return r.length;
}

// ───────────────────────────────────────────────────────────────────────────
// Service-level: enroll, confirm, disable, challenge
// ───────────────────────────────────────────────────────────────────────────

/** Begin enrollment. Generates a secret, writes it to the user
    row but DOES NOT enable 2FA — the caller must follow up with
    `confirmEnrollment` after the user enters a valid code. Returns
    the secret + otpauth URI for QR display.

    Calling this when 2FA is already enabled is rejected; the user
    must disable first. Calling when a secret already exists but
    isn't enabled (interrupted setup) overwrites the secret. */
export async function beginEnrollment(opts: {
  userId: bigint;
  accountName: string;
  issuer: string;
}): Promise<{ secret: string; otpauthUri: string }> {
  const user = await db
    .select({ id: schema.users.id, totpEnabled: schema.users.totpEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, opts.userId))
    .limit(1);
  if (!user[0]) throw errors.notFound('User');
  if (user[0].totpEnabled) {
    throw errors.conflict('Two-factor authentication is already enabled');
  }
  const secret = generateSecret();
  await db
    .update(schema.users)
    .set({ totpSecret: encryptField(secret) })
    .where(eq(schema.users.id, opts.userId));
  return {
    secret,
    otpauthUri: buildOtpAuthUri({
      secret,
      accountName: opts.accountName,
      issuer: opts.issuer,
    }),
  };
}

/** Finish enrollment. Verifies a code against the pending secret,
    flips the enabled flag, generates and persists recovery codes,
    and returns the plaintext codes for the caller to display once. */
export async function confirmEnrollment(opts: {
  userId: bigint;
  code: string;
}): Promise<{ recoveryCodes: string[] }> {
  const user = await db
    .select({
      id: schema.users.id,
      totpSecret: schema.users.totpSecret,
      totpEnabled: schema.users.totpEnabled,
    })
    .from(schema.users)
    .where(eq(schema.users.id, opts.userId))
    .limit(1);
  if (!user[0]) throw errors.notFound('User');
  if (user[0].totpEnabled) {
    throw errors.conflict('Two-factor authentication is already enabled');
  }
  if (!user[0].totpSecret) {
    throw errors.badRequest('No enrollment in progress; call begin first');
  }
  const enrollStep = verifyTotpStep(decryptField(user[0].totpSecret), opts.code);
  if (enrollStep === null) {
    throw errors.badRequest('Invalid code');
  }
  const recoveryCodes = generateRecoveryCodes();
  await persistRecoveryCodes(opts.userId, recoveryCodes);
  await db
    .update(schema.users)
    // Seed totp_last_step with the enrollment step so this very code can't be
    // replayed at the first real login (single-use, same as verifyForLogin).
    .set({ totpEnabled: true, totpVerifiedAt: new Date(), totpLastStep: BigInt(enrollStep) })
    .where(eq(schema.users.id, opts.userId));
  // May unlock double_locked (passkey + 2FA). Best-effort, non-blocking.
  void import('./achievements')
    .then((m) => m.syncAndNotifyAchievements(opts.userId))
    .catch(() => {});
  return { recoveryCodes };
}

/** Disable 2FA. Requires a valid code (or recovery code) to
    prevent attackers with stolen session tokens from disabling.
    Clears the secret and recovery codes. */
export async function disable(opts: {
  userId: bigint;
  code: string;
}): Promise<void> {
  const user = await db
    .select({
      id: schema.users.id,
      totpSecret: schema.users.totpSecret,
      totpEnabled: schema.users.totpEnabled,
    })
    .from(schema.users)
    .where(eq(schema.users.id, opts.userId))
    .limit(1);
  if (!user[0] || !user[0].totpEnabled || !user[0].totpSecret) {
    throw errors.badRequest('Two-factor authentication is not enabled');
  }
  const codeOk =
    (await consumeTotpForUser(opts.userId, decryptField(user[0].totpSecret), opts.code)) ||
    (await consumeRecoveryCode(opts.userId, opts.code));
  if (!codeOk) throw errors.badRequest('Invalid code');
  await db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ totpEnabled: false, totpSecret: null, totpVerifiedAt: null })
      .where(eq(schema.users.id, opts.userId));
    await tx.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, opts.userId));
  });
}

/** Verify a TOTP or recovery code as part of the login flow. The
    caller has already verified password + identified the user;
    this is the second factor check. Returns true/false; record
    successful verification timestamp on success. */
export async function verifyForLogin(opts: {
  userId: bigint;
  code: string;
}): Promise<boolean> {
  const user = await db
    .select({
      totpSecret: schema.users.totpSecret,
      totpEnabled: schema.users.totpEnabled,
    })
    .from(schema.users)
    .where(eq(schema.users.id, opts.userId))
    .limit(1);
  if (!user[0] || !user[0].totpEnabled || !user[0].totpSecret) {
    return false;
  }
  const ok =
    (await consumeTotpForUser(opts.userId, decryptField(user[0].totpSecret), opts.code)) ||
    (await consumeRecoveryCode(opts.userId, opts.code));
  if (ok) {
    await db
      .update(schema.users)
      .set({ totpVerifiedAt: new Date() })
      .where(eq(schema.users.id, opts.userId));
  }
  return ok;
}
