import { decodeFunctionData, encodeFunctionResult, sha256, toHex, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { IMAGE_BOARD_ABI, cellMapFromBlocks, cidBytesToString } from '../src/image-boards';

import {
  CALLS_PER_BATCH,
  GATEWAYS,
  MULTICALL3,
  fetchVerified,
  gatewaysFor,
  mapLimit,
  pageParams,
  readDrawnBoard,
  rpcUrlFor,
  type Fetch,
  type Rpc,
} from './board-read';

const BOARD: Address = '0x00000000000000000000000000000000000b0a2d';
const ZERO: Hex = `0x${'00'.repeat(32)}`;

describe('pageParams — what the renderer contract writes, and nothing else', () => {
  it('reads the board and the block', () => {
    expect(pageParams(`?chain=46630&board=${BOARD}`)).toEqual({ chain: 46630, board: BOARD, block: null });
    expect(pageParams(`?chain=4663&board=${BOARD}&block=12`)).toEqual({ chain: 4663, board: BOARD, block: 12n });
  });

  it('refuses an address the renderer would never write', () => {
    expect(pageParams('')).toBeNull();
    expect(pageParams(`?board=${BOARD}`)).toBeNull();
    expect(pageParams(`?chain=0&board=${BOARD}`)).toBeNull();
    expect(pageParams(`?chain=46630&board=0x1234`)).toBeNull();
    expect(pageParams(`?chain=46630&board=${BOARD}&block=0`)).toBeNull();
    expect(pageParams(`?chain=46630&board=${BOARD}&block=`)).toBeNull();
    expect(pageParams(`?chain=46630&board=${BOARD}&block=1e3`)).toBeNull();
  });

  it('reads only chains the SDK names, by their public endpoint', () => {
    expect(rpcUrlFor(46630)).toBe('https://rpc.testnet.chain.robinhood.com');
    expect(rpcUrlFor(4663)).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(rpcUrlFor(1)).toBeNull();
  });
});

describe('gatewaysFor — the gateway serving the page first', () => {
  it('a path gateway', () => {
    expect(gatewaysFor({ protocol: 'https:', host: 'example.net', pathname: '/ipfs/bafy/' })).toEqual(['https://example.net', ...GATEWAYS]);
  });

  it('a subdomain gateway', () => {
    // One already listed moves to the front rather than being asked twice.
    expect(gatewaysFor({ protocol: 'https:', host: 'bafyabc.ipfs.dweb.link', pathname: '/' })).toEqual(['https://dweb.link', 'https://ipfs.io', 'https://w3s.link', 'https://gateway.pinata.cloud']);
    expect(gatewaysFor({ protocol: 'https:', host: 'bafyabc.ipfs.example.net', pathname: '/' })).toEqual(['https://example.net', ...GATEWAYS]);
  });

  it('nothing else: a marketplace proxy or a local file is not asked', () => {
    expect(gatewaysFor({ protocol: 'https:', host: 'proxy.example', pathname: '/render/abc' })).toEqual(GATEWAYS);
    expect(gatewaysFor({ protocol: 'file:', host: '', pathname: '/ipfs/x/index.html' })).toEqual(GATEWAYS);
  });
});

const digest = async (bytes: Uint8Array): Promise<Hex> => sha256(bytes);

describe('fetchVerified — bytes are accepted only against their hash', () => {
  const good = new TextEncoder().encode('the picture');
  const hash = sha256(good);

  it('passes over a gateway answering other bytes, and one that fails', async () => {
    const asked: string[] = [];
    const fetchFn: Fetch = async (url) => {
      asked.push(url);
      if (url.startsWith('https://a')) return new Response('other bytes');
      if (url.startsWith('https://b')) throw new Error('offline');
      if (url.startsWith('https://c')) return new Response('', { status: 504 });
      return new Response(good);
    };
    const bytes = await fetchVerified('bafkcid', hash, ['https://a', 'https://b', 'https://c', 'https://d'], fetchFn, digest);
    expect(bytes && new TextDecoder().decode(bytes)).toBe('the picture');
    expect(asked).toEqual(['https://a/ipfs/bafkcid', 'https://b/ipfs/bafkcid', 'https://c/ipfs/bafkcid', 'https://d/ipfs/bafkcid']);
  });

  it('is null when no gateway serves the bytes', async () => {
    expect(await fetchVerified('bafkcid', hash, ['https://a'], async () => new Response('other'), digest)).toBeNull();
  });

  it('stops at the first match', async () => {
    let calls = 0;
    await fetchVerified('bafkcid', hash, ['https://a', 'https://b'], async () => (calls++, new Response(good)), digest);
    expect(calls).toBe(1);
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit', async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(most).toBe(3);
  });
});

/**
 * A node that answers Multicall3 from a board described in memory, decoding every inner call with
 * the board's FULL ABI — so the page's hand-picked subset is checked against the real one.
 */
function fakeNode(blocks: { col: number; row: number; cols: number; rows: number; shown: Hex }[]) {
  const tags: unknown[] = [];
  let ethCalls = 0;
  const answer = (fn: string, args: readonly unknown[]): unknown => {
    switch (fn) {
      case 'name':
        return 'Board "one"';
      case 'width':
        return 205;
      case 'height':
        return 100;
      case 'cellSize':
        return 10;
      case 'gridCols':
        return 20;
      case 'gridRows':
        return 10;
      case 'imageHash':
        return sha256(toHex('source'));
      case 'sourceCid':
        return '0x01701220aa';
      case 'blockCount':
        return BigInt(blocks.length);
      case 'blockOf': {
        const b = blocks[Number(args[0]) - 1]!;
        return { ...b, version: 1, level: 0n, boughtAt: 0, cellsLeft: 1, contentHash: ZERO };
      }
      case 'shownHash':
        return blocks[Number(args[0]) - 1]!.shown;
    }
    throw new Error(`unexpected read ${fn}`);
  };
  const multicallAbi = [
    {
      type: 'function',
      name: 'aggregate3',
      stateMutability: 'payable',
      inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }],
      outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
    },
  ] as const;
  const rpc: Rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x2a';
    if (method !== 'eth_call') throw new Error(method);
    ethCalls++;
    const [call, tag] = params as [{ to: Address; data: Hex }, unknown];
    tags.push(tag);
    expect(call.to).toBe(MULTICALL3);
    const { args } = decodeFunctionData({ abi: multicallAbi, data: call.data });
    const inner = args[0];
    expect(inner.length).toBeLessThanOrEqual(CALLS_PER_BATCH);
    const results = inner.map((c) => {
      expect(c.target.toLowerCase()).toBe(BOARD);
      expect(c.allowFailure).toBe(false);
      const d = decodeFunctionData({ abi: IMAGE_BOARD_ABI, data: c.callData });
      const value = answer(d.functionName, d.args ?? []);
      return { success: true, returnData: encodeFunctionResult({ abi: IMAGE_BOARD_ABI as Abi, functionName: d.functionName, result: value } as never) };
    });
    return encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: results });
  };
  return { rpc, tags, ethCalls: () => ethCalls };
}

