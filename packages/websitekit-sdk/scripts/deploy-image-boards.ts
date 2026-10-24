/**
 * Deploys image boards — the token generation (`docs/IMAGE-BOARD-SPEC.md` §13) — onto a chain that
 * already has a protocol generation: `ImageBoardExtension` (set-up and rentals), `ImageBoardRenderer`
 * (every metadata string), the `ImageBoard` implementation over both, then `ImageBoardCollection`,
 * the Boards collection in which each board is one token. Each board is itself an ERC-721 of its
 * blocks.
 *
 *   testnet:  set -a; . ./.env; set +a
 *   mainnet:  set -a; . ./.env; . ./.env.mainnet; set +a; export DEPLOYER_KEY=…   (your terminal only)
 *   then:     IMAGE_BOARD_NAME="…" IMAGE_BOARD_SYMBOL=… IMAGE_BOARD_OWNER=0x… \
 *             IMAGE_BOARD_THUMBNAIL_BASE=https://<platform>/i/boards/ \
 *             IMAGE_BOARD_RENDERER_PAGE=ipfs://<cid>/ IMAGE_BOARD_CONTRACT_JSON=<file.json> \
 *             pnpm --filter @websitekit/sdk exec tsx scripts/deploy-image-boards.ts
 *
 * **`IMAGE_BOARD_NAME` and `IMAGE_BOARD_SYMBOL` are the Boards collection's ERC-721 name and symbol**
 * — what marketplaces show, and a board's own symbol is this one's with its token id. The deployer's
 * to choose and fixed at deployment, with no default: the protocol's source names no product
 * (2026-10-12), as `SlotSite`'s are `createSite` arguments. So is the Boards collection's own
 * metadata (ERC-7572), which has no setter: `IMAGE_BOARD_CONTRACT_JSON` is a FILE, parsed and written
 * as `data:application/json;utf8,…`. A string in a shell variable is what put curly quotes into the
 * first 4663 collection's metadata (2026-10-22), unparseable for good.
 *
 * **`IMAGE_BOARD_IMPLEMENTATION=0x…` deploys the collection alone** over an implementation already
 * deployed, its extension and renderer read from it; the renderer's two strings are then the
 * implementation's, so neither variable is asked. A board records the collection that created it,
 * so one implementation serves any number of collections. Every read-back still runs.
 *
 * **`IMAGE_BOARD_COLLECTION=0x…` moves an existing collection's NEW boards to a new implementation**
 * (2026-10-24, squares not for sale): a new extension and implementation over the renderer the
 * collection's current implementation names, then `setImplementation` — sent by the deployer, who
 * must be the collection's owner. Boards already created keep theirs for good (`implementationOf`).
 * The collection's name, symbol, owner and metadata are read from it, so none of those variables is
 * asked, and on a testnet `IMAGE_BOARD_TOKEN` must name the token it already allows. The smoke runs
 * against it there.
 *
 * **The renderer's two strings are fixed for every board of this implementation** — nobody can
 * change how an existing board's metadata reads. `IMAGE_BOARD_THUMBNAIL_BASE` serves the board
 * token's composite (`<base><token>?v=<changes>`); `IMAGE_BOARD_RENDERER_PAGE` is the reference
 * renderer, an `ipfs://` page given `?chain=…&board=…`.
 *
 * **The collection owner's powers**: the token allowlist, and which implementation NEW boards are
 * cloned from (`setImplementation`). No base URI, and ownership moves only by the two-step handover.
 *
 * **The protocol's terms are READ, not configured.** `protocolBps` and `protocolTreasury` are
 * immutables of the `SlotSite` implementation behind `WEBSITEKIT_FACTORY`, and the image-board
 * implementation is given the same two values. A second variable for the treasury would be a second
 * place for one fact, and it is an immutable with no setter on every board ever cloned.
 *
 * **The settlement token differs by chain, on purpose.**
 *   - Testnet: a NEW `TestUSD`, the one with EIP-2612 `permit` — page boards keep the old one
 *     (decided 2026-10-07). `IMAGE_BOARD_TOKEN` reuses one this script already deployed.
 *   - Mainnet: real USDG from `src/settlement.ts`, and nothing else. A TestUSD is refused there.
 * Either way the token must actually accept a permit, and that is PROVED before anything deploys:
 * a throwaway key signs one and `permit` is simulated against the token. A token without it would
 * leave `buyBlocksWithPermit` ignoring the failure and every buy reverting at the pull.
 *
 * **Testnet also runs a smoke** — create a named board with one zone, lower its prices to half,
 * buy two areas in one permit buy (two tokens minted), read its metadata back as JSON, take a cell,
 * rent the taker's block for an hour. Not on mainnet, where a board is a public artifact and a buy is
 * real money.
 *
 * **Verify all four contracts afterwards**, so every board cloned from the implementation has a
 * readable contract page. The commands are printed at the end.
 */
