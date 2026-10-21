/**
 * The reference renderer page (`docs/IMAGE-BOARD-SPEC.md` §13.9): one self-contained HTML file,
 * pinned on IPFS, whose address every board's metadata names as `animation_url`. Given
 * `?chain=<id>&board=<address>` it draws the board; with `&block=<id>`, that block's squares still
 * showing, at the block's own size.
 *
 * It needs only the chain and IPFS: `board-read.ts` reads the board at one chain block over the
 * chain's public RPC and fetches every picture by its hash; `composeBoard` (the SDK's) lays them
 * over the source. A picture that cannot be fetched or does not match its hash is not drawn, and
 * the source shows there; a source that cannot be fetched leaves the blocks on nothing.
 */
import type { Hex } from 'viem';

import { composeBoard, type ComposedBlock, type RgbaPicture } from '../src/image-compose';
import { fetchVerified, gatewaysFor, mapLimit, pageParams, pictureCid, readDrawnBoard, rpcOver, rpcUrlFor, type DrawnBoard } from './board-read';

/** Pictures fetched at once: a browser allows about six connections to a host. */
const FETCHES_AT_ONCE = 6;

const status = document.getElementById('status')!;
const canvas = document.getElementById('board') as HTMLCanvasElement;

function say(words: string): void {
  status.textContent = words;
  status.hidden = words === '';
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Hex> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Straight-alpha RGBA, or null for bytes no decoder here reads. */
async function decode(bytes: Uint8Array<ArrayBuffer>): Promise<RgbaPicture | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const g = c.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { width: c.width, height: c.height, rgba: g.getImageData(0, 0, c.width, c.height).data };
  } catch {
    return null;
  }
}

async function picture(cid: string, hash: Hex, gateways: readonly string[]): Promise<RgbaPicture | null> {
  const bytes = await fetchVerified(cid, hash, gateways, (url, init) => fetch(url, init), sha256);
  return bytes ? decode(bytes) : null;
}

function draw(width: number, height: number, rgba: Uint8ClampedArray): void {
  canvas.width = width;
  canvas.height = height;
  // Both callers allocate a fresh buffer, never a shared one.
  canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  canvas.hidden = false;
}

/** One block's squares still showing, cut from the drawn board: every other pixel left clear. */
function cutBlock(board: DrawnBoard, drawn: Uint8ClampedArray, tokenId: number): { width: number; height: number; rgba: Uint8ClampedArray } {
  const block = board.blocks[tokenId - 1]!;
  const s = board.cellSize;
  const width = block.cols * s;
  const height = block.rows * s;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const cellRow = block.row + Math.floor(y / s);
    for (let x = 0; x < width; x++) {
      if (board.cells[cellRow * board.grid.cols + block.col + Math.floor(x / s)] !== tokenId) continue;
      const from = ((block.row * s + y) * board.width + block.col * s + x) * 4;
      out.set(drawn.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba: out };
}

async function main(): Promise<void> {
  const params = pageParams(location.search);
  const rpcUrl = params && rpcUrlFor(params.chain);
  if (!params || !rpcUrl) return say('This address names no board.');
  say('Reading the board…');
  const board = await readDrawnBoard(rpcOver(rpcUrl, (url, init) => fetch(url, init)), params.board);
  document.title = params.block === null ? board.name : `${board.name} #${params.block}`;
  if (params.block !== null && params.block > BigInt(board.blocks.length)) return say('This block has not been sold.');

  const gateways = gatewaysFor(location);
  // A block alone needs only its own picture; the source shows under it wherever it is clear.
  const wanted = params.block === null ? board.blocks : [board.blocks[Number(params.block) - 1]!];
  say('Fetching pictures…');
  const [source, pictures] = await Promise.all([
    picture(board.sourceCid, board.imageHash, gateways),
    mapLimit(wanted, FETCHES_AT_ONCE, (b) => (b.shownHash ? picture(pictureCid(b.shownHash), b.shownHash, gateways) : Promise.resolve(null))),
  ]);
  // The board is its declared size: a source of any other size is not the one it was made from.
  const base: RgbaPicture =
    source && source.width === board.width && source.height === board.height
      ? source
      : { width: board.width, height: board.height, rgba: new Uint8ClampedArray(board.width * board.height * 4) };
  const blocks: ComposedBlock[] = wanted.map((b, i) => ({ tokenId: b.tokenId, col: b.col, row: b.row, cols: b.cols, rows: b.rows, picture: pictures[i]! }));
  const drawn = composeBoard({ source: base, cellSize: board.cellSize, grid: board.grid, cells: board.cells, blocks });
  if (params.block === null) {
    draw(board.width, board.height, drawn);
  } else {
    const cut = cutBlock(board, drawn, Number(params.block));
    draw(cut.width, cut.height, cut.rgba);
  }
  say('');
  document.documentElement.dataset.drawn = String(board.at);
}

main().catch(() => say('This board could not be read.'));
