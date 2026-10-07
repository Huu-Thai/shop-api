import { allocate, salableOf } from './allocation.js';

const s = (
  sourceId: string,
  quantity: number,
  reserved = 0,
  safetyStock = 0,
) => ({
  inventoryId: `i-${sourceId}`,
  sourceId,
  quantity,
  reserved,
  safetyStock,
});

describe('allocate', () => {
  it('fills from the first source, then the next', () => {
    expect(
      allocate([s('a', 3), s('b', 10)], 5)?.map((x) => [
        x.source.sourceId,
        x.quantity,
      ]),
    ).toEqual([
      ['a', 3],
      ['b', 2],
    ]);
    expect(allocate([s('a', 10)], 4)?.map((x) => x.quantity)).toEqual([4]);
  });

  it('respects reservations and safety stock, and refuses when short', () => {
    expect(salableOf(s('a', 10, 6, 2))).toBe(2);
    expect(salableOf(s('a', 1, 0, 5))).toBe(0);
    expect(
      allocate([s('a', 10, 6, 2), s('b', 1)], 3)?.map((x) => x.quantity),
    ).toEqual([2, 1]);
    expect(allocate([s('a', 10, 6, 2), s('b', 1)], 4)).toBeUndefined();
    expect(allocate([], 1)).toBeUndefined();
  });
});
