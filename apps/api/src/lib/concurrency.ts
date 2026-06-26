/**
 * Run a list of async tasks with at most `limit` in flight at once, resolving
 * when all have settled. Tasks must not reject (wrap your own try/catch) —
 * this runner is for best-effort fan-out (e.g. push delivery) where one
 * failure must not abort the batch.
 *
 * Why: an unbounded `Promise.all(items.map(...))` over a large audience (a
 * 10k-member @everyone) opens thousands of sockets at once, starving the
 * shared connection pool / event loop and, for the APNs HTTP/2 session,
 * exceeding the server's max-concurrent-streams. Bounding the in-flight count
 * keeps the burst flat without serializing.
 */
export async function runBounded(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  if (tasks.length === 0) return;
  const max = Math.max(1, Math.min(limit, tasks.length));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]!();
    }
  }
  await Promise.all(Array.from({ length: max }, () => worker()));
}

/** Default in-flight cap for push fan-out across all transports. */
export const PUSH_FANOUT_CONCURRENCY = 32;
