/**
 * Snowflake IDs
 * -------------
 * 64-bit IDs structured as Discord/Twitter-style snowflakes:
 *
 *   ┌─ 1 bit unused (always 0; keeps value positive)
 *   │   ┌─── 41 bits of milliseconds since EPOCH
 *   │   │                                               ┌── 10 bits worker id
 *   │   │                                               │            ┌── 12 bits sequence
 *   ▼   ▼                                               ▼            ▼
 *   0 | tttttttttttttttttttttttttttttttttttttttttt | wwwwwwwwww | ssssssssssss
 *
 * That gives:
 *   - timestamp range: 2^41 ms ≈ 69 years from EPOCH
 *   - 1024 worker IDs per cluster
 *   - 4096 IDs per worker per millisecond
 *
 * Worker ID is set per API instance via env var. Generation lives in the API
 * package so the worker counter and clock-drift handling stay in one place;
 * this file only exposes the constants and a decoder both client and server
 * can use to display "created at" times.
 */

/** January 1, 2024, 00:00:00 UTC. */
export const SNOWFLAKE_EPOCH_MS = 1704067200000;

export const TIMESTAMP_BITS = 41n;
export const WORKER_BITS = 10n;
export const SEQUENCE_BITS = 12n;

export const WORKER_SHIFT = SEQUENCE_BITS; // 12
export const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_BITS; // 22

export const WORKER_MASK = (1n << WORKER_BITS) - 1n;
export const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n;
export const MAX_WORKER_ID = WORKER_MASK; // 1023

/** True if the string looks like a valid snowflake. Used in input validation. */
export function isSnowflake(value: string): boolean {
  if (!/^\d{1,20}$/.test(value)) return false;
  try {
    const big = BigInt(value);
    return big >= 0n && big < 1n << 63n;
  } catch {
    return false;
  }
}
