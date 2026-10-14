import { describe, expect, it } from 'vitest';

import {
  FULL_PRICE_BPS,
  MAX_WORDS_PER_BUY,
  MAX_ZONES,
  RefusedBuyError,
  blockError,
  buyError,
  cellMapFromBlocks,
  cellMapOf,
  emptyCells,
  gridOf,
  idAt,
  layoutProblem,
  paint,
  quote,
  quoteBlocks,
  quoteRect,
  squarePrice,
  termsError,
  wordsOf,
  type GridState,
  type Holding,
  type Rect,
  type TakeTerms,
  type Zone,
} from './image-grid';

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

const A = '0x00000000000000000000000000000000000a11ce';
const B = '0x0000000000000000000000000000000000000b0b';
const CREATOR = '0x0000000000000000000000000000000000005e11';
const HOUR = 3_600n;
const WEEK = 604_800n;
const T0 = 1_000_000n;
const STANDARD: TakeTerms = { takeBps: 14_000, payoutBps: 11_500, reversionBps: 9_700, maxReversionWeeks: 52, cooldownSecs: 3_600 };

/** A 30 × 67 board at 10,003 a square, as the contract's take tests use, with these blocks painted in order. */
function board(blocks: { rect: Rect; owner: string; level?: bigint; at?: bigint }[] = [], over: Partial<GridState> = {}): GridState {
  const grid = over.grid ?? { cols: 30, rows: 67 };
  const cells = emptyCells(grid);
  const held = new Map<number, Holding>();
  blocks.forEach((b, i) => {
    paint(cells, grid, b.rect, i + 1);
    held.set(i + 1, { owner: b.owner, level: b.level ?? 10_000n, boughtAt: b.at ?? T0 });
  });
  return {
    grid,
    cellPrice: 10_003n,
    zones: [],
    priceBps: FULL_PRICE_BPS,
    terms: STANDARD,
    creator: CREATOR,
    keptCount: 0,
    cells,
    blocks: held,
    ...over,
  };
}
const at = (col: number, row: number, cols = 1, rows = 1): Rect => ({ col, row, cols, rows });

describe('the cell map', () => {
  it('reads a block id from each 32-bit lane of the words `cellRow` returns', () => {
    const grid = { cols: 10, rows: 1 };
    const word0 = (7n << 0n) | (9n << 32n) | (0xffffffffn << 224n);
    const cells = cellMapOf(grid, [[word0, 5n << 32n]]);
    expect([...cells]).toEqual([7, 9, 0, 0, 0, 0, 0, 0xffffffff, 0, 5]);
  });

  it('refuses a row count that is not the grid\'s', () => {
    expect(() => cellMapOf({ cols: 8, rows: 2 }, [[0n]])).toThrow(/rows/);
  });

  it('paints the blocks in id order, whatever order they are given in', () => {
    const grid = { cols: 3, rows: 1 };
    const cells = cellMapFromBlocks(grid, [
      { tokenId: 2n, col: 1, row: 0, cols: 2, rows: 1 },
      { tokenId: 1n, col: 0, row: 0, cols: 3, rows: 1 },
    ]);
    expect([...cells]).toEqual([1, 2, 2]);
  });

  it('paints over what is there, as a take does', () => {
    const grid = { cols: 4, rows: 2 };
    const cells = emptyCells(grid);
    paint(cells, grid, at(0, 0, 3, 2), 1);
    paint(cells, grid, at(1, 1, 3, 1), 2);
    expect([...cells]).toEqual([1, 1, 1, 0, 1, 2, 2, 2]);
    expect(idAt(cells, grid, 3, 1)).toBe(2);
  });
});

describe('wordsOf', () => {
  it('counts the words a row spans, times its rows', () => {
    expect(wordsOf(at(0, 0, 8, 1))).toBe(1);
    expect(wordsOf(at(7, 0, 2, 1))).toBe(2);
    expect(wordsOf(at(1, 0, 8, 3))).toBe(6);
    expect(wordsOf(at(0, 0, 256, 16))).toBe(MAX_WORDS_PER_BUY);
    expect(wordsOf(at(0, 0, 1, 512))).toBe(MAX_WORDS_PER_BUY);
  });
});

