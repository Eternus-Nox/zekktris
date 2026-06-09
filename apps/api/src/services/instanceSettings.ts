/**
 * Instance settings (runtime key/value)
 * -------------------------------------
 * Thin accessor over the `instance_settings` table — instance-wide config an
 * admin can change at runtime without a redeploy (vs env, which is fixed at
 * boot). Values are stored as text; the absence of a row means "fall back to
 * the env/default". Used by the OIDC/SSO config (and open to other runtime
 * settings later).
 */

import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: schema.instanceSettings.value })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

/** Fetch many keys at once. Returns every requested key (null when absent). */
export async function getSettings(keys: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = null;
  if (keys.length === 0) return out;
  const rows = await db
    .select()
    .from(schema.instanceSettings)
    .where(inArray(schema.instanceSettings.key, keys));
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Upsert a setting. Pass null to store an explicit null (e.g. cleared). */
export async function setSetting(key: string, value: string | null): Promise<void> {
  await db
    .insert(schema.instanceSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.instanceSettings.key,
      set: { value, updatedAt: new Date() },
    });
}
