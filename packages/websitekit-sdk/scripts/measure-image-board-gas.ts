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
 * Since takeovers (2026-10-14) a buy writes a block id per cell, eight cells to a storage word, so
 * its cost is driven by the WORDS it writes — fresh (zero → nonzero, ~20,000 more) or already
 * touched — plus, for every block it takes cells from, a credit, a count and an event. The
 * scenarios separate those: fresh and touched words in every shape, takes over 1 to 88 blocks whose
 * owners have nothing credited or something, young and a year old (reversion's loop runs per week),
 * listed or not, a board with 512 zones, several areas in one buy, and a permit. It ends with the
 * formula `lib/image-board-gas.ts` uses, checked against every receipt.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { IMAGE_BOARD_CONFIG_PARAMS } from '../src/image-boards';

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
const extensionArt = artifact('ImageBoardExtension.sol', 'ImageBoardExtension');
const rendererArt = artifact('ImageBoardRenderer.sol', 'ImageBoardRenderer');
const collectionArt = artifact('ImageBoardCollection.sol', 'ImageBoardCollection');

// Anvil mines at once; viem's default 4 s receipt poll would make this run take an hour.
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC), pollingInterval: 20 });
const wallet = createWalletClient({ chain: foundry, transport: http(RPC) });
const testClient = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC) });

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

const STANDARD = { takeBps: 14_000n, payoutBps: 11_500n, reversionBps: 9_700n, maxReversionWeeks: 52n, cooldownSecs: 3_600n };

