/**
 * What the reference renderer page reads (`docs/IMAGE-BOARD-SPEC.md` §13.9), with no DOM: the page's
 * address, the board at one chain block, and pictures fetched from IPFS and checked against their
 * hashes. `page.ts` draws; this decides what is drawn from.
 *
 * **The page is fixed for every board of an implementation** (its address is a renderer deploy
 * argument), so it trusts nothing it is served: the chain over a public RPC, never a keyed one, and
 * every picture's bytes against the hash the chain holds — a gateway that answers with other bytes
 * draws nothing, the source shows there.
 */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';

import { CHAINS } from '../src/chains';
import { cidBytesToString, contentHashToCid } from '../src/content';
import { cellMapFromBlocks, type CellMap, type Grid, type Rect } from '../src/image-grid';

/** Multicall3, at its canonical address on both Robinhood chains (measured with `eth_getCode`). */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Calls per `aggregate3`: a board of 10,000 blocks is 50 requests, none near a node's gas cap. */
export const CALLS_PER_BATCH = 400;

/**
 * Public gateways, tried in order after the one serving the page. Each answers CORS `*`; a picture
 * is accepted from whichever answers first with bytes matching its hash.
 */
export const GATEWAYS: readonly string[] = ['https://ipfs.io', 'https://dweb.link', 'https://w3s.link', 'https://gateway.pinata.cloud'];

const ZERO_HASH: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

const MULTICALL_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/** The board's reads this page makes, and nothing else: the full ABI would be most of the page. */
const BOARD_ABI = [
  { type: 'function', name: 'width', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'height', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'cellSize', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'gridCols', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'gridRows', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'imageHash', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'sourceCid', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'blockCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'blockOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'col', type: 'uint16' },
          { name: 'row', type: 'uint16' },
          { name: 'cols', type: 'uint16' },
          { name: 'rows', type: 'uint16' },
          { name: 'version', type: 'uint32' },
          { name: 'level', type: 'uint96' },
          { name: 'boughtAt', type: 'uint40' },
          { name: 'cellsLeft', type: 'uint24' },
          { name: 'contentHash', type: 'bytes32' },
        ],
      },
    ],
  },
  { type: 'function', name: 'shownHash', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
] as const;

type BoardRead = (typeof BOARD_ABI)[number]['name'];

/** What the page was asked to draw: the renderer writes `?chain=<id>&board=<address>[&block=<id>]`. */
export interface PageParams {
  chain: number;
  board: Address;
  /** One block's squares still showing; null for the whole board. */
  block: bigint | null;
}

/** The page's query string, or null for one the renderer would never write. */
export function pageParams(search: string): PageParams | null {
  const q = new URLSearchParams(search);
  const chain = q.get('chain') ?? '';
  const board = q.get('board') ?? '';
  const block = q.get('block');
  if (!/^[1-9][0-9]*$/.test(chain) || !/^0x[0-9a-fA-F]{40}$/.test(board)) return null;
  if (block !== null && !/^[1-9][0-9]*$/.test(block)) return null;
  return { chain: Number(chain), board: board as Address, block: block === null ? null : BigInt(block) };
}

