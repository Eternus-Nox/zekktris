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

const workerId = BigInt(env.WORKER_ID);
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
