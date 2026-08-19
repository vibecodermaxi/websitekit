/**
 * The chain wiring every script in this directory shares.
 *
 * **Why this exists rather than six copies.** Each script used to declare its own chain, its own
 * clients and its own `send()`. Three of those `send()`s never checked `receipt.status` — and
 * `waitForTransactionReceipt` RESOLVES on a revert rather than throwing, so a failed `edit` was
 * indistinguishable from a successful one until the board read back wrong two steps later. That is
 * the same hole the v2 end-to-end suite found in the SDK's own helper. One `send()` that checks
 * status is the fix; six is an invitation to reintroduce it.
 *
 * The accounts are memoized rather than eager so a script only demands the credentials it actually
 * uses: `chain-checks.ts` needs the taker key and no deployer key, and making it fail on an unset
 * `TESTNET_DEPLOYER_KEY` would be a lie about what it does.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  type Account,
  type Address,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { existsSync, readFileSync } from 'node:fs';

import {
  DEMO_SITE,
  EXAMPLE_SITES,
  ROBINHOOD_TESTNET,
  buildBuyFrom,
  parseFloor,
  readBuyContext,
  type SiteRef,
} from '../../src/index';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run \`set -a && . ./.env && set +a\` first`);
  return value;
}

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET.chainId,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [required('TESTNET_RPC_URL')] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_TESTNET.explorer } },
  testnet: true,
});

export const publicClient = createPublicClient({ chain: robinhoodTestnet, transport: http() });

function memo<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

export const deployer = memo(() => privateKeyToAccount(required('TESTNET_DEPLOYER_KEY') as `0x${string}`));
export const taker = memo(() => privateKeyToAccount(required('TESTNET_TAKER_KEY') as `0x${string}`));

const walletFor = (account: Account) =>
  createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

export const deployerWallet = memo(() => walletFor(deployer()));
export const takerWallet = memo(() => walletFor(taker()));

/**
 * The factory and reader, from the environment.
 *
 * **The factory is never deployed by a seed script.** `seed-demo.ts` used to deploy a fresh
 * implementation whenever `WEBSITEKIT_FACTORY` was unset, which is exactly how a full set of
 * contracts got orphaned on testnet once. There is one protocol deployment per chain and
 * `deploy-protocol.ts` owns it; everything here reads it.
 */
export const FACTORY = required('WEBSITEKIT_FACTORY') as Address;
export const READER = required('WEBSITEKIT_READER') as Address;

/** `{ site, reader }` — v2 reads take this, never a bare address (§11.4). */
export const refFor = (site: Address): SiteRef => ({ site, reader: READER });

/**
 * `minFloor` on a native 18-decimal site, from `_deriveMinFloor`: `10 ** (decimals - 4)` (§11.2).
 *
 * Hardcoding it here is safe only because every board in this directory settles natively. A
 * token-settled board derives a different number — 100 units on 6-decimal USDG — and `readSiteTerms`
 * is the authority for one.
 */
export const MIN_FLOOR = 10n ** 14n;

/**
 * A floor, in ETH, asserted against `minFloor`.
 *
 * **Never `parseEther`.** The house rule is that a floor parses against the SETTLEMENT token's
 * decimals; `parseEther` hardcodes 18 and is silently right here and wrong by 1e12 on USDG. The
 * assertion is the other half: every floor these boards carried at v1 — `0.00008`, `0.000004` —
 * sits BELOW v2's `minFloor` and reverts `InvalidFloor` at `createSite`, which is a whole board
 * failing to deploy for one number in a table nobody re-reads.
 */
export function floor(eth: string): bigint {
  const value = parseFloor(eth, 18);
  if (value < MIN_FLOOR) {
    throw new RangeError(
      `websitekit/scripts: floor ${eth} ETH is ${value}, below minFloor ${MIN_FLOOR} — see §11.2`,
    );
  }
  return value;
}

/**
 * Sends a transaction and refuses to call a revert a success.
 *
 * `waitForTransactionReceipt` resolves for a reverted transaction and reports it in `status`. Every
 * caller here has to check it, so no caller does it itself.
 */
