import { describe, it, expect } from 'vitest';
import { ResumeBuffer } from '../src/gateway/resume';

describe('ResumeBuffer', () => {
  it('returns frames strictly after a seq, in order', () => {
    const b = new ResumeBuffer();
    b.append(1, '{"s":1}', 1000);
    b.append(2, '{"s":2}', 1001);
    b.append(3, '{"s":3}', 1002);
    expect(b.framesAfter(1)).toEqual(['{"s":2}', '{"s":3}']);
    expect(b.framesAfter(3)).toEqual([]);
    expect(b.firstSeq).toBe(1);
    expect(b.lastSeq).toBe(3);
  });

  it('canResume: caught up, behind-within-buffer, gap-too-large, client-ahead', () => {
    const b = new ResumeBuffer();
    b.append(5, 'a', 1000);
    b.append(6, 'b', 1001);
    b.append(7, 'c', 1002);
    const connSeq = 7;
    expect(b.canResume(7, connSeq)).toBe(true); // fully caught up, 0 replay
    expect(b.canResume(6, connSeq)).toBe(true); // behind by 1, in buffer
    expect(b.canResume(4, connSeq)).toBe(true); // exactly firstSeq-1
    expect(b.canResume(3, connSeq)).toBe(false); // before firstSeq-1 → gap too large
    expect(b.canResume(8, connSeq)).toBe(false); // client ahead of server → bogus
  });

  it('empty buffer can only resume a fully-caught-up client', () => {
    const b = new ResumeBuffer();
    expect(b.canResume(0, 0)).toBe(true);
    expect(b.canResume(0, 5)).toBe(false); // behind but nothing buffered
  });

  it('prunes by size (ring drops oldest)', () => {
    const b = new ResumeBuffer(3, 1_000_000);
    for (let i = 1; i <= 5; i++) b.append(i, `f${i}`, 1000 + i);
    expect(b.size).toBe(3);
    expect(b.firstSeq).toBe(3);
    expect(b.lastSeq).toBe(5);
    expect(b.framesAfter(2)).toEqual(['f3', 'f4', 'f5']);
    // The pruned prefix is now un-resumable.
    expect(b.canResume(1, 5)).toBe(false);
  });

  it('prunes by age', () => {
    const b = new ResumeBuffer(1000, 100); // 100ms window
    b.append(1, 'old', 1000);
    b.append(2, 'mid', 1050);
    b.append(3, 'new', 1200); // now=1200, cutoff=1100 → drops seq 1 (and 2? at 1050 < 1100 yes)
    expect(b.firstSeq).toBe(3);
    expect(b.framesAfter(0)).toEqual(['new']);
  });
});
