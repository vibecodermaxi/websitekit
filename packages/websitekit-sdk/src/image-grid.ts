/**
 * The image-board grid rule, in TypeScript (`docs/IMAGE-BOARD-SPEC.md`).
 *
 * **A twin of `ImageBoard.sol`**: `gridOf` is its `initialize` geometry, `layoutProblem` what its
 * `initialize` refuses of zones, `buyError` its `buyError` (and `blockError` its
 * one-rectangle `blockError`), and `quoteBlocks` and `quote` its own. The two runtimes cannot
 * import each other, so they are pinned by one fixture — `GenImageGridVectors.s.sol` writes the
 * contract's answers and `image-grid.vectors.test.ts` asserts this file against every line. Change a
 * rule here and that test is what notices.
 *
 * **This is what a screen shows, never what a buy trusts.** The buy action asks the contract's own
 * `buyError` and `quoteBlocks` fresh (`readBuyError`, `readQuoteBlocks` in `image-boards.ts`)
 * before anyone signs, and the buy names the most it will pay, so the chain stays the one gate and
 * this is its preview.
 *
 * **Any cell can be bought** (2026-10-14, spec §11): free, or held by a block, which a buy then
 * takes — except a block's still in its cooldown. (Kept squares were removed with spec §13,
 * 2026-10-21.)
 * What a sold cell costs moves with time (reversion is weekly), so every price here takes `now`,
 * in seconds, as the chain's clock would read it.
 *
 * Dependency-free on purpose: a buy screen's drag-select runs it in the browser on every pointer
 * move. Take prices are `pricing.ts`'s `computeTakePrice`, the page boards' own, imported rather than
 * copied.
 */
import { BPS_DENOMINATOR, PricingOverflowError, SECONDS_PER_WEEK, computeTakePrice } from './pricing';

/**
 * Square cells, in the image's own pixels: the contract takes any whole size from `MIN_CELL_SIZE` to
 * `MAX_CELL_SIZE` (2026-10-20). `CELL_SIZES` are the ones a set-up screen usually offers.
 */
export const MIN_CELL_SIZE = 10;
export const MAX_CELL_SIZE = 200;
export const CELL_SIZES = [10, 15, 20] as const;
export type CellSize = (typeof CELL_SIZES)[number];

/** A block id per cell on chain, eight to a storage word, 32 words to a row. */
export const MAX_GRID_COLS = 256;
/** The contract's limit on rows. A buy is bounded by `MAX_WORDS_PER_BUY`, not by the grid. */
export const MAX_GRID_ROWS = 1_000;
/** The chain's ceiling, not a product limit: the contract's `MAX_ZONES`, measured to fit a transaction. */
export const MAX_ZONES = 512;
/** Cells to a storage word of the cell map. */
export const CELLS_PER_WORD = 8;
/**
 * The contract's `MAX_WORDS_PER_BUY`: the most cell words one buy may write, counted per row of each
 * rectangle as the words its columns span (`wordsOf`). 512 is a 64 × 64 square or a 256 × 16 strip.
 */
export const MAX_WORDS_PER_BUY = 512;
/** The contract's `MAX_BLOCKS_TAKEN_PER_BUY`: the most blocks one buy may take cells from, counted once per rectangle. */
export const MAX_BLOCKS_TAKEN_PER_BUY = 88;

/** A board's `priceBps` before its holder lowers anything: every square at the price set at creation. */
export const FULL_PRICE_BPS = 10_000;

const BPS = BPS_DENOMINATOR;
const BPS_SQUARED = BPS * BPS;
const U256_MAX = (1n << 256n) - 1n;

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

/** The contract's error names, and `none` for a buy that can go through. */
export type BlockErrorName =
  | 'none'
  | 'EmptyBlock'
  | 'OutsideGrid'
  | 'CellsTaken'
  | 'CoolingDown'
  | 'TooLarge'
  | 'TooManyBlocks';

/** How a sold cell is taken: the board's five terms, chosen by its creator and frozen (`Terms` on chain). */
export interface TakeTerms {
  takeBps: number;
  payoutBps: number;
  reversionBps: number;
  maxReversionWeeks: number;
  cooldownSecs: number;
}

/** What pricing a take needs to know of a block. */
export interface Holding {
  owner: string;
  /** What the block cost over the creation price of its cells, in bps, rounded up. */
  level: bigint;
  /** When it was bought, in seconds. A resale or a gift does not move it. */
  boughtAt: bigint;
}

/** Which block holds each cell, `cells[row * grid.cols + col]`; zero is a free cell. */
export type CellMap = Uint32Array;

