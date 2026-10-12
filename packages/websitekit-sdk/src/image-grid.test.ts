import { describe, expect, it } from 'vitest';

import { FULL_PRICE_BPS, MAX_ZONES, blockError, buyError, gridOf, layoutProblem, occupancy, quote, squarePrice, type Zone } from './image-grid';

/**
 * The boundaries, stated where a reader can see them. Agreement with the contract is
 * `image-grid.vectors.test.ts`; this file is what the rule IS, at its edges.
 */
describe('gridOf', () => {
  it('is whole cells from the top-left', () => {
    expect(gridOf(300, 671, 10)).toEqual({ cols: 30, rows: 67 });
    expect(gridOf(300, 671, 15)).toEqual({ cols: 20, rows: 44 });
    expect(gridOf(19, 19, 10)).toEqual({ cols: 1, rows: 1 });
  });

  it('refuses a cell size that is not 10, 15 or 20', () => {
    expect(gridOf(300, 300, 12)).toEqual({ error: 'InvalidConfig' });
    expect(gridOf(300, 300, 5)).toEqual({ error: 'InvalidConfig' });
  });

  it('allows 256 across and 1,000 down, and not one more', () => {
    expect(gridOf(2569, 10_009, 10)).toEqual({ cols: 256, rows: 1_000 });
    expect(gridOf(2570, 100, 10)).toEqual({ error: 'InvalidConfig' });
    expect(gridOf(100, 10_010, 10)).toEqual({ error: 'InvalidConfig' });
  });

  it('refuses an image smaller than one cell', () => {
    expect(gridOf(9, 100, 10)).toEqual({ error: 'InvalidConfig' });
    expect(gridOf(100, 9, 10)).toEqual({ error: 'InvalidConfig' });
  });

  it('refuses dimensions no uint32 could carry', () => {
    expect(gridOf(100.5, 100, 10)).toEqual({ error: 'InvalidConfig' });
    expect(gridOf(-100, 100, 10)).toEqual({ error: 'InvalidConfig' });
  });
});

describe('blockError', () => {
  const grid = { cols: 30, rows: 67 };
  const taken = occupancy([{ col: 10, row: 10, cols: 3, rows: 3 }]);

  it('checks empty, then outside, then taken — the contract’s order', () => {
    // Empty AND outside: empty wins.
    expect(blockError(grid, taken, { col: 40, row: 0, cols: 0, rows: 1 })).toBe('EmptyBlock');
    // Outside AND overlapping: outside wins.
    expect(blockError(grid, taken, { col: 10, row: 10, cols: 30, rows: 1 })).toBe('OutsideGrid');
  });

  it('allows a block flush with the edge and refuses one cell past it', () => {
    expect(blockError(grid, taken, { col: 28, row: 66, cols: 2, rows: 1 })).toBe('none');
    expect(blockError(grid, taken, { col: 29, row: 0, cols: 2, rows: 1 })).toBe('OutsideGrid');
    expect(blockError(grid, taken, { col: 0, row: 66, cols: 1, rows: 2 })).toBe('OutsideGrid');
  });

  it('refuses one shared corner cell and allows touching edges', () => {
    expect(blockError(grid, taken, { col: 12, row: 12, cols: 3, rows: 3 })).toBe('CellsTaken');
    expect(blockError(grid, taken, { col: 13, row: 10, cols: 2, rows: 3 })).toBe('none');
    expect(blockError(grid, taken, { col: 10, row: 13, cols: 3, rows: 2 })).toBe('none');
  });

  it('builds a 256-wide row as every bit of the word', () => {
    const wide = occupancy([{ col: 0, row: 0, cols: 256, rows: 1 }]);
    expect(wide.get(0)).toBe((1n << 256n) - 1n);
    expect(blockError({ cols: 256, rows: 2 }, wide, { col: 255, row: 0, cols: 1, rows: 1 })).toBe('CellsTaken');
    expect(blockError({ cols: 256, rows: 2 }, wide, { col: 0, row: 1, cols: 256, rows: 1 })).toBe('none');
  });

  it('merges blocks that share a row', () => {
    const two = occupancy([
      { col: 0, row: 0, cols: 2, rows: 1 },
      { col: 4, row: 0, cols: 1, rows: 2 },
    ]);
    expect(two.get(0)).toBe(0b10011n);
    expect(two.get(1)).toBe(0b10000n);
    expect(two.has(2)).toBe(false);
  });
});

