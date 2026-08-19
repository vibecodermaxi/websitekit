/**
 * Deploys and seeds the shared demo board the `create-websitekit` scaffold points at (§6).
 *
 * "The scaffold must ship with slots already claimed and priced on testnet, because an empty board
 * teaches nothing about the mechanic." This is what makes that true: it creates one site through
 * the deployed v2 factory, claims most of its slots across two accounts, has one account TAKE a
 * couple from the other so the board shows real payouts and a take count above one, and then opens
 * a TENANCY on one position so the reader's `unaccruedRent` / `netCost` surface has something real
 * behind it.
 *
 * **Driven entirely through `@websitekit/sdk`, on purpose.** The unit tests check the SDK against its
 * own assumptions and the anvil suite checks it against a local EVM. This checks it against a real
 * chain with real gas, real block times and a real RPC — which is the only place a wrong deadline,
 * a torn read or a bad ABI encoding shows up as what it actually is.
 *
 *   set -a && . ./.env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/seed-demo.ts
 *
 * **This script never deploys protocol contracts.** The v1 version deployed a fresh implementation
 * and factory whenever `WEBSITEKIT_FACTORY` was unset, which is how a full set was orphaned on
 * testnet once. `deploy-protocol.ts` owns that; this reads `FACTORY` and fails if it is missing.
 */
import { formatEther } from 'viem';

import {
  ROBINHOOD_TESTNET,
  buildCreateSite,
  buildListForRent,
  buildSetAvailability,
  buildRent,
  quoteRent,
  readListing,
  readSiteTerms,
  readSlots,
  type SiteRef,
} from '../src/index';
import {
  FACTORY,
  balanceOf,
  buy,
  deployer,
  deployerWallet,
  ensureFunded,
  floor,
  publicClient,
  refFor,
  send,
  taker,
  takerWallet,
} from './lib/chain';

/**
 * Same keys as the scaffold's `websitekit.config.ts` — the page renders BY KEY, so a key that
 * differs by one character renders a fallback forever and looks like a broken gateway. Slot keys are
 * permanent on-chain identities; add and retire them freely before `createSite` and treat them as
 * frozen after it.
 *
 * **Floors sit at or just above `minFloor` (1e14 = 0.0001 ETH on a native site).** v1's board ran
 * from 4e12 to 1e14, a 37x spread — every value below 1e14 now reverts `InvalidFloor`, so the spread
 * is 2x rather than 37x and the board is priced to be claimable many times over out of a faucet
 * rather than to look like a real rate card. Floors are read from chain for display, so this table
 * and the scaffold's never need to agree on price — only on keys.
 */
const SLOTS: Record<string, bigint> = {
  'nav.logo': floor('0.0001'),
  'nav.link.1': floor('0.0001'),
  'nav.link.2': floor('0.0001'),
  'nav.link.3': floor('0.0001'),
  'nav.cta': floor('0.0002'),

  'hero.eyebrow': floor('0.0001'),
  'hero.headline': floor('0.0002'),
  'hero.subhead': floor('0.0001'),
  'hero.image': floor('0.0002'),

  'feature.1.title': floor('0.0001'),
  'feature.1.body': floor('0.0001'),
  'feature.2.title': floor('0.0001'),
  'feature.2.body': floor('0.0001'),
  'feature.3.title': floor('0.0001'),
  'feature.3.body': floor('0.0001'),

  'footer.note': floor('0.0001'),
};

/** Left UNCLAIMED on purpose, so the scaffold shows both halves of the board on first load. */
const LEAVE_UNCLAIMED = ['feature.3.title', 'feature.3.body', 'nav.link.3'];
/**
 * Marked unavailable after registration, so the board carries the third state a real publisher's
 * board will have: registered, unclaimed, and OFF the market (§10.4). One key only — the other two
 * open slots stay claimable, because claimable-versus-withdrawn is the contrast being demonstrated.
 */
const MARK_UNAVAILABLE = ['nav.link.3'];
/** Claimed by the taker, so the board has more than one owner. */
const TAKER_CLAIMS = ['nav.cta', 'hero.subhead', 'footer.note'];
/** Taken from the deployer AFTER claiming, so these show a payout and a take count above one. */
const TAKE_FROM_DEPLOYER = ['hero.headline', 'nav.logo'];
/** Rented from its owner, so the board carries one encumbered position (§2.4). */
const RENT: { key: string; days: bigint } = { key: 'hero.image', days: 3n };

const COOLDOWN_SECS = 60n;

