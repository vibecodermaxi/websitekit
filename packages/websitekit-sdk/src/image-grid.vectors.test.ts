/**
 * `image-grid.ts` against `ImageBoard.sol`, line by line: two runtimes pinned by one fixture.
 *
 * Runs `forge script script/GenImageGridVectors.s.sol`, which creates real boards through the real
 * collection, buys and takes on them at real times, and writes what the contract answered to
 * `out/image-grid-vectors.jsonl`. The source of truth is the contract, an END of the pin; this file
 * is the other end.
 *
 * **What the fixture pins**: grid derivation for 28 image sizes, at both ends of the cell-size range
 * (2026-10-20) and both grid limits; `layoutProblem` against what `initialize` refused for 14 sets of zones;
 * `termsError` against what it refused for 19 sets of terms, at every clamp and one past it. Since
 * takeovers (2026-10-14): `blockError` and `quote` for every rectangle of nine shapes at every origin
 * (one past the grid in the first sweep) on a board with zones (one priced near 2^150), a block given
 * away, blocks taken in part and twice, some cooling — at three moments: with
 * blocks cooling, a week into reversion, and with free squares cut to 3,333 bps and every block past
 * its last week (one bought at the cut, its level under 10,000) — and the word and block caps at
 * their boundaries on a 256 × 600 board; a board whose reversion stops at two weeks, week by week past
 * it; `buyError` and `quoteBlocks` for 23 lists (the caps counted across rectangles, a block in two), each also bought
 * for real by the generator, which asserts the buy refused with the same error or pulled the quote.
 * The cell map is decoded by `cellMapOf` from the words `cellRow` returned, and on every state
 * `cellMapFromBlocks` must paint the same map from the blocks' rectangles alone. Since spec §13
 * (2026-10-21): the IPFS addresses the renderer writes for ten hashes and binary CIDs, against
 * `contentHashToCid` and `cidBytesToString`. Kept squares were removed from both ends.
 *
 * **What it does not**: the zone ceiling (512 zones, asserted in `image-grid.test.ts` and the
 * contract's own suite), overflow (asserted in `image-grid.test.ts`), and any board shape outside
 * these — a twin that special-cased them would pass.
 *
 * Skips without forge locally; fails in CI, where a skip would be a green check that tested nothing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { cidBytesToString, contentHashToCid } from './content';
import {
  LAYOUT_ERROR,
  blockError,
  cellMapFromBlocks,
  buyError,
  cellMapOf,
  gridOf,
  layoutProblem,
  quote,
  quoteBlocks,
  termsError,
  type BlockErrorName,
  type GridState,
  type Rect,
  type TakeTerms,
  type Zone,
} from './image-grid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(__dirname, '../../websitekit-contracts');
const outFile = path.join(contractsDir, 'out', 'image-grid-vectors.jsonl');

const hasForge = spawnSync('forge', ['--version'], { encoding: 'utf-8' }).status === 0;
if (!hasForge && process.env.CI) throw new Error('image-grid vectors: forge is not on PATH, and this is CI');

type ZoneJson = [number, number, number, number, string];
type RectJson = [number, number, number, number];

type Line =
  | { kind: 'grid'; width: number; height: number; cellSize: number; gridCols?: number; gridRows?: number; error: string }
  | { kind: 'layout'; zones: ZoneJson[]; error: string }
  | ({ kind: 'terms'; error: string } & TakeTerms)
  | {
      kind: 'state';
      gridCols: number;
      gridRows: number;
      cellPrice: string;
      priceBps: number;
      zones: ZoneJson[];
      terms: TakeTerms;
      now: string;
      rows: [number, string[]][];
      blocks: [number, string, string, string, number, number, number, number][];
    }
  | ({ kind: 'rect'; error: BlockErrorName; total: string } & Rect)
  | { kind: 'multi'; rects: RectJson[]; error: BlockErrorName; total: string }
  | { kind: 'cid'; hash?: Hex; bytes?: Hex; cid: string };

const zoneOf = ([col, row, cols, rows, price]: ZoneJson): Zone => ({ col, row, cols, rows, cellPrice: BigInt(price) });
const rectOf = ([col, row, cols, rows]: RectJson): Rect => ({ col, row, cols, rows });

/** The twin's state from a `state` line: the cell map decoded from the contract's own words. */
function stateOf(line: Extract<Line, { kind: 'state' }>): { state: GridState; now: bigint } {
  const grid = { cols: line.gridCols, rows: line.gridRows };
  const words = Math.ceil(grid.cols / 8);
  const rows: bigint[][] = Array.from({ length: grid.rows }, () => new Array<bigint>(words).fill(0n));
  for (const [r, ws] of line.rows) rows[r] = ws.map(BigInt);
  return {
    now: BigInt(line.now),
    state: {
      grid,
      cellPrice: BigInt(line.cellPrice),
      zones: line.zones.map(zoneOf),
      priceBps: line.priceBps,
      terms: line.terms,
      cells: cellMapOf(grid, rows),
      blocks: new Map(line.blocks.map(([id, owner, level, boughtAt]) => [id, { owner, level: BigInt(level), boughtAt: BigInt(boughtAt) }])),
    },
  };
}

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
  const of = <K extends Line['kind']>(kind: K) => lines.filter((l): l is Extract<Line, { kind: K }> => l.kind === kind);

  it('has vectors for every outcome, so agreement is not vacuous', () => {
    expect(of('grid').length).toBeGreaterThanOrEqual(19);
    expect(of('state').length).toBe(10);
    const answers = [...of('rect'), ...of('multi')];
    for (const name of ['none', 'EmptyBlock', 'OutsideGrid', 'CellsTaken', 'CoolingDown', 'TooLarge', 'TooManyBlocks'] as const) {
      expect(answers.filter((l) => l.error === name).length, name).toBeGreaterThan(0);
    }
  });

  it('paints the same cell map from the blocks alone as the chain stores', () => {
    const states = of('state');
    let held = 0;
    for (const line of states) {
      const { state } = stateOf(line);
      const painted = cellMapFromBlocks(
        state.grid,
        line.blocks.map(([tokenId, , , , col, row, cols, rows]) => ({ tokenId, col, row, cols, rows })),
      );
      expect([...painted]).toEqual([...state.cells]);
      held += state.cells.filter((id) => id !== 0).length;
    }
    expect(held).toBeGreaterThan(300);
  });

  it('derives the same grid, or refuses the same image', () => {
    let checked = 0;
    for (const line of of('grid')) {
      const ours = gridOf(line.width, line.height, line.cellSize);
      const theirs = line.error === 'none' ? { cols: line.gridCols, rows: line.gridRows } : { error: line.error };
      expect(ours, `${line.width}×${line.height} at ${line.cellSize}`).toEqual(theirs);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('refuses the same zones, with the same error', () => {
    const layouts = of('layout');
    expect(layouts.length).toBeGreaterThanOrEqual(14);
    for (const name of ['none', 'InvalidConfig']) {
      expect(layouts.some((l) => l.error === name), name).toBe(true);
    }
    const grid = { cols: 12, rows: 10 };
    for (const line of layouts) {
      const found = layoutProblem(grid, line.zones.map(zoneOf));
      expect(found ? LAYOUT_ERROR[found.problem] : 'none', JSON.stringify(line)).toBe(line.error);
    }
  });

  it('refuses the same terms, with the same error', () => {
    const cases = of('terms');
    expect(cases.length).toBeGreaterThanOrEqual(19);
    for (const name of ['none', 'PayoutBelowPrincipal', 'TakeTooHigh', 'TakeBelowPayout', 'InvalidReversion', 'InvalidConfig']) {
      expect(cases.some((l) => l.error === name), name).toBe(true);
    }
    for (const line of cases) {
      const { kind: _kind, error, ...terms } = line;
      expect(termsError(terms, 500) ?? 'none', JSON.stringify(terms)).toBe(error);
    }
  });

  it('refuses and prices every rectangle as the contract does', () => {
    let current: { state: GridState; now: bigint } | null = null;
    let checked = 0;
    let taking = 0;
    let lowered = 0;
    for (const line of lines) {
      if (line.kind === 'state') {
        current = stateOf(line);
        continue;
      }
      if (line.kind !== 'rect') continue;
      if (!current) throw new Error('a rect line before any state line');
      const { state, now } = current;
      const rect = { col: line.col, row: line.row, cols: line.cols, rows: line.rows };
      const label = `${JSON.stringify(rect)} at ${now}`;
      expect(blockError(state, rect, now), label).toBe(line.error);
      if (line.error === 'none') {
        expect(quote(state, rect, now), label).toBe(BigInt(line.total));
        if (state.priceBps < 10_000) lowered++;
        let held = false;
        for (let r = rect.row; r < rect.row + rect.rows; r++) {
          for (let c = rect.col; c < rect.col + rect.cols; c++) held ||= state.cells[r * state.grid.cols + c] !== 0;
        }
        if (held) taking++;
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(2_000);
    // Rectangles that take sold cells, so agreement is not agreement on free cells only.
    expect(taking).toBeGreaterThan(500);
    // And with free squares cut, where rounding up the free part decides the figure.
    expect(lowered).toBeGreaterThan(300);
  });

  it('refuses and prices the same lists of rectangles, naming the same one', () => {
    let current: { state: GridState; now: bigint } | null = null;
    let checked = 0;
    for (const line of lines) {
      if (line.kind === 'state') {
        current = stateOf(line);
        continue;
      }
      if (line.kind !== 'multi') continue;
      if (!current) throw new Error('a multi line before any state line');
      const rects = line.rects.map(rectOf);
      expect(buyError(current.state, rects, current.now), JSON.stringify(line.rects)).toBe(line.error);
      if (line.error === 'none') expect(quoteBlocks(current.state, rects, current.now)).toBe(BigInt(line.total));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(23);
  });

  it('writes every IPFS address as the renderer does', () => {
    const cids = of('cid');
    expect(cids.filter((l) => l.hash).length).toBe(4);
    expect(cids.filter((l) => l.bytes).length).toBe(6);
    for (const line of cids) {
      const ours = line.hash ? contentHashToCid(line.hash) : cidBytesToString(line.bytes!);
      expect(ours, JSON.stringify(line)).toBe(line.cid);
    }
  });
});
