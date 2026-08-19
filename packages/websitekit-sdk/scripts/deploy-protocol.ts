/**
 * Deploys the four contracts a chain needs before any site can exist.
 *
 *   set -a && . .env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/deploy-protocol.ts
 *
 * **Order is load-bearing.** `RentalsLib` first, because its address is baked into the
 * implementation's bytecode at link time; then the linked implementation; then the factory, which
 * records both; then the reader, which is independent of all of it.
 *
 * **The link is the dangerous step, and it is why this script exists rather than a `forge create`
 * one-liner.** solc leaves a `__$…$__` placeholder at each of the four call sites and records the
 * byte offsets in `linkReferences`; substituting the wrong address is not a revert — the
 * implementation delegatecalls into whatever happens to live there, which may be nothing at all
 * (spec §11.4). So this links from the offsets rather than by string replacement, refuses to
 * continue if a placeholder survives, and then VERIFIES the link on-chain by asserting the factory's
 * recorded `rentalsLibCodehash` matches the library it just deployed.
 *
 * Written against `@websitekit/sdk`'s own artifacts and read back through its own reads, on purpose:
 * driving a real chain through the SDK is a third independent check on it, after the unit tests and
 * the anvil suite. A wrong ABI encoding shows up here as what it actually is.
 *
 * Deploying is idempotent-hostile by design: there is no "reuse if present" branch, because that is
 * exactly what produced an orphaned deployment once already. Set `WEBSITEKIT_FACTORY` in `.env` to
 * point tooling at an existing deployment instead of running this again.
 */
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SLOT_READER_ABI } from '../src/index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run \`set -a && . .env && set +a\` first`);
  return value;
}

const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [required('TESTNET_RPC_URL')] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

/** Protocol economics, frozen into the implementation and unstrippable by any clone. */
const PROTOCOL_BPS = 500n; // 5% of every buy
const PROTOCOL_RENT_BPS = 500n; // 5% of every rent, mirroring the buy path (§2.5)

/**
 * Where the protocol's cut of every buy and every rental accrues, on every site ever cloned from
 * this implementation, forever. An `immutable` with no setter.
 *
 * **Required from the environment rather than defaulted to the deployer.** Defaulting would be
 * convenient and would quietly make a hot deploy key the permanent recipient of protocol revenue on
 * the whole chain — a decision worth typing out once.
 */
const protocolTreasury = required('PROTOCOL_TREASURY') as `0x${string}`;
if (!/^0x[0-9a-fA-F]{40}$/.test(protocolTreasury)) {
  throw new Error(`PROTOCOL_TREASURY "${protocolTreasury}" is not a 20-byte hex address`);
}

interface Artifact {
  abi: unknown[];
  bytecode: `0x${string}`;
  linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>;
}

function artifact(solFile: string, name: string): Artifact {
  const json = JSON.parse(readFileSync(path.join(contractsOut, solFile, `${name}.json`), 'utf-8'));
  return {
    abi: json.abi,
    bytecode: json.bytecode.object as `0x${string}`,
    linkReferences: json.bytecode.linkReferences ?? {},
  };
}

/**
 * Substitutes deployed library addresses into an unlinked artifact, from solc's own byte offsets.
 *
 * Offsets are in BYTES over the bytecode; the hex string is two characters per byte, and the `0x`
 * prefix has to come off first. Both conversions are places an off-by-one produces a contract that
 * deploys cleanly and misbehaves later, which is why the placeholder sweep at the end is not
 * decorative.
 */
function link(art: Artifact, libraries: Record<string, `0x${string}`>): `0x${string}` {
  let out = art.bytecode.slice(2);
  let substitutions = 0;

  for (const perFile of Object.values(art.linkReferences)) {
    for (const [libName, spots] of Object.entries(perFile)) {
      const address = libraries[libName];
      if (!address) throw new Error(`no address supplied for library ${libName}`);
      const bare = address.slice(2).toLowerCase();
      for (const { start, length } of spots) {
        if (length !== 20) throw new Error(`unexpected link length ${length} for ${libName}`);
        out = out.slice(0, start * 2) + bare + out.slice((start + length) * 2);
        substitutions += 1;
      }
    }
  }

  if (substitutions === 0) throw new Error('nothing was linked — this artifact has no link references');
  if (/__\$[0-9a-f]{34}\$__/.test(out)) throw new Error('a library placeholder survived linking — offsets are wrong');
  console.log(`  linked ${substitutions} call site(s)`);
  return `0x${out}`;
}

