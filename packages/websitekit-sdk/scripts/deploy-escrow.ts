/**
 * Deploys render escrow's two contracts onto a chain that already has a protocol generation.
 *
 *   set -a && . ./.env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/deploy-escrow.ts
 *
 * `docs/escrow_contract.md` §10, *Deployment, and the bind is the part anyone can check*.
 *
 * **Order is load-bearing, and shorter than the protocol's.** `Attestor` first, because
 * `EscrowFactory`'s constructor deploys the vault implementation and hands it the registry's
 * address as an immutable; then the factory. There is no third step: the vault implementation is
 * created BY the factory's constructor, since a vault needs its factory's address and a factory
 * needs its implementation's, and one of the two has to create the other.
 *
 * **The generation check runs BEFORE anything is deployed, and it is the reason this script is not
 * two `forge create` lines.** An `EscrowFactory` bound to a `SlotFactory` whose implementation
 * predates `SiteConfig.pinTreasury` is not broken on deploy — it is broken on the first
 * `createEscrowedSite`, which reverts on an ABI mismatch after a publisher has signed. So the
 * implementation is asked for `treasuryPinned()` first: `SlotSite` has a `receive()` and no
 * `fallback()`, so an unknown selector reverts, and a generation without the pin fails this call
 * rather than answering it.
 *
 * **Nothing here is frozen and that is the point.** The vault, the factory and the registry are all
 * redeployable and none is generation-bound — they can be pointed at any pinned board. `setParams`
 * and `allowToken` are the owner's, and `setAttestor` moves the referee key without touching a
 * vault. What cannot be changed afterwards is which `SlotFactory` this factory creates boards
 * through, and which registry its vaults read.
 *
 * Written against the SDK's own artifacts and read back through viem, for the reason
 * `deploy-protocol.ts` gives: driving a real chain is a third independent check after the unit
 * tests and the anvil suite, and a wrong encoding shows up here as what it actually is.
 */
import { formatEther } from 'viem';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deployer as deployerAccount,
  deployerWallet,
  describeChain,
  publicClient,
  required,
} from './lib/chain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');

function address(name: string): `0x${string}` {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} "${value}" is not a 20-byte hex address`);
  return value as `0x${string}`;
}

/**
 * The four vault parameters, required from the environment rather than defaulted.
 *
 * Same reasoning as `PROTOCOL_TREASURY` one script over: a default here is a policy decision made
 * by whoever last edited a constant, and these decide how long a publisher waits for their own
 * money and how long a holder waits to claim against them. `setParams` can move all four later,
 * so this is a starting position rather than a commitment — but it should be a typed one.
 *
 * `docs/escrow_contract.md` §11 settles the production values at 14 days / 12 hours / 6 hours.
 * A chain being driven by hand wants far shorter, or the loop cannot be seen in one sitting.
 */
function params(): { windowSecs: bigint; claimDelaySecs: bigint; minTransitionSecs: bigint; minBooking: bigint } {
  const missing = ['ESCROW_WINDOW_SECS', 'ESCROW_CLAIM_DELAY_SECS', 'ESCROW_MIN_TRANSITION_SECS', 'ESCROW_MIN_BOOKING']
    .filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} not set. The four vault parameters are deliberately not defaulted.\n\n` +
        '  For a testnet chain driven by hand:\n' +
        '    ESCROW_WINDOW_SECS=3600          # 1 hour  — a deposit matures this long after booking\n' +
        '    ESCROW_CLAIM_DELAY_SECS=900      # 15 min  — after markDark, before any holder may claim\n' +
        '    ESCROW_MIN_TRANSITION_SECS=600   # 10 min  — spacing between markDark/clearDark\n' +
        '    ESCROW_MIN_BOOKING=1             # 1 unit  — below this, inbound stays unbooked\n\n' +
        '  The settled production values (docs/escrow_contract.md §11):\n' +
        '    1209600 / 43200 / 21600',
    );
  }
  const p = {
    windowSecs: BigInt(required('ESCROW_WINDOW_SECS')),
    claimDelaySecs: BigInt(required('ESCROW_CLAIM_DELAY_SECS')),
    minTransitionSecs: BigInt(required('ESCROW_MIN_TRANSITION_SECS')),
    minBooking: BigInt(required('ESCROW_MIN_BOOKING')),
  };
  // The contract's own guard, run before the gas is spent rather than after.
  if (p.windowSecs === 0n) throw new Error('ESCROW_WINDOW_SECS may not be zero — EscrowFactory reverts InvalidParams');
  return p;
}

