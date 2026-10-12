/**
 * The image-board grid rule, in TypeScript (`docs/IMAGE-BOARD-SPEC.md`).
 *
 * **A twin of `ImageBoard.sol`**: `gridOf` is its `initialize` geometry, `layoutProblem` what its
 * `initialize` refuses of zones and kept blocks, `blockError` its `blockError`, `buyError` what its
 * `buyBlocks` refuses a list with, and `quote` its `quote`. The two runtimes cannot import each other, so they are pinned by one fixture —
 * `GenImageGridVectors.s.sol` writes the contract's answers and `image-grid.vectors.test.ts` asserts
 * this file against every line. Change a rule here and that test is what notices.
 *
 * **This is what a screen shows, never what a buy trusts.** The buy action asks the contract's
 * `blockError` fresh (`readBlockError` in `image-boards.ts`) before it sends, so the chain stays
 * the one gate and this is its preview.
 *
 * Dependency-free on purpose: a buy screen's drag-select runs it in the browser on every pointer move.
 */

/** Square cells, in the image's own pixels. */
export const CELL_SIZES = [10, 15, 20] as const;
export type CellSize = (typeof CELL_SIZES)[number];

/** One storage word per row on chain. */
export const MAX_GRID_COLS = 256;
/** So buying the whole grid fits one transaction under Robinhood Chain's 32M gas cap per transaction. */
export const MAX_GRID_ROWS = 1_000;
/** The chain's ceiling, not a product limit: the contract's `MAX_ZONES`, measured to fit a transaction. */
export const MAX_ZONES = 512;

/** A board's `priceBps` before its holder lowers anything: every square at the price set at creation. */
export const FULL_PRICE_BPS = 10_000;

export interface Grid {
  cols: number;
  rows: number;
}

/** A block, in cells, from the grid's top-left. */
export interface Rect {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/** Cells priced differently from the board's `cellPrice`, in the settlement token's units. */
export interface Zone extends Rect {
  cellPrice: bigint;
}

/** The contract's error names, and `none` for a block that can be bought. */
export type BlockErrorName = 'none' | 'EmptyBlock' | 'OutsideGrid' | 'CellsTaken';

/**
 * The grid an image of this size gets: whole cells from the top-left, the strip a cell does not
 * fit left unsold. `InvalidConfig` is the contract's refusal, for the same inputs.
 */
export function gridOf(width: number, height: number, cellSize: number): Grid | { error: 'InvalidConfig' } {
  if (!(CELL_SIZES as readonly number[]).includes(cellSize)) return { error: 'InvalidConfig' };
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    return { error: 'InvalidConfig' };
  }
  const cols = Math.floor(width / cellSize);
  const rows = Math.floor(height / cellSize);
  if (cols === 0 || cols > MAX_GRID_COLS || rows === 0 || rows > MAX_GRID_ROWS) return { error: 'InvalidConfig' };
  return { cols, rows };
}

/** The bits a block sets in each of its rows: column `c` is bit `c`, as on chain. */
function maskOf(col: number, cols: number): bigint {
  return ((1n << BigInt(cols)) - 1n) << BigInt(col);
}

/**
 * Taken cells as one bitmap per row — the shape the contract stores — built from the sold blocks.
 * A row with nothing sold is absent.
 */
export function occupancy(blocks: readonly Rect[]): Map<number, bigint> {
  const taken = new Map<number, bigint>();
  for (const b of blocks) {
    const mask = maskOf(b.col, b.cols);
    for (let r = b.row; r < b.row + b.rows; r++) taken.set(r, (taken.get(r) ?? 0n) | mask);
  }
  return taken;
}

/** Why this block could not be bought on this grid right now, in the contract's order of checks. */
export function blockError(grid: Grid, taken: ReadonlyMap<number, bigint>, rect: Rect): BlockErrorName {
  if (rect.cols === 0 || rect.rows === 0) return 'EmptyBlock';
  if (rect.col + rect.cols > grid.cols || rect.row + rect.rows > grid.rows) return 'OutsideGrid';
  const mask = maskOf(rect.col, rect.cols);
  for (let r = rect.row; r < rect.row + rect.rows; r++) {
    if (((taken.get(r) ?? 0n) & mask) !== 0n) return 'CellsTaken';
  }
  return 'none';
}

/**
 * Why `buyBlocks` would refuse this list of rectangles right now: the first one that is empty, off
 * the grid, or on a cell that is sold or that an earlier rectangle in the list takes — or
 * `EmptyBlock` for an empty list. The contract takes each in turn, so order decides which error.
 */
