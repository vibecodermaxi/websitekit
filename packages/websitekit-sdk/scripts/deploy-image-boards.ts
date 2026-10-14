/**
 * Deploys image boards onto a chain that already has a protocol generation
 * (`docs/IMAGE-BOARD-SPEC.md`): the `ImageBoard` implementation, then `ImageBoardCollection`
 * — the ERC-721 in which each board is one token (decided 2026-10-09, `docs/IMAGE-BOARD-SPEC.md`).
 *
 *   testnet:  set -a; . ./.env; set +a
 *   mainnet:  set -a; . ./.env; . ./.env.mainnet; set +a; export DEPLOYER_KEY=…   (your terminal only)
 *   then:     IMAGE_BOARD_NAME="… Image Boards" IMAGE_BOARD_SYMBOL=… \
 *             IMAGE_BOARD_OWNER=0x… IMAGE_BOARD_BASE_URI=https://<platform>/i/boards/ \
 *             pnpm --filter @websitekit/sdk exec tsx scripts/deploy-image-boards.ts
 *
 * **`IMAGE_BOARD_NAME` and `IMAGE_BOARD_SYMBOL` are the collection's ERC-721 name and symbol** —
 * what marketplaces show. The deployer's to choose and fixed at deployment, with no default: the
 * protocol's source names no product (2026-10-12), as `SlotSite`'s are `createSite` arguments.
 *
 * **`IMAGE_BOARD_BASE_URI` is where marketplaces fetch each board's metadata**: `tokenURI(n)` is it
 * plus `n`. The owner can move it later (`setBaseURI`, which announces a refresh of every token) —
 * the collection owner's one power besides the token allowlist.
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
 * **Testnet also runs a smoke buy** — create a board with one zone and one kept block (2026-10-11),
 * lower its prices to half, mint, buy two areas in one permit buy (one across the zone), read the
 * owners and the prices back (2026-10-11: several areas, and lowered prices). Not on
 * mainnet, where a board is a public artifact and a buy is real money.
 *
 * **Verify both contracts on Blockscout afterwards**, so every board cloned from the implementation
 * has a readable contract page. The commands are printed at the end.
 */