import { encodeAbiParameters, formatEther, formatUnits, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMAGE_BOARD_CONFIG_PARAMS } from '../src/image-boards';
import { ROBINHOOD_MAINNET_USDG } from '../src/settlement';
import {
  activeChain,
  deployer as deployerAccount,
  deployerWallet,
  describeChain,
  publicClient,
  required,
} from './lib/chain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');

function artifact(solFile: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(path.join(contractsOut, solFile, `${name}.json`), 'utf-8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}

function address(name: string): Address {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} "${value}" is not a 20-byte hex address`);
  return value as Address;
}

const siteArt = artifact('SlotSite.sol', 'SlotSite');
const slotFactoryArt = artifact('SlotFactory.sol', 'SlotFactory');
const usdArt = artifact('TestUSD.sol', 'TestUSD');
const boardArt = artifact('ImageBoard.sol', 'ImageBoard');
const extensionArt = artifact('ImageBoardExtension.sol', 'ImageBoardExtension');
const rendererArt = artifact('ImageBoardRenderer.sol', 'ImageBoardRenderer');
const collectionArt = artifact('ImageBoardCollection.sol', 'ImageBoardCollection');

const TEST_USD = { name: 'websitekit Test Dollar', symbol: 'tUSD', decimals: 6 } as const;

const deployer = deployerAccount();
const wallet = deployerWallet();

async function deploy(label: string, art: { abi: Abi; bytecode: Hex }, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ ...art, args } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // A reverted deploy still resolves with a receipt; only `status` tells.
  if (receipt.status !== 'success') throw new Error(`${label} deploy reverted (tx ${hash})`);
  console.log(`  ${label.padEnd(20)} ${receipt.contractAddress}  (gas ${receipt.gasUsed})`);
  return receipt.contractAddress!;
}

async function write(label: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) {
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted (tx ${hash})`);
  return receipt;
}

function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;
}

/** Signs an EIP-2612 permit over the token's own domain. */
async function signPermit(
  signer: ReturnType<typeof privateKeyToAccount>,
  token: Address,
  spender: Address,
  value: bigint,
  deadline: bigint,
) {
  const [name, nonce] = await Promise.all([
    read<string>(token, usdArt.abi, 'name'),
    read<bigint>(token, usdArt.abi, 'nonces', [signer.address]),
  ]);
  // The domain's version is not readable through the 2612 surface; both tokens here use "1", and
  // the simulation below is what proves it rather than this line.
  const sig = await signer.signTypedData({
    domain: { name, version: '1', chainId: activeChain.id, verifyingContract: token },
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
    message: { owner: signer.address, spender, value, nonce, deadline },
  });
  return {
    v: parseInt(sig.slice(130, 132), 16),
    r: sig.slice(0, 66) as Hex,
    s: `0x${sig.slice(66, 130)}` as Hex,
  };
}

