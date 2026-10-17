/**
 * Leader-gated timers
 * -------------------
 * Timers for GLOBAL background work (the sweeps scheduled in index.ts): work
 * that mutates shared state and must therefore happen ONCE across the cluster,
 * not once per replica.
 */

import { isLeader } from '../cluster';

/**
 * setInterval for GLOBAL background work — work that mutates shared state and
 * must therefore happen ONCE across the cluster, not once per replica.
 *
 * Several of the sweeps in index.ts delete rows; running them concurrently on
 * three replicas is how data goes missing. `isLeader()` is a synchronous field read
 * (see cluster.ts) so this costs nothing, and it returns true unconditionally
 * on a single instance, leaving today's behaviour untouched.
 *
 * NOT for per-process housekeeping — an in-memory cache sweep has to run in
 * every process that owns a cache. Those keep using plain setInterval.
 */
export function leaderInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!isLeader()) return;
    fn();
  }, ms);
}

/**
 * setTimeout counterpart of leaderInterval, for a global sweep's leading
 * "first run after boot". Gated the same way: otherwise every replica runs
 * the sweep a few minutes after it boots (i.e. on every rolling deploy),
 * which is exactly the concurrent run leaderInterval exists to prevent. A
 * non-leader skips it; the leader's own interval covers the work.
 */
export function leaderTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (!isLeader()) return;
    fn();
  }, ms);
}
