/**
 * Deploys and seeds the shared demo board the `create-websitekit` scaffold points at (§6), on
 * whichever chain `WEBSITEKIT_CHAIN_ID` names — settling in that chain's dollar: USDG on mainnet,
 * the tUSD stand-in on testnet.
 *
 * "The scaffold must ship with slots already claimed and priced, because an empty board
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
 *   SEED_CHECK=1 pnpm --filter @websitekit/sdk exec tsx scripts/seed-demo.ts   # budget, spends nothing
 *   pnpm --filter @websitekit/sdk exec tsx scripts/seed-demo.ts
 *
 * **On a chain where the money is real it also needs `SEED_MAINNET=yes`**, so a script run against
 * the wrong `WEBSITEKIT_CHAIN_ID` stops before it spends anything rather than after.
 *
 * **This script never deploys protocol contracts.** The v1 version deployed a fresh implementation
 * and factory whenever `WEBSITEKIT_FACTORY` was unset, which is how a full set was orphaned on
 * testnet once. `deploy-protocol.ts` owns that; this reads `FACTORY` and fails if it is missing.
 */
import { erc20Abi, formatEther, formatUnits } from 'viem';

import {
  buildApproveSettlement,
  buildCreateSite,
  buildListForRent,
  buildRent,
  buildSetAvailability,
  buildSweepTreasury,
  buildWithdrawFor,
  parseFloor,
  quoteRent,
  readListing,
  readPendingWithdrawal,
  readSiteTerms,
  readSlots,
  settlementTokenFor,
  type SiteRef,
} from '../src/index';
import {
  activeChain,
  balanceOf,
  buy,
  deployer,
  deployerWallet,
  ensureFunded,
  factory,
  publicClient,
  refFor,
  send,
  taker,
  takerWallet,
} from './lib/chain';

const CHECK_ONLY = process.env.SEED_CHECK === '1';
if (!activeChain.testnet && !CHECK_ONLY && process.env.SEED_MAINNET !== 'yes') {
  throw new Error(`${activeChain.name} is a real-money chain — set SEED_MAINNET=yes to seed it`);
}

/** Resolved here rather than imported as a constant — see `factory()`'s note on being lazy. */
const FACTORY = factory();
const TOKEN = settlementTokenFor(activeChain.id);
const usd = (amount: bigint) => `$${formatUnits(amount, TOKEN.decimals)}`;

/**
 * Same keys AND the same floors as the scaffold's `websitekit.config.ts` — the page renders BY KEY,
 * so a key that differs by one character renders a fallback forever and looks like a broken
 * gateway, and a builder who deploys their own board from the scaffold should get the prices they
 * were shown. Slot keys are permanent on-chain identities.
 *
 * Dollars, parsed at the settlement token's decimals and asserted against `minFloor`
 * (`10 ** (decimals - 4)`, $0.0001 at six) where the table is written rather than where it deploys.
 */
const FLOORS: Record<string, string> = {
  'nav.logo': '2.00',
  'nav.link.1': '1.00',
  'nav.link.2': '1.00',
  'nav.link.3': '1.00',
  'nav.cta': '3.00',

  'hero.eyebrow': '0.50',
  'hero.headline': '5.00',
  'hero.subhead': '2.00',
  'hero.image': '4.00',

  'feature.1.title': '0.80',
  'feature.1.body': '0.40',
  'feature.2.title': '0.80',
  'feature.2.body': '0.40',
  'feature.3.title': '0.80',
  'feature.3.body': '0.40',

  'footer.note': '0.20',
};
const MIN_FLOOR = 10n ** BigInt(TOKEN.decimals - 4);
const SLOTS: Record<string, bigint> = Object.fromEntries(
  Object.entries(FLOORS).map(([key, amount]) => {
    const value = parseFloor(amount, TOKEN.decimals);
    if (value < MIN_FLOOR) throw new RangeError(`${key}: floor ${amount} is below minFloor ${MIN_FLOOR}`);
    return [key, value];
  }),
);

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
/**
 * Rented from its owner, so the board carries one encumbered position (§2.4). Thirty days, the
 * board's ceiling, because the scaffold says "one under a live tenancy" and a shorter term makes
 * that false sooner.
 */
const RENT: { key: string; days: bigint } = { key: 'hero.image', days: 30n };
/** 2% of the floor per day — well above `minRentBps`, so the term costs something legible. */
const RENT_RATE_BPS = 200n;

const COOLDOWN_SECS = 60n;
const TAKE_BPS = 14_000n;

