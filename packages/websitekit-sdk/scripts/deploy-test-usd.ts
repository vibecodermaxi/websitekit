/**
 * Deploys the testnet settlement stand-in, mints the first float, and prints what to record.
 *
 *   set -a && . .env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/deploy-test-usd.ts
 *
 * **Why a stand-in exists at all.** Chain 46630's USDG (`0x7E95…`) is a Paxos-shaped token whose
 * `mint` and `increaseSupplyToAddress` are role-gated. We hold no role and hold no balance, so
 * every board the platform issued against it is a board nobody can buy from — the settlement token
 * is frozen at `createSite`, so those boards cannot be repaired, only replaced. Native settlement
 * was not the alternative: `PIVOT-MAP` #25 settles that the managed platform issues
 * dollar-denominated boards only. Real USDG is wired up on mainnet; testnet gets this.
 *
 * **Six decimals is the load-bearing argument.** §11.2 derives `minFloor` from the token's own
 * `decimals()`, so a stand-in at 18 puts every floor in the starter set out by 1e12 — and
 * `createSite` validates the whole floor array, reverting with a selector that names no slot.
 *
 * Deploying twice is not an error this script can detect, and the consequence is worse than an
 * orphaned contract: boards created against the first token cannot be migrated to the second. If
 * `SETTLEMENT_TOKEN` is already set for this chain, you almost certainly do not want to run this.
 */
import { formatEther, formatUnits } from 'viem';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');

import {
  activeChain,
  deployer as deployerAccount,
  deployerWallet,
  describeChain,
  publicClient,
  required,
} from './lib/chain';

/**
 * **Refused off a testnet, and this is the one guard in this directory that is not about
 * convenience.** `TestUSD.mint` is permissionless — that is the entire point of a stand-in, and it
 * is what `SettlementToken.mintable` gates checkout's faucet on. Deploying one on a chain where the
 * money is real puts a token anybody can print beside a token nobody can, on the chain where the
 * fake `usdg` already has more holders than the real one. There is no argument for it, so there is
 * no override.
 */
if (!activeChain.testnet) {
  throw new Error(
    `deploy-test-usd refuses ${activeChain.name} (${activeChain.id}): a mintable stand-in belongs on a testnet only`,
  );
}

/** What it stands in for, and therefore what it must answer. */
const NAME = 'websitekit Test Dollar';
const SYMBOL = 'tUSD';
const DECIMALS = 6;

/**
 * The relayer's opening float, in whole units.
 *
 * The relayer needs a balance for two different jobs and only one of them is obvious: it will fund
 * buyers through the token's own permissionless `mint`, which costs it nothing — but a sponsored
 * `buyFor` spends the relayer's OWN balance, because the site pulls from `msg.sender`. This is the
 * second one.
 */
const RELAYER_FLOAT = 100_000;

const artifact = JSON.parse(readFileSync(path.join(contractsOut, 'TestUSD.sol', 'TestUSD.json'), 'utf-8'));
const abi = artifact.abi;
const bytecode = artifact.bytecode.object as `0x${string}`;

const deployer = deployerAccount();
const relayer = required('RELAYER_ADDRESS') as `0x${string}`;
const wallet = deployerWallet();

const balance = await publicClient.getBalance({ address: deployer.address });
console.log(`\n${describeChain()}`);
console.log(`deployer  ${deployer.address} — ${formatEther(balance)} ETH`);
console.log(`relayer   ${relayer}`);
console.log(`token     ${NAME} (${SYMBOL}), ${DECIMALS} decimals\n`);
if (balance === 0n) throw new Error('deployer has no balance — fund it from the testnet faucet first');

const hash = await wallet.deployContract({ abi, bytecode, args: [NAME, SYMBOL, DECIMALS] } as never);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
// A reverted deploy still resolves here with a receipt; only `status` distinguishes it.
if (receipt.status !== 'success') throw new Error(`TestUSD deploy reverted (tx ${hash})`);
const token = receipt.contractAddress!;
console.log(`  deployed  ${token}  (tx ${hash})`);

// ---------------------------------------------------------------------------
// Read it back before trusting it. A stand-in that answers the wrong `decimals()`
// is the one failure that stays silent until a whole board will not deploy.
// ---------------------------------------------------------------------------

const [onChainDecimals, onChainSymbol, cap] = await Promise.all([
  publicClient.readContract({ address: token, abi, functionName: 'decimals' }) as Promise<number>,
  publicClient.readContract({ address: token, abi, functionName: 'symbol' }) as Promise<string>,
  publicClient.readContract({ address: token, abi, functionName: 'maxMintPerCall' }) as Promise<bigint>,
]);
if (onChainDecimals !== DECIMALS) throw new Error(`deployed token reports ${onChainDecimals} decimals, not ${DECIMALS}`);
if (onChainSymbol !== SYMBOL) throw new Error(`deployed token reports symbol ${onChainSymbol}`);
console.log(`  reads back ${onChainSymbol}, ${onChainDecimals} decimals, cap ${formatUnits(cap, DECIMALS)}/call`);
console.log(`  minFloor for a board settling in it: ${10 ** (DECIMALS - 4)} units`);

const float = BigInt(RELAYER_FLOAT) * 10n ** BigInt(DECIMALS);
const mintHash = await wallet.writeContract({ address: token, abi, functionName: 'mint', args: [relayer, float] } as never);
const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
if (mintReceipt.status !== 'success') throw new Error(`mint to the relayer REVERTED (tx ${mintHash})`);

const relayerBalance = (await publicClient.readContract({
  address: token,
  abi,
  functionName: 'balanceOf',
  args: [relayer],
})) as bigint;
console.log(`  minted    ${formatUnits(relayerBalance, DECIMALS)} ${SYMBOL} to the relayer`);

console.log(`
Deployed. Record it in apps/platform/lib/settlement.ts:

  ${activeChain.id}: { address: '${token.toLowerCase()}', decimals: ${DECIMALS}, symbol: '${SYMBOL}', mintable: true }

\`mintable\` is not optional and not decoration: it is what stops checkout's faucet path existing
where the money is real. Add the entry and the flag together, never the entry alone.

Then verify on Blockscout:

  cd packages/websitekit-contracts && forge verify-contract ${token} \\
    src/mocks/TestUSD.sol:TestUSD --chain-id ${activeChain.id} \\
    --verifier blockscout --verifier-url ${activeChain.blockExplorers.default.url}/api \\
    --constructor-args \$(cast abi-encode "constructor(string,string,uint8)" "${NAME}" "${SYMBOL}" ${DECIMALS})

Boards already created against the OLD settlement token cannot be migrated — the token is frozen
at \`createSite\`. They have to be recreated.
`);
