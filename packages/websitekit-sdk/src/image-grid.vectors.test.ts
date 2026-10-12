/**
 * `image-grid.ts` against `ImageBoard.sol`, line by line: two runtimes pinned by one fixture.
 *
 * Runs `forge script script/GenImageGridVectors.s.sol`, which creates real boards through the real
 * factory and writes what the contract answered to `out/image-grid-vectors.jsonl`. The source of
 * truth is the contract, an END of the pin; this file is the other end.
 *
 * **What the fixture pins**: grid derivation for 19 image sizes across all three cell sizes and both
 * limits, and `blockError` for every rectangle of eight shapes at every origin one cell past a
 * 12×10 grid with three blocks sold, plus a 256-wide board (the full-word mask). Since 2026-10-11:
 * `layoutProblem` against what `initialize` refused for 20 sets of zones and kept blocks (every
 * boundary: edges, touching, one shared cell, either order), and `quote` and `blockError` for every
 * rectangle of six shapes on a board with three zones (one priced near 2^150) and two kept blocks —
 * at full price and lowered to 3,333 and 1 bps — and `buyError` against what a real `buyBlocks`
 * refused for 11 lists (empty, touching, sharing a cell, the same twice, either order of two bad).
 * **What it does not**: the zone ceiling (512 zones, asserted in `image-grid.test.ts` and the
 * contract's own suite) and any board shape outside these — a twin that special-cased them would pass.
 *
 * Skips without forge locally; fails in CI, where a skip would be a green check that tested nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LAYOUT_ERROR,
  blockError,
  buyError,
  gridOf,
  layoutProblem,
  occupancy,
  quote,
  type BlockErrorName,
  type Grid,
  type Rect,
  type Zone,
} from './image-grid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(__dirname, '../../websitekit-contracts');
const outFile = path.join(contractsDir, 'out', 'image-grid-vectors.jsonl');

const hasForge = spawnSync('forge', ['--version'], { encoding: 'utf-8' }).status === 0;
if (!hasForge && process.env.CI) throw new Error('image-grid vectors: forge is not on PATH, and this is CI');

type Line =
  | { kind: 'grid'; width: number; height: number; cellSize: number; gridCols?: number; gridRows?: number; error: string }
  | { kind: 'board'; gridCols: number; gridRows: number; sold: [number, number, number, number][] }
  | ({ kind: 'rect'; error: BlockErrorName } & Rect)
  | { kind: 'layout'; zones: ZoneJson[]; kept: KeptJson[]; error: string }
  | { kind: 'zoned'; gridCols: number; gridRows: number; cellPrice: string; priceBps: number; zones: ZoneJson[]; kept: KeptJson[] }
  | ({ kind: 'quote'; total: string; error: BlockErrorName } & Rect)
  | { kind: 'multiBoard'; gridCols: number; gridRows: number; sold: KeptJson[] }
  | { kind: 'multi'; rects: KeptJson[]; error: BlockErrorName };

type ZoneJson = [number, number, number, number, string];
type KeptJson = [number, number, number, number];
const zoneOf = ([col, row, cols, rows, price]: ZoneJson): Zone => ({ col, row, cols, rows, cellPrice: BigInt(price) });
const rectOf = ([col, row, cols, rows]: KeptJson): Rect => ({ col, row, cols, rows });

function generate(): Line[] {
  const result = spawnSync('forge', ['script', 'script/GenImageGridVectors.s.sol'], {
    cwd: contractsDir,
    encoding: 'utf-8',
  });
  if (result.status !== 0) throw new Error(`GenImageGridVectors failed:\n${result.stdout}\n${result.stderr}`);
  if (!existsSync(outFile)) throw new Error(`no vectors at ${outFile}`);
  return readFileSync(outFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

describe.skipIf(!hasForge)('the grid rule agrees with ImageBoard.sol', () => {
  const lines = hasForge ? generate() : [];

  it('has vectors for every outcome, so agreement is not vacuous', () => {
    const grids = lines.filter((l) => l.kind === 'grid');
    const rects = lines.filter((l): l is Extract<Line, { kind: 'rect' }> => l.kind === 'rect');
    expect(grids.length).toBeGreaterThanOrEqual(19);
    expect(grids.some((l) => l.error === 'InvalidConfig')).toBe(true);
    expect(grids.some((l) => l.error === 'none')).toBe(true);
    expect(lines.filter((l) => l.kind === 'board').length).toBe(2);
    for (const name of ['none', 'EmptyBlock', 'OutsideGrid', 'CellsTaken'] as const) {
      expect(rects.filter((l) => l.error === name).length, name).toBeGreaterThan(0);
    }
  });

  it('derives the same grid, or refuses the same image', () => {
    let checked = 0;
    for (const line of lines) {
      if (line.kind !== 'grid') continue;
      const ours = gridOf(line.width, line.height, line.cellSize);
      const theirs = line.error === 'none' ? { cols: line.gridCols, rows: line.gridRows } : { error: line.error };
      expect(ours, `${line.width}×${line.height} at ${line.cellSize}`).toEqual(theirs);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('names the same error for every rectangle', () => {
    let grid: Grid | null = null;
    let taken = new Map<number, bigint>();
    let checked = 0;
    for (const line of lines) {
      if (line.kind === 'board') {
        grid = { cols: line.gridCols, rows: line.gridRows };
        taken = occupancy(line.sold.map(([col, row, cols, rows]) => ({ col, row, cols, rows })));
        continue;
      }
      if (line.kind !== 'rect') continue;
      if (!grid) throw new Error('a rect line before any board line');
      const rect = { col: line.col, row: line.row, cols: line.cols, rows: line.rows };
      expect(blockError(grid, taken, rect), JSON.stringify(rect)).toBe(line.error);
      checked++;
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it('refuses the same zones and kept blocks, with the same error', () => {
    const layouts = lines.filter((l): l is Extract<Line, { kind: 'layout' }> => l.kind === 'layout');
    expect(layouts.length).toBeGreaterThanOrEqual(20);
    for (const name of ['none', 'InvalidConfig', 'EmptyBlock', 'OutsideGrid', 'CellsTaken']) {
      expect(layouts.some((l) => l.error === name), name).toBe(true);
    }
    const grid = { cols: 12, rows: 10 };
    for (const line of layouts) {
      const found = layoutProblem(grid, line.zones.map(zoneOf), line.kept.map(rectOf));
      expect(found ? LAYOUT_ERROR[found.problem] : 'none', JSON.stringify(line)).toBe(line.error);
    }
  });

  it('quotes every rectangle on a zoned board as the contract does', () => {
    let grid: Grid | null = null;
    let zones: Zone[] = [];
    let cellPrice = 0n;
    let priceBps = 0;
    let taken = new Map<number, bigint>();
    let checked = 0;
    let mixed = 0;
    let lowered = 0;
    for (const line of lines) {
      if (line.kind === 'zoned') {
        grid = { cols: line.gridCols, rows: line.gridRows };
        zones = line.zones.map(zoneOf);
        cellPrice = BigInt(line.cellPrice);
        priceBps = line.priceBps;
        taken = occupancy(line.kept.map(rectOf));
        continue;
      }
      if (line.kind !== 'quote') continue;
      if (!grid) throw new Error('a quote line before the zoned board');
      const rect = { col: line.col, row: line.row, cols: line.cols, rows: line.rows };
      expect(quote(rect, cellPrice, zones, priceBps), `${JSON.stringify(rect)} at ${priceBps}`).toBe(BigInt(line.total));
      expect(blockError(grid, taken, rect), JSON.stringify(rect)).toBe(line.error);
      if (priceBps === 10_000 && BigInt(line.total) !== BigInt(rect.cols * rect.rows) * cellPrice) mixed++;
      if (priceBps < 10_000) lowered++;
      checked++;
    }
    expect(checked).toBeGreaterThan(1_500);
    // Rectangles a zone priced, so agreement on them is not agreement at the base price only.
    expect(mixed).toBeGreaterThan(100);
    // And at lowered prices, where rounding up the whole block decides the figure.
    expect(lowered).toBeGreaterThan(1_000);
  });

  it('refuses the same lists of rectangles, naming the same one', () => {
    const board = lines.find((l): l is Extract<Line, { kind: 'multiBoard' }> => l.kind === 'multiBoard');
    if (!board) throw new Error('no multiBoard line');
    const grid = { cols: board.gridCols, rows: board.gridRows };
    const taken = occupancy(board.sold.map(rectOf));
    const cases = lines.filter((l): l is Extract<Line, { kind: 'multi' }> => l.kind === 'multi');
    expect(cases.length).toBeGreaterThanOrEqual(11);
    for (const name of ['none', 'EmptyBlock', 'OutsideGrid', 'CellsTaken'] as const) {
      expect(cases.some((l) => l.error === name), name).toBe(true);
    }
    for (const line of cases) {
      expect(buyError(grid, taken, line.rects.map(rectOf)), JSON.stringify(line.rects)).toBe(line.error);
    }
  });
});