/** The largest board the contract allows: 256 cells across, 1,000 down. */
async function freshBoard(zones: { col: number; row: number; cols: number; rows: number; cellPrice: bigint }[] = []): Promise<{ board: Address; gas: bigint }> {
  const args = [
    SELLER,
    encodeAbiParameters(IMAGE_BOARD_CONFIG_PARAMS, [
      {
        settlementToken: usd,
        width: 2560,
        height: 10_000,
        cellSize: 10,
        cellPrice: 1n,
        imageHash: keccak256(toHex('img')),
        sourceCid: '0x01551220ab',
        name: 'Gas board',
        description: '',
        zones,
        terms: STANDARD,
      },
    ]),
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

/** The usual state: someone has bought before, so the holder's and the protocol's ledgers are nonzero. */
async function warmedBoard(zones: Parameters<typeof freshBoard>[0] = []): Promise<Address> {
  const { board } = await freshBoard(zones);
  await send(OTHER, board, boardArt.abi, 'buyBlocks', [OTHER.address, [{ col: 255, row: 999, cols: 1, rows: 1 }], 2n ** 255n, 2n ** 40n]);
  return board;
}

type R = { col: number; row: number; cols: number; rows: number };
const buyAs = (who: typeof BUYER, board: Address, rects: R[], recipient: Address = who.address) =>
  send(who, board, boardArt.abi, 'buyBlocks', [recipient, rects, 2n ** 255n, 2n ** 40n]);

async function wait(secs: number) {
  await testClient.increaseTime({ seconds: secs });
  await testClient.mine({ blocks: 1 });
}

async function permitBuy(board: Address, rects: R[]) {
  const total = (await publicClient.readContract({ address: board, abi: boardArt.abi, functionName: 'quoteBlocks', args: [rects] } as never)) as bigint;
  const nonce = (await publicClient.readContract({ address: usd, abi: usdArt.abi, functionName: 'nonces', args: [BUYER.address] } as never)) as bigint;
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
  const gas = await send(BUYER, board, boardArt.abi, 'buyBlocksWithPermit', [
    BUYER.address,
    rects,
    total,
    deadline,
    parseInt(sig.slice(130, 132), 16),
    sig.slice(0, 66) as Hex,
    `0x${sig.slice(66, 130)}` as Hex,
  ]);
  await send(BUYER, usd, usdArt.abi, 'approve', [board, 2n ** 255n]);
  return gas;
}

/** What one buy did, in the terms the formula counts. */
interface Row {
  what: string;
  rects: number;
  freshWords: number;
  touchedWords: number;
  cells: number;
  parts: number;
  /** Reversion's weeks summed over the parts, each capped at the board's 52: its loop runs once a week. */
  weeks: number;
  freshOwners: number;
  zones: number;
  permit: boolean;
  emptyLedger: boolean;
  gas: bigint;
}
const rows: Row[] = [];
const words = (r: R) => (Math.floor((r.col + r.cols - 1) / 8) - Math.floor(r.col / 8) + 1) * r.rows;
const cellsOf = (rs: R[]) => rs.reduce((n, r) => n + r.cols * r.rows, 0);
function record(what: string, gas: bigint, o: Partial<Omit<Row, 'what' | 'gas'>>) {
  rows.push({ what, rects: 1, freshWords: 0, touchedWords: 0, cells: 0, parts: 0, weeks: 0, freshOwners: 0, zones: 0, permit: false, emptyLedger: false, ...o, gas });
}

/** The formula as `lib/image-board-gas.ts` will have it; tuned until every receipt sits under it. */
const F = {
  base: 192_000,
  extraRect: 70_000,
  freshWord: 24_700,
  touchedWord: 7_800,
  cell: 1_000,
  part: 22_600,
  week: 220,
  freshOwner: 22_000,
  zone: 3_500,
  zoneExtraRect: 1_000,
  permit: 30_000,
  emptyLedger: 67_000,
};
const estimate = (r: Row) =>
  F.base +
  (r.rects - 1) * F.extraRect +
  r.freshWords * F.freshWord +
  r.touchedWords * F.touchedWord +
  r.cells * F.cell +
  r.parts * F.part +
  r.weeks * F.week +
  r.freshOwners * F.freshOwner +
  r.zones * (F.zone + (r.rects - 1) * F.zoneExtraRect) +
  (r.permit ? F.permit : 0) +
  (r.emptyLedger ? F.emptyLedger : 0);

async function main() {
  const anvil: ChildProcess = spawn('anvil', ['--port', String(PORT), '--silent', '--gas-limit', '2000000000', '--code-size-limit', '100000'], {
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
    const extension = await deploy(extensionArt, [500n, PROTOCOL]);
    const renderer = await deploy(rendererArt, ['https://example.com/i/boards/', 'ipfs://bafyrenderer/']);
    const implementation = await deploy(boardArt, [extension, renderer]);
    collection = await deploy(collectionArt, ['Gas Image Boards', 'GIMG', RELAYER.address, implementation, [usd], '']);
    for (const who of [BUYER, OTHER]) {
      for (let i = 0; i < 5; i++) await send(RELAYER, usd, usdArt.abi, 'mint', [who.address, 1_000_000n * 10n ** 6n]);
    }

    // Fresh words, on a board that has sold before.
    const shapes: [number, number][] = [
      [1, 1], [8, 1], [9, 1], [1, 8], [8, 8], [2, 64], [64, 8], [64, 64], [256, 16], [1, 512], [16, 256], [256, 2],
    ];
    for (const [c, r] of shapes) {
      const board = await warmedBoard();
      const rect = { col: 0, row: 0, cols: c, rows: r };
      record(`fresh ${c}×${r}`, await buyAs(BUYER, board, [rect]), { freshWords: words(rect), cells: c * r });
    }
    // The first buy on a new board: every ledger goes zero → nonzero.
    {
      const { board } = await freshBoard();
      record('first buy on a new board, 1×1', await buyAs(BUYER, board, [{ col: 0, row: 0, cols: 1, rows: 1 }]), { freshWords: 1, cells: 1, emptyLedger: true });
    }

    // Touched words, no take: one cell sold in every word, then the other seven bought.
    for (const r of [1, 16, 64]) {
      const board = await warmedBoard();
      const columns = Array.from({ length: 32 }, (_, k) => ({ col: 8 * k, row: 0, cols: 1, rows: r }));
      for (let k = 0; k < 32; k += 8) await buyAs(OTHER, board, columns.slice(k, k + 8));
      const rect = { col: 1, row: 0, cols: 7, rows: r };
      record(`touched 7×${r}`, await buyAs(BUYER, board, [rect]), { touchedWords: words(rect), cells: 7 * r });
    }

    // Takes over k one-cell blocks in a row. Owners with nothing credited (each a new address),
    // then one owner who already has credit; young (an hour), then a year old (reversion's last week).
    // 88 is the most one buy may take (`MAX_BLOCKS_TAKEN_PER_BUY`): the worst case, measured.
    for (const k of [1, 8, 32, 88]) {
      for (const owners of ['fresh', 'credited'] as const) {
        for (const age of [3_600, 60 * 7 * 86_400]) {
          const board = await warmedBoard();
          const ones = Array.from({ length: k }, (_, i) => ({ col: i, row: 0, cols: 1, rows: 1 }));
          if (owners === 'fresh') {
            for (const one of ones) await buyAs(OTHER, board, [one], privateKeyToAccount(generatePrivateKey()).address);
          } else {
            await buyAs(OTHER, board, ones);
            // One take first, so OTHER has something credited.
            await buyAs(OTHER, board, [{ col: 200, row: 5, cols: 1, rows: 1 }], OTHER.address);
            await wait(3_600);
            await buyAs(BUYER, board, [{ col: 200, row: 5, cols: 1, rows: 1 }]);
          }
          await wait(age);
          const rect = { col: 0, row: 0, cols: k, rows: 1 };
          record(`take ${k} blocks, ${owners} owners, ${age === 3_600 ? 'an hour' : 'a year'} old`, await buyAs(BUYER, board, [rect]), {
            touchedWords: words(rect),
            cells: k,
            parts: k,
            weeks: age === 3_600 ? 0 : 52 * k,
            freshOwners: owners === 'fresh' ? k : 0,
          });
        }
      }
    }

    // A take over one big block: touched words in bulk, one part.
    for (const [c, r] of [[256, 16], [1, 512], [64, 64]] as [number, number][]) {
      const board = await warmedBoard();
      const rect = { col: 0, row: 0, cols: c, rows: r };
      await buyAs(OTHER, board, [rect]);
      await wait(3_600);
      record(`take one ${c}×${r} block`, await buyAs(BUYER, board, [rect]), { touchedWords: words(rect), cells: c * r, parts: 1, freshOwners: 1 });
    }

    // Listed blocks taken: the listing is deleted and an event emitted.
    {
      const board = await warmedBoard();
      const ones = Array.from({ length: 16 }, (_, i) => ({ col: i, row: 0, cols: 1, rows: 1 }));
      await buyAs(OTHER, board, ones);
      const first = (await publicClient.readContract({ address: board, abi: boardArt.abi, functionName: 'blockCount' } as never)) as bigint;
      for (let id = first - 15n; id <= first; id++) await send(OTHER, board, boardArt.abi, 'listBlock', [id, 1_000n]);
      await wait(3_600);
      const rect = { col: 0, row: 0, cols: 16, rows: 1 };
      record('take 16 listed blocks', await buyAs(BUYER, board, [rect]), { touchedWords: words(rect), cells: 16, parts: 16, freshOwners: 1 });
    }

    // 512 zones, each read by every rectangle.
    {
      const many = Array.from({ length: 512 }, (_, i) => ({ col: i % 256, row: 500 + Math.floor(i / 256), cols: 1, rows: 1, cellPrice: 3n }));
      for (const [c, r] of [[1, 1], [64, 8]] as [number, number][]) {
        const board = await warmedBoard(many);
        const rect = { col: 0, row: 0, cols: c, rows: r };
        record(`fresh ${c}×${r}, 512 zones`, await buyAs(BUYER, board, [rect]), { freshWords: words(rect), cells: c * r, zones: 512 });
      }
      const board = await warmedBoard(many);
      const rects = Array.from({ length: 10 }, (_, i) => ({ col: 0, row: i * 2, cols: 1, rows: 1 }));
      record('10 areas, 512 zones', await buyAs(BUYER, board, rects), { rects: 10, freshWords: 10, cells: 10, zones: 512 });
    }

    // Several areas.
    for (const n of [2, 10]) {
      const board = await warmedBoard();
      const rects = Array.from({ length: n }, (_, i) => ({ col: 0, row: i * 2, cols: 8, rows: 1 }));
      record(`${n} areas, fresh`, await buyAs(BUYER, board, rects), { rects: n, freshWords: n, cells: 8 * n });
    }

    // A permit.
    for (const [c, r] of [[1, 1], [64, 8]] as [number, number][]) {
      const board = await warmedBoard();
      const rect = { col: 0, row: 0, cols: c, rows: r };
      record(`permit, fresh ${c}×${r}`, await permitBuy(board, [rect]), { freshWords: words(rect), cells: c * r, permit: true });
    }
  } finally {
    anvil.kill();
  }

  console.log('| buy | gas | formula | over by |');
  console.log('|---|---:|---:|---:|');
  let under = 0;
  let worst = 0;
  for (const r of rows) {
    const e = estimate(r);
    const over = e / Number(r.gas) - 1;
    if (e < Number(r.gas)) under++;
    worst = Math.max(worst, over);
    console.log(`| ${r.what} | ${r.gas.toLocaleString('en-US')} | ${e.toLocaleString('en-US')} | ${(over * 100).toFixed(1)}% |`);
  }
  console.log(`\nformula ${JSON.stringify(F)}: ${under} receipts above it; at most ${(worst * 100).toFixed(1)}% over`);
  void cellsOf;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
