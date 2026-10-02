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
 * **And it did not stop the CHAIN being copied — 2026-09-18.** `deploy-protocol.ts`,
 * `deploy-escrow.ts`, `deploy-test-usd.ts` and `smoke-deployment.ts` each carried their own
 * `defineChain` with their own local `required()`, and `chain-checks.ts` carried a fifth for
 * mainnet. **The reason was mechanical rather than careless, and it is the thing that was actually
 * fixed:** `FACTORY` and `READER` below used to be EAGER `required()` calls at module scope, so a
 * script that deploys the factory could not import this module at all — the factory does not exist
 * yet. Copying the chain was the cheapest way out, and every copy then had to be kept in step by
 * hand.
 *
 * That was this file's own argument, made two paragraphs above and applied to the keys only: *the
 * accounts are memoized rather than eager so a script only demands the credentials it actually
 * uses.* `chain-checks.ts` uses neither the factory nor the reader and refused to start without
 * both — measured, not inferred. They are memoized now, for the reason the keys already were.
 *
 * **Which chain: `WEBSITEKIT_CHAIN_ID`, unset meaning the testnet.** Same shape as the platform's
 * `NEXT_PUBLIC_CHAIN_ID` and deliberately NOT the same variable — this package is published, and a
 * Next.js prefix in it would be a framework leaking into a library. The two are independent on
 * purpose: driving `prove-*` against the testnet while production serves mainnet is a thing an
 * operator should be able to do without editing the product's environment.
 *
 * **An unrecognised value throws** (`chainFor`), because the only fallback available is the testnet
 * and a typo meaning mainnet would otherwise run a deploy somewhere nobody chose.
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
  ROBINHOOD_TESTNET_CHAIN,
  approvalFor,
  buildBuyFrom,
  demoSiteFor,
  exampleSitesFor,
  chainFor,
  parseFloor,
  readBuyContext,
  type Chain,
  type SiteRef,
} from '../../src/index';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run \`set -a && . ./.env && set +a\` first`);
  return value;
}

export function resolveScriptChain(declared: string | undefined): Chain {
  if (!declared) return ROBINHOOD_TESTNET_CHAIN;
  const id = Number(declared);
  if (!Number.isInteger(id)) {
    throw new Error(`WEBSITEKIT_CHAIN_ID is ${JSON.stringify(declared)}, which is not a chain id`);
  }
  return chainFor(id);
}

const active = resolveScriptChain(process.env.WEBSITEKIT_CHAIN_ID);

/**
 * A value whose `TESTNET_`-prefixed name may only be read while the chain IS a testnet.
 *
 * **This is the rule that matters most in this file, and it is about the KEYS rather than the
 * endpoint.** Every credential here is named `TESTNET_DEPLOYER_KEY` / `TESTNET_TAKER_KEY`, which
 * was honest while there was one chain. Pointing these scripts at mainnet leaves two ways to go and
 * both are bad: put a mainnet key in a variable called `TESTNET_`, which is the naming lie this
 * repo just spent a rename removing from `robinhoodTestnet`; or read a testnet key on mainnet,
 * which is an account with no funds failing its GAS ESTIMATE — reported by viem as `execution
 * reverted` with no revert data, the error shape this repo has already lost a session to.
 *
 * So the neutral name wins everywhere, and the legacy one answers only where it is true. On a
 * mainnet chain `TESTNET_DEPLOYER_KEY` is not a fallback, it is invisible.
 */
export function scopedEnv(
  chain: Chain,
  name: string,
  legacyTestnet: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const declared = env[name];
  if (declared) return declared;
  if (chain.testnet) return env[legacyTestnet] || undefined;
  return undefined;
}

/**
 * The same, refusing rather than answering undefined.
 *
 * **The chain is a PARAMETER rather than the module's own `active`, and that is a test boundary.**
 * Closed over `active`, the mainnet branch is unreachable from a suite — the only chain a test can
 * get through this module is the one the environment selected, and in this workspace that is a
 * testnet, so *every* assertion would pass against a version that ignored the scope entirely. That
 * is `apps/platform/lib/chain.ts`'s `viemChainFor` finding, and the fix is the same one: hand it
 * the chain it would not otherwise see.
 */
export function requireScopedEnv(
  chain: Chain,
  name: string,
  legacyTestnet: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = scopedEnv(chain, name, legacyTestnet, env);
  if (value) return value;
  const alsoTried = chain.testnet ? ` (or ${legacyTestnet})` : '';
  throw new Error(
    `${name}${alsoTried} is not set for ${chain.name} — run \`set -a && . ./.env && set +a\` first`,
  );
}

/**
 * The chain these scripts drive.
 *
 * **The resolved endpoint goes INTO `rpcUrls`**, which is what lets every `http()` with no argument
 * in this directory stay correct. That is the opposite of `apps/platform/lib/chain.ts`, where the
 * record carries the PUBLIC endpoint because it is shipped to a browser and the private one is a
 * separate export — the asymmetry is deliberate and follows from who reads each.
 */
