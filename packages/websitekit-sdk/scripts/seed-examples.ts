/**
 * Deploys the four example boards the docs point at, on whichever chain `WEBSITEKIT_CHAIN_ID` names,
 * settling in that chain's dollar — USDG on mainnet, the tUSD stand-in on testnet.
 *
 * `seed-demo.ts` seeds ONE board — the generic SaaS landing page the scaffold renders. That shape is
 * inherited, and it is the only shape a prospective site owner can currently see, which makes "would
 * this work for my site?" unanswerable from the docs. These are the answer: four boards that differ
 * in the two things that actually vary between real sites — the slot layout, and the economics
 * chosen at `createSite`.
 *
 *   set -a && . ./.env && set +a          # zsh needs ./.env; a bare `.env` is searched on PATH
 *   SEED_CHECK=1 pnpm --filter @websitekit/sdk exec tsx scripts/seed-examples.ts   # budget only
 *   pnpm --filter @websitekit/sdk exec tsx scripts/seed-examples.ts
 *
 * A real-money chain also needs `SEED_MAINNET=yes`, as `seed-demo.ts` does.
 *
 * **Each board is created in its FINAL shape.** On the testnet this took two scripts: this one
 * claimed most of each board, and `seed-example-extras.ts` later registered peripheral slots at the
 * page edges and claimed the gaps left in the middle, so that what a visitor sees for sale is what a
 * real publisher would sell. Here the edge slots (`extras`) are registered at `createSite` and left
 * open, and every content slot is claimed, in one pass. The extras script stays for the testnet
 * boards, which already exist in the two-step shape.
 *
 * **The money is swept home after every board**, so the deployer needs only one board's worth of
 * dollars at a time rather than all four: it is each board's treasury, so its cut of every purchase
 * sits in the site until `sweepTreasury`, and the take payouts sit in its pull ledger until
 * `withdrawFor`.
 *
 * **What v2 changed about these boards, beyond names.** Take economics are no longer frozen at
 * `createSite` — they are mutable until the first claim and a one-way ratchet after it (§6.1) — but
 * they are still the thing that distinguishes these four, so they are still chosen deliberately per
 * board. Each board now also carries RENT economics, which v1 had no concept of, and those stay
 * freely mutable for the site's whole life (§2.5.1). The reversion tail that used to be called decay
 * is `reversionBps` / `maxReversionWeeks`.
 *
 * **Re-running is safe.** Every created site is appended to `examples.json` before its board is
 * claimed, and any board already listed there is skipped. A deploy script that is not idempotent is
 * one you can only afford to run when you are certain, and certainty is not what you have while
 * debugging.
 *
 * **The ledger carries the contract generation it was written by, and this refuses to touch another
 * one.** v1's ledger was an untagged `{slug: address}` map, so the first v2 run read it, concluded
 * all four boards already existed, skipped creation and then reverted trying to read v2 terms off a
 * v1 clone. That failure was loud only by luck — `readTerms` happens to be incompatible. Had the
 * generations shared a view, this would have gone on to seed content onto boards nobody can read.
 * The version field is what makes the check structural rather than lucky.
 *
 * Content bytes are NOT seeded here — `seed-example-content.ts` does that.
 */
