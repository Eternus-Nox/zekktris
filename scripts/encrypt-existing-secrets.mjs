#!/usr/bin/env node
/**
 * Backfill: encrypt existing plaintext secrets at rest
 * ----------------------------------------------------
 * One-time (idempotent) migration that encrypts any TOTP secrets and bot
 * event-signing secrets that were stored as plaintext BEFORE
 * FIELD_ENCRYPTION_KEY was set. New writes are already encrypted by the
 * app; this catches rows written earlier.
 *
 * It uses the SAME enc:v1 AES-256-GCM envelope as
 * apps/api/src/lib/fieldCrypto.ts, so the app decrypts the results
 * transparently. Rows already in enc:v1 form are skipped, so it's safe to
 * run repeatedly.
 *
 * Usage (from the repo root, with the api's env available):
 *
 *   DATABASE_URL=postgres://...  FIELD_ENCRYPTION_KEY=<hex-or-base64> \
 *     node scripts/encrypt-existing-secrets.mjs [--dry-run]
 *
 * Run it ONCE after you first set FIELD_ENCRYPTION_KEY. Take a database
 * backup first. If you ever rotate the key, this script does NOT
 * re-encrypt enc:v1 rows under a new key — that needs a dedicated rotation
 * step (decrypt with old key, encrypt with new).
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

const DRY_RUN = process.argv.includes('--dry-run');

const databaseUrl = process.env.DATABASE_URL;
const rawKey = process.env.FIELD_ENCRYPTION_KEY;

if (!databaseUrl) {
  console.error('✗ DATABASE_URL is required.');
  process.exit(1);
}
if (!rawKey) {
  console.error('✗ FIELD_ENCRYPTION_KEY is required (the key the app will decrypt with).');
  process.exit(1);
}

function decodeKey(raw) {
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`FIELD_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${buf.length})`);
  }
  return buf;
}

const key = decodeKey(rawKey);

function encryptField(plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

const sql = postgres(databaseUrl, { max: 1 });

async function backfillColumn(column, label) {
  // Pull rows whose value is non-null and not already encrypted.
  const rows = await sql`
    SELECT id, ${sql(column)} AS val
    FROM users
    WHERE ${sql(column)} IS NOT NULL
      AND ${sql(column)} NOT LIKE ${PREFIX + '%'}
  `;
  if (rows.length === 0) {
    console.log(`• ${label}: nothing to encrypt (all rows already encrypted or empty).`);
    return 0;
  }
  console.log(`• ${label}: ${rows.length} plaintext row(s) to encrypt${DRY_RUN ? ' (dry run)' : ''}.`);
  if (DRY_RUN) return rows.length;

  let done = 0;
  for (const row of rows) {
    const enc = encryptField(row.val);
    await sql`UPDATE users SET ${sql(column)} = ${enc} WHERE id = ${row.id}`;
    done += 1;
  }
  console.log(`  ✓ ${label}: encrypted ${done} row(s).`);
  return done;
}

try {
  await backfillColumn('totp_secret', 'TOTP secrets');
  await backfillColumn('bot_event_secret', 'Bot event secrets');
  console.log(DRY_RUN ? 'Dry run complete — no changes written.' : 'Backfill complete.');
} catch (err) {
  console.error('✗ Backfill failed:', err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