console.log(`factory  ${FACTORY}  (from the environment — never deployed here)`);
console.log(`deployer ${deployer().address}  ${await balanceOf(deployer().address)} ETH`);
console.log(`taker    ${taker().address}  ${await balanceOf(taker().address)} ETH\n`);

// ---------------------------------------------------------------------------
// 0. Afford it before spending any of it
// ---------------------------------------------------------------------------
//
// A run that dies half-way leaves a board that is neither empty nor seeded, and re-running walks
// prices up on whatever it already claimed. The estimate is deliberately crude and deliberately
// high: takes cost `takeBps` of the price, and gas is padded well past the ~240k a buy measured.
const GAS_PAD = 400_000n * 200_000_000n; // ~0.00008 ETH per tx at 0.13 gwei, rounded up hard
const takerSpend =
  TAKER_CLAIMS.reduce((sum, key) => sum + SLOTS[key]!, 0n) +
  (TAKE_FROM_DEPLOYER.reduce((sum, key) => sum + SLOTS[key]!, 0n) * 14_000n) / 10_000n +
  GAS_PAD * BigInt(TAKER_CLAIMS.length + TAKE_FROM_DEPLOYER.length + 2);
const deployerSpend =
  Object.entries(SLOTS)
    .filter(([key]) => !LEAVE_UNCLAIMED.includes(key) && !TAKER_CLAIMS.includes(key))
    .reduce((sum, [, value]) => sum + value, 0n) + GAS_PAD * 14n;

console.log('budget:');
await ensureFunded(deployer(), deployerSpend, 'deployer');
await ensureFunded(taker(), takerSpend, 'taker');

// ---------------------------------------------------------------------------
// 1. The board, registered in the same transaction as the site
// ---------------------------------------------------------------------------

const createRequest = buildCreateSite({
  factory: FACTORY,
  name: 'Northwind',
  symbol: 'NWND',
  baseTokenURI: 'https://websitekit.org/demo/slot/',
  treasury: deployer().address,
  // Native. The demo board settles in the chain's own currency so the scaffold's first run needs
  // no token, no approval and no faucet beyond gas.
  settlementToken: '0x0000000000000000000000000000000000000000',
  economics: {
    takeBps: 14_000n, //          1.4x
    payoutBps: 11_500n, //        1.15x to the displaced owner
    reversionBps: 9_000n, //      0.9/week
    maxReversionWeeks: 12n, //    shorter than the 52 ceiling — a small board should reach floor fast
    // 60s rather than the Standard profile's 900. This is a board people are meant to poke at; a
    // 15-minute wait between takes teaches patience rather than the mechanic.
    cooldownSecs: COOLDOWN_SECS,
  },
  // v2. Rent economics are freely mutable for the site's life (§2.5.1), so unlike the block above
  // these are a starting point rather than a permanent choice.
  rentals: {
    siteRentBps: 2_500n, //       with protocolRentBps 500, a 30% total fee — inside [1_000, 4_000]
    maxRentalTerm: 2_592_000n, // 30 days
    minRentBps: 25n, //           0.25% of effective floor per day, the anti-poisoning rate floor
  },
  floorPolicy: {
    floorDeltaBps: 2_000n, //     20% per move, the ceiling
    floorChangeCooldown: 86_400n,
    maxAskBps: 40_000n, //        an owner may ask up to 4x
  },
  slots: SLOTS,
});

const { result } = await publicClient.simulateContract({ ...createRequest, account: deployer() } as never);
const site = result as `0x${string}`;
await send(deployerWallet(), 'createSite', { ...createRequest, account: deployer() });
console.log(`\nNorthwind  ${site}`);

const ref: SiteRef = refFor(site);
const terms = await readSiteTerms(publicClient, ref);
console.log(`  implementation v${terms.implementationVersion}  minFloor ${terms.minFloor}  settling natively\n`);

// ---------------------------------------------------------------------------
// 2. Claim, so the board is alive
// ---------------------------------------------------------------------------

let spent = 0n;
for (const key of Object.keys(SLOTS)) {
  if (LEAVE_UNCLAIMED.includes(key)) continue;
  const isTaker = TAKER_CLAIMS.includes(key);
  const charged = await buy(isTaker ? takerWallet() : deployerWallet(), ref, key, terms.settlementToken);
  spent += charged;
  console.log(`  claimed ${key.padEnd(18)} ${formatEther(charged).padStart(10)} ETH  by ${isTaker ? 'taker' : 'deployer'}`);
}

// ---------------------------------------------------------------------------
// 3. Take, so the board shows the mechanic rather than just ownership
// ---------------------------------------------------------------------------

