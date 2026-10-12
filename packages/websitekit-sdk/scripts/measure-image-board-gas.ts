/**
 * Gas per image-board operation, measured from real receipts on a local anvil
 * (`docs/IMAGE-BOARD-SPEC.md`). Prints a table and a fit; writes nothing.
 *
 *   forge build   # in packages/websitekit-contracts
 *   pnpm --filter @websitekit/sdk exec tsx scripts/measure-image-board-gas.ts
 *
 * Receipts, not `gasleft()` in a Foundry test, so every figure includes the 21,000 intrinsic cost,
 * calldata and cold access — what a wallet is actually charged on L2 execution. On an Orbit chain
 * the fee also carries an L1 data component that this does not see; it is per-byte of calldata and
 * a buy's calldata is fixed-size, so it does not change with the block's size.
 *
 * A buy writes one storage word per ROW of the block, so its cost should be driven by rows and
 * barely by columns. The scenarios are chosen to show that: tall and wide blocks of equal cell
 * count, and rows that are fresh against rows another block already touched (a zero→nonzero write
 * costs 20,000 more than a nonzero→nonzero one).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');
const PORT = 8896;
const RPC = `http://127.0.0.1:${PORT}`;

const RELAYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BUYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const OTHER = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const SELLER = '0x7099000000000000000000000000000000005e11' as Address;
const PROTOCOL = '0x000000000000000000000000000000000000dEaD' as Address;
const USD_NAME = 'websitekit Test Dollar';

function artifact(solFile: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(path.join(contractsOut, solFile, `${name}.json`), 'utf-8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}

const usdArt = artifact('TestUSD.sol', 'TestUSD');
const boardArt = artifact('ImageBoard.sol', 'ImageBoard');
const collectionArt = artifact('ImageBoardCollection.sol', 'ImageBoardCollection');

const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC) });

async function send(
  account: typeof RELAYER,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
): Promise<bigint> {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain: foundry } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
  return receipt.gasUsed;
}

async function deploy(art: { abi: Abi; bytecode: Hex }, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ ...art, account: RELAYER, chain: foundry, args } as never);
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
}

let usd: Address;
let collection: Address;

/** The largest board the contract allows: 256 cells across, 1,000 down. */
async function freshBoard(): Promise<{ board: Address; gas: bigint }> {
  const args = [
    SELLER,
    {
      settlementToken: usd,
      width: 2560,
      height: 10_000,
      cellSize: 10,
      cellPrice: 10_000n,
      imageHash: keccak256(toHex('img')),
      zones: [],
      kept: [],
    },
  ] as const;
  const { result } = await publicClient.simulateContract({
    address: collection,
    abi: collectionArt.abi,
    functionName: 'createBoardFor',
    args,
    account: RELAYER,
  } as never);
  const gas = await send(RELAYER, collection, collectionArt.abi, 'createBoardFor', args);
  const [board] = result as [Address, bigint];
  for (const who of [BUYER, OTHER]) {
    await send(who, usd, usdArt.abi, 'approve', [board, 2n ** 255n]);
  }
  return { board, gas };
}

/** The usual state: someone has bought before, so the board's ledgers are already nonzero. */
async function warmedBoard(): Promise<Address> {
  const { board } = await freshBoard();
  await send(OTHER, board, boardArt.abi, 'buyBlocks', [OTHER.address, [{ col: 255, row: 999, cols: 1, rows: 1 }]]);
  return board;
}

const buy = (board: Address, col: number, row: number, cols: number, rows: number) =>
  send(BUYER, board, boardArt.abi, 'buyBlocks', [BUYER.address, [{ col, row, cols, rows }]]);

async function permitBuy(board: Address, col: number, row: number, cols: number, rows: number) {
  const total = (await publicClient.readContract({
    address: board,
    abi: boardArt.abi,
    functionName: 'quote',
    args: [col, row, cols, rows],
  } as never)) as bigint;
  const nonce = (await publicClient.readContract({
    address: usd,
    abi: usdArt.abi,
    functionName: 'nonces',
    args: [BUYER.address],
  } as never)) as bigint;
  const deadline = 2n ** 40n;
  const sig = await BUYER.signTypedData({
    domain: { name: USD_NAME, version: '1', chainId: foundry.id, verifyingContract: usd },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: BUYER.address, spender: board, value: total, nonce, deadline },
  });
  // A permit buy only makes sense without a standing allowance.
  await send(BUYER, usd, usdArt.abi, 'approve', [board, 0n]);
  return send(BUYER, board, boardArt.abi, 'buyBlocksWithPermit', [
    BUYER.address,
    [{ col, row, cols, rows }],
    total,
    deadline,
    parseInt(sig.slice(130, 132), 16),
    sig.slice(0, 66) as Hex,
    `0x${sig.slice(66, 130)}` as Hex,
  ]);
}

