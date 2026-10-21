/**
 * The drawn board (`docs/IMAGE-BOARD-SPEC.md` §13.9): what every renderer draws, in TypeScript, on
 * raw RGBA. Decoding a picture and checking its bytes against its hash are the caller's (a browser
 * decodes one way, a server another); this is the part every renderer must agree on — which pixels
 * each block's picture covers, at what size, and how it is laid over what is under it.
 *
 * 1. Start from the source image, all of it, the strip no whole cell fits included.
 * 2. For every block, for every cell the cell map gives it, lay its shown picture over
 *    that cell's pixels, source-over with straight (unpremultiplied) alpha. The picture covers the
 *    block's whole rectangle, at exactly the rectangle's size in pixels or at half of each side
 *    (rounded, at least 1) scaled up to it.
 * 3. A block with no picture, or one of any other size, is not drawn: the source shows there.
 *
 * **The scaling filter is the renderer's** (spec §13.9): here it is nearest-neighbour, the one any
 * runtime can reproduce exactly. Two renderers may differ on a half-size picture; at full size, and
 * on which pixels a block covers, they may not.
 *
 * Dependency-free on purpose: the reference renderer page and a server both run it.
 */
import type { CellMap, Grid, Rect } from './image-grid';

/** Pixels, row-major, four bytes each, straight alpha. */
export interface RgbaPicture {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

export interface ComposedBlock extends Rect {
  /** The block's id: the cell map names cells by it. */
  tokenId: number;
  /** Its SHOWN picture, decoded and checked against its hash by the caller; null for none. */
  picture: RgbaPicture | null;
}

/** A block's rectangle in pixels. */
export function blockBox(rect: Pick<Rect, 'cols' | 'rows'>, cellSize: number): { width: number; height: number } {
  return { width: rect.cols * cellSize, height: rect.rows * cellSize };
}

/** The two sizes a block's picture may be: its rectangle's, or half of each side rounded (at least 1). */
export function acceptedPictureSizes(box: { width: number; height: number }): [{ width: number; height: number }, { width: number; height: number }] {
  return [box, { width: Math.max(1, Math.round(box.width / 2)), height: Math.max(1, Math.round(box.height / 2)) }];
}

/**
 * The board as drawn: a new RGBA buffer the source's size. `blocks` in any order: the cell map gives
 * each cell to one block, so no two pictures meet on a pixel and the order cannot matter (the spec's
 * "in id order" is how the map is painted, `cellMapFromBlocks`). A picture whose size is neither of
 * `acceptedPictureSizes` is skipped, as spec §13.9 says.
 */
export function composeBoard(o: {
  source: RgbaPicture;
  cellSize: number;
  grid: Grid;
  cells: CellMap;
  blocks: readonly ComposedBlock[];
}): Uint8ClampedArray {
  const { source, cellSize, grid, cells } = o;
  if (source.rgba.length !== source.width * source.height * 4) throw new Error('image compose: the source is not width × height RGBA');
  if (cells.length !== grid.cols * grid.rows) throw new Error('image compose: the cell map is not the grid');
  const out = new Uint8ClampedArray(source.rgba);
  for (const block of o.blocks) {
    const picture = block.picture;
    if (!picture) continue;
    const box = blockBox(block, cellSize);
    const [full, half] = acceptedPictureSizes(box);
    const isFull = picture.width === full.width && picture.height === full.height;
    const isHalf = picture.width === half.width && picture.height === half.height;
    if (!isFull && !isHalf) continue;
    if (picture.rgba.length !== picture.width * picture.height * 4) continue;
    const left = block.col * cellSize;
    const top = block.row * cellSize;
    for (let y = 0; y < box.height; y++) {
      const cellRow = block.row + Math.floor(y / cellSize);
      const sy = isFull ? y : Math.min(picture.height - 1, Math.floor((y * picture.height) / box.height));
      for (let x = 0; x < box.width; x++) {
        const cellCol = block.col + Math.floor(x / cellSize);
        if (cells[cellRow * grid.cols + cellCol] !== block.tokenId) continue;
        const sx = isFull ? x : Math.min(picture.width - 1, Math.floor((x * picture.width) / box.width));
        const s = (sy * picture.width + sx) * 4;
        const d = ((top + y) * source.width + left + x) * 4;
        blend(out, d, picture.rgba, s);
      }
    }
  }
  return out;
}

/** Source-over, straight alpha, rounded to the nearest unit — the platform's regenerator's own blend. */
function blend(out: Uint8ClampedArray, d: number, src: Uint8Array | Uint8ClampedArray, s: number): void {
  const a = src[s + 3]!;
  if (a === 255) {
    out[d] = src[s]!;
    out[d + 1] = src[s + 1]!;
    out[d + 2] = src[s + 2]!;
    out[d + 3] = 255;
    return;
  }
  const sa = a / 255;
  const da = out[d + 3]! / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  for (let c = 0; c < 3; c++) out[d + c] = Math.round((src[s + c]! * sa + out[d + c]! * da * (1 - sa)) / oa);
  out[d + 3] = Math.round(oa * 255);
}
