import { describe, it, expect } from 'vitest';
import { computeReorder } from '../src/lib/useChannelDragReorder';
import type { Channel } from '@zekktris/client';

// Minimal channel factory — computeReorder only reads id / type / position /
// parentId, so we build just those and cast to the full type.
function ch(
  id: string,
  position: number,
  parentId: string | null,
  type: 'guild_text' | 'guild_category' = 'guild_text',
): Channel {
  return { id, type, position, parentId } as unknown as Channel;
}

// A guild with one category (catA) holding c1,c2,c3 and one top-level
// channel t1.
const fixture = (): Channel[] => [
  ch('catA', 0, null, 'guild_category'),
  ch('c1', 0, 'catA'),
  ch('c2', 1, 'catA'),
  ch('c3', 2, 'catA'),
  ch('t1', 0, null),
];

const find = (
  changes: Array<{ id: string; position: number; parentId?: string | null }>,
  id: string,
) => changes.find((c) => c.id === id);

describe('computeReorder', () => {
  it('reorders within a category and emits the shifted positions', () => {
    // Move c3 to before c1 → new order c3, c1, c2.
    const changes = computeReorder(fixture(), {
      sourceId: 'c3',
      sourceKind: 'channel',
      targetId: 'c1',
      position: 'before',
    });
    expect(find(changes, 'c3')).toMatchObject({ id: 'c3', position: 0 });
    expect(find(changes, 'c1')).toMatchObject({ id: 'c1', position: 1 });
    expect(find(changes, 'c2')).toMatchObject({ id: 'c2', position: 2 });
    // Same parent throughout → no parentId in the diff.
    expect(changes.every((c) => c.parentId === undefined)).toBe(true);
  });

  it('reparents a channel to top-level and keeps the diff minimal', () => {
    // Drop c2 after the top-level channel t1 → c2 leaves catA for root.
    const changes = computeReorder(fixture(), {
      sourceId: 'c2',
      sourceKind: 'channel',
      targetId: 't1',
      position: 'after',
    });
    // c2 moved out: parentId becomes null, lands at index 1 under root.
    expect(find(changes, 'c2')).toMatchObject({ id: 'c2', position: 1, parentId: null });
    // c3 closes the gap left in catA (2 → 1), no parent change.
    expect(find(changes, 'c3')).toMatchObject({ id: 'c3', position: 1 });
    expect(find(changes, 'c3')?.parentId).toBeUndefined();
    // c1 (already at 0) and t1 (already at 0) are unchanged → omitted.
    expect(find(changes, 'c1')).toBeUndefined();
    expect(find(changes, 't1')).toBeUndefined();
  });

  it("drops a channel INTO a category, appending to its children", () => {
    // Drop t1 into catA → appended after c1,c2,c3 (index 3), reparented.
    const changes = computeReorder(fixture(), {
      sourceId: 't1',
      sourceKind: 'channel',
      targetId: 'catA',
      position: 'into',
    });
    expect(find(changes, 't1')).toMatchObject({ id: 't1', position: 3, parentId: 'catA' });
    // Existing children keep their positions → nothing else in the diff.
    expect(changes).toHaveLength(1);
  });

  it('returns an empty diff for a no-op move (already in place)', () => {
    // c1 is already first in catA; dropping it before c2 changes nothing.
    const changes = computeReorder(fixture(), {
      sourceId: 'c1',
      sourceKind: 'channel',
      targetId: 'c2',
      position: 'before',
    });
    expect(changes).toHaveLength(0);
  });
});