describe('readDrawnBoard — the board at one chain block', () => {
  /** 201 blocks are 402 reads: the batch boundary falls between a block's two reads. */
  const blocks = Array.from({ length: 201 }, (_, i) => ({
    col: i % 20,
    row: Math.floor(i / 20) % 10,
    cols: 1,
    rows: 1,
    shown: i % 3 === 0 ? ZERO : sha256(toHex(`picture ${i}`)),
  }));

  it('reads every block across batches, all at the same block', async () => {
    const node = fakeNode(blocks);
    const board = await readDrawnBoard(node.rpc, BOARD);
    expect(node.ethCalls()).toBe(1 + Math.ceil((2 * blocks.length) / CALLS_PER_BATCH));
    expect(new Set(node.tags)).toEqual(new Set(['0x2a']));
    expect(board.at).toBe(42n);
    expect(board).toMatchObject({ name: 'Board "one"', width: 205, height: 100, cellSize: 10, grid: { cols: 20, rows: 10 }, sourceCid: cidBytesToString('0x01701220aa') });
    expect(board.blocks).toHaveLength(201);
    expect(board.blocks[200]).toEqual({ tokenId: 201, col: 0, row: 0, cols: 1, rows: 1, shownHash: blocks[200]!.shown });
    // No picture yet reads as none, never as the zero hash's CID.
    expect(board.blocks[0]!.shownHash).toBeNull();
    // The cell map is the chain's: later blocks cover earlier ones.
    expect(board.cells[0]).toBe(201);
    expect(Array.from(board.cells)).toEqual(Array.from(cellMapFromBlocks(board.grid, board.blocks)));
  });

  it('a board with no blocks is one batch', async () => {
    const node = fakeNode([]);
    const board = await readDrawnBoard(node.rpc, BOARD);
    expect(node.ethCalls()).toBe(1);
    expect(board.blocks).toEqual([]);
  });
});