// ---------------------------------------------------------------------------
// What is being deployed against
// ---------------------------------------------------------------------------

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const slotFactory = address('WEBSITEKIT_FACTORY');
const existing = process.env.IMAGE_BOARD_IMPLEMENTATION ? address('IMAGE_BOARD_IMPLEMENTATION') : null;
const upgrading = process.env.IMAGE_BOARD_COLLECTION ? address('IMAGE_BOARD_COLLECTION') : null;
if (existing && upgrading) throw new Error('IMAGE_BOARD_IMPLEMENTATION and IMAGE_BOARD_COLLECTION are two different jobs: set one');
if (upgrading && activeChain.testnet && !process.env.IMAGE_BOARD_TOKEN) {
  throw new Error('IMAGE_BOARD_COLLECTION on a testnet needs IMAGE_BOARD_TOKEN: the token that collection already allows');
}
const collectionName = upgrading ? await read<string>(upgrading, collectionArt.abi, 'name') : required('IMAGE_BOARD_NAME');
const collectionSymbol = upgrading ? await read<string>(upgrading, collectionArt.abi, 'symbol') : required('IMAGE_BOARD_SYMBOL');
const owner = upgrading ? await read<Address>(upgrading, collectionArt.abi, 'owner') : address('IMAGE_BOARD_OWNER');
const contractURI = upgrading ? await read<string>(upgrading, collectionArt.abi, 'contractURI') : contractUriFrom(required('IMAGE_BOARD_CONTRACT_JSON'));
// The implementation whose renderer, and so whose two strings, are kept: the given one, or the
// collection's current one when only its new boards move.
const keptFrom = existing ?? (upgrading ? await read<Address>(upgrading, collectionArt.abi, 'implementation') : null);

/** The collection's metadata from a JSON file: refused unless it parses to an object with a name. */
function contractUriFrom(file: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`IMAGE_BOARD_CONTRACT_JSON "${file}" is not readable JSON: ${(error as Error).message}`);
  }
  const name = (parsed as { name?: unknown } | null)?.name;
  if (typeof parsed !== 'object' || Array.isArray(parsed) || typeof name !== 'string' || name.trim() === '') {
    throw new Error(`IMAGE_BOARD_CONTRACT_JSON "${file}" must be a JSON object with a non-empty "name"`);
  }
  return `data:application/json;utf8,${JSON.stringify(parsed)}`;
}

let thumbnailBase: string;
let rendererPage: string;
if (keptFrom) {
  const existingRenderer = await read<Address>(keptFrom, boardArt.abi, 'renderer');
  [thumbnailBase, rendererPage] = await Promise.all([
    read<string>(existingRenderer, rendererArt.abi, 'thumbnailBase'),
    read<string>(existingRenderer, rendererArt.abi, 'rendererPage'),
  ]);
} else {
  thumbnailBase = required('IMAGE_BOARD_THUMBNAIL_BASE');
  // A base without the trailing slash makes every thumbnail `…/boards1`; plain http is a testnet's only.
  if (!thumbnailBase.endsWith('/')) throw new Error(`IMAGE_BOARD_THUMBNAIL_BASE "${thumbnailBase}" must end with "/"`);
  if (!thumbnailBase.startsWith('https://') && !(activeChain.testnet && thumbnailBase.startsWith('http://'))) {
    throw new Error(`IMAGE_BOARD_THUMBNAIL_BASE "${thumbnailBase}" must be https off a testnet`);
  }
  rendererPage = required('IMAGE_BOARD_RENDERER_PAGE');
  // Fixed for every board of this implementation: an IPFS page, whose `?chain=…` follows its slash.
  if (!rendererPage.startsWith('ipfs://') || !rendererPage.endsWith('/')) {
    throw new Error(`IMAGE_BOARD_RENDERER_PAGE "${rendererPage}" must be an ipfs:// address ending with "/"`);
  }
}
const siteImplementation = await read<Address>(slotFactory, slotFactoryArt.abi, 'implementation');
const [protocolBps, protocolTreasury] = await Promise.all([
  read<bigint>(siteImplementation, siteArt.abi, 'protocolBps'),
  read<Address>(siteImplementation, siteArt.abi, 'protocolTreasury'),
]);

const balance = await publicClient.getBalance({ address: deployer.address });
console.log(`\n${describeChain()}`);
console.log(`deployer          ${deployer.address} — ${formatEther(balance)} ETH`);
console.log(`collection        "${collectionName}" (${collectionSymbol})`);
console.log(`collection owner  ${owner} (allowToken and setImplementation, for new boards only; handover only)`);
if (existing) console.log(`implementation    ${existing} (deployed; only the collection is new)`);
if (upgrading) console.log(`collection        ${upgrading} (deployed; its NEW boards move to a new implementation over the renderer of ${keptFrom})`);
console.log(`thumbnails        ${thumbnailBase}<token>?v=<changes>`);
console.log(`renderer page     ${rendererPage}?chain=…&board=…`);
// Whole, never cut: it is fixed for good, and a cut hid the curly quotes of 2026-10-22.
console.log(`collection meta   ${contractURI}`);
console.log(`protocol terms    ${protocolBps} bps to ${protocolTreasury}, read from SlotSite ${siteImplementation}\n`);
if (balance === 0n) throw new Error('deployer has no balance');
if (upgrading && !same(owner, deployer.address)) throw new Error(`${upgrading} is owned by ${owner}: setImplementation must be sent by its owner`);
if (protocolBps !== 500n) throw new Error(`the protocol generation takes ${protocolBps} bps; image boards were decided at 500`);