/** Everything a buy is checked and priced against. */
export interface GridState {
  grid: Grid;
  cellPrice: bigint;
  /** Required, `[]` for none: leaving them out would price a board at a price it does not charge. */
  zones: readonly Zone[];
  /** What share of the creation prices a FREE square costs now. Sold cells never see it. */
  priceBps: number;
  terms: TakeTerms;
  cells: CellMap;
  /** Every block a cell names, by id. */
  blocks: ReadonlyMap<number, Holding>;
}

/**
 * The grid an image of this size gets: whole cells from the top-left, the strip a cell does not
 * fit left unsold. `InvalidConfig` is the contract's refusal, for the same inputs.
 */
export function gridOf(width: number, height: number, cellSize: number): Grid | { error: 'InvalidConfig' } {
  if (!Number.isInteger(cellSize) || cellSize < MIN_CELL_SIZE || cellSize > MAX_CELL_SIZE) return { error: 'InvalidConfig' };
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    return { error: 'InvalidConfig' };
  }
  const cols = Math.floor(width / cellSize);
  const rows = Math.floor(height / cellSize);
  if (cols === 0 || cols > MAX_GRID_COLS || rows === 0 || rows > MAX_GRID_ROWS) return { error: 'InvalidConfig' };
  return { cols, rows };
}

/** A board with nothing sold. */
export function emptyCells(grid: Grid): CellMap {
  return new Uint32Array(grid.cols * grid.rows);
}

/**
 * The cell map from what the contract's `cellRow` answers for each row in order: ⌈cols / 8⌉ words a
 * row, column `c` in word `c / 8`, lane `c % 8`, 32 bits a lane.
 */
export function cellMapOf(grid: Grid, rows: readonly (readonly bigint[])[]): CellMap {
  if (rows.length !== grid.rows) throw new Error(`image grid: ${rows.length} rows of cells for a grid of ${grid.rows}`);
  const cells = emptyCells(grid);
  for (const [r, words] of rows.entries()) {
    for (let c = 0; c < grid.cols; c++) {
      const word = words[Math.floor(c / CELLS_PER_WORD)] ?? 0n;
      cells[r * grid.cols + c] = Number((word >> BigInt((c % CELLS_PER_WORD) * 32)) & 0xffffffffn);
    }
  }
  return cells;
}

/**
 * The cell map from the blocks alone: every block's rectangle painted in id order. Exactly the
 * contract's, because `_record` is the only thing that writes a cell, and it paints a new block's
 * whole rectangle — so a screen holding the blocks needs no `cellRow` read. Pass every block.
 */
export function cellMapFromBlocks(grid: Grid, blocks: readonly (Rect & { tokenId: bigint | number | string })[]): CellMap {
  const cells = emptyCells(grid);
  for (const b of [...blocks].sort((x, y) => Number(x.tokenId) - Number(y.tokenId))) paint(cells, grid, b, Number(b.tokenId));
  return cells;
}

/** Marks every cell of `rect` as block `id`'s, as a buy does: what was under it is covered. */
export function paint(cells: CellMap, grid: Grid, rect: Rect, id: number): void {
  for (let r = rect.row; r < rect.row + rect.rows; r++) {
    cells.fill(id, r * grid.cols + rect.col, r * grid.cols + rect.col + rect.cols);
  }
}

/** The block holding a cell, or zero. */
export function idAt(cells: CellMap, grid: Grid, col: number, row: number): number {
  return cells[row * grid.cols + col] ?? 0;
}

/** The storage words a rectangle writes, which is what `MAX_WORDS_PER_BUY` counts: per row, the words its columns span. */
export function wordsOf(rect: Rect): number {
  const perRow = Math.floor((rect.col + rect.cols - 1) / CELLS_PER_WORD) - Math.floor(rect.col / CELLS_PER_WORD) + 1;
  return perRow * rect.rows;
}

/** `a * b`, throwing where the contract's checked multiply reverts. */
function mul(a: bigint, b: bigint): bigint {
  const result = a * b;
  if (result > U256_MAX) throw new PricingOverflowError('multiply');
  return result;
}

/** One covered block's share of a rectangle. */
export interface TakenPart {
  blockId: number;
  owner: string;
  /** How many of its cells the rectangle covers. */
  cells: number;
  /** What those cells cost the buyer. */
  price: bigint;
}

/** What one rectangle covers and costs, as the contract surveys it. */
export interface RectQuote {
  /** Why this rectangle is refused, `none` if it is not. Counted as if it were the buy's only one. */
  error: BlockErrorName;
  /** Its whole price; zero when refused. */
  total: bigint;
  /** Cells nobody holds, sold first-hand at `priceBps`. */
  free: number;
  /** Every block it takes cells from, in the order the contract meets them (row by row). */
  taken: TakenPart[];
}

interface Survey {
  error: BlockErrorName;
  base: bigint;
  freeBase: bigint;
  free: number;
  parts: { blockId: number; owner: string; base: bigint; cells: number; floor: bigint }[];
}