describe('quote', () => {
  it('is cells times the cell price on a board with no zones', () => {
    expect(quote({ col: 5, row: 7, cols: 3, rows: 4 }, 10_003n, [], FULL_PRICE_BPS)).toBe(120_036n);
  });

  it('prices each cell at its zone', () => {
    const zones: Zone[] = [{ col: 10, row: 10, cols: 5, rows: 5, cellPrice: 30_011n }];
    // Columns 8, 9 outside, column 10 inside.
    expect(quote({ col: 8, row: 10, cols: 3, rows: 1 }, 10_003n, zones, FULL_PRICE_BPS)).toBe(2n * 10_003n + 30_011n);
  });

  it('scales the whole block by the board\'s share, rounding up', () => {
    // 10,003 at half is 5,001.5: one square charges 5,002, two exactly 10,003 — not 2 × 5,002.
    expect(quote({ col: 0, row: 0, cols: 1, rows: 1 }, 10_003n, [], 5_000)).toBe(5_002n);
    expect(quote({ col: 0, row: 0, cols: 2, rows: 1 }, 10_003n, [], 5_000)).toBe(10_003n);
    expect(squarePrice(10_003n, 5_000)).toBe(5_002n);
  });

  it('never makes a square free', () => {
    expect(quote({ col: 0, row: 0, cols: 1, rows: 1 }, 1n, [], 1)).toBe(1n);
    expect(squarePrice(1n, 1)).toBe(1n);
  });
});

describe('buyError', () => {
  const grid = { cols: 12, rows: 10 };
  const taken = occupancy([{ col: 2, row: 2, cols: 3, rows: 2 }]);

  it('refuses an empty list', () => {
    expect(buyError(grid, taken, [])).toBe('EmptyBlock');
  });

  it('takes rectangles that touch, and refuses ones that share a cell', () => {
    expect(buyError(grid, taken, [{ col: 0, row: 0, cols: 2, rows: 2 }, { col: 2, row: 0, cols: 2, rows: 2 }])).toBe('none');
    expect(buyError(grid, taken, [{ col: 0, row: 0, cols: 2, rows: 2 }, { col: 1, row: 1, cols: 2, rows: 1 }])).toBe('CellsTaken');
  });

  it('names the first bad rectangle, in order', () => {
    const sold = { col: 4, row: 3, cols: 1, rows: 1 };
    const outside = { col: 20, row: 0, cols: 1, rows: 1 };
    expect(buyError(grid, taken, [sold, outside])).toBe('CellsTaken');
    expect(buyError(grid, taken, [outside, sold])).toBe('OutsideGrid');
  });
});

describe('layoutProblem', () => {
  const grid = { cols: 256, rows: 1_000 };
  const zone = (row: number): Zone => ({ col: 0, row, cols: 1, rows: 1, cellPrice: 1n });

  it('accepts the most zones the chain allows and refuses one more', () => {
    const most = Array.from({ length: MAX_ZONES }, (_, i) => zone(i));
    expect(layoutProblem(grid, most, [])).toBeNull();
    expect(layoutProblem(grid, [...most, zone(MAX_ZONES)], [])).toEqual({ problem: 'too-many-zones', index: MAX_ZONES });
  });

  it('names the zone or kept block at fault', () => {
    expect(layoutProblem(grid, [zone(0), zone(1), zone(1)], [])).toEqual({ problem: 'zones-overlap', index: 2 });
    const kept = [
      { col: 0, row: 0, cols: 2, rows: 2 },
      { col: 1, row: 1, cols: 1, rows: 1 },
    ];
    expect(layoutProblem(grid, [], kept)).toEqual({ problem: 'kept-overlap', index: 1 });
  });
});