// ---------------------------------------------------------------------------
// The settlement token, and proof that it takes a permit
// ---------------------------------------------------------------------------

let token: Address;
if (!activeChain.testnet) {
  if (process.env.IMAGE_BOARD_TOKEN) throw new Error('IMAGE_BOARD_TOKEN is refused off a testnet: mainnet settles in real USDG only');
  token = ROBINHOOD_MAINNET_USDG.address as Address;
} else if (process.env.IMAGE_BOARD_TOKEN) {
  token = address('IMAGE_BOARD_TOKEN');
  console.log(`  reusing token        ${token}`);
} else {
  token = await deploy('TestUSD (permit)', usdArt, [TEST_USD.name, TEST_USD.symbol, TEST_USD.decimals]);
}

const decimals = await read<number>(token, usdArt.abi, 'decimals');
if (decimals !== 6) throw new Error(`${token} reports ${decimals} decimals, not 6`);

{
  // A throwaway signer, so the proof spends nothing and touches no real account.
  const probe = privateKeyToAccount(generatePrivateKey());
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { v, r, s } = await signPermit(probe, token, deployer.address, 1n, deadline);
  try {
    await publicClient.simulateContract({
      address: token,
      abi: usdArt.abi,
      functionName: 'permit',
      args: [probe.address, deployer.address, 1n, deadline, v, r, s],
      account: deployer,
    } as never);
  } catch (error) {
    throw new Error(`${token} did not accept a valid EIP-2612 permit — image boards need one. ${String(error).slice(0, 300)}`);
  }
  console.log(`  permit proved        ${token} accepts a signed permit (${decimals} decimals)`);
}

// ---------------------------------------------------------------------------
// Deploy and read back
// ---------------------------------------------------------------------------

let extension: Address;
let renderer: Address;
let implementation: Address;
if (existing) {
  implementation = existing;
  [extension, renderer] = await Promise.all([
    read<Address>(existing, boardArt.abi, 'extension'),
    read<Address>(existing, boardArt.abi, 'renderer'),
  ]);
} else {
  extension = await deploy('ImageBoardExtension', extensionArt, [protocolBps, protocolTreasury]);
  // A renderer is fixed per implementation and reads only the board, so a move keeps the one boards
  // already have: the same metadata for every board of the collection.
  renderer = keptFrom
    ? await read<Address>(keptFrom, boardArt.abi, 'renderer')
    : await deploy('ImageBoardRenderer', rendererArt, [thumbnailBase, rendererPage]);
  // The implementation READS its protocol terms from the extension, so the two cannot disagree.
  implementation = await deploy('ImageBoard', boardArt, [extension, renderer]);
}
let collection: Address;
if (upgrading) {
  await write('setImplementation', upgrading, collectionArt.abi, 'setImplementation', [implementation]);
  collection = upgrading;
  console.log(`  setImplementation    ${collection} → ${implementation} (boards created before keep theirs)`);
} else {
  collection = await deploy('ImageBoardCollection', collectionArt, [collectionName, collectionSymbol, owner, implementation, [token], contractURI]);
}