/** Each cell's creation price, row-major over the rectangle: `cellPrice`, or its zone's. */
function pricesOf(state: GridState, k: Rect): bigint[] {
  const prices = new Array<bigint>(k.cols * k.rows).fill(state.cellPrice);
  for (const z of state.zones) {
    const c0 = Math.max(z.col, k.col);
    const c1 = Math.min(z.col + z.cols, k.col + k.cols);
    const r0 = Math.max(z.row, k.row);
    const r1 = Math.min(z.row + z.rows, k.row + k.rows);
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) prices[(r - k.row) * k.cols + c - k.col] = z.cellPrice;
    }
  }
  return prices;
}

/**
 * The contract's `_survey`: the rectangle's cells tallied by the block holding them, each at its
 * creation price. A block met for the first time is checked, in this order — the buy's block cap,
 * cooling down — and its floor level read; the first refusal ends the survey.
 */
function survey(state: GridState, k: Rect, now: bigint, takenSoFar: number): Survey {
  const v: Survey = { error: 'none', base: 0n, freeBase: 0n, free: 0, parts: [] };
  const prices = pricesOf(state, k);
  const seen = new Map<number, number>();
  for (let r = k.row; r < k.row + k.rows; r++) {
    for (let c = k.col; c < k.col + k.cols; c++) {
      const price = prices[(r - k.row) * k.cols + c - k.col]!;
      const id = idAt(state.cells, state.grid, c, r);
      v.base += price;
      if (id === 0) {
        v.freeBase += price;
        v.free++;
        continue;
      }
      const at = seen.get(id);
      if (at !== undefined) {
        v.parts[at]!.base += price;
        v.parts[at]!.cells++;
        continue;
      }
      if (takenSoFar + v.parts.length === MAX_BLOCKS_TAKEN_PER_BUY) return { ...v, error: 'TooManyBlocks' };
      const held = state.blocks.get(id);
      if (!held) throw new Error(`image grid: cell ${c},${r} names block ${id}, which the state does not carry`);
      if (now < held.boughtAt + BigInt(state.terms.cooldownSecs)) return { ...v, error: 'CoolingDown' };
      const weeks = now > held.boughtAt ? (now - held.boughtAt) / SECONDS_PER_WEEK : 0n;
      const { effectiveFloor } = computeTakePrice(
        held.level,
        BPS,
        weeks,
        BigInt(state.terms.reversionBps),
        BigInt(state.terms.takeBps),
        BigInt(state.terms.maxReversionWeeks),
      );
      seen.set(id, v.parts.length);
      v.parts.push({ blockId: id, owner: held.owner, base: price, cells: 1, floor: effectiveFloor });
    }
  }
  return v;
}

/**
 * The contract's `_priceOf`: the free part a first sale at `priceBps`, rounded up; each covered
 * block's cells their creation price at its floor level times `takeBps`, rounded down.
 */
function priced(state: GridState, v: Survey): RectQuote {
  let total = 0n;
  if (v.free !== 0) total = (mul(v.freeBase, BigInt(state.priceBps)) + BPS - 1n) / BPS;
  const taken = v.parts.map((p) => {
    const price = mul(mul(p.base, p.floor), BigInt(state.terms.takeBps)) / BPS_SQUARED;
    total += price;
    return { blockId: p.blockId, owner: p.owner, cells: p.cells, price };
  });
  return { error: 'none', total, free: v.free, taken };
}

function sharesACell(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows;
}

/**
 * The contract's `_inspect`: each rectangle in turn — its shape (empty, off the grid, sharing a cell
 * with an earlier one, past the word cap), then its survey — so the first rectangle that fails
 * names the error, and an empty list is `EmptyBlock`.
 */
function inspect(state: GridState, rects: readonly Rect[], now: bigint): { error: BlockErrorName; quotes: RectQuote[] } {
  if (rects.length === 0) return { error: 'EmptyBlock', quotes: [] };
  const { grid } = state;
  const quotes: RectQuote[] = [];
  let words = 0;
  let taken = 0;
  for (const [i, k] of rects.entries()) {
    if (k.cols === 0 || k.rows === 0) return { error: 'EmptyBlock', quotes };
    if (k.col + k.cols > grid.cols || k.row + k.rows > grid.rows) return { error: 'OutsideGrid', quotes };
    if (rects.slice(0, i).some((e) => sharesACell(e, k))) return { error: 'CellsTaken', quotes };
    words += wordsOf(k);
    if (words > MAX_WORDS_PER_BUY) return { error: 'TooLarge', quotes };
    const v = survey(state, k, now, taken);
    if (v.error !== 'none') return { error: v.error, quotes };
    taken += v.parts.length;
    quotes.push(priced(state, v));
  }
  return { error: 'none', quotes };
}