console.log(`\nwaiting out the ${COOLDOWN_SECS}s cooldown before taking…`);
await new Promise((resolve) => setTimeout(resolve, Number(COOLDOWN_SECS) * 1_000 + 5_000));

for (const key of TAKE_FROM_DEPLOYER) {
  const charged = await buy(takerWallet(), ref, key, terms.settlementToken);
  spent += charged;
  console.log(`  taken   ${key.padEnd(18)} ${formatEther(charged).padStart(10)} ETH  by taker`);
}

// ---------------------------------------------------------------------------
// 4. Rent, so one position is encumbered (§2.4)
// ---------------------------------------------------------------------------
//
// The deployer owns `hero.image` and lists it; the taker rents it. This is the only part of the
// board that exercises the delegatecalled `RentalsLib`, and it is what gives the scaffold a slot
// whose `netCost` differs from its price — the number §2.4.2 exists for. The rate is set well above
// `minRentBps` so the term costs something legible rather than truncating to dust.
{
  const [position] = await readSlots(publicClient, ref, [RENT.key]);
  const ratePerDay = (position!.effectiveFloor * 200n) / 10_000n; // 2% of floor per day
  await send(deployerWallet(), 'listForRent', {
    ...buildListForRent(site, RENT.key, ratePerDay, 604_800n),
    account: deployer(),
  });

  const listing = await readListing(publicClient, site, RENT.key);
  const durationSecs = RENT.days * 86_400n;
  const quote = quoteRent(listing.ratePerDay, durationSecs, terms.protocolRentBps, listing.feeBps);
  await send(takerWallet(), 'rent', {
    ...buildRent({
      site,
      key: RENT.key,
      durationSecs,
      expectedRatePerDay: listing.ratePerDay,
      settlementToken: terms.settlementToken,
      cost: quote.cost,
    }),
    account: taker(),
  });
  spent += quote.cost;
  console.log(
    `\n  rented  ${RENT.key.padEnd(18)} ${formatEther(quote.cost).padStart(10)} ETH  ` +
      `${RENT.days}d to taker (net ${quote.net} to the owner)`,
  );
}

// ---------------------------------------------------------------------------
// 5. Take one open slot OFF the market (§10.4)
// ---------------------------------------------------------------------------

await send(deployerWallet(), 'setAvailability', {
  ...buildSetAvailability(site, MARK_UNAVAILABLE, false),
  account: deployer(),
});
console.log(`  off-market  ${MARK_UNAVAILABLE.join(', ')} — registered, unclaimed, not claimable`);

// ---------------------------------------------------------------------------
// 6. Read the whole board back through the reader and prove it looks right
// ---------------------------------------------------------------------------

const board = await readSlots(publicClient, ref, Object.keys(SLOTS));
console.log('\nfinal board, read through SlotReader:');
for (const slot of board) {
  const owner = slot.owner ? `${slot.owner.slice(0, 8)}…` : slot.isAvailable ? 'unclaimed' : 'OFF-MARKET';
  const rented = slot.isRented ? `  RENTED net ${formatEther(slot.netCost)}` : '';
  console.log(
    `  ${slot.key.padEnd(18)} ${owner.padEnd(12)} floor ${formatEther(slot.floor).padStart(8)}  ` +
      `next ${formatEther(slot.charged).padStart(10)}  takes ${String(slot.takes).padStart(2)}${rented}`,
  );
}

const claimed = board.filter((slot) => slot.owner).length;
const taken = board.filter((slot) => slot.takes > 1).length;
const rented = board.filter((slot) => slot.isRented).length;
const offMarket = board.filter((slot) => !slot.owner && !slot.isAvailable).length;
if (claimed !== Object.keys(SLOTS).length - LEAVE_UNCLAIMED.length) throw new Error('claim count wrong');
if (taken !== TAKE_FROM_DEPLOYER.length) throw new Error('take count wrong');
if (rented !== 1) throw new Error('the tenancy did not open');
if (offMarket !== MARK_UNAVAILABLE.length) throw new Error('the off-market state did not land');

console.log(`
  ${claimed} claimed, ${LEAVE_UNCLAIMED.length - offMarket} open, ${offMarket} off-market, ${taken} taken once, ${rented} rented
  spent ${formatEther(spent)} ETH
  deployer now ${await balanceOf(deployer().address)} ETH
  taker    now ${await balanceOf(taker().address)} ETH

  ${ROBINHOOD_TESTNET.explorer}/address/${site}

  Record it in src/addresses.ts as DEMO_SITE, and in the scaffold's .env:
    NEXT_PUBLIC_WEBSITEKIT_SITE=${site}
    NEXT_PUBLIC_WEBSITEKIT_READER=${ref.reader}
`);