const [recBps, recTreasury, recExt, recRenderer, recThumb, recPage, recImpl, recOwner, allowed, recContract, recName, recSymbol] = await Promise.all([
  read<bigint>(implementation, boardArt.abi, 'protocolBps'),
  read<Address>(implementation, boardArt.abi, 'protocolTreasury'),
  read<Address>(implementation, boardArt.abi, 'extension'),
  read<Address>(implementation, boardArt.abi, 'renderer'),
  read<string>(renderer, rendererArt.abi, 'thumbnailBase'),
  read<string>(renderer, rendererArt.abi, 'rendererPage'),
  read<Address>(collection, collectionArt.abi, 'implementation'),
  read<Address>(collection, collectionArt.abi, 'owner'),
  read<boolean>(collection, collectionArt.abi, 'tokenAllowed', [token]),
  read<string>(collection, collectionArt.abi, 'contractURI'),
  read<string>(collection, collectionArt.abi, 'name'),
  read<string>(collection, collectionArt.abi, 'symbol'),
]);
if (recBps !== protocolBps || !same(recTreasury, protocolTreasury)) throw new Error('implementation records other protocol terms');
if (!same(recExt, extension) || !same(recRenderer, renderer)) throw new Error(`implementation points at ${recExt} and ${recRenderer}`);
if (recThumb !== thumbnailBase || recPage !== rendererPage) throw new Error(`renderer carries "${recThumb}" and "${recPage}"`);
if (!same(recImpl, implementation)) throw new Error(`collection points at ${recImpl}`);
if (!same(recOwner, owner)) throw new Error(`collection is owned by ${recOwner}`);
if (!allowed) throw new Error(`${token} is not allowed by the collection`);
if (recContract !== contractURI) throw new Error(`collection's contractURI is ${recContract}`);
if (recName !== collectionName || recSymbol !== collectionSymbol) throw new Error(`collection is "${recName}" (${recSymbol})`);
console.log(`  read back            ${recBps} bps → ${recTreasury}; implementation → extension, renderer; renderer's strings; collection → implementation; owner; token allowed; contractURI; name and symbol`);

// ---------------------------------------------------------------------------
// Smoke buy, testnet only
// ---------------------------------------------------------------------------

/** A `data:application/json;base64,…` metadata string, parsed: the renderer's output read as a client reads it. */
function metadata(uri: string): Record<string, unknown> {
  const prefix = 'data:application/json;base64,';
  if (!uri.startsWith(prefix)) throw new Error(`metadata is not a base64 JSON data URI: ${uri.slice(0, 60)}`);
  return JSON.parse(Buffer.from(uri.slice(prefix.length), 'base64').toString('utf-8')) as Record<string, unknown>;
}