export function buyError(grid: Grid, taken: ReadonlyMap<number, bigint>, rects: readonly Rect[]): BlockErrorName {
  if (rects.length === 0) return 'EmptyBlock';
  const sofar = new Map(taken);
  for (const rect of rects) {
    const error = blockError(grid, sofar, rect);
    if (error !== 'none') return error;
    const mask = maskOf(rect.col, rect.cols);
    for (let r = rect.row; r < rect.row + rect.rows; r++) sofar.set(r, (sofar.get(r) ?? 0n) | mask);
  }
  return 'none';
}

/** How many of `[a, a + an)` fall in `[b, b + bn)`. */
function overlap(a: number, an: number, b: number, bn: number): number {
  return Math.max(0, Math.min(a + an, b + bn) - Math.max(a, b));
}

/**
 * What the block at this position costs now: each cell at its zone's price, or `cellPrice` outside
 * every zone, the sum scaled by the board's `priceBps` and rounded up — the whole block's price, not
 * each cell's, so a cut never makes a square free. `zones` and `priceBps` are required — a board with
 * none passes `[]`, one never lowered `FULL_PRICE_BPS` — because leaving either out would quote a
 * board at a price it does not charge. Zones never overlap (`layoutProblem`), so a cell has one price.
 */
export function quote(rect: Rect, cellPrice: bigint, zones: readonly Zone[], priceBps: number): bigint {
  let total = 0n;
  let zoned = 0;
  for (const z of zones) {
    const cells = overlap(rect.col, rect.cols, z.col, z.cols) * overlap(rect.row, rect.rows, z.row, z.rows);
    zoned += cells;
    total += BigInt(cells) * z.cellPrice;
  }
  total += BigInt(rect.cols * rect.rows - zoned) * cellPrice;
  return (total * BigInt(priceBps) + 9_999n) / 10_000n;
}

/** What one square costs now, at the board's price or a zone's: a 1×1 block's quote, rounded up as one. */
export function squarePrice(cellPrice: bigint, priceBps: number): bigint {
  return (cellPrice * BigInt(priceBps) + 9_999n) / 10_000n;
}

/** Why a set of zones and kept blocks would be refused at creation, naming which one. */
export type LayoutProblem =
  | 'too-many-zones'
  | 'zone-price'
  | 'zone-empty'
  | 'zone-outside'
  | 'zones-overlap'
  | 'kept-empty'
  | 'kept-outside'
  | 'kept-overlap';

/** The error the contract's `initialize` reverts with for each, which the vectors pin. */
export const LAYOUT_ERROR: Record<LayoutProblem, 'InvalidConfig' | Exclude<BlockErrorName, 'none'>> = {
  'too-many-zones': 'InvalidConfig',
  'zone-price': 'InvalidConfig',
  'zone-empty': 'InvalidConfig',
  'zone-outside': 'InvalidConfig',
  'zones-overlap': 'InvalidConfig',
  'kept-empty': 'EmptyBlock',
  'kept-outside': 'OutsideGrid',
  'kept-overlap': 'CellsTaken',
};

/**
 * The contract's checks on a new board's zones and kept blocks, in its order: the zone count, then
 * each zone (price and size, then the grid, then the zones before it), then each kept block through
 * `blockError` against the ones before it. A zone may lie over kept cells. `index` is the zone's or
 * the kept block's place in its list; null means the contract would accept the layout.
 */
export function layoutProblem(
  grid: Grid,
  zones: readonly Zone[],
  kept: readonly Rect[],
): { problem: LayoutProblem; index: number } | null {
  if (zones.length > MAX_ZONES) return { problem: 'too-many-zones', index: MAX_ZONES };
  const covered = new Map<number, bigint>();
  for (const [index, z] of zones.entries()) {
    if (z.cellPrice <= 0n) return { problem: 'zone-price', index };
    if (z.cols === 0 || z.rows === 0) return { problem: 'zone-empty', index };
    if (z.col + z.cols > grid.cols || z.row + z.rows > grid.rows) return { problem: 'zone-outside', index };
    const mask = maskOf(z.col, z.cols);
    for (let r = z.row; r < z.row + z.rows; r++) {
      if (((covered.get(r) ?? 0n) & mask) !== 0n) return { problem: 'zones-overlap', index };
      covered.set(r, (covered.get(r) ?? 0n) | mask);
    }
  }
  const taken = new Map<number, bigint>();
  for (const [index, k] of kept.entries()) {
    const error = blockError(grid, taken, k);
    if (error === 'EmptyBlock') return { problem: 'kept-empty', index };
    if (error === 'OutsideGrid') return { problem: 'kept-outside', index };
    if (error === 'CellsTaken') return { problem: 'kept-overlap', index };
    const mask = maskOf(k.col, k.cols);
    for (let r = k.row; r < k.row + k.rows; r++) taken.set(r, (taken.get(r) ?? 0n) | mask);
  }
  return null;
}
