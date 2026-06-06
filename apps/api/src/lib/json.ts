/**
 * JSON helpers
 * ------------
 * The DB returns rows with `id: bigint` and `permissions: bigint`. JSON has
 * no native bigint type, and `Number(big)` loses precision above 2^53. The
 * Discord-style fix is to serialize bigints as decimal strings on the wire.
 *
 * Use these helpers (or the typed DTOs in lib/dto.ts) at every boundary
 * between the DB and an HTTP response. Don't `JSON.stringify` raw rows.
 */

/** Convert a value to its wire form: bigint -> decimal string, null -> null. */
export function bigintStr(v: bigint): string;
export function bigintStr(v: bigint | null): string | null;
export function bigintStr(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}

/** Serialize a Date to ISO 8601 (UTC). */
export function isoDate(d: Date): string;
export function isoDate(d: Date | null): string | null;
export function isoDate(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}