export async function send(wallet: WalletClient, label: string, request: unknown) {
  const hash = await wallet.writeContract(request as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted (tx ${hash})`);
  return receipt;
}

/** Balance in ETH, formatted, for the one-line reports every script opens with. */
export async function balanceOf(address: Address): Promise<string> {
  return formatEther(await publicClient.getBalance({ address }));
}

/**
 * Checks a wallet can afford what it is about to spend, and tops it up from the deployer if not.
 *
 * **A seed script that dies half-way through a board is the failure worth engineering against.**
 * It leaves a board that is neither empty nor seeded, and re-running it walks prices up on whatever
 * it already claimed. Estimating first turns that into a message before anything is spent.
 *
 * Topping the taker up from the deployer is not robbing Peter to pay Paul: the deployer is the
 * treasury on every board here, so ~95% of every claim the taker makes lands back with it. The
 * split between the two wallets is a fiction for making the boards look multi-owner, and the
 * transfer just corrects for the fiction being unbalanced.
 */
export async function ensureFunded(account: Account, needsWei: bigint, label: string) {
  const have = await publicClient.getBalance({ address: account.address });
  if (have >= needsWei) {
    console.log(`  ${label.padEnd(8)} ${formatEther(have)} ETH — needs ~${formatEther(needsWei)}, ok`);
    return;
  }
  const short = needsWei - have;
  if (account.address === deployer().address) {
    throw new Error(
      `deployer holds ${formatEther(have)} ETH and needs ~${formatEther(needsWei)} — top it up from a faucet`,
    );
  }
  console.log(`  ${label.padEnd(8)} ${formatEther(have)} ETH — needs ~${formatEther(needsWei)}, topping up ${formatEther(short)}`);
  const hash = await deployerWallet().sendTransaction({
    account: deployer(),
    chain: robinhoodTestnet,
    to: account.address,
    value: short,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`top-up to ${label} reverted (tx ${hash})`);
}

/**
 * Claims or takes one slot, and returns what it cost.
 *
 * Goes through `readBuyContext` + `buildBuyFrom` rather than assembling a `buy` by hand, because
 * that pair is what pins the quote, the encumbrance hash and the CHAIN's clock to a single block.
 * A hand-built buy is where a torn read and a wall-clock deadline both come from, and both look
 * like the chain misbehaving rather than like a client bug.
 */
export async function buy(
  wallet: WalletClient,
  ref: SiteRef,
  key: string,
  settlementToken: Address,
): Promise<bigint> {
  const context = await readBuyContext(publicClient, ref, key);
  await send(wallet, `buy ${key}`, {
    ...buildBuyFrom(ref.site, context, settlementToken),
    account: wallet.account,
  });
  return context.slot.charged;
}

/**
 * Where the seeded boards live, resolved in the order that is true soonest.
 *
 * `seed-examples.ts` writes `examples.json` the moment each site is created, and `src/addresses.ts`
 * is only updated afterwards by hand. So a freshly seeded board exists in the ledger before it
 * exists in the published constant, and a script run in between would otherwise read the PREVIOUS
 * generation's addresses and quietly seed content onto boards nobody is looking at. The ledger wins
 * when it exists; the constant is the answer for anyone who did not just run the seeder.
 */
export function exampleSites(): Record<string, Address> {
  const ledgerPath = new URL('../examples.json', import.meta.url);
  if (!existsSync(ledgerPath)) return { ...EXAMPLE_SITES };

  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
    version?: number;
    sites?: Record<string, Address>;
  };
  // A ledger from an earlier contract generation names boards this SDK cannot read at all. Refusing
  // is the whole point: the untagged v1 ledger was read as current once, and the only reason it did
  // not seed content onto unreadable boards was that `readTerms` happened to revert first.
  if (ledger.version !== 2) {
    throw new Error(
      `scripts/examples.json is a v${ledger.version ?? 1} ledger — move it aside; its boards are not v2 clones`,
    );
  }
  return { ...ledger.sites };
}

/**
 * The demo board. `WEBSITEKIT_DEMO_SITE` overrides the published constant, for the window between
 * `seed-demo.ts` printing a fresh address and `src/addresses.ts` being updated with it.
 */
export function demoSite(): Address {
  return (process.env.WEBSITEKIT_DEMO_SITE as Address | undefined) ?? DEMO_SITE;
}

/**
 * What one `edit` costs in gas money, padded.
 *
 * An edit moves no value, so a script that only writes content looks free and is not — it still has
 * to pay for a transaction, and a wallet that runs out mid-run fails its GAS ESTIMATE. viem reports
 * that as `execution reverted` with no revert data, which reads as the contract refusing the call.
 * That is the trap this constant exists to keep a budget check in front of: an edit measured ~60k
 * gas, this pads to 400k at ~1.5x the observed 0.13 gwei.
 */
export const EDIT_GAS = 400_000n * 200_000_000n;
