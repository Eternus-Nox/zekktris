/**
 * Snowflake generator
 * -------------------
 * Produces 64-bit IDs in Twitter/Discord layout. The decoded layout (epoch,
 * worker bits, sequence bits) lives in `@zekktris/shared/snowflake` so the
 * client can decode IDs without depending on the server.
 *
 * One generator per process. Multiple processes (replicas) coordinate by
 * each having a unique WORKER_ID env var. With 10 worker bits you can run up
 * to 1024 replicas before IDs collide.
 *
 * Within a single millisecond a single worker can produce up to 4096 IDs
 * (12 sequence bits). If you exceed that (you won't), generation spin-waits
 * to the next millisecond.
 */

import {
  SNOWFLAKE_EPOCH_MS,
  TIMESTAMP_SHIFT,
  WORKER_SHIFT,
  SEQUENCE_MASK,
  MAX_WORKER_ID,
} from '@zekktris/shared/snowflake';
import { env } from './env';
import { log } from './log';

if (env.WORKER_ID < 0 || BigInt(env.WORKER_ID) > MAX_WORKER_ID) {
  // env.ts already bounds 0..1023, this is belt-and-suspenders.
  throw new Error(`WORKER_ID out of range: ${env.WORKER_ID}`);
}

let workerId = BigInt(env.WORKER_ID);
/** Latched by the first generated id — see setWorkerId. */
let issued = false;

/**
 * Set this process's worker id, once, before any id is generated.
 *
 * The env var alone cannot do this job under `docker compose --scale`: one
 * `WORKER_ID` is declared for the whole service, so every replica would be
 * worker 0 and mint COLLIDING ids. `cluster.ts` leases a distinct slot per
 * process and calls this before the startup checks run.
 *
 * Changing the worker id after ids exist would let this process re-issue
 * timestamps another worker has already used, so that is refused rather than
 * silently honoured.
 */
export function setWorkerId(id: number): void {
  if (issued) {
    throw new Error('setWorkerId called after ids were already generated');
  }
  if (id < 0 || BigInt(id) > MAX_WORKER_ID) {
    throw new Error(`WORKER_ID out of range: ${id}`);
  }
  workerId = BigInt(id);
}
let lastTimestamp = -1n;
let sequence = 0n;

function currentMs(): bigint {
  return BigInt(Date.now());
}

function waitNextMs(after: bigint): bigint {
  let now = currentMs();
  while (now <= after) {
    now = currentMs();
  }
  return now;
}

/**
 * Generate the next snowflake.
 *
 * Returns a bigint. Serialize to string (snowflake.toString()) when sending
 * to clients — JSON cannot represent bigints natively and we want to avoid
 * float precision loss above 2^53.
 */
export function nextSnowflake(): bigint {
  issued = true;
  let now = currentMs();

  if (now < lastTimestamp) {
    // Clock went backwards (NTP step, system suspend, etc). Don't issue an ID
    // that's older than one we already issued.
    log.warn('clock drift detected, waiting', {
      lastTimestamp: lastTimestamp.toString(),
      now: now.toString(),
    });
    now = waitNextMs(lastTimestamp);
  }

  if (now === lastTimestamp) {
    sequence = (sequence + 1n) & SEQUENCE_MASK;
    if (sequence === 0n) {
      // Sequence exhausted for this ms; wait for the next ms.
      now = waitNextMs(lastTimestamp);
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = now;

  const tsPart = (now - BigInt(SNOWFLAKE_EPOCH_MS)) << TIMESTAMP_SHIFT;
  const workerPart = workerId << WORKER_SHIFT;
  return tsPart | workerPart | sequence;
}

/**
 * The smallest snowflake that could have been generated at `date` (worker and
 * sequence bits zeroed). Any id created at/after `date` is >= this value, so
 * `id >= minSnowflakeForDate(joinedAt)` is an index-friendly lower bound for
 * "messages since the member joined" — no created_at scan, and it bounds the
 * (channel_id, id) index range so a new member's channel load doesn't page
 * through the whole backlog. Clamped at the epoch so a pre-epoch date (can't
 * happen in practice) yields 0 (matches everything) rather than a negative id.
 */
export function minSnowflakeForDate(date: Date): bigint {
  const ms = Math.max(date.getTime(), SNOWFLAKE_EPOCH_MS);
  return (BigInt(ms) - BigInt(SNOWFLAKE_EPOCH_MS)) << TIMESTAMP_SHIFT;
}