// ---------------------------------------------------------------------------
// 0. Afford it before spending any of it
// ---------------------------------------------------------------------------
//
// A run that dies half-way leaves a board that is neither empty nor seeded, and re-running walks
// prices up on whatever it already claimed. So both currencies are budgeted up front: the DOLLARS
// each account pays, and the GAS each account sends — which on a token board includes one approval
// per purchase, and which a wallet that cannot cover fails at estimate with no revert data.
const sum = (keys: string[], scale = 10_000n) => keys.reduce((total, key) => total + (SLOTS[key]! * scale) / 10_000n, 0n);
const deployerClaims = Object.keys(SLOTS).filter((key) => !LEAVE_UNCLAIMED.includes(key) && !TAKER_CLAIMS.includes(key));
const rentCost = (SLOTS[RENT.key]! * RENT_RATE_BPS * RENT.days) / 10_000n;

// 2% headroom on every purchase, covering the 1% slippage the approval allows plus rounding.
const deployerUsd = (sum(deployerClaims) * 10_200n) / 10_000n;
const takerUsd = ((sum(TAKER_CLAIMS) + sum(TAKE_FROM_DEPLOYER, TAKE_BPS) + rentCost) * 10_200n) / 10_000n;

const gasPrice = await publicClient.getGasPrice();
const GAS_PER_TX = 400_000n * gasPrice * 3n; // padded hard: a buy measured ~240k, and price moves
const deployerTxs = BigInt(1 + deployerClaims.length * 2 + 1 + 1 + 2 + 2); // create, claims+approvals, list, availability, top-ups, sweeps
const takerTxs = BigInt((TAKER_CLAIMS.length + TAKE_FROM_DEPLOYER.length) * 2 + 2 + 2); // buys+approvals, rent+approval, return
const deployerGas = GAS_PER_TX * deployerTxs;
const takerGas = GAS_PER_TX * takerTxs;

