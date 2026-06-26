import { describe, it, expect } from 'vitest';
import { runBounded } from '../src/lib/concurrency';

// Pure (no DB) — backs the bounded push fan-out.
describe('runBounded', () => {
  it('runs every task exactly once', async () => {
    const seen: number[] = [];
    const tasks = Array.from({ length: 50 }, (_, i) => async () => {
      seen.push(i);
    });
    await runBounded(tasks, 8);
    expect(seen.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
  });

  it('never exceeds the concurrency limit, yet does run concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 40 }, () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    await runBounded(tasks, 6);
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });

  it('no-ops on empty input', async () => {
    await expect(runBounded([], 4)).resolves.toBeUndefined();
  });

  it('caps workers at the task count when limit exceeds it', async () => {
    let peak = 0;
    let inFlight = 0;
    const tasks = Array.from({ length: 3 }, () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    });
    await runBounded(tasks, 100);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