describe('buyError', () => {
  it('checks empty, then outside, then sharing a cell, then size — the contract\'s order', () => {
    const s = board();
    expect(buyError(s, [], T0)).toBe('EmptyBlock');
    expect(blockError(s, { col: 40, row: 0, cols: 0, rows: 1 }, T0)).toBe('EmptyBlock');
    expect(blockError(s, at(29, 0, 2, 1), T0)).toBe('OutsideGrid');
    expect(blockError(s, at(28, 66, 2, 1), T0)).toBe('none');
    expect(buyError(s, [at(0, 0, 2, 2), at(2, 0, 2, 2)], T0)).toBe('none');
    expect(buyError(s, [at(0, 0, 2, 2), at(1, 1, 2, 1)], T0)).toBe('CellsTaken');
  });

  it('allows 512 words in a buy and refuses one more, across its rectangles', () => {
    const s = board([], { grid: { cols: 256, rows: 600 } });
    expect(blockError(s, at(0, 0, 256, 16), T0)).toBe('none');
    expect(blockError(s, at(0, 0, 256, 17), T0)).toBe('TooLarge');
    expect(blockError(s, at(0, 0, 1, 512), T0)).toBe('none');
    expect(blockError(s, at(0, 0, 1, 513), T0)).toBe('TooLarge');
    // 8 wide, but straddling two words: 2 a row.
    expect(blockError(s, at(4, 0, 8, 256), T0)).toBe('none');
    expect(blockError(s, at(4, 0, 8, 257), T0)).toBe('TooLarge');
    expect(buyError(s, [at(0, 0, 256, 8), at(0, 8, 256, 8)], T0)).toBe('none');
    expect(buyError(s, [at(0, 0, 256, 8), at(0, 8, 256, 8), at(0, 16, 1, 1)], T0)).toBe('TooLarge');
  });

  it('refuses a cell still in its cooldown, and allows it the second the cooldown ends', () => {
    const s = board([{ rect: at(0, 0), owner: A }]);
    expect(blockError(s, at(0, 0), T0 + HOUR - 1n)).toBe('CoolingDown');
    expect(blockError(s, at(0, 0), T0 + HOUR)).toBe('none');
  });

  it('refuses a kept block while the creator owns it, and only then', () => {
    const kept = board([{ rect: at(1, 1, 2, 2), owner: CREATOR }], { keptCount: 1 });
    expect(blockError(kept, at(1, 1), T0 + WEEK)).toBe('CellsKept');
    const given = board([{ rect: at(1, 1, 2, 2), owner: A }], { keptCount: 1 });
    expect(blockError(given, at(1, 1), T0 + WEEK)).toBe('none');
    // The creator's own block, bought rather than kept, is an ordinary block.
    const bought = board([{ rect: at(1, 1, 2, 2), owner: CREATOR }], { keptCount: 0 });
    expect(blockError(bought, at(1, 1), T0 + WEEK)).toBe('none');
    // An address in another case is the same address.
    const shouted = board([{ rect: at(1, 1, 2, 2), owner: CREATOR.toUpperCase().replace('0X', '0x') }], { keptCount: 1 });
    expect(blockError(shouted, at(1, 1), T0 + WEEK)).toBe('CellsKept');
  });

  it('refuses a kept block as kept in its first hour, when it is also cooling', () => {
    const s = board([{ rect: at(1, 1, 2, 2), owner: CREATOR }], { keptCount: 1 });
    expect(blockError(s, at(1, 1), T0)).toBe('CellsKept');
  });

  it('checks a rectangle that shares a cell before counting its words', () => {
    const s = board([], { grid: { cols: 256, rows: 40 } });
    expect(buyError(s, [at(0, 0, 256, 16), at(0, 0, 1, 1)], T0)).toBe('CellsTaken');
  });

  it('names the first block it meets row by row that refuses', () => {
    const cooling = { rect: at(0, 0), owner: A, at: T0 + WEEK };
    const kept = { rect: at(1, 0), owner: CREATOR };
    expect(blockError(board([kept, cooling], { keptCount: 1 }), at(0, 0, 2, 1), T0 + WEEK)).toBe('CoolingDown');
    const keptFirst = { rect: at(0, 0), owner: CREATOR };
    const coolingSecond = { rect: at(1, 0), owner: A, at: T0 + WEEK };
    expect(blockError(board([keptFirst, coolingSecond], { keptCount: 1 }), at(0, 0, 2, 1), T0 + WEEK)).toBe('CellsKept');
  });

  it('allows taking from 128 blocks in a buy and refuses one more, counted per rectangle', () => {
    const grid = { cols: 256, rows: 2 };
    const ones = Array.from({ length: 130 }, (_, i) => ({ rect: at(i, 0), owner: A }));
    const s = board(ones, { grid });
    const later = T0 + HOUR;
    expect(blockError(s, at(0, 0, 128, 1), later)).toBe('none');
    expect(blockError(s, at(0, 0, 129, 1), later)).toBe('TooManyBlocks');
    expect(buyError(s, [at(0, 0, 64, 1), at(64, 0, 64, 1)], later)).toBe('none');
    expect(buyError(s, [at(0, 0, 64, 1), at(64, 0, 65, 1)], later)).toBe('TooManyBlocks');
    expect(buyError(s, [at(0, 0, 43, 1), at(43, 0, 43, 1), at(86, 0, 43, 1)], later)).toBe('TooManyBlocks');
    expect(buyError(s, [at(0, 0, 43, 1), at(43, 0, 43, 1), at(86, 0, 42, 1)], later)).toBe('none');
    // Free cells count for nothing.
    expect(blockError(s, at(0, 0, 128, 2), later)).toBe('none');
  });
});

