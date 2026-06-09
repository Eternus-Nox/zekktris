/**
 * Re-encrypt field-encrypted columns under the current primary key.
 * ----------------------------------------------------------------
 * Field-encrypted columns today: users.totp_secret (2FA) and
 * users.bot_event_secret (bot event-signing). Both live on `users`.
 *
 * Use this during key rotation, or to backfill after first setting a key:
 *
 *   1. Move the current FIELD_ENCRYPTION_KEY into FIELD_ENCRYPTION_KEYS_OLD.
 *   2. Set a freshly generated FIELD_ENCRYPTION_KEY (openssl rand -hex 32).
 *   3. Deploy. Everything still decrypts (primary fails, old key verifies).
 *   4. Run this script:  pnpm --filter @zekktris/api reencrypt-fields
 *      It rewrites every value still under an old key (or legacy plaintext)
 *      so it's encrypted under the new primary.
 *   5. Once it reports failed=0 and a re-run reports updated=0, drop the old
 *      key from FIELD_ENCRYPTION_KEYS_OLD and deploy again.
 *
 * Idempotent + re-runnable: values already under the primary key are skipped
 * (reencryptToPrimary returns null), so a second run updates nothing. A value
 * that can't be decrypted with ANY configured key is left untouched and
 * reported (the script exits non-zero) — never silently dropped.
 */

import { eq, isNotNull, or } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { db, schema, closeDb } from '../src/db';
import { reencryptToPrimary, isFieldEncryptionEnabled } from '../src/lib/fieldCrypto';

export interface ReencryptStats {
  scanned: number;
  updated: number;
  totp: number;
  bot: number;
  failures: Array<{ id: string; error: string }>;
}

/**
 * Walk the field-encrypted columns and re-encrypt anything not already under
 * the primary key. Pure of process exit / logging so it's unit-testable.
 */
export async function reencryptAllFields(): Promise<ReencryptStats> {
  const rows = await db
    .select({
      id: schema.users.id,
      totpSecret: schema.users.totpSecret,
      botEventSecret: schema.users.botEventSecret,
    })
    .from(schema.users)
    .where(or(isNotNull(schema.users.totpSecret), isNotNull(schema.users.botEventSecret)));

  const stats: ReencryptStats = { scanned: 0, updated: 0, totp: 0, bot: 0, failures: [] };

  for (const row of rows) {
    stats.scanned++;
    const patch: { totpSecret?: string; botEventSecret?: string } = {};
    try {
      if (row.totpSecret) {
        const next = reencryptToPrimary(row.totpSecret);
        if (next !== null) {
          patch.totpSecret = next;
          stats.totp++;
        }
      }
      if (row.botEventSecret) {
        const next = reencryptToPrimary(row.botEventSecret);
        if (next !== null) {
          patch.botEventSecret = next;
          stats.bot++;
        }
      }
    } catch (err) {
      // Decryptable with no configured key — leave the row alone so no data is
      // lost; report it so the operator can add the missing old key and re-run.
      stats.failures.push({ id: row.id.toString(), error: (err as Error).message });
      continue;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(schema.users).set(patch).where(eq(schema.users.id, row.id));
      stats.updated++;
    }
  }

  return stats;
}

async function main(): Promise<void> {
  if (!isFieldEncryptionEnabled()) {
    // eslint-disable-next-line no-console
    console.error(
      'FIELD_ENCRYPTION_KEY is not set — nothing to re-encrypt. Set the primary key first.',
    );
    process.exitCode = 1;
    return;
  }
  const stats = await reencryptAllFields();
  // eslint-disable-next-line no-console
  console.log(
    `re-encrypt complete: scanned ${stats.scanned} user(s), updated ${stats.updated} ` +
      `(totp ${stats.totp}, bot ${stats.bot}), failed ${stats.failures.length}.`,
  );
  if (stats.failures.length > 0) {
    for (const f of stats.failures) {
      // eslint-disable-next-line no-console
      console.error(`  user ${f.id}: ${f.error}`);
    }
    // eslint-disable-next-line no-console
    console.error(
      'Some rows could not be decrypted with any configured key. Add the ' +
        'original key to FIELD_ENCRYPTION_KEYS_OLD and re-run.',
    );
    process.exitCode = 1;
  }
}

// Only auto-run when invoked directly (`tsx scripts/reencrypt-fields.ts`), not
// when imported by a test.
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