const tokenBalance = (address: `0x${string}`) =>
  publicClient.readContract({ address: TOKEN.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

console.log(`chain    ${activeChain.name} (${activeChain.id})${activeChain.testnet ? '' : ' — REAL MONEY'}`);
console.log(`factory  ${FACTORY}  (from the environment — never deployed here)`);
console.log(`settles  ${TOKEN.symbol} ${TOKEN.address}`);
console.log(`deployer ${deployer().address}  ${await balanceOf(deployer().address)} ETH  ${usd(await tokenBalance(deployer().address))}`);
console.log(`taker    ${taker().address}  ${await balanceOf(taker().address)} ETH  ${usd(await tokenBalance(taker().address))}\n`);
console.log('budget:');
console.log(`  deployer pays ~${usd(deployerUsd)} and ~${formatEther(deployerGas)} ETH of gas`);
console.log(`  taker    pays ~${usd(takerUsd)} and ~${formatEther(takerGas)} ETH of gas`);
console.log(`  the deployer must hold ~${usd(deployerUsd + takerUsd)} up front; most of it comes back at the end\n`);

const needUsd = deployerUsd + takerUsd;
const haveUsd = (await tokenBalance(deployer().address)) + (await tokenBalance(taker().address));
if (haveUsd < needUsd) {
  throw new Error(`the two accounts hold ${usd(haveUsd)} and need ~${usd(needUsd)} — send ${TOKEN.symbol} to the deployer`);
}
if (CHECK_ONLY) {
  console.log('SEED_CHECK=1 — affordable in dollars. Nothing was sent.');
  process.exit(0);
}

await ensureFunded(deployer(), deployerGas + takerGas, 'deployer');
await ensureFunded(taker(), takerGas, 'taker');

// Top the taker's dollars up from the deployer. The split between the two accounts is a fiction for
// making the board look multi-owner; the deployer is the treasury, so most of it comes straight back.
{
  const have = await tokenBalance(taker().address);
  if (have < takerUsd) {
    await send(deployerWallet(), 'fund taker', {
      address: TOKEN.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [taker().address, takerUsd - have],
      account: deployer(),
    });
    console.log(`  taker    topped up ${usd(takerUsd - have)}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The board, registered in the same transaction as the site
// ---------------------------------------------------------------------------

const createRequest = buildCreateSite({
  factory: FACTORY,
  name: 'Northwind',
  symbol: 'NWND',
  baseTokenURI: 'https://websitekit.org/demo/slot/',
  treasury: deployer().address,
  // The chain's dollar, the same as every board the scaffold deploys — so the first board a builder
  // sees is priced the way their own will be.
  settlementToken: TOKEN.address,
  economics: {
    takeBps: TAKE_BPS, //         1.4x
    payoutBps: 11_500n, //        1.15x to the displaced owner
    reversionBps: 9_700n, //      0.97/week — the scaffold's own number, so its README describes this board
    maxReversionWeeks: 52n,
    // 60s rather than the scaffold's 900. This is a board people are meant to poke at; a 15-minute
    // wait between takes teaches patience rather than the mechanic.
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
if (terms.settlementToken.toLowerCase() !== TOKEN.address.toLowerCase()) {
  throw new Error(`the board settles in ${terms.settlementToken}, not ${TOKEN.symbol} — stop and look`);
}
console.log(`  implementation v${terms.implementationVersion}  minFloor ${terms.minFloor}  settling in ${TOKEN.symbol}\n`);

// ---------------------------------------------------------------------------
// 2. Claim, so the board is alive
// ---------------------------------------------------------------------------

let spent = 0n;
for (const key of Object.keys(SLOTS)) {
  if (LEAVE_UNCLAIMED.includes(key)) continue;
  const isTaker = TAKER_CLAIMS.includes(key);
  const charged = await buy(isTaker ? takerWallet() : deployerWallet(), ref, key, terms.settlementToken);
  spent += charged;
  console.log(`  claimed ${key.padEnd(18)} ${usd(charged).padStart(8)}  by ${isTaker ? 'taker' : 'deployer'}`);
}

// ---------------------------------------------------------------------------
// 3. Take, so the board shows the mechanic rather than just ownership
// ---------------------------------------------------------------------------

console.log(`\nwaiting out the ${COOLDOWN_SECS}s cooldown before taking…`);
await new Promise((resolve) => setTimeout(resolve, Number(COOLDOWN_SECS) * 1_000 + 5_000));

for (const key of TAKE_FROM_DEPLOYER) {
  const charged = await buy(takerWallet(), ref, key, terms.settlementToken);
  spent += charged;
  console.log(`  taken   ${key.padEnd(18)} ${usd(charged).padStart(8)}  by taker`);
}

// ---------------------------------------------------------------------------
// 4. Rent, so one position is encumbered (§2.4)
// ---------------------------------------------------------------------------
//
// The deployer owns `hero.image` and lists it; the taker rents it. This is the only part of the
// board that exercises the delegatecalled `RentalsLib`, and it is what gives the scaffold a slot
// whose `netCost` differs from its price — the number §2.4.2 exists for.
{
  const [position] = await readSlots(publicClient, ref, [RENT.key]);
  const ratePerDay = (position!.effectiveFloor * RENT_RATE_BPS) / 10_000n;
  const durationSecs = RENT.days * 86_400n;
  await send(deployerWallet(), 'listForRent', {
    ...buildListForRent(site, RENT.key, ratePerDay, durationSecs),
    account: deployer(),
  });

  const listing = await readListing(publicClient, site, RENT.key);
  const quote = quoteRent(listing.ratePerDay, durationSecs, terms.protocolRentBps, listing.feeBps);
  // A rental pulls exactly `cost` — the rate is an equality, not a ceiling — so that is the allowance.
  await send(takerWallet(), 'approve rent', {
    ...buildApproveSettlement(terms.settlementToken, site, quote.cost),
    account: taker(),
  });
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
  console.log(`\n  rented  ${RENT.key.padEnd(18)} ${usd(quote.cost).padStart(8)}  ${RENT.days}d to taker`);
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
  const rented = slot.isRented ? `  RENTED net ${usd(slot.netCost)}` : '';
  console.log(
    `  ${slot.key.padEnd(18)} ${owner.padEnd(12)} floor ${usd(slot.floor).padStart(7)}  ` +
      `next ${usd(slot.charged).padStart(8)}  takes ${String(slot.takes).padStart(2)}${rented}`,
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

// ---------------------------------------------------------------------------
// 7. Bring the money home
// ---------------------------------------------------------------------------
//
// The deployer is the treasury, so the publisher's cut of every purchase is sitting in the site; the
// payouts from the two takes are credited to the deployer's pull ledger; and the taker holds what
// its top-up did not spend. None of it needs to stay where it is for the board to look right.
await send(deployerWallet(), 'sweepTreasury', { ...buildSweepTreasury(site), account: deployer() });
if ((await readPendingWithdrawal(publicClient, site, deployer().address)) > 0n) {
  await send(deployerWallet(), 'withdrawFor', { ...buildWithdrawFor(site, deployer().address), account: deployer() });
}
{
  const left = await tokenBalance(taker().address);
  if (left > 0n) {
    await send(takerWallet(), 'return taker funds', {
      address: TOKEN.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [deployer().address, left],
      account: taker(),
    });
  }
}

console.log(`
  ${claimed} claimed, ${LEAVE_UNCLAIMED.length - offMarket} open, ${offMarket} off-market, ${taken} taken once, ${rented} rented
  paid in ${usd(spent)} across all purchases and the tenancy
  deployer now ${await balanceOf(deployer().address)} ETH  ${usd(await tokenBalance(deployer().address))}
  taker    now ${await balanceOf(taker().address)} ETH  ${usd(await tokenBalance(taker().address))}

  ${activeChain.blockExplorers.default.url}/address/${site}

  Record it in src/addresses.ts under DEMO_SITES[${activeChain.id}], then write its content:
    WEBSITEKIT_DEMO_SITE=${site} pnpm --filter @websitekit/sdk exec tsx scripts/seed-content.ts
`);