export const activeChain = defineChain({
  id: active.id,
  name: active.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [scopedEnv(active, 'CHAIN_RPC_URL', 'TESTNET_RPC_URL') ?? active.rpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: active.explorer } },
  testnet: active.testnet,
});

/** One line every script prints before it does anything, so nobody drives the wrong chain blind. */
export function describeChain(): string {
  return `chain             ${activeChain.id} ${activeChain.name}${activeChain.testnet ? '' : ' — REAL MONEY'}`;
}

export const publicClient = createPublicClient({ chain: activeChain, transport: http() });

function memo<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

export const deployer = memo(() =>
  privateKeyToAccount(requireScopedEnv(active, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY') as `0x${string}`),
);
export const taker = memo(() =>
  privateKeyToAccount(requireScopedEnv(active, 'TAKER_KEY', 'TESTNET_TAKER_KEY') as `0x${string}`),
);

const walletFor = (account: Account) =>
  createWalletClient({ account, chain: activeChain, transport: http() });

export const deployerWallet = memo(() => walletFor(deployer()));
export const takerWallet = memo(() => walletFor(taker()));

/**
 * The factory and reader, from the environment, resolved ON FIRST USE.
 *
 * **The factory is never deployed by a seed script.** `seed-demo.ts` used to deploy a fresh
 * implementation whenever `WEBSITEKIT_FACTORY` was unset, which is exactly how a full set of
 * contracts got orphaned on testnet once. There is one protocol deployment per chain and
 * `deploy-protocol.ts` owns it; everything here reads it.
 *
 * **Lazy rather than eager, which is what unblocked sharing this module at all** — see the header.
 * A deploy script imports the chain and never asks for a factory that does not exist yet, and
 * `chain-checks.ts` asks for neither.
 */
export const factory = memo(() => required('WEBSITEKIT_FACTORY') as Address);
export const reader = memo(() => required('WEBSITEKIT_READER') as Address);

/** `{ site, reader }` — v2 reads take this, never a bare address (§11.4). */
export const refFor = (site: Address): SiteRef => ({ site, reader: reader() });

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
    chain: activeChain,
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
  const request = buildBuyFrom(ref.site, context, settlementToken);
  // A token-settled board pulls the price with `transferFrom`, so the allowance has to land first —
  // and be MINED first, or the buy is estimated against no allowance and reverts. `null` natively.
  const approval = approvalFor(request, settlementToken);
  if (approval) await send(wallet, `approve ${key}`, { ...approval, account: wallet.account });
  await send(wallet, `buy ${key}`, { ...request, account: wallet.account });
  return context.slot.charged;
}

/**
 * The example-board ledger for the ACTIVE chain: `examples.json` on the testnet, where it has always
 * lived, and `examples.<chainId>.json` anywhere else. Per chain rather than one file with a map,
 * because every guard in `seed-examples.ts` refuses a ledger for another chain outright — so two
 * chains in one file would make whichever ran second refuse to run at all.
 */
export function examplesLedgerPath(): URL {
  return new URL(active.testnet ? '../examples.json' : `../examples.${active.id}.json`, import.meta.url);
}

/**
 * Where the seeded boards live, resolved in the order that is true soonest.
 *
 * `seed-examples.ts` writes the ledger the moment each site is created, and `src/addresses.ts` is
 * only updated afterwards by hand. So a freshly seeded board exists in the ledger before it exists
 * in the published constant, and a script run in between would otherwise read the PREVIOUS
 * generation's addresses and quietly seed content onto boards nobody is looking at. The ledger wins
 * when it exists; the published constant for this chain is the answer otherwise.
 */
export function exampleSites(): Record<string, Address> {
  const ledgerPath = examplesLedgerPath();
  if (!existsSync(ledgerPath)) {
    const published = exampleSitesFor(active.id);
    if (!published) throw new Error(`no example boards are recorded for ${active.name}`);
    return { ...published };
  }

  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
    version?: number;
    chainId?: number;
    sites?: Record<string, Address>;
  };
  // A ledger from an earlier contract generation names boards this SDK cannot read at all. Refusing
  // is the whole point: the untagged v1 ledger was read as current once, and the only reason it did
  // not seed content onto unreadable boards was that `readTerms` happened to revert first.
  if (ledger.version !== 2) {
    throw new Error(`${ledgerPath.pathname} is a v${ledger.version ?? 1} ledger — move it aside; its boards are not v2 clones`);
  }
  if (ledger.chainId !== active.id) {
    throw new Error(`${ledgerPath.pathname} is for chain ${ledger.chainId}, not ${active.id}`);
  }
  return { ...ledger.sites };
}

/**
 * The demo board. `WEBSITEKIT_DEMO_SITE` overrides the published constant, for the window between
 * `seed-demo.ts` printing a fresh address and `src/addresses.ts` being updated with it.
 */
export function demoSite(): Address {
  const site = (process.env.WEBSITEKIT_DEMO_SITE as Address | undefined) ?? demoSiteFor(active.id);
  if (!site) throw new Error(`no demo board is recorded for ${active.name} — set WEBSITEKIT_DEMO_SITE`);
  return site;
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
