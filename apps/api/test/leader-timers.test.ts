import { describe, it, expect, vi, afterEach } from 'vitest';

// Drive leadership from the test: the timers must consult isLeader() at FIRE
// time, for the leading boot run exactly as for the interval.
let leader = true;
vi.mock('../src/cluster', () => ({ isLeader: () => leader }));

const { leaderInterval, leaderTimeout } = await import('../src/lib/leaderTimers');

describe('leader-gated sweep timers', () => {
  afterEach(() => {
    vi.useRealTimers();
    leader = true;
  });

  it('leaderTimeout skips the leading boot run on a non-leader replica', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    leader = false;
    leaderTimeout(fn, 1000);
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('leaderTimeout runs on the leader, checked when the timer fires', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    leader = false;
    leaderTimeout(fn, 1000);
    leader = true; // won the election before the leading run fired
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('leaderInterval only ticks while leader', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = leaderInterval(fn, 1000);
    vi.advanceTimersByTime(1000);
    leader = false;
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
    clearInterval(t);
  });
});