/** The public endpoint of a chain this SDK names, or null: the page reads no chain it cannot name. */
export function rpcUrlFor(chain: number): string | null {
  return CHAINS[chain]?.rpcUrl ?? null;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** One JSON-RPC call. A node's error (a revert) is thrown with its message. */
export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export function rpcOver(url: string, fetchFn: Fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`rpc answered ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`rpc: ${body.error.message ?? 'error'}`);
    return body.result;
  };
}

export interface DrawnBlock extends Rect {
  tokenId: number;
  /** The picture the board shows for it; null for none yet. */
  shownHash: Hex | null;
}

/** A board as §13.9 draws it, every field read at the same chain block `at`. */
export interface DrawnBoard {
  at: bigint;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  grid: Grid;
  imageHash: Hex;
  /** The source image's IPFS address (`b…`). */
  sourceCid: string;
  blocks: DrawnBlock[];
  cells: CellMap;
}

interface Call {
  fn: BoardRead;
  args?: readonly [bigint];
}

/** Board reads through Multicall3 at block `at`, in batches; any failed read fails the whole read. */
async function readAll(rpc: Rpc, board: Address, at: Hex, calls: readonly Call[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < calls.length; i += CALLS_PER_BATCH) {
    const batch = calls.slice(i, i + CALLS_PER_BATCH);
    const data = encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: 'aggregate3',
      args: [batch.map((c) => ({ target: board, allowFailure: false, callData: encodeFunctionData({ abi: BOARD_ABI, functionName: c.fn, args: c.args } as never) }))],
    });
    const raw = (await rpc('eth_call', [{ to: MULTICALL3, data }, at])) as Hex;
    const results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: raw });
    results.forEach((r, j) => out.push(decodeFunctionResult({ abi: BOARD_ABI, functionName: batch[j]!.fn, data: r.returnData } as never)));
  }
  return out;
}

/**
 * The board at the chain's current block (spec §13.9 step 1). The cell map is painted from the
 * blocks (`cellMapFromBlocks`, which IS the contract's map), so no `cellRow` read is needed.
 */
export async function readDrawnBoard(rpc: Rpc, board: Address): Promise<DrawnBoard> {
  const at = (await rpc('eth_blockNumber', [])) as Hex;
  const head = await readAll(rpc, board, at, [
    { fn: 'name' },
    { fn: 'width' },
    { fn: 'height' },
    { fn: 'cellSize' },
    { fn: 'gridCols' },
    { fn: 'gridRows' },
    { fn: 'imageHash' },
    { fn: 'sourceCid' },
    { fn: 'blockCount' },
  ]);
  const [name, width, height, cellSize, cols, rows, imageHash, sourceCid, blockCount] = head as [string, number, number, number, number, number, Hex, Hex, bigint];
  const ids = Array.from({ length: Number(blockCount) }, (_, i) => BigInt(i + 1));
  const reads = await readAll(
    rpc,
    board,
    at,
    ids.flatMap((id): Call[] => [
      { fn: 'blockOf', args: [id] },
      { fn: 'shownHash', args: [id] },
    ]),
  );
  const blocks = ids.map((id, i): DrawnBlock => {
    const shape = reads[2 * i] as { col: number; row: number; cols: number; rows: number };
    const shown = reads[2 * i + 1] as Hex;
    return { tokenId: Number(id), col: shape.col, row: shape.row, cols: shape.cols, rows: shape.rows, shownHash: shown === ZERO_HASH ? null : shown };
  });
  const grid = { cols, rows };
  return { at: BigInt(at), name, width, height, cellSize, grid, imageHash, sourceCid: cidBytesToString(sourceCid), blocks, cells: cellMapFromBlocks(grid, blocks) };
}

/** A block picture's IPFS address: its hash IS a raw block's CID (spec §13.7). */
export function pictureCid(hash: Hex): string {
  return contentHashToCid(hash);
}

/**
 * Where to fetch from: the gateway serving this page first (a path gateway, `/ipfs/<cid>/…`, or a
 * subdomain one, `<cid>.ipfs.<host>`), then `GATEWAYS`. Anything else serving the page — a
 * marketplace's proxy, a local file — is not asked.
 */
export function gatewaysFor(location: { protocol: string; host: string; pathname: string }): string[] {
  const own: string[] = [];
  if (location.protocol === 'https:' || location.protocol === 'http:') {
    if (location.pathname.startsWith('/ipfs/')) own.push(`${location.protocol}//${location.host}`);
    const sub = /^[a-z0-9]+\.ipfs\.(.+)$/.exec(location.host);
    if (sub) own.push(`${location.protocol}//${sub[1]}`);
  }
  return [...new Set([...own, ...GATEWAYS])];
}

export type Sha256 = (bytes: Uint8Array<ArrayBuffer>) => Promise<Hex>;

/** Per gateway; a gateway that has not found a picture in this long is passed over. */
export const GATEWAY_TIMEOUT_MS = 15_000;

/**
 * The bytes at `cid` whose `sha256` is `hash`, from the first gateway that serves them, or null when
 * none does. A gateway answering other bytes is passed over like one that failed.
 */
export async function fetchVerified(cid: string, hash: Hex, gateways: readonly string[], fetchFn: Fetch, sha256: Sha256): Promise<Uint8Array<ArrayBuffer> | null> {
  for (const gateway of gateways) {
    try {
      const res = await fetchFn(`${gateway}/ipfs/${cid}`, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await sha256(bytes)).toLowerCase() === hash.toLowerCase()) return bytes;
    } catch {
      // the next gateway
    }
  }
  return null;
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
