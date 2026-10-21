import { describe, expect, it } from 'vitest';

import { acceptedPictureSizes, composeBoard, type RgbaPicture } from './image-compose';
import { cellMapFromBlocks } from './image-grid';

/** A picture of one colour. */
function solid(width: number, height: number, [r, g, b, a]: [number, number, number, number]): RgbaPicture {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([r, g, b, a], i * 4);
  return { width, height, rgba };
}

function pixel(out: Uint8ClampedArray, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 4;
  return [...out.slice(at, at + 4)];
}

const GREY: [number, number, number, number] = [100, 100, 100, 255];
const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

/** A 4 × 3 grid of 10 px cells on a 45 × 32 source: a strip no whole cell fits on both axes. */
const grid = { cols: 4, rows: 3 };
const source = solid(45, 32, GREY);

describe('composeBoard (spec §13.9)', () => {
  it('draws each block only on the cells the map still gives it, newest on top', () => {
    const blocks = [
      { tokenId: 1, col: 0, row: 0, cols: 2, rows: 2, picture: solid(20, 20, RED) },
      { tokenId: 2, col: 1, row: 1, cols: 2, rows: 1, picture: solid(20, 10, BLUE) },
    ];
    const cells = cellMapFromBlocks(grid, blocks);
    const out = composeBoard({ source, cellSize: 10, grid, cells, blocks: [...blocks].reverse() });
    expect(pixel(out, 45, 0, 0)).toEqual(RED);
    expect(pixel(out, 45, 19, 9)).toEqual(RED);
    expect(pixel(out, 45, 5, 15)).toEqual(RED); // cell (0,1): block 1's still
    expect(pixel(out, 45, 15, 15)).toEqual(BLUE); // cell (1,1): taken by block 2
    expect(pixel(out, 45, 25, 15)).toEqual(BLUE);
    expect(pixel(out, 45, 35, 15)).toEqual(GREY); // free
    expect(pixel(out, 45, 44, 31)).toEqual(GREY); // the strip is the source's
  });

  /** A taken cell belongs to the taker even when the taker has no picture yet: the source shows. */
  it('never draws a block on a cell the map gives another, pictured or not', () => {
    const blocks = [
      { tokenId: 1, col: 0, row: 0, cols: 2, rows: 1, picture: solid(20, 10, RED) },
      { tokenId: 2, col: 1, row: 0, cols: 1, rows: 1, picture: null },
    ];
    const out = composeBoard({ source, cellSize: 10, grid, cells: cellMapFromBlocks(grid, blocks), blocks });
    expect(pixel(out, 45, 5, 5)).toEqual(RED);
    expect(pixel(out, 45, 15, 5)).toEqual(GREY);
  });

  it('draws nothing for a block without a picture, or with one of another size', () => {
    const blocks = [
      { tokenId: 1, col: 0, row: 0, cols: 1, rows: 1, picture: null },
      { tokenId: 2, col: 1, row: 0, cols: 1, rows: 1, picture: solid(9, 10, RED) },
      { tokenId: 3, col: 2, row: 0, cols: 1, rows: 1, picture: solid(5, 5, RED) },
    ];
    const out = composeBoard({ source, cellSize: 10, grid, cells: cellMapFromBlocks(grid, blocks), blocks });
    expect(pixel(out, 45, 5, 5)).toEqual(GREY);
    expect(pixel(out, 45, 15, 5)).toEqual(GREY);
    expect(pixel(out, 45, 25, 5)).toEqual(RED); // half size is drawn, scaled up
  });

  it('scales a half-size picture up over the whole rectangle', () => {
    // A 3 × 1 block of 10 px cells is 30 × 10; half is 15 × 5. Left half red, right half blue.
    const half = solid(15, 5, BLUE);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) half.rgba.set(RED, (y * 15 + x) * 4);
    const blocks = [{ tokenId: 1, col: 0, row: 2, cols: 3, rows: 1, picture: half }];
    const out = composeBoard({ source, cellSize: 10, grid, cells: cellMapFromBlocks(grid, blocks), blocks });
    expect(pixel(out, 45, 0, 20)).toEqual(RED);
    expect(pixel(out, 45, 13, 29)).toEqual(RED);
    expect(pixel(out, 45, 14, 20)).toEqual(BLUE);
    expect(pixel(out, 45, 29, 29)).toEqual(BLUE);
  });

  it('lays transparency over the source, straight alpha', () => {
    const blocks = [{ tokenId: 1, col: 0, row: 0, cols: 1, rows: 1, picture: solid(10, 10, [255, 0, 0, 128]) }];
    const out = composeBoard({ source, cellSize: 10, grid, cells: cellMapFromBlocks(grid, blocks), blocks });
    // 255 × 128/255 + 100 × (1 − 128/255) = 177.8; 100 × 127/255 = 49.8.
    expect(pixel(out, 45, 0, 0)).toEqual([178, 50, 50, 255]);
    const clear = [{ tokenId: 1, col: 0, row: 0, cols: 1, rows: 1, picture: solid(10, 10, [255, 0, 0, 0]) }];
    expect(pixel(composeBoard({ source, cellSize: 10, grid, cells: cellMapFromBlocks(grid, clear), blocks: clear }), 45, 0, 0)).toEqual(GREY);
  });

  it('leaves the source it was given untouched', () => {
    const before = [...source.rgba];
    const blocks = [{ tokenId: 1, col: 0, row: 0, cols: 1, rows: 1, picture: solid(10, 10, RED) }];
    composeBoard({ source, cellSize: 10, grid, cells: cellMapFromBlocks(grid, blocks), blocks });
    expect([...source.rgba]).toEqual(before);
  });

  it('halves each side rounded, never below a pixel', () => {
    expect(acceptedPictureSizes({ width: 30, height: 10 })[1]).toEqual({ width: 15, height: 5 });
    expect(acceptedPictureSizes({ width: 15, height: 15 })[1]).toEqual({ width: 8, height: 8 });
    expect(acceptedPictureSizes({ width: 1, height: 1 })[1]).toEqual({ width: 1, height: 1 });
  });
});