if (activeChain.testnet) {
  const createArgs = [
    deployer.address,
    // The set-up is bytes the collection passes through to the board (2026-10-20).
    encodeAbiParameters(IMAGE_BOARD_CONFIG_PARAMS, [
      {
        settlementToken: token,
        width: 300,
        height: 671,
        cellSize: 10,
        cellPrice: 10_000n,
        imageHash: keccak256(toHex('deploy smoke')),
        // The shape of a CIDv1; the smoke reads it back, nothing fetches it.
        sourceCid: '0x01551220ab',
        name: 'Deploy smoke "board"',
        description: '',
        // A dear 2×2 zone at the top-left, and a 2×2 not for sale (2026-10-24).
        zones: [
          { col: 0, row: 0, cols: 2, rows: 2, cellPrice: 20_000n },
          { col: 10, row: 10, cols: 2, rows: 2, cellPrice: 0n },
        ],
        // The Standard profile with no cooldown, so the smoke can take a block it has just sold.
        terms: { takeBps: 14_000n, payoutBps: 11_500n, reversionBps: 9_700n, maxReversionWeeks: 52n, cooldownSecs: 0n },
      },
    ]),
  ] as const;
  const { result } = await publicClient.simulateContract({
    address: collection,
    abi: collectionArt.abi,
    functionName: 'createBoardFor',
    args: createArgs,
    account: deployer,
  } as never);
  const [board, boardToken] = result as [Address, bigint];
  await write('createBoardFor', collection, collectionArt.abi, 'createBoardFor', createArgs);
  const nftHolder = await read<Address>(collection, collectionArt.abi, 'ownerOf', [boardToken]);
  if (!same(nftHolder, deployer.address)) throw new Error(`smoke board's NFT is held by ${nftHolder}`);
  // Which code the board runs is recorded per board (2026-10-20): the collection can move NEW boards on.
  const clonedFrom = await read<Address>(collection, collectionArt.abi, 'implementationOf', [boardToken]);
  if (!same(clonedFrom, implementation)) throw new Error(`smoke board was cloned from ${clonedFrom}`);
  const grid = [await read<number>(board, boardArt.abi, 'gridCols'), await read<number>(board, boardArt.abi, 'gridRows')];
  if (grid[0] !== 30 || grid[1] !== 67) throw new Error(`smoke board grid is ${grid}, not 30×67`);
  // The board's token's metadata is the board's own, built on chain; the name survives as JSON.
  const boardMeta = metadata(await read<string>(collection, collectionArt.abi, 'tokenURI', [boardToken]));
  if (boardMeta.name !== 'Deploy smoke "board"') throw new Error(`smoke board's metadata names it ${String(boardMeta.name)}`);
  if (boardMeta.image !== `${thumbnailBase}${boardToken}?v=0`) throw new Error(`smoke board's thumbnail is ${String(boardMeta.image)}`);
  const symbol = await read<string>(board, boardArt.abi, 'symbol');
  if (symbol !== `${collectionSymbol}-${boardToken}`) throw new Error(`smoke board's own symbol is ${symbol}`);

  // Squares not for sale (2026-10-24): the zone priced zero is no free square and refuses a buy; a
  // board priced zero is refused with nothing to sell, and made with one priced square.
  const keptSelector = keccak256(toHex('CellsKept()')).slice(0, 10);
  const free = await read<bigint>(board, boardArt.abi, 'freeCells');
  if (free !== 30n * 67n - 4n) throw new Error(`smoke board has ${free} free squares, not ${30 * 67 - 4}`);
  const keptAnswer = await read<Hex>(board, boardArt.abi, 'buyError', [[{ col: 9, row: 9, cols: 2, rows: 2 }]]);
  if (keptAnswer !== keptSelector) throw new Error(`a buy one square into the zone not for sale answers ${keptAnswer}, not CellsKept`);
  const pricedZero = (zones: readonly { col: number; row: number; cols: number; rows: number; cellPrice: bigint }[]) => [
    deployer.address,
    encodeAbiParameters(IMAGE_BOARD_CONFIG_PARAMS, [
      {
        settlementToken: token,
        width: 300,
        height: 671,
        cellSize: 10,
        cellPrice: 0n,
        imageHash: keccak256(toHex('deploy smoke, priced zero')),
        sourceCid: '0x01551220ab',
        name: 'Deploy smoke, priced zero',
        description: '',
        zones,
        terms: { takeBps: 14_000n, payoutBps: 11_500n, reversionBps: 9_700n, maxReversionWeeks: 52n, cooldownSecs: 0n },
      },
    ]),
  ];
  const nothingForSale = await publicClient
    .simulateContract({ address: collection, abi: collectionArt.abi, functionName: 'createBoardFor', args: pricedZero([]), account: deployer } as never)
    .then(() => null, (error: unknown) => error);
  if (!nothingForSale) throw new Error('a board priced zero with no priced zone was accepted');
  await publicClient.simulateContract({
    address: collection,
    abi: collectionArt.abi,
    functionName: 'createBoardFor',
    args: pricedZero([{ col: 29, row: 66, cols: 1, rows: 1, cellPrice: 1n }]),
    account: deployer,
  } as never);
  console.log(`  smoke not for sale   the zone priced zero refuses a buy (CellsKept) and is no free square; a board priced zero is refused with nothing for sale and accepted with one priced square`);

  // One row in the zone, one below it: two cells at 20,000 and two at the base 10,000.
  // `quoteBlocks` of one area: the board carries no single-area read since rentals (2026-10-20).
  const quoteOne = (col: number, row: number, cols: number, rows: number) =>
    read<bigint>(board, boardArt.abi, 'quoteBlocks', [[{ col, row, cols, rows }]]);
  const across = await quoteOne(0, 1, 2, 2);
  if (across !== 60_000n) throw new Error(`smoke quote across the zone is ${across}, not 60,000`);
  // The board's holder (the deployer) lowers prices to half: the same block is now 30,000, and one
  // base square 5,000. Then two areas in one buy, by permit, at the lowered price.
  await write('lowerPrices', board, boardArt.abi, 'lowerPrices', [5_000n]);
  const halved = await quoteOne(0, 1, 2, 2);
  if (halved !== 30_000n) throw new Error(`smoke quote after lowering to half is ${halved}, not 30,000`);
  const total = halved + (await quoteOne(5, 5, 1, 1));
  if (total !== 35_000n) throw new Error(`smoke total for two areas is ${total}, not 35,000`);
  await write('mint', token, usdArt.abi, 'mint', [deployer.address, total]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { v, r, s } = await signPermit(deployer, token, board, total, deadline);
  const recipient = address('TESTNET_TAKER_ADDRESS');
  const areas = [
    { col: 0, row: 1, cols: 2, rows: 2 },
    { col: 5, row: 5, cols: 1, rows: 1 },
  ];
  const receipt = await write('buyBlocksWithPermit', board, boardArt.abi, 'buyBlocksWithPermit', [
    recipient, areas, total, deadline, v, r, s,
  ]);
  for (const id of [1n, 2n]) {
    const holder = await read<Address>(board, boardArt.abi, 'ownerOf', [id]);
    if (!same(holder, recipient)) throw new Error(`smoke block ${id} is held by ${holder}, not ${recipient}`);
  }
  const balance = await read<bigint>(board, boardArt.abi, 'balanceOf', [recipient]);
  if (balance !== 2n) throw new Error(`the smoke buyer holds ${balance} blocks, not 2`);
  // Two tokens minted, from zero; and one ERC-4906 MetadataUpdate from the collection.
  const minted = receipt.logs.filter((l) => same(l.address, board) && l.topics[0] === keccak256(toHex('Transfer(address,address,uint256)')));
  if (minted.length !== 2) throw new Error(`the smoke buy minted ${minted.length} tokens, not 2`);
  const updated = receipt.logs.filter((l) => same(l.address, collection));
  if (updated.length !== 1) throw new Error(`the smoke buy left ${updated.length} collection logs, not one MetadataUpdate`);
  const owed = await read<bigint>(board, boardArt.abi, 'pendingWithdrawals', [deployer.address]);
  if (owed !== total - (total * protocolBps) / 10_000n) throw new Error(`the board's holder is owed ${owed}`);
  const blockMeta = metadata(await read<string>(board, boardArt.abi, 'tokenURI', [1n]));
  if (blockMeta.name !== 'Deploy smoke "board" #1') throw new Error(`smoke block 1's metadata names it ${String(blockMeta.name)}`);
  console.log(`  smoke                board ${board} (token ${boardToken}, ${symbol}): metadata read back; prices lowered to half; 2×2 across the zone and a 1×1 in one buy for ${formatUnits(total, 6)} by permit → ${recipient}, two tokens minted; holder credited; MetadataUpdate (gas ${receipt.gasUsed})`);

  // A take: the deployer buys block 2's one cell back. Bought at half price, its floor is still the
  // creation price, so the take is 10,000 × 1.4 and its owner is credited 10,000 × 1.15.
  const takeArea = [{ col: 5, row: 5, cols: 1, rows: 1 }];
  const take = await read<bigint>(board, boardArt.abi, 'quoteBlocks', [takeArea]);
  if (take !== 14_000n) throw new Error(`smoke take is ${take}, not 14,000`);
  const takePrice = await read<bigint>(renderer, rendererArt.abi, 'takePrice', [board, 2n]);
  if (takePrice !== take) throw new Error(`the renderer prices block 2's take at ${takePrice}, the board at ${take}`);
  await write('mint', token, usdArt.abi, 'mint', [deployer.address, take]);
  const taken = await signPermit(deployer, token, board, take, deadline);
  const takeReceipt = await write('buyBlocksWithPermit (a take)', board, boardArt.abi, 'buyBlocksWithPermit', [
    deployer.address, takeArea, take, deadline, taken.v, taken.r, taken.s,
  ]);
  const paidOut = await read<bigint>(board, boardArt.abi, 'pendingWithdrawals', [recipient]);
  if (paidOut !== 11_500n) throw new Error(`the displaced owner is owed ${paidOut}, not 11,500`);
  const left = await read<{ cellsLeft: number }>(board, boardArt.abi, 'blockOf', [2n]);
  if (left.cellsLeft !== 0) throw new Error(`block 2 has ${left.cellsLeft} cells left, not 0`);
  const stillHeld = await read<Address>(board, boardArt.abi, 'ownerOf', [2n]);
  if (!same(stillHeld, recipient)) throw new Error('a take moved the covered token');
  console.log(`  smoke take           block 2's cell taken for ${formatUnits(take, 6)}, as the renderer priced it; its owner credited ${formatUnits(paidOut, 6)} and still holds the token (gas ${takeReceipt.gasUsed})`);

  // A rental (2026-10-20): the deployer offers the block it just took and rents it for the taker for
  // an hour, by permit; the tenant is the ERC-4907 user.
  const rate = 1_000_008n; // a day; an hour of it is 41,667
  await write('listForRent', board, boardArt.abi, 'listForRent', [3n, rate, 86_400n]);
  const cost = (rate * 3_600n) / 86_400n;
  await write('mint', token, usdArt.abi, 'mint', [deployer.address, cost]);
  const rentPermit = await signPermit(deployer, token, board, cost, deadline);
  const protocolBefore = await read<bigint>(board, boardArt.abi, 'pendingWithdrawals', [protocolTreasury]);
  const rentReceipt = await write('rentWithPermit', board, boardArt.abi, 'rentWithPermit', [
    3n, recipient, 3_600n, rate, deadline, rentPermit.v, rentPermit.r, rentPermit.s,
  ]);
  const tenancy = await read<{ tenant: Address; prepaid: bigint }>(board, boardArt.abi, 'rentalOf', [3n]);
  if (!same(tenancy.tenant, recipient)) throw new Error(`the smoke rental's tenant is ${tenancy.tenant}`);
  const user = await read<Address>(board, boardArt.abi, 'userOf', [3n]);
  if (!same(user, recipient)) throw new Error(`the smoke rental's ERC-4907 user is ${user}`);
  const rentCut = (await read<bigint>(board, boardArt.abi, 'pendingWithdrawals', [protocolTreasury])) - protocolBefore;
  if (rentCut !== (cost * protocolBps) / 10_000n || tenancy.prepaid !== cost - 2n * rentCut) {
    throw new Error(`the smoke rental split ${cost} as ${rentCut} to the protocol and ${tenancy.prepaid} escrowed`);
  }
  console.log(`  smoke rental         block 3 rented for an hour for ${formatUnits(cost, 6)} by permit → ${recipient}, its user; 5% + 5% credited, the rest escrowed (gas ${rentReceipt.gasUsed})`);
}

// A testnet's Blockscout takes a script; 4663's answers a Cloudflare challenge, so off a testnet the
// commands name Sourcify, which Etherscan picks up its matches from.
const verifier = activeChain.testnet ? `--verifier blockscout --verifier-url ${activeChain.blockExplorers.default.url}/api` : '--verifier sourcify --watch';
const verify = (addr: Address, contract: string, signature: string, args: string) => `  forge verify-contract ${addr} ${contract} --chain-id ${activeChain.id} \\
    ${verifier} \\
    --constructor-args $(cast abi-encode "${signature}" ${args})`;

console.log(`
Deployed. Record in packages/websitekit-sdk/src/image-boards.ts (IMAGE_BOARD_DEPLOYMENTS):

  implementation: '${implementation.toLowerCase()}', extension: '${extension.toLowerCase()}', renderer: '${renderer.toLowerCase()}',
  collection: '${collection.toLowerCase()}', token: '${token.toLowerCase()}',

Verify ${existing ? 'the collection' : upgrading ? 'the extension and the implementation' : 'all four'}:

  cd packages/websitekit-contracts
${existing ? '' : `${verify(extension, 'src/ImageBoardExtension.sol:ImageBoardExtension', 'constructor(uint256,address)', `${protocolBps} ${protocolTreasury}`)}
${upgrading ? '' : `${verify(renderer, 'src/ImageBoardRenderer.sol:ImageBoardRenderer', 'constructor(string,string)', `"${thumbnailBase}" "${rendererPage}"`)}
`}${verify(implementation, 'src/ImageBoard.sol:ImageBoard', 'constructor(address,address)', `${extension} ${renderer}`)}
`}${upgrading ? '' : verify(collection, 'src/ImageBoardCollection.sol:ImageBoardCollection', 'constructor(string,string,address,address,address[],string)', `"${collectionName}" "${collectionSymbol}" ${owner} ${implementation} "[${token}]" ${shellQuote(contractURI)}`)}
`);

/** One shell word, whatever the string holds — the metadata carries apostrophes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