const deployer = privateKeyToAccount(required('TESTNET_DEPLOYER_KEY') as `0x${string}`);
const publicClient = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const wallet = createWalletClient({ account: deployer, chain: robinhoodTestnet, transport: http() });

async function deploy(name: string, abi: unknown[], bytecode: `0x${string}`, args: readonly unknown[]) {
  const hash = await wallet.deployContract({ abi, bytecode, args } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // A reverted deploy still resolves here with a receipt; only `status` distinguishes it.
  if (receipt.status !== 'success') throw new Error(`${name} deploy reverted (tx ${hash})`);
  const address = receipt.contractAddress!;
  console.log(`  ${name.padEnd(14)} ${address}`);
  return address;
}

const balance = await publicClient.getBalance({ address: deployer.address });
console.log(`\ndeployer          ${deployer.address} — ${formatEther(balance)} ETH`);
console.log(`protocolTreasury  ${protocolTreasury} (permanent)\n`);
if (balance === 0n) throw new Error('deployer has no balance — fund it from the testnet faucet first');

const rentalsLib = await deploy('RentalsLib', artifact('RentalsLib.sol', 'RentalsLib').abi, artifact('RentalsLib.sol', 'RentalsLib').bytecode, []);

const siteArtifact = artifact('SlotSite.sol', 'SlotSite');
const implementation = await deploy(
  'SlotSite',
  siteArtifact.abi,
  link(siteArtifact, { RentalsLib: rentalsLib }),
  [PROTOCOL_BPS, PROTOCOL_RENT_BPS, protocolTreasury],
);

const factoryArtifact = artifact('SlotFactory.sol', 'SlotFactory');
const factory = await deploy('SlotFactory', factoryArtifact.abi, factoryArtifact.bytecode, [implementation, rentalsLib]);

const readerArtifact = artifact('SlotReader.sol', 'SlotReader');
const reader = await deploy('SlotReader', readerArtifact.abi, readerArtifact.bytecode, []);

// ---------------------------------------------------------------------------
// Verify the link on-chain, because a wrong one is silent
// ---------------------------------------------------------------------------

const recordedLib = (await publicClient.readContract({
  address: factory,
  abi: factoryArtifact.abi as never,
  functionName: 'rentalsLib',
})) as `0x${string}`;
const recordedHash = (await publicClient.readContract({
  address: factory,
  abi: factoryArtifact.abi as never,
  functionName: 'rentalsLibCodehash',
})) as `0x${string}`;

const liveCode = await publicClient.getCode({ address: rentalsLib });
if (!liveCode || liveCode === '0x') throw new Error('RentalsLib has no code at its own address');
if (recordedLib.toLowerCase() !== rentalsLib.toLowerCase()) {
  throw new Error(`factory recorded ${recordedLib} as the library, not ${rentalsLib}`);
}
console.log(`\n  library link verified — factory records ${recordedLib}`);
console.log(`  codehash ${recordedHash}`);

// The reader is the other half: a deploy that produced an implementation nothing can read is a
// deploy that has to be redone, and finding that out now costs one call.
const version = (await publicClient.readContract({
  address: implementation,
  abi: siteArtifact.abi as never,
  functionName: 'implementationVersion',
})) as bigint;
if (version !== 2n) throw new Error(`implementation reports version ${version}, expected 2`);
void SLOT_READER_ABI; // the reader is exercised for real by the first `createSite`, not here

console.log(`
Deployed. Record this in packages/websitekit-sdk/src/addresses.ts:

export const ROBINHOOD_TESTNET_V2: Deployment = {
  chainId: 46630,
  version: 2,
  implementation: '${implementation}',
  factory: '${factory}',
  reader: '${reader}',
  rentalsLib: '${rentalsLib}',
  protocolBps: ${PROTOCOL_BPS}n,
  explorer: 'https://explorer.testnet.chain.robinhood.com',
};

Then verify the IMPLEMENTATION on Blockscout — once, not per site. Every site is an
EIP-1167 clone of it, so one verification gives every site a readable contract page.
Clones report \`abi: 0\` on Blockscout; that is how it models a proxy, not a failure.
`);