import { formatEther, formatUnits, keccak256, toFunctionSelector, toHex, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const slotFactory = address('WEBSITEKIT_FACTORY');
const collectionName = required('IMAGE_BOARD_NAME');
const collectionSymbol = required('IMAGE_BOARD_SYMBOL');
const owner = address('IMAGE_BOARD_OWNER');
const baseURI = required('IMAGE_BOARD_BASE_URI');
// A base without the trailing slash makes every tokenURI `…/boards1`; plain http is a testnet's only.
if (!baseURI.endsWith('/')) throw new Error(`IMAGE_BOARD_BASE_URI "${baseURI}" must end with "/"`);
if (!baseURI.startsWith('https://') && !(activeChain.testnet && baseURI.startsWith('http://'))) {
  throw new Error(`IMAGE_BOARD_BASE_URI "${baseURI}" must be https off a testnet`);
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
console.log(`collection owner  ${owner} (allowToken and setBaseURI only; no reach into any board)`);
console.log(`metadata base     ${baseURI}<token>`);
console.log(`protocol terms    ${protocolBps} bps to ${protocolTreasury}, read from SlotSite ${siteImplementation}\n`);
if (balance === 0n) throw new Error('deployer has no balance');
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

const implementation = await deploy('ImageBoard', boardArt, [protocolBps, protocolTreasury]);
const collection = await deploy('ImageBoardCollection', collectionArt, [collectionName, collectionSymbol, owner, implementation, [token], baseURI]);

const [recBps, recTreasury, recImpl, recOwner, allowed, recBase, recName, recSymbol] = await Promise.all([
  read<bigint>(implementation, boardArt.abi, 'protocolBps'),
  read<Address>(implementation, boardArt.abi, 'protocolTreasury'),
  read<Address>(collection, collectionArt.abi, 'implementation'),
  read<Address>(collection, collectionArt.abi, 'owner'),
  read<boolean>(collection, collectionArt.abi, 'tokenAllowed', [token]),
  read<string>(collection, collectionArt.abi, 'baseURI'),
  read<string>(collection, collectionArt.abi, 'name'),
  read<string>(collection, collectionArt.abi, 'symbol'),
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
if (recBps !== protocolBps || !same(recTreasury, protocolTreasury)) throw new Error('implementation records other protocol terms');
if (!same(recImpl, implementation)) throw new Error(`collection points at ${recImpl}`);
if (!same(recOwner, owner)) throw new Error(`collection is owned by ${recOwner}`);
if (!allowed) throw new Error(`${token} is not allowed by the collection`);
if (recBase !== baseURI) throw new Error(`collection's base is ${recBase}`);
if (recName !== collectionName || recSymbol !== collectionSymbol) throw new Error(`collection is "${recName}" (${recSymbol})`);
console.log(`  read back            ${recBps} bps → ${recTreasury}; collection → implementation; owner; token allowed; base; name and symbol`);

// ---------------------------------------------------------------------------
// Smoke buy, testnet only
// ---------------------------------------------------------------------------

if (activeChain.testnet) {
  const createArgs = [
    deployer.address,
    {
      settlementToken: token,
      width: 300,
      height: 671,
      cellSize: 10,
      cellPrice: 10_000n,
      imageHash: keccak256(toHex('deploy smoke')),
      // A dear 2×2 zone at the top-left, and the bottom-right square kept by the deployer.
      zones: [{ col: 0, row: 0, cols: 2, rows: 2, cellPrice: 20_000n }],
      kept: [{ col: 29, row: 66, cols: 1, rows: 1 }],
      // The Standard profile with no cooldown, so the smoke can take a block it has just sold.
      terms: { takeBps: 14_000n, payoutBps: 11_500n, reversionBps: 9_700n, maxReversionWeeks: 52n, cooldownSecs: 0n },
    },
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
  const uri = await read<string>(collection, collectionArt.abi, 'tokenURI', [boardToken]);
  if (uri !== `${baseURI}${boardToken}`) throw new Error(`smoke board's tokenURI is ${uri}`);
  const grid = await read<[number, number]>(board, boardArt.abi, 'gridSize');
  if (grid[0] !== 30 || grid[1] !== 67) throw new Error(`smoke board grid is ${grid}, not 30×67`);

  const kept = await read<Address>(board, boardArt.abi, 'ownerOf', [1n]);
  if (!same(kept, deployer.address)) throw new Error(`smoke board's kept block is held by ${kept}, not the creator`);
  // One row in the zone, one below it: two cells at 20,000 and two at the base 10,000.
  const across = await read<bigint>(board, boardArt.abi, 'quote', [0, 1, 2, 2]);
  if (across !== 60_000n) throw new Error(`smoke quote across the zone is ${across}, not 60,000`);
  // The board's holder (the deployer) lowers prices to half: the same block is now 30,000, and one
  // base square 5,000. Then two areas in one buy, by permit, at the lowered price.
  await write('lowerPrices', board, boardArt.abi, 'lowerPrices', [5_000n]);
  const halved = await read<bigint>(board, boardArt.abi, 'quote', [0, 1, 2, 2]);
  if (halved !== 30_000n) throw new Error(`smoke quote after lowering to half is ${halved}, not 30,000`);
  const total = halved + (await read<bigint>(board, boardArt.abi, 'quote', [5, 5, 1, 1]));
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
  const holder = await read<Address>(board, boardArt.abi, 'ownerOf', [2n]);
  if (!same(holder, recipient)) throw new Error(`smoke block is held by ${holder}, not ${recipient}`);
  const second = await read<Address>(board, boardArt.abi, 'ownerOf', [3n]);
  if (!same(second, recipient)) throw new Error(`smoke block 3 is held by ${second}, not ${recipient}`);
  // The buy must have told marketplaces: one ERC-4906 MetadataUpdate from the collection.
  const updated = receipt.logs.filter((l) => same(l.address, collection));
  if (updated.length !== 1) throw new Error(`the smoke buy left ${updated.length} collection logs, not one MetadataUpdate`);
  const owed = await read<bigint>(board, boardArt.abi, 'pendingWithdrawals', [deployer.address]);
  if (owed !== total - (total * protocolBps) / 10_000n) throw new Error(`the board's holder is owed ${owed}`);
  console.log(`  smoke                board ${board} (token ${boardToken}): kept block 1 the creator's; prices lowered to half; 2×2 across the zone and a 1×1 in one buy for ${formatUnits(total, 6)} by permit → ${holder}; holder credited; MetadataUpdate (gas ${receipt.gasUsed})`);

  // A take: the deployer buys block 3's one cell back. Bought at half price, its floor is still the
  // creation price, so the take is 10,000 × 1.4 and its owner is credited 10,000 × 1.15.
  const kept1 = await read<`0x${string}`>(board, boardArt.abi, 'buyError', [[{ col: 29, row: 66, cols: 1, rows: 1 }]]);
  if (kept1 !== toFunctionSelector('CellsKept()')) throw new Error(`the kept square answered ${kept1}, not CellsKept`);
  const takeArea = [{ col: 5, row: 5, cols: 1, rows: 1 }];
  const take = await read<bigint>(board, boardArt.abi, 'quoteBlocks', [takeArea]);
  if (take !== 14_000n) throw new Error(`smoke take is ${take}, not 14,000`);
  await write('mint', token, usdArt.abi, 'mint', [deployer.address, take]);
  const taken = await signPermit(deployer, token, board, take, deadline);
  const takeReceipt = await write('buyBlocksWithPermit (a take)', board, boardArt.abi, 'buyBlocksWithPermit', [
    deployer.address, takeArea, take, deadline, taken.v, taken.r, taken.s,
  ]);
  const paidOut = await read<bigint>(board, boardArt.abi, 'pendingWithdrawals', [recipient]);
  if (paidOut !== 11_500n) throw new Error(`the displaced owner is owed ${paidOut}, not 11,500`);
  const left = await read<{ cellsLeft: number }>(board, boardArt.abi, 'blockOf', [3n]);
  if (left.cellsLeft !== 0) throw new Error(`block 3 has ${left.cellsLeft} cells left, not 0`);
  console.log(`  smoke take           block 3's cell taken for ${formatUnits(take, 6)}; its owner credited ${formatUnits(paidOut, 6)}; the kept square refused (gas ${takeReceipt.gasUsed})`);
}

console.log(`
Deployed. Record in packages/websitekit-sdk/src/image-boards.ts (IMAGE_BOARD_DEPLOYMENTS):

  implementation: '${implementation.toLowerCase()}', collection: '${collection.toLowerCase()}', token: '${token.toLowerCase()}',

Verify both on Blockscout:

  cd packages/websitekit-contracts
  forge verify-contract ${implementation} src/ImageBoard.sol:ImageBoard --chain-id ${activeChain.id} \\
    --verifier blockscout --verifier-url ${activeChain.blockExplorers.default.url}/api \\
    --constructor-args $(cast abi-encode "constructor(uint256,address)" ${protocolBps} ${protocolTreasury})
  forge verify-contract ${collection} src/ImageBoardCollection.sol:ImageBoardCollection --chain-id ${activeChain.id} \\
    --verifier blockscout --verifier-url ${activeChain.blockExplorers.default.url}/api \\
    --constructor-args $(cast abi-encode "constructor(string,string,address,address,address[],string)" "${collectionName}" "${collectionSymbol}" ${owner} ${implementation} "[${token}]" "${baseURI}")
`);