import { erc20Abi, formatUnits, type Address } from 'viem';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCreateSite,
  buildSweepTreasury,
  buildWithdrawFor,
  parseFloor,
  readPendingWithdrawal,
  readSiteTerms,
  readSlots,
  settlementTokenFor,
  type SiteEconomicsConfig,
  type SiteRentalConfig,
} from '../src/index';
import {
  activeChain,
  balanceOf,
  buy,
  deployer,
  deployerWallet,
  ensureFunded,
  examplesLedgerPath,
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
const MIN_FLOOR = 10n ** BigInt(TOKEN.decimals - 4);
const LEDGER = fileURLToPath(examplesLedgerPath());

/** A floor in dollars, parsed at the settlement token's decimals and asserted against `minFloor`. */
function usd(amount: string): bigint {
  const value = parseFloor(amount, TOKEN.decimals);
  if (value < MIN_FLOOR) throw new RangeError(`floor ${amount} is below minFloor ${MIN_FLOOR} (§11.2)`);
  return value;
}
const fmt = (amount: bigint) => `$${formatUnits(amount, TOKEN.decimals)}`;

const COOLDOWN_SECS = 60n;

/**
 * Every board shares one floor policy — the axis these examples are NOT about. What varies is the
 * take economics, the rent economics and the layout.
 */
const FLOOR_POLICY = { floorDeltaBps: 2_000n, floorChangeCooldown: 86_400n, maxAskBps: 40_000n };

interface Board {
  slug: string;
  name: string;
  symbol: string;
  /** What kind of site this is, and why its economics are shaped the way they are. */
  premise: string;
  economics: SiteEconomicsConfig;
  rentals: SiteRentalConfig;
  slots: Record<string, bigint>;
  /** Claimed by the taker rather than the deployer, so the board has more than one owner. */
  takerClaims: string[];
  /** Taken from the deployer after claiming, so the board shows a payout and a take count above 1. */
  takeFromDeployer: string[];
  /**
   * Registered at `createSite` and left OPEN — the edge slots a visitor sees for sale, because a
   * board with no open slots teaches only half the mechanic. Every key in `slots` is claimed; these
   * are the only open positions on the board.
   */
  extras: Record<string, bigint>;
}

/**
 * **Floors are in dollars: $2 for the most prominent position on each board, $1 for the rest.** The
 * 2:1 shape is the one the testnet boards had; the scale is chosen so all four can be seeded for
 * tens of dollars, most of which is swept back. A production board would price the masthead well
 * above the footer — these exist to show the mechanic, not to set a rate card.
 */
const BOARDS: Board[] = [
  {
    slug: 'dispatch',
    name: 'The Weekly Dispatch',
    symbol: 'DSPT',
    premise:
      'A newsletter archive. Sponsorship is the whole business model already, and the archive keeps ' +
      'earning long after the send — so reversion is slow (0.95/week over 26 weeks) and a sponsor ' +
      'who buys the masthead keeps most of their position for months. Rent terms run long for the ' +
      'same reason: a sponsor books an archive by the month, not by the day.',
    economics: {
      takeBps: 14_000n, //          1.4x
      payoutBps: 11_500n, //        1.15x
      reversionBps: 9_500n, //      0.95/week — an archive holds its value
      maxReversionWeeks: 26n,
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 2_000n, //       25% total with the protocol's 500
      maxRentalTerm: 7_776_000n, // 90 days
      minRentBps: 20n,
    },
    slots: {
      'masthead.title': usd('1.00'),
      'masthead.tagline': usd('1.00'),
      'sponsor.primary': usd('2.00'), //  the top banner — the most valuable thing on the page
      'issue.latest.sponsor': usd('1.00'),
      'issue.prev.sponsor': usd('1.00'),
      'recommended.1': usd('1.00'), //    newsletters really do sell these
      'recommended.2': usd('1.00'),
      'recommended.3': usd('1.00'),
      'footer.credit': usd('1.00'),
    },
    takerClaims: ['sponsor.primary', 'recommended.1', 'footer.credit', 'recommended.3', 'issue.prev.sponsor'],
    takeFromDeployer: ['masthead.title'],
    extras: { 'announce.bar': usd('1.00'), 'nav.link.1': usd('1.00'), 'footer.link.1': usd('1.00') },
  },
  {
    slug: 'devconf',
    name: 'DevConf Autumn',
    symbol: 'DVCF',
    premise:
      'A conference site. Sponsor tiers are already an auction held over email, so the take premium ' +
      'is steep (2x) and the board runs it in public instead. The event has a date, so nothing ' +
      'reverts for long: 4 weeks and it is back at floor. Rent is capped near the length of the ' +
      'event itself — nobody books a booth banner for a quarter.',
    economics: {
      takeBps: 20_000n, //          2x — tiers are contested, and the site keeps the wider spread
      payoutBps: 12_000n, //        1.2x
      reversionBps: 9_000n,
      maxReversionWeeks: 4n, //     a dated event; a long reversion tail is meaningless
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 3_500n, //       40% total — the conference takes the biggest cut of the four
      maxRentalTerm: 1_209_600n, // 14 days
      minRentBps: 50n,
    },
    slots: {
      'sponsor.headline': usd('2.00'), // title sponsor
      'sponsor.gold.1': usd('1.00'),
      'sponsor.gold.2': usd('1.00'),
      'sponsor.gold.3': usd('1.00'),
      'sponsor.silver.1': usd('1.00'),
      'sponsor.silver.2': usd('1.00'),
      'booth.1': usd('1.00'),
      'booth.2': usd('1.00'),
      'schedule.note': usd('1.00'),
    },
    takerClaims: ['sponsor.gold.1', 'sponsor.gold.2', 'booth.1', 'sponsor.silver.2', 'booth.2'],
    takeFromDeployer: ['sponsor.headline'],
    extras: { 'announce.bar': usd('1.00'), 'nav.link.1': usd('1.00'), 'footer.link.1': usd('1.00') },
  },
  {
    slug: 'remoteroles',
    name: 'Remote Roles',
    symbol: 'RMTR',
    premise:
      'A job board. Listings churn weekly and a stale featured slot is worse than an empty one, so ' +
      'reversion is the fastest of the four (0.85/week over 8 weeks) — a listing nobody refreshes ' +
      'falls back to floor inside two months and reopens to the next employer. Rent is the natural ' +
      'primitive here: an employer wants the slot for a hiring window, not forever.',
    economics: {
      takeBps: 13_000n, //          1.3x — low friction, because churn is the point
      payoutBps: 11_000n,
      reversionBps: 8_500n, //      0.85/week — the fastest of the four
      maxReversionWeeks: 8n,
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 1_000n, //       15% total — the lowest of the four, because renting IS the product
      maxRentalTerm: 2_592_000n, // 30 days, a hiring window
      minRentBps: 30n,
    },
    slots: {
      'banner.top': usd('2.00'),
      'featured.1': usd('1.00'),
      'featured.2': usd('1.00'),
      'featured.3': usd('1.00'),
      'featured.4': usd('1.00'),
      'featured.5': usd('1.00'),
      'category.design.sponsor': usd('1.00'),
      'category.eng.sponsor': usd('1.00'),
      'footer.link.1': usd('1.00'),
    },
    takerClaims: ['featured.1', 'banner.top', 'footer.link.1', 'featured.4', 'featured.5', 'category.design.sponsor'],
    takeFromDeployer: ['featured.2', 'category.eng.sponsor'],
    extras: { 'nav.link.1': usd('1.00'), 'footer.link.2': usd('1.00') },
  },
  {
    slug: 'vaultline',
    name: 'Vaultline',
    symbol: 'VLTL',
    premise:
      'A DeFi protocol landing page. Ecosystem placement is already bought and sold off-chain, in ' +
      'Telegram, at BD-deal pace — this puts it on-chain at market pace. The take premium is steep ' +
      '(1.6x) because an integrations row is genuinely contested, and the reversion tail is the full ' +
      '52 weeks the contract allows: an ecosystem page is a long game, and a partner who bought in a ' +
      'year ago should still be paying for the position they hold.',
    economics: {
      takeBps: 16_000n, //          1.6x — placement is contested, and the protocol keeps the spread
      payoutBps: 12_000n, //        1.2x
      reversionBps: 9_000n,
      maxReversionWeeks: 52n, //    the contract's ceiling — the longest tail of the four boards
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 2_500n, //       30% total
      maxRentalTerm: 31_536_000n, // 365 days, the contract's ceiling — a long game here too
      minRentBps: 10n,
    },
    slots: {
      'announce.bar': usd('2.00'), //   the strip above everything; the most-seen pixels on the page
      'hero.headline': usd('2.00'),
      'hero.sub': usd('1.00'),
      'hero.cta': usd('1.00'),
      'integration.1': usd('1.00'),
      'integration.2': usd('1.00'),
      'integration.3': usd('1.00'),
      'integration.4': usd('1.00'),
      'ecosystem.1': usd('1.00'),
      'ecosystem.2': usd('1.00'),
      'ecosystem.3': usd('1.00'),
      'audit.note': usd('1.00'),
      'footer.link.1': usd('1.00'),
    },
    takerClaims: ['announce.bar', 'integration.1', 'ecosystem.1', 'footer.link.1', 'integration.4', 'ecosystem.3'],
    takeFromDeployer: ['hero.headline', 'ecosystem.2'],
    extras: { 'nav.link.1': usd('1.00'), 'footer.link.2': usd('1.00') },
  },
];

// ---------------------------------------------------------------------------

interface Ledger {
  version: 2;
  chainId: number;
  /**
   * The factory these boards were created through, and therefore the GENERATION they are clones of.
   *
   * `version` cannot carry this: it means "readable by this SDK", which stayed 2 across the
   * treasury-pin generation of 2026-09-03 because `SlotView` did not change shape. So a ledger from
   * the previous generation passes the version check, and a seed run against a new factory would
   * find four sites already recorded and skip creating any of them — reporting success against a
   * generation with no example boards on it. That is the exact failure `ROADMAP.md` records from
   * v1's untagged ledger, one generation later.
   *
   * Optional only so a ledger written before this field is a clear error rather than a crash.
   */
  factory?: Address;
  sites: Record<string, Address>;
}

const LEDGER_VERSION = 2;

function loadLedger(): Ledger {
  if (!existsSync(LEDGER)) {
    return { version: LEDGER_VERSION, chainId: activeChain.id, factory: FACTORY, sites: {} };
  }
  const raw = JSON.parse(readFileSync(LEDGER, 'utf-8')) as Partial<Ledger>;
  if (raw.version !== LEDGER_VERSION) {
    throw new Error(
      `${path.basename(LEDGER)} is a v${raw.version ?? 1} ledger — its boards are clones of a different ` +
        'implementation and cannot be read by this SDK. Move it aside before seeding a new generation.',
    );
  }
  if (raw.chainId !== activeChain.id) {
    throw new Error(`${path.basename(LEDGER)} is for chain ${raw.chainId}, not ${activeChain.id}`);
  }
  if (!raw.factory || raw.factory.toLowerCase() !== FACTORY.toLowerCase()) {
    throw new Error(
      `${path.basename(LEDGER)} records boards created through ${raw.factory ?? 'an unrecorded factory'}, but ` +
        `WEBSITEKIT_FACTORY is ${FACTORY}. Those boards are clones of a different implementation and re-seeding ` +
        'would skip creating any of them. Move the ledger aside (see examples.r1.json) before seeding a new ' +
        'generation, or point WEBSITEKIT_FACTORY back at the one its boards are on.',
    );
  }
  return { version: LEDGER_VERSION, chainId: raw.chainId, factory: raw.factory, sites: raw.sites ?? {} };
}

const ledger = loadLedger();

const tokenBalance = (address: Address) =>
  publicClient.readContract({ address: TOKEN.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

console.log(`chain    ${activeChain.name} (${activeChain.id})${activeChain.testnet ? '' : ' — REAL MONEY'}`);
console.log(`factory  ${FACTORY}  (from the environment — never deployed here)`);
console.log(`settles  ${TOKEN.symbol} ${TOKEN.address}`);
console.log(`ledger   ${path.basename(LEDGER)}`);
console.log(`deployer ${deployer().address}  ${await balanceOf(deployer().address)} ETH  ${fmt(await tokenBalance(deployer().address))}`);
console.log(`taker    ${taker().address}  ${await balanceOf(taker().address)} ETH  ${fmt(await tokenBalance(taker().address))}\n`);

// ---------------------------------------------------------------------------
// 0. Afford it before spending any of it — see the note in `seed-demo.ts`
// ---------------------------------------------------------------------------
//
// Dollars are budgeted PER BOARD, because the money is swept home after each: the float the two
// accounts need is the most expensive single board, not the sum. Gas is budgeted for the whole run,
// since that does not come back — one approval per purchase on a token board.
const todo = BOARDS.filter((board) => !ledger.sites[board.slug]);
const costOf = (board: Board) => {
  const keys = Object.keys(board.slots);
  const deployerKeys = keys.filter((key) => !board.takerClaims.includes(key));
  const deployerUsd = deployerKeys.reduce((sum, key) => sum + board.slots[key]!, 0n);
  const takerUsd =
    board.takerClaims.reduce((sum, key) => sum + board.slots[key]!, 0n) +
    board.takeFromDeployer.reduce((sum, key) => sum + (board.slots[key]! * board.economics.takeBps) / 10_000n, 0n);
  // 2% headroom: the 1% slippage an approval allows, plus rounding.
  return { deployerUsd: (deployerUsd * 10_200n) / 10_000n, takerUsd: (takerUsd * 10_200n) / 10_000n, txs: keys.length * 2 + board.takeFromDeployer.length * 2 + 4 };
};

const gasPrice = await publicClient.getGasPrice();
const GAS_PER_TX = 400_000n * gasPrice * 3n;
let float = 0n;
let flow = 0n;
let txs = 0;
console.log('budget:');
for (const board of todo) {
  const cost = costOf(board);
  const total = cost.deployerUsd + cost.takerUsd;
  float = total > float ? total : float;
  flow += total;
  txs += cost.txs;
  console.log(`  ${board.slug.padEnd(12)} ~${fmt(total)} through the board`);
}
const gas = GAS_PER_TX * BigInt(txs + 4);
console.log(`  ~${fmt(flow)} moves in all; the accounts need ~${fmt(float)} at once, and ~${(Number(gas) / 1e18).toFixed(6)} ETH of gas\n`);

const haveUsd = (await tokenBalance(deployer().address)) + (await tokenBalance(taker().address));
if (todo.length && haveUsd < float) {
  throw new Error(`the two accounts hold ${fmt(haveUsd)} and need ~${fmt(float)} — send ${TOKEN.symbol} to the deployer`);
}
if (CHECK_ONLY) {
  console.log(todo.length ? 'SEED_CHECK=1 — affordable. Nothing was sent.' : 'SEED_CHECK=1 — every board already exists. Nothing to do.');
  process.exit(0);
}
if (todo.length) {
  await ensureFunded(deployer(), gas, 'deployer');
  await ensureFunded(taker(), GAS_PER_TX * BigInt(txs), 'taker');
}

/** Moves dollars between the two accounts. Only the split is fictional; the deployer is every treasury. */
async function transfer(from: 'deployer' | 'taker', amount: bigint) {
  if (amount <= 0n) return;
  const wallet = from === 'deployer' ? deployerWallet() : takerWallet();
  const account = from === 'deployer' ? deployer() : taker();
  const to = from === 'deployer' ? taker().address : deployer().address;
  await send(wallet, `transfer ${from}`, {
    address: TOKEN.address,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
    account,
  });
}

/** Brings a board's money back to the deployer: its treasury, its payouts, the taker's leftovers. */
async function sweepHome(site: Address) {
  await send(deployerWallet(), 'sweepTreasury', { ...buildSweepTreasury(site), account: deployer() });
  if ((await readPendingWithdrawal(publicClient, site, deployer().address)) > 0n) {
    await send(deployerWallet(), 'withdrawFor', { ...buildWithdrawFor(site, deployer().address), account: deployer() });
  }
  await transfer('taker', await tokenBalance(taker().address));
}

let spent = 0n;

for (const board of BOARDS) {
  let site = ledger.sites[board.slug];
  if (site) {
    console.log(`\n${board.name} — already at ${site}, skipping`);
    continue;
  }

  // 1. The board, with its content slots AND its open edge slots registered in one transaction.
  const createRequest = buildCreateSite({
    factory: FACTORY,
    name: board.name,
    symbol: board.symbol,
    baseTokenURI: `https://websitekit.org/examples/${board.slug}/slot/`,
    treasury: deployer().address,
    settlementToken: TOKEN.address,
    economics: board.economics,
    rentals: board.rentals,
    floorPolicy: FLOOR_POLICY,
    slots: { ...board.slots, ...board.extras },
  });
  const { result } = await publicClient.simulateContract({ ...createRequest, account: deployer() } as never);
  await send(deployerWallet(), `createSite ${board.slug}`, { ...createRequest, account: deployer() });
  site = result as Address;
  // Recorded BEFORE anything is claimed, so a run that dies here is resumable by hand rather than
  // re-creating a board on the next run.
  ledger.sites[board.slug] = site;
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`\n${board.name}  ${site}`);

  const ref = refFor(site);
  const terms = await readSiteTerms(publicClient, ref);
  if (terms.settlementToken.toLowerCase() !== TOKEN.address.toLowerCase()) {
    throw new Error(`${board.slug} settles in ${terms.settlementToken}, not ${TOKEN.symbol} — stop and look`);
  }

  // Fund the taker for this board only.
  const cost = costOf(board);
  await transfer('deployer', cost.takerUsd - (await tokenBalance(taker().address)));

  // 2. Claim every content slot, across two owners.
  for (const key of Object.keys(board.slots)) {
    const isTaker = board.takerClaims.includes(key);
    const charged = await buy(isTaker ? takerWallet() : deployerWallet(), ref, key, terms.settlementToken);
    spent += charged;
    console.log(`  claimed ${key.padEnd(26)} ${fmt(charged).padStart(7)}  by ${isTaker ? 'taker' : 'deployer'}`);
  }

  // 3. Take, so the board shows a payout and a take count above one.
  console.log(`  waiting out the ${COOLDOWN_SECS}s cooldown before taking…`);
  await new Promise((resolve) => setTimeout(resolve, Number(COOLDOWN_SECS) * 1_000 + 5_000));
  for (const key of board.takeFromDeployer) {
    const charged = await buy(takerWallet(), ref, key, terms.settlementToken);
    spent += charged;
    console.log(`  taken   ${key.padEnd(26)} ${fmt(charged).padStart(7)}  by taker`);
  }

  // 4. Prove it looks right, then bring the money home before the next board.
  const rows = await readSlots(publicClient, ref, [...Object.keys(board.slots), ...Object.keys(board.extras)]);
  const open = rows.filter((slot) => !slot.owner).map((slot) => slot.key).sort();
  const expectedOpen = Object.keys(board.extras).sort();
  if (open.join() !== expectedOpen.join()) throw new Error(`${board.slug}: open slots are ${open}, expected ${expectedOpen}`);
  if (rows.filter((slot) => slot.takes > 1).length !== board.takeFromDeployer.length) {
    throw new Error(`${board.slug}: take count wrong`);
  }
  await sweepHome(site);
  console.log(`  open for sale: ${open.join(', ')}  — swept home`);
}

// 5. Read every board back through the reader.
for (const board of BOARDS) {
  const site = ledger.sites[board.slug]!;
  const keys = [...Object.keys(board.slots), ...Object.keys(board.extras)];
  const rows = await readSlots(publicClient, refFor(site), keys);
  const terms = await readSiteTerms(publicClient, refFor(site));
  console.log(
    `\n${board.name}  ${site}` +
      `\n  take ${Number(terms.takeBps) / 10_000}x  reversion ${Number(terms.reversionBps) / 10_000}/wk over ` +
      `${terms.maxReversionWeeks}w  rent fee ${Number(terms.siteRentBps + terms.protocolRentBps) / 100}%  ` +
      `max term ${Number(terms.maxRentalTerm) / 86_400}d`,
  );
  for (const slot of rows) {
    const owner = slot.owner ? `${slot.owner.slice(0, 8)}…` : 'OPEN';
    console.log(`  ${slot.key.padEnd(26)} ${owner.padEnd(12)} floor ${fmt(slot.floor).padStart(6)}  next ${fmt(slot.charged).padStart(7)}  takes ${slot.takes}`);
  }
}

console.log(`
  paid in ${fmt(spent)} across all purchases
  deployer now ${await balanceOf(deployer().address)} ETH  ${fmt(await tokenBalance(deployer().address))}
  taker    now ${await balanceOf(taker().address)} ETH  ${fmt(await tokenBalance(taker().address))}

  addresses written to ${path.basename(LEDGER)}
  explorer ${activeChain.blockExplorers.default.url}

  Record them in src/addresses.ts (EXAMPLE_SITES_BY_CHAIN[${activeChain.id}]), then run
  seed-example-content.ts with the same environment.
`);