/** Why `buyBlocks` would refuse these rectangles bought together at `now`, or `none`. */
export function buyError(state: GridState, rects: readonly Rect[], now: bigint): BlockErrorName {
  return inspect(state, rects, now).error;
}

/** `buyError` for one rectangle. */
export function blockError(state: GridState, rect: Rect, now: bigint): BlockErrorName {
  return buyError(state, [rect], now);
}

/** Thrown where the contract's `quote` and `quoteBlocks` revert: they never price a refusal. */
export class RefusedBuyError extends Error {
  constructor(readonly reason: Exclude<BlockErrorName, 'none'>) {
    super(`image grid: the buy is refused (${reason})`);
    this.name = 'RefusedBuyError';
  }
}

/** What `buyBlocks` would pull for these rectangles at `now`: the sum of each one's price. Throws `RefusedBuyError` when refused. */
export function quoteBlocks(state: GridState, rects: readonly Rect[], now: bigint): bigint {
  const { error, quotes } = inspect(state, rects, now);
  if (error !== 'none') throw new RefusedBuyError(error);
  return quotes.reduce((sum, q) => sum + q.total, 0n);
}

/** `quoteBlocks` for one rectangle. */
export function quote(state: GridState, rect: Rect, now: bigint): bigint {
  return quoteBlocks(state, [rect], now);
}

/**
 * One rectangle as if bought alone, with what it covers: the free cells and every block it would
 * take from, each with its price. For a screen; never throws for a refusal, which is `error`.
 */
export function quoteRect(state: GridState, rect: Rect, now: bigint): RectQuote {
  const { error, quotes } = inspect(state, [rect], now);
  if (error !== 'none') return { error, total: 0n, free: 0, taken: [] };
  return quotes[0]!;
}

/** `TermsLib`'s ceilings, which a board's terms are held to as a page board's are. */
export const MAX_TAKE_BPS = 30_000;
export const MAX_REVERSION_WEEKS = 52;
export const MAX_COOLDOWN_SECS = 604_800;

/** The errors `TermsLib.checkEconomicsAbsolute` reverts a board's creation with. */
export type TermsError = 'PayoutBelowPrincipal' | 'TakeTooHigh' | 'TakeBelowPayout' | 'InvalidReversion' | 'InvalidConfig';

/**
 * Why the contract would refuse these terms at creation, in `TermsLib`'s order, or null. A displaced
 * owner is paid at least the floor (`payoutBps` ≥ 10,000), and a take must leave something for the
 * board's holder after the payout and the protocol's cut.
 */
export function termsError(t: TakeTerms, protocolBps: number): TermsError | null {
  if (t.payoutBps < 10_000) return 'PayoutBelowPrincipal';
  if (t.takeBps > MAX_TAKE_BPS) return 'TakeTooHigh';
  if (t.takeBps <= t.payoutBps + protocolBps) return 'TakeBelowPayout';
  if (t.reversionBps === 0 || t.reversionBps > 10_000) return 'InvalidReversion';
  if (t.maxReversionWeeks > MAX_REVERSION_WEEKS) return 'InvalidReversion';
  if (t.cooldownSecs > MAX_COOLDOWN_SECS) return 'InvalidConfig';
  return null;
}

/** What one FREE square costs now, at the board's price or a zone's: rounded up, as one. */
export function squarePrice(cellPrice: bigint, priceBps: number): bigint {
  return (cellPrice * BigInt(priceBps) + 9_999n) / 10_000n;
}

/** The bits a rectangle sets in each of its rows, for the layout's overlap checks. */
function maskOf(col: number, cols: number): bigint {
  return ((1n << BigInt(cols)) - 1n) << BigInt(col);
}

/** Why a set of zones would be refused at creation, naming which one. */
export type LayoutProblem = 'too-many-zones' | 'zone-price' | 'zone-empty' | 'zone-outside' | 'zones-overlap';

/** The error the contract's `initialize` reverts with for each, which the vectors pin. */
export const LAYOUT_ERROR: Record<LayoutProblem, 'InvalidConfig'> = {
  'too-many-zones': 'InvalidConfig',
  'zone-price': 'InvalidConfig',
  'zone-empty': 'InvalidConfig',
  'zone-outside': 'InvalidConfig',
  'zones-overlap': 'InvalidConfig',
};

/**
 * The contract's checks on a new board's zones, in its order: the count, then each zone (price and
 * size, then the grid, then the zones before it). `index` is the zone's place in its list; null
 * means the contract would accept them.
 */
export function layoutProblem(grid: Grid, zones: readonly Zone[]): { problem: LayoutProblem; index: number } | null {
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
  return null;
}