const rows: { what: string; cols: number; rows: number; gas: bigint }[] = [];
const record = (what: string, c: number, r: number, gas: bigint) => rows.push({ what, cols: c, rows: r, gas });

async function main() {
  const anvil: ChildProcess = spawn('anvil', ['--port', String(PORT), '--silent', '--gas-limit', '2000000000'], {
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    usd = await deploy(usdArt, [USD_NAME, 'tUSD', 6]);
    const implementation = await deploy(boardArt, [500n, PROTOCOL]);
    collection = await deploy(collectionArt, ['Gas Image Boards', 'GIMG', RELAYER.address, implementation, [usd], 'https://example.com/b/']);
    for (const who of [BUYER, OTHER]) {
      await send(RELAYER, usd, usdArt.abi, 'mint', [who.address, 1_000_000n * 10n ** 6n]);
    }

    // Creation, and the very first buy on a board (every ledger slot goes zero → nonzero).
    const created = await freshBoard();
    record('createBoardFor', 0, 0, created.gas);
    record('first buy on a new board', 1, 1, await buy(created.board, 0, 0, 1, 1));

    // Fresh rows, on a board that has sold before.
    const shapes: [number, number][] = [
      [1, 1], [2, 2], [5, 5], [10, 10], [20, 20], [30, 67], [50, 50], [100, 100],
      [256, 1], [256, 10], [1, 256], [10, 100], [10, 500],
    ];
    // The whole largest grid leaves no cell to warm the board with, so it is a first buy.
    record('first buy, the whole largest grid', 256, 1000, await buy((await freshBoard()).board, 0, 0, 256, 1000));
    for (const [c, r] of shapes) {
      const board = await warmedBoard();
      record('buy, fresh rows', c, r, await buy(board, 0, 0, c, r));
      // The same rows again, beside it: every row word is already nonzero.
      if (2 * c <= 256) record('buy, rows already touched', c, r, await buy(board, c, 0, c, r));
    }

    for (const [c, r] of [[1, 1], [10, 10], [10, 100]] as [number, number][]) {
      const board = await warmedBoard();
      record('buyBlocksWithPermit, fresh rows', c, r, await permitBuy(board, 0, 0, c, r));
    }

    // Holder operations, on block 2 (the buyer's).
    const board = await warmedBoard();
    await buy(board, 0, 0, 3, 3);
    const hash = keccak256(toHex('picture'));
    record('edit, first write', 3, 3, await send(BUYER, board, boardArt.abi, 'edit', [2n, hash]));
    record('edit, later write', 3, 3, await send(BUYER, board, boardArt.abi, 'edit', [2n, keccak256(toHex('p2'))]));
    record('setEditor', 3, 3, await send(BUYER, board, boardArt.abi, 'setEditor', [2n, RELAYER.address]));
    record(
      'transferBlock (deletes the grant)',
      3,
      3,
      await send(BUYER, board, boardArt.abi, 'transferBlock', [2n, OTHER.address]),
    );
    record('withdrawFor (seller)', 0, 0, await send(RELAYER, board, boardArt.abi, 'withdrawFor', [SELLER]));
  } finally {
    anvil.kill();
  }

  console.log('| operation | block | gas |');
  console.log('|---|---|---:|');
  for (const r of rows) {
    const shape = r.cols ? `${r.cols}×${r.rows} (${r.cols * r.rows} cells)` : '';
    console.log(`| ${r.what} | ${shape} | ${r.gas.toLocaleString('en-US')} |`);
  }

  // Least squares, gas = a + b·rows, over each kind of buy.
  for (const kind of ['buy, fresh rows', 'buy, rows already touched']) {
    const pts = rows.filter((r) => r.what === kind).map((r) => [r.rows, Number(r.gas)] as const);
    const n = pts.length;
    const sx = pts.reduce((s, [x]) => s + x, 0);
    const sy = pts.reduce((s, [, y]) => s + y, 0);
    const sxx = pts.reduce((s, [x]) => s + x * x, 0);
    const sxy = pts.reduce((s, [x, y]) => s + x * y, 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a = (sy - b * sx) / n;
    const worst = Math.max(...pts.map(([x, y]) => Math.abs(y - (a + b * x))));
    console.log(`\n${kind}: gas ≈ ${Math.round(a)} + ${Math.round(b)} × rows   (worst residual ${Math.round(worst)})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
