/**
 * `pnpm deploy:site` — one transaction, and you own a site.
 *
 * This ships as readable source inside your project rather than behind a CLI binary on purpose.
 * Deploying a site is a single `createSite` call; a builder who can read the thirty lines that do
 * it understands what they now own, and what they cannot change afterwards. Edit it freely.
 *
 * **What this transaction fixes, and how tightly.** `settlementToken` is frozen forever — it has no
 * setter, because changing it would orphan every balance on the site's ledger, and it also fixes
 * `minFloor` via the token's decimals. The take economics are softer than that but still nearly
 * one-way: they are freely editable until the FIRST position is claimed, and after that may only
 * ratchet in the direction that cannot strand a holder — `takeBps` down, `payoutBps` up, reversion
 * slower, cooldown shorter. The rental terms stay freely mutable in both directions, because rent
 * binds nobody involuntarily: an owner who dislikes a rate simply does not list.
 *
 * So the numbers below are a decision rather than a default to revisit — but a wrong one costs a
 * conversation before launch, not an abandoned site.
 */
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ROBINHOOD_TESTNET, buildCreateSite, slotFloors } from '@websitekit/sdk';
import { readFileSync, writeFileSync } from 'node:fs';

import config from '../websitekit.config';
import { robinhoodTestnet } from '../lib/chain';

/**
 * The factory and the reader for this chain, from the SDK's published table unless .env overrides.
 *
 * These were required from .env while v2 was undeployed. It is deployed now, so the published
 * addresses are the default again and a scaffolded project needs no address of its own — only a
 * funded key. The reader is carried separately from the factory because it is deliberately
 * REPLACEABLE (§11.4): adopting a new one is a config change here, not a version bump of the SDK.
 */
const FACTORY = (process.env.WEBSITEKIT_FACTORY as `0x${string}` | undefined) ?? ROBINHOOD_TESTNET.factory;
const READER = (process.env.WEBSITEKIT_READER as `0x${string}` | undefined) ?? ROBINHOOD_TESTNET.reader;
if (!READER) throw new Error('no reader for this chain — set WEBSITEKIT_READER in .env');

const key = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error('DEPLOYER_PRIVATE_KEY is not set — copy .env.example to .env');

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: robinhoodTestnet, transport: http() });

/**
 * `minFloor`, as the contract will derive it: `10 ** (decimals - 4)` (§11.2).
 *
 * Checked here because the contract checks it at `createSite` and reverts the WHOLE deploy for one
 * floor that is too low — one `InvalidFloor` selector for sixteen slots, naming none of them. The
 * same rule bites hardest on a token-settled site, where the number is 100 units rather than 1e14
 * and a config copied from a native site is wrong by a factor of a trillion.
 */
const minFloor = 10n ** BigInt(config.decimals - 4);
for (const slot of config.slots) {
  if (slot.floor < minFloor) {
    throw new Error(
      `websitekit.config.ts: "${slot.key}" has a floor below this site's minimum. ` +
        `With ${config.decimals} decimals the minimum is ${minFloor} — raise it before deploying.`,
    );
  }
}

const request = buildCreateSite({
  factory: FACTORY,
  name: 'My Site',
  symbol: 'MYSITE',
  baseTokenURI: 'https://example.com/slot/',
  treasury: account.address,

  // `0x0` settles in the chain's native currency. Pass an ERC-20 address to settle in a stablecoin
  // instead — and then set `decimals` in websitekit.config.ts to match it.
  settlementToken: '0x0000000000000000000000000000000000000000',

  economics: {
    takeBps: 14_000n, //          1.4x — what a taker pays over the effective floor
    payoutBps: 11_500n, //        1.15x of the CURRENT effective floor to the displaced owner. The
    //                            guarantee that survives every input is that they get at least the
    //                            floor back — not that they always profit.
    reversionBps: 9_700n, //      0.97/week. Bounded below by your floor, so it is mean reversion of
    //                            the takeover price rather than loss of value.
    maxReversionWeeks: 52n, //    how far back a stale slot can revert
    cooldownSecs: 900n, //        15 minutes between takes on one slot
  },

  // Rent lets an owner sell temporary use without giving up the asset. Freely editable later.
  rentals: {
    siteRentBps: 2_500n, //       your cut of rent. Combined with the protocol's, must land in 10-40%.
    maxRentalTerm: 2_592_000n, // 30 days, in SECONDS. The ceiling is 365 days — but a long term
    //                            means fewer takes, so you are trading spread income for rent.
    minRentBps: 25n, //           0.25%/day of a slot's floor, the anti-poisoning rate floor
  },

  floorPolicy: {
    floorDeltaBps: 2_000n, //        a floor moves at most ±20% per change
    floorChangeCooldown: 86_400n, // and at most once a day
    maxAskBps: 40_000n, //           an owner may ask up to 4x what they paid
  },

  // Registered in the same transaction, so one call produces a working board. Slots are CLOSED by
  // default — without that, anyone who reads this repo could buy `hero.headline` before you launch.
  slots: slotFloors(config),
});

const { result: site } = await publicClient.simulateContract({ ...request, account });
const hash = await wallet.writeContract(request as never);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
// `waitForTransactionReceipt` RESOLVES for a reverted transaction — it reports the failure in
// `status` rather than throwing. Without this check a failed deploy writes a nonexistent address
// into .env and the page renders an empty board with no clue why.
if (receipt.status !== 'success') throw new Error(`createSite reverted (tx ${hash})`);

console.log(`
  Site deployed: ${site}
  ${robinhoodTestnet.blockExplorers.default.url}/address/${site}

  Written into .env as NEXT_PUBLIC_WEBSITEKIT_SITE. Restart \`pnpm dev\`.
`);

// Appended to .env rather than rewritten into websitekit.config.ts: the config is source you edit, and
// a script that rewrites your source is a script that will eventually eat a comment you wanted.
const envPath = '.env';
const existing = (() => {
  try {
    return readFileSync(envPath, 'utf-8');
  } catch {
    return '';
  }
})();
writeFileSync(
  envPath,
  `${existing
    .replace(/^NEXT_PUBLIC_WEBSITEKIT_SITE=.*$/m, '')
    .replace(/^NEXT_PUBLIC_WEBSITEKIT_READER=.*$/m, '')
    .trimEnd()}\nNEXT_PUBLIC_WEBSITEKIT_SITE=${site}\nNEXT_PUBLIC_WEBSITEKIT_READER=${READER}\n`,
);

void parseEther; // re-exported for convenience when editing floors above