/**
 * The settlement tokens a board may be escrowed in, as an allowlist.
 *
 * `createEscrowedSite` refuses `TokenNotAllowed` for anything else, which is what stops a board
 * being created against a token whose transfer semantics the vault's accounting has never seen —
 * a fee-on-transfer or rebasing token would make `book()`'s balance delta lie. Native is
 * `0x0000000000000000000000000000000000000000` and the platform issues no native board (`PIVOT-MAP`
 * #25), so on a platform chain this is the settlement token and nothing else.
 */
function tokens(): `0x${string}`[] {
  const raw = required('ESCROW_TOKENS');
  const list = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('ESCROW_TOKENS is empty — a factory that allows no token can create no board');
  for (const t of list) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new Error(`ESCROW_TOKENS entry "${t}" is not a 20-byte hex address`);
  }
  return list as `0x${string}`[];
}

interface Artifact {
  abi: unknown[];
  bytecode: `0x${string}`;
}

function artifact(solFile: string, name: string): Artifact {
  const json = JSON.parse(readFileSync(path.join(contractsOut, solFile, `${name}.json`), 'utf-8'));
  return { abi: json.abi, bytecode: json.bytecode.object as `0x${string}` };
}

const deployer = deployerAccount();
const wallet = deployerWallet();

async function deploy(name: string, abi: unknown[], bytecode: `0x${string}`, args: readonly unknown[]) {
  const hash = await wallet.deployContract({ abi, bytecode, args } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // A reverted deploy still resolves here with a receipt; only `status` distinguishes it.
  if (receipt.status !== 'success') throw new Error(`${name} deploy reverted (tx ${hash})`);
  const deployed = receipt.contractAddress!;
  console.log(`  ${name.padEnd(14)} ${deployed}`);
  return deployed;
}

const slotFactory = address('WEBSITEKIT_FACTORY');
/**
 * The referee, and it is its own variable — **the argument that used to be here was true and
 * stopped being true on 2026-09-17.**
 *
 * It read `RELAYER_ADDRESS`, reasoning that `markDark`/`clearDark` are sent by `lib/relayer.ts`
 * with `RELAYER_PRIVATE_KEY`, so a second variable would be a second place for one fact whose
 * disagreement is silent — a vault that refuses every mark, found the first time a real board goes
 * dark. E-0 split the keys: `relayer.ts` signs those two calls with `attestorAccount()`, reading
 * `ESCROW_ATTESTOR_KEY`. So this script was naming the relayer in a registry the code no longer
 * signs as, which is the exact failure the old comment predicted, arriving through the door it left
 * open. The live testnet registry names neither — somebody moved it by hand with `setAttestor`.
 *
 * **Refused when it equals the relayer**, because that is E-0's rule and a note is not a rule. The
 * two capabilities have different blast radii: the relayer holds everyone's money, the referee can
 * only mark a board dark and can pay nobody. Collapsing them makes the separation cosmetic.
 */
const referee = address('ESCROW_ATTESTOR_ADDRESS');
if (referee.toLowerCase() === (process.env.RELAYER_ADDRESS ?? '').toLowerCase()) {
  throw new Error(
    'ESCROW_ATTESTOR_ADDRESS is the relayer. The referee key must be separate — docs/escrow_mainnet.md E-0.',
  );
}
const vaultParams = params();
const allowed = tokens();

const balance = await publicClient.getBalance({ address: deployer.address });
console.log(`\n${describeChain()}`);
console.log(`deployer          ${deployer.address} — ${formatEther(balance)} ETH`);
console.log(`slotFactory       ${slotFactory}`);
console.log(`referee           ${referee} (the one privileged key — docs/escrow_contract.md §7)`);
console.log(`window            ${vaultParams.windowSecs}s, claim delay ${vaultParams.claimDelaySecs}s, spacing ${vaultParams.minTransitionSecs}s, minBooking ${vaultParams.minBooking}`);
console.log(`tokens            ${allowed.join(', ')}\n`);
if (balance === 0n) throw new Error('deployer has no balance — fund it from the testnet faucet first');

// ---------------------------------------------------------------------------
// The generation check, before a single deploy
// ---------------------------------------------------------------------------

const slotFactoryAbi = artifact('SlotFactory.sol', 'SlotFactory').abi;
const siteAbi = artifact('SlotSite.sol', 'SlotSite').abi;

const implementation = (await publicClient.readContract({
  address: slotFactory,
  abi: slotFactoryAbi as never,
  functionName: 'implementation',
})) as `0x${string}`;

try {
  await publicClient.readContract({ address: implementation, abi: siteAbi as never, functionName: 'treasuryPinned' });
} catch {
  throw new Error(
    `the implementation at ${implementation} does not answer treasuryPinned() — WEBSITEKIT_FACTORY names a ` +
      'generation from before the pin. Escrow cannot be deployed against it: createEscrowedSite would revert ' +
      'on its first call. Run scripts/deploy-protocol.ts and point WEBSITEKIT_FACTORY at the new factory.',
  );
}
console.log(`  generation check ok — implementation ${implementation} carries the pin\n`);

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

const attestorArtifact = artifact('Attestor.sol', 'Attestor');
const registry = await deploy('Attestor', attestorArtifact.abi, attestorArtifact.bytecode, [deployer.address, referee]);

const factoryArtifact = artifact('EscrowFactory.sol', 'EscrowFactory');
const escrowFactory = await deploy('EscrowFactory', factoryArtifact.abi, factoryArtifact.bytecode, [
  deployer.address,
  slotFactory,
  registry,
  vaultParams,
  allowed,
]);

// ---------------------------------------------------------------------------
// Verify, because every one of these is silent when wrong
// ---------------------------------------------------------------------------

async function readFactory(functionName: string, args: readonly unknown[] = []) {
  return publicClient.readContract({ address: escrowFactory, abi: factoryArtifact.abi as never, functionName, args } as never);
}

const recordedAttestor = (await publicClient.readContract({
  address: registry,
  abi: attestorArtifact.abi as never,
  functionName: 'attestor',
})) as `0x${string}`;
if (recordedAttestor.toLowerCase() !== referee.toLowerCase()) {
  throw new Error(`registry records ${recordedAttestor} as the referee, not ${referee}`);
}

const recordedFactory = (await readFactory('slotFactory')) as `0x${string}`;
if (recordedFactory.toLowerCase() !== slotFactory.toLowerCase()) {
  throw new Error(`escrow factory records ${recordedFactory} as its SlotFactory, not ${slotFactory}`);
}

const vaultImplementation = (await readFactory('vaultImplementation')) as `0x${string}`;
const vaultCode = await publicClient.getCode({ address: vaultImplementation });
if (!vaultCode || vaultCode === '0x') throw new Error('the vault implementation has no code at its own address');

const [windowSecs, claimDelaySecs, minTransitionSecs, minBooking] = (await readFactory('params')) as [bigint, bigint, bigint, bigint];
if (
  windowSecs !== vaultParams.windowSecs ||
  claimDelaySecs !== vaultParams.claimDelaySecs ||
  minTransitionSecs !== vaultParams.minTransitionSecs ||
  minBooking !== vaultParams.minBooking
) {
  throw new Error(`factory records params ${windowSecs}/${claimDelaySecs}/${minTransitionSecs}/${minBooking}, not what was asked for`);
}

for (const token of allowed) {
  if (!(await readFactory('tokenAllowed', [token]))) throw new Error(`${token} was not allowed by the constructor`);
}

console.log(`
  referee verified          registry ${registry} answers ${recordedAttestor}
  slot factory verified     ${recordedFactory}
  vault implementation      ${vaultImplementation} (${(vaultCode.length - 2) / 2} B)
  params verified           ${windowSecs}s / ${claimDelaySecs}s / ${minTransitionSecs}s / ${minBooking}
  tokens verified           ${allowed.length} allowed

Deployed. Set these on the platform (.env and apps/platform/.env.local):

ESCROW_FACTORY=${escrowFactory}
ESCROW_ATTESTOR=${registry}

ESCROW_ATTESTOR_KEY must stay the key for the address the registry names, or every markDark
reverts. It is NOT the relayer key — see the referee note above. Nothing is
escrowed until a board is CREATED through this factory — existing boards are pinned to nothing
and cannot be attached to a vault, because treasury is frozen at createSite.

Then: prove-escrow.ts phase 1, wait ${claimDelaySecs}s, phase 2 with the addresses it prints.
`);