describe('quote', () => {
  it('is cells times the cell price on a board with nothing sold', () => {
    expect(quote(board(), at(5, 7, 3, 4), T0)).toBe(120_036n);
  });

  it('prices each free cell at its zone', () => {
    const zones: Zone[] = [{ col: 10, row: 10, cols: 5, rows: 5, cellPrice: 30_011n }];
    expect(quote(board([], { zones }), at(8, 10, 3, 1), T0)).toBe(2n * 10_003n + 30_011n);
  });

  it('scales the free part by the board\'s share, rounding up', () => {
    // 10,003 at half is 5,001.5: one square charges 5,002, two exactly 10,003 — not 2 × 5,002.
    expect(quote(board([], { priceBps: 5_000 }), at(0, 0), T0)).toBe(5_002n);
    expect(quote(board([], { priceBps: 5_000 }), at(0, 0, 2, 1), T0)).toBe(10_003n);
    expect(squarePrice(10_003n, 5_000)).toBe(5_002n);
  });

  it('never makes a square free', () => {
    expect(quote(board([], { cellPrice: 1n, priceBps: 1 }), at(0, 0), T0)).toBe(1n);
    expect(squarePrice(1n, 1)).toBe(1n);
  });

  it('charges a taken cell its creation price at the floor level times take: the contract\'s 14,004', () => {
    const s = board([{ rect: at(0, 0), owner: A, level: 10_000n }]);
    expect(quote(s, at(0, 0), T0 + HOUR)).toBe(14_004n);
  });

  it('reverts the level weekly toward the creation price, and never below it', () => {
    const s = board([{ rect: at(0, 0), owner: A, level: 14_000n }]);
    // The contract's figures: one week 10,003 × 13,580 × 1.4, two weeks × 13,172.
    expect(quote(s, at(0, 0), T0 + 2n * WEEK - 1n)).toBe(19_017n);
    expect(quote(s, at(0, 0), T0 + 2n * WEEK)).toBe(18_446n);
    expect(quote(s, at(0, 0), T0 + 104n * WEEK)).toBe(14_004n);
    // Reversion stops at the board's last week: past it the floor holds.
    const short = board([{ rect: at(0, 0), owner: A, level: 14_000n }], { terms: { ...STANDARD, reversionBps: 9_900, maxReversionWeeks: 2 } });
    expect(quote(short, at(0, 0), T0 + 3n * WEEK)).toBe(quote(short, at(0, 0), T0 + 2n * WEEK));
    expect(quote(short, at(0, 0), T0 + 2n * WEEK)).toBeLessThan(quote(short, at(0, 0), T0 + WEEK));
    // A block bought at a cut is still taken from its creation price.
    expect(quote(board([{ rect: at(0, 0), owner: A, level: 5_001n }]), at(0, 0), T0 + HOUR)).toBe(14_004n);
  });

  it('prices a rectangle across two blocks and free cells: the contract\'s 62,018', () => {
    const s = board([
      { rect: at(0, 0, 2, 1), owner: A, level: 10_000n },
      { rect: at(3, 0), owner: B, level: 10_000n },
    ]);
    const found = quoteRect(s, at(0, 0, 5, 1), T0 + HOUR);
    expect(found.total).toBe(62_018n);
    expect(found.free).toBe(2);
    expect(found.taken).toEqual([
      { blockId: 1, owner: A, cells: 2, price: 28_008n },
      { blockId: 2, owner: B, cells: 1, price: 14_004n },
    ]);
  });

  it('counts a block met twice in one rectangle once', () => {
    // Row 0 reads 1, 2, 1.
    const s = board([
      { rect: at(0, 0, 3, 2), owner: A },
      { rect: at(1, 0), owner: B },
    ]);
    const found = quoteRect(s, at(0, 0, 3, 2), T0 + HOUR);
    expect(found.taken.map((p) => [p.blockId, p.cells])).toEqual([
      [1, 5],
      [2, 1],
    ]);
  });

  it('sums every rectangle of a buy, and throws for a refusal as the contract reverts', () => {
    const s = board([{ rect: at(0, 0), owner: A }]);
    expect(quoteBlocks(s, [at(0, 0), at(5, 5)], T0 + HOUR)).toBe(14_004n + 10_003n);
    expect(() => quoteBlocks(s, [at(5, 5), at(0, 0)], T0)).toThrow(RefusedBuyError);
    expect(quoteRect(s, at(0, 0), T0)).toEqual({ error: 'CoolingDown', total: 0n, free: 0, taken: [] });
  });

  it('throws where the contract\'s checked arithmetic would overflow', () => {
    const s = board([{ rect: at(0, 0), owner: A, level: 1n << 95n }], { cellPrice: 1n << 150n });
    expect(() => quote(s, at(0, 0), T0 + HOUR)).toThrow(/overflows/);
  });
});

describe('termsError', () => {
  it('is TermsLib\'s clamps, in its order', () => {
    expect(termsError(STANDARD, 500)).toBeNull();
    expect(termsError({ ...STANDARD, payoutBps: 9_999, takeBps: 40_000 }, 500)).toBe('PayoutBelowPrincipal');
    expect(termsError({ ...STANDARD, takeBps: 30_001 }, 500)).toBe('TakeTooHigh');
    expect(termsError({ ...STANDARD, takeBps: 30_000, payoutBps: 29_500 }, 500)).toBe('TakeBelowPayout');
    expect(termsError({ ...STANDARD, takeBps: 30_000, payoutBps: 29_499 }, 500)).toBeNull();
    expect(termsError({ ...STANDARD, reversionBps: 10_001 }, 500)).toBe('InvalidReversion');
    expect(termsError({ ...STANDARD, reversionBps: 10_000 }, 500)).toBeNull();
    expect(termsError({ ...STANDARD, maxReversionWeeks: 0 }, 500)).toBeNull();
    expect(termsError({ ...STANDARD, cooldownSecs: 604_800 }, 500)).toBeNull();
    expect(termsError({ ...STANDARD, cooldownSecs: 0 }, 500)).toBeNull();
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
